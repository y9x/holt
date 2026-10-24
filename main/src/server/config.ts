import { existsSync } from 'node:fs'
import path from 'node:path'
import dns from 'node:dns'
import { pathToFileURL, fileURLToPath } from 'node:url'

try {
  dns.setDefaultResultOrder('ipv4first')
} catch {  }

export type AiEndpoint = 'chat-completions' | 'responses' | 'messages' | 'gemini' | 'cloudflare-playground'

export interface AiProviderConfig {
  baseUrl: string
  apiKey?: string
  model: string
  endpoint?: AiEndpoint

  auth?: 'api-key' | 'gcloud'
}

/** One Abstract AI catalogue model (config.ai.models). multiplier is the metering weight per token. */
export interface AbstractModelConfig {
  id: string
  multiplier: number
  enabled: boolean
}

/** One Abstract AI relay upstream (config.ai.upstreams, read by src/server/abstract-relay/). */
export interface AbstractUpstreamConfig {
  name?: string
  baseUrl: string
  apiKey: string
  protocol?: 'openai' | 'anthropic'
  priority?: number
  enabled?: boolean
  /** true = a provider we resell and charge for (Abstract AI plans); false = a free provider. */
  paid: boolean
  /**
   * true = chat-only: the models from GET {baseUrl}/models appear in the chat interface and are never
   * relayed on /v1. Excluded from every relay candidate list. Default false.
   */
  chatOnly?: boolean
}

export interface AbulxtConfig {
  configName?: string
  db?: { url: string }
  stripe?: {
    secretKey: string
    webhookSecret: string
    /** Abstract AI billing portal (bpc_...). Unset means the Abstract portal is refused. */
    portalConfiguration?: string
    /** abstract_<plan>_<month|year> (Abstract AI). */
    prices: { [key: `abstract_${string}`]: string | undefined }

    sandbox?: {
      secretKey: string
      webhookSecret: string
      prices: { [key: `abstract_${string}`]: string | undefined }
    }
  }
  ai?: {
    free?: AiProviderConfig
    premium?: AiProviderConfig

    vertex?: AiProviderConfig
    limits?: {
      perMinute?: number
      guestRequestsTotal?: number
      freeRequestsPerDay?: number
      freeTokensPerDay?: number
      freeContextTokens?: number
    }

    search?: {

      enabled?: boolean

      egressProxy?: string
      safeSearch?: 'strict' | 'moderate' | 'off'
      region?: string
      searchRpm?: number
      fetchRpm?: number

      maxSteps?: number

      allowPrivateUrls?: boolean
    }

    /** Cloudflare AI Playground provider (anonymous WS agent). */
    cloudflare?: {
      /** Set false to hide/disable playground routing. Default true. */
      enabled?: boolean
      /** Public alias used when model is auto and free provider is absent. */
      defaultModel?: string
    }

    /**
     * Public MCP endpoint wrapping WebSearchTools for playground Durable Objects.
     * `publicUrl` must be reachable from the internet (e.g. https://host/api/mcp/ddg).
     */
    mcp?: {
      apiKey?: string
      publicUrl?: string
    }

    /** Abstract AI relay upstreams (src/server/abstract-relay/), tried in priority order. */
    upstreams?: AbstractUpstreamConfig[]
    /** Abstract AI model catalogue (src/server/abstract-relay/models.ts). Only enabled entries are routable. */
    models?: AbstractModelConfig[]
  }
  ads?: {
    key?: string
    zones?: {
      banner?: string
      preroll?: string
      socialbar?: string
      popunder?: string
      smartlink?: string
      adcash?: string
    }
    prerollSeconds?: number
    /** Adcash publisher API token (admin dashboard only; never sent to clients). */
    adcashApiToken?: string
    /** Adsterra publisher API key (admin dashboard only; never sent to clients). */
    adsterraApiKey?: string
  }

  mail?: {
    host?: string
    port?: number
    secure?: boolean
    from?: string

    auth?: { user?: string; pass?: string }

    publicOrigin?: string
  }

  captcha?: {
    enabled?: boolean

    provider?: 'turnstile' | 'hcaptcha'
    secret?: string

    secrets?: string[]
    sitekey?: string

    sitekeys?: string[]
  }

