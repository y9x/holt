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
