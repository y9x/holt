// The platform this page was served for, and how (proxy or iframe). holt-service.ts injects it into the built page as
// `<script type="application/json" id="holt-platform">`: a data block, never executed, so the page's
// CSP needs no allowance for it. Everything in it is public (origins and the platform's own URLs).

import type { LinkTarget } from './protocol'

export type PlatformLinks = Record<LinkTarget, string | null>

export interface EmbedPlatform {
  id: string
  name: string
  /** proxy: served top-level under the platform's own `/chat/`. iframe: framed by the platform's page. */
  mode: 'proxy' | 'iframe'
  /** Page origins allowed to embed this platform's chat. Lower-case, no trailing slash. */
  origins: string[]
  links: PlatformLinks
  /** Proxy mode, localStorage logins: the key holding the platform's bearer token on its own origin. */
  tokenStorageKey: string | null
  /** Proxy mode: render the full chatbox (the platform's origin serves the chat API). */
  chat: boolean
  /** The guild this site's chatbox opens on first, or null. */
  homeGuild: string | null
}

function stringOrNull(value: unknown): string | null {
  // An absolute URL, or a path on this page's own origin (proxy-only platforms; holt-service validates it).
  return typeof value === 'string' && (/^https?:\/\//.test(value) || /^\/(?!\/)/.test(value)) ? value : null
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
  const { id, name, mode, origins, links, tokenStorageKey, chat, homeGuild } = raw as Record<string, unknown>
  if (typeof id !== 'string' || typeof name !== 'string' || !Array.isArray(origins)) return null
  const linkObject = (typeof links === 'object' && links !== null ? links : {}) as Record<string, unknown>
  return {
    id,
    name,
    mode: mode === 'proxy' ? 'proxy' : 'iframe',
    origins: origins.filter((origin): origin is string => typeof origin === 'string').map((origin) => origin.toLowerCase()),
    links: {
      account: stringOrNull(linkObject.account),
      settings: stringOrNull(linkObject.settings),
      verifyEmail: stringOrNull(linkObject.verifyEmail),
      signIn: stringOrNull(linkObject.signIn),
    },
    tokenStorageKey: mode === 'proxy' && typeof tokenStorageKey === 'string' && tokenStorageKey ? tokenStorageKey : null,
    chat: mode === 'proxy' && chat === true,
    homeGuild: typeof homeGuild === 'string' && /^\d{15,22}$/.test(homeGuild) ? homeGuild : null,
  }
}