  webauthn?: {
    rpID?: string
    rpName?: string
    origin?: string
  }

  cloudflare?: {
    apiKey?: string
    email?: string

    zones?: string[]
  }

  domains?: {

    port?: number

    loadBalancerIp?: string[]

    zoneCacheTtlSeconds?: number

    allowedAmphDomains?: string[]

    dnsCacheTtlSeconds?: number
  }

  watchdog?: {
    enabled?: boolean

    gcoreApiToken?: string

    zone?: string

    fqdn?: string

    ttl?: number

    intervalSeconds?: number

    failThreshold?: number

    passThreshold?: number

    minHealthy?: number

    nullRoutePingTarget?: string

    httpTimeoutMs?: number

    edges?: Array<{
      name: string
      sshHost: string
      ips: string[]
      ipsV6?: string[]
    }>
  }

  discord?: {

    botToken?: string

    clientId?: string
    clientSecret?: string

    /** Verification-bot OAuth redirect (anti-alt). */
    redirectUri?: string

    /**
     * Stable account-link OAuth redirect. Must be registered in the Discord
     * developer portal. Prefer a single production origin so cloaked hosts
     * can all share one redirect URI.
     * Example: https://abstracteducation.loan/api/account/discord/callback
     */
    accountRedirectUri?: string

    /** Optional extras registered in Discord; used as fallbacks when probing. */
    accountRedirectUris?: string[]

    guildId?: string

    salt?: string

    webhookUrl?: string

    port?: number

    reconcileIntervalMinutes?: number

    // Guild text channel IDs mirrored to the site chatbox (community bridge).
    // Legacy per-channel list; still bridged alongside bridgeCategories.
    bridgeChannels?: string[]

    // Discord category channel IDs (any guild the bot is in). Every text /
    // announcement channel inside a listed category is bridged automatically,
    // including channels created or moved in later; channels moved out or
    // deleted are disabled (history kept). guildId stays the HOME guild
    // (verification, entitlement roles, /ai, account link).
    bridgeCategories?: string[]

    roleIds?: {

      member?: string

      /** Granted whenever a Discord ID is linked (holt / community role). */
      holt?: string

      verified?: string[]

      alt?: string

      muted?: string
    }

    // Maps Discord guild roles to chat permission tiers (member/mod/admin/owner).
    // Chat admin (tier >= admin) gates chatbox commands and webhook-permission
    // management. This is independent of site admin. Any role id listed here is
    // also synced into discord_bridge_chat_role on startup.
    chatRoles?: {
      member?: string[]   // role ids that can chat (default: everyone verified)
      mod?: string[]      // chatbox moderation commands
      admin?: string[]    // chat admin: manage webhook permissions, all commands
      owner?: string[]    // webhook owner: full control incl. granting chat admin
    }

    // Site chatbox bridge tuning.
    bridge?: {
      // Anti-abuse ping limits (discord-mention-limits.ts; every field
      // optional, defaults in DEFAULT_MENTION_LIMITS). perMessage = AutoMod
      // mention-spam block (unique user+role mentions; admins exempt); the
      // window budgets make excess pings inert instead of rejecting.
      mentionLimits?: {
        perMessage?: number
        windowSeconds?: number
        pingsPerWindow?: number
        staffPingsPerWindow?: number
        everyoneWindowSeconds?: number
        everyonePerWindow?: number
        adminEveryonePerWindow?: number
        targetWindowSeconds?: number
        perTargetPerWindow?: number
      }
    }
  }
  // /api/* response obfuscation (api-crypto.ts). Seals eligible JSON responses
  // under the per-session `wcs` seed for clients that negotiate it. Default OFF;
  // un-negotiated / cookie-less clients always get plaintext. See PLAN-API.md.
  apiCrypto?: {
    /** Seal eligible /api/* JSON responses for negotiating clients. Default false. */
    enabled?: boolean
  }
  // /api/rt realtime WebSocket frame encryption (rt-crypto-codec.ts). Seals rt
  // frames under the per-session `wcs` seed (label abulxt-rt-cloak/v1) for
  // clients that negotiate the derived subprotocol. Default OFF; un-negotiated /
  // cookie-less clients stay plaintext.
  rtCrypto?: {
    /** Seal /api/rt frames for negotiating clients. Default false. */
    enabled?: boolean
    /** Length-bucket padding in bytes (must match the client; keep 0 for realtime). */
    padding?: number
  }
  allowedOrigins?: string[]
  media?: { apiBase?: string; resolverPath?: string }
  /** Local `vite` dev only. `vpsSsh` (an ssh target, e.g. "root@prod") makes
   * the dev server open an SSH tunnel to the VPS on start so music works
   * locally; env ABULXT_VPS_SSH / ABULXT_VPS_FORWARDS / MUSIC_UPSTREAM win. */
  dev?: { vpsSsh?: string; vpsForwards?: string; musicUpstream?: string }
  cloaksDir?: string

