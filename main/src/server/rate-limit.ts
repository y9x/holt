

export type RateLimitOk = { ok: true }
export type RateLimitHit = { ok: false; retryAfterSec: number; error: string }
export type RateLimitResult = RateLimitOk | RateLimitHit

type Bucket = number[]

const buckets = new Map<string, Bucket>()
let lastSweep = 0

function sweep(now: number, windowMs: number) {

  if (now - lastSweep < 30_000 && buckets.size < 12_000) return
  lastSweep = now
  const cutoff = now - Math.max(windowMs, 60_000)
  for (const [key, hits] of buckets) {
    const kept = hits.filter((t) => t > cutoff)
    if (!kept.length) buckets.delete(key)
    else buckets.set(key, kept)
  }

  if (buckets.size > 40_000) {
    const keys = [...buckets.keys()].slice(0, buckets.size - 20_000)
    for (const key of keys) buckets.delete(key)
  }
}

export function rateLimit(
  key: string,
  opts: { limit: number; windowMs: number; error?: string },
): RateLimitResult {
  const now = Date.now()
  sweep(now, opts.windowMs)
  const windowStart = now - opts.windowMs
  const prev = buckets.get(key) || []
  const hits = prev.filter((t) => t > windowStart)
  if (hits.length >= opts.limit) {
    const oldest = hits[0] ?? now
    const retryAfterSec = Math.max(1, Math.ceil((oldest + opts.windowMs - now) / 1000))
    buckets.set(key, hits)
    return {
      ok: false,
      retryAfterSec,
      error: opts.error || 'Too many requests. Slow down and try again.',
    }
  }
  hits.push(now)
  buckets.set(key, hits)
  return { ok: true }
}

export function isScriptedUserAgent(ua: string | undefined | null): boolean {
  const s = String(ua || '').trim().toLowerCase()
  if (!s) return true
  return /^(node(?:\/|\s|$)|python-requests|python-urllib|curl\/|wget\/|go-http-client|java\/|apache-httpclient|libwww-perl|scrapy|httpclient|okhttp|postmanruntime|insomnia)/.test(s)
}

// Discord's 429 shape: `Retry-After` header + { message, retry_after (seconds),
// global }. The chat client (src/lib/rate-limit-queue.ts) waits retry_after and
// retries quietly, so every rate-limited route must answer with this shape.
// `error` / `retryAfterSec` are kept for older clients that read them.
export function rateLimitedBody(retryAfterSec: number, error = 'You are being rate limited.', global = false) {
  const retry = Math.max(0, Number.isFinite(retryAfterSec) ? retryAfterSec : 1)
  return { message: 'You are being rate limited.', retry_after: retry, global, code: 429, error, retryAfterSec: retry }
}

export function sendRateLimited(
  response: { statusCode: number; setHeader(name: string, value: string): unknown; end(body: string): unknown },
  retryAfterSec: number,
  error?: string,
  global = false,
) {
  const body = rateLimitedBody(retryAfterSec, error, global)
  response.statusCode = 429
  response.setHeader('Retry-After', String(Math.ceil(body.retry_after)))
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}
