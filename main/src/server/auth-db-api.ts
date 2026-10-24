import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, ViteDevServer } from 'vite'
import { configureDatabase, dbConfigured, ensureSchema, query } from './db.js'
import { loadConfig } from './config.js'
import { captchaEnabled, verifyCaptcha } from './captcha.js'
import { mailEnabled, sendEmailVerification, generateVerificationCode, canSendEmail } from './email.js'
import {
  activeBan,
  createSession,
  hashPassword,
  sessionForToken,
  startSessionCleanup,
  validateEmail,
  validatePassword,
  validateUsername,
  verifyPassword,
} from './account.js'
import { checkTotp } from './totp.js'
import { parseRequestUrl } from './request-url.ts'
import { planForEntitlement } from '../ai-plans.js'
import { isScriptedUserAgent, rateLimit } from './rate-limit.ts'

export type DbUser = {
  id: number
  username: string
  email: string | null
  email_verified: boolean
  admin: boolean
  created: Date
  stripe_customer_id: string | null
  stripe_sandbox_customer_id: string | null
  sandbox: boolean
  totp_enabled: boolean
  email_otp_enabled: boolean
  discord_id?: string | null
  discord_username?: string | null
  discord_avatar?: string | null
  discord_name?: string | null
  hasPasskeys?: boolean
  pronouns?: string | null
  about_me?: string | null
  chat_display_name?: string | null
  presence_status?: string | null
  /** Entitlements: King Proxy until / No Ads until (ai-plans.ts planForEntitlement). */
  paid_until?: Date | null
  noads_until?: Date | null
}

export function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}

export async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization || ''
  if (!header.startsWith('Bearer ')) return null
  const token = header.slice(7).trim()
  return token || null
}

export function requestIp(request: IncomingMessage): string | null {

  const cf = request.headers['cf-connecting-ip']
  if (typeof cf === 'string' && cf.trim()) return cf.trim()
  if (Array.isArray(cf) && cf[0]?.trim()) return cf[0].trim()
  const xff = request.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim()
  if (Array.isArray(xff) && xff[0]?.trim()) return xff[0].split(',')[0].trim()
  return request.socket?.remoteAddress || null
}

function sendRateLimited(response: ServerResponse, hit: { retryAfterSec: number; error: string }) {
  response.setHeader('Retry-After', String(hit.retryAfterSec))
  return sendJson(response, 429, { error: hit.error, retryAfterSec: hit.retryAfterSec })
}

const USER_COLUMNS = `id, username, email, email_verified, admin, created, stripe_customer_id, stripe_sandbox_customer_id, sandbox, totp_enabled, email_otp_enabled, discord_id, discord_username, discord_avatar, discord_name, pronouns, about_me, chat_display_name, presence_status, paid_until, noads_until`

export function publicUser(user: DbUser) {
  return {
    username: user.username,
    email: user.email,
    emailVerified: user.email_verified,
    admin: user.admin,
    createdAt: user.created,
    plan: planForEntitlement(user),
    totpEnabled: user.totp_enabled,
    sandbox: user.sandbox,
    hasPasskeys: Boolean(user.hasPasskeys),
    pronouns: user.pronouns ?? null,
    aboutMe: user.about_me ?? null,
    chatDisplayName: user.chat_display_name ?? null,
    presenceStatus: user.presence_status ?? 'online',
    discord: user.discord_id
      ? { id: user.discord_id, username: user.discord_username, name: user.discord_name, avatar: user.discord_avatar }
      : null,
  }
}

export async function resolveAuthUser(request: IncomingMessage): Promise<DbUser | null> {
  const token = bearerToken(request)
  if (!token) return null
  const session = await sessionForToken(token)
  if (!session) return null
  const { rows } = await query<DbUser>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [session.user_id])
  const user = rows[0]
  if (!user) return null
  if (await activeBan(user.id)) return null
  const { rows: pk } = await query<{ count: string }>('SELECT count(*)::text AS count FROM passkey WHERE user_id = $1', [user.id])
  user.hasPasskeys = Number(pk[0]?.count ?? 0) > 0
  return user
}

export async function userForToken(token: string): Promise<DbUser | null> {
  const session = await sessionForToken(token)
  if (!session) return null
  const { rows } = await query<DbUser>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [session.user_id])
  const user = rows[0]
  if (!user) return null
  if (await activeBan(user.id)) return null
  return user
}

export async function resolveAuthSession(request: IncomingMessage) {
  const token = bearerToken(request)
  if (!token) return null
  return sessionForToken(token)
}

