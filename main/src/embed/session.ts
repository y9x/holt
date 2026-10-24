// The identity exchange from the frame's side: POST /api/session (same origin) turns the platform's
// identity token into a holt session. The session stays in memory; it is never written to a cookie or
// storage, because inside a partner's iframe both are third-party and partitioned or blocked.

export interface PublicPrincipal {
  key: string
  platform: string
  name: string
  emailVerified: boolean
  avatar: string | null
  tier: string | null
  admin: boolean
}

export interface HoltSession {
  token: string
  /** Epoch milliseconds. */
  expiresAt: number
  principal: PublicPrincipal
}

export type ExchangeResult =
  | { ok: true; session: HoltSession }
  | { ok: false; reason: 'rejected' | 'unreachable'; detail: string }

export type ProxyMeResult =
  | { ok: true; principal: PublicPrincipal | null }
  | { ok: false; detail: string }

/**
 * Proxy embedding: who the platform says is signed in. Same origin as the page (the platform's own
 * `/chat/`), so the platform's cookies go along and holt asks the platform server-side. Relative, so it
 * works under whatever path the platform proxies.
 */
export async function fetchProxyPrincipal(tokenStorageKey: string | null): Promise<ProxyMeResult> {
  const headers: Record<string, string> = { 'X-Holt': '1', Accept: 'application/json' }
  // A platform that keeps its login in localStorage: this page is on its origin, so the token is readable
  // here. It goes only to holt's same-origin endpoint, which forwards it to the platform's user-state URL.
  if (tokenStorageKey) {
    let token: string | null = null
    try {
      token = localStorage.getItem(tokenStorageKey)
    } catch { /* storage blocked: signed out as far as holt can tell */ }
    if (token && /^[A-Za-z0-9._~+/-]+=*$/.test(token)) headers.Authorization = `Bearer ${token}`
  }
  let response: Response
  try {
    response = await fetch('./_holt/me', { headers, credentials: 'same-origin', cache: 'no-store' })
  } catch {
    return { ok: false, detail: 'network error' }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { ok: false, detail: `HTTP ${response.status}` }
  }
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  if (!response.ok) return { ok: false, detail: typeof record.error === 'string' ? record.error : `HTTP ${response.status}` }
  const principal = record.principal
  return { ok: true, principal: typeof principal === 'object' && principal !== null ? (principal as PublicPrincipal) : null }
}

export async function exchangeToken(platformId: string, identityToken: string): Promise<ExchangeResult> {
  let response: Response
  try {
    response = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: platformId, token: identityToken }),
      credentials: 'omit',
    })
  } catch {
    return { ok: false, reason: 'unreachable', detail: 'network error' }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { ok: false, reason: 'unreachable', detail: `HTTP ${response.status}` }
  }
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  if (!response.ok) {
    return { ok: false, reason: response.status >= 500 ? 'unreachable' : 'rejected', detail: typeof record.error === 'string' ? record.error : `HTTP ${response.status}` }
  }
  if (typeof record.session !== 'string' || typeof record.expiresAt !== 'number' || typeof record.principal !== 'object' || record.principal === null) {
    return { ok: false, reason: 'unreachable', detail: 'unexpected response' }
  }
  return { ok: true, session: { token: record.session, expiresAt: record.expiresAt, principal: record.principal as PublicPrincipal } }
}
