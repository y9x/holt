// Discord-style rate-limit handling for the chat API (bridge.ts, avatar.ts).
//
// Discord's HTTP layer never surfaces a 429 for normal actions: it waits the
// response's `retry_after`, retries, and holds later requests to the same
// route bucket behind the limited one so their order is preserved (a burst of
// sends lands in order, reaction toggles apply in click order). Typing pings
// are simply dropped while limited. Only after waiting "too long" does the
// request fail - and then it fails like any other request (the caller shows
// its normal failure state, never a rate-limit message).
//
// Buckets: keyed by method + route path (query stripped) unless the caller
// names one (e.g. forward shares the send bucket, like the server limiter).
// Writes run one at a time per bucket (Discord's message queue); reads run
// concurrently but still respect the bucket's block. A `global: true` 429
// (the server's per-IP limiter) blocks every bucket.

export interface RateLimitOptions {
  /** Route bucket; defaults to `${METHOD} ${pathname}`. */
  bucket?: string
  /** Aborting removes a queued/waiting request (rejects with AbortError). */
  signal?: AbortSignal | null
  /** One request in flight at a time (default: true for non-GET/HEAD). */
  serial?: boolean
  /** Drop instead of waiting (typing indicator): resolves the 429 response. */
  dropWhenLimited?: boolean
  /** Longest single retry_after we will wait out (default 60s). */
  maxSingleWaitMs?: number
  /** Give up once the request has been pending this long (default 3 min). */
  maxTotalMs?: number
}

export const RATE_LIMIT_MAX_SINGLE_WAIT_MS = 60_000
export const RATE_LIMIT_MAX_TOTAL_MS = 180_000
const JITTER_MS = 250

interface Item {
  run: () => Promise<Response>
  resolve: (response: Response) => void
  reject: (error: unknown) => void
  signal: AbortSignal | null
  onAbort: (() => void) | null
  enqueuedAt: number
  drop: boolean
  maxSingleWaitMs: number
  maxTotalMs: number
  settled: boolean
}

interface Bucket {
  key: string
  queue: Item[]
  inFlight: number
  serial: boolean
  blockedUntil: number
  timer: ReturnType<typeof setTimeout> | null
}

const buckets = new Map<string, Bucket>()
let globalBlockedUntil = 0

// Test hooks (fake clock / deterministic jitter); not used by the app.
export const rateLimitInternals = {
  now: () => Date.now(),
  jitter: () => Math.random() * JITTER_MS,
  reset() {
    for (const b of buckets.values()) if (b.timer) clearTimeout(b.timer)
    buckets.clear()
    globalBlockedUntil = 0
  },
}

function abortError(): Error {
  try {
    return new DOMException('The operation was aborted.', 'AbortError')
  } catch {
    const e = new Error('The operation was aborted.')
    e.name = 'AbortError'
    return e
  }
}

/** Whether `bucket` (or the global limit) is currently blocked. */
export function isRateLimited(bucket: string): boolean {
  const now = rateLimitInternals.now()
  return globalBlockedUntil > now || (buckets.get(bucket)?.blockedUntil ?? 0) > now
}

/** Retry delay of a 429 (ms) + whether it is global. Reads Discord's body
 *  `{ retry_after (s), global }`, falling back to the Retry-After header.
 *  null = no retry information (not a retryable rate limit). */
export async function readRetryAfter(response: Response): Promise<{ ms: number; global: boolean } | null> {
  let body: Record<string, unknown> = {}
  try {
    body = await response.clone().json() as Record<string, unknown>
  } catch { /* non-JSON 429 */ }
  const candidates = [body.retry_after, body.retryAfterSec, body.retryAfter, response.headers.get('Retry-After')]
  for (const value of candidates) {
    if (value === null || value === undefined || value === '') continue
    const sec = Number(value)
    if (Number.isFinite(sec) && sec >= 0) return { ms: Math.ceil(sec * 1000), global: body.global === true }
  }
  return null
}

function bucketFor(key: string, serial: boolean): Bucket {
  let b = buckets.get(key)
  if (!b) {
    b = { key, queue: [], inFlight: 0, serial, blockedUntil: 0, timer: null }
    buckets.set(key, b)
  }
  return b
}

function settle(item: Item, fn: () => void) {
  if (item.settled) return
  item.settled = true
  if (item.signal && item.onAbort) item.signal.removeEventListener('abort', item.onAbort)
  fn()
}

