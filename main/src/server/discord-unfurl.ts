// Discord-style link unfurl for web-originated chat messages. When a web user
// posts http(s) URLs, we fetch each one server-side (short timeout, capped
// body) and build an embed in Discord's OWN raw API shape - the exact object
// Discord's unfurler would attach (type link/article/image/video/gifv,
// provider, author, thumbnail/image/video with width/height, color) - so the
// web client renders site unfurls and Discord-resolved embeds through one
// renderer (pages/chat/Embeds.tsx).
//
// Once the message is delivered through the channel webhook, Discord's own
// unfurl supersedes this one (discord-bridge-bot.ts adopts its embeds, which
// carry media-proxy URLs). This module is the fast first preview and the
// fallback for anything Discord doesn't unfurl.
//
// Best-effort: ANY failure (SSRF guard, non-200, unsupported type, timeout, no
// title) returns null and the message simply has no embed - sends never fail
// over an unfurl. Zero new dependencies: meta scraping is regex/string parsing
// of the document <head> only; media dimensions come from header sniffing.

import { lookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { networkInterfaces } from 'node:os'
import { Readable, pipeline } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { freshCdnUrl } from './discord-cdn-refresh.js'

// Discord's raw embed media object.
export interface UnfurlMedia {
  url: string
  width?: number
  height?: number
  // 1 << 5 IS_ANIMATED (GIF/animated WebP thumbnails).
  flags?: number
}

// Discord's raw embed object (the subset an unfurl produces).
export interface UnfurlEmbed {
  type: 'link' | 'article' | 'image' | 'video' | 'gifv' | 'rich'
  url: string
  title?: string
  description?: string
  color?: number
  provider?: { name: string; url?: string }
  author?: { name: string; url?: string }
  thumbnail?: UnfurlMedia
  video?: UnfurlMedia
}

const FETCH_TIMEOUT_MS = 4000
const PROBE_TIMEOUT_MS = 3000
const MAX_HTML_BYTES = 256 * 1024 // cap the HTML read at ~256KB
const MAX_PROBE_BYTES = 64 * 1024 // image header sniff window
const MAX_REDIRECTS = 4
const EMBED_FLAG_IS_ANIMATED = 1 << 5
// Media types inferred from the path when a CDN sends no usable Content-Type.
const MEDIA_EXT_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
}

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

// --- Link extraction --------------------------------------------------------
// Discord's own link rules (web client markdown, see pages/chat/markdown.ts):
// url = /^https?:\/\/[^\s<]+[^<.,:;"'\]\s]/ with trailing-")" balancing
// (Wikipedia-style "(…)" paths survive; an unbalanced ")" is dropped), the CDN
// attachmentLink rule ahead of it, and masked [label](url) links. Angle
// brackets (<https://…> and [label](<https://…>)) suppress embeds in Discord;
// honor that here too. Code spans/blocks never unfurl. A URL that ends in an
// emphasis/spoiler delimiter run OPENED before it on the same line
// (**https://x**, ||https://x||) gives the run back to the outer rule, as
// simple-markdown's outer match does.
const URL_START_G = /https?:\/\//gi
const DISCORD_URL_RE = /^https?:\/\/[^\s<]+[^<.,:;"'\]\s]/
const ATTACHMENT_URL_RE = /^https:\/\/(?:[A-Za-z0-9-]+\.)*(?:(?:media|images)(?:-[A-Za-z0-9]+)?\.discordapp\.net|(?:cdn(?:-[A-Za-z0-9]+)?\.discordapp\.com))\/(?:attachments|ephemeral-attachments)\/\d+\/\d+\/[A-Za-z0-9._-]*[A-Za-z0-9_-](?:[?][a-zA-Z0-9?&=_-]*)?/
const MASKED_RE_G = /\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/gi

function stripUnembeddable(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length))
    .replace(/<https?:\/\/[^\s>]+>/gi, (m) => ' '.repeat(m.length))
}

function discordUrlMatch(text: string): string | null {
  const m = DISCORD_URL_RE.exec(text)
  if (!m) return null
  let url = m[0]
  let from = 0
  for (let i = url.length - 1; i >= 0 && url[i] === ')'; i--) {
    const open = url.indexOf('(', from)
    if (open === -1) {
      url = url.slice(0, url.length - 1)
      break
    }
    from = open + 1
  }
  return url
}

