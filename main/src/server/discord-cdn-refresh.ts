// Discord signed-CDN URL refresh. Attachment URLs on cdn.discordapp.com /
// media.discordapp.net carry a signature (`ex` = hex unix-seconds expiry,
// `is` = issued, `hm` = HMAC) and stop working ~24h after issue. Rows in
// discord_bridge_message keep the URL they were written with, so before a
// stored message is served (/history, /pins, /search, live pages) every
// signed URL that is expired or expiring within REFRESH_MARGIN_MS is batch-
// refreshed through Discord's POST /attachments/refresh-urls (bot token, ≤50
// URLs per call), cached in memory, and - for DB rows - persisted back with a
// targeted UPDATE of the media JSONB columns only (attachments / embeds /
// forwarded / components; never content or edited_at).
//
// Only Discord's own CDN hosts are ever sent to Discord; any other host is
// left untouched. Refresh is best-effort: on any failure the stored URL is
// served unchanged.

import { query } from './db.js'
import { discordFetch } from './discord-roles.js'

const CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net'])
const SIGNED_PATH_RE = /^\/(attachments|ephemeral-attachments)\//
const REFRESH_MARGIN_MS = 60 * 60 * 1000
const BATCH_SIZE = 50
const MAX_BATCHES_PER_CALL = 4
const MIN_CALL_GAP_MS = 400
const CACHE_MAX = 5000
const FAIL_BACKOFF_MS = 30_000

interface Signed {
  url: URL
  key: string // host-agnostic identity: the attachment path
  expiresMs: number
}

function parseSigned(value: string): Signed | null {
  if (!value.startsWith('https://')) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (!CDN_HOSTS.has(url.hostname) || !SIGNED_PATH_RE.test(url.pathname)) return null
  const ex = url.searchParams.get('ex')
  if (!ex || !/^[0-9a-f]{1,12}$/i.test(ex)) return null
  return { url, key: url.pathname, expiresMs: parseInt(ex, 16) * 1000 }
}

function needsRefresh(s: Signed, now: number): boolean {
  return s.expiresMs - now < REFRESH_MARGIN_MS
}

// Refreshed signature params per attachment path.
const cache = new Map<string, { ex: string; is: string; hm: string; expiresMs: number }>()

function remember(key: string, refreshed: URL): void {
  const ex = refreshed.searchParams.get('ex')
  const is = refreshed.searchParams.get('is')
  const hm = refreshed.searchParams.get('hm')
  if (!ex || !is || !hm || !/^[0-9a-f]{1,12}$/i.test(ex)) return
  cache.delete(key)
  cache.set(key, { ex, is, hm, expiresMs: parseInt(ex, 16) * 1000 })
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
}

// Apply cached fresh signature params to a URL, keeping its host and any
// other params (media proxy width/height/format).
function applyCached(s: Signed, now: number): string | null {
  const hit = cache.get(s.key)
  if (!hit || needsRefresh({ ...s, expiresMs: hit.expiresMs }, now)) return null
  const next = new URL(s.url.toString())
  next.searchParams.set('ex', hit.ex)
  next.searchParams.set('is', hit.is)
  next.searchParams.set('hm', hit.hm)
  return next.toString()
}

// One Discord call at a time, spaced MIN_CALL_GAP_MS apart; a failure backs
// the whole refresher off for FAIL_BACKOFF_MS so an outage isn't hammered.
let chain: Promise<unknown> = Promise.resolve()
let lastCallAt = 0
let failedAt = 0

async function callRefresh(urls: string[]): Promise<void> {
  const run = async () => {
    if (Date.now() - failedAt < FAIL_BACKOFF_MS) return
    const wait = lastCallAt + MIN_CALL_GAP_MS - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastCallAt = Date.now()
    const response = await discordFetch('/attachments/refresh-urls', {
      method: 'POST',
      body: JSON.stringify({ attachment_urls: urls }),
    }).catch(() => null)
    if (!response || !response.ok) {
      failedAt = Date.now()
      await response?.body?.cancel().catch(() => {})
      return
    }
    const body = (await response.json().catch(() => null)) as { refreshed_urls?: Array<{ original?: string; refreshed?: string }> } | null
    for (const entry of body?.refreshed_urls || []) {
      if (typeof entry.refreshed !== 'string') continue
      const refreshed = parseSigned(entry.refreshed)
      if (refreshed) remember(refreshed.key, refreshed.url)
    }
  }
  const next = chain.then(run, run)
  chain = next.catch(() => {})
  await next.catch(() => {})
}

// A fetchable form of one Discord CDN attachment URL (link unfurl): returned
// as-is while its signature is valid, else re-signed through refresh-urls
// (Discord serves unsigned or expired attachment URLs as a 404 "This content
// is no longer available"). null = not a Discord CDN attachment URL, or the
// refresh failed.
export async function freshCdnUrl(value: string): Promise<string | null> {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || !CDN_HOSTS.has(url.hostname) || !SIGNED_PATH_RE.test(url.pathname)) return null
  const now = Date.now()
  const signed = parseSigned(value)
  if (signed && !needsRefresh(signed, now)) return value
  const s: Signed = signed ?? { url, key: url.pathname, expiresMs: 0 }
  const cached = applyCached(s, now)
  if (cached) return cached
  const cdn = new URL(`https://cdn.discordapp.com${url.pathname}`)
  for (const p of ['ex', 'is', 'hm']) {
    const v = url.searchParams.get(p)
    if (v) cdn.searchParams.set(p, v)
  }
  await callRefresh([cdn.toString()])
  return applyCached(s, now)
}

