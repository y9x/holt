// abulxt API crypto - isomorphic /api/* response (and future request) codec.
//
// Runs identically in the browser (bundled by Vite, compiled through the shield
// VM like every other chunk) and in Node (the *-api.ts handlers). It has NO DOM-
// or Node-only imports; all crypto comes from @noble/* via the already-proven
// Wisp cloak primitives (`./seal-codec.ts`).
//
// Key model (FIXED + VERSIONED - do not regenerate per build; a client built
// today must interoperate with a server built later):
//
//   We REUSE the per-session `wcs` seed cookie minted by rt-api - one
//   cookie, one minting path - but derive API keys under a DISTINCT HKDF salt so
//   they are cryptographically independent of the Wisp transport keys (domain
//   separation). The seed never leaves the cookie; both ends derive the same
//   keys from it.
//
//     master  = HKDF-Extract(SHA-256, ikm = seed, salt = "abulxt-api-cloak/v1")
//     keyReq  = HKDF-Expand(SHA-256, master, info = "req", L = 32)   // client -> server
//     keyRes  = HKDF-Expand(SHA-256, master, info = "res", L = 32)   // server -> client
//
// Directional keys stop a reflected body from ever validating in the wrong
// direction. v1 only uses keyRes (response sealing); keyReq is reserved for the
// later request-body item.
//
// Per sealed body (reusing the Wisp `seal`/`open` frame):
//
//   body = nonce(24) || XChaCha20-Poly1305(keyRes, nonce, utf8(json))   (tag = 16)
//
// Fresh random 24-byte nonce per response → no counter state, two seals of the
// same JSON differ. The version lives in the negotiation header / content-type
// (see api-crypto.ts), not in a plaintext magic byte.

import { extract, expand } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  seal,
  open,
  decodeSeed,
  WCS_COOKIE_NAME,
  KEY_LEN,
} from './seal-codec.ts'

/** Wire/scheme version. Bump only for an incompatible protocol change. */
export const API_CRYPTO_VERSION = 1
/** Token carried in the negotiation header and echoed to mark a sealed body. */
export const API_CRYPTO_TOKEN = `v${API_CRYPTO_VERSION}`
/**
 * Request header: client sends it to signal "I accept sealed responses".
 * Response header: server echoes it to mark the body as sealed. Lower-case so
 * it matches Node's normalised `request.headers` keys directly.
 */
export const API_CRYPTO_HEADER = 'x-abulxt-crypto'
/** Content-Type for a sealed body (opaque octets; nothing says "json"). */
export const API_CRYPTO_CONTENT_TYPE = 'application/abulxt-sealed'

const SALT_STRING = 'abulxt-api-cloak/v1'
const utf8 = new TextEncoder()
const utf8dec = new TextDecoder()
const SALT = utf8.encode(SALT_STRING)
const INFO_REQ = utf8.encode('req')
const INFO_RES = utf8.encode('res')

export interface ApiKeys {
  /** Client -> server direction key (request bodies; reserved for later). */
  keyReq: Uint8Array
  /** Server -> client direction key (responses). */
  keyRes: Uint8Array
}

/** Derive the directional API keys from a 32-byte `wcs` seed. */
export function deriveApiKeys(seed: Uint8Array): ApiKeys {
  const master = extract(sha256, seed, SALT)
  return {
    keyReq: expand(sha256, master, INFO_REQ, KEY_LEN),
    keyRes: expand(sha256, master, INFO_RES, KEY_LEN),
  }
}

/** Parse + decode the `wcs` seed from a raw Cookie header (server side). */
export function seedFromCookieHeader(cookieHeader: string | null | undefined): Uint8Array | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== WCS_COOKIE_NAME) continue
    return decodeSeed(part.slice(eq + 1).trim())
  }
  return null
}

/** Read + decode the `wcs` seed from `document.cookie` (browser side). */
export function seedFromDocumentCookie(): Uint8Array | null {
  const g = globalThis as { document?: { cookie?: string } }
  if (!g.document || typeof g.document.cookie !== 'string') return null
  return seedFromCookieHeader(g.document.cookie)
}

/** Seal an already-serialised JSON/text body into a sealed frame. */
export function sealText(keyRes: Uint8Array, text: string): Uint8Array {
  return seal(keyRes, utf8.encode(text))
}

/** Seal a value by JSON-stringifying it first. */
export function sealJson(keyRes: Uint8Array, value: unknown): Uint8Array {
  return sealText(keyRes, JSON.stringify(value))
}

/**
 * Open a sealed frame back to its text body. Returns null on any auth failure
 * (tamper, wrong key, truncated) - never throws. The caller treats null as a
 * failed request (no error oracle beyond that).
 */
export function openToText(keyRes: Uint8Array, frame: Uint8Array | ArrayBuffer): string | null {
  const pt = open(keyRes, frame)
  if (!pt) return null
  return utf8dec.decode(pt)
}