function linkAt(text: string, opener: string): string | null {
  const attachment = ATTACHMENT_URL_RE.exec(text)
  if (attachment) return attachment[0]
  const url = discordUrlMatch(text)
  if (!url) return null
  const run = /([*_~|]+)$/.exec(url)
  if (run && opener.includes(run[1])) return discordUrlMatch(url.slice(0, url.length - run[1].length))
  return url
}

// Every unfurlable URL in a message body, in content order, de-duplicated.
export function messageLinks(content: string): string[] {
  const body = stripUnembeddable(content || '')
  const found: Array<{ index: number; url: string }> = []
  for (const m of body.matchAll(MASKED_RE_G)) found.push({ index: m.index ?? 0, url: m[1] })
  const withoutMasked = body.replace(MASKED_RE_G, (all) => ' '.repeat(all.length))
  let consumedTo = 0
  for (const m of withoutMasked.matchAll(URL_START_G)) {
    const index = m.index ?? 0
    if (index < consumedTo) continue
    const opener = withoutMasked.slice(withoutMasked.lastIndexOf('\n', index - 1) + 1, index)
    const url = linkAt(withoutMasked.slice(index), opener)
    if (!url) continue
    consumedTo = index + url.length
    found.push({ index, url })
  }
  found.sort((a, b) => a.index - b.index)
  const seen = new Set<string>()
  const out: string[] = []
  for (const { url } of found) {
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

// The first http(s) URL in a message body, if any (kept for callers that only
// care about one link).
export function firstLink(content: string): string | null {
  return messageLinks(content)[0] ?? null
}

// --- SSRF guard -------------------------------------------------------------
// Only public http/https targets. Rejects credentials in the URL, hostnames
// that are localhost / internal-looking names, and any IP literal in a
// private / loopback / link-local / reserved range. Every hop (including each
// redirect and every media probe) is re-checked. Hostnames are resolved
// INSIDE the connection (a custom socket `lookup`), every resolved address is
// vetted, and the socket connects to exactly the vetted address - so a DNS
// rebind between a check and the connect is impossible. Only the default
// http/https ports are allowed, and this host's own interface addresses are
// refused (its public IP would otherwise reach services bound to 0.0.0.0).

const PRIVATE_HOST_RE = /^(localhost|.*\.(localhost|local|internal|lan|home|corp|intra|arpa))$/i

function ipv4Octets(host: string): number[] | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null
  const parts = host.split('.').map(Number)
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets
  if (a === 0) return true                    // 0.0.0.0/8 "this host"
  if (a === 10) return true                   // 10.0.0.0/8
  if (a === 127) return true                  // loopback
  if (a === 169 && b === 254) return true     // link-local (incl. cloud metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true     // 192.168.0.0/16
  if (a === 192 && b === 0 && octets[2] === 0) return true // 192.0.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18.0.0/15 benchmarking
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64.0.0/10
  if (a >= 224) return true                   // multicast + reserved
  return false
}

// Unbracketed IPv6 literal (as returned by DNS lookups).
function isPrivateIpv6(inner: string): boolean {
  const lower = inner.toLowerCase()
  if (lower === '::1' || lower === '::') return true
  // Transition ranges that can embed/route to an IPv4 address: NAT64
  // (64:ff9b::/96 and 64:ff9b:1::/48), 6to4 (2002::/16), Teredo (2001:0::/32),
  // and deprecated IPv4-compatible (::a.b.c.d, serialized as ::xxxx:xxxx).
  if (lower.startsWith('64:ff9b:') || lower.startsWith('2002:') || /^2001:0?:/.test(lower)) return true
  if (/^::[0-9a-f]{1,4}(:[0-9a-f]{1,4})?$/.test(lower) || /^::\d+\.\d+\.\d+\.\d+$/.test(lower)) return true
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true // fe80::/10 link-local
  if (lower.startsWith('fec') || lower.startsWith('fed') || lower.startsWith('fee') || lower.startsWith('fef')) return true // fec0::/10 site-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // unique-local fc00::/7
  if (lower.startsWith('ff')) return true // multicast
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) {
    const octets = ipv4Octets(mapped[1])
    return octets ? isPrivateIpv4(octets) : true
  }
  // Hex-form v4-mapped (::ffff:7f00:1) - treat the whole mapped range as private.
  if (lower.startsWith('::ffff:')) return true
  return false
}

