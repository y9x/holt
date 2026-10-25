// Proxy embedding's identity check. The platform proxies `/chat/` on its own site to holt, so the
// browser sends the platform's cookies along. holt asks the platform who that is by calling the
// platform's configured user-state URL (platform.userState.url) with those cookies, server to server.
//
// Trust comes from where holt asks, not from what the page says: the URL is always the configured
// one, never derived from the request. A forged request gets the identity of whatever cookies it
// carries, which is only ever its own.
//
// The cookies are forwarded and never logged or stored. Answers are cached for a short time, keyed by a
// hash of the forwarded cookies, so a page that polls does not hit the platform on every request.
//
// Platforms that keep their login in localStorage (userState.tokenStorageKey) have no cookie to forward:
// the page, running on the platform's own origin, reads the token and sends it as `Authorization: Bearer`,
// and holt forwards that header the same way. Without tokenStorageKey an Authorization header is dropped.

import { createHash } from 'node:crypto'
import type { Platform, UserStateConfig } from './platforms.ts'
import type { Principal } from './identity-token.ts'

const FETCH_TIMEOUT_MS = 5000
const MAX_BODY_CHARS = 64 * 1024
const SIGNED_IN_TTL_MS = 30_000
const SIGNED_OUT_TTL_MS = 10_000
const MAX_CACHE_ENTRIES = 10_000
const SUBJECT = /^[A-Za-z0-9._-]{1,128}$/
const SNOWFLAKE = /^\d{15,22}$/
const NAME_MAX = 80
/** RFC 6750 token68 characters only: nothing that could split or extend the header. */
const BEARER = /^Bearer [A-Za-z0-9._~+/-]{8,1024}=*$/

/** What the browser sent through the proxy. A plain string is a Cookie header. */
export interface ForwardedCredentials {
  cookie?: string | undefined
  authorization?: string | undefined
}

/** The platform's endpoint failed in a way that says nothing about who is signed in. */
export class UserStateUnavailable extends Error {}

interface CacheEntry {
  principal: Principal | null
  expires: number
}

const cache = new Map<string, CacheEntry>()

/** Only the configured cookies, re-serialised; null when none of them is present. */
export function forwardedCookies(header: string | undefined, allow: readonly string[] | null): string | null {
  if (!header) return null
  const kept: string[] = []
  for (const part of header.split(';')) {
    const pair = part.trim()
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    if (allow === null || allow.includes(name)) kept.push(pair)
  }
  return kept.length ? kept.join('; ') : null
}

