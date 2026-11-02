// Partner avatars: the avatar a partner (an untrusted platform) says its user has, shown only once holt has
// checked it. A trusted platform moderates its own uploads and its avatar URL is used as-is (forward-auth.ts);
// a partner's URL arrives as `principal.avatarSource` and never reaches a page or Discord itself.
//
//   1. holt fetches the URL itself (https on 443 only, public addresses only, checked at connect time so a DNS
//      answer cannot be swapped for an internal one; at most 3 redirects, each re-checked; 5 MB; 10 s).
//   2. avatar-image.ts decodes it with only the PNG/JPEG/WebP/GIF loaders and re-encodes our own 256px WebP.
//   3. avatar-moderation.ts asks the configured model about that WebP. Anything but a clean "allowed" is
//      rejected or pending; both leave the default avatar.
//   4. The WebP is stored (partner_avatar_image) and served from holt's public origin, approved ones only:
//      `<publicOrigin>/avatars/<sha256>.webp`. Pages and Discord webhooks only ever see that URL.
//
// Resolving never waits for a check: an unchecked URL resolves to null (the default avatar) and is queued; the
// next request after the check finishes shows it. A URL is re-fetched daily, a failed or inconclusive one
// hourly; when the image behind a URL changes, the default avatar shows until the new image passes (the old
// copy is never shown for it again, and nothing unchecked ever is). A verdict belongs to the image (keyed by
// our WebP's hash) and is final once approved or rejected, so the model sees each image once.
//
// Not here: manual review. A pending image stays pending until a later re-check decides it.

import https from 'node:https'
import dns from 'node:dns'
import net from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LookupFunction } from 'node:net'
import { createHash } from 'node:crypto'
import { query } from './db.js'
import { normalizeAvatar, AvatarImageError, AVATAR_MAX_BYTES } from './avatar-image.ts'
import { moderateAvatarImage, type ModerationProvider, type ModerationVerdict } from './avatar-moderation.ts'

const FETCH_TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 3
const MAX_URL_CHARS = 2048
const RECHECK_MS = 24 * 60 * 60_000
const RETRY_MS = 60 * 60_000
const MEMORY_TTL_MS = 5 * 60_000
const MAX_MEMORY = 20_000
const MAX_QUEUE = 500
const CONCURRENCY = 2
/** New avatar URLs one identity may queue per hour: someone cycling URLs cannot run up model calls. */
const NEW_SOURCES_PER_HOUR = 6
const SHA = /^[0-9a-f]{64}$/
export const AVATAR_ROUTE = '/avatars/'

// ---------------------------------------------------------------------------------------------------------
// Address policy

const blocked = new net.BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(address, prefix, 'ipv6')

/** May holt connect to this address? Only globally routable unicast. IPv4-mapped IPv6 is judged as IPv4. Pure. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address)
  if (family === 4) return !blocked.check(address, 'ipv4')
  if (family !== 6) return false
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped) return isPublicAddress(mapped[1]!)
  if (/^::ffff:/i.test(address)) return false
  return !blocked.check(address, 'ipv6')
}

/** Only `https://host/...` on the default port, no credentials, not too long. Pure. */
export function acceptableSourceUrl(raw: string): URL | null {
  if (raw.length > MAX_URL_CHARS) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return null
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(host) && !isPublicAddress(host)) return null
  if (!net.isIP(host) && (!host.includes('.') || /\.(local|localhost|internal|lan|home\.arpa)$/i.test(host) || host === 'localhost')) return null
  return url
}

/** dns.lookup, refusing any answer that includes a non-public address. Runs at connect time. */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '', 0)
    const list = addresses as dns.LookupAddress[]
    if (!list.length || list.some((a) => !isPublicAddress(a.address))) {
      const refused = Object.assign(new Error(`${hostname} resolves to a non-public address`), { code: 'EHOLTBLOCKED' })
      return callback(refused, '', 0)
    }
    if (options.all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list)
    callback(null, list[0]!.address, list[0]!.family)
  })
}

class FetchRefused extends Error {}

