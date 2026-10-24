// holt sessions: what the embed page holds after an identity exchange, sent as `Authorization: Bearer`.
//
// Not a cookie. Inside a partner's iframe holt's cookies are third-party and blocked, so the session
// lives in the frame's memory and rides the handshake instead. Expiry is short; the loader script
// asks the platform for a fresh identity token when holt reports `token-expired`.

import { signJwt, verifyJwt, JwtError } from './jwt.ts'
import type { Principal } from './identity-token.ts'

export const SESSION_TTL_SECONDS = 12 * 60 * 60
const TYP = 'holt-session'

export function issueSession(principal: Principal, secret: string, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000)
  return signJwt({
    typ: TYP,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
    key: principal.key,
    platform: principal.platformId,
    name: principal.name,
    ev: principal.emailVerified,
    avatar: principal.avatar,
    tier: principal.tier,
  }, secret)
}

/** The principal of a live session, or null for anything that is not one. Never throws. */
export function readSession(token: string, secret: string, nowMs = Date.now()): Principal | null {
  let claims
  try {
    claims = verifyJwt(token, secret)
  } catch (error) {
    if (error instanceof JwtError) return null
    throw error
  }
  if (claims.typ !== TYP) return null
  const now = Math.floor(nowMs / 1000)
  if (typeof claims.exp !== 'number' || claims.exp <= now) return null
  if (typeof claims.key !== 'string' || typeof claims.platform !== 'string' || typeof claims.name !== 'string') return null
  return {
    key: claims.key,
    platformId: claims.platform,
    name: claims.name,
    emailVerified: claims.ev === true,
    avatar: typeof claims.avatar === 'string' ? claims.avatar : null,
    tier: typeof claims.tier === 'string' ? claims.tier : null,
  }
}
