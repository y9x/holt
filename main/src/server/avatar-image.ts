// Safe decode + normalize for partner avatars (partner-avatars.ts): the image a partner platform's user-state
// answer points at, fetched by holt. Same design as abulxt's upload normalizer, holt's own copy.
//
// Threat model: the image is attacker-controlled bytes handed to native image
// decoders (libvips via sharp). The goals are (1) only ever run the four
// decoders we need (PNG, JPEG, WebP, GIF), (2) never reach libheif (HEIF/HEIC/
// AVIF; repeated memory-safety CVEs) or any other optional loader (SVG/rsvg,
// TIFF, JXL, PDF, RAW, magick, ...), (3) bound CPU/memory, and (4) never serve
// or forward the original bytes.
//
// Layered defense:
//   1. Magic-byte sniff BEFORE any decoder sees the buffer. Only PNG, JPEG,
//      WebP (RIFF....WEBP) and GIF signatures pass; extension and Content-Type
//      are never consulted. ISO-BMFF ("....ftyp", i.e. HEIF/HEIC/AVIF/JXL box
//      form) is explicitly named in the rejection.
//   2. libvips operation blocking (sharp.block): EVERY foreign loader is
//      blocked process-wide, then only the four *Buffer loaders above are
//      unblocked. libvips skips blocked loaders during format detection, so
//      even if the sniff were bypassed, VipsForeignLoadHeif* (libheif),
//      rsvg, tiff, etc. cannot be selected. This is what makes libheif
//      unreachable even though sharp's prebuilt libvips links it.
//      NOTE: this is process-global; this module is the only sharp user.
//   3. metadata().format must equal the sniffed format (catches a buffer that
//      sniffs as one format but libvips would parse as another).
//   4. Decompression bombs: limitInputPixels (40 MP) is enforced by sharp from
//      the header dimensions before pixel data is decoded; we also cap each
//      side, the raw byte size (enforced upstream while streaming), run with
//      failOn 'error' (implies 'truncated'), a processing timeout, a small
//      concurrency gate, and the libvips op cache disabled.
//   5. Polyglots (e.g. PNG+ZIP/HTML/JS trailers, EXIF/XMP payloads): the output
//      is always our own WebP re-encode of the decoded pixels with all
//      metadata (EXIF/XMP/ICC/IPTC) stripped, so trailing or embedded data
//      never survives. It is served as image/webp with nosniff + a
//      default-src 'none' CSP regardless.
//   Animated GIF/WebP: only the first frame is decoded (animated: false,
//   pages: 1).
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import type { Metadata, OutputInfo, SharpOptions } from 'sharp'

export type AvatarSourceFormat = 'png' | 'jpeg' | 'webp' | 'gif'

// Output edge in px. Largest avatar presentation is ~128 CSS px (Discord
// profile/popout view of a webhook avatar; our profile popout is 80px), so
// 256 covers that at 2x DPR and the 80px popout at 3x; the 40px message avatar
// is covered up to 6x. Larger buys nothing visible and costs bytes/model
// tokens; smaller (128) would blur on 2x+ screens in the popout.
export const AVATAR_SIZE = 256
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024
export const AVATAR_MAX_INPUT_PIXELS = 40_000_000
const AVATAR_MAX_SIDE = 16_384
const AVATAR_MIN_SIDE = 8
const AVATAR_WEBP_QUALITY = 85
const PROCESS_TIMEOUT_SECONDS = 10
const MAX_CONCURRENT = 2

export class AvatarImageError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'AvatarImageError'
  }
}

export interface NormalizedAvatar {
  bytes: Buffer
  sha256: string
  sourceSha256: string
  sourceFormat: AvatarSourceFormat
  width: number
  height: number
}

// libvips loader class names for the only formats we accept.
const ALLOWED_LOADERS = [
  'VipsForeignLoadPngBuffer',
  'VipsForeignLoadJpegBuffer',
  'VipsForeignLoadWebpBuffer',
  'VipsForeignLoadNsgifBuffer',
]

let hardened = false
function hardenSharp(): void {
  if (hardened) return
  sharp.block({ operation: ['VipsForeignLoad'] })
  sharp.unblock({ operation: ALLOWED_LOADERS })
  sharp.cache(false)
  hardened = true
}

export function sha256Hex(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex')
}