function atPath(record: unknown, path: string): unknown {
  let value = record
  for (const key of path.split('.')) {
    if (typeof value !== 'object' || value === null) return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

/** A configured field: `a.b`, or `a.b|c.d` (the first present, non-empty one). */
function at(record: unknown, path: string | null): unknown {
  if (path === null) return undefined
  for (const option of path.replace(/^!/, '').split('|')) {
    const value = atPath(record, option)
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

/** emailVerified: `true` at the path, or, negated (`!path`), nothing truthy there. */
function verifiedAt(record: unknown, path: string | null): boolean {
  if (path === null) return false
  const value = at(record, path)
  return path.startsWith('!') ? !value : value === true
}

/** The principal in one user-state answer, or null for "nobody is signed in". Pure. */
export function principalFromUserState(platform: Platform, config: UserStateConfig, body: unknown): Principal | null {
  if (typeof body !== 'object' || body === null) return null
  const rawId = at(body, config.fields.id)
  if (rawId === undefined || rawId === null || rawId === '' || rawId === false) return null
  const id = typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId) : rawId
  if (typeof id !== 'string' || !SUBJECT.test(id)) throw new UserStateUnavailable(`user-state ${config.fields.id} is not an id`)
  const rawName = at(body, config.fields.name)
  const name = typeof rawName === 'string' ? rawName.trim().slice(0, NAME_MAX) : ''
  let avatar: string | null = null
  const rawAvatar = at(body, config.fields.avatar)
  if (typeof rawAvatar === 'string') {
    try {
      const url = new URL(rawAvatar)
      if (url.protocol === 'https:') avatar = url.href
    } catch { /* not a URL: no avatar */ }
  }
  // A trusted platform also vouches for the user's linked Discord account, site-admin status and chat name.
  let discordId: string | null = null
  let admin = false
  let displayName = ''
  if (platform.trusted) {
    const rawDiscord = at(body, config.fields.discordId)
    const did = typeof rawDiscord === 'number' ? String(rawDiscord) : rawDiscord
    if (typeof did === 'string' && SNOWFLAKE.test(did)) discordId = did
    admin = at(body, config.fields.admin) === true
    const rawDisplay = at(body, config.fields.displayName)
    displayName = typeof rawDisplay === 'string' ? rawDisplay.trim().slice(0, NAME_MAX) : ''
  }
  return {
    key: `${platform.identityNamespace}:${id}`,
    platformId: platform.id,
    name: displayName || name || id,
    emailVerified: verifiedAt(body, config.fields.emailVerified),
    // Only a trusted platform's avatar is shown or sent to Discord: it moderates its own uploads; holt has no
    // moderation path for an arbitrary partner's image URLs.
    avatar: platform.trusted ? avatar : null,
    tier: null,
    ...(platform.trusted ? { discordId, admin } : {}),
  }
}

function remember(key: string, principal: Principal | null, now: number): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    for (const [stale, entry] of cache) if (entry.expires <= now) cache.delete(stale)
    // Still full of live entries: drop the oldest insertions.
    for (const oldest of cache.keys()) {
      if (cache.size < MAX_CACHE_ENTRIES) break
      cache.delete(oldest)
    }
  }
  cache.set(key, { principal, expires: now + (principal ? SIGNED_IN_TTL_MS : SIGNED_OUT_TTL_MS) })
}

/**
 * Who the request's cookies belong to on this platform. Null: signed out (no cookies, or the platform
 * says so with 401/403/404/204 or a body without an id). Throws UserStateUnavailable when the platform
 * cannot be asked (timeout, 5xx, garbage), so a broken endpoint never looks like a sign-out.
 */
export async function principalFromPlatform(
  platform: Platform,
  credentials: string | undefined | ForwardedCredentials,
  now = Date.now(),
): Promise<Principal | null> {
  const config = platform.userState
  if (!config) return null
  const given: ForwardedCredentials = typeof credentials === 'object' ? credentials : { cookie: credentials }
  const cookies = forwardedCookies(given.cookie, config.cookies)
  // The page sends a localStorage token to holt as `Authorization: Bearer <token>`; holt passes it on in the
  // header the platform expects (tokenHeader), as `Bearer <token>` or the raw token.
  const bearer = config.tokenStorageKey && given.authorization && BEARER.test(given.authorization) ? given.authorization : null
  const tokenValue = bearer ? (config.tokenHeader.bearer ? bearer : bearer.slice('Bearer '.length)) : null
  if (!cookies && !tokenValue) return null

  const key = createHash('sha256').update(`${platform.id}\n${cookies ?? ''}\n${tokenValue ?? ''}`).digest('base64url')
  const hit = cache.get(key)
  if (hit && hit.expires > now) return hit.principal

  let response: Response
  try {
    response = await fetch(config.url, {
      method: 'GET',
      headers: {
        ...(cookies ? { cookie: cookies } : {}),
        ...(tokenValue ? { [config.tokenHeader.name]: tokenValue } : {}),
        accept: 'application/json',
        'user-agent': 'holt (+https://holt.abstracteducation.loan)',
      },
      // A redirect is usually a login page: never follow it with the user's cookies.
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch {
    throw new UserStateUnavailable('user-state request failed')
  }
  if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 204 || (response.status >= 300 && response.status < 400)) {
    remember(key, null, now)
    return null
  }
  if (!response.ok) throw new UserStateUnavailable(`user-state answered HTTP ${response.status}`)
  const text = await response.text().catch(() => '')
  if (text.length > MAX_BODY_CHARS) throw new UserStateUnavailable('user-state answer too large')
  let body: unknown
  try {
    body = text.trim() === '' || text.trim() === 'null' ? null : JSON.parse(text)
  } catch {
    throw new UserStateUnavailable('user-state answer is not JSON')
  }
  const principal = principalFromUserState(platform, config, body)
  remember(key, principal, now)
  return principal
}

/** Test hook: forget every cached answer. */
export function clearUserStateCache(): void {
  cache.clear()
}
