// The chatbox's API base. The chat page is always served by the platform's own `/chat/` proxy, so its API is
// always one place: the page's `./_holt/` (`/chat/_holt/api/...`), which the same proxy rule sends to holt.
// No failover (abulxt's static builds rotate between backend domains; holt has nothing to rotate to).

import { readPlatform } from '../embed/platform'

let cached: string | null = null

function holtBase(): string {
  if (cached !== null) return cached
  let base = ''
  try {
    if (typeof document !== 'undefined' && readPlatform()) base = new URL('./_holt', document.baseURI).href.replace(/\/$/, '')
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