function isPrivateHost(host: string): boolean {
  const lower = host.toLowerCase()
  if (PRIVATE_HOST_RE.test(lower)) return true
  // IPv6 literals come bracketed in URL.hostname: [::1], [fe80::1], [fd00::…].
  if (lower.startsWith('[')) return isPrivateIpv6(lower.slice(1, -1))
  const octets = ipv4Octets(lower)
  if (octets) return isPrivateIpv4(octets)
  return false
}

// This host's own interface addresses (public ones included), refreshed
// periodically. Reaching our own public IP would hit any service bound to
// 0.0.0.0 from the inside.
let localAddressCache: { expires: number; set: Set<string> } | null = null
function localAddresses(): Set<string> {
  if (localAddressCache && localAddressCache.expires > Date.now()) return localAddressCache.set
  const set = new Set<string>()
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list || []) set.add(a.address.toLowerCase().replace(/%.*$/, ''))
    }
  } catch {
    // no interface info: the private-range checks still apply
  }
  localAddressCache = { expires: Date.now() + 60_000, set }
  return set
}

// Is this resolved/literal address one we must never connect to?
function isBlockedAddress(address: string, family?: number): boolean {
  const bare = address.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  if (localAddresses().has(bare)) return true
  const fam = family ?? isIP(bare)
  if (fam === 6) return isPrivateIpv6(bare)
  const octets = ipv4Octets(bare)
  return octets ? isPrivateIpv4(octets) : true
}

function isAllowedUrl(url: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  // Default ports only (URL.port is '' for :80 on http and :443 on https).
  if (url.port !== '') return false
  if (isPrivateHost(url.hostname)) return false
  const literal = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  if (isIP(literal) && isBlockedAddress(literal)) return false
  return true
}

// Resolve the hostname and refuse when ANY resolved address is private.
async function resolvesPublic(url: URL): Promise<boolean> {
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  if (isIP(host)) return true // literal - already vetted by isAllowedUrl
  try {
    const addresses = await lookup(host, { all: true, verbatim: true })
    if (!addresses.length) return false
    return addresses.every(({ address, family }) => !isBlockedAddress(address, family))
  } catch {
    return false
  }
}

// Socket-level resolver: the address the socket actually connects to is the
// one vetted here (no second, unchecked lookup). Any blocked address in the
// answer fails the whole connection.
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true, verbatim: true }).then((addresses) => {
    if (!addresses.length || addresses.some(({ address, family }) => isBlockedAddress(address, family))) {
      const error: NodeJS.ErrnoException = new Error(`unfurl: refusing non-public address for ${hostname}`)
      error.code = 'EUNFURLBLOCKED'
      callback(error, '', 4)
      return
    }
    if (options.all) callback(null, addresses)
    else callback(null, addresses[0].address, addresses[0].family)
  }, (error: NodeJS.ErrnoException) => callback(error, '', 4))
}

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304])

// pipeline() propagates errors/aborts both ways, so an aborted response
// errors the decoded stream (and the reader) instead of hanging it.
function decodedBody(res: IncomingMessage): Readable {
  const encoding = String(res.headers['content-encoding'] || '').trim().toLowerCase()
  const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip()
    : encoding === 'deflate' ? createInflate()
      : encoding === 'br' ? createBrotliDecompress()
        : null
  if (!decoder) return res
  pipeline(res, decoder, () => {})
  return decoder
}

