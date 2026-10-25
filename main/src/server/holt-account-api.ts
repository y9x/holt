// holt-chat's account endpoints: the per-identity settings the chatbox keeps (they used to live on the
// abulxt account) and the platform hook's pushes. Reached only through holt-service:
//
//   POST /api/holt-account/presence        { status }           Set Status (presence.ts), signed-in callers.
//   GET  /api/holt-account/guild-folders                        The server rail layout (sealed).
//   POST /api/holt-account/guild-folders   { guildFolders }     Save it (Discord's guildFolders shape).
//   POST /api/holt-platform/identities     { identities }       A platform describes changed identities.
//   POST /api/holt-platform/forget         { keys }             A platform deleted these accounts.
//
// The /api/holt-platform/* routes need the platform header holt-service signs after checking the platform's
// hook signature (chat-caller.ts readPlatformHeader); the platform may only speak for its own namespace.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, ViteDevServer } from 'vite'
import { dbConfigured, ensureSchema, query } from './db.js'
import { loadConfig } from './config.js'
import { resolveChatIdentity, readPlatformHeader, PLATFORM_HEADER } from './chat-caller.ts'
import { isPresenceChoice, setPresenceChoice } from './presence.js'
import { normalizeGuildFolders, validateGuildFolders } from './guild-folders.ts'
import { forgetIdentity, forgetTouched, saveIdentity } from './identity-directory.ts'
import { emitIdentitiesChanged } from './discord-chat-perms.js'
import { webIdentityKey } from './chat-identity-key.ts'
import { broadcastEphemeral, DISCORD_BRIDGE_OWNER_KEY } from './events.js'
import { writeSealedJson } from './api-crypto.ts'
import { rateLimit, sendRateLimited } from './rate-limit.ts'

const MAX_BODY = 64 * 1024
const SNOWFLAKE = /^\d{15,22}$/

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'private, no-store')
  response.end(JSON.stringify(body))
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) { resolve(null); request.destroy(); return }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown
        resolve(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null)
      } catch {
        resolve(null)
      }
    })
    request.on('error', () => resolve(null))
  })
}

async function sessionSecret(): Promise<string | null> {
  const config = await loadConfig().catch(() => null) as { sessionSecret?: unknown } | null
  return typeof config?.sessionSecret === 'string' && config.sessionSecret.length >= 32 ? config.sessionSecret : null
}

async function handleAccount(path: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const identity = await resolveChatIdentity(request, await sessionSecret())
  if (!identity.user) return sendJson(response, 401, { error: 'Sign in to continue.' })
  const key = identity.user.ext_key
  const limit = rateLimit(`holt-account:${key}`, { limit: 60, windowMs: 60_000, error: 'Too many requests. Slow down.' })
  if (!limit.ok) return sendRateLimited(response, limit.retryAfterSec, limit.error)

  if (path === 'presence') {
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' })
    const body = await readBody(request)
    if (!body || !isPresenceChoice(body.status)) return sendJson(response, 400, { error: 'Unknown status.' })
    const view = await setPresenceChoice(key, body.status)
    return sendJson(response, 200, { status: body.status, shown: view.shown })
  }

  if (path === 'guild-folders') {
    if (request.method === 'GET') {
      const { rows } = await query<{ folders: unknown }>('SELECT folders FROM chat_guild_folders WHERE key = $1', [key])
      const payload = JSON.stringify({ guildFolders: normalizeGuildFolders(rows[0]?.folders ?? []) })
      const config = await loadConfig().catch(() => null)
      if (config?.apiCrypto?.enabled && writeSealedJson(request, response, payload, 200)) return
      response.statusCode = 200
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.setHeader('Cache-Control', 'private, no-store')
      return void response.end(payload)
    }
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' })
    const body = await readBody(request)
    const check = validateGuildFolders(body?.guildFolders)
    if (!check.ok) return sendJson(response, 400, { error: check.error })
    await query(
      `INSERT INTO chat_guild_folders (key, folders) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET folders = EXCLUDED.folders, updated = NOW()`,
      [key, JSON.stringify(check.folders)],
    )
    // The identity's other sockets pick the new layout up (keys-targeted, ephemeral for everyone else).
    broadcastEphemeral(DISCORD_BRIDGE_OWNER_KEY, 'account.guild_folders', { keys: [key], guildFolders: check.folders })
    return sendJson(response, 200, { guildFolders: check.folders })
  }
  return sendJson(response, 404, { error: 'Not found' })
}

async function handlePlatform(path: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const secret = await sessionSecret()
  const platform = secret ? readPlatformHeader(request, secret) : null
  if (!platform) return sendJson(response, 403, { error: 'Forbidden' })
  if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' })
  const body = await readBody(request)
  if (!body) return sendJson(response, 400, { error: 'Bad request' })
  // A platform speaks only for keys in its own namespace.
  const own = (raw: unknown): string | null => {
    const key = webIdentityKey(raw)
    return key && key.startsWith(`${platform.namespace}:`) ? key : null
  }

  if (path === 'identities') {
    const list = Array.isArray(body.identities) ? body.identities.slice(0, 500) : []
    const changed: string[] = []
    for (const item of list) {
      const r = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
      const key = own(r.key)
      if (!key || typeof r.name !== 'string' || !r.name.trim()) continue
      const avatar = platform.trusted && typeof r.avatar === 'string' && /^https:\/\//.test(r.avatar) ? r.avatar : null
      await saveIdentity({
        ext_key: key,
        platform: platform.id,
        username: r.name.trim().slice(0, 32),
        avatar,
        discord_id: platform.trusted && typeof r.discordId === 'string' && SNOWFLAKE.test(r.discordId) ? r.discordId : null,
        admin: platform.trusted && r.admin === true,
        email_verified: r.emailVerified === true,
      })
      forgetTouched(key)
      changed.push(key)
    }
    await emitIdentitiesChanged(changed)
    return sendJson(response, 200, { updated: changed.length })
  }

  if (path === 'forget') {
    const keys = (Array.isArray(body.keys) ? body.keys : []).map(own).filter((k): k is string => k !== null).slice(0, 500)
    for (const key of keys) await forgetIdentity(key)
    await emitIdentitiesChanged(keys)
    return sendJson(response, 200, { forgotten: keys.length })
  }
  return sendJson(response, 404, { error: 'Not found' })
}

export function holtAccountApi(): Plugin {
  function register(server: { middlewares: ViteDevServer['middlewares'] }) {
    const wrap = (handler: (path: string, req: IncomingMessage, res: ServerResponse) => Promise<void>) =>
      (request: IncomingMessage, response: ServerResponse) => {
        void (async () => {
          if (!dbConfigured()) return sendJson(response, 503, { error: 'Database is not configured.' })
          await ensureSchema()
          const path = (request.url || '/').split('?')[0].replace(/^\/+|\/+$/g, '')
          await handler(path, request, response)
        })().catch((error) => {
          console.warn('[holt-account] request failed', error instanceof Error ? error.message : error)
          if (!response.headersSent) sendJson(response, 500, { error: 'Request failed.' })
          else response.end()
        })
      }
    server.middlewares.use('/api/holt-account/', wrap(handleAccount))
    server.middlewares.use('/api/holt-platform/', wrap(handlePlatform))
  }
  return {
    name: 'holt-account-api',
    configurePreviewServer(server) {
      register(server)
    },
  }
}

export { PLATFORM_HEADER }
