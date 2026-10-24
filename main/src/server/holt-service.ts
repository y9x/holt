// holt service: the standalone chatbox server. Runs on amph under systemd (deploy/holt.service),
// loopback only; OpenResty terminates TLS in front of it.
//
// Today it serves the embed handshake end to end: the compiled embed page (main/dist, built by
// `make build` through the vendored protection pipeline), the partner loader script, and the
// identity exchange that turns a platform's token into a holt session. The chat itself (API,
// realtime, Discord bridge) arrives in later phases (docs/PLAN.md) and mounts next to these routes.
//
// Proxy embedding (the simple way, docs/EMBEDDING.md): the platform proxies `/chat/` on its own site to
// `/<platform id>/` here, so holt runs same-origin with the platform, and says who is signed in at its
// own user-state URL, which holt calls with the forwarded cookies (forward-auth.ts).
//
//   GET  /<id>/                       The chat page, top-level on the platform's site.
//   GET  /<id>/_holt/me               { principal | null, links }. Needs `X-Holt: 1`.
//   *    /<id>/_holt/api/discord/bridge/*  The chat API (chat platforms), proxied to holt-chat.
//
// A chat platform with its own accounts (not abulxt's, see usesSiteAccounts) also gets:
//
//   POST /<id>/_holt/session          Platform cookies/token -> a short holt session ({ session: null } when
//                                     signed out). The page holds it and renews it. Needs `X-Holt: 1`.
//   GET  /<id>/_holt/api/auth/me      The chatbox's "who am I" for that session.
//   WS   /<id>/_holt/api/rt           Realtime (bridge events), proxied to holt-chat.
//
// For those platforms holt-service is the only one that decides who the caller is: it drops the caller's
// Authorization and Cookie headers (except the `wcs` seal seed) and any X-Holt-Principal, and tells
// holt-chat in a signed X-Holt-Principal (chat-caller.ts).
//   GET  /<id>/assets/*               The compiled build (relative URLs, so any proxy path works).
//
// Iframe embedding (identity tokens, for sites that cannot proxy):
//
//   GET  /healthz                     ok
//   GET  /holt-embed.js               The loader script platforms include (main/loader).
//   GET  /embed?platform=<id>         The iframe page. CSP frame-ancestors = that platform's origins.
//   GET  /assets/*, other dist files  The compiled build. Hashed names, served immutable.
//   POST /api/session                 { platform, token } -> { session, expiresAt, principal, links }
//                                     Origin must be one of the platform's allowedOrigins.
//   GET  /api/me                      Bearer session -> { principal, links }

import http from 'node:http'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { loadConfig, type HoltConfig } from './holt-config.ts'
import { frameAncestors, platformById, platformForOrigin, usesSiteAccounts, type Platform } from './platforms.ts'
import { FOREIGN_PAGE_HEADER, PRINCIPAL_HEADER, signPrincipal } from './chat-caller.ts'
import { IdentityTokenError, verifyIdentityToken, type Principal } from './identity-token.ts'
import { issueSession, readSession, SESSION_TTL_SECONDS } from './session.ts'
import { principalFromPlatform, UserStateUnavailable } from './forward-auth.ts'
import { checkLicense, readLicense, type LicenseRefusal } from './license.ts'
import { registeredLicenses } from './bridge-config.ts'

type EmbedMode = 'iframe' | 'proxy'
/** `/<platform id>/<rest>`: proxy embedding. The id grammar matches platforms.ts SLUG. */
const PROXY_PATH = /^\/([a-z][a-z0-9-]{0,31})(\/.*)?$/

const MAX_BODY_BYTES = 16 * 1024
const APP_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const DIST_DIR = path.join(APP_ROOT, 'dist')
// The partner loader is served as written, outside the obfuscation pipeline: it is a public SDK that
// runs on the partner's page, and its whole content is the documented protocol (embed/protocol.ts).
// `make build` still runs the canary check over it.
const LOADER_FILE = path.join(APP_ROOT, 'loader', 'holt-embed.js')

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.bin': 'application/octet-stream',
}

interface EmbedShell {
  html: string
  /** CSP source expressions for every inline <script> the build emits. */
  scriptHashes: string[]
}

/**
 * The built page and the hashes of its inline scripts (the obfuscation key and string registry that
 * build-obfuscator-plugin injects). Hashes instead of 'unsafe-inline', so an injected script never runs.
 */
