// abulxt API crypto - client-side negotiate + transparent-decrypt fetch wrapper.
//
// `cryptoFetch` is a drop-in for `fetch` on same-origin /api/* GETs. It adds the
// negotiation header and, when the server answers with a sealed body, decrypts
// it and returns a synthetic plaintext `Response` whose `.json()` / `.text()`
// behave exactly as if the server had replied in cleartext. When the server
// replies in cleartext (feature off, un-negotiated, or an endpoint that does
// not seal), the original Response is returned untouched - so this is safe to
// adopt per call site ahead of any server rollout.
//
// This module is bundled and runs through the shield VM like the rest of the
// client; the decrypt path is not special-cased out of obfuscation.

import { activeApiUrl } from './api-base'
import {
  deriveApiKeys,
  openToText,
  seedFromDocumentCookie,
  API_CRYPTO_HEADER,
  API_CRYPTO_TOKEN,
} from './api-crypto-codec.ts'
import { failoverFetch } from './api-failover'

function isSealed(response: Response): boolean {
  return (response.headers.get(API_CRYPTO_HEADER) || '').trim() === API_CRYPTO_TOKEN
}

/** A Response that signals a hard failure so callers treat it like a bad fetch. */
function sealedFailure(status = 502): Response {
  return new Response(null, { status, statusText: 'Sealed response could not be decrypted' })
}

/** Rebuild plaintext headers from a sealed response (drop the sealed framing). */
function plaintextHeaders(sealed: Response): Headers {
  const headers = new Headers(sealed.headers)
  headers.delete(API_CRYPTO_HEADER)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  return headers
}

export async function cryptoFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers || {})
  if (!headers.has(API_CRYPTO_HEADER)) headers.set(API_CRYPTO_HEADER, API_CRYPTO_TOKEN)

  const response = await failoverFetch(activeApiUrl(String(input)), { ...init, headers })
  if (!isSealed(response)) return response

  const seed = seedFromDocumentCookie()
  const buffer = await response.arrayBuffer()
  if (!seed) return sealedFailure()

  let keyRes: Uint8Array
  try {
    keyRes = deriveApiKeys(seed).keyRes
  } catch {
    return sealedFailure()
  }

  const text = openToText(keyRes, buffer)
  if (text === null) return sealedFailure()

  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: plaintextHeaders(response),
  })
}
