import { apiUrl } from './api-base'
import { failoverFetch } from './api-failover'
import { clientConfig } from './config'
import './captcha.css'

type Provider = 'turnstile' | 'hcaptcha'

declare global {
  interface Window {
    hcaptcha?: {
      render: (el: HTMLElement, opts: {
        sitekey: string
        size: string
        theme?: string
        callback: (token: string) => void
        'error-callback'?: () => void
        'expired-callback'?: () => void
      }) => number
      execute: (id: number) => void
      remove: (id: number) => void
    }
    turnstile?: {
      render: (el: HTMLElement | string, opts: {
        sitekey: string
        size?: 'normal' | 'compact' | 'flexible' | 'invisible'
        appearance?: 'always' | 'execute' | 'interaction-only' | 'never'
        theme?: 'light' | 'dark' | 'auto'
        callback: (token: string) => void
        'error-callback'?: () => void
        'expired-callback'?: () => void
        'timeout-callback'?: () => void
      }) => string
      execute: (id: string | HTMLElement) => void
      reset: (id: string | HTMLElement) => void
      remove: (id: string) => void
    }
  }
}

type CaptchaConfig = {
  enabled: boolean
  provider: Provider
  sitekey: string
  challengeId: string
  theme?: string
  size?: string
  expiresInSec?: number
}

const SCRIPT_SRC: Record<Provider, string> = {
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
  hcaptcha: 'https://js.hcaptcha.com/1/api.js?render=explicit',
}

let scriptPromise: Promise<void> | null = null
let scriptProvider: Provider | null = null
let cachedConfig: CaptchaConfig | null = null
let cachedAt = 0

function embeddedProvider(): Provider {
  return clientConfig().captchaProvider === 'turnstile' ? 'turnstile' : 'hcaptcha'
}

export function captchaEnabled(): boolean {
  // Prefer embedded build config. Never treat a failed/404 config fetch as "enabled".
  const embeddedKey = clientConfig().captchaSitekey
  if (embeddedKey === '') {
    // Explicitly disabled by publicClientConfig when captcha.enabled=false.
    if (!cachedConfig) return false
  }
  return Boolean(embeddedKey) || Boolean(cachedConfig?.enabled && cachedConfig.sitekey)
}

export async function fetchCaptchaConfig(force = false): Promise<CaptchaConfig> {
  const now = Date.now()
  if (!force && cachedConfig && now - cachedAt < 2000) return cachedConfig

  // If the build embedded an empty sitekey, captcha is off - do not hit /api/captcha/config
  // (especially important for static CDN builds like jsDelivr).
  const embeddedKey = clientConfig().captchaSitekey
  if (!embeddedKey) {
    cachedConfig = {
      enabled: false,
      provider: embeddedProvider(),
      sitekey: '',
      challengeId: '',
      theme: 'dark',
      size: 'flexible',
    }
    cachedAt = now
    return cachedConfig
  }

  const embedded = embeddedProvider()
  try {
    const res = await failoverFetch(apiUrl('/api/captcha/config'), { method: 'GET', cache: 'no-store' })
    if (!res.ok) {
      cachedConfig = {
        enabled: false,
        provider: embedded,
        sitekey: '',
        challengeId: '',
        theme: 'dark',
        size: 'flexible',
      }
      cachedAt = now
      return cachedConfig
    }
    const data = await res.json() as CaptchaConfig
    cachedConfig = {
      enabled: Boolean(data.enabled && data.sitekey),
      provider: data.provider === 'turnstile' ? 'turnstile' : 'hcaptcha',
      sitekey: String(data.sitekey || ''),
      challengeId: String(data.challengeId || ''),
      theme: data.theme || 'dark',
      size: data.size || 'flexible',
      expiresInSec: data.expiresInSec,
    }
    cachedAt = now
    try {
      const cfg = clientConfig() as { captchaSitekey?: string; captchaProvider?: string }
      cfg.captchaSitekey = cachedConfig.sitekey
      cfg.captchaProvider = cachedConfig.provider
    } catch { /* ignore */ }
    return cachedConfig
  } catch {
    cachedConfig = {
      enabled: Boolean(embeddedKey),
      provider: embedded,
      sitekey: String(embeddedKey || ''),
      challengeId: '',
      theme: 'dark',
      size: 'flexible',
    }
    cachedAt = now
    return cachedConfig
  }
}


