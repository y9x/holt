import { apiUrl } from './api-base'
import { apiFetch } from './api-fetch'
import { invalidateAdsConfig } from './ads'
import { reconnectRt } from './rt'

export type AbulxtUser = {
  id: number
  username: string
  email?: string | null
  emailVerified?: boolean
  admin?: boolean
  createdAt: string
  plan?: 'free'
  totpEnabled?: boolean
  hasPasskeys?: boolean
  pronouns?: string | null
  aboutMe?: string | null
  /** Stored chat display name (null = use the site username). */
  chatDisplayName?: string | null
  /** Stored Set Status choice (online | idle | dnd | invisible). */
  presenceStatus?: string | null
  sandbox?: boolean
  discord?: { id: string; username: string | null; name: string | null; avatar: string | null } | null
}

export type LoginResult =
  | { kind: 'done'; user: AbulxtUser }
  | { kind: '2fa'; pending: string; needsTotp: boolean }

// holt's own session (embed/proxy-session.ts), never the platform's login: on abulxt's site the platform's
// token lives under abulxt:auth-token on the same origin.
const tokenKey = 'holt:session'
const base = apiUrl('/api/auth')
const accountBase = apiUrl('/api/account')
const webauthnBase = apiUrl('/api/webauthn')
const adminBase = apiUrl('/api/admin')

export function getAuthToken() {
  try {
    return localStorage.getItem(tokenKey)
  } catch {
    return null
  }
}

function setAuthToken(token: string | null) {
  try {
    if (token) localStorage.setItem(tokenKey, token)
    else localStorage.removeItem(tokenKey)
  } catch {

  }
  invalidateAdsConfig()
  reconnectRt()
}

async function request<T>(path: string, options: RequestInit = {}, baseUrl: string = base): Promise<T> {
  const response = await apiFetch(`${baseUrl}${path}`, options)
  const raw = await response.text()
  let data: Record<string, unknown> & { error?: string } = {}
  let parsed = true
  try {
    data = raw ? JSON.parse(raw) as Record<string, unknown> & { error?: string } : {}
  } catch {
    parsed = false
  }

  if (response.status === 401) {
    setAuthToken(null)
    throw new Error(typeof data.error === 'string' ? data.error : 'Sign in to continue.')
  }
  if (!parsed) throw new Error(response.ok ? 'Auth API returned a non-JSON response.' : 'Request failed')
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Request failed')
  return data as T
}

export async function register(username: string, password: string, email?: string, captchaToken?: string) {
  const data = await request<{ token: string; user: AbulxtUser }>('/register', {
    method: 'POST',
    body: JSON.stringify({ username, password, email: email || undefined, captchaToken }),
  })
  setAuthToken(data.token)
  return data.user
}

export async function login(username: string, password: string, captchaToken?: string): Promise<LoginResult> {
  const data = await request<{ token?: string; user?: AbulxtUser; pending?: string; needsTotp?: boolean }>('/login', {
    method: 'POST',
    body: JSON.stringify({ username, password, captchaToken }),
  })
  if (data.pending) {
    return { kind: '2fa', pending: data.pending, needsTotp: Boolean(data.needsTotp) }
  }
  if (!data.token || !data.user) throw new Error('Login failed.')
  setAuthToken(data.token)
  return { kind: 'done', user: data.user }
}

export async function completeLogin2fa(pending: string, codes: { totpCode?: string; emailCode?: string }) {
  const data = await request<{ token: string; user: AbulxtUser }>('/login/2fa', {
    method: 'POST',
    body: JSON.stringify({ pending, ...codes }),
  })
  setAuthToken(data.token)
  return data.user
}

let meInflight: Promise<AbulxtUser> | null = null
let meCache: { user: AbulxtUser; at: number } | null = null
const ME_TTL = 30_000

