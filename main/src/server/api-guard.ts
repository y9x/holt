import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Plugin, ViteDevServer } from 'vite'
import { captchaEnabled, captchaProvider, issueCaptchaChallenge, verifyCaptcha } from './captcha.ts'
import { clientIp } from './identity.ts'
import { parseRequestUrl } from './request-url.ts'
import { rateLimit, sendRateLimited } from './rate-limit.ts'

const CAPTCHA_EXEMPT_PREFIXES = [
  '/api/captcha/',
  '/api/stripe/webhook',
]

const CAPTCHA_EXEMPT_EXACT = new Set([
  '/api/ads/config', // fetched early for free users; rate-limited instead
])

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const ACCESS_COOKIE = 'abulxt_access'
const accessSigningKey = randomBytes(32)

function cookieValue(request: IncomingMessage, name: string): string {
  const raw = request.headers.cookie || ''
  for (const part of raw.split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return value.join('=')
  }
  return ''
}

function accessSignature(expires: string): string {
  return createHmac('sha256', accessSigningKey).update(expires).digest('base64url')
}

function hasSiteAccess(request: IncomingMessage): boolean {
  const [expires, signature] = cookieValue(request, ACCESS_COOKIE).split('.')
  if (!expires || !signature || Number(expires) <= Date.now()) return false
  const expected = Buffer.from(accessSignature(expires))
  const supplied = Buffer.from(signature)
  return expected.length === supplied.length && timingSafeEqual(expected, supplied)
}

function isSecureRequest(request: IncomingMessage): boolean {
  if ((request.socket as { encrypted?: boolean }).encrypted) return true
  const forwarded = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  return forwarded === 'https'
}

function siteAccessCookie(request: IncomingMessage): string {
  const expires = String(Date.now() + 12 * 60 * 60 * 1000)
  const secure = isSecureRequest(request) ? '; Secure' : ''
  return `${ACCESS_COOKIE}=${expires}.${accessSignature(expires)}; Max-Age=43200; Path=/; HttpOnly${secure}; SameSite=Lax`
}

function shouldGate(request: IncomingMessage, path: string): boolean {
  if ((request.method || 'GET').toUpperCase() !== 'GET') return false
  // Never gate the relay upgrade. It is a WebSocket, so match on the Upgrade
  // header rather than the (config-driven) path.
  if (String(request.headers.upgrade || '').toLowerCase() === 'websocket') return false
  if (path.startsWith('/api/')) return false
  const acceptsHtml = String(request.headers.accept || '').includes('text/html')
  return acceptsHtml || /^\/assets\/.*\.(?:js|mjs|wasm|map)$/i.test(path)
}

function gateHtml(sitekey: string, challengeId: string, returnTo: string): string {
  const params = JSON.stringify({ sitekey, challengeId, returnTo }).replace(/</g, '\\u003c')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Checking your browser</title><script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script><style>html,body{height:100%;margin:0;background:#050505;color:#f5f5f5;font:14px ui-monospace,SFMono-Regular,Menlo,monospace}body{display:grid;place-items:center;background-image:radial-gradient(rgba(255,255,255,.16) 1px,transparent 1px);background-size:16px 16px}.card{width:min(420px,calc(100% - 40px));padding:30px;border:1px solid rgba(255,255,255,.16);border-radius:22px;background:rgba(12,12,13,.94);box-shadow:0 24px 80px #000;text-align:center}.mark{font-size:24px}.muted{color:#929292;font-size:12px;line-height:1.6}.widget{min-height:70px;display:grid;place-items:center;margin:22px 0 10px}.error{min-height:18px;color:#ff9f9f;font-size:12px}</style></head><body><main class="card"><div class="mark">✦</div><h1>Verify you are human</h1><p class="muted">Complete the check to enter Abstract.</p><div id="widget" class="widget"></div><p id="error" class="error"></p></main><script>const cfg=${params};const error=document.getElementById('error');function ready(){if(!window.turnstile)return setTimeout(ready,50);turnstile.render('#widget',{sitekey:cfg.sitekey,theme:'dark',size:'flexible',appearance:'always',callback:async token=>{error.textContent='Verifying…';const res=await fetch('/api/captcha/access',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,challengeId:cfg.challengeId})});if(res.ok)location.replace(cfg.returnTo);else{error.textContent='Verification failed. Please try again.';turnstile.reset('#widget')}} ,'error-callback':()=>{error.textContent='Could not load the check. Please retry.'}})}ready()</script></body></html>`
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown> } catch { return {} }
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}

function pathOf(request: IncomingMessage): string {

  const url = parseRequestUrl(request.url)
  const rel = url.pathname || '/'
  if (rel.startsWith('/api/')) return rel.replace(/\/$/, '') || '/api'
  const full = `/api${rel.startsWith('/') ? rel : `/${rel}`}`.replace(/\/$/, '')
  return full || '/api'
}

function isCaptchaExempt(path: string, method: string): boolean {
  if (!WRITE_METHODS.has(method)) return true
  if (CAPTCHA_EXEMPT_EXACT.has(path)) return true
  return CAPTCHA_EXEMPT_PREFIXES.some((p) => path === p.replace(/\/$/, '') || path.startsWith(p))
}

function readHeaderToken(request: IncomingMessage): { token?: string; challengeId?: string } {
  const tokenHeader = request.headers['x-hcaptcha-token']
    || request.headers['x-turnstile-token']
    || request.headers['x-captcha-token']
  const challengeHeader = request.headers['x-captcha-challenge']
  const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader
  const challengeId = Array.isArray(challengeHeader) ? challengeHeader[0] : challengeHeader
  return {
    token: token?.trim() || undefined,
    challengeId: challengeId?.trim() || undefined,
  }
}