  gateKeys?: {
    wisp?: string
    /** The relay URL path segment that precedes the gate key, so the route is
     *  not literally the word wisp on the wire. Non-secret but obfuscating; empty falls back to
     *  `stream`. Must match the edge/origin OpenResty location and the client. */
    wispPath?: string
    gatewayToken?: string
    [key: string]: string | undefined
  }
  klipy?: {
    // KLIPY app key. Exposed to the signed-in, embed-permitted web client so
    // GIF/sticker requests originate from the end-user's browser (required by
    // KLIPY's standard integration terms - no server-side proxying).
    apiKey?: string
  }
  avatars?: {
    // Public origin used to build absolute avatar URLs (Discord webhook
    // avatar_url needs one). Falls back to mail.publicOrigin.
    publicOrigin?: string
    // AI catalog id used for image moderation (default gemini-3.8-flash-high).
    moderationModel?: string
    moderationTimeoutMs?: number
    uploadsPerHour?: number
    rejectCooldownMinutes?: number
  }
  client?: {
    apiBase?: string
    /** Ordered absolute API backends for static/CDN builds (failover). */
    apiBases?: string[]
    wispUrl?: string
    /** Relay path segment (mirrors gateKeys.wispPath) and gate key, so the
     *  same-origin/local relay URL is built as /<wispPath>/<wispKey>/. The key
     *  already ships inside wispUrl, so this adds no new exposure. */
    wispPath?: string
    wispKey?: string
    /** Hosts that serve the same relay path directly (the edge apex, not
     *  behind Cloudflare). The browser races them against wispUrl and keeps
     *  the fastest one that answers; [] disables the race. */
    wispDirectHosts?: string[]
    /** Per-site relay hostnames for nearest-site routing. Each host's DNS
     *  must point at ONE edge site (DNS-only). `id` ashburn / chicago /
     *  losangeles / santaclara carry built-in coordinates; other sites need
     *  lat/lon. [] (default) keeps the plain RTT race over wispDirectHosts. */
    relaySites?: Array<{ id: string; host: string; city?: string; lat?: number; lon?: number }>

    huGamesBase?: string
    moviesUrl?: string
    mediaApiBase?: string
    enableSplash?: boolean
    sjHost?: string
  }
}