function scriptLoaded(provider: Provider): boolean {
  return provider === 'turnstile' ? Boolean(window.turnstile) : Boolean(window.hcaptcha)
}

function loadScript(provider: Provider): Promise<void> {
  if (scriptPromise && scriptProvider === provider) return scriptPromise
  if (scriptLoaded(provider)) return Promise.resolve()
  scriptProvider = provider
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SCRIPT_SRC[provider]
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load captcha'))
    document.head.append(script)
  })
  return scriptPromise
}

export function warmCaptcha() {
  if (!captchaEnabled()) return
  void fetchCaptchaConfig().then((cfg) => {
    if (cfg.enabled && cfg.sitekey) void loadScript(cfg.provider)
  }).catch(() => {})
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => warmCaptcha(), { once: true })
  } else {
    warmCaptcha()
  }
}

async function solveTurnstile(sitekey: string): Promise<string | undefined> {
  const turnstile = window.turnstile
  if (!turnstile) return undefined
  return new Promise<string | undefined>((resolve) => {
    const container = document.createElement('div')
    container.className = 'abulxt-captcha-overlay'
    container.innerHTML = '<div class="abulxt-captcha-card"><strong>Verify you are human</strong><span>Complete the check to continue.</span><div class="abulxt-captcha-widget"></div></div>'
    document.body.append(container)
    let widgetId = ''
    const done = (value?: string) => {
      try { if (widgetId) turnstile.remove(widgetId) } catch {  }
      container.remove()
      resolve(value)
    }
    const widget = container.querySelector<HTMLElement>('.abulxt-captcha-widget') || container
    widgetId = turnstile.render(widget, {
      sitekey,
      size: 'flexible',
      appearance: 'always',
      theme: 'dark',
      callback: (value) => done(value),
      'error-callback': () => done(undefined),
      'expired-callback': () => done(undefined),
      'timeout-callback': () => done(undefined),
    })
  })
}

async function solveHcaptcha(sitekey: string): Promise<string | undefined> {
  const hcaptcha = window.hcaptcha
  if (!hcaptcha) return undefined
  return new Promise<string | undefined>((resolve) => {
    const container = document.createElement('div')
    container.style.display = 'none'
    document.body.append(container)
    let widgetId = -1
    const done = (value?: string) => {
      try { if (widgetId >= 0) hcaptcha.remove(widgetId) } catch {  }
      container.remove()
      resolve(value)
    }
    widgetId = hcaptcha.render(container, {
      sitekey,
      size: 'invisible',
      theme: 'dark',
      callback: (value) => done(value),
      'error-callback': () => done(undefined),
      'expired-callback': () => done(undefined),
    })
    hcaptcha.execute(widgetId)
  })
}

export async function solveCaptcha(forceNewChallenge = true): Promise<{ token?: string; challengeId?: string; provider?: Provider }> {
  const cfg = await fetchCaptchaConfig(forceNewChallenge)
  if (!cfg.enabled || !cfg.sitekey) return { provider: cfg.provider }
  try {
    await loadScript(cfg.provider)
    const token = cfg.provider === 'turnstile'
      ? await solveTurnstile(cfg.sitekey)
      : await solveHcaptcha(cfg.sitekey)
    cachedConfig = null
    cachedAt = 0
    return { token, challengeId: cfg.challengeId, provider: cfg.provider }
  } catch {
    return { challengeId: cfg.challengeId, provider: cfg.provider }
  }
}

export async function getCaptchaToken(): Promise<string | undefined> {
  const solved = await solveCaptcha(true)
  return solved.token
}

export async function getCaptchaHeaders(): Promise<Record<string, string>> {
  const { token, challengeId, provider } = await solveCaptcha(true)
  const headers: Record<string, string> = {}
  if (token) headers[provider === 'turnstile' ? 'x-turnstile-token' : 'x-hcaptcha-token'] = token
  if (challengeId) headers['x-captcha-challenge'] = challengeId
  return headers
}
