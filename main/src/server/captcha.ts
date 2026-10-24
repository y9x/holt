import { randomBytes } from 'node:crypto'
import { captchaProviderOf, getConfig } from './config.js'

type Provider = 'turnstile' | 'hcaptcha'

const VERIFY_URL: Record<Provider, string> = {
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  hcaptcha: 'https://api.hcaptcha.com/siteverify',
}

type Challenge = {
  sitekey: string
  ip: string | null
  expires: number
}

const challenges = new Map<string, Challenge>()
let rotateCursor = 0
let lastSweep = 0

function sweep(now: number) {
  if (now - lastSweep < 15_000 && challenges.size < 5_000) return
  lastSweep = now
  for (const [id, row] of challenges) {
    if (row.expires <= now) challenges.delete(id)
  }
  if (challenges.size > 20_000) {
    const drop = [...challenges.keys()].slice(0, challenges.size - 10_000)
    for (const id of drop) challenges.delete(id)
  }
}

export function captchaEnabled(): boolean {
  const captcha = getConfig().captcha
  return Boolean(captcha?.enabled && secretPool().length && sitekeyPool().length)
}

export function captchaProvider(): Provider {
  return captchaProviderOf(getConfig())
}

export function sitekeyPool(): string[] {
  const captcha = getConfig().captcha || {}
  const pool = [
    ...(Array.isArray((captcha as { sitekeys?: string[] }).sitekeys) ? (captcha as { sitekeys?: string[] }).sitekeys! : []),
    ...(captcha.sitekey ? [captcha.sitekey] : []),
  ]
    .map((k) => String(k || '').trim())
    .filter(Boolean)
  return [...new Set(pool)]
}

export function secretPool(): string[] {
  const captcha = getConfig().captcha || {}
  const pool = [
    ...(Array.isArray((captcha as { secrets?: string[] }).secrets) ? (captcha as { secrets?: string[] }).secrets! : []),
    ...(captcha.secret ? [captcha.secret] : []),
  ]
    .map((k) => String(k || '').trim())
    .filter(Boolean)
  return [...new Set(pool)]
}

let secretCursor = 0

function nextSecret(): string {
  const pool = secretPool()
  if (!pool.length) return ''
  const value = pool[secretCursor % pool.length]
  secretCursor = (secretCursor + 1) % pool.length
  return value
}

export function nextSitekey(): string {
  const pool = sitekeyPool()
  if (!pool.length) return ''
  const key = pool[rotateCursor % pool.length]
  rotateCursor = (rotateCursor + 1) % pool.length
  return key
}

export function issueCaptchaChallenge(ip?: string | null): { sitekey: string; challengeId: string; expiresInSec: number; provider: Provider } {
  const sitekey = nextSitekey()
  const challengeId = randomBytes(18).toString('base64url')
  const expiresInSec = 10 * 60
  const now = Date.now()
  sweep(now)
  challenges.set(challengeId, {
    sitekey,
    ip: ip || null,
    expires: now + expiresInSec * 1000,
  })
  return { sitekey, challengeId, expiresInSec, provider: captchaProvider() }
}

export function peekCaptchaChallenge(challengeId: string | undefined | null): Challenge | null {
  if (!challengeId) return null
  const row = challenges.get(challengeId)
  if (!row) return null
  if (row.expires <= Date.now()) {
    challenges.delete(challengeId)
    return null
  }
  return row
}

export function consumeCaptchaChallenge(challengeId: string | undefined | null): Challenge | null {
  const row = peekCaptchaChallenge(challengeId)
  if (!row || !challengeId) return null
  challenges.delete(challengeId)
  return row
}

export async function verifyCaptcha(
  token: string | undefined | null,
  remoteIp?: string | null,
  opts?: { challengeId?: string | null; consumeChallenge?: boolean },
): Promise<boolean> {
  if (!captchaEnabled()) return true
  if (!token) return false

  const provider = captchaProvider()
  let sitekey = sitekeyPool()[0] || ''
  if (opts?.challengeId) {
    const row = opts.consumeChallenge === false
      ? peekCaptchaChallenge(opts.challengeId)
      : consumeCaptchaChallenge(opts.challengeId)
    if (!row) return false
    sitekey = row.sitekey
  }

  const secret = nextSecret()
  if (!secret) return false

  try {
    const body = new URLSearchParams({
      secret,
      response: token,
      ...(remoteIp ? { remoteip: remoteIp } : {}),

      ...(provider === 'hcaptcha' && sitekey ? { sitekey } : {}),
    })
    const res = await fetch(VERIFY_URL[provider], {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(5000),
    })
    const data = (await res.json()) as { success?: boolean }
    return Boolean(data.success)
  } catch {
    return false
  }
}