function loadEmbedShell(): EmbedShell {
  const file = path.join(DIST_DIR, 'index.html')
  let html: string
  try {
    html = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`${file} is missing: run \`make build\` first`)
  }
  const scriptHashes: string[] = []
  for (const match of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    const attributes = match[1] ?? ''
    const body = match[2] ?? ''
    if (/\ssrc\s*=/i.test(attributes) || /type\s*=\s*["']?application\/json/i.test(attributes) || body === '') continue
    scriptHashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`)
  }
  return { html, scriptHashes }
}

/** The platform data block for one embed page. `<` is escaped so the JSON can never close the tag. */
function platformBlock(platform: Platform, mode: EmbedMode, homeGuild: string | null = null): string {
  // tokenStorageKey is a key name, not a secret: the page reads the token itself on the platform's origin.
  const tokenStorageKey = mode === 'proxy' ? platform.userState?.tokenStorageKey ?? null : null
  // homeGuild: the guild this site's chatbox opens on first (bridge.<platform>.guild).
  // api: 'site' = the chatbox calls abulxt's API on the page's origin; 'holt' = under ./_holt/ (own accounts).
  const api = usesSiteAccounts(platform) ? 'site' : 'holt'
  const data = JSON.stringify({ id: platform.id, name: platform.name, mode, origins: platform.allowedOrigins, links: platform.links, tokenStorageKey, chat: mode === 'proxy' && platform.chat, homeGuild, api })
  return `<script type="application/json" id="holt-platform">${data.replace(/</g, '\\u003c')}</script>`
}

function pageHtml(shell: EmbedShell, platform: Platform, mode: EmbedMode, homeGuild: string | null = null): string {
  const block = platformBlock(platform, mode, homeGuild)
  return shell.html.includes('</head>') ? shell.html.replace('</head>', `${block}\n</head>`) : block + shell.html
}

function embedCsp(platform: Platform, shell: EmbedShell, mode: EmbedMode): string {
  // The chatbox shows Discord CDN images, video and audio, GIF search results (klipy) and link embeds
  // (YouTube, Spotify, ... in iframes). Scripts stay 'self' plus the build's own inline hashes either way.
  const chat = mode === 'proxy' && platform.chat
  return [
    // Proxied, the page is the platform's own top-level page; framed, only the platform's origins may frame it.
    mode === 'proxy' ? "frame-ancestors 'self'" : frameAncestors(platform),
    "default-src 'self'",
    `script-src 'self' ${shell.scriptHashes.join(' ')}`.trim(),
    // HolyText's ellipsis mode injects a <style> into its shadow root.
    "style-src 'self' 'unsafe-inline'",
    chat ? 'img-src https: data: blob:' : 'img-src https: data:',
    chat ? "connect-src 'self' https://api.klipy.com" : "connect-src 'self'",
    ...(chat ? ['media-src https: data: blob:', 'frame-src https:', "font-src 'self' data:"] : []),
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ')
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'private, no-store')
  response.end(JSON.stringify(body))
}

function sendText(response: http.ServerResponse, status: number, type: string, body: string | Buffer, cache = 'no-store'): void {
  response.statusCode = status
  response.setHeader('Content-Type', type)
  response.setHeader('Cache-Control', cache)
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.end(body)
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function publicPrincipal(principal: Principal, config: HoltConfig) {
  return {
    key: principal.key,
    platform: principal.platformId,
    name: principal.name,
    emailVerified: principal.emailVerified,
    avatar: principal.avatar,
    tier: principal.tier,
    admin: config.admins.has(principal.key),
  }
}

/** CORS for the handshake: only a platform's own origins may call /api/* from a page. */
function cors(request: http.IncomingMessage, response: http.ServerResponse, config: HoltConfig): Platform | null {
  const origin = request.headers.origin
  const platform = platformForOrigin(config.platforms, origin)
  if (!platform || !origin) return null
  response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  response.setHeader('Access-Control-Max-Age', '600')
  response.setHeader('Vary', 'Origin')
  return platform
}

function bearer(request: http.IncomingMessage): string | null {
  const header = request.headers.authorization
  if (typeof header !== 'string') return null
  const match = /^Bearer\s+(\S+)$/.exec(header)
  return match?.[1] ?? null
}

/**
 * Why a request for `platform` is not licensed, or null when it is (or licensing is off). The license
 * comes from the proxy's X-Holt-License header (proxy embedding) or the page (iframe embedding).
 */
function licenseRefusal(config: HoltConfig, platform: Platform, token: string | null | undefined): LicenseRefusal | null {
  if (!config.licensing) return null
  const check = checkLicense(config.licensing, platform.id, token)
  if (!check.ok) return check.reason
  // With a `bridge` key, the config is the license register: only a license listed for this platform counts.
  const registered = registeredLicenses(config.bridge, platform.id)
  if (registered === null) return null
  const lids = registered.map((t) => readLicense(config.licensing!.secret, t)?.lid).filter(Boolean)
  return lids.includes(check.license.lid) ? null : 'revoked'
}

const UNLICENSED_TEXT = 'This site is not licensed to embed this chat, or its license has expired or been revoked.'

function headerValue(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null
}

const CHAT_API_ORIGIN = { host: '127.0.0.1', port: 8831 }
const CHAT_API_PREFIX = '/_holt/api/discord/bridge/'
const RT_PATH = '/_holt/api/rt'
/** Hop-by-hop headers, holt's own license header, and a principal only holt-service may set never go upstream. */
const NOT_FORWARDED = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'x-holt-license', PRINCIPAL_HEADER, FOREIGN_PAGE_HEADER])
/** A proxy sign-in lasts this long; the page renews it every few minutes (embed/main.tsx). */
const PROXY_SESSION_TTL_SECONDS = 15 * 60
const WCS_COOKIE = /(?:^|;\s*)(wcs=[^;]*)/

/**
 * Who the caller is to holt-chat, as request headers. A platform on abulxt accounts: its own credentials
 * pass through (abulxt's identity.ts resolves them). Any other platform: only the holt session counts,
 * so its Authorization and Cookie are dropped (except the `wcs` seal seed) and the principal is signed.
 */
function callerHeaders(request: http.IncomingMessage, platform: Platform, config: HoltConfig, token: string | null): http.OutgoingHttpHeaders {
  if (usesSiteAccounts(platform)) return {}
  const out: http.OutgoingHttpHeaders = { authorization: undefined, cookie: undefined, [FOREIGN_PAGE_HEADER]: 'holt' }
  const wcs = WCS_COOKIE.exec(request.headers.cookie ?? '')
  if (wcs) out.cookie = wcs[1]
  const principal = token ? readSession(token, config.sessionSecret) : null
  if (principal && principal.platformId === platform.id) out[PRINCIPAL_HEADER] = signPrincipal(principal, config.sessionSecret)
  return out
}

function upstreamHeaders(request: http.IncomingMessage, caller: http.OutgoingHttpHeaders, keep: (name: string) => boolean): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined && keep(name)) headers[name] = value
  }
  for (const [name, value] of Object.entries(caller)) {
    if (value === undefined) delete headers[name]
    else headers[name] = value
  }
  headers.host = `${CHAT_API_ORIGIN.host}:${CHAT_API_ORIGIN.port}`
  return headers
}

/**
 * The chat API for a chat platform: /<id>/_holt/api/discord/bridge/* -> holt-chat /api/discord/bridge/*
 * (vite.chat.config.ts). Called after the license check. The platform's proxy set the client address
 * headers (X-Real-IP, X-Forwarded-For, CF-Connecting-IP); they pass through, because the bridge uses
 * them for IP bans and rate limits.
 */
function proxyChatApi(request: http.IncomingMessage, response: http.ServerResponse, upstreamPath: string, caller: http.OutgoingHttpHeaders): Promise<void> {
  return new Promise((resolve) => {
    const headers = upstreamHeaders(request, caller, (name) => !NOT_FORWARDED.has(name))
    const upstream = http.request({ ...CHAT_API_ORIGIN, method: request.method, path: upstreamPath, headers }, (answer) => {
      const out: http.OutgoingHttpHeaders = {}
      for (const [name, value] of Object.entries(answer.headers)) {
        if (value !== undefined && !NOT_FORWARDED.has(name)) out[name] = value
      }
      response.writeHead(answer.statusCode ?? 502, out)
      answer.pipe(response)
      answer.on('end', resolve)
    })
    upstream.on('error', (error) => {
      console.warn(`[holt] chat API unreachable: ${error.message}`)
      if (!response.headersSent) sendJson(response, 502, { error: 'The chat service is unavailable right now.' })
      else response.end()
      resolve()
    })
    request.pipe(upstream)
  })
}

/** A file of the compiled build, or null. Never index.html (only /embed serves it) and never outside dist. */
async function distFile(pathname: string): Promise<{ file: string; type: string } | null> {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  const file = path.resolve(DIST_DIR, '.' + decoded)
  if (!file.startsWith(DIST_DIR + path.sep) || path.basename(file) === 'index.html') return null
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()]
  if (!type) return null
  try {
    if (!(await stat(file)).isFile()) return null
  } catch {
    return null
  }
  return { file, type }
}

async function handle(request: http.IncomingMessage, response: http.ServerResponse, config: HoltConfig, shell: EmbedShell): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://holt.local')
  const method = request.method ?? 'GET'

  if (url.pathname === '/healthz') return sendText(response, 200, 'text/plain; charset=utf-8', 'ok')

  if (url.pathname === '/holt-embed.js') {
    if (method !== 'GET') return sendText(response, 405, 'text/plain; charset=utf-8', 'method not allowed')
    response.setHeader('Access-Control-Allow-Origin', '*')
    return sendText(response, 200, 'text/javascript; charset=utf-8', await readFile(LOADER_FILE), 'public, max-age=300')
  }

  if (url.pathname === '/embed') {
    if (method !== 'GET') return sendText(response, 405, 'text/plain; charset=utf-8', 'method not allowed')
    const platform = platformById(config.platforms, url.searchParams.get('platform') ?? '')
    if (!platform) return sendText(response, 404, 'text/plain; charset=utf-8', 'unknown platform')
    // License first: an unlicensed caller learns nothing about how a platform embeds.
    const refused = licenseRefusal(config, platform, url.searchParams.get('license'))
    if (refused) {
      console.warn(`[holt] ${platform.id}: embed refused (license ${refused})`)
      return sendText(response, 403, 'text/plain; charset=utf-8', UNLICENSED_TEXT)
    }
    if (platform.secret === null) return sendText(response, 404, 'text/plain; charset=utf-8', 'this platform embeds by proxy')
    // The browser enforces who may frame this page. X-Frame-Options is left out: CSP supersedes it.
    response.setHeader('Content-Security-Policy', embedCsp(platform, shell, 'iframe'))
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    return sendText(response, 200, 'text/html; charset=utf-8', pageHtml(shell, platform, 'iframe'))
  }

  if (url.pathname.startsWith('/api/')) {
    const platform = cors(request, response, config)
    if (method === 'OPTIONS') {
      response.statusCode = platform ? 204 : 403
      response.end()
      return
    }
    // The embed page itself is same-origin (no Origin header on GET; holt's own origin on POST).
    const sameOrigin = request.headers.origin === undefined || request.headers.origin === config.publicOrigin
    if (!platform && !sameOrigin) return sendJson(response, 403, { error: 'origin not allowed' })

    if (url.pathname === '/api/session') {
      if (method !== 'POST') return sendJson(response, 405, { error: 'method not allowed' })
      const body = await readJsonBody(request)
      if (!body) return sendJson(response, 400, { error: 'bad request' })
      const target = platformById(config.platforms, typeof body.platform === 'string' ? body.platform : '')
      if (!target) return sendJson(response, 404, { error: 'unknown platform' })
      // A page may only exchange tokens for the platform its origin belongs to.
      if (platform && platform.id !== target.id) return sendJson(response, 403, { error: 'origin belongs to another platform' })
      const refused = licenseRefusal(config, target, typeof body.license === 'string' ? body.license : null)
      if (refused) return sendJson(response, 403, { error: UNLICENSED_TEXT, code: 'unlicensed' })
      if (typeof body.token !== 'string' || !body.token) return sendJson(response, 400, { error: 'token is required' })
      let principal: Principal
      try {
        principal = verifyIdentityToken(body.token, target)
      } catch (error) {
        if (error instanceof IdentityTokenError) return sendJson(response, 401, { error: error.message })
        throw error
      }
      const now = Date.now()
      return sendJson(response, 200, {
        session: issueSession(principal, config.sessionSecret, now),
        expiresAt: now + SESSION_TTL_SECONDS * 1000,
        principal: publicPrincipal(principal, config),
        links: target.links,
      })
    }

    if (url.pathname === '/api/me') {
      if (method !== 'GET') return sendJson(response, 405, { error: 'method not allowed' })
      const token = bearer(request)
      const principal = token ? readSession(token, config.sessionSecret) : null
      if (!principal) return sendJson(response, 401, { error: 'session expired', code: 'token-expired' })
      const owner = platformById(config.platforms, principal.platformId)
      if (!owner) return sendJson(response, 401, { error: 'platform no longer configured' })
      return sendJson(response, 200, { principal: publicPrincipal(principal, config), links: owner.links })
    }

    return sendJson(response, 404, { error: 'not found' })
  }

  const proxied = PROXY_PATH.exec(url.pathname)
  const proxyPlatform = proxied ? platformById(config.platforms, proxied[1]!) : null
  if (proxied && proxyPlatform) {
    const rest = proxied[2] ?? ''
    // Everything under /<id>/ needs the platform's license, added by its proxy (the browser never has it).
    // Checked before anything else, so an unlicensed caller learns nothing about how a platform embeds.
    const refused = licenseRefusal(config, proxyPlatform, headerValue(request.headers['x-holt-license']))
    if (refused) {
      if (rest === '/' || rest === '') console.warn(`[holt] ${proxyPlatform.id}: proxy page refused (license ${refused})`)
      if (rest === '/_holt/me') return sendJson(response, 403, { error: UNLICENSED_TEXT, code: 'unlicensed' })
      return sendText(response, 403, 'text/plain; charset=utf-8', UNLICENSED_TEXT)
    }
    if (!proxyPlatform.userState) return sendText(response, 404, 'text/plain; charset=utf-8', 'this platform embeds by iframe')
    // `/<id>` without the slash: relative asset URLs would resolve one level too high. Absolute on holt's
    // origin, so nginx's default proxy_redirect turns it back into the platform's own `/chat/`.
    if (rest === '') {
      response.statusCode = 308
      response.setHeader('Location', `${config.publicOrigin}/${proxied[1]}/${url.search}`)
      response.end()
      return
    }
    if (rest === '/') {
      if (method !== 'GET' && method !== 'HEAD') return sendText(response, 405, 'text/plain; charset=utf-8', 'method not allowed')
      response.setHeader('Content-Security-Policy', embedCsp(proxyPlatform, shell, 'proxy'))
      // A platform page that is cross-origin isolated (abulxt sends COEP: credentialless for its in-browser
      // workspace) may only frame documents that send COEP too; without it the browser refuses the frame.
      // credentialless changes nothing for a page opened directly or framed by a site without COEP.
      response.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
      response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
      const homeGuild = config.bridge?.find((entry) => entry.platform === proxyPlatform.id)?.guild ?? null
      return sendText(response, 200, 'text/html; charset=utf-8', pageHtml(shell, proxyPlatform, 'proxy', homeGuild))
    }
    if (rest.startsWith(CHAT_API_PREFIX)) {
      if (!proxyPlatform.chat) return sendJson(response, 404, { error: 'not found' })
      const caller = callerHeaders(request, proxyPlatform, config, bearer(request))
      return proxyChatApi(request, response, `/api/discord/bridge/${rest.slice(CHAT_API_PREFIX.length)}${url.search}`, caller)
    }
    // A chat platform with its own accounts: the sign-in exchange and the chatbox's account endpoints.
    if (proxyPlatform.chat && !usesSiteAccounts(proxyPlatform) && (rest === '/_holt/session' || rest.startsWith('/_holt/api/'))) {
      return handleOwnAccounts(request, response, config, proxyPlatform, rest)
    }
    if (rest === '/_holt/me') {
      if (method !== 'GET') return sendJson(response, 405, { error: 'method not allowed' })
      // A cross-site page cannot set this header without a CORS preflight, which holt never answers here.
      if (request.headers['x-holt'] !== '1') return sendJson(response, 403, { error: 'missing X-Holt header' })
      response.setHeader('Vary', 'Cookie, Authorization')
      try {
        const principal = await principalFromPlatform(proxyPlatform, { cookie: request.headers.cookie, authorization: request.headers.authorization })
        return sendJson(response, 200, { principal: principal ? publicPrincipal(principal, config) : null, links: proxyPlatform.links })
      } catch (error) {
        if (!(error instanceof UserStateUnavailable)) throw error
        console.warn(`[holt] ${proxyPlatform.id} user state unavailable: ${error.message}`)
        return sendJson(response, 503, { error: 'Could not reach the site to check who you are.' })
      }
    }
    if (method === 'GET' || method === 'HEAD') {
      const found = await distFile(rest)
      if (found) return sendText(response, 200, found.type, await readFile(found.file), rest.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
    }
    return sendText(response, 404, 'text/plain; charset=utf-8', 'not found')
  }

  if (method === 'GET' || method === 'HEAD') {
    const found = await distFile(url.pathname)
    if (found) {
      // Emitted names are content hashes (check-dist-refs enforces it), so assets never change in place.
      const cache = url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
      return sendText(response, 200, found.type, await readFile(found.file), cache)
    }
  }

  sendText(response, 404, 'text/plain; charset=utf-8', 'not found')
}

/**
 * The sign-in exchange and the account endpoints the chatbox calls, for a chat platform with its own
 * accounts. Everything account-related (settings, email verification, sign-in) belongs to the platform:
 * the chatbox links there (platform.links), holt only says who is signed in.
 */
async function handleOwnAccounts(request: http.IncomingMessage, response: http.ServerResponse, config: HoltConfig, platform: Platform, rest: string): Promise<void> {
  const method = request.method ?? 'GET'
  response.setHeader('Cache-Control', 'private, no-store')
  if (rest === '/_holt/session') {
    if (method !== 'POST') return sendJson(response, 405, { error: 'method not allowed' })
    // A cross-site page cannot set this header without a CORS preflight, which holt never answers here.
    if (request.headers['x-holt'] !== '1') return sendJson(response, 403, { error: 'missing X-Holt header' })
    let principal: Principal | null
    try {
      principal = await principalFromPlatform(platform, { cookie: request.headers.cookie, authorization: request.headers.authorization })
    } catch (error) {
      if (!(error instanceof UserStateUnavailable)) throw error
      console.warn(`[holt] ${platform.id} user state unavailable: ${error.message}`)
      return sendJson(response, 503, { error: 'Could not reach the site to check who you are.' })
    }
    if (!principal) return sendJson(response, 200, { session: null, links: platform.links })
    const now = Date.now()
    return sendJson(response, 200, {
      session: issueSession(principal, config.sessionSecret, now, PROXY_SESSION_TTL_SECONDS),
      expiresAt: now + PROXY_SESSION_TTL_SECONDS * 1000,
      principal: publicPrincipal(principal, config),
      links: platform.links,
    })
  }
  const token = bearer(request)
  // Captcha (config + verify) is served by holt-chat's API guard, which gates the chat API's writes.
  if (rest.startsWith('/_holt/api/captcha/')) {
    const search = new URL(request.url ?? '/', 'http://holt.local').search
    return proxyChatApi(request, response, `${rest.slice('/_holt'.length)}${search}`, callerHeaders(request, platform, config, token))
  }
  const principal = token ? readSession(token, config.sessionSecret) : null
  const own = principal && principal.platformId === platform.id ? principal : null
  if (rest === '/_holt/api/auth/me') {
    if (method !== 'GET') return sendJson(response, 405, { error: 'method not allowed' })
    if (!own) return sendJson(response, 401, { error: 'Sign in to continue.' })
    // The chatbox's account shape (lib/auth-api.ts AbulxtUser). id 0: not an abulxt account; the chat
    // API identifies this user by their key, never by id.
    return sendJson(response, 200, {
      user: {
        id: 0, username: own.name, email: null, emailVerified: own.emailVerified, admin: false,
        createdAt: new Date(0).toISOString(), chatDisplayName: null, presenceStatus: null, discord: null,
        key: own.key, platform: platform.id,
      },
    })
  }
  if (!own) return sendJson(response, 401, { error: 'Sign in to continue.' })
  // Set Status: presence is tracked for abulxt accounts only; the choice is accepted and not stored.
  if (rest === '/_holt/api/auth/presence' && method === 'POST') return sendJson(response, 200, { status: 'online', shown: 'online' })
  if (rest === '/_holt/api/auth/resend-verification' && method === 'POST') {
    return sendJson(response, 400, { error: `Verify your email on ${platform.name}.`, verifyEmail: platform.links.verifyEmail ?? platform.links.account })
  }
  // Avatars are uploaded and moderated for abulxt accounts only; others show Discord's default (no upload).
  if (rest === '/_holt/api/avatars/me' && method === 'GET') return sendJson(response, 200, { active: null, latest: null })
  // The server rail layout (folders) is kept for abulxt accounts only; others get Discord's default order.
  if (rest === '/_holt/api/account/guild-folders') return sendJson(response, 200, { guildFolders: [] })
  return sendJson(response, 404, { error: 'not found' })
}

/**
 * WS /<id>/_holt/api/rt for a chat platform with its own accounts: license, then the caller (the holt
 * session the chatbox passes as ?token=), then a raw upgrade pass-through to holt-chat's /api/rt.
 */
function handleUpgrade(request: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer, config: HoltConfig): void {
  const refuse = (status: string) => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`) }
  const url = new URL(request.url ?? '/', 'http://holt.local')
  const proxied = PROXY_PATH.exec(url.pathname)
  const platform = proxied ? platformById(config.platforms, proxied[1]!) : null
  if (!proxied || !platform || proxied[2] !== RT_PATH) return refuse('404 Not Found')
  if (licenseRefusal(config, platform, headerValue(request.headers['x-holt-license']))) return refuse('403 Forbidden')
  if (!platform.chat || !platform.userState || usesSiteAccounts(platform)) return refuse('404 Not Found')
  const caller = callerHeaders(request, platform, config, url.searchParams.get('token'))
  // The token stays here: holt-chat gets the signed principal instead.
  const keep = (name: string) => name !== 'host' && name !== 'x-holt-license' && name !== PRINCIPAL_HEADER && name !== FOREIGN_PAGE_HEADER
  const upstream = http.request({ ...CHAT_API_ORIGIN, method: 'GET', path: '/api/rt', headers: upstreamHeaders(request, caller, keep) })
  upstream.on('upgrade', (answer, upstreamSocket, upstreamHead) => {
    let raw = `HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}\r\n`
    for (let i = 0; i < answer.rawHeaders.length; i += 2) raw += `${answer.rawHeaders[i]}: ${answer.rawHeaders[i + 1]}\r\n`
    socket.write(raw + '\r\n')
    if (upstreamHead.length) socket.write(upstreamHead)
    if (head.length) upstreamSocket.write(head)
    upstreamSocket.pipe(socket).pipe(upstreamSocket)
    const close = () => { socket.destroy(); upstreamSocket.destroy() }
    socket.on('error', close)
    upstreamSocket.on('error', close)
    socket.on('close', close)
    upstreamSocket.on('close', close)
  })
  upstream.on('response', (answer) => {
    refuse(`${answer.statusCode ?? 502} ${answer.statusMessage ?? 'Bad Gateway'}`)
    answer.resume()
  })
  upstream.on('error', (error) => {
    console.warn(`[holt] realtime unreachable: ${error.message}`)
    refuse('502 Bad Gateway')
  })
  socket.on('error', () => upstream.destroy())
  upstream.end()
}

async function main(): Promise<void> {
  const config = await loadConfig()
  const shell = loadEmbedShell()
  const server = http.createServer((request, response) => {
    handle(request, response, config, shell).catch((error: unknown) => {
      console.error('[holt] request failed:', error instanceof Error ? error.message : error)
      if (!response.headersSent) sendJson(response, 500, { error: 'internal error' })
      else response.end()
    })
  })
  server.on('upgrade', (request, socket, head) => {
    try {
      handleUpgrade(request, socket, head, config)
    } catch (error) {
      console.error('[holt] upgrade failed:', error instanceof Error ? error.message : error)
      socket.destroy()
    }
  })
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`[holt] listening on 127.0.0.1:${config.port} for ${config.platforms.map((p) => p.id).join(', ')} (${shell.scriptHashes.length} inline script hash(es))`)
  })
  const shutdown = (signal: string) => {
    console.log(`[holt] ${signal}: shutting down`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((error: unknown) => {
  console.error('[holt] fatal:', error instanceof Error ? error.message : error)
  process.exit(1)
})
