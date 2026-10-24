import { clientConfig } from './config'

const ACTIVE_KEY = 'abulxt:api-base'

// Last-resort backend when none of the configured bases answer from this
// device (school filters, DNS blocks). Only used by builds that talk to a
// cross-origin API (apiBases configured); same-origin hosts never use it.
export const FALLBACK_API_BASE = 'https://commonsensehealthcare.org'

function normalizeBase(value: string): string {
  return value.trim().replace(/\/$/, '')
}

function isAbsoluteHttp(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

export function configuredApiBases(): string[] {
  const cfg = clientConfig() as { apiBase?: string; apiBases?: string[] }
  const out: string[] = []
  const push = (raw?: string) => {
    const base = normalizeBase(String(raw || ''))
    if (!base) return
    if (!out.includes(base)) out.push(base)
  }
  if (Array.isArray(cfg.apiBases)) {
    for (const item of cfg.apiBases) push(item)
  }
  push(cfg.apiBase)
  if (out.length) push(FALLBACK_API_BASE)
  return out
}

function readStoredActive(): string {
  try {
    return normalizeBase(localStorage.getItem(ACTIVE_KEY) || '')
  } catch {
    return ''
  }
}

function writeStoredActive(base: string) {
  try {
    if (base) localStorage.setItem(ACTIVE_KEY, base)
    else localStorage.removeItem(ACTIVE_KEY)
  } catch {
    /* ignore */
  }
}

let memoryActive = ''
// Set when the page's own origin serves the API (local dev, the VPS domains).
// Same-origin wins over every configured base: no CORS, no cross-site hop.
let sameOriginBase = ''

function pageOrigin(): string {
  if (typeof window === 'undefined' || !window.location) return ''
  return /^https?:$/.test(window.location.protocol) ? window.location.origin : ''
}

export function apiBase(): string {
  if (sameOriginBase) return sameOriginBase
  const bases = configuredApiBases()
  if (!bases.length) return ''

  const preferred = normalizeBase(memoryActive || readStoredActive())
  if (preferred && bases.includes(preferred)) return preferred

  memoryActive = bases[0]
  writeStoredActive(memoryActive)
  return memoryActive
}

export function setApiBase(base: string): string {
  const normalized = normalizeBase(base)
  const bases = configuredApiBases()
  if (normalized && bases.includes(normalized)) {
    memoryActive = normalized
    writeStoredActive(normalized)
    return memoryActive
  }
  return apiBase()
}

export function rotateApiBase(failedBase?: string): string {
  const bases = configuredApiBases()
  if (!bases.length) return ''
  const current = normalizeBase(failedBase || apiBase())
  if (sameOriginBase && current === sameOriginBase) {
    sameOriginBase = ''
    return apiBase()
  }
  const idx = Math.max(0, bases.indexOf(current))
  const next = bases[(idx + 1) % bases.length] || bases[0]
  return setApiBase(next)
}

export function siteOrigin(): { protocol: string; host: string } {
  const loc =
    typeof window !== 'undefined' && window.location
      ? window.location
      : typeof location !== 'undefined'
        ? location
        : null
  if (loc && loc.host) return { protocol: loc.protocol, host: loc.host }
  if (typeof document !== 'undefined' && document.baseURI) {
    try {
      const u = new URL(document.baseURI)
      if (u.host) return { protocol: u.protocol, host: u.host }
    } catch {
      /* ignore */
    }
  }
  const base = apiBase()
  if (base && isAbsoluteHttp(base)) {
    try {
      const u = new URL(base)
      return { protocol: u.protocol, host: u.host }
    } catch {
      /* ignore */
    }
  }
  return { protocol: 'https:', host: '' }
}

export function apiUrl(path: string, base = apiBase()): string {
  if (!path.startsWith('/')) path = `/${path}`
  return `${normalizeBase(base)}${path}`
}

export function rewriteApiUrl(input: string, nextBase: string): string {
  const target = normalizeBase(nextBase)
  if (!target) return input
  try {
    if (/^https?:\/\//i.test(input)) {
      const u = new URL(input)
      const n = new URL(target)
      u.protocol = n.protocol
      u.host = n.host
      return u.toString()
    }
  } catch {
    /* fall through */
  }
  if (input.startsWith('/')) return `${target}${input}`
  return input
}

/**
 * Point an absolute API URL at the active backend. Several modules build
 * `apiUrl(...)` constants at import time, before selectApiBase() has run, so
 * their origin can be a stale or unreachable base; fetch helpers call this to
 * retarget them. URLs on other origins are returned unchanged.
 */
export function activeApiUrl(input: string): string {
  if (!/^https?:\/\//i.test(input)) return input
  const active = apiBase()
  if (!active) return input
  try {
    const origin = new URL(input).origin
    if (origin === new URL(active).origin) return input
    const known = [...configuredApiBases(), pageOrigin()].filter(Boolean)
    return known.includes(origin) ? rewriteApiUrl(input, active) : input
  } catch {
    return input
  }
}

export function shouldRotateApiBase(res?: Response | null, err?: unknown): boolean {
  if (err) return true
  if (!res) return true
  return res.status === 502 || res.status === 503 || res.status === 504 || res.status === 521 || res.status === 522 || res.status === 523
}

/** The configured API base an absolute URL points at, or '' if it is not ours. */
export function apiBaseOf(input: string): string {
  if (!/^https?:\/\//i.test(input)) return ''
  let origin: string
  try {
    origin = new URL(input).origin
  } catch {
    return ''
  }
  for (const base of configuredApiBases()) {
    try {
      if (new URL(base).origin === origin) return base
    } catch {
      /* relative base: not a cross-origin backend */
    }
  }
  return ''
}

// ---------------------------------------------------------------------------
// Backend health + automatic failover.
//
// Static builds talk to one of several backend domains (apiBases). Any of them
// can be blocked by a network filter (DNS sinkhole, dropped connections, an
// HTML block page). A base counts as healthy only when a cross-origin GET of
// PROBE_PATH comes back with our JSON: block pages carry no CORS headers and
// are not our JSON, so they fail the probe. Probes race (staggered, first
// healthy wins); results persist so the next load starts on a known-good base.
// ---------------------------------------------------------------------------

const HEALTH_KEY = 'abulxt:api-health'
// Unauthenticated, already routed to the app server on every edge, and answers
// a small JSON 401 with CORS headers. Sent without credentials or custom
// headers so it stays a simple request (no preflight).
const PROBE_PATH = '/api/auth/me'
const PROBE_TIMEOUT_MS = 6000
const PROBE_STAGGER_MS = 350
const BAD_COOLDOWN_MS = 5 * 60_000
const GOOD_TTL_MS = 10 * 60_000

interface HealthRecord {
  good: Record<string, number>
  bad: Record<string, number>
}

function readHealth(): HealthRecord {
  try {
    const raw = JSON.parse(localStorage.getItem(HEALTH_KEY) || '{}') as Partial<HealthRecord>
    return { good: raw.good || {}, bad: raw.bad || {} }
  } catch {
    return { good: {}, bad: {} }
  }
}

function writeHealth(record: HealthRecord) {
  try {
    localStorage.setItem(HEALTH_KEY, JSON.stringify(record))
  } catch {
    /* ignore */
  }
}

function markGood(base: string) {
  const record = readHealth()
  record.good[base] = Date.now()
  delete record.bad[base]
  writeHealth(record)
}

function markBad(base: string) {
  const record = readHealth()
  record.bad[base] = Date.now() + BAD_COOLDOWN_MS
  delete record.good[base]
  writeHealth(record)
}

function isCoolingDown(base: string, record = readHealth()): boolean {
  return (record.bad[base] || 0) > Date.now()
}

export async function probeApiBase(base: string, signal?: AbortSignal): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetch(apiUrl(PROBE_PATH, base), {
      cache: 'no-store',
      credentials: 'omit',
      mode: 'cors',
      signal: controller.signal,
    })
    if (res.status !== 200 && res.status !== 401) return false
    const body = JSON.parse(await res.text()) as unknown
    return !!body && typeof body === 'object' && ('user' in body || 'error' in body)
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Candidate order: current base, then config order; cooling-down bases last. */
function candidateOrder(exclude = ''): string[] {
  const record = readHealth()
  const bases = configuredApiBases().filter((base) => base !== exclude)
  const active = normalizeBase(memoryActive || readStoredActive())
  const ordered = active && bases.includes(active) ? [active, ...bases.filter((b) => b !== active)] : bases
  return [
    ...ordered.filter((base) => !isCoolingDown(base, record)),
    ...ordered.filter((base) => isCoolingDown(base, record)),
  ]
}

/** Probe candidates with a staggered race; resolves the first healthy base or ''. */
function raceHealthy(candidates: string[]): Promise<string> {
  return new Promise((resolve) => {
    let next = 0
    let pending = 0
    let done = false
    let stagger: ReturnType<typeof setTimeout> | undefined
    const controllers = new Set<AbortController>()
    const finish = (winner: string) => {
      if (done) return
      done = true
      clearTimeout(stagger)
      for (const c of controllers) c.abort()
      resolve(winner)
    }
    const launch = () => {
      if (done) return
      clearTimeout(stagger)
      if (next >= candidates.length) {
        if (!pending) finish('')
        return
      }
      const base = candidates[next++]
      const controller = new AbortController()
      controllers.add(controller)
      pending++
      void probeApiBase(base, controller.signal).then((ok) => {
        controllers.delete(controller)
        pending--
        if (done) return
        if (ok) {
          markGood(base)
          finish(base)
          return
        }
        markBad(base)
        launch()
      })
      if (next < candidates.length) stagger = setTimeout(launch, PROBE_STAGGER_MS)
    }
    launch()
  })
}

let resolving: Promise<string> | null = null
const rechecking = new Map<string, Promise<string>>()

function resolveHealthyBase(exclude = ''): Promise<string> {
  if (resolving) return resolving
  resolving = raceHealthy(candidateOrder(exclude))
    .then((winner) => (winner ? setApiBase(winner) : apiBase()))
    .finally(() => {
      resolving = null
    })
  return resolving
}

/**
 * The base to use right now, verified. Returns immediately when the active
 * base has passed a probe before (revalidating in the background once stale);
 * only the very first load, or a base known to be down, waits for a race.
 */
export function ensureApiBase(): Promise<string> {
  const active = apiBase()
  if (sameOriginBase || configuredApiBases().length <= 1) return Promise.resolve(active)
  const record = readHealth()
  if (isCoolingDown(active, record)) return resolveHealthyBase(active)
  const verifiedAt = record.good[active]
  if (!verifiedAt) return resolveHealthyBase()
  if (Date.now() - verifiedAt > GOOD_TTL_MS && !resolving && !rechecking.has(active)) {
    void reportApiFailure(active)
  }
  return Promise.resolve(active)
}

/**
 * A request to `base` failed at the network level. Re-probe it: if it is still
 * healthy the failure was route-specific and nothing rotates; otherwise race
 * the other bases and switch. Resolves the base callers should use next.
 */
export function reportApiFailure(base: string): Promise<string> {
  const failed = normalizeBase(base)
  if (configuredApiBases().length <= 1 || !failed) return Promise.resolve(apiBase())
  if (failed !== apiBase()) return Promise.resolve(apiBase())
  if (sameOriginBase && failed === sameOriginBase) {
    // The page's own origin stopped serving the API: fall back to the configured bases.
    sameOriginBase = ''
    return resolveHealthyBase()
  }
  if (resolving) return resolving
  const existing = rechecking.get(failed)
  if (existing) return existing
  const check = probeApiBase(failed)
    .then((ok) => {
      if (ok) {
        markGood(failed)
        return failed
      }
      markBad(failed)
      return resolveHealthyBase(failed)
    })
    .finally(() => {
      rechecking.delete(failed)
    })
  rechecking.set(failed, check)
  return check
}

// Startup wait cap: past this, render on the current base and let the race
// keep running in the background (it switches the active base when it lands).
const SELECT_WAIT_MS = 4500
let selection: Promise<string> | null = null

/**
 * Resolve (once per page load) the backend to start on. The page's own origin
 * wins when it serves the API (VPS domains, local dev: no CORS, no cross-site
 * hop); otherwise the health engine picks a reachable configured base.
 */
export function selectApiBase(): Promise<string> {
  if (selection) return selection
  if (configuredApiBases().length <= 1 || typeof fetch !== 'function' || typeof AbortController === 'undefined') {
    selection = Promise.resolve(apiBase())
    return selection
  }
  selection = (async () => {
    const own = pageOrigin()
    if (own) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 1500)
      try {
        if (await probeApiBase(own, controller.signal)) {
          sameOriginBase = own
          return own
        }
      } finally {
        clearTimeout(timer)
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const capped = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve(apiBase()), SELECT_WAIT_MS)
    })
    try {
      return await Promise.race([ensureApiBase(), capped])
    } finally {
      clearTimeout(timer)
    }
  })()
  return selection
}