// One GET through node:http(s) with the guarded resolver, surfaced as a
// WHATWG Response (body streamed, never buffered here; redirects not
// followed). Callers cap how much of the body they read.
function guardedGet(url: URL, signal: AbortSignal, headers: Record<string, string>): Promise<Response> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = send(url, { method: 'GET', headers, lookup: guardedLookup, signal, agent: false }, (res) => {
      const status = res.statusCode || 0
      if (status < 200 || status > 599) {
        res.destroy()
        reject(new Error(`unfurl: unexpected status ${status}`))
        return
      }
      const out = new Headers()
      for (const [name, value] of Object.entries(res.headers)) {
        if (value === undefined) continue
        for (const v of Array.isArray(value) ? value : [value]) {
          try { out.append(name, String(v)) } catch { /* invalid header value */ }
        }
      }
      if (NULL_BODY_STATUS.has(status)) {
        res.resume()
        resolve(new Response(null, { status, headers: out }))
        return
      }
      const stream = decodedBody(res)
      resolve(new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers: out }))
    })
    req.on('error', reject)
    req.end()
  })
}

// --- Meta scraping ----------------------------------------------------------

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#0?34;/g, '"')
    .replace(/&apos;|&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
}

function safeCodePoint(cp: number): string {
  try {
    return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''
  } catch {
    return ''
  }
}

// Pull every <meta> tag's attributes out of the head, then index the
// OpenGraph/Twitter ones. Attribute order varies (property before content or
// vice versa), so each tag is parsed for both attributes independently.
function scrapeMeta(html: string): Map<string, string> {
  const meta = new Map<string, string>()
  const tagRe = /<meta\s[^>]*>/gi
  const attrRe = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g
  let tag: RegExpExecArray | null
  while ((tag = tagRe.exec(html))) {
    let key: string | null = null
    let content: string | null = null
    attrRe.lastIndex = 0
    let attr: RegExpExecArray | null
    while ((attr = attrRe.exec(tag[0]))) {
      const name = attr[1].toLowerCase()
      const value = attr[3] ?? attr[4] ?? ''
      if (name === 'property' || name === 'name' || name === 'itemprop') key = value.toLowerCase()
      else if (name === 'content') content = value
    }
    if (key && content !== null && !meta.has(key)) meta.set(key, decodeEntities(content.trim()))
  }
  return meta
}

function scrapeTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!match) return null
  const title = decodeEntities(match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
  return title || null
}

// YouTube watch pages mark the channel with schema.org microdata:
// <span itemprop="author" …><link itemprop="url" href="…"><link itemprop="name" content="…"></span>
function scrapeMicrodataAuthor(html: string): { name: string; url?: string } | null {
  const block = html.match(/itemprop=["']author["'][\s\S]{0,600}?<\/span>/i)
  if (!block) return null
  const name = block[0].match(/itemprop=["']name["'][^>]*content=["']([^"']+)["']/i)
  if (!name) return null
  const url = block[0].match(/itemprop=["']url["'][^>]*href=["']([^"']+)["']/i)
  return { name: decodeEntities(name[1]), url: url ? decodeEntities(url[1]) : undefined }
}

// Parse a #rgb/#rrggbb/#rrggbbaa theme-color into Discord's integer color.
function parseThemeColor(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const hex = raw.trim().match(/^#([0-9a-f]{3,8})$/i)
  if (!hex) return undefined
  let h = hex[1]
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  if (h.length === 4) h = h.split('').map((c) => c + c).join('')
  if (h.length === 8) h = h.slice(0, 6) // drop alpha
  if (h.length !== 6) return undefined
  const value = parseInt(h, 16)
  return Number.isFinite(value) ? value : undefined
}

function resolveUrl(maybe: string | undefined, base: URL): string | null {
  if (!maybe) return null
  try {
    const resolved = new URL(maybe, base)
    if (!isAllowedUrl(resolved)) return null
    return resolved.toString()
  } catch {
    return null
  }
}

function intMeta(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 && n < 100000 ? n : undefined
}

// --- Fetching ---------------------------------------------------------------

// Read a response body with a hard byte cap - unfurl targets are arbitrary
// third-party pages, so never trust Content-Length or read unbounded.
async function readCappedBytes(response: Response, cap: number): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || !value) break
      chunks.push(value)
      total += value.byteLength
      if (total >= cap) break
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const merged = new Uint8Array(Math.min(total, cap))
  let offset = 0
  for (const chunk of chunks) {
    const slice = chunk.subarray(0, Math.min(chunk.byteLength, merged.byteLength - offset))
    merged.set(slice, offset)
    offset += slice.byteLength
    if (offset >= merged.byteLength) break
  }
  return merged
}

// Fetch one URL, following redirects manually so every hop is re-checked
// against the SSRF guard (a public URL must not be able to 302 us into a
// private address) - both the literal check and the DNS resolution check.
async function fetchGuarded(url: URL, signal: AbortSignal, accept: string): Promise<{ response: Response; finalUrl: URL } | null> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedUrl(current) || !(await resolvesPublic(current))) return null
    // resolvesPublic is only an early-out; the binding check is guardedLookup
    // inside the connection itself.
    const response = await guardedGet(current, signal, {
      'User-Agent': USER_AGENT,
      Accept: accept,
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => {})
      if (!location) return null
      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        return null
      }
      current = next
      continue
    }
    return { response, finalUrl: current }
  }
  return null
}

// --- Media header sniffing --------------------------------------------------

interface Dimensions { width: number; height: number; animated: boolean }

function u16be(b: Uint8Array, o: number): number { return (b[o] << 8) | b[o + 1] }
function u16le(b: Uint8Array, o: number): number { return b[o] | (b[o + 1] << 8) }
function u24le(b: Uint8Array, o: number): number { return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) }
function u32be(b: Uint8Array, o: number): number { return ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) }
function ascii(b: Uint8Array, o: number, n: number): string {
  let s = ''
  for (let i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i])
  return s
}

