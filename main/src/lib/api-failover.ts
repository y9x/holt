// fetch() for backend requests that survives a blocked backend domain.
//
// URLs that point at a configured API base are sent to the currently healthy
// base (api-base.ts ensureApiBase), even if the caller built the URL against
// an older base. When a request fails at the network level, the base is
// re-probed: a still-healthy base means the failure was route-specific and the
// original error is returned; a dead base is swapped for the next healthy one
// and the request is retried there. Any other URL is passed straight to fetch.

import {
  apiBaseOf,
  configuredApiBases,
  ensureApiBase,
  reportApiFailure,
  rewriteApiUrl,
  shouldRotateApiBase,
} from './api-base'

// Time allowed until response headers arrive. Covers firewalls that silently
// drop packets instead of refusing; streaming bodies are not cut off by it.
const HEADER_TIMEOUT_MS = 15_000

// Cloudflare could not reach the origin: the request never hit the app, so it
// is safe to replay even when it is not idempotent.
const NEVER_REACHED_ORIGIN = new Set([521, 522, 523])

class ApiTimeoutError extends Error {
  constructor() {
    super('API request timed out')
    this.name = 'TimeoutError'
  }
}

function fetchWithHeaderTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const outer = init.signal
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason)
    else outer.addEventListener('abort', () => controller.abort(outer.reason), { once: true })
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  return fetch(url, { ...init, signal: controller.signal }).then(
    (response) => {
      clearTimeout(timer)
      return response
    },
    (error) => {
      clearTimeout(timer)
      throw timedOut ? new ApiTimeoutError() : error
    },
  )
}

function replayable(body: RequestInit['body']): boolean {
  return !(typeof ReadableStream !== 'undefined' && body instanceof ReadableStream)
}

export async function failoverFetch(
  input: string,
  init: RequestInit = {},
  options: { headerTimeoutMs?: number } = {},
): Promise<Response> {
  if (!apiBaseOf(input)) return fetch(input, init)

  const method = (init.method || 'GET').toUpperCase()
  const idempotent = method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
  const canReplay = replayable(init.body)
  const timeoutMs = options.headerTimeoutMs ?? HEADER_TIMEOUT_MS
  const tried = new Set<string>()
  let base = await ensureApiBase()
  let lastError: unknown = null
  let lastResponse: Response | null = null

  for (let attempt = 0; attempt < Math.max(1, configuredApiBases().length); attempt++) {
    if (!base || tried.has(base)) break
    tried.add(base)
    let response: Response
    try {
      response = await fetchWithHeaderTimeout(rewriteApiUrl(input, base), init, timeoutMs)
    } catch (error) {
      if (init.signal?.aborted) throw error
      lastError = error
      const next = await reportApiFailure(base)
      if (next === base || !canReplay) throw error
      // A timed-out write may have reached the server; don't send it twice.
      if (error instanceof ApiTimeoutError && !idempotent) throw error
      base = next
      continue
    }
    if (!shouldRotateApiBase(response)) return response
    lastResponse = response
    const next = await reportApiFailure(base)
    if (next === base || !canReplay) return response
    if (!idempotent && !NEVER_REACHED_ORIGIN.has(response.status)) return response
    base = next
  }

  if (lastResponse) return lastResponse
  throw lastError instanceof Error ? lastError : new Error('API request failed')
}