const DEFAULTS: AbulxtConfig = {
  configName: 'defaults',
  ai: {
    limits: {
      perMinute: 30,
      guestRequestsTotal: 4,
      freeRequestsPerDay: 40,
      freeTokensPerDay: 500000,
      freeContextTokens: 8000,
    },
  },
  ads: {
    key: '427133cdb2bc5dec94ac6f7e840c3efc',
    zones: {
      banner: '427133cdb2bc5dec94ac6f7e840c3efc',
      preroll: '427133cdb2bc5dec94ac6f7e840c3efc',
      socialbar: '',
      popunder: '',
      smartlink: 'https://asiafilm.org/4/a4efa29c4f6554a1805aa4e06ef7f352',
      adcash: '',
    },
    prerollSeconds: 3,
    adcashApiToken: '',
    adsterraApiKey: '',
  },

  mail: { host: '', port: 25, secure: false, from: 'noreply@caan.edu', publicOrigin: '' },
  captcha: { enabled: false, provider: 'hcaptcha', secret: '', secrets: [], sitekey: '', sitekeys: [] },
  webauthn: { rpID: '', rpName: 'Abstract', origin: '' },
  cloudflare: { apiKey: '', email: '', zones: [] },
  domains: {
    port: 8822,
    loadBalancerIp: ['45.82.161.87'],
    zoneCacheTtlSeconds: 600,
    allowedAmphDomains: [],
    dnsCacheTtlSeconds: 60,
  },

  discord: { port: 8823, reconcileIntervalMinutes: 60, bridgeChannels: [], bridgeCategories: [], roleIds: { verified: [] }, chatRoles: { member: [], mod: [], admin: [], owner: [] } },
  apiCrypto: { enabled: true },
  rtCrypto: { enabled: true, padding: 0 },
  allowedOrigins: [],
  media: { apiBase: '/api/media', resolverPath: 'yt-dlp' },
  cloaksDir: '../cloaks',
  gateKeys: { wisp: '', wispPath: '', gatewayToken: '' },
  klipy: { apiKey: '' },
  avatars: { publicOrigin: '', moderationModel: 'gemini-3.8-flash-high', moderationTimeoutMs: 60_000, uploadsPerHour: 5, rejectCooldownMinutes: 10 },
  client: {
    apiBase: '',
    wispUrl: '',
    // The edge fleet's DNS-only apex: its relay skips the Cloudflare leg
    // (measured ~2x throughput, ~3x lower request latency). Clean streams
    // exit from the edges and shady ones via Mullvad, never from the origin.
    wispDirectHosts: ['byod.abstracteducation.loan'],
    huGamesBase: '',
    moviesUrl: 'https://shuttletv.pk/',
    mediaApiBase: '/api/media',
    enableSplash: false,
  },
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function merge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : (override as T))
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in out ? merge(out[key], value) : value
  }
  return out as T
}

const configDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

async function importConfigFile(name: string): Promise<AbulxtConfig | null> {
  const file = path.join(configDir, name)
  if (!existsSync(file)) return null
  const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`)
  return (mod.abulxtConfig || mod.default || null) as AbulxtConfig | null
}

let cached: AbulxtConfig | null = null

export async function loadConfig(force = false): Promise<AbulxtConfig> {
  if (cached && !force) return cached
  let config: AbulxtConfig = merge(DEFAULTS, {})
  const base = await importConfigFile('config.js')
  if (base) config = merge(config, base)
  const deploy = (process.env.ABULXT_CONFIG || '').trim()
  if (deploy) {
    const override = await importConfigFile(`config.${deploy}.js`)
    if (override) config = merge(config, override)
  }

  const envWispKey = (process.env.WISP_GATE_KEY || process.env.LIGHTSPEED_GATE_KEY || '').trim()
  if (envWispKey && !config.gateKeys?.wisp) {
    config.gateKeys = { ...config.gateKeys, wisp: envWispKey }
  }
  const envWispUrl = (process.env.VITE_WISP_URL || process.env.WISP_URL || '').trim()
  if (envWispUrl && !config.client?.wispUrl) {
    config.client = config.client || {}
    config.client.wispUrl = envWispUrl
  }
  if (process.env.VITE_API_BASE) {
    config.client = config.client || {}
    config.client.apiBase = process.env.VITE_API_BASE
  }
  if (process.env.VITE_API_BASES) {
    config.client = config.client || {}
    const bases = String(process.env.VITE_API_BASES)
      .split(/[\s,]+/)
      .map((value) => value.trim().replace(/\/$/, ''))
      .filter(Boolean)
    if (bases.length) config.client.apiBases = bases
  }
  if (process.env.VITE_HU_GAMES_BASE) {
    config.client = config.client || {}
    config.client.huGamesBase = process.env.VITE_HU_GAMES_BASE
  }
  if (process.env.VITE_WISP_URL) {
    config.client = config.client || {}
    config.client.wispUrl = process.env.VITE_WISP_URL
  }
  if (process.env.VITE_SJ_HOST) {
    config.client = config.client || {}
    config.client.sjHost = process.env.VITE_SJ_HOST
  }
  if (process.env.VITE_MEDIA_API_BASE) {
    config.client = config.client || {}
    config.client.mediaApiBase = process.env.VITE_MEDIA_API_BASE
  }
  if (process.env.VITE_MOVIES_URL) {
    config.client = config.client || {}
    config.client.moviesUrl = process.env.VITE_MOVIES_URL
  }
  if (process.env.VITE_ENABLE_SPLASH !== undefined) {
    config.client = config.client || {}
    config.client.enableSplash = process.env.VITE_ENABLE_SPLASH === '1' || process.env.VITE_ENABLE_SPLASH === 'true'
  }

  // Relay path: `/<wispPath>/<key>/`. The segment is never the word "wisp" on
  // the wire (default `stream`). The key is also exposed to the client so the
  // same-origin relay URL is keyed too; it already ships inside wispUrl.
  const wispPath = String(config.gateKeys?.wispPath || 'stream').replace(/^\/+|\/+$/g, '') || 'stream'
  config.client = config.client || {}
  config.client.wispPath = wispPath
  config.client.wispKey = config.gateKeys?.wisp || ''
  const wispUrlIsBarePlaceholder = !config.client.wispUrl
    || /\/wisp\//.test(config.client.wispUrl)
  if (config.gateKeys?.wisp && wispUrlIsBarePlaceholder) {
    config.client.wispUrl = `wss://mathewteachesalgebra.site/${wispPath}/${config.gateKeys.wisp}/`
  } else if (config.client.wispUrl && !config.gateKeys?.wisp) {
    const seg = wispPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = config.client.wispUrl.match(new RegExp(`/${seg}/([a-f0-9]+)`, 'i'))
    if (match) {
      config.gateKeys = { ...config.gateKeys, wisp: match[1] }
      config.client.wispKey = match[1]
    }
  }
  warnOnTestCaptchaKeys(config)
  cached = config
  return config
}

