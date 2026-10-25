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

/**
 * Proxy embedding: the platform serves holt under its own path (`/chat/` -> holt `/<id>/`) and answers
 * "who is this?" at `url` from its own cookies. holt calls `url` server-side with the cookies the
 * browser sent through the proxy, so the answer comes from the platform itself, never from the page.
 */
export interface UserStateConfig {
  /** Absolute URL of the platform's user-state endpoint. Always this URL, never one from a request. */
  url: string
  /** Field names in the endpoint's JSON. Dotted paths reach into nested objects ("user.id"). */
  fields: {
    id: string; name: string; emailVerified: string | null; avatar: string | null
    /** Trusted platforms only: the linked Discord id, site-admin flag, and chat display name (over `name`). */
    discordId: string | null; admin: string | null; displayName: string | null
  }
  /** Cookie names forwarded to `url`. Null forwards every cookie the browser sent. */
  cookies: readonly string[] | null
  /**
   * For platforms that keep their login in localStorage instead of a cookie (abulxt, Abstract AI): the key
   * the page reads on the platform's own origin and sends as `Authorization: Bearer`, which holt forwards to
   * `url` like a cookie. Null: cookies only, and holt never forwards an Authorization header.
   */
  tokenStorageKey: string | null
  /**
   * How the platform expects that token on its user-state URL: a header name and whether the value is
   * `Bearer <token>` (abulxt) or the raw token (nocturne's `X-Noc-Session`). Default: Authorization, bearer.
   */
  tokenHeader: { name: string; bearer: boolean }
}

export interface Platform {
  id: string
  name: string
  identityNamespace: string
  /** Identity tokens (iframe embedding). Null when the platform only uses proxy embedding. */
  issuer: string | null
  secret: string | null
  allowedOrigins: readonly string[]
  links: PlatformLinks
  userState: UserStateConfig | null
  /**
   * The full chatbox instead of the identity shell (proxy platforms only). The chatbox calls its API and
   * realtime socket under the platform's `/chat/_holt/api/`, through the same proxy rule as the page.
   */
  chat: boolean
  /**
   * The platform may vouch for more than who is signed in (userState.fields.discordId / admin /
   * displayName): its users chat with their linked Discord member's roles and as site admins. Set only for
   * platforms the operator controls (abulxt, Abstract), never for partners.
   */
  trusted: boolean
  /**
   * The platform's private hook (loopback or https), signed both ways with `secret` (hook-signature.ts):
   * holt relays the platform's own Discord commands, buttons and home-guild member events to it, and the
   * platform tells holt when an identity changed or was deleted (`/<id>/_holt/platform/*`). Null: none.
   */
  hook: { url: string; secret: string } | null
}

const SLUG = /^[a-z][a-z0-9-]{0,31}$/
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i
const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/
// A field path ("user.id"), or several separated by `|` (the first present one wins). emailVerified may be
// negated with `!` ("!user.emailNotice": verified while the platform shows no verify-email notice).
const FIELD_PATH = /^!?[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,3}(\|[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,3}){0,4}$/
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/
/** Headers holt must never let a platform config redirect a visitor's token into. */
const FORBIDDEN_TOKEN_HEADERS = new Set(['host', 'cookie', 'content-length', 'transfer-encoding', 'connection', 'x-holt-license', 'x-holt-principal'])
const STORAGE_KEY = /^[A-Za-z0-9:._-]{1,128}$/
/** `discord:` and `guest:` are holt's own; a platform may not claim them. */
const RESERVED_NAMESPACES = new Set(['discord', 'guest', 'holt'])
/** Top-level paths holt serves itself. A platform id is a path prefix in proxy embedding, so these are taken. */
const RESERVED_IDS = new Set(['api', 'assets', 'embed', 'healthz', 'holt'])

class PlatformConfigError extends Error {}

function fail(id: string, message: string): never {
  throw new PlatformConfigError(`platform ${id}: ${message}`)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function httpsUrl(id: string, field: string, value: unknown, optional: boolean): string | null {
  const raw = text(value)
  if (raw === null) return optional ? null : fail(id, `${field} is required`)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return fail(id, `${field} is not a URL`)
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') fail(id, `${field} must be https`)
  return url.href
}

/**
 * An account link: an absolute https URL, or, on a proxy-only platform, a path ("/#/account") on whatever
 * origin the page is served from. A path keeps users on the domain they came in on (abulxt is served on
 * many). Iframe pages cannot use one: the platform's page resolves it, and holt cannot know that page.
 */
function linkUrl(id: string, field: string, value: unknown, optional: boolean, allowPath: boolean): string | null {
  const raw = text(value)
  if (raw !== null && raw.startsWith('/')) {
    if (!allowPath) fail(id, `${field}: a path link needs a proxy-only platform (userState, no issuer/secret)`)
    if (raw.startsWith('//') || /[\s\\]/.test(raw)) fail(id, `${field} is not a path`)
    return raw
  }
  return httpsUrl(id, field, value, optional)
}

function parseUserState(id: string, value: unknown): UserStateConfig | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object') fail(id, 'userState must be an object')
  const raw = value as Record<string, unknown>
  const url = httpsUrl(id, 'userState.url', raw.url, false)!
  const fields = (typeof raw.fields === 'object' && raw.fields !== null ? raw.fields : {}) as Record<string, unknown>
  const field = (key: string, fallback: string | null): string | null => {
    if (fields[key] === null) return null
    const path = text(fields[key]) ?? fallback
    if (path !== null && !FIELD_PATH.test(path)) fail(id, `userState.fields.${key} is not a field name`)
    return path
  }
  let cookies: string[] | null = null
  if (raw.cookies !== undefined && raw.cookies !== null) {
    if (!Array.isArray(raw.cookies) || raw.cookies.length === 0) fail(id, 'userState.cookies must be a non-empty list of cookie names')
    cookies = raw.cookies.map((name) => {
      if (typeof name !== 'string' || !COOKIE_NAME.test(name)) fail(id, `userState.cookies entry ${String(name)} is not a cookie name`)
      return name
    })
  }
  const headerName = (text(raw.tokenHeader) ?? 'authorization').toLowerCase()
  if (!HEADER_NAME.test(headerName) || FORBIDDEN_TOKEN_HEADERS.has(headerName)) fail(id, 'userState.tokenHeader is not an allowed header name')
  const tokenHeader = { name: headerName, bearer: headerName === 'authorization' }
  const tokenStorageKey = text(raw.tokenStorageKey)
  if (tokenStorageKey !== null && !STORAGE_KEY.test(tokenStorageKey)) fail(id, 'userState.tokenStorageKey is not a storage key')
  return {
    url,
    fields: {
      id: field('id', 'id')!, name: field('name', 'username')!, emailVerified: field('emailVerified', 'email_verified'), avatar: field('avatar', 'avatar'),
      discordId: field('discordId', null), admin: field('admin', null), displayName: field('displayName', null),
    },
    cookies,
    tokenStorageKey,
    tokenHeader,
  }
}

