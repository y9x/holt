// Embed licenses: a site may embed holt only while it holds a license the holt operator issued.
//
// A license is an HS256 token signed with `licensing.secret` (holt's own; never given to a site):
//   { typ: "holt-license", lid, platform, iat, exp?, note? }
// It is bound to one platform id and an optional expiry, and can be revoked by its `lid`
// (`licensing.revoked`). holt stores no license list: a license is valid when its signature checks out,
// it names the platform being served, it has not expired and its lid is not revoked.
//
// How a site presents it:
//   proxy embedding   its proxy adds `X-Holt-License: <license>` to every request it forwards to holt.
//                     Set by the proxy, so the browser never sees it, and a direct visit to holt cannot
//                     act as the site.
//   iframe embedding  `Holt.mount({ license })`. Visible in the page, which is fine: it only works for
//                     that platform, whose allowed origins (CSP frame-ancestors) are the only pages
//                     that can frame it.
//
// Pure apart from the clock: no I/O.

import { randomBytes } from 'node:crypto'
import { signJwt, verifyJwt, JwtError } from './jwt.ts'

export interface LicensingConfig {
  secret: string
  revoked: ReadonlySet<string>
}

export interface License {
  lid: string
  platform: string
  /** Epoch seconds. */
  issuedAt: number
  /** Epoch seconds, or null for a license that does not expire. */
  expiresAt: number | null
  note: string | null
}

export type LicenseCheck = { ok: true; license: License } | { ok: false; reason: LicenseRefusal }

export type LicenseRefusal = 'missing' | 'invalid' | 'wrong-platform' | 'expired' | 'revoked'

const TYP = 'holt-license'
const LID = /^[A-Za-z0-9_-]{8,64}$/
const PLATFORM = /^[a-z][a-z0-9-]{0,31}$/
const NOTE_MAX = 200
/** A license that names a platform which must be presented as a header is at most this long. */
export const LICENSE_MAX_CHARS = 2048

export function mintLicense(
  secret: string,
  options: { platform: string; days?: number | null; note?: string | null },
  nowMs = Date.now(),
): { token: string; license: License } {
  if (!PLATFORM.test(options.platform)) throw new Error('platform must be a platform id')
  const iat = Math.floor(nowMs / 1000)
  const days = options.days ?? null
  if (days !== null && (!Number.isInteger(days) || days <= 0)) throw new Error('days must be a positive whole number')
  const exp = days === null ? null : iat + days * 86_400
  const note = options.note ? options.note.slice(0, NOTE_MAX) : null
  const lid = randomBytes(12).toString('base64url')
  const claims: Record<string, unknown> = { typ: TYP, lid, platform: options.platform, iat }
  if (exp !== null) claims.exp = exp
  if (note !== null) claims.note = note
  return { token: signJwt(claims, secret), license: { lid, platform: options.platform, issuedAt: iat, expiresAt: exp, note } }
}

/** The license in a token, signature checked, without the platform/expiry/revocation rules. */
export function readLicense(secret: string, token: string): License | null {
  if (token.length > LICENSE_MAX_CHARS) return null
  let claims
  try {
    claims = verifyJwt(token, secret)
  } catch (error) {
    if (error instanceof JwtError) return null
    throw error
  }
  if (claims.typ !== TYP) return null
  if (typeof claims.lid !== 'string' || !LID.test(claims.lid)) return null
  if (typeof claims.platform !== 'string' || !PLATFORM.test(claims.platform)) return null
  if (typeof claims.iat !== 'number' || !Number.isInteger(claims.iat)) return null
  if (claims.exp !== undefined && (typeof claims.exp !== 'number' || !Number.isInteger(claims.exp))) return null
  return {
    lid: claims.lid,
    platform: claims.platform,
    issuedAt: claims.iat,
    expiresAt: typeof claims.exp === 'number' ? claims.exp : null,
    note: typeof claims.note === 'string' ? claims.note : null,
  }
}

/** Whether `token` licenses `platformId` right now. */
export function checkLicense(config: LicensingConfig, platformId: string, token: string | null | undefined, nowMs = Date.now()): LicenseCheck {
  if (!token) return { ok: false, reason: 'missing' }
  const license = readLicense(config.secret, token.trim())
  if (!license) return { ok: false, reason: 'invalid' }
  if (license.platform !== platformId) return { ok: false, reason: 'wrong-platform' }
  if (config.revoked.has(license.lid)) return { ok: false, reason: 'revoked' }
  if (license.expiresAt !== null && license.expiresAt * 1000 <= nowMs) return { ok: false, reason: 'expired' }
  return { ok: true, license }
}

/** The licensing block of config.js, or null when licensing is off (no secret configured). */
export function parseLicensing(raw: unknown, file: string): LicensingConfig | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object') throw new Error(`${file}: licensing must be an object`)
  const { secret, revoked } = raw as { secret?: unknown; revoked?: unknown }
  if (typeof secret !== 'string' || secret.length < 32 || secret === 'CHANGE_ME') throw new Error(`${file}: licensing.secret must be at least 32 characters`)
  const list = revoked === undefined ? [] : revoked
  if (!Array.isArray(list) || !list.every((lid) => typeof lid === 'string' && LID.test(lid))) throw new Error(`${file}: licensing.revoked must be a list of license ids`)
  return { secret, revoked: new Set(list as string[]) }
}