export function authDbApi(options?: { dataDir?: string }): Plugin {
  function register(server: { middlewares: ViteDevServer['middlewares'] }) {
    server.middlewares.use(async (request, response, next) => {
      const url = parseRequestUrl(request.url)
      if (!url.pathname.startsWith('/api/auth')) return next()
      if (!dbConfigured()) {
        return sendJson(response, 503, { error: 'Accounts database is not configured (set DATABASE_URL).' })
      }
      await ensureSchema(options?.dataDir)
      startSessionCleanup()

      const method = request.method || 'GET'
      const pathName = url.pathname.replace(/\/$/, '') || '/'
      const ip = requestIp(request as IncomingMessage)

      try {
        if (method === 'POST' && pathName === '/api/auth/register') {
          const ua = request.headers['user-agent'] || ''
          const ipKey = ip || 'unknown'

          if (isScriptedUserAgent(ua)) {
            return sendJson(response, 403, { error: 'Automated clients cannot register. Use a browser.' })
          }

          const perIpBurst = rateLimit(`auth:register:ip:${ipKey}`, {
            limit: 5,
            windowMs: 15 * 60_000,
            error: 'Too many registration attempts from your network. Try again later.',
          })
          if (!perIpBurst.ok) return sendRateLimited(response, perIpBurst)

          const perIpDay = rateLimit(`auth:register:ipday:${ipKey}`, {
            limit: 15,
            windowMs: 24 * 60 * 60_000,
            error: 'Daily registration limit reached for your network. Try again tomorrow.',
          })
          if (!perIpDay.ok) return sendRateLimited(response, perIpDay)

          const globalBurst = rateLimit('auth:register:global', {
            limit: 60,
            windowMs: 60_000,
            error: 'Registration is temporarily rate-limited. Try again in a minute.',
          })
          if (!globalBurst.ok) return sendRateLimited(response, globalBurst)

          const body = await readBody(request as IncomingMessage)
          const username = String(body.username ?? '').trim()
          const password = String(body.password ?? '')
          const email = String(body.email ?? '').trim()
          if (!(request as IncomingMessage & { abulxtCaptchaVerified?: boolean }).abulxtCaptchaVerified
            && !(await verifyCaptcha(body.captchaToken as string | undefined, ip))) {
            return sendJson(response, 400, { error: 'Captcha verification failed. Try again.' })
          }
          const usernameError = validateUsername(username)
          if (usernameError) return sendJson(response, 400, { error: usernameError })
          const passwordError = validatePassword(password)
          if (passwordError) return sendJson(response, 400, { error: passwordError })
          if (email) {
            const emailError = validateEmail(email)
            if (emailError) return sendJson(response, 400, { error: emailError })
          }
          const { rows: existing } = await query('SELECT 1 FROM users WHERE lower(username) = lower($1)', [username])
          if (existing.length) return sendJson(response, 409, { error: 'That username is taken.' })
          if (email) {
            const { rows: emailTaken } = await query('SELECT 1 FROM users WHERE email IS NOT NULL AND lower(email) = lower($1)', [email])
            if (emailTaken.length) return sendJson(response, 409, { error: 'That email is already in use.' })
          }
          const { salt, hash } = await hashPassword(password)

          const code = email ? generateVerificationCode() : null
          const { rows } = await query<DbUser>(
            `INSERT INTO users (username, password_salt, password_hash, email, email_verified, email_verification_code)
             VALUES ($1, $2, $3, $4, FALSE, $5)
             RETURNING ${USER_COLUMNS}`,
            [username, salt, hash, email || null, code],
          )
          const user = rows[0]
          if (email && code && mailEnabled()) {
            const throttle = await canSendEmail(email, ip, user.id)
            if (!throttle) await sendEmailVerification(email, code).catch(() => {})
          }
          const token = await createSession(user.id, ip, request.headers['user-agent'] || null)
          return sendJson(response, 201, { token, user: publicUser(user) })
        }

        if (method === 'POST' && pathName === '/api/auth/login') {
          const ua = request.headers['user-agent'] || ''
          const ipKey = ip || 'unknown'
          if (isScriptedUserAgent(ua)) {
            return sendJson(response, 403, { error: 'Automated clients cannot sign in. Use a browser.' })
          }
          const loginBurst = rateLimit(`auth:login:ip:${ipKey}`, {
            limit: 30,
            windowMs: 15 * 60_000,
            error: 'Too many sign-in attempts. Try again in a few minutes.',
          })
          if (!loginBurst.ok) return sendRateLimited(response, loginBurst)

          const body = await readBody(request as IncomingMessage)

          const identifier = String(body.identifier ?? body.username ?? '').trim()
          const password = String(body.password ?? '')
          if (!(request as IncomingMessage & { abulxtCaptchaVerified?: boolean }).abulxtCaptchaVerified
            && !(await verifyCaptcha(body.captchaToken as string | undefined, ip))) {
            return sendJson(response, 400, { error: 'Captcha verification failed. Try again.' })
          }
          const { rows } = await query<DbUser & { password_salt: string; password_hash: string }>(
            `SELECT ${USER_COLUMNS}, password_salt, password_hash FROM users
             WHERE lower(username) = lower($1) OR (email IS NOT NULL AND lower(email) = lower($1))`,
            [identifier],
          )
          const row = rows[0]
          if (!row || !(await verifyPassword(password, row.password_salt, row.password_hash))) {
            return sendJson(response, 401, { error: 'Wrong username/email or password.' })
          }
          const ban = await activeBan(row.id)
          if (ban) {
            return sendJson(response, 403, { error: `This account is banned${ban.reason ? `: ${ban.reason}` : '.'}` })
          }

          const needsTotp = row.totp_enabled
          if (needsTotp) {
            const pending = randomBytes(24).toString('base64url')
            await query(
              `INSERT INTO webauthn_challenge (challenge, user_id, kind, expires) VALUES ($1, $2, 'login', NOW() + INTERVAL '10 minutes')`,
              [pending, row.id],
            )
            return sendJson(response, 200, { pending, needsTotp, needsEmailOtp: false })
          }

          const token = await createSession(row.id, ip, request.headers['user-agent'] || null)
          return sendJson(response, 200, { token, user: publicUser(row) })
        }

        if (method === 'POST' && pathName === '/api/auth/login/2fa') {
          const body = await readBody(request as IncomingMessage)
          const pending = String(body.pending ?? '')
          const totpCode = String(body.totpCode ?? '').trim()
          const { rows: pendingRows } = await query<{ user_id: number }>(
            `SELECT user_id FROM webauthn_challenge WHERE challenge = $1 AND kind = 'login' AND expires > NOW()`,
            [pending],
          )
          const userId = pendingRows[0]?.user_id
          if (!userId) return sendJson(response, 401, { error: 'Login session expired. Sign in again.' })
          const { rows } = await query<DbUser & { totp_secret: string | null }>(
            `SELECT ${USER_COLUMNS}, totp_secret FROM users WHERE id = $1`,
            [userId],
          )
          const row = rows[0]
          if (!row) return sendJson(response, 401, { error: 'Account not found.' })

          if (row.totp_enabled && row.totp_secret) {
            const totpOk = await checkTotp(totpCode, row.totp_secret)
            const backupOk = totpCode.length > 8 && (await verifyBackup(row.id, totpCode))
            if (!totpOk && !backupOk) return sendJson(response, 401, { error: 'Invalid authenticator code.' })
          }
          await query('DELETE FROM webauthn_challenge WHERE challenge = $1', [pending])
          const token = await createSession(row.id, ip, request.headers['user-agent'] || null)
          return sendJson(response, 200, { token, user: publicUser(row) })
        }

        if (method === 'GET' && pathName === '/api/auth/me') {
          const user = await resolveAuthUser(request as IncomingMessage)
          if (!user) return sendJson(response, 401, { error: 'Sign in to continue.' })
          return sendJson(response, 200, { user: publicUser(user), captcha: captchaEnabled(), mail: mailEnabled() })
        }

        if (method === 'POST' && pathName === '/api/auth/logout') {
          const token = bearerToken(request as IncomingMessage)
          if (token) await query('DELETE FROM session WHERE secret = $1', [token])
          return sendJson(response, 200, { ok: true })
        }

        return sendJson(response, 404, { error: 'Not found' })
      } catch (error) {
        return sendJson(response, 500, { error: error instanceof Error ? error.message : 'Auth request failed' })
      }
    })
  }

  return {
    name: 'abulxt-auth-db-api',
    async configResolved() {
      const config = await loadConfig()
      configureDatabase(config.db?.url)
    },
    configureServer(server) {
      register(server)
    },
    configurePreviewServer(server) {
      register(server)
    },
  }
}

async function verifyBackup(userId: number, code: string): Promise<boolean> {
  const { rows } = await query<{ totp_backup_code: string | null }>('SELECT totp_backup_code FROM users WHERE id = $1', [userId])
  const stored = rows[0]?.totp_backup_code
  if (!stored || stored !== code) return false
  await query('UPDATE users SET totp_backup_code = NULL WHERE id = $1', [userId])
  return true
}
