// Compact JWT, HS256 only. Platforms sign identity tokens with any JWT library; holt signs its own
// sessions with the same code. No other algorithm is accepted: `alg` is compared to the literal.
//
// Pure: node:crypto only.

import { createHmac, timingSafeEqual } from 'node:crypto'

export type Claims = Record<string, unknown>

export class JwtError extends Error {}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function decodeSegment(segment: string): unknown {
  let text: string
  try {
    text = Buffer.from(segment, 'base64url').toString('utf8')
  } catch {
    throw new JwtError('malformed token')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new JwtError('malformed token')
  }
}

export function signJwt(claims: Claims, secret: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify(claims))
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}

/** The claims of a token whose HS256 signature matches `secret`. Expiry is the caller's to check. */
export function verifyJwt(token: string, secret: string): Claims {
  const parts = token.split('.')
  if (parts.length !== 3) throw new JwtError('malformed token')
  const [header, payload, signature] = parts as [string, string, string]
  const parsedHeader = decodeSegment(header)
  if (typeof parsedHeader !== 'object' || parsedHeader === null || (parsedHeader as { alg?: unknown }).alg !== 'HS256') {
    throw new JwtError('unsupported algorithm')
  }
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest()
  let given: Buffer
  try {
    given = Buffer.from(signature, 'base64url')
  } catch {
    throw new JwtError('bad signature')
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new JwtError('bad signature')
  const claims = decodeSegment(payload)
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) throw new JwtError('malformed token')
  return claims as Claims
}