function parsePlatform(entry: unknown, index: number): Platform {
  if (typeof entry !== 'object' || entry === null) throw new PlatformConfigError(`platforms[${index}] is not an object`)
  const raw = entry as Record<string, unknown>
  const id = text(raw.id) ?? fail(`#${index}`, 'id is required')
  if (!SLUG.test(id)) fail(id, 'id must be a lowercase slug')
  if (RESERVED_IDS.has(id)) fail(id, `id ${id} is reserved (holt serves that path itself)`)
  const name = text(raw.name) ?? fail(id, 'name is required')
  const identityNamespace = text(raw.identityNamespace) ?? id
  if (!SLUG.test(identityNamespace)) fail(id, 'identityNamespace must be a lowercase slug')
  if (RESERVED_NAMESPACES.has(identityNamespace)) fail(id, `identityNamespace ${identityNamespace} is reserved`)
  const userState = parseUserState(id, raw.userState)
  // Identity tokens are optional once the platform answers user state itself; one of the two is required.
  const issuer = text(raw.issuer)
  const secret = text(raw.secret)
  if ((issuer === null) !== (secret === null)) fail(id, 'issuer and secret go together')
  if (issuer === null && userState === null) fail(id, 'needs userState (proxy embedding) or issuer + secret (identity tokens)')
  if (secret !== null && (secret === 'CHANGE_ME' || secret.length < 32)) fail(id, 'secret must be at least 32 characters')
  const origins = Array.isArray(raw.allowedOrigins) ? raw.allowedOrigins : []
  if (origins.length === 0) fail(id, 'allowedOrigins must list at least one origin')
  const allowedOrigins = origins.map((value) => {
    const origin = text(value) ?? fail(id, 'allowedOrigins has an empty entry')
    if (!ORIGIN.test(origin) || origin.endsWith('/')) fail(id, `allowedOrigins entry ${origin} is not an origin`)
    if (!origin.startsWith('https://') && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin)) fail(id, `allowedOrigins entry ${origin} must be https`)
    return origin.toLowerCase()
  })
  const links = (typeof raw.links === 'object' && raw.links !== null ? raw.links : {}) as Record<string, unknown>
  const pathLinks = secret === null && userState !== null
  if (raw.chat !== undefined && typeof raw.chat !== 'boolean') fail(id, 'chat must be true or false')
  const chat = raw.chat === true
  if (chat && userState === null) fail(id, 'chat needs proxy embedding (userState): the chatbox calls the chat API on its own origin')
  if (raw.trusted !== undefined && typeof raw.trusted !== 'boolean') fail(id, 'trusted must be true or false')
  const trusted = raw.trusted === true
  // Only a trusted platform may vouch for a Discord account or an admin: anything else would let a partner
  // hand its users another member's roles.
  if (!trusted && userState && (userState.fields.discordId || userState.fields.admin)) fail(id, 'userState.fields.discordId / admin need trusted: true')
  let hook: Platform['hook'] = null
  if (raw.hook !== undefined && raw.hook !== null) {
    const h = (typeof raw.hook === 'object' ? raw.hook : {}) as Record<string, unknown>
    const hookUrl = text(h.url) ?? fail(id, 'hook.url is required')
    if (!/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?\/)/.test(hookUrl)) fail(id, 'hook.url must be https or loopback http')
    const hookSecret = text(h.secret) ?? fail(id, 'hook.secret is required')
    if (hookSecret.length < 32) fail(id, 'hook.secret must be at least 32 characters')
    hook = { url: hookUrl.replace(/\/+$/, ''), secret: hookSecret }
  }
  return {
    id,
    name,
    identityNamespace,
    issuer,
    secret,
    allowedOrigins,
    links: {
      account: linkUrl(id, 'links.account', links.account, false, pathLinks)!,
      settings: linkUrl(id, 'links.settings', links.settings, false, pathLinks)!,
      verifyEmail: linkUrl(id, 'links.verifyEmail', links.verifyEmail, true, pathLinks),
      signIn: linkUrl(id, 'links.signIn', links.signIn, true, pathLinks),
    },
    userState,
    chat,
    trusted,
    hook,
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
    if (platform.secret === null) continue
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
