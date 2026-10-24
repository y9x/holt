

export interface ClientConfig {
  apiBase?: string;
  /** Ordered absolute API backends for static/CDN builds (failover). */
  apiBases?: string[];
  /** Neutral relay URL (preferred). Legacy `wispUrl` still accepted if present. */
  relayUrl?: string;
  wispUrl?: string;
  /** Path segment for same-origin relay (`/<relayPath>/<relayKey>/`). */
  relayPath?: string;
  wispPath?: string;
  relayKey?: string;
  wispKey?: string;
  /** Direct (non-Cloudflare) relay hosts raced against relayUrl. */
  relayHosts?: string[];
  wispDirectHosts?: string[];
  /** Relay hostnames that each reach ONE edge site, for nearest-site routing. */
  relaySites?: RelaySiteConfig[];
  moviesUrl?: string;
  mediaApiBase?: string;
  enableSplash?: boolean;
  sjHost?: string;

  captchaSitekey?: string;

  captchaProvider?: string;

  huGamesBase?: string;

  ecKey?: string;

  mainWebsite?: string;
  isMainWebsite?: boolean;

  /** The chat view is holt's chatbox (iframe of /chat/). false renders the built-in chatbox. */
  holtChat?: boolean;
}

/** Prefer neutral relay* keys; fall back to legacy wisp* for old embeds. */
export function relayUrlOf(cfg: ClientConfig = clientConfig()): string {
  return String(cfg.relayUrl || cfg.wispUrl || '').trim()
}

export function relayPathOf(cfg: ClientConfig = clientConfig()): string {
  const raw = String(cfg.relayPath || cfg.wispPath || 'stream').replace(/^\/+|\/+$/g, '')
  return raw || 'stream'
}

export function relayKeyOf(cfg: ClientConfig = clientConfig()): string {
  return String(cfg.relayKey || cfg.wispKey || '').trim()
}

export interface RelaySiteConfig {
  /** Site id; the four edge sites have built-in coordinates (relay-geo.ts). */
  id: string;
  /** Hostname whose DNS points at this site only (DNS-only, not proxied). */
  host: string;
  city?: string;
  lat?: number;
  lon?: number;
}

export function relaySitesOf(cfg: ClientConfig = clientConfig()): RelaySiteConfig[] {
  const sites = Array.isArray(cfg.relaySites) ? cfg.relaySites : []
  return sites.filter((s): s is RelaySiteConfig => !!s && typeof s.id === 'string' && typeof s.host === 'string' && s.host.trim().length > 0)
}

export function relayHostsOf(cfg: ClientConfig = clientConfig()): string[] {
  const hosts = cfg.relayHosts || cfg.wispDirectHosts || []
  return Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === 'string' && h.trim().length > 0) : []
}

let cached: ClientConfig | null = null;

let capturedShadowRoot: ShadowRoot | undefined;

/**
 * Take the cloak shadow root that uncloak-client.js hands over on `window`,
 * then remove the global so it is not left exposed to other same-page scripts
 * (A6). The first caller captures it; later callers reuse the cached value.
 */
export function getCloakShadowRoot(): ShadowRoot | undefined {
  if (typeof window === "undefined") return capturedShadowRoot;
  const holder = window as unknown as { __ABULXT_SHADOW_ROOT__?: ShadowRoot };
  if (holder.__ABULXT_SHADOW_ROOT__) {
    capturedShadowRoot = holder.__ABULXT_SHADOW_ROOT__;
    try {
      delete holder.__ABULXT_SHADOW_ROOT__;
    } catch {
      holder.__ABULXT_SHADOW_ROOT__ = undefined;
    }
  }
  return capturedShadowRoot;
}

function readEmbedded(): ClientConfig {
  if (typeof document === "undefined") return {};
  const shadowRoot = getCloakShadowRoot();
  const el = shadowRoot?.getElementById("abulxt-config") || shadowRoot?.querySelector("#abulxt-config") || document.getElementById("abulxt-config");
  if (!el?.textContent) return {};
  try {
    return JSON.parse(el.textContent) as ClientConfig;
  } catch {
    return {};
  }
}

// Only a config that was actually found is cached: a read before the cloak has
// mounted its #abulxt-config would otherwise pin `{}` for the whole session
// (no API bases, every API URL relative to the static host).
function current(): ClientConfig {
  if (cached) return cached;
  const found = readEmbedded();
  if (Object.keys(found).length) cached = found;
  return found;
}

export async function loadClientConfig(): Promise<ClientConfig> {
  return current();
}

export function clientConfig(): ClientConfig {
  return current();
}

export function isMainDomain(): boolean {
  const cfg = clientConfig();
  if (typeof cfg.isMainWebsite === "boolean") {
    return cfg.isMainWebsite;
  }
  if (typeof window === "undefined") return true;
  const host = window.location.hostname;
  if (cfg.mainWebsite && host === cfg.mainWebsite) return true;
  if (("." + host).endsWith(".abstracteducation.loan")) {
    return true;
  }
  return false;
}
