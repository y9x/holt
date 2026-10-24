

import { parse as parseHtml, type HTMLElement } from 'node-html-parser'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { createSession, type Session } from 'wreq-js'

export interface SearchToolsConfig {

  egressProxy?: string
  safeSearch?: 'strict' | 'moderate' | 'off'
  region?: string
  searchRpm?: number
  fetchRpm?: number

  maxSteps?: number
  allowPrivateUrls?: boolean
}

const SEARCH_URL = 'https://html.duckduckgo.com/html/'
const LITE_URL = 'https://lite.duckduckgo.com/lite/'

const BROWSER_PROFILE = 'chrome_149'
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
const SEARCH_HEADERS: Record<string, string> = {
  'User-Agent': BROWSER_UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://html.duckduckgo.com',
  'Referer': 'https://html.duckduckgo.com/',
}
const MAX_REDIRECTS = 5
const REF_THRESHOLD = 120

class BlockedError extends Error {
  constructor(status: number) {
    super(`DuckDuckGo block signal (HTTP ${status})`)
    this.name = 'BlockedError'
  }
}

class SlidingLimiter {
  private stamps: number[] = []
  private rpm: number
  constructor(rpm: number) { this.rpm = rpm }
  async acquire(): Promise<void> {
    if (this.rpm <= 0) return
    for (;;) {
      const now = Date.now()
      const cutoff = now - 60_000
      this.stamps = this.stamps.filter((t) => t > cutoff)
      if (this.stamps.length < this.rpm) {
        this.stamps.push(now)
        return
      }
      const wait = this.stamps[0] + 60_000 - now + 5
      await new Promise((r) => setTimeout(r, Math.min(wait, 5_000)))
    }
  }
}

class LinkRegistry {
  private map = new Map<string, string>()
  private counter = 0
  private max: number
  constructor(max = 256) { this.max = max }
  shorten(url: string): string {
    for (const [token, existing] of this.map) {
      if (existing === url) return token
    }
    const token = `ref://${++this.counter}`
    this.map.set(token, url)
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest) this.map.delete(oldest)
    }
    return token
  }
  resolve(token: string): string | null {
    return this.map.get(token) ?? null
  }
}