export async function me(): Promise<AbulxtUser> {
  if (meCache && Date.now() - meCache.at < ME_TTL) return meCache.user
  if (meInflight) return meInflight
  meInflight = (async () => {
    const data = await request<{ user?: AbulxtUser; captcha?: boolean; mail?: boolean }>('/me')
    if (!data.user?.username) {
      setAuthToken(null)
      meCache = null
      throw new Error('Sign in to continue.')
    }
    meCache = { user: data.user, at: Date.now() }
    return data.user
  })()
  try {
    return await meInflight
  } finally {
    meInflight = null
  }
}

export function invalidateMe(): void {
  meCache = null
}

export async function logout() {
  try {
    await request('/logout', { method: 'POST' })
  } catch {
    /* ignore */
  }
  setAuthToken(null)
}

export type SessionInfo = {
  id: string
  created: string
  lastSeen: string
  expires: string | null
  device: string
  geo: string | null
  current: boolean
}

const post = <T,>(path: string, body: Record<string, unknown>, baseUrl: string = accountBase) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) }, baseUrl)

export const changePassword = (current: string, next: string) => post<{ ok: true }>('/change-password', { current, next })
export const changeUsername = (next: string, password: string) => post<{ ok: true; username: string }>('/change-username', { next, password })
export const setEmail = (email: string) => post<{ ok: true }>('/set-email', { email })
export const resendVerification = () => post<{ ok: true }>('/resend-verification', {})
export const verifyEmail = (code: string) => post<{ ok: true; email: string }>('/verify-email', { code })
export const forgotPassword = (identifier: string) => post<{ ok: true }>('/forgot-password', { identifier })
export const resetPassword = (identifier: string, code: string, next: string) => post<{ ok: true }>('/reset-password', { identifier, code, next })
export const saveProfileText = (pronouns: string, aboutMe: string) =>
  post<{ ok: true; pronouns: string | null; aboutMe: string | null }>('/profile', { pronouns, aboutMe })
export const deleteAccount = (password: string) => post<{ ok: true }>('/delete', { password })

// Persists the Set Status choice (server presence.ts); other devices get it live.
export const savePresenceStatus = (status: string) => post<{ status: string; shown: string }>('/presence', { status })

export const listSessions = () => request<{ sessions: SessionInfo[] }>('/sessions', {}, accountBase).then((d) => d.sessions)
export const revokeSession = (id: string) => post<{ ok: true }>('/sessions/revoke', { id })
export const revokeOtherSessions = () => post<{ ok: true }>('/sessions/revoke-others', {})

export const totpSetup = () => post<{ secret: string; uri: string; qr: string }>('/totp/setup', {})
export const totpEnable = (code: string) => post<{ ok: true; backupCode: string }>('/totp/enable', { code })
export const totpDisable = (password: string) => post<{ ok: true }>('/totp/disable', { password })

export function discordLinkUrl(): string {
  const token = getAuthToken()
  return apiUrl(`/api/account/discord/link${token ? `?token=${encodeURIComponent(token)}` : ''}`)
}
export const discordUnlink = () => post<{ ok: true }>('/discord/unlink', {})
export async function setDiscordId(discordId: string) {
  const data = await post<{ ok: true; discordId: string; status: string; dmSent: boolean }>('/discord/set-id', { discordId })
  invalidateMe()
  return data
}

export type PasskeyInfo = { id: number; name: string | null; device: string | null; lastUsed: string | null; created: string }

export const passkeyRegisterOptions = () => post<{ options: Record<string, unknown> }>('/register-options', {}, webauthnBase)
export const passkeyRegisterVerify = (response: unknown, name: string) => post<{ ok: true }>('/register-verify', { response, name }, webauthnBase)
export const passkeyLoginOptions = () => post<{ options: Record<string, unknown>; ownerKey: string }>('/login-options', {}, webauthnBase)
export const passkeyLoginVerify = (response: unknown, ownerKey: string) =>
  post<{ token: string; user: AbulxtUser }>('/login-verify', { response, ownerKey }, webauthnBase)
