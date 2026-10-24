// Identity tokens: how a platform vouches for one of its users.
//
// The platform's backend mints a short-lived HS256 JWT with its platform secret and hands it to the
// page, which passes it into the embed (see embed/protocol.ts). holt verifies it and mints a Principal.
// holt never sees the platform's passwords or email addresses: it gets claims.
//
//   iss             Must equal the platform's configured issuer.
//   aud             "holt".
//   sub             The platform's stable user id (not a username: those change).
//   iat, exp        Required. exp - iat is at most MAX_TTL_SECONDS; a token is for one handshake.
//   jti             Optional. A token with a jti is accepted once.
//   name            Display name. Required.
//   email_verified  Boolean. Composing is gated on it, as in abulxt today. Default false.
//   avatar          Optional https URL.
//   tier            Optional slug the platform defines (for example "king-proxy"). Mapped to chat
//                   roles per platform later; carried through for now.
//
// There is no admin claim and there never will be: holt admins come from config.admins.

import { verifyJwt, JwtError } from './jwt.ts'
import type { Platform } from './platforms.ts'

export interface Principal {
  /** `<identityNamespace>:<sub>`. The author key, ban subject, timeout subject: one key everywhere. */
  key: string
  platformId: string
  name: string
  emailVerified: boolean
  avatar: string | null
  tier: string | null
}

export class IdentityTokenError extends Error {}

export const MAX_TTL_SECONDS = 10 * 60
const CLOCK_SKEW_SECONDS = 60
const SUBJECT = /^[A-Za-z0-9._-]{1,128}$/
const TIER = /^[a-z][a-z0-9-]{0,31}$/
const NAME_MAX = 80

/** jti values seen, with their expiry. Swept on insert. One process: N processes = N accepts. */
const seenJti = new Map<string, number>()

function sweep(nowSeconds: number): void {
  for (const [jti, exp] of seenJti) if (exp <= nowSeconds) seenJti.delete(jti)
}

function fail(message: string): never {
  throw new IdentityTokenError(message)
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

export function verifyIdentityToken(token: string, platform: Platform, nowMs = Date.now()): Principal {
  // A proxy-embedding-only platform has no token secret, so no token can be valid for it.
  if (platform.secret === null || platform.issuer === null) fail('this platform does not use identity tokens')
  let claims
  try {
    claims = verifyJwt(token, platform.secret)
  } catch (error) {
    fail(error instanceof JwtError ? error.message : 'bad token')
  }
  const now = Math.floor(nowMs / 1000)

  if (claims.iss !== platform.issuer) fail('wrong issuer')
  const aud = claims.aud
  if (!(aud === 'holt' || (Array.isArray(aud) && aud.includes('holt')))) fail('wrong audience')

  const iat = integer(claims.iat) ?? fail('iat is required')
  const exp = integer(claims.exp) ?? fail('exp is required')
  if (iat > now + CLOCK_SKEW_SECONDS) fail('token is from the future')
  if (exp <= now) fail('token expired')
  if (exp - iat > MAX_TTL_SECONDS) fail('token lifetime too long')

  const sub = typeof claims.sub === 'string' ? claims.sub : fail('sub is required')
  if (!SUBJECT.test(sub)) fail('sub is malformed')
  const name = typeof claims.name === 'string' ? claims.name.trim() : ''
  if (!name || name.length > NAME_MAX) fail('name is required')
  const emailVerified = claims.email_verified === true
  let avatar: string | null = null
  if (claims.avatar !== undefined && claims.avatar !== null) {
    if (typeof claims.avatar !== 'string') fail('avatar is malformed')
    let url: URL
    try {
      url = new URL(claims.avatar)
    } catch {
      fail('avatar is malformed')
    }
    if (url.protocol !== 'https:') fail('avatar must be https')
    avatar = url.href
  }
  let tier: string | null = null
  if (claims.tier !== undefined && claims.tier !== null) {
    if (typeof claims.tier !== 'string' || !TIER.test(claims.tier)) fail('tier is malformed')
    tier = claims.tier
  }

  if (claims.jti !== undefined) {
    if (typeof claims.jti !== 'string' || !claims.jti || claims.jti.length > 128) fail('jti is malformed')
    const scoped = `${platform.id}\n${claims.jti}`
    sweep(now)
    if (seenJti.has(scoped)) fail('token already used')
    seenJti.set(scoped, exp)
  }

  return { key: `${platform.identityNamespace}:${sub}`, platformId: platform.id, name, emailVerified, avatar, tier }
}