function fetchOnce(url: URL, deadline: number): Promise<{ status: number; location: string | null; body: Buffer | null }> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return reject(new FetchRefused('timed out'))
    const request = https.request(url, {
      method: 'GET',
      lookup: publicLookup,
      agent: false,
      timeout: remaining,
      headers: { accept: 'image/png,image/jpeg,image/webp,image/gif', 'user-agent': 'holt-avatars (+https://holt.abstracteducation.loan)' },
    }, (response: IncomingMessage) => {
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400) {
        response.resume()
        return resolve({ status, location: typeof response.headers.location === 'string' ? response.headers.location : null, body: null })
      }
      if (status !== 200) {
        response.resume()
        return resolve({ status, location: null, body: null })
      }
      const declared = Number(response.headers['content-length'])
      if (Number.isFinite(declared) && declared > AVATAR_MAX_BYTES) {
        response.destroy()
        return reject(new FetchRefused('too large'))
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > AVATAR_MAX_BYTES) {
          response.destroy()
          reject(new FetchRefused('too large'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => resolve({ status, location: null, body: Buffer.concat(chunks) }))
      response.on('error', reject)
    })
    const timer = setTimeout(() => request.destroy(new FetchRefused('timed out')), remaining)
    request.on('close', () => clearTimeout(timer))
    request.on('timeout', () => request.destroy(new FetchRefused('timed out')))
    request.on('error', reject)
    request.end()
  })
}

/** The bytes behind a partner's avatar URL, under the address policy above. Throws FetchRefused or a network error. */
async function fetchSource(raw: string): Promise<Buffer> {
  const deadline = Date.now() + FETCH_TIMEOUT_MS
  let url = acceptableSourceUrl(raw)
  for (let hop = 0; url; hop++) {
    const answer = await fetchOnce(url, deadline)
    if (answer.body) return answer.body
    if (!answer.location) throw new FetchRefused(`HTTP ${answer.status}`)
    if (hop >= MAX_REDIRECTS) throw new FetchRefused('too many redirects')
    let next: string
    try {
      next = new URL(answer.location, url).href
    } catch {
      throw new FetchRefused('bad redirect')
    }
    url = acceptableSourceUrl(next)
  }
  throw new FetchRefused('URL not allowed')
}

// ---------------------------------------------------------------------------------------------------------
// Store

type ImageStatus = 'approved' | 'rejected' | 'pending'

interface SourceRow {
  image_sha256: string | null
  status: ImageStatus | null
  checked: Date | string
}

const urlHash = (url: string): string => createHash('sha256').update(url).digest('hex')

let publicOrigin = ''
let provider: ModerationProvider | null = null

/** Set once by holt-chat at start (vite.chat.config.ts): where avatars are served, and the model to ask. */
export function configurePartnerAvatars(options: { publicOrigin: string; provider: ModerationProvider | null }): void {
  publicOrigin = options.publicOrigin.replace(/\/+$/, '')
  provider = options.provider
  if (!provider) console.warn('[avatars] avatars.moderation is not configured: partner avatars stay the default')
}

export function publicAvatarUrl(sha256: string): string {
  return `${publicOrigin}${AVATAR_ROUTE}${sha256}.webp`
}

const memory = new Map<string, { url: string | null; until: number }>()
const queued = new Set<string>()
const queue: Array<{ hash: string; url: string }> = []
const newSources = new Map<string, { count: number; since: number }>()
let running = 0

function remember(hash: string, url: string | null): void {
  if (memory.size >= MAX_MEMORY) memory.delete(memory.keys().next().value as string)
  memory.set(hash, { url, until: Date.now() + MEMORY_TTL_MS })
}

function allowNewSource(identityKey: string): boolean {
  const now = Date.now()
  const hit = newSources.get(identityKey)
  if (!hit || now - hit.since > 60 * 60_000) {
    if (newSources.size > 20_000) newSources.clear()
    newSources.set(identityKey, { count: 1, since: now })
    return true
  }
  hit.count += 1
  return hit.count <= NEW_SOURCES_PER_HOUR
}

function enqueue(hash: string, url: string): void {
  if (queued.has(hash) || queue.length >= MAX_QUEUE) return
  queued.add(hash)
  queue.push({ hash, url })
  pump()
}

function pump(): void {
  while (running < CONCURRENCY && queue.length) {
    const job = queue.shift()!
    running += 1
    void check(job.hash, job.url)
      .catch((error) => console.warn('[avatars] check failed:', error instanceof Error ? error.message : error))
      .finally(() => {
        running -= 1
        queued.delete(job.hash)
        memory.delete(job.hash)
        pump()
      })
  }
}

async function recordSource(hash: string, url: string, imageSha: string | null, error: string | null): Promise<void> {
  // A failed re-fetch keeps the image already on file: a flaky host does not take an approved avatar away.
  await query(
    `INSERT INTO partner_avatar_source (url_hash, url, image_sha256, error, checked) VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (url_hash) DO UPDATE SET image_sha256 = COALESCE(EXCLUDED.image_sha256, partner_avatar_source.image_sha256),
       error = EXCLUDED.error, checked = NOW()`,
    [hash, url, imageSha, error],
  )
}

