// The platform this embed page was served for. holt-service.ts injects it into the built page as
// `<script type="application/json" id="holt-platform">`: a data block, never executed, so the page's
// CSP needs no allowance for it. Everything in it is public (origins and the platform's own URLs).

import type { LinkTarget } from './protocol'

export type PlatformLinks = Record<LinkTarget, string | null>

export interface EmbedPlatform {
  id: string
  name: string
  /** Page origins allowed to embed this platform's chat. Lower-case, no trailing slash. */
  origins: string[]
  links: PlatformLinks
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && /^https?:\/\//.test(value) ? value : null
}

export function readPlatform(): EmbedPlatform | null {
  const el = document.getElementById('holt-platform')
  if (!el?.textContent) return null
  let raw: unknown
  try {
    raw = JSON.parse(el.textContent)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const { id, name, origins, links } = raw as Record<string, unknown>
  if (typeof id !== 'string' || typeof name !== 'string' || !Array.isArray(origins)) return null
  const linkObject = (typeof links === 'object' && links !== null ? links : {}) as Record<string, unknown>
  return {
    id,
    name,
    origins: origins.filter((origin): origin is string => typeof origin === 'string').map((origin) => origin.toLowerCase()),
    links: {
      account: stringOrNull(linkObject.account),
      settings: stringOrNull(linkObject.settings),
      verifyEmail: stringOrNull(linkObject.verifyEmail),
      signIn: stringOrNull(linkObject.signIn),
    },
  }
}
