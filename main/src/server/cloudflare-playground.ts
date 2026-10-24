import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import type { ChatInputMessage, CallOptions, ToolCallResult } from './ai-providers.js'
import { loadConfig } from './config.js'
import { createMcpTurnSession, endMcpTurnSession } from './mcp-turn.js'
import { devMcpPublicUrl } from './dev-tunnel.ts'
import { clientToolSpecs, mcpToolSpecs } from '../lib/chat-tools.ts'

const PLAYGROUND_HOST = 'playground.ai.cloudflare.com'
const PLAYGROUND_ORIGIN = 'https://playground.ai.cloudflare.com'
const AGENT_PATH_PREFIX = '/agents/playground/'
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
const DEFAULT_SLUG = '@cf/zai-org/glm-5.3'
const CONTEXT_CAP = 131_072
const DIAL_TIMEOUT_MS = 20_000
const HANDSHAKE_TIMEOUT_MS = 10_000
const IDLE_TIMEOUT_MS = 120_000
const MCP_RPC_TIMEOUT_MS = 20_000
const MCP_READY_TIMEOUT_MS = 45_000

const DELTA_DEDUPE_SLUGS = new Set([
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/qwen/qwen3-30b-a3b-fp8',
])

type JsonMap = Record<string, unknown>

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function asNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function messageText(content: ChatInputMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n\n')
}

function historyCharBudget(contextWindow: number, systemLen: number, userLen: number): number {
  let window = contextWindow > 0 ? contextWindow : CONTEXT_CAP
  if (window > CONTEXT_CAP) window = CONTEXT_CAP
  let usable = window - 4096
  if (usable < 4096) usable = Math.floor(window / 2)
  const remaining = usable * 3 - systemLen - userLen
  return remaining < 0 ? 0 : remaining
}

function boundHistory(lines: string[], budget: number): string {
  if (!lines.length || budget <= 0) return ''
  const full = lines.join('\n\n')
  if (full.length <= budget) {
    return `\n\n<conversation_history>\n${full}\n</conversation_history>\n\nContinue the conversation above. The user's new message follows.`
  }
  const kept: string[] = []
  let currentLen = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    let line = lines[i]!
    if (currentLen + line.length + 2 > budget) {
      if (!kept.length) {
        if (line.length > budget) line = line.slice(line.length - budget)
        kept.push(line)
      }
      break
    }
    kept.push(line)
    currentLen += line.length + 2
  }
  kept.reverse()
  return `\n\n<conversation_history>\n[... earlier conversation history omitted to stay within context window ...]\n\n${kept.join('\n\n')}\n</conversation_history>\n\nContinue the conversation above. The user's new message follows.`
}

const CHAT_FRAME_CHAR_LIMIT = 5500

/**
 * Build the playground system prompt + the single UI user message.
 *
 * Goldenticket stuffs the real user text into `state.system` inside
 * <user_request> and only sends a short instruction in the chat frame (to dodge
 * a ~6k chat-frame limit). That is fragile: if system state is lost to a
 * handshake race, the model only sees the orphan instruction and replies that
 * the <user_request> tags are empty - exactly the failure we hit in chat.
 *
 * Strategy: always put the real user text in the chat frame (truncated to the
 * limit). For long payloads, also mirror the full text into system so nothing
 * is lost. History/system context stay in `state.system`.
 */
function prepareTurn(systemPrompt: string, userText: string): { system: string; chatText: string } {
  const trimmed = userText.trim()
  if (!trimmed) {
    throw new Error('cloudflare playground turn requires a non-empty user message')
  }

  let system = systemPrompt
  let chatText = trimmed
  if (trimmed.length > CHAT_FRAME_CHAR_LIMIT) {
    const label = trimmed.startsWith('<tool_result') ? 'tool_results' : 'user_request'
    system += `\n\n<${label}>\n${trimmed}\n</${label}>\n\nThe full ${label} is above; the chat message is truncated.`
    chatText = trimmed.slice(0, CHAT_FRAME_CHAR_LIMIT) + '\n…(truncated)'
  }
  return { system, chatText }
}