class TtlCache<T> {
  private map = new Map<string, { value: T; expires: number }>()
  private ttlMs: number
  private max: number
  constructor(ttlMs: number, max: number) { this.ttlMs = ttlMs; this.max = max }
  get(key: string): T | undefined {
    const hit = this.map.get(key)
    if (!hit) return undefined
    if (Date.now() > hit.expires) {
      this.map.delete(key)
      return undefined
    }
    return hit.value
  }
  set(key: string, value: T): void {
    if (this.ttlMs <= 0 || this.max <= 0) return
    this.map.set(key, { value, expires: Date.now() + this.ttlMs })
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest) this.map.delete(oldest)
    }
  }
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export class WebSearchTools {
  private proxy: string
  private session: Promise<Session> | null = null
  private searchLimiter: SlidingLimiter
  private fetchLimiter: SlidingLimiter
  private links = new LinkRegistry()
  private cache = new TtlCache<string>(300_000, 64)
  readonly maxSteps: number
  private safeSearch: string
  private region: string
  private allowPrivate: boolean

  constructor(config: SearchToolsConfig | undefined) {
    this.proxy = (config?.egressProxy || '').trim()
    this.safeSearch = config?.safeSearch === 'off' ? '-2' : config?.safeSearch === 'moderate' ? '-1' : '1'
    this.region = config?.region || ''
    this.searchLimiter = new SlidingLimiter(config?.searchRpm ?? 30)
    this.fetchLimiter = new SlidingLimiter(config?.fetchRpm ?? 20)
    this.maxSteps = Math.max(1, Math.min(14, config?.maxSteps ?? 10))
    this.allowPrivate = config?.allowPrivateUrls === true
  }

  private getSession(): Promise<Session> {
    if (!this.session) {
      this.session = createSession({
        browser: BROWSER_PROFILE,
        os: 'windows',
        ...(this.proxy ? { proxy: this.proxy } : {}),
      })
    }
    return this.session
  }

  egressLabel(): string {
    if (!this.proxy) return 'direct'
    try {
      const url = new URL(this.proxy)
      return `${url.protocol}//${url.host}`
    } catch {
      return 'socks5'
    }
  }

  private async guardedFetch(url: string, init: { method?: string; body?: string } = {}, redirects = 0): Promise<{ status: number; header: (name: string) => string | null; text: () => Promise<string> }> {
    if (!this.allowPrivate) await assertPublicUrl(url)
    const session = await this.getSession()
    const res = await session.fetch(url, {
      method: init.method ?? 'GET',
      headers: SEARCH_HEADERS,
      ...(init.body ? { body: init.body } : {}),
      redirect: 'manual',
    })
    const out = { status: res.status, header: (name: string) => res.headers.get(name), text: () => res.text() }
    if (res.status === 429 && redirects < 1) {
      const retryAfter = Number(res.headers.get('retry-after') || '2')
      await new Promise((r) => setTimeout(r, Math.min(retryAfter, 10) * 1000))
      return this.guardedFetch(url, init, redirects + 1)
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (redirects >= MAX_REDIRECTS) throw new Error(`too many redirects (>${MAX_REDIRECTS})`)
      const location = res.headers.get('location')
      if (location) return this.guardedFetch(new URL(location, url).toString(), init, redirects + 1)
    }
    return out
  }

  async search(query: string, maxResults = 10, region = ''): Promise<string> {
    await this.searchLimiter.acquire()
    const kl = region || this.region

    const qs = new URLSearchParams({ q: query, kl, kp: this.safeSearch }).toString()
    const searchUrl = `${SEARCH_URL}?${qs}`
    const liteUrl = `${LITE_URL}?${qs}`

    let html = ''
    try {
      const res = await this.guardedFetch(searchUrl)
      if (res.status === 202 || res.status === 403) throw new BlockedError(res.status)
      if (res.status < 200 || res.status >= 300) throw new Error(`DuckDuckGo returned HTTP ${res.status}`)
      html = await res.text()
    } catch (primary) {

      try {
        const res = await this.guardedFetch(liteUrl)
        if (res.status === 202 || res.status === 403) throw new BlockedError(res.status)
        if (res.status < 200 || res.status >= 300) throw new Error(`DuckDuckGo lite returned HTTP ${res.status}`)
        html = await res.text()
      } catch (lite) {

        if (lite instanceof BlockedError || primary instanceof BlockedError) {
          return 'Web search is temporarily unavailable (the search provider is rate-limiting this server). Do not retry the same search - answer the question from your own knowledge and note that you could not verify it against current sources.'
        }
        throw primary
      }
    }

    const results = parseSearchResults(html).slice(0, Math.max(1, Math.min(20, maxResults)))
    if (!results.length) return `No results found for "${query}". Answer from your own knowledge if you can.`
    const lines: string[] = []
    results.forEach((r, i) => {
      const display = r.url.length > REF_THRESHOLD
        ? `${this.links.shorten(r.url)} (long URL shortened; pass to web_fetch as-is, or call expand_link to get the full URL)`
        : r.url
      lines.push(`${i + 1}. ${r.title}`)
      lines.push(`   URL: ${display}`)
      lines.push(`   Summary: ${r.snippet}`)
      lines.push('')
    })
    return lines.join('\n').trim()
  }

  async fetchContent(url: string, maxLength = 6000): Promise<string> {
    let target = url.trim()
    if (target.startsWith('ref://')) {
      const resolved = this.links.resolve(target)
      if (!resolved) return `Unknown link token ${target}. Run web_search again for fresh links.`
      target = resolved
    }
    if (!/^https?:\/\//i.test(target)) return `Invalid URL: ${target}`
    const cacheKey = `${target}:${maxLength}`
    const cached = this.cache.get(cacheKey)
    if (cached) return cached
    await this.fetchLimiter.acquire()
    const res = await this.guardedFetch(target)
    if (res.status < 200 || res.status >= 300) throw new Error(`Failed to fetch ${target} (HTTP ${res.status})`)
    const html = await res.text()
    const text = extractText(html).slice(0, Math.max(500, Math.min(16000, maxLength)))
    const out = text || `No readable text content found at ${target}.`
    this.cache.set(cacheKey, out)
    return out
  }

  expandLink(token: string): string {
    const bare = token.replace(/^ref:\/\//, '')
    const resolved = this.links.resolve(`ref://${bare}`)
    return resolved ? resolved : `Unknown link token: ${token}`
  }
}

async function assertPublicUrl(url: string): Promise<void> {
  const { hostname } = new URL(url)
  const { address } = await lookup(hostname)
  if (isForbiddenIp(address)) throw new Error(`refusing to fetch private/internal address ${address}`)
}

function isForbiddenIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const p = ip.split('.').map(Number)
    return (
      p[0] === 10 || p[0] === 127 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || p[0] === 0 ||
      p[0] >= 224
    )
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase()
    return lower === '::1' || lower === '::' || lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')
  }
  return true
}

function parseSearchResults(html: string): SearchResult[] {
  const root = parseHtml(html)
  const out: SearchResult[] = []
  for (const el of root.querySelectorAll('.result')) {
    const titleEl = el.querySelector('.result__title a')
    if (!titleEl) continue
    let url = titleEl.getAttribute('href') || ''
    if (url.includes('y.js')) continue
    if (url.startsWith('//duckduckgo.com/l/?uddg=')) {
      url = decodeURIComponent(url.split('uddg=')[1].split('&')[0])
    }
    const title = titleEl.text.trim()
    const snippet = el.querySelector('.result__snippet')?.text.trim() ?? ''
    if (title && url) out.push({ title, url, snippet })
  }

  if (!out.length) {
    for (const el of root.querySelectorAll('a.result-link')) {
      const title = el.text.trim()
      let url = el.getAttribute('href') || ''
      if (url.startsWith('//duckduckgo.com/l/?uddg=')) {
        url = decodeURIComponent(url.split('uddg=')[1].split('&')[0])
      }
      const snippet = el.closest('tr')?.nextElementSibling?.querySelector('.result-snippet')?.text.trim() ?? ''
      if (title && url) out.push({ title, url, snippet })
    }
  }
  return out
}

function extractText(html: string): string {
  const root = parseHtml(html)
  for (const el of root.querySelectorAll('script, style, nav, header, footer, aside, form, noscript, iframe, .ad, .ads, [role="navigation"]')) {
    el.remove()
  }
  const main: HTMLElement = root.querySelector('main, article, [role="main"]') ?? root.querySelector('body') ?? root
  return main
    .text
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line: string) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}