// PNG / GIF / JPEG / WebP dimensions from the first bytes of the file.
export function sniffImageSize(b: Uint8Array): Dimensions | null {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && ascii(b, 12, 4) === 'IHDR') {
    // acTL before IDAT = APNG.
    const head = ascii(b, 0, Math.min(b.length, 4096))
    const actl = head.indexOf('acTL')
    const idat = head.indexOf('IDAT')
    return { width: u32be(b, 16), height: u32be(b, 20), animated: actl > 0 && (idat < 0 || actl < idat) }
  }
  if (b.length >= 10 && ascii(b, 0, 3) === 'GIF') {
    return { width: u16le(b, 6), height: u16le(b, 8), animated: true }
  }
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const chunk = ascii(b, 12, 4)
    if (chunk === 'VP8 ' && b.length >= 30) return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, animated: false }
    if (chunk === 'VP8L' && b.length >= 25) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, animated: false }
    }
    if (chunk === 'VP8X' && b.length >= 30) {
      return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1, animated: (b[20] & 0x02) !== 0 }
    }
    return null
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue }
      const marker = b[o + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue }
      const len = u16be(b, o + 2)
      // SOF0..SOF15 except DHT(C4)/JPG(C8)/DAC(CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: u16be(b, o + 5), width: u16be(b, o + 7), animated: false }
      }
      o += 2 + len
    }
  }
  return null
}

// MP4/MOV: the first video track's tkhd width/height (16.16 fixed point),
// when the moov box sits inside the sniff window (fast-start files).
function sniffMp4Size(b: Uint8Array): { width: number; height: number } | null {
  const idx = ascii(b, 0, b.length).indexOf('tkhd')
  if (idx < 4) return null
  let o = idx + 4
  const version = b[o]
  o += version === 1 ? 4 + 8 + 8 + 4 + 4 + 8 : 4 + 4 + 4 + 4 + 4 + 4
  o += 8 + 2 + 2 + 2 + 2 + 36
  if (o + 8 > b.length) return null
  const width = u32be(b, o) >>> 16
  const height = u32be(b, o + 4) >>> 16
  return width > 0 && height > 0 ? { width, height } : null
}

// Probe a media URL for its dimensions (header bytes only, SSRF-guarded).
async function probeImage(rawUrl: string): Promise<Dimensions | null> {
  let target: URL
  try {
    target = new URL(rawUrl)
  } catch {
    return null
  }
  try {
    const page = await fetchGuarded(target, AbortSignal.timeout(PROBE_TIMEOUT_MS), 'image/avif,image/webp,image/*,*/*;q=0.5')
    if (!page || !page.response.ok) {
      await page?.response.body?.cancel().catch(() => {})
      return null
    }
    const type = (page.response.headers.get('content-type') || '').toLowerCase()
    if (!type.startsWith('image/')) {
      await page.response.body?.cancel().catch(() => {})
      return null
    }
    return sniffImageSize(await readCappedBytes(page.response, MAX_PROBE_BYTES))
  } catch {
    return null
  }
}