function splitMessages(messages: ChatInputMessage[]): { system: string; historyLines: string[]; lastUser: string } {
  const systemParts: string[] = []
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx < 0) throw new Error('messages must contain at least one user turn')

  const lastUser = messageText(messages[lastUserIdx]!.content)
  const historyLines: string[] = []
  for (let i = 0; i < lastUserIdx; i++) {
    const msg = messages[i]!
    const text = messageText(msg.content)
    if (msg.role === 'system') {
      if (text) systemParts.push(text)
      continue
    }
    if (!text) continue
    const label = msg.role === 'assistant' ? 'Assistant' : 'User'
    historyLines.push(`[${label}]\n${text}`)
  }
  return { system: systemParts.join('\n\n'), historyLines, lastUser }
}

type TurnEvent =
  | { kind: 'chunk'; chunk: JsonMap }
  | { kind: 'usage'; usage: JsonMap }
  | { kind: 'error'; error: Error }
  | { kind: 'done' }
  | { kind: 'mcp'; mcp: JsonMap }
  | { kind: 'rpc'; frame: JsonMap }

class PlaygroundTurn {
  readonly requestId: string
  readonly dedupeText: boolean
  private ws: WebSocket
  private closed = false
  private readonly queue: TurnEvent[] = []
  private waiters: Array<() => void> = []
  private readonly rpcWaiters = new Map<string, { resolve: (v: JsonMap) => void; reject: (e: Error) => void }>()

  constructor(ws: WebSocket, requestId: string, dedupeText: boolean) {
    this.ws = ws
    this.requestId = requestId
    this.dedupeText = dedupeText
    ws.on('message', (data) => this.onMessage(data.toString()))
    ws.on('close', () => this.push({ kind: 'done' }))
    ws.on('error', (err) => this.push({ kind: 'error', error: err instanceof Error ? err : new Error(String(err)) }))
  }

  private push(event: TurnEvent) {
    this.queue.push(event)
    const waiters = this.waiters.splice(0)
    for (const wake of waiters) wake()
  }

  private onMessage(raw: string) {
    let frame: JsonMap
    try { frame = JSON.parse(raw) as JsonMap } catch { return }
    const type = asString(frame.type)
    if (type === 'cf_agent_state') {
      const state = (frame.state && typeof frame.state === 'object') ? frame.state as JsonMap : null
      if (state && state.usage && typeof state.usage === 'object') {
        this.push({ kind: 'usage', usage: state.usage as JsonMap })
      }
      return
    }
    if (type === 'rpc') {
      this.deliverRpc(frame)
      this.push({ kind: 'rpc', frame })
      return
    }
    if (type === 'cf_agent_mcp_servers') {
      if (frame.mcp && typeof frame.mcp === 'object') this.push({ kind: 'mcp', mcp: frame.mcp as JsonMap })
      return
    }
    if (type === 'cf_agent_use_chat_response') {
      if (asString(frame.id) !== this.requestId) return
      if (frame.error === true) {
        this.push({ kind: 'error', error: new Error(flattenAgentError(asString(frame.body))) })
        return
      }
      const body = asString(frame.body).trim()
      if (body) {
        try {
          this.push({ kind: 'chunk', chunk: JSON.parse(body) as JsonMap })
        } catch { /* ignore malformed chunk */ }
      }
      if (frame.done === true) this.push({ kind: 'done' })
    }
  }

  private deliverRpc(frame: JsonMap) {
    const id = asString(frame.id)
    const waiter = this.rpcWaiters.get(id)
    if (!waiter) return
    // Streaming RPCs send done:false chunks first; only settle on final/absent done.
    if (frame.done === false) return
    this.rpcWaiters.delete(id)
    if (frame.success === false) {
      waiter.reject(new Error(asString(frame.error) || 'rpc failed'))
      return
    }
    const result = (frame.result && typeof frame.result === 'object') ? frame.result as JsonMap : {}
    waiter.resolve(result)
  }

