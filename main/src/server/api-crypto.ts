// abulxt API crypto - server-side response sealing helper.
//
// A small, handler-agnostic helper (NOT a Vite plugin): a *-api.ts handler that
// has computed a JSON body calls `writeSealedJson(request, response, body)`. If
// the client negotiated sealing AND a usable `wcs` seed is present, it writes
// the sealed body + marker headers and returns true. Otherwise it returns false
// and the handler sends its normal plaintext response - so an un-negotiated or
// cookie-less client is never broken.
//
// This is deliberately opt-in per handler and gated by the caller behind a
// config flag (config.apiCrypto.enabled, default OFF), so nothing changes until
// it is turned on.

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  deriveApiKeys,
  sealText,
  seedFromCookieHeader,
  API_CRYPTO_HEADER,
  API_CRYPTO_TOKEN,
  API_CRYPTO_CONTENT_TYPE,
} from '../lib/api-crypto-codec.ts'

function headerValue(raw: string | string[] | undefined): string {
  if (Array.isArray(raw)) return raw[0] ?? ''
  return raw ?? ''
}

/** True when the request's negotiation header advertises our sealing version. */
export function clientAcceptsCrypto(request: Pick<IncomingMessage, 'headers'>): boolean {
  const value = headerValue(request.headers[API_CRYPTO_HEADER] as string | string[] | undefined)
  if (!value) return false
  return value.split(',').some((token) => token.trim() === API_CRYPTO_TOKEN)
}

/**
 * Seal `bodyText` (an already-serialised JSON string) for the caller when they
 * negotiated it and a seed is available. Returns true when it wrote the sealed
 * response (caller must stop), false when the caller should send plaintext.
 *
 * Caching: a sealed body is encrypted under a PER-SESSION key, so a shared cache
 * must never hand one session's ciphertext to another. We force `no-store` and
 * `Vary` on the negotiation header, overriding whatever cacheability the
 * plaintext path would have set.
 */
export function writeSealedJson(
  request: Pick<IncomingMessage, 'headers'>,
  response: ServerResponse,
  bodyText: string,
  status = 200,
): boolean {
  if (!clientAcceptsCrypto(request)) return false
  const seed = seedFromCookieHeader(request.headers.cookie)
  if (!seed) return false

  let keyRes: Uint8Array
  try {
    keyRes = deriveApiKeys(seed).keyRes
  } catch {
    return false
  }

  const frame = sealText(keyRes, bodyText)
  response.statusCode = status
  response.setHeader('Content-Type', API_CRYPTO_CONTENT_TYPE)
  response.setHeader(API_CRYPTO_HEADER, API_CRYPTO_TOKEN)
  response.setHeader('Vary', API_CRYPTO_HEADER)
  response.setHeader('Cache-Control', 'private, no-store')
  response.end(Buffer.from(frame))
  return true
}