// --- Provider-specific shaping -----------------------------------------------

// Hosts whose og:video is a player Discord embeds as an iframe (type video).
const VIDEO_PLAYER_HOSTS = /^(www\.)?(youtube\.com|youtube-nocookie\.com|player\.vimeo\.com|player\.twitch\.tv|clips\.twitch\.tv)$/i
// Hosts whose short looping mp4 Discord renders as a GIFV.
const GIFV_HOSTS = /(^|\.)(tenor\.com|giphy\.com|imgur\.com)$/i

function youtubeId(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/^www\.|^m\./, '')
  if (host === 'youtu.be') return url.pathname.slice(1).split('/')[0] || null
  if (host === 'youtube.com' || host === 'music.youtube.com') {
    if (url.pathname === '/watch') return url.searchParams.get('v')
    const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{6,})/)
    if (m) return m[1]
  }
  return null
}

function clip(text: string | undefined | null, max: number): string | undefined {
  if (!text) return undefined
  const t = text.trim()
  if (!t) return undefined
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

// YouTube watch pages put their OpenGraph tags ~700KB into the document -
// past the HTML read cap - so YouTube links are shaped from the oEmbed API
// (same SSRF-guarded fetch) into Discord's exact YouTube embed: red bar,
// YouTube provider, channel as author, 1280×720 maxres thumbnail (hq 480×360
// fallback) and the /embed/ player as video.
async function unfurlYouTube(id: string): Promise<UnfurlEmbed | null> {
  const watch = `https://www.youtube.com/watch?v=${id}`
  const oembedUrl = new URL('https://www.youtube.com/oembed')
  oembedUrl.searchParams.set('url', watch)
  oembedUrl.searchParams.set('format', 'json')
  const page = await fetchGuarded(oembedUrl, AbortSignal.timeout(FETCH_TIMEOUT_MS), 'application/json')
  if (!page || !page.response.ok) {
    await page?.response.body?.cancel().catch(() => {})
    return null
  }
  let data: Record<string, unknown>
  try {
    data = JSON.parse(new TextDecoder('utf-8').decode(await readCappedBytes(page.response, MAX_PROBE_BYTES))) as Record<string, unknown>
  } catch {
    return null
  }
  const title = typeof data.title === 'string' ? data.title : null
  if (!title) return null
  const maxres = `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`
  const maxresDims = await probeImage(maxres)
  const thumbnail: UnfurlMedia = maxresDims && maxresDims.width > 120
    ? { url: maxres, width: maxresDims.width, height: maxresDims.height }
    : { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, width: 480, height: 360 }
  const embed: UnfurlEmbed = {
    type: 'video',
    url: watch,
    title: clip(title, 256),
    color: 0xff0000,
    provider: { name: 'YouTube', url: 'https://www.youtube.com' },
    thumbnail,
    video: { url: `https://www.youtube.com/embed/${id}`, width: 1280, height: 720 },
  }
  const authorName = typeof data.author_name === 'string' ? data.author_name : null
  const authorUrl = typeof data.author_url === 'string' ? resolveUrl(data.author_url, new URL(watch)) : null
  if (authorName) embed.author = authorUrl ? { name: authorName, url: authorUrl } : { name: authorName }
  return embed
}

// --- Unfurl -----------------------------------------------------------------

async function unfurlMedia(finalUrl: URL, contentType: string, bytes: Uint8Array, requested: string): Promise<UnfurlEmbed | null> {
  if (contentType.startsWith('image/')) {
    const dims = sniffImageSize(bytes)

    const thumbnail: UnfurlMedia = { url: finalUrl.toString() }
    if (dims) {
      thumbnail.width = dims.width
      thumbnail.height = dims.height
      if (dims.animated) thumbnail.flags = EMBED_FLAG_IS_ANIMATED
    }
    return { type: 'image', url: requested, thumbnail }
  }
  if (contentType.startsWith('video/')) {
    const video: UnfurlMedia = { url: finalUrl.toString() }
    const dims = sniffMp4Size(bytes)
    if (dims) {
      video.width = dims.width
      video.height = dims.height
    }
    return { type: 'video', url: requested, video }
  }
  return null
}

async function unfurlHtml(html: string, finalUrl: URL, requested: string): Promise<UnfurlEmbed | null> {
  // Only the <head> matters for meta; cap the scrape surface. If a </head>
  // exists, cut there; otherwise the 256KB body cap still bounds the work.
  // (YouTube's author microdata lives in the body, so search the full capped
  // document for it.)
  const headEnd = html.search(/<\/head\s*>/i)
  const head = headEnd > 0 ? html.slice(0, headEnd) : html
  const meta = scrapeMeta(head)

  const title = meta.get('og:title') || meta.get('twitter:title') || scrapeTitle(head)
  const description = meta.get('og:description') || meta.get('twitter:description') || meta.get('description') || undefined
  const siteName = meta.get('og:site_name') || undefined
  const color = parseThemeColor(meta.get('theme-color'))
  const canonical = resolveUrl(meta.get('og:url'), finalUrl) || finalUrl.toString()

  const imageUrl = resolveUrl(
    meta.get('og:image:secure_url') || meta.get('og:image:url') || meta.get('og:image') || meta.get('twitter:image') || meta.get('twitter:image:src'),
    finalUrl,
  )
  let imageWidth = intMeta(meta.get('og:image:width'))
  let imageHeight = intMeta(meta.get('og:image:height'))
  let imageAnimated = false
  if (imageUrl && (!imageWidth || !imageHeight)) {
    const dims = await probeImage(imageUrl)
    if (dims) {
      imageWidth = dims.width
      imageHeight = dims.height
      imageAnimated = dims.animated
    }
  }
  const thumbnail: UnfurlMedia | undefined = imageUrl && imageWidth && imageHeight
    ? { url: imageUrl, width: imageWidth, height: imageHeight, ...(imageAnimated ? { flags: EMBED_FLAG_IS_ANIMATED } : {}) }
    : undefined

  const videoUrl = resolveUrl(
    meta.get('og:video:secure_url') || meta.get('og:video:url') || meta.get('og:video') || meta.get('twitter:player'),
    finalUrl,
  )
  const videoWidth = intMeta(meta.get('og:video:width') || meta.get('twitter:player:width'))
  const videoHeight = intMeta(meta.get('og:video:height') || meta.get('twitter:player:height'))
  const videoType = (meta.get('og:video:type') || '').toLowerCase()

  // YouTube: Discord's exact YouTube embed shape (red bar, YouTube provider,
  // channel as author, 1280x720 maxres thumbnail, /embed/ player video).
  const ytId = youtubeId(finalUrl) || youtubeId(new URL(requested))
  if (ytId && /^[\w-]{6,20}$/.test(ytId)) {
    if (!title) return null
    const author = scrapeMicrodataAuthor(html)
    const embed: UnfurlEmbed = {
      type: 'video',
      url: `https://www.youtube.com/watch?v=${ytId}`,
      title: clip(title, 256),
      color: 0xff0000,
      provider: { name: 'YouTube', url: 'https://www.youtube.com' },
      thumbnail: thumbnail ?? { url: `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`, width: 480, height: 360 },
      video: { url: `https://www.youtube.com/embed/${ytId}`, width: videoWidth || 1280, height: videoHeight || 720 },
    }
    const desc = clip(description, 350)
    if (desc) embed.description = desc
    if (author) {
      const authorUrl = author.url ? resolveUrl(author.url, finalUrl) : null
      embed.author = authorUrl ? { name: author.name, url: authorUrl } : { name: author.name }
    }
    return embed
  }

  if (!title && !thumbnail) return null // Discord shows nothing for a bare page.

  const provider = siteName ? { name: clip(siteName, 256)! } : undefined

  // GIFV: Tenor/Giphy/Imgur pages whose og:video is a looping mp4.
  if (videoUrl && GIFV_HOSTS.test(finalUrl.hostname) && (videoType.startsWith('video/') || /\.mp4(\?|$)/i.test(videoUrl))) {
    const video: UnfurlMedia = { url: videoUrl }
    if (videoWidth && videoHeight) {
      video.width = videoWidth
      video.height = videoHeight
    }
    return {
      type: 'gifv',
      url: requested,
      ...(provider ? { provider: { ...provider, url: finalUrl.origin } } : {}),
      ...(thumbnail ? { thumbnail } : {}),
      video,
    }
  }

  // Player embeds (Vimeo/Twitch/YouTube-nocookie players) → type video.
  if (videoUrl && VIDEO_PLAYER_HOSTS.test(new URL(videoUrl).hostname) && thumbnail) {
    const embed: UnfurlEmbed = {
      type: 'video',
      url: canonical,
      title: clip(title, 256),
      thumbnail,
      video: { url: videoUrl, width: videoWidth || thumbnail.width, height: videoHeight || thumbnail.height },
    }
    if (provider) embed.provider = { ...provider, url: finalUrl.origin }
    const desc = clip(description, 350)
    if (desc) embed.description = desc
    if (color !== undefined) embed.color = color
    return embed
  }

  // Generic page. twitter:card=summary_large_image → article (Discord shows
  // the thumbnail as a large image under the text); otherwise link (small
  // thumbnail at the right).
  const large = (meta.get('twitter:card') || '').toLowerCase() === 'summary_large_image'
  const embed: UnfurlEmbed = { type: large && thumbnail ? 'article' : 'link', url: canonical }
  const t = clip(title, 256)
  if (t) embed.title = t
  const desc = clip(description, 350)
  if (desc) embed.description = desc
  if (provider) embed.provider = provider
  if (color !== undefined) embed.color = color
  if (thumbnail) embed.thumbnail = thumbnail
  return embed
}

// Fetch `rawUrl` and build a Discord-shaped embed for it. Returns null on any
// failure - unfurl is best-effort.
export async function unfurlUrl(rawUrl: string): Promise<UnfurlEmbed | null> {
  let target: URL
  try {
    target = new URL(rawUrl)
  } catch {
    return null
  }
  if (!isAllowedUrl(target)) return null

  try {
    const ytId = youtubeId(target)
    if (ytId && /^[\w-]{6,20}$/.test(ytId)) return await unfurlYouTube(ytId)
    // Discord CDN attachment links 404 unless freshly signed (ex/is/hm): a
    // pasted unsigned or day-old link is re-signed through Discord's
    // refresh-urls first. Still a public Discord host, fetched through the
    // same SSRF-guarded path below (pinned lookup, ports, size caps).
    const signed = await freshCdnUrl(rawUrl).catch(() => null)
    const fetchTarget = signed ? new URL(signed) : target
    if (!isAllowedUrl(fetchTarget)) return null
    const page = await fetchGuarded(
      fetchTarget,
      AbortSignal.timeout(FETCH_TIMEOUT_MS),
      'text/html,application/xhtml+xml;q=0.9,image/*;q=0.8,video/*;q=0.7,*/*;q=0.5',
    )
    if (!page) return null
    const { response, finalUrl } = page
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      return null
    }
    const contentType = (response.headers.get('content-type') || '').toLowerCase()
    // Some CDNs serve media as application/octet-stream (or binary/*). For a
    // media-looking path, fall back to the extension's type and let unfurlMedia
    // verify the bytes (images must sniff as images; videos are trusted by ext).
    const extType = contentType === '' || contentType.startsWith('application/octet-stream') || contentType.startsWith('binary/')
      ? MEDIA_EXT_TYPES[finalUrl.pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? ''] ?? ''
      : ''
    if (contentType.startsWith('image/') || contentType.startsWith('video/') || extType) {
      // Direct media link: only the header bytes are read (dimensions).
      const bytes = await readCappedBytes(response, MAX_PROBE_BYTES)
      // Extension-typed image fallback: the bytes must really be an image.
      if (extType.startsWith('image/') && !sniffImageSize(bytes)) return null
      return await unfurlMedia(finalUrl, extType || contentType, bytes, rawUrl)
    }
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      await response.body?.cancel().catch(() => {})
      return null
    }
    const html = new TextDecoder('utf-8').decode(await readCappedBytes(response, MAX_HTML_BYTES))
    return await unfurlHtml(html, finalUrl, rawUrl)
  } catch {
    // Timeout, DNS failure, TLS error, abort - all best-effort nulls.
    return null
  }
}