  send(value: unknown) {
    if (this.closed) throw new Error('playground turn is closed')
    this.ws.send(JSON.stringify(value))
  }

  async callRpc(method: string, args: unknown[], timeoutMs = MCP_RPC_TIMEOUT_MS): Promise<JsonMap> {
    const id = randomUUID()
    const result = new Promise<JsonMap>((resolve, reject) => {
      this.rpcWaiters.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.rpcWaiters.has(id)) {
          this.rpcWaiters.delete(id)
          reject(new Error(`rpc ${method} timed out`))
        }
      }, timeoutMs)
    })
    this.send({ type: 'rpc', id, method, args })
    return result
  }

  async next(timeoutMs: number, signal?: AbortSignal): Promise<TurnEvent> {
    if (this.queue.length) return this.queue.shift()!
    return new Promise<TurnEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('playground idle timeout'))
      }, timeoutMs)
      const onAbort = () => {
        cleanup()
        reject(new Error('aborted'))
      }
      const wake = () => {
        cleanup()
        resolve(this.queue.shift()!)
      }
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.waiters = this.waiters.filter((w) => w !== wake)
      }
      if (signal?.aborted) {
        cleanup()
        reject(new Error('aborted'))
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(wake)
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    try { this.ws.close() } catch { /* ignore */ }
  }
}

function flattenAgentError(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) return 'cloudflare agent stream error'
  try {
    const payload = JSON.parse(trimmed) as { message?: string; details?: string }
    if (payload.message) {
      return payload.details ? `${payload.message} (${payload.details})` : payload.message
    }
  } catch { /* raw */ }
  return trimmed
}

/** Dial the agent room and capture the first cf_agent_state without missing it. */
function dialAndHandshake(room: string, signal?: AbortSignal): Promise<{ ws: WebSocket; baseState: JsonMap }> {
  const endpoint = `wss://${PLAYGROUND_HOST}${AGENT_PATH_PREFIX}${room}`
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint, {
      origin: PLAYGROUND_ORIGIN,
      headers: { 'User-Agent': BROWSER_UA },
      handshakeTimeout: DIAL_TIMEOUT_MS,
    })

    let opened = false
    let settled = false
    let baseState: JsonMap = {}

    const failTimer = setTimeout(() => {
      cleanup()
      try { ws.close() } catch { /* ignore */ }
      reject(new Error('playground dial timed out'))
    }, DIAL_TIMEOUT_MS)

    // Bound how long we wait for the initial state after open. Proceed with {}
    // on timeout - setState still works, we just may miss merge flags.
    let stateTimer: ReturnType<typeof setTimeout> | undefined

    const onAbort = () => {
      cleanup()
      try { ws.close() } catch { /* ignore */ }
      reject(new Error('aborted'))
    }

    const cleanup = () => {
      clearTimeout(failTimer)
      if (stateTimer) clearTimeout(stateTimer)
      signal?.removeEventListener('abort', onAbort)
      ws.off('message', onMessage)
      ws.off('open', onOpen)
      ws.off('error', onError)
    }

    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ ws, baseState })
    }

    const onMessage = (data: WebSocket.RawData) => {
      try {
        const frame = JSON.parse(data.toString()) as JsonMap
        if (asString(frame.type) === 'cf_agent_state' && frame.state && typeof frame.state === 'object') {
          baseState = frame.state as JsonMap
          if (opened) finish()
        }
      } catch { /* ignore */ }
    }

    const onOpen = () => {
      opened = true
      clearTimeout(failTimer)
      // If state already arrived before open fired, finish now; else wait briefly.
      if (Object.keys(baseState).length) {
        finish()
        return
      }
      stateTimer = setTimeout(() => finish(), HANDSHAKE_TIMEOUT_MS)
    }

    const onError = (err: Error) => {
      cleanup()
      reject(err)
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    // Attach message listener BEFORE open so the initial state broadcast cannot
    // slip through between open and awaitInitialState (the race that left us
    // merging onto {} and occasionally losing later setState ordering).
    ws.on('message', onMessage)
    ws.once('open', onOpen)
    ws.once('error', onError)
  })
}

