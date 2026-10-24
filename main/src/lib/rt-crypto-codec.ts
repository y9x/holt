// abulxt realtime (/api/rt) crypto - isomorphic WebSocket frame codec.
//
// Runs identically in the browser (bundled by Vite, compiled through the shield
// VM like every other chunk) and in Node (the /api/rt WebSocket server in
// rt-api.ts). It has NO DOM- or Node-only imports; all crypto comes from
// @noble/* via the already-proven Wisp cloak primitives
// (`./seal-codec.ts`), which this module treats as a read-only
// dependency.
//
// Key model (FIXED + VERSIONED - do not regenerate per build; a client built
// today must interoperate with a server built later):
//
//   We REUSE the per-session `wcs` seed cookie minted by rt-api - one
//   cookie, one minting path, no new cookie - but derive realtime keys under a
//   DISTINCT HKDF salt so they are cryptographically independent of the Wisp
//   transport keys AND the /api/* response keys (domain separation). The seed
//   never leaves the cookie; both ends derive the same keys from it.
//
//     master      = HKDF-Extract(SHA-256, ikm = seed, salt = "abulxt-rt-cloak/v1")
//     keyC2S      = HKDF-Expand(SHA-256, master, info = "c2s",      L = 32)
//     keyS2C      = HKDF-Expand(SHA-256, master, info = "s2c",      L = 32)
//     subprotocol = base64url(HKDF-Expand(SHA-256, master, info = "subproto", L = 16))
//
// Directional keys stop a server→client frame from ever validating as a
// client→server frame (no reflection). The opaque subprotocol token is the
// negotiation signal: the client offers it as a WebSocket subprotocol; a
// cloak-aware server that holds the same seed echoes it, which both ends read
// off `ws.protocol` to confirm the cloak (exactly like the Wisp cloak).
//
// Per WebSocket message (realtime fast path, same frame as the Wisp cloak):
//
//   frame = nonce(24) || XChaCha20-Poly1305(key, nonce, utf8(jsonText))   (tag = 16)
//
// Fresh random 24-byte nonce per message → no counter state, frames may be
// processed out of order, two seals of the same payload differ, and the outer
// bytes are indistinguishable from random to a passive DPI observer. Fixed
// 40-byte overhead per message.

import { extract, expand } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  seal,
  open,
  decodeSeed,
  base64urlEncode,
  WCS_COOKIE_NAME,
  KEY_LEN,
  SUBPROTO_LEN,
  type SealOptions,
  type OpenOptions,
} from './seal-codec.ts'

/** Wire/scheme version. Bump only for an incompatible protocol change. */
export const RT_CRYPTO_VERSION = 1

const SALT_STRING = 'abulxt-rt-cloak/v1'
const utf8 = new TextEncoder()
const utf8dec = new TextDecoder()
const SALT = utf8.encode(SALT_STRING)
const INFO_C2S = utf8.encode('c2s')
const INFO_S2C = utf8.encode('s2c')
const INFO_SUBPROTO = utf8.encode('subproto')

export interface RtKeys {
  /** Client -> server direction key (messages sent by the browser). */
  keyC2S: Uint8Array
  /** Server -> client direction key (broadcasts / replies to the browser). */
  keyS2C: Uint8Array
  /** Derived opaque WebSocket subprotocol token (base64url, 16 bytes). */
  subprotocol: string
}

/** Derive the directional realtime keys + subprotocol token from a 32-byte `wcs` seed. */
export function deriveRtKeys(seed: Uint8Array): RtKeys {
  const master = extract(sha256, seed, SALT)
  return {
    keyC2S: expand(sha256, master, INFO_C2S, KEY_LEN),
    keyS2C: expand(sha256, master, INFO_S2C, KEY_LEN),
    subprotocol: base64urlEncode(expand(sha256, master, INFO_SUBPROTO, SUBPROTO_LEN)),
  }
}

/** Derive just the opaque subprotocol token (server negotiation, no key material kept). */
export function deriveRtSubprotocol(seed: Uint8Array): string {
  const master = extract(sha256, seed, SALT)
  return base64urlEncode(expand(sha256, master, INFO_SUBPROTO, SUBPROTO_LEN))
}

/** Seal a JSON/text string into a frame (nonce||ciphertext+tag). */
export function sealString(key: Uint8Array, text: string, opts?: SealOptions): Uint8Array {
  return seal(key, utf8.encode(text), opts)
}

/**
 * Open a frame back to its text payload. Returns null on ANY authentication
 * failure (tamper, wrong key, truncated/short frame) - never throws. The caller
 * treats null as a dropped frame (no error oracle beyond that).
 */
export function openToString(key: Uint8Array, frame: Uint8Array | ArrayBuffer, opts?: OpenOptions): string | null {
  const pt = open(key, frame, opts)
  if (!pt) return null
  return utf8dec.decode(pt)
}

/** Parse + decode the `wcs` seed from a raw Cookie header (server side). */
export function seedFromCookieHeader(cookieHeader: string | null | undefined): Uint8Array | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== WCS_COOKIE_NAME) continue
    let value = part.slice(eq + 1).trim()
    try { value = decodeURIComponent(value) } catch { /* use raw */ }
    return decodeSeed(value)
  }
  return null
}

/** Read + decode the `wcs` seed from `document.cookie` (browser side). */
export function seedFromDocumentCookie(): Uint8Array | null {
  const g = globalThis as { document?: { cookie?: string } }
  if (!g.document || typeof g.document.cookie !== 'string') return null
  return seedFromCookieHeader(g.document.cookie)
}

export { WCS_COOKIE_NAME }