function applyRateLimits(path: string, method: string, ip: string): { ok: true } | { ok: false; retryAfterSec: number; error: string } {
  const all = rateLimit(`api:all:${ip}`, {
    limit: 240,
    windowMs: 60_000,
    error: 'Too many API requests. Slow down.',
  })
  if (!all.ok) return all

  if (WRITE_METHODS.has(method)) {
    const writes = rateLimit(`api:write:${ip}`, {
      limit: 90,
      windowMs: 60_000,
      error: 'Too many write requests. Slow down.',
    })
    if (!writes.ok) return writes
  }

  if (path.startsWith('/api/auth/')) {
    const auth = rateLimit(`api:auth:${ip}`, {
      limit: 40,
      windowMs: 60_000,
      error: 'Too many auth requests. Slow down.',
    })
    if (!auth.ok) return auth
  }

  if (path.startsWith('/api/ai/') || path === '/api/rt') {
    const ai = rateLimit(`api:ai:${ip}`, {
      limit: 120,
      windowMs: 60_000,
      error: 'Too many AI/realtime requests. Slow down.',
    })
    if (!ai.ok) return ai
  }

  if (path.startsWith('/api/library')) {
    const lib = rateLimit(`api:library:${ip}`, {
      limit: 120,
      windowMs: 60_000,
      error: 'Too many library requests. Slow down.',
    })
    if (!lib.ok) return lib
  }

  if (path.startsWith('/api/admin')) {
    const admin = rateLimit(`api:admin:${ip}`, {
      limit: 60,
      windowMs: 60_000,
      error: 'Too many admin requests. Slow down.',
    })
    if (!admin.ok) return admin
  }

  return { ok: true }
}

function attach(server: { middlewares: ViteDevServer['middlewares'] }) {

  server.middlewares.use('/api/captcha/access', async (request, response) => {
    if ((request.method || 'GET') !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' })
    if (!captchaEnabled()) return sendJson(response, 503, { error: 'Captcha is not configured.' })
    const body = await readJson(request as IncomingMessage)
    const ok = await verifyCaptcha(String(body.token || ''), clientIp(request as IncomingMessage), {
      challengeId: String(body.challengeId || ''),
      consumeChallenge: true,
    })
    if (!ok) return sendJson(response, 403, { error: 'Captcha verification failed.' })
    response.setHeader('Set-Cookie', siteAccessCookie(request as IncomingMessage))
    return sendJson(response, 200, { ok: true })
  })

  server.middlewares.use('/api/captcha/config', (request, response) => {
    if ((request.method || 'GET') !== 'GET') {
      return sendJson(response, 405, { error: 'Method not allowed' })
    }
    const ip = clientIp(request as IncomingMessage)
    if (!captchaEnabled()) {
      return sendJson(response, 200, { enabled: false, sitekey: '', challengeId: '', provider: captchaProvider(), theme: 'dark' })
    }
    const issued = issueCaptchaChallenge(ip)
    return sendJson(response, 200, {
      enabled: true,
      sitekey: issued.sitekey,
      challengeId: issued.challengeId,
      expiresInSec: issued.expiresInSec,
      provider: issued.provider,
      theme: 'dark',
      size: 'flexible',
    })
  })

  server.middlewares.use((request, response, next) => {
    if (!captchaEnabled()) return next()
    const path = parseRequestUrl(request.url).pathname || '/'
    if (!shouldGate(request as IncomingMessage, path) || hasSiteAccess(request as IncomingMessage)) return next()
    const issued = issueCaptchaChallenge(clientIp(request as IncomingMessage))
    response.statusCode = 403
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store, private')
    response.setHeader('X-Robots-Tag', 'noindex, nofollow')
    return response.end(gateHtml(issued.sitekey, issued.challengeId, request.url || '/'))
  })

  server.middlewares.use('/api', async (request, response, next) => {
    const method = (request.method || 'GET').toUpperCase()
    if (method === 'OPTIONS') return next()

    const path = pathOf(request as IncomingMessage)
    const ip = clientIp(request as IncomingMessage)

    const limited = applyRateLimits(path, method, ip)
    if (!limited.ok) {
      // Per-IP limiter across every route = Discord's global rate limit.
      return sendRateLimited(response, limited.retryAfterSec, limited.error, true)
    }

    if (!captchaEnabled() || isCaptchaExempt(path, method)) {
      return next()
    }

    const headerTok = readHeaderToken(request as IncomingMessage)
    let token = headerTok.token
    let challengeId = headerTok.challengeId

    const url = parseRequestUrl(request.url)
    if (!token) token = url.searchParams.get('captchaToken') || undefined
    if (!challengeId) challengeId = url.searchParams.get('captchaChallenge') || undefined

    const ok = await verifyCaptcha(token, ip, { challengeId, consumeChallenge: true })
    if (!ok) {
      return sendJson(response, 403, {
        error: 'Captcha verification failed. Reload and try again.',
        captchaRequired: true,
      })
    }
    ;(request as IncomingMessage & { abulxtCaptchaVerified?: boolean }).abulxtCaptchaVerified = true
    return next()
  })
}

export function apiGuard(): Plugin {
  return {
    name: 'abulxt-api-guard',
    enforce: 'pre',
    configureServer(server) {
      attach(server)
    },
    configurePreviewServer(server) {
      attach(server)
    },
  }
}