/** Connects the playground to our MCP URL. Resolves with the tool names the playground received. */
async function connectMcp(turn: PlaygroundTurn, url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<string[]> {
  const result = await turn.callRpc('connectMCPServer', [url, headers])
  if (asString(result.authUrl)) {
    throw new Error('agent demanded interactive oauth for the callback url')
  }
  const deadline = Date.now() + MCP_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('aborted')
    const remaining = Math.max(1, deadline - Date.now())
    const event = await turn.next(Math.min(remaining, 5_000), signal)
    if (event.kind !== 'mcp') continue
    const serversRaw = event.mcp.servers
    const serverList: JsonMap[] = Array.isArray(serversRaw)
      ? serversRaw as JsonMap[]
      : serversRaw && typeof serversRaw === 'object'
        ? Object.values(serversRaw as Record<string, JsonMap>)
        : []
    const tools = Array.isArray(event.mcp.tools) ? event.mcp.tools : []
    for (const server of serverList) {
      const state = asString(server.state)
      if (state === 'ready') {
        if (!tools.length) throw new Error('mcp server ready with zero tools')
        return tools.map((tool) => asString((tool as JsonMap).name)).filter(Boolean)
      }
      if (state === 'failed' || state === 'not-connected') {
        throw new Error(`mcp server ${state}`)
      }
      if (state === 'authenticating') {
        throw new Error('mcp server requires interactive oauth')
      }
    }
  }
  throw new Error('mcp server ready timed out')
}

async function collect(
  turn: PlaygroundTurn,
  options: CallOptions,
): Promise<ToolCallResult> {
  let text = ''
  let reasoning = ''
  let inputTokens = 0
  let outputTokens = 0
  let dedupeBlockId = ''
  let dedupeParity = 0

  for (;;) {
    const event = await turn.next(IDLE_TIMEOUT_MS, options.signal)
    if (event.kind === 'error') throw event.error
    if (event.kind === 'done') break
    if (event.kind === 'usage') {
      inputTokens = asNumber(event.usage.inputTokens) || inputTokens
      outputTokens = asNumber(event.usage.outputTokens) || outputTokens
      continue
    }
    if (event.kind !== 'chunk') continue
    const chunk = event.chunk
    const type = asString(chunk.type)
    if (type === 'text-delta') {
      let delta = asString(chunk.delta)
      if (!delta) continue
      if (turn.dedupeText) {
        const blockId = asString(chunk.id)
        if (blockId !== dedupeBlockId) {
          dedupeBlockId = blockId
          dedupeParity = 0
        }
        dedupeParity++
        if (dedupeParity % 2 === 0) continue
      }
      text += delta
      options.onText?.(delta)
    } else if (type === 'reasoning-delta') {
      const delta = asString(chunk.delta)
      if (!delta) continue
      reasoning += delta
      options.onThinking?.(delta)
    } else if (type === 'error') {
      throw new Error(asString(chunk.errorText) || 'cloudflare agent reported an error')
    }
  }

  const tokens = inputTokens + outputTokens
  return {
    text: text || 'The provider returned an empty response.',
    thinking: reasoning || undefined,
    tokens: tokens > 0 ? tokens : Math.ceil(text.length / 4),
    steps: 1,
  }
}

/**
 * Run one chat turn against the public Cloudflare AI Playground agent socket.
 * Mirrors goldenticket's startCloudflareTurn + collectCloudflareTurn flow:
 * dial → merge cf_agent_state → optional connectMCPServer → submit → collect.
 */
