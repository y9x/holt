import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { query } from './db.js'
import { deviceFromUA, geoForIp } from './geo.js'

const scrypt = promisify(scryptCb)

export const usernamePattern = /^[A-Za-z0-9._-]{2,20}$/
export const emailPattern = /\S+@\S+\.\S+/

export function validateUsername(username: string): string | undefined {
  if (!usernamePattern.test(username)) return 'Username must be 2–20 letters, numbers, . _ or -.'
  return undefined
}

export function validatePassword(password: string): string | undefined {
  if (password.length < 8) return 'Password must be at least 8 characters.'
  if (password.length > 120) return 'Password must be at most 120 characters.'
  return undefined
}

export function validateEmail(email: string): string | undefined {
  if (!emailPattern.test(email)) return 'Enter a valid email address.'
  return undefined
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16)
  const hash = (await scrypt(password, salt, 32)) as Buffer
  return { salt: salt.toString('base64url'), hash: hash.toString('base64url') }
}

export async function verifyPassword(password: string, saltB64: string, hashB64: string): Promise<boolean> {
  const salt = Buffer.from(saltB64, 'base64url')
  const expected = Buffer.from(hashB64, 'base64url')
  const actual = (await scrypt(password, salt, expected.length)) as Buffer
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export type SessionRow = {
  secret: string
  created: Date
  ip: string | null
  user_id: number
  expires: Date | null
  last_seen: Date
  totp_verified: boolean
  user_agent?: string | null
  device?: string | null
  geo_city?: string | null
  geo_region?: string | null
  geo_country?: string | null
}

export async function createSession(userId: number, ip: string | null, userAgent?: string | null): Promise<string> {
  const token = randomBytes(24).toString('base64url')
  const expires = new Date(Date.now() + SESSION_TTL_MS)
  const device = deviceFromUA(userAgent)

  const geo = await geoForIp(ip)
  await query(
    `INSERT INTO session (secret, user_id, ip, expires, user_agent, device, geo_city, geo_region, geo_country)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [token, userId, ip, expires, userAgent || null, device, geo.city, geo.region, geo.country],
  )
  return token
}

export async function sessionForToken(token: string): Promise<SessionRow | null> {
  const { rows } = await query<SessionRow>(
    `SELECT secret, created, ip, user_id, expires, last_seen, totp_verified FROM session WHERE secret = $1`,
    [token],
  )
  const session = rows[0]
  if (!session) return null
  if (session.expires && Date.now() >= new Date(session.expires).getTime()) {
    await query('DELETE FROM session WHERE secret = $1', [token])
    return null
  }

  const lastSeen = new Date(session.last_seen).getTime()
  if (Date.now() - lastSeen > 60_000) {
    const expires = new Date(Date.now() + SESSION_TTL_MS)
    await query('UPDATE session SET last_seen = NOW(), expires = $2 WHERE secret = $1', [token, expires])
  }
  return session
}

export async function revokeOtherSessions(userId: number, keepSecret: string | null): Promise<void> {
  if (keepSecret) await query('DELETE FROM session WHERE user_id = $1 AND secret <> $2', [userId, keepSecret])
  else await query('DELETE FROM session WHERE user_id = $1', [userId])
}

export type BanRow = { id: number; expires: Date | null; reason: string | null }

export async function activeBan(userId: number): Promise<BanRow | null> {
  const { rows } = await query<BanRow>(
    `SELECT id, expires, reason FROM ban
     WHERE user_id = $1 AND (expires IS NULL OR expires > NOW())
     ORDER BY created DESC LIMIT 1`,
    [userId],
  )
  return rows[0] || null
}

let cleanupStarted = false
export function startSessionCleanup(): void {
  if (cleanupStarted) return
  cleanupStarted = true
  const run = () => {
    query('DELETE FROM session WHERE expires IS NOT NULL AND expires < NOW()').catch(() => {})
    query('DELETE FROM webauthn_challenge WHERE expires < NOW()').catch(() => {})
  }
  run()
  setInterval(run, 10 * 60 * 1000).unref?.()
}
