// abulxt Wisp Cloak - isomorphic frame codec.
//
// This module runs identically in the browser (bundled by Vite) and in Node
// (the abulxt-wisp cloak service). It has NO DOM- or Node-only imports; all
// crypto comes from @noble/* which is isomorphic.
//
// Protocol (FIXED + VERSIONED - do not regenerate constants per build; a client
// built today must interoperate with a server built later):
//
//   master        = HKDF-Extract(SHA-256, ikm = seed, salt = "abulxt-wisp-cloak/v1")
//   keyC2S        = HKDF-Expand(SHA-256, master, info = "c2s",      L = 32)
//   keyS2C        = HKDF-Expand(SHA-256, master, info = "s2c",      L = 32)
//   subprotocol   = base64url(HKDF-Expand(SHA-256, master, info = "subproto", L = 16))
//
// Per WebSocket binary message (default, realtime fast path):
//
//   frame = nonce(24) || XChaCha20-Poly1305(key, nonce, plaintext)    (tag = 16)
//
// Overhead is a fixed 40 bytes/frame (24-byte random nonce + 16-byte Poly1305
// tag). The random per-frame nonce means no counter synchronisation is needed,
// so frames may be processed out of order - safe for a realtime mux. The outer
// bytes are a random nonce followed by AEAD ciphertext: no plaintext magic, so
// a frame is indistinguishable from random to a passive DPI observer.
//
// Optional length-bucket padding (default OFF - see `padding`) uses a 3-byte
// versioned inner header INSIDE the encrypted plaintext so the outer bytes stay
// random:
//
//   inner = version(1 = 0x01) || realLen(uint16 BE) || plaintext || zero-pad
//
// The pad rounds (3 + realLen) up to a multiple of `padding` bytes. Both ends
// must agree on whether padding is enabled (it is a deployment-wide config
// flag, matched client/server), so `open` is told the same `padding` value.

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { extract, expand } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

/** Name of the per-session seed cookie (shared secret, readable by client JS). */
export const WCS_COOKIE_NAME = 'wcs'
/** Wire/scheme version. Bump only for an incompatible protocol change. */
export const CLOAK_VERSION = 1
export const NONCE_LEN = 24
export const TAG_LEN = 16
export const SEED_LEN = 32
export const KEY_LEN = 32
export const SUBPROTO_LEN = 16
/** Minimum valid frame: nonce + tag (empty plaintext). */
export const MIN_FRAME_LEN = NONCE_LEN + TAG_LEN
/** Inner padded-format header: version(1) + uint16 length. */
const PAD_HEADER_LEN = 3

const SALT_STRING = 'abulxt-wisp-cloak/v1'
const utf8 = new TextEncoder()
const SALT = utf8.encode(SALT_STRING)
const INFO_C2S = utf8.encode('c2s')
const INFO_S2C = utf8.encode('s2c')
const INFO_SUBPROTO = utf8.encode('subproto')

export interface CloakKeys {
  /** HKDF-Extract PRK - the shared master secret. */
  master: Uint8Array
  /** Client -> server direction key. */
  keyC2S: Uint8Array
  /** Server -> client direction key. */
  keyS2C: Uint8Array
  /** Derived opaque WebSocket subprotocol token (base64url, 16 bytes). */
  subprotocol: string
}

export interface SealOptions {
  /**
   * Length-bucket padding in bytes (default off). When > 0, the plaintext is
   * wrapped in a versioned inner header and zero-padded so its length is a
   * multiple of this value. `open` must be given the same value.
   */
  padding?: number
}

export type OpenOptions = SealOptions

// ---------------------------------------------------------------------------
// base64url (isomorphic - no Buffer / atob dependency)
// ---------------------------------------------------------------------------

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const B64_LOOKUP: Record<string, number> = (() => {
  const table: Record<string, number> = {}
  for (let i = 0; i < B64_ALPHABET.length; i++) table[B64_ALPHABET[i]!] = i
  // tolerate standard base64 input too
  table['+'] = 62
  table['/'] = 63
  return table
})()

export function base64urlEncode(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += B64_ALPHABET[(n >> 18) & 63]! + B64_ALPHABET[(n >> 12) & 63]! + B64_ALPHABET[(n >> 6) & 63]! + B64_ALPHABET[n & 63]!
  }
  const rem = bytes.length - i
  if (rem === 1) {
    const n = bytes[i]! << 16
    out += B64_ALPHABET[(n >> 18) & 63]! + B64_ALPHABET[(n >> 12) & 63]!
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += B64_ALPHABET[(n >> 18) & 63]! + B64_ALPHABET[(n >> 12) & 63]! + B64_ALPHABET[(n >> 6) & 63]!
  }
  return out
}

export function base64urlDecode(str: string): Uint8Array | null {
  const clean = str.replace(/[^A-Za-z0-9+/_-]/g, '')
  const len = clean.length
  if (len === 0) return new Uint8Array(0)
  if (len % 4 === 1) return null
  const fullGroups = Math.floor(len / 4)
  const rem = len - fullGroups * 4
  const outLen = fullGroups * 3 + (rem === 2 ? 1 : rem === 3 ? 2 : 0)
  const out = new Uint8Array(outLen)
  let o = 0
  let i = 0
  const val = (c: string): number => {
    const v = B64_LOOKUP[c]
    return v === undefined ? -1 : v
  }
  for (let g = 0; g < fullGroups; g++, i += 4) {
    const a = val(clean[i]!), b = val(clean[i + 1]!), c = val(clean[i + 2]!), d = val(clean[i + 3]!)
    if (a < 0 || b < 0 || c < 0 || d < 0) return null
    const n = (a << 18) | (b << 12) | (c << 6) | d
    out[o++] = (n >> 16) & 0xff
    out[o++] = (n >> 8) & 0xff
    out[o++] = n & 0xff
  }
  if (rem === 2) {
    const a = val(clean[i]!), b = val(clean[i + 1]!)
    if (a < 0 || b < 0) return null
    out[o++] = ((a << 2) | (b >> 4)) & 0xff
  } else if (rem === 3) {
    const a = val(clean[i]!), b = val(clean[i + 1]!), c = val(clean[i + 2]!)
    if (a < 0 || b < 0 || c < 0) return null
    out[o++] = ((a << 2) | (b >> 4)) & 0xff
    out[o++] = ((b << 4) | (c >> 2)) & 0xff
  }
  return out
}