export async function callCloudflarePlayground(
  messages: ChatInputMessage[],
  modelOverride: string | undefined,
  options: CallOptions = {},
): Promise<ToolCallResult> {
  const slug = (modelOverride || '').trim() || DEFAULT_SLUG
  const { system: systemText, historyLines, lastUser } = splitMessages(messages)
  const budget = historyCharBudget(CONTEXT_CAP, systemText.length, lastUser.length)
  const historyPrompt = boundHistory(historyLines, budget)
  const prepared = prepareTurn(systemText + historyPrompt, lastUser)

  // Resolve MCP config before dialing so we don't leave a gap between setState
  // and submit while waiting on disk/network config loads.
  const config = await loadConfig()
  // In `vite` dev the dev tunnel (dev-tunnel.ts) supplies the public MCP URL; otherwise the configured one.
  const mcpBaseUrl = (devMcpPublicUrl() || config.ai?.mcp?.publicUrl || '').trim().replace(/\/$/, '')
  const mcpKey = (config.ai?.mcp?.apiKey || '').trim()

  // Per-turn session id embedded in the MCP dial URL. tools/call on this same
  // process looks it up and fires onToolEvent → thread.tool.* in the chat UI.
  // Requires publicUrl to hit THIS process (production amph does; local needs a
  // tunnel or a local publicUrl, otherwise tools still run but won't render).
  const mcpSessionId = (mcpBaseUrl && mcpKey)
    ? createMcpTurnSession(options.onToolEvent, options.allowedTools, options.toolBridge)
    : ''
  const mcpUrl = mcpSessionId ? `${mcpBaseUrl}/${mcpSessionId}` : mcpBaseUrl

  const room = `playground-${randomUUID()}`
  const { ws, baseState } = await dialAndHandshake(room, options.signal)
  const turn = new PlaygroundTurn(ws, randomUUID().replace(/-/g, '').slice(0, 8), DELTA_DEDUPE_SLUGS.has(slug))

  const state: JsonMap = { ...baseState }
  delete state.usage
  delete state.system
  state.model = slug
  state.stream = true

  // The playground agent takes its system prompt from the setConfig RPC. A
  // `system` field in cf_agent_state is echoed back but never used: the model
  // keeps the agent's default prompt (verified with a one-word probe).
  const applyConfig = () => turn.callRpc('setConfig', [{ model: slug, system: prepared.system }])

  try {
    turn.send({ type: 'cf_agent_state', state })
    await applyConfig()

    // Optional native MCP: point the playground Durable Object at our DDG tools.
    if (mcpUrl && mcpKey) {
      try {
        const headers: Record<string, string> = { Authorization: `Bearer ${mcpKey}` }
        const receivedList = await connectMcp(turn, mcpUrl, headers, options.signal)
        const received = new Set(receivedList)
        console.log(`[ai] cloudflare mcp connected url=${mcpUrl} tools=${receivedList.join(',')}`)
        // Client tools run in the owner's browser through our MCP route. If the MCP host is not this process
        // (a local dev server pointed at production), they are missing here and the model cannot call them.
        // Only tools the MCP route serves are expected here. runSubagent and fetch run on the server and never reach the playground.
        const servable = new Set([...mcpToolSpecs(undefined), ...clientToolSpecs(undefined)].map((spec) => spec.name))
        const missing = (options.allowedTools ?? []).filter((name) => servable.has(name) && !received.has(name))
        if (options.toolBridge && missing.length) {
          console.warn(`[ai] cloudflare mcp did not receive ${missing.length} enabled tool(s): ${missing.join(', ')}. The MCP URL (${mcpBaseUrl}) must reach this server process.`)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[ai] cloudflare mcp fallback: ${message}`)
      }
      // MCP connect can reshuffle agent state - re-assert system/model before submit.
      turn.send({ type: 'cf_agent_state', state })
      await applyConfig()
    }

    const body = JSON.stringify({
      id: room,
      trigger: 'submit-message',
      messageId: 'user_last',
      messages: [{
        id: 'user_last',
        role: 'user',
        parts: [{ type: 'text', text: prepared.chatText }],
      }],
    })
    turn.send({
      id: turn.requestId,
      type: 'cf_agent_use_chat_request',
      init: { method: 'POST', body },
    })

    return await collect(turn, options)
  } finally {
    endMcpTurnSession(mcpSessionId)
    turn.close()
  }
}

export function isCloudflarePlaygroundEndpoint(endpoint: string | undefined): boolean {
  return endpoint === 'cloudflare-playground'
}
