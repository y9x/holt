import { getCaptchaHeaders } from './captcha'
import { activeApiUrl } from './api-base'
import { failoverFetch } from './api-failover'
import { rateLimitedRequest, routeBucket, type RateLimitOptions } from './rate-limit-queue'

const TOKEN_KEY = 'abulxt:auth-token'

function authToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method || 'GET').toUpperCase()
  const headers = new Headers(init.headers || {})

  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  const token = authToken()
  if (token && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${token}`)
  }

  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const captchaHeaders = await getCaptchaHeaders()
    for (const [key, value] of Object.entries(captchaHeaders)) {
      if (value) headers.set(key, value)
    }
  }

  return failoverFetch(activeApiUrl(input), { ...init, headers })
}

// apiFetch with Discord's rate-limit behavior (rate-limit-queue.ts): a 429 is
// waited out (retry_after) and retried, queued behind its route bucket so
// order is preserved; it only resolves with a 429 after giving up (or when
// `dropWhenLimited`). Rejects with AbortError when the signal aborts.
export function apiFetchQueued(input: string, init: RequestInit = {}, options: RateLimitOptions = {}): Promise<Response> {
  const method = (init.method || 'GET').toUpperCase()
  const signal = options.signal ?? init.signal ?? null
  return rateLimitedRequest(
    options.bucket || routeBucket(method, input),
    () => apiFetch(input, { ...init, signal }),
    { ...options, method, signal },
  )
}
