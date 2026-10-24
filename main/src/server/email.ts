import nodemailer, { type Transporter } from 'nodemailer'
import { randomBytes } from 'node:crypto'
import { getConfig } from './config.js'
import { query } from './db.js'

let transporter: Transporter | null = null

export function mailEnabled(): boolean {
  const mail = getConfig().mail
  return Boolean(mail && (mail.host || '').trim())
}

function getTransporter(): Transporter {
  if (transporter) return transporter
  const mail = getConfig().mail || {}
  const host = mail.host || 'mail2.caan.edu'
  const user = mail.from || 'noreply@caan.edu'
  transporter = nodemailer.createTransport({
    host,

    port: mail.port ?? 465,
    secure: mail.secure ?? true,
    auth: {
      user: mail.auth?.user || user,
      pass: mail.auth?.pass || '',
    },
    tls: { servername: host },
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 8000,
  })
  return transporter
}

export function generateVerificationCode(): string {
  const characters = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 8; i++) code += characters[Math.floor(Math.random() * characters.length)]
  return code
}

export function generateSecret(): string {
  return randomBytes(24).toString('base64url')
}

const RESEND_THROTTLE_MS = 30_000
const ADDR_HOURLY_CAP = 5
const ADDR_DAILY_CAP = 20
const IP_HOURLY_CAP = 20
const IP_DAILY_CAP = 60

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

type RateWindow = { email: string | null; ip: string | null }

async function recentSends({ email, ip }: RateWindow, sinceMs: number): Promise<Date[]> {
  const { rows } = await query<{ send_time: Date }>(
    `SELECT send_time FROM email_log
     WHERE send_time > $1 AND ((email IS NOT NULL AND email = $2) OR (ip IS NOT NULL AND ip = $3))`,
    [new Date(Date.now() - sinceMs), email, ip],
  )
  return rows.map((r) => new Date(r.send_time))
}

export async function canSendEmail(email: string | null, ip: string | null, userId: number | null): Promise<string | undefined> {
  if (!email && !ip) return undefined
  const now = Date.now()

  const recent = await recentSends({ email, ip }, RESEND_THROTTLE_MS)
  if (recent.length) {
    const wait = Math.ceil((RESEND_THROTTLE_MS - (now - Math.max(...recent.map((d) => d.getTime())))) / 1000)
    return `Please wait ${wait} more second${wait === 1 ? '' : 's'} before requesting another email.`
  }

  if (email) {
    const addrDay = await recentSends({ email, ip: null }, DAY_MS)
    if (addrDay.length >= ADDR_DAILY_CAP) return 'Too many emails to this address today. Try again tomorrow.'
    const addrHour = addrDay.filter((d) => now - d.getTime() < HOUR_MS)
    if (addrHour.length >= ADDR_HOURLY_CAP) return 'Too many emails to this address recently. Try again in an hour.'
  }

  if (ip) {
    const ipDay = await recentSends({ email: null, ip }, DAY_MS)
    if (ipDay.length >= IP_DAILY_CAP) return 'Too many emails from your network today. Try again tomorrow.'
    const ipHour = ipDay.filter((d) => now - d.getTime() < HOUR_MS)
    if (ipHour.length >= IP_HOURLY_CAP) return 'Too many emails from your network recently. Try again in an hour.'
  }

  await query('INSERT INTO email_log (email, ip, user_id) VALUES ($1, $2, $3)', [email, ip, userId])
  return undefined
}

export async function canSendNotification(email: string | null, ip: string | null, userId: number | null): Promise<boolean> {
  if (!email) return false
  const now = Date.now()
  const day = await recentSends({ email, ip: null }, DAY_MS)
  if (day.length >= ADDR_DAILY_CAP * 3) return false
  const hour = day.filter((d) => now - d.getTime() < HOUR_MS)
  if (hour.length >= ADDR_HOURLY_CAP * 3) return false
  await query('INSERT INTO email_log (email, ip, user_id) VALUES ($1, $2, $3)', [email, ip, userId])
  return true
}

const emailCSS = `div{background:#fff;padding:20px;font-family:"Helvetica Neue","Helvetica","Arial","sans-serif;color:#111}`
const codeCSS = `code{display:inline-block;background:#f0f0f0;border:1px solid #ddd;border-radius:6px;padding:8px 14px;font-size:20px;letter-spacing:3px;font-weight:700}`

// HTML-escape every dynamic value interpolated into an email template so that
// an address, hostname, IP or alert reason can never break out of its HTML
// context. Covers both element content and double-quoted attribute values.
function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

function wrap(body: string): string {
  return `<div style="${emailCSS}">${body}</div>`
}

async function sendMail(to: string, subject: string, html: string): Promise<void> {
  const mail = getConfig().mail || {}
  await getTransporter().sendMail({
    from: mail.from || 'noreply@caan.edu',
    to,
    subject,
    html: wrap(html),
  })
}

function linkFor(path: string): string {
  const origin = (getConfig().mail?.publicOrigin || '').replace(/\/$/, '')
  return `${origin}${path}`
}

export async function sendEmailVerification(to: string, code: string): Promise<void> {
  await sendMail(to, 'Verify your Abstract email', `<p>Enter this code to verify your email address:</p><p><span style="${codeCSS}">${esc(code)}</span></p><p>If you didn't request this, you can ignore it.</p>`)
}

export async function sendChangeEmailVerification(to: string, secret: string): Promise<void> {
  const url = linkFor(`/#account?verify-email=${encodeURIComponent(secret)}`)
  // The token URL is used only as the href; the visible link text is a fixed
  // label so the raw secret-bearing URL is never rendered as copyable text.
  await sendMail(to, 'Confirm your new email', `<p>Click to confirm this as your new Abstract email:</p><p><a href="${esc(url)}">Confirm your new email</a></p><p>If you didn't request this, you can ignore it.</p>`)
}

export async function sendPasswordReset(to: string, code: string, minutes: number): Promise<void> {
  await sendMail(to, 'Your Abstract password reset code', `<p>Enter this code to reset your Abstract password:</p><p><span style="${codeCSS}">${esc(code)}</span></p><p>The code expires in ${minutes} minutes. If you didn't request a reset, you can ignore this email.</p>`)
}

export async function sendLoginOtp(to: string, code: string): Promise<void> {
  await sendMail(to, 'Your Abstract sign-in code', `<p>Your one-time sign-in code:</p><p><span style="${codeCSS}">${esc(code)}</span></p><p>If you didn't try to sign in, secure your account.</p>`)
}

export async function sendSecurityNotification(to: string, what: string, ip: string | null): Promise<void> {
  // Subject is a plain-text header (not HTML), so `what` is not escaped there;
  // both `what` and `ip` are escaped where they enter the HTML body.
  await sendMail(to, `Security alert: ${what}`, `<p>${esc(what)} on your Abstract account${ip ? ` from IP <b>${esc(ip)}</b>` : ''}.</p><p>If this wasn't you, reset your password immediately.</p>`)
}
