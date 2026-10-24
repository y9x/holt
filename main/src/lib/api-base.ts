// holt-owned stand-in for abulxt's lib/api-base.ts (VENDOR.md): same exports, holt's rules.
//
// abulxt's version picks one of several backend domains and fails over between them (static and CDN
// builds). holt's chatbox is always served by the platform's own proxy, so its API is always one place:
//
// - a platform on abulxt accounts ('site'): the page's own origin. abulxt routes /api/discord/bridge/* to
//   holt and keeps /api/rt and /api/auth itself.
// - a platform with its own accounts ('holt'): under the page's `./_holt/` (`/chat/_holt/api/...`), which
//   the platform's `/chat/` proxy rule already sends to holt. No extra rule on the partner's side.
//
// No failover: there is nothing to fail over to.

import { readPlatform } from '../embed/platform'

let cached: string | null = null

function holtBase(): string {
  if (cached !== null) return cached
  let base = ''
  try {
    if (typeof document !== 'undefined' && readPlatform()?.api === 'holt') base = new URL('./_holt', document.baseURI).href.replace(/\/$/, '')
  } catch {
    base = ''
  }
  cached = base
  return base
}

export function configuredApiBases(): string[] {
  return []
}

export function apiBase(): string {
  return holtBase()
}

export function apiUrl(path: string, base = apiBase()): string {
  if (!path.startsWith('/')) path = `/${path}`
  return `${base.replace(/\/$/, '')}${path}`
}

export function rewriteApiUrl(input: string, nextBase: string): string {
  const target = nextBase.trim().replace(/\/$/, '')
  if (!target) return input
  if (input.startsWith('/')) return `${target}${input}`
  return input
}

/** Every API URL already points at the one base. */
export function activeApiUrl(input: string): string {
  return input
}

export function shouldRotateApiBase(_res?: Response | null, _err?: unknown): boolean {
  return false
}

export function apiBaseOf(_input: string): string {
  return ''
}

export function ensureApiBase(): Promise<string> {
  return Promise.resolve(apiBase())
}

export function reportApiFailure(_base?: string): Promise<string> {
  return Promise.resolve(apiBase())
}