export function getConfig(): AbulxtConfig {
  if (!cached) throw new Error('Config not loaded yet; await loadConfig() first')
  return cached
}

function warnOnTestCaptchaKeys(config: AbulxtConfig) {
  const captcha = config.captcha
  if (!captcha?.enabled) return
  const values = [captcha.secret, ...(captcha.secrets || []), captcha.sitekey, ...(captcha.sitekeys || [])]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
  if (!values.some((value) => /^[123]x00000000000000000000/.test(value))) return
  console.warn('[captcha] Cloudflare test keys are configured, so every captcha verification passes. Replace them with real Turnstile sitekey/secret values before deploying.')
}

export function publicClientConfig(config: AbulxtConfig) {
  const raw = { ...(config.client || {}) } as Record<string, unknown>

  // Public HTML must not ship the tokens `wisp` / `ultraviolet` - scanners key
  // off those names in #abulxt-config. Emit neutral relay* keys only.
  const relayUrl = String(raw.relayUrl || raw.wispUrl || '')
  const relayPath = String(raw.relayPath || raw.wispPath || config.gateKeys?.wispPath || 'stream').replace(/^\/+|\/+$/g, '') || 'stream'
  const relayKey = String(raw.relayKey || raw.wispKey || config.gateKeys?.wisp || '')
  const relayHosts = (raw.relayHosts || raw.wispDirectHosts || []) as string[]

  const client: Record<string, unknown> = {
    apiBase: raw.apiBase || '',
    apiBases: raw.apiBases,
    moviesUrl: raw.moviesUrl,
    mediaApiBase: raw.mediaApiBase,
    enableSplash: raw.enableSplash,
    sjHost: raw.sjHost,
    huGamesBase: raw.huGamesBase,
    mainWebsite: raw.mainWebsite,
    isMainWebsite: raw.isMainWebsite,
    // Neutral names only (no "wisp*" / "uv*" keys on the wire).
    relayUrl,
    relayPath,
    relayKey,
    relayHosts,
    relaySites: raw.relaySites,
    captchaSitekey: config.captcha?.enabled
      ? (config.captcha?.sitekey || config.captcha?.sitekeys?.[0] || '')
      : '',
    captchaProvider: config.captcha?.enabled ? captchaProviderOf(config) : '',
    // The chat view is holt's chatbox (an iframe of /chat/) unless client.holtChat is false.
    holtChat: raw.holtChat !== false,
  }

  // Drop empties so the embedded JSON stays small.
  for (const [k, v] of Object.entries(client)) {
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) delete client[k]
  }
  return client
}

export function captchaProviderOf(config: AbulxtConfig): 'turnstile' | 'hcaptcha' {
  const raw = String(config.captcha?.provider || '').trim().toLowerCase()
  return raw === 'turnstile' ? 'turnstile' : 'hcaptcha'
}
