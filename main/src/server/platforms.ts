// Platforms: the sites that embed holt and vouch for their own users (config `platforms`).
//
// A platform owns three things holt never does: the account system, the pages for it (links), and
// the page origins allowed to embed. Identity is `<identityNamespace>:<subject>`; platforms that share
// an account system share a namespace so one account stays one identity across them.
//
// Pure: no I/O. Throws on a malformed entry so a typo fails at startup, not at a user's first message.

export interface PlatformLinks {
  account: string
  settings: string
  verifyEmail: string | null
  signIn: string | null
}

export interface Platform {
  id: string
  name: string
  identityNamespace: string
  issuer: string
  secret: string
  allowedOrigins: readonly string[]
  links: PlatformLinks
}

const SLUG = /^[a-z][a-z0-9-]{0,31}$/
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i
/** `discord:` and `guest:` are holt's own; a platform may not claim them. */
const RESERVED_NAMESPACES = new Set(['discord', 'guest', 'holt'])

class PlatformConfigError extends Error {}

function fail(id: string, message: string): never {
  throw new PlatformConfigError(`platform ${id}: ${message}`)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function httpsUrl(id: string, field: string, value: unknown, optional: boolean): string | null {
  const raw = text(value)
  if (raw === null) return optional ? null : fail(id, `links.${field} is required`)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return fail(id, `links.${field} is not a URL`)
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') fail(id, `links.${field} must be https`)
  return url.href
}

function parsePlatform(entry: unknown, index: number): Platform {
  if (typeof entry !== 'object' || entry === null) throw new PlatformConfigError(`platforms[${index}] is not an object`)
  const raw = entry as Record<string, unknown>
  const id = text(raw.id) ?? fail(`#${index}`, 'id is required')
  if (!SLUG.test(id)) fail(id, 'id must be a lowercase slug')
  const name = text(raw.name) ?? fail(id, 'name is required')
  const identityNamespace = text(raw.identityNamespace) ?? id
  if (!SLUG.test(identityNamespace)) fail(id, 'identityNamespace must be a lowercase slug')
  if (RESERVED_NAMESPACES.has(identityNamespace)) fail(id, `identityNamespace ${identityNamespace} is reserved`)
  const issuer = text(raw.issuer) ?? fail(id, 'issuer is required')
  const secret = text(raw.secret) ?? fail(id, 'secret is required')
  if (secret === 'CHANGE_ME' || secret.length < 32) fail(id, 'secret must be at least 32 characters')
  const origins = Array.isArray(raw.allowedOrigins) ? raw.allowedOrigins : []
  if (origins.length === 0) fail(id, 'allowedOrigins must list at least one origin')
  const allowedOrigins = origins.map((value) => {
    const origin = text(value) ?? fail(id, 'allowedOrigins has an empty entry')
    if (!ORIGIN.test(origin) || origin.endsWith('/')) fail(id, `allowedOrigins entry ${origin} is not an origin`)
    if (!origin.startsWith('https://') && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin)) fail(id, `allowedOrigins entry ${origin} must be https`)
    return origin.toLowerCase()
  })
  const links = (typeof raw.links === 'object' && raw.links !== null ? raw.links : {}) as Record<string, unknown>
  return {
    id,
    name,
    identityNamespace,
    issuer,
    secret,
    allowedOrigins,
    links: {
      account: httpsUrl(id, 'account', links.account, false)!,
      settings: httpsUrl(id, 'settings', links.settings, false)!,
      verifyEmail: httpsUrl(id, 'verifyEmail', links.verifyEmail, true),
      signIn: httpsUrl(id, 'signIn', links.signIn, true),
    },
  }
}

/** The platform list from config. Ids are unique; a secret is never shared between namespaces. */
export function parsePlatforms(raw: unknown): Platform[] {
  if (!Array.isArray(raw)) return []
  const out = raw.map(parsePlatform)
  const ids = new Set<string>()
  const secretOwner = new Map<string, string>()
  for (const platform of out) {
    if (ids.has(platform.id)) fail(platform.id, 'duplicate id')
    ids.add(platform.id)
    const owner = secretOwner.get(platform.secret)
    if (owner !== undefined && owner !== platform.identityNamespace) fail(platform.id, `shares a secret with namespace ${owner}`)
    secretOwner.set(platform.secret, platform.identityNamespace)
  }
  return out
}

export function platformById(platforms: readonly Platform[], id: string): Platform | null {
  return platforms.find((platform) => platform.id === id) ?? null
}

/** The platform a page origin belongs to. An origin embeds at most one platform. */
export function platformForOrigin(platforms: readonly Platform[], origin: string | undefined): Platform | null {
  if (!origin) return null
  const needle = origin.toLowerCase()
  return platforms.find((platform) => platform.allowedOrigins.includes(needle)) ?? null
}

/** The CSP frame-ancestors source list for one platform's embed page. */
export function frameAncestors(platform: Platform): string {
  return `frame-ancestors ${platform.allowedOrigins.join(' ')}`
}
