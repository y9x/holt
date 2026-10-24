import { devServerPort } from './dev-tunnel.ts'
import { randomUUID } from 'node:crypto'
import type { ToolEvent } from './ai-providers.js'

/**
 * Per-turn MCP session registry.
 *
 * Cloudflare playground Durable Objects call our MCP endpoint over the public
 * internet. We mint a short-lived session id, append it to the dial URL
 * (`/api/mcp/ddg/<sessionId>`), and register the chat turn's onToolEvent here
 * so tools/call on this process can drive the same thread.tool.* UI as the
 * local OpenAI/Anthropic tool loops.
 *
 * Sessions are process-local and TTL-bounded - the playground turn is short,
 * and we always unregister in finally. Stale entries are reaped as a safety net.
 */

const SESSION_TTL_MS = 15 * 60 * 1000

type McpTurnSession = {
  onToolEvent?: (event: ToolEvent) => void
  /** Tool names this turn may list and call. Undefined means no restriction. */
  allowedTools?: ReadonlySet<string>
  /** Where client tools run: the owner's browser workspace, for this turn. */
  bridge?: { ownerKey: string; threadId: string }
  createdAt: number
}

const sessions = new Map<string, McpTurnSession>()

function reapExpired() {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(id)
  }
}

export function createMcpTurnSession(
  onToolEvent?: (event: ToolEvent) => void,
  allowedTools?: readonly string[],
  bridge?: { ownerKey: string; threadId: string },
): string {
  reapExpired()
  // In dev the id starts with this dev server's port, so the tunnel's supervisor sends the call back here.
  const port = devServerPort()
  const id = `${port ? `${port}-` : ''}${randomUUID().replace(/-/g, '')}`
  sessions.set(id, {
    onToolEvent,
    allowedTools: allowedTools ? new Set(allowedTools) : undefined,
    bridge,
    createdAt: Date.now(),
  })
  return id
}

export function getMcpTurnSession(id: string | undefined | null): McpTurnSession | undefined {
  if (!id) return undefined
  const session = sessions.get(id)
  if (!session) return undefined
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(id)
    return undefined
  }
  return session
}

export function endMcpTurnSession(id: string | undefined | null) {
  if (!id) return
  sessions.delete(id)
}

/** Parse `/api/mcp/ddg/...` into auth path-key (optional) + session id (optional). */
export function parseMcpDdgPath(url: string | undefined, apiKey: string): { pathKey: string; sessionId: string } {
  const path = (url || '').split('?')[0] || ''
  const prefix = '/api/mcp/ddg/'
  if (!path.startsWith(prefix)) return { pathKey: '', sessionId: '' }
  const parts = path
    .slice(prefix.length)
    .split('/')
    .map((p) => {
      try { return decodeURIComponent(p) } catch { return p }
    })
    .map((p) => p.trim())
    .filter(Boolean)

  if (parts.length >= 2) {
    return { pathKey: parts[0] || '', sessionId: parts[1] || '' }
  }
  if (parts.length === 1) {
    const only = parts[0] || ''
    // Bare /api/mcp/ddg/<apiKey> is path-key auth with no session.
    if (apiKey && only === apiKey) return { pathKey: only, sessionId: '' }
    // /api/mcp/ddg/<sessionId> with Bearer auth.
    return { pathKey: '', sessionId: only }
  }
  return { pathKey: '', sessionId: '' }
}

export function mcpToolTitle(name: string, args: Record<string, unknown>): string {
  if (name === 'web_search') return `Searching the web for "${String(args.query ?? '')}"`
  if (name === 'web_fetch') return `Reading ${mcpHostOf(String(args.url ?? ''))}`
  if (name === 'expand_link') return 'Expanding link'
  return `Using ${name}`
}

export function mcpToolSummary(name: string, result: string): string {
  if (name === 'web_search') {
    const count = (result.match(/^\d+\. /gm) || []).length
    return `${count} result${count === 1 ? '' : 's'}`
  }
  if (name === 'web_fetch') return `${Math.round(result.length / 100) / 10}k chars`
  return 'Done'
}

function mcpHostOf(url: string): string {
  if (url.startsWith('ref://')) return 'a result link'
  try { return new URL(url).hostname } catch { return url.slice(0, 40) }
}

export function newMcpCallId(sessionId: string, rpcId: string | number | null | undefined): string {
  const suffix = rpcId != null && String(rpcId) ? String(rpcId) : randomUUID().slice(0, 8)
  return `mcp-${sessionId.slice(0, 8)}-${suffix}`
}