// ---------------------------------------------------------------------------
// seed helpers
// ---------------------------------------------------------------------------

/** WebCrypto RNG, available in browsers and Node 18+ (globalThis.crypto). */
function getRandomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }
  if (g.crypto && typeof g.crypto.getRandomValues === 'function') {
    g.crypto.getRandomValues(out)
    return out
  }
  throw new Error('no secure RNG available (globalThis.crypto.getRandomValues missing)')
}

/** Mint a fresh 32-byte per-session seed (the shared secret). */
export function generateSeed(): Uint8Array {
  return getRandomBytes(SEED_LEN)
}

/** Encode a seed as base64url for storage in the `wcs` cookie. */
export function encodeSeed(seed: Uint8Array): string {
  return base64urlEncode(seed)
}

/** Decode a seed from the cookie value. Returns null when malformed / wrong length. */
export function decodeSeed(value: string | null | undefined): Uint8Array | null {
  if (!value) return null
  const bytes = base64urlDecode(value.trim())
  if (!bytes || bytes.length !== SEED_LEN) return null
  return bytes
}

// ---------------------------------------------------------------------------
// key derivation
// ---------------------------------------------------------------------------

/** Derive the directional keys + subprotocol token from a 32-byte seed. */
export function deriveKeys(seed: Uint8Array): CloakKeys {
  if (seed.length !== SEED_LEN) throw new Error(`cloak seed must be ${SEED_LEN} bytes, got ${seed.length}`)
  const master = extract(sha256, seed, SALT)
  const keyC2S = expand(sha256, master, INFO_C2S, KEY_LEN)
  const keyS2C = expand(sha256, master, INFO_S2C, KEY_LEN)
  const subprotocol = base64urlEncode(expand(sha256, master, INFO_SUBPROTO, SUBPROTO_LEN))
  return { master, keyC2S, keyS2C, subprotocol }
}

/** Derive just the opaque WebSocket subprotocol token (used for negotiation). */
export function deriveSubprotocol(seed: Uint8Array): string {
  if (seed.length !== SEED_LEN) throw new Error(`cloak seed must be ${SEED_LEN} bytes, got ${seed.length}`)
  const master = extract(sha256, seed, SALT)
  return base64urlEncode(expand(sha256, master, INFO_SUBPROTO, SUBPROTO_LEN))
}

// ---------------------------------------------------------------------------
// frame seal / open
// ---------------------------------------------------------------------------

function toBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data)
}

function padPlaintext(plaintext: Uint8Array, padding: number): Uint8Array {
  if (plaintext.length > 0xffff) throw new Error('cloak frame too large for padded format (> 65535 bytes)')
  const bodyLen = PAD_HEADER_LEN + plaintext.length
  const bucket = Math.max(1, Math.floor(padding))
  const totalLen = Math.ceil(bodyLen / bucket) * bucket
  const inner = new Uint8Array(totalLen) // zero-filled pad
  inner[0] = CLOAK_VERSION
  inner[1] = (plaintext.length >> 8) & 0xff
  inner[2] = plaintext.length & 0xff
  inner.set(plaintext, PAD_HEADER_LEN)
  return inner
}

function unpadPlaintext(inner: Uint8Array): Uint8Array | null {
  if (inner.length < PAD_HEADER_LEN) return null
  if (inner[0] !== CLOAK_VERSION) return null
  const realLen = (inner[1]! << 8) | inner[2]!
  if (PAD_HEADER_LEN + realLen > inner.length) return null
  return inner.slice(PAD_HEADER_LEN, PAD_HEADER_LEN + realLen)
}

/**
 * Encrypt one binary message. Output is `nonce(24) || AEAD(ct||tag)`, random on
 * every call (fresh nonce), so two seals of the same plaintext differ.
 */
export function seal(key: Uint8Array, data: Uint8Array | ArrayBuffer, opts: SealOptions = {}): Uint8Array {
  const plaintext = toBytes(data)
  const body = opts.padding && opts.padding > 0 ? padPlaintext(plaintext, opts.padding) : plaintext
  const nonce = getRandomBytes(NONCE_LEN)
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(body)
  const frame = new Uint8Array(NONCE_LEN + ciphertext.length)
  frame.set(nonce, 0)
  frame.set(ciphertext, NONCE_LEN)
  return frame
}

/**
 * Decrypt one frame. Returns the plaintext, or `null` on any authentication
 * failure (tamper, wrong key, truncated / malformed frame). Never throws.
 */
export function open(key: Uint8Array, frame: Uint8Array | ArrayBuffer, opts: OpenOptions = {}): Uint8Array | null {
  const bytes = toBytes(frame)
  if (bytes.length < MIN_FRAME_LEN) return null
  const nonce = bytes.subarray(0, NONCE_LEN)
  const ciphertext = bytes.subarray(NONCE_LEN)
  let body: Uint8Array
  try {
    body = xchacha20poly1305(key, nonce).decrypt(ciphertext)
  } catch {
    return null
  }
  if (opts.padding && opts.padding > 0) return unpadPlaintext(body)
  return body
}