export const passkeyList = () => request<{ passkeys: PasskeyInfo[] }>('/list', {}, webauthnBase).then((d) => d.passkeys)
export const passkeyDelete = (id: number) => post<{ ok: true }>('/delete', { id }, webauthnBase)

export async function completePasskeyLogin(token: string) {
  setAuthToken(token)
}

export type AdminUser = { id: number; username: string; email: string | null; admin: boolean; created: string; banned: boolean }
export type AdminUsage = {
  id: number
  username: string
  requests: number
  tokens: number
  todayRequests: number
  todayTokens: number
  hourly: number[]
}

export const adminListUsers = () => request<{ users: AdminUser[] }>('/users', {}, adminBase).then((d) => d.users)
export const adminBan = (userId: number, reason?: string, days?: number | null) => post<{ ok: true }>('/ban', { userId, reason, days }, adminBase)
export const adminUnban = (userId: number) => post<{ ok: true }>('/unban', { userId }, adminBase)
export const adminSetAdmin = (userId: number, admin: boolean) => post<{ ok: true }>('/set-admin', { userId, admin }, adminBase)
export const adminSetSandbox = (userId: number, sandbox: boolean) => post<{ ok: true }>('/set-sandbox', { userId, sandbox }, adminBase)
export const adminUsage = () => request<{ usage: AdminUsage[] }>('/usage', {}, adminBase).then((d) => d.usage)

export type AdminTrafficEvent = {
  id: string
  kind: 'ai' | 'wisp' | string
  ip: string
  country: string | null
  city: string | null
  region: string | null
  userId: number | null
  username: string | null
  path: string | null
  meta: Record<string, unknown>
  created: string
  location: string | null
}

export const adminTraffic = (opts?: { kind?: 'ai' | 'wisp'; limit?: number }) => {
  const q = new URLSearchParams()
  if (opts?.kind) q.set('kind', opts.kind)
  if (opts?.limit) q.set('limit', String(opts.limit))
  const suffix = q.toString() ? `/traffic?${q}` : '/traffic'
  return request<{ events: AdminTrafficEvent[]; dns?: string[] }>(suffix, {}, adminBase)
}

export type AdminUserDetail = {
  id: number
  username: string
  email: string | null
  emailVerified: boolean
  admin: boolean
  created: string
  totpEnabled: boolean
  emailOtpEnabled: boolean
  hasStripe: boolean
  sandbox: boolean
  sessions: number
  passkeys: number
  banned: boolean
  banReason: string | null
  banExpires: string | null
}
export const adminUserDetail = (userId: number) =>
  request<{ user: AdminUserDetail }>(`/user-detail?userId=${userId}`, {}, adminBase).then((d) => d.user)

export type AdminRevenue = {
  daily: { day: string; cents: number; count: number }[]
  totalCents: number
  transactions: number
}
export const adminRevenue = () => request<AdminRevenue>('/revenue', {}, adminBase)

export type AdminAdStats = {
  adcash: {
    configured: boolean
    ok: boolean
    error?: string
    currency: string
    totalRevenue: number
    stats: { zoneId: string; impressions: number; clicks: number; revenue: number }[]
  }
  adsterra: {
    configured: boolean
    ok: boolean
    error?: string
    totalRevenue: number
    stats: { zone: string; format: string; impressions: number; clicks: number; revenue: number }[]
  }
}
export const adminAdStats = () => request<AdminAdStats>('/ads-stats', {}, adminBase)

export type AdminTransaction = {
  id: string
  username: string
  tier: string
  amountCents: number | null
  currency: string
  source: string
  actor: string | null
  periodEnd: string | null
  created: string
}
export const adminTransactions = () => request<{ transactions: AdminTransaction[] }>('/transactions', {}, adminBase).then((d) => d.transactions)

export type AdminAuditEntry = { id: string; admin: string | null; action: string; target: string | null; detail: unknown; created: string }
export const adminAudit = () => request<{ audit: AdminAuditEntry[] }>('/audit', {}, adminBase).then((d) => d.audit)