// Walk any JSON value, collecting signed CDN URL strings (whole-string only).
function collect(value: unknown, out: Signed[], depth = 0): void {
  if (depth > 12 || value == null) return
  if (typeof value === 'string') {
    const s = parseSigned(value)
    if (s) out.push(s)
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) collect(v, out, depth + 1)
    return
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collect(v, out, depth + 1)
  }
}

// Return a copy of `value` with every signed URL replaced via `map`; `changed`
// reports whether anything differed.
function rewrite(value: unknown, map: Map<string, string>, depth = 0): { value: unknown; changed: boolean } {
  if (depth > 12 || value == null) return { value, changed: false }
  if (typeof value === 'string') {
    const next = map.get(value)
    return next && next !== value ? { value: next, changed: true } : { value, changed: false }
  }
  if (Array.isArray(value)) {
    let changed = false
    const arr = value.map((v) => {
      const r = rewrite(v, map, depth + 1)
      changed ||= r.changed
      return r.value
    })
    return changed ? { value: arr, changed } : { value, changed: false }
  }
  if (typeof value === 'object') {
    let changed = false
    const obj: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = rewrite(v, map, depth + 1)
      changed ||= r.changed
      obj[k] = r.value
    }
    return changed ? { value: obj, changed } : { value, changed: false }
  }
  return { value, changed: false }
}

// The media-bearing fields of a message row.
const MEDIA_FIELDS = ['attachments', 'embeds', 'forwarded', 'components'] as const
type MediaField = typeof MEDIA_FIELDS[number]
type MediaCarrier = { id: number } & Partial<Record<MediaField, unknown>>

// Refresh signed CDN URLs in a batch of messages. Returns new message objects
// (unchanged ones are returned as-is). `persist` writes refreshed media back
// to discord_bridge_message for DB rows (id > 0) - never for live Discord
// pages, which aren't stored.
export async function refreshMessageMedia<T extends MediaCarrier>(messages: T[], opts: { persist: boolean }): Promise<T[]> {
  if (!messages.length) return messages
  const now = Date.now()
  const found: Signed[] = []
  for (const m of messages) for (const f of MEDIA_FIELDS) collect(m[f], found)
  const stale = found.filter((s) => needsRefresh(s, now))
  if (!stale.length) return messages

  const map = new Map<string, string>()
  const pending = new Map<string, Signed>()
  for (const s of stale) {
    const cached = applyCached(s, now)
    if (cached) map.set(s.url.toString(), cached)
    else if (!pending.has(s.key)) pending.set(s.key, s)
  }
  if (pending.size) {
    // Discord's refresher takes the canonical cdn.discordapp.com form; the
    // signature is path-based, so a media proxy URL refreshes the same way.
    const urls = [...pending.values()].map((s) => {
      const cdn = new URL(`https://cdn.discordapp.com${s.url.pathname}`)
      for (const p of ['ex', 'is', 'hm']) {
        const v = s.url.searchParams.get(p)
        if (v) cdn.searchParams.set(p, v)
      }
      return cdn.toString()
    })
    for (let i = 0; i < urls.length && i / BATCH_SIZE < MAX_BATCHES_PER_CALL; i += BATCH_SIZE) {
      await callRefresh(urls.slice(i, i + BATCH_SIZE))
    }
    for (const s of stale) {
      if (map.has(s.url.toString())) continue
      const fresh = applyCached(s, now)
      if (fresh) map.set(s.url.toString(), fresh)
    }
  }
  if (!map.size) return messages

  return messages.map((m) => {
    const next: Record<string, unknown> = { ...m }
    const changedFields: MediaField[] = []
    for (const f of MEDIA_FIELDS) {
      if (m[f] === undefined) continue
      const r = rewrite(m[f], map)
      if (r.changed) {
        next[f] = r.value
        changedFields.push(f)
      }
    }
    if (!changedFields.length) return m
    if (opts.persist && m.id > 0) void persistMedia(m.id, next, changedFields)
    return next as T
  })
}

// Targeted write-back: only the media JSONB columns that changed; content,
// edited_at and every other column stay untouched. Deleted rows are skipped.
async function persistMedia(id: number, row: Record<string, unknown>, fields: MediaField[]): Promise<void> {
  const sets: string[] = []
  const params: unknown[] = [id]
  for (const f of fields) {
    params.push(JSON.stringify(row[f] ?? null))
    sets.push(`${f} = $${params.length}::jsonb`)
  }
  await query(
    `UPDATE discord_bridge_message SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL`,
    params,
  ).catch(() => {})
}