function pump(b: Bucket) {
  if (b.timer) {
    clearTimeout(b.timer)
    b.timer = null
  }
  const now = rateLimitInternals.now()
  const until = Math.max(b.blockedUntil, globalBlockedUntil)
  if (until > now) {
    if (b.queue.length) b.timer = setTimeout(() => pump(b), until - now)
    return
  }
  while (b.queue.length && (!b.serial || b.inFlight === 0)) {
    const item = b.queue.shift()!
    if (item.settled) continue
    void start(b, item)
  }
}

function pumpAll() {
  for (const b of buckets.values()) pump(b)
}

async function start(b: Bucket, item: Item) {
  b.inFlight += 1
  let response: Response
  try {
    response = await item.run()
  } catch (error) {
    b.inFlight -= 1
    settle(item, () => item.reject(error))
    pump(b)
    return
  }
  if (response.status !== 429) {
    b.inFlight -= 1
    settle(item, () => item.resolve(response))
    pump(b)
    return
  }
  const retry = await readRetryAfter(response)
  b.inFlight -= 1
  if (!retry) {
    // A 429 without retry info isn't a rate limit we can wait out.
    settle(item, () => item.resolve(response))
    pump(b)
    return
  }
  const now = rateLimitInternals.now()
  const waitMs = retry.ms + rateLimitInternals.jitter()
  if (retry.global) globalBlockedUntil = Math.max(globalBlockedUntil, now + waitMs)
  else b.blockedUntil = Math.max(b.blockedUntil, now + waitMs)
  const tooLong = retry.ms > item.maxSingleWaitMs || now - item.enqueuedAt + waitMs > item.maxTotalMs
  if (item.drop || tooLong || item.signal?.aborted) {
    // Give up: hand the 429 back; the caller treats it as an ordinary failure.
    settle(item, () => (item.signal?.aborted ? item.reject(abortError()) : item.resolve(response)))
  } else {
    // Retry first (ahead of anything queued behind it) once the block lifts.
    b.queue.unshift(item)
  }
  if (retry.global) pumpAll()
  else pump(b)
}

/**
 * Run `doFetch` through the bucket queue, waiting out 429s Discord-style.
 * `doFetch` is called again for each retry, so it must be re-runnable.
 * Resolves with the final Response (a 429 only after giving up or when
 * `dropWhenLimited`), rejects with AbortError when `signal` aborts.
 */
export function rateLimitedRequest(bucket: string, doFetch: () => Promise<Response>, options: RateLimitOptions & { method?: string } = {}): Promise<Response> {
  const method = (options.method || 'GET').toUpperCase()
  const serial = options.serial ?? !['GET', 'HEAD'].includes(method)
  const signal = options.signal ?? null
  const b = bucketFor(options.bucket || bucket, serial)
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    if (options.dropWhenLimited && isRateLimited(b.key)) {
      const retrySec = Math.max(0, Math.max(b.blockedUntil, globalBlockedUntil) - rateLimitInternals.now()) / 1000
      resolve(new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: retrySec, global: false }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }))
      return
    }
    const item: Item = {
      run: doFetch,
      resolve,
      reject,
      signal,
      onAbort: null,
      enqueuedAt: rateLimitInternals.now(),
      drop: Boolean(options.dropWhenLimited),
      maxSingleWaitMs: options.maxSingleWaitMs ?? RATE_LIMIT_MAX_SINGLE_WAIT_MS,
      maxTotalMs: options.maxTotalMs ?? RATE_LIMIT_MAX_TOTAL_MS,
      settled: false,
    }
    if (signal) {
      item.onAbort = () => {
        const index = b.queue.indexOf(item)
        if (index >= 0) b.queue.splice(index, 1)
        // In-flight requests reject through fetch's own signal; a queued or
        // waiting one is settled here.
        if (index >= 0) settle(item, () => reject(abortError()))
        pump(b)
      }
      signal.addEventListener('abort', item.onAbort, { once: true })
    }
    b.queue.push(item)
    pump(b)
  })
}

/** Default bucket for a URL: `${METHOD} ${pathname}` (query stripped). */
export function routeBucket(method: string, url: string): string {
  const path = url.split('?')[0].replace(/^https?:\/\/[^/]+/i, '')
  return `${method.toUpperCase()} ${path}`
}