async function check(hash: string, url: string): Promise<void> {
  let bytes: Buffer
  try {
    bytes = await fetchSource(url)
  } catch (error) {
    return recordSource(hash, url, null, `fetch: ${error instanceof Error ? error.message.slice(0, 200) : 'failed'}`)
  }
  let webp: { bytes: Buffer; sha256: string }
  try {
    webp = await normalizeAvatar(bytes)
  } catch (error) {
    return recordSource(hash, url, null, `image: ${error instanceof AvatarImageError ? error.code : 'failed'}`)
  }
  const { rows } = await query<{ status: ImageStatus; checked: Date | string }>(
    `SELECT status, checked FROM partner_avatar_image WHERE sha256 = $1`, [webp.sha256])
  const known = rows[0]
  const settled = known && known.status !== 'pending'
  const freshPending = known && known.status === 'pending' && Date.now() - new Date(known.checked).getTime() < RETRY_MS
  if (!settled && !freshPending) {
    const verdict: ModerationVerdict = await moderateAvatarImage(webp.bytes, provider)
    await query(
      `INSERT INTO partner_avatar_image (sha256, bytes, status, categories, reason, model, raw, checked)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (sha256) DO UPDATE SET status = EXCLUDED.status, categories = EXCLUDED.categories,
         reason = EXCLUDED.reason, model = EXCLUDED.model, raw = EXCLUDED.raw, checked = NOW()
       WHERE partner_avatar_image.status = 'pending'`,
      [webp.sha256, webp.bytes, verdict.decision, verdict.categories, verdict.reason, verdict.model, verdict.raw],
    )
    if (verdict.decision !== 'approved') console.warn(`[avatars] ${webp.sha256.slice(0, 12)} ${verdict.decision}: ${verdict.categories.join(',') || verdict.raw.slice(0, 120)}`)
  }
  await recordSource(hash, url, webp.sha256, null)
}

/**
 * The URL to show for a partner user's avatar: holt's approved copy, or null (the default avatar) while it is
 * unchecked, pending, rejected or unreachable. Never waits for a check; queues one when due.
 */
export async function moderatedAvatarUrl(source: string, identityKey: string): Promise<string | null> {
  if (!publicOrigin || !acceptableSourceUrl(source)) return null
  const hash = urlHash(source)
  const hit = memory.get(hash)
  if (hit && hit.until > Date.now()) return hit.url
  let row: SourceRow | undefined
  try {
    const { rows } = await query<SourceRow>(
      `SELECT s.image_sha256, i.status, s.checked FROM partner_avatar_source s
       LEFT JOIN partner_avatar_image i ON i.sha256 = s.image_sha256 WHERE s.url_hash = $1`, [hash])
    row = rows[0]
  } catch (error) {
    console.warn('[avatars] lookup failed:', error instanceof Error ? error.message : error)
    return null
  }
  const approved = row?.status === 'approved' && row.image_sha256 ? publicAvatarUrl(row.image_sha256) : null
  if (!row) {
    if (allowNewSource(identityKey)) enqueue(hash, source)
  } else {
    const age = Date.now() - new Date(row.checked).getTime()
    if (age > (approved || row.status === 'rejected' ? RECHECK_MS : RETRY_MS)) enqueue(hash, source)
  }
  remember(hash, approved)
  return approved
}

/** GET /api/holt-avatars/<sha256>.webp in holt-chat (holt-service serves it publicly at /avatars/). */
export async function serveAvatar(sha256: string, response: ServerResponse): Promise<void> {
  const notFound = () => {
    response.statusCode = 404
    response.setHeader('Cache-Control', 'public, max-age=300')
    response.end()
  }
  if (!SHA.test(sha256)) return notFound()
  const { rows } = await query<{ bytes: Buffer }>(`SELECT bytes FROM partner_avatar_image WHERE sha256 = $1 AND status = 'approved'`, [sha256])
  const bytes = rows[0]?.bytes
  if (!bytes) return notFound()
  response.statusCode = 200
  response.setHeader('Content-Type', 'image/webp')
  response.setHeader('Content-Length', String(bytes.length))
  // Content-addressed and the verdict is final; a day keeps a manual DELETE of a bad row from lingering long.
  response.setHeader('Cache-Control', 'public, max-age=86400')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  response.end(bytes)
}

/** Test hook. */
export function resetPartnerAvatarsForTest(): void {
  memory.clear()
  queued.clear()
  queue.length = 0
  newSources.clear()
}
