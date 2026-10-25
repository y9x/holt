// Who is calling the chat API (holt-chat): a platform's signed-in user, or a guest.
//
// holt has no accounts. holt-service verifies the visitor with their own platform (forward-auth.ts, then a
// holt session) and hands holt-chat that principal in X-Holt-Principal, signed with a key derived from
// `sessionSecret`, short-lived, and only over loopback. holt-service strips any inbound copy and the caller's
// Authorization/Cookie headers, so a page can neither forge a principal nor smuggle in other credentials.
//
// The principal becomes a ChatUser keyed by its chat identity key (`<namespace>:<subject>`: `abulxt:42`,
// `lab:1`). Bans, timeouts, overwrites, onboarding and author keys all use it. A trusted platform
// (platforms.ts `trusted`) also vouches for the user's linked Discord account and site-admin status.

import type { IncomingMessage } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { clientIp, guestOwnerKey } from './identity.js'
import { webIdentityKey } from './chat-identity-key.ts'
import { touchIdentity } from './identity-directory.ts'
import type { Principal } from './identity-token.ts'

export interface ChatUser {
  /** `<namespace>:<subject>`: author key, onboarding key, ban/timeout/overwrite subject. */
  ext_key: string
  /** The platform the user signed in on (links, badges). */
  platform: string
  /** The name the platform gave (its display name when it is trusted and has one). */
  username: string
  email_verified: boolean
  /** Site admin, vouched for by a trusted platform. Always false for partners. */
  admin: boolean
  /** Platform-supplied avatar URL (https only), or null. Shown only for trusted platforms (moderated there). */
  avatar: string | null
  /** The user's linked Discord account, vouched for by a trusted platform; null otherwise. */
  discord_id: string | null
}

export interface ChatIdentity {
  ownerKey: string
  user: ChatUser | null
  isGuest: boolean
  ip: string
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
    discordId: typeof claims.discordId === 'string' && /^\d{15,22}$/.test(claims.discordId) ? claims.discordId : null,
    admin: claims.admin === true,
  }
}

/** The chat user for a verified principal, or null when its key is not a web identity key (Discord, guest). */
export function extUserOf(principal: Principal): ChatUser | null {
  const key = webIdentityKey(principal.key)
  if (!key || key !== principal.key) return null
  const name = principal.name.trim().slice(0, 32) || key.slice(key.indexOf(':') + 1)
  const avatar = principal.avatar && /^https:\/\//.test(principal.avatar) ? principal.avatar : null
  return {
    ext_key: key, platform: principal.platformId, username: name, email_verified: principal.emailVerified,
    admin: principal.admin === true, avatar, discord_id: principal.discordId ?? null,
  }
}

function fromLoopback(request: IncomingMessage): boolean {
  const address = request.socket?.remoteAddress || ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** The caller: the principal holt-service signed, or a guest. Never any other credential. */
export async function resolveChatIdentity(request: IncomingMessage, sessionSecret: string | null): Promise<ChatIdentity> {
  const ip = clientIp(request)
  const guest: ChatIdentity = { ownerKey: guestOwnerKey(ip), user: null, isGuest: true, ip }
  const header = request.headers[PRINCIPAL_HEADER]
  if (typeof header !== 'string' || !header || !sessionSecret || !fromLoopback(request)) return guest
  const principal = readPrincipal(header, sessionSecret)
  const user = principal ? extUserOf(principal) : null
  if (!user) return guest
  touchIdentity(user)
  return { ...guest, ownerKey: user.ext_key, user, isGuest: false }
}

/**
 * A platform's push (identity changes, deletions), after holt-service verified the platform's hook signature:
 * which platform it is and what it may speak for. Signed like the principal, with its own purpose string.
 */
export const PLATFORM_HEADER = 'x-holt-platform'

export interface PlatformClaim {
  id: string
  namespace: string
  trusted: boolean
}

function platformMac(sessionSecret: string, body: string): string {
  const key = createHmac('sha256', sessionSecret).update('holt-chat platform v1').digest()
  return createHmac('sha256', key).update(body).digest('base64url')
}

export function signPlatformHeader(claim: PlatformClaim, sessionSecret: string, nowMs = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...claim, exp: nowMs + PRINCIPAL_TTL_MS })).toString('base64url')
  return `${body}.${platformMac(sessionSecret, body)}`
}

/** The platform behind a push, or null unless holt-service signed it (and only over loopback). */
export function readPlatformHeader(request: IncomingMessage, sessionSecret: string, nowMs = Date.now()): PlatformClaim | null {
  const value = request.headers[PLATFORM_HEADER]
  if (typeof value !== 'string' || !fromLoopback(request)) return null
  const dot = value.indexOf('.')
  if (dot <= 0) return null
  const body = value.slice(0, dot)
  const given = Buffer.from(value.slice(dot + 1))
  const expected = Buffer.from(platformMac(sessionSecret, body))
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>
    if (typeof claims.exp !== 'number' || claims.exp <= nowMs) return null
    if (typeof claims.id !== 'string' || typeof claims.namespace !== 'string') return null
    return { id: claims.id, namespace: claims.namespace, trusted: claims.trusted === true }
  } catch {
    return null
  }
}