function startsWith(buf: Uint8Array, sig: number[], offset = 0): boolean {
  if (buf.length < offset + sig.length) return false
  for (let i = 0; i < sig.length; i++) if (buf[offset + i] !== sig[i]) return false
  return true
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

// Strict signature sniff. Returns null for anything not in the allowlist.
export function sniffAvatarFormat(buf: Uint8Array): AvatarSourceFormat | null {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (startsWith(buf, ascii('GIF87a')) || startsWith(buf, ascii('GIF89a'))) return 'gif'
  if (startsWith(buf, ascii('RIFF')) && startsWith(buf, ascii('WEBP'), 8)) return 'webp'
  return null
}

function describeRejectedFormat(buf: Uint8Array): string {
  if (startsWith(buf, ascii('ftyp'), 4)) return 'HEIC, HEIF, and AVIF images are not supported. Use PNG, JPEG, WebP, or GIF.'
  if (startsWith(buf, [0xff, 0x0a]) || startsWith(buf, [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20])) return 'JPEG XL images are not supported. Use PNG, JPEG, WebP, or GIF.'
  return 'Unsupported image type. Use PNG, JPEG, WebP, or GIF.'
}

let active = 0
const waiters: Array<() => void> = []
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiters.push(resolve))
  active++
  try {
    return await fn()
  } finally {
    active--
    waiters.shift()?.()
  }
}

// Decode the (already size-capped) upload and produce our canonical avatar:
// square center crop, AVATAR_SIZE x AVATAR_SIZE, sRGB WebP, no metadata.
export async function normalizeAvatar(input: Buffer): Promise<NormalizedAvatar> {
  if (!input.length) throw new AvatarImageError('empty', 'The file is empty.')
  if (input.length > AVATAR_MAX_BYTES) throw new AvatarImageError('too_large', 'Images must be 5 MB or smaller.')
  const sourceFormat = sniffAvatarFormat(input)
  if (!sourceFormat) throw new AvatarImageError('unsupported_format', describeRejectedFormat(input))
  hardenSharp()

  const options: SharpOptions = {
    limitInputPixels: AVATAR_MAX_INPUT_PIXELS,
    failOn: 'error',
    animated: false,
    pages: 1,
    sequentialRead: true,
  }

  return withSlot(async () => {
    let meta: Metadata
    try {
      meta = await sharp(input, options).metadata()
    } catch (error) {
      const msg = error instanceof Error ? error.message : ''
      if (/pixel limit/i.test(msg)) throw new AvatarImageError('too_many_pixels', 'That image is too large. Keep it under 40 megapixels.')
      throw new AvatarImageError('decode_failed', 'That image could not be read. It may be corrupt.')
    }
    if (meta.format !== sourceFormat) {
      throw new AvatarImageError('format_mismatch', 'That image could not be read. It may be corrupt.')
    }
    const w = meta.width || 0
    const h = meta.height || 0
    if (w < AVATAR_MIN_SIDE || h < AVATAR_MIN_SIDE) throw new AvatarImageError('too_small', 'That image is too small.')
    if (w > AVATAR_MAX_SIDE || h > AVATAR_MAX_SIDE || w * h > AVATAR_MAX_INPUT_PIXELS) {
      throw new AvatarImageError('too_many_pixels', 'That image is too large. Keep it under 40 megapixels.')
    }

    let out: { data: Buffer; info: OutputInfo }
    try {
      out = await sharp(input, options)
        .timeout({ seconds: PROCESS_TIMEOUT_SECONDS })
        .rotate() // EXIF auto-orient, then the orientation tag is dropped with the rest
        .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'centre' })
        .toColourspace('srgb')
        .webp({ quality: AVATAR_WEBP_QUALITY, effort: 4 })
        .toBuffer({ resolveWithObject: true })
    } catch {
      throw new AvatarImageError('decode_failed', 'That image could not be read. It may be corrupt.')
    }
    if (out.info.format !== 'webp' || out.info.width !== AVATAR_SIZE || out.info.height !== AVATAR_SIZE) {
      throw new AvatarImageError('encode_failed', 'That image could not be processed.')
    }
    return {
      bytes: out.data,
      sha256: sha256Hex(out.data),
      sourceSha256: sha256Hex(input),
      sourceFormat,
      width: out.info.width,
      height: out.info.height,
    }
  })
}
