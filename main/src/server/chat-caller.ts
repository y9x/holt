// Who is calling the chat API (holt-chat): a site account, or another platform's user.
//
// - A site account (namespace `abulxt`: the abulxt and Abstract sites) arrives with its own abulxt token and
//   is resolved by the vendored identity.ts, exactly as on abulxt.
// - Anyone else (nocturne, lab, ...) was verified by holt-service with their own platform (forward-auth.ts,
//   then a holt session). holt-service hands holt-chat that principal in X-Holt-Principal, signed with a key
//   derived from `sessionSecret`, short-lived, and only over loopback. holt-service strips any inbound copy
//   and the caller's Authorization/Cookie headers on those platforms, so a partner page can neither forge a
//   principal nor smuggle in an abulxt token.
//
// The other platform's user becomes an ExtChatUser: it has the fields the chat API reads off a DbUser, with
// `id: null` (no site account, so no site-only feature can mistake it for one) and `ext_key`, its chat
// identity key (`<namespace>:<subject>`). Bans, timeouts, overwrites, onboarding and author keys all use it.

import type { IncomingMessage } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { DbUser } from './auth-db-api.js'
import { resolveIdentity, clientIp, type Identity } from './identity.js'
import { clientGeo } from './traffic-log.js'
import { extKeyOf } from './discord-chat-perms.js'
import type { Principal } from './identity-token.ts'

export interface ExtChatUser {
  id: null
  /** `<namespace>:<subject>`: author key, onboarding key, ban/timeout/overwrite subject. */
  ext_key: string
  /** The platform the user signed in on (links, badges). */
  platform: string
  username: string
  email_verified: boolean
  admin: false
  /** Platform-supplied avatar URL (https only), or null. */
  avatar: string | null
  discord_id: null
  discord_avatar: null
  discord_name: null
  chat_display_name: null
  global_name?: undefined
}

export type ChatUser = DbUser | ExtChatUser

export type ChatIdentity = Omit<Identity, 'user'> & { user: ChatUser | null }

export function isExtUser(user: ChatUser | null | undefined): user is ExtChatUser {
  return Boolean(user && user.id === null && 'ext_key' in user)
}

export const PRINCIPAL_HEADER = 'x-holt-principal'
/** A principal header is good for one request; this only bounds clock skew and replay of a captured header. */
const PRINCIPAL_TTL_MS = 60_000

function principalKey(sessionSecret: string): Buffer {
  return createHmac('sha256', sessionSecret).update('holt-chat principal v1').digest()
}

function mac(sessionSecret: string, body: string): string {
  return createHmac('sha256', principalKey(sessionSecret)).update(body).digest('base64url')
}

/** holt-service side: the header value for a verified principal. */
export function signPrincipal(principal: Principal, sessionSecret: string, nowMs = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...principal, exp: nowMs + PRINCIPAL_TTL_MS })).toString('base64url')
  return `${body}.${mac(sessionSecret, body)}`
}

/** holt-chat side: the principal in a header value, or null for anything not signed by holt-service. Pure. */
export function readPrincipal(value: string, sessionSecret: string, nowMs = Date.now()): Principal | null {
  const dot = value.indexOf('.')
  if (dot <= 0) return null
  const body = value.slice(0, dot)
  const given = Buffer.from(value.slice(dot + 1))
  const expected = Buffer.from(mac(sessionSecret, body))
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  let claims: Record<string, unknown>
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof claims.exp !== 'number' || claims.exp <= nowMs) return null
  if (typeof claims.key !== 'string' || typeof claims.platformId !== 'string' || typeof claims.name !== 'string') return null
  return {
    key: claims.key,
    platformId: claims.platformId,
    name: claims.name,
    emailVerified: claims.emailVerified === true,
    avatar: typeof claims.avatar === 'string' ? claims.avatar : null,
    tier: typeof claims.tier === 'string' ? claims.tier : null,
  }
}

/** The chat user for a verified principal, or null when its key could name a site account, Discord or a guest. */
export function extUserOf(principal: Principal): ExtChatUser | null {
  const key = extKeyOf(principal.key)
  if (!key) return null
  const name = principal.name.trim().slice(0, 32) || key.slice(key.indexOf(':') + 1)
  const avatar = principal.avatar && /^https:\/\//.test(principal.avatar) ? principal.avatar : null
  return {
    id: null, ext_key: key, platform: principal.platformId, username: name, email_verified: principal.emailVerified,
    admin: false, avatar, discord_id: null, discord_avatar: null, discord_name: null, chat_display_name: null,
  }
}

function fromLoopback(request: IncomingMessage): boolean {
  const address = request.socket?.remoteAddress || ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * The caller. With X-Holt-Principal (another platform's user) it is that user, or a guest when the header does
 * not verify: never a fallback to other credentials. Without it, the vendored abulxt resolution.
 */
export async function resolveChatIdentity(request: IncomingMessage, sessionSecret: string | null): Promise<ChatIdentity> {
  const header = request.headers[PRINCIPAL_HEADER]
  if (header === undefined) return resolveIdentity(request)
  const ip = clientIp(request)
  const guest: ChatIdentity = { ownerKey: `guest:${ip}`, user: null, isGuest: true, ip, ...clientGeo(request) }
  if (typeof header !== 'string' || !sessionSecret || !fromLoopback(request)) return guest
  const principal = readPrincipal(header, sessionSecret)
  const user = principal ? extUserOf(principal) : null
  if (!user) return guest
  return { ...guest, ownerKey: user.ext_key, user, isGuest: false }
}

/**
 * Set by holt-service on requests from a platform with its own accounts (its page is on another origin).
 * Never trusted from outside: holt-service strips inbound copies.
 */
export const FOREIGN_PAGE_HEADER = 'x-holt-api'

const SITE_AVATAR_PATH = /"\/api\/avatars\//g

/**
 * abulxt avatars are stored and served as same-origin paths (`/api/avatars/<sha>.webp`). On another
 * platform's page that path is the partner's own server, so responses and realtime frames for those pages
 * point it at abulxt's public origin instead. Pure.
 */
export function absolutizeSiteAvatars(json: string, siteOrigin: string | null): string {
  if (!siteOrigin || !json.includes('"/api/avatars/')) return json
  return json.replace(SITE_AVATAR_PATH, `"${siteOrigin}/api/avatars/`)
}

/** abulxt's public origin (avatars.publicOrigin, else mail.publicOrigin), or null. */
export function siteOriginOf(config: unknown): string | null {
  const c = config as { avatars?: { publicOrigin?: unknown }; mail?: { publicOrigin?: unknown } } | null
  const raw = c?.avatars?.publicOrigin || c?.mail?.publicOrigin
  return typeof raw === 'string' && /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(raw.replace(/\/$/, '')) ? raw.replace(/\/$/, '') : null
}
