// Rules for the custom AI endpoint sent on each chat request (send-route.ts).
// Pure checks plus one DNS lookup. Nothing here stores or logs a value: the
// endpoint, model, thinking level and key all arrive per request and live only
// for that call.
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'max'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

const MODEL_ID = /^[A-Za-z0-9._/:@-]{1,100}$/
const PROVIDER_KEY = /^[\x21-\x7e]{1,512}$/
const MAX_BASE_URL_LENGTH = 2048
// Names that point at this machine or at an internal network.
const INTERNAL_HOST = /(^|\.)(localhost|localdomain|local|internal|intranet|lan|corp|home\.arpa)$/

export interface CustomEndpoint {
  baseUrl: string
  /** The address the connection is pinned to (the first DNS answer; all answers are public). */
  address: string
  family: 4 | 6
}

export type Check<T> = { ok: true; value: T } | { ok: false; error: string }

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

export function isThinking(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value)
}

// ---- Address classes -------------------------------------------------------

/** Public unicast IPv4: everything except the reserved, private and special ranges. */
export function isPublicIPv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b, c] = parts
  if (a === 0 || a === 10 || a === 127) return false // this network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false // carrier-grade NAT
  if (a === 169 && b === 254) return false // link-local (includes the cloud metadata address)
  if (a === 172 && b >= 16 && b <= 31) return false // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false // IETF protocol assignments, TEST-NET-1
  if (a === 192 && b === 168) return false // private
  if (a === 198 && (b === 18 || b === 19)) return false // benchmarking
  if (a === 198 && b === 51 && c === 100) return false // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false // TEST-NET-3
  if (a >= 224) return false // multicast, reserved, broadcast
  return true
}

/** Expands an IPv6 address into eight 16-bit groups, or null when it does not parse. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase()
  const embedded = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (embedded) {
    const octets = embedded[1].split('.').map(Number)
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
    text = `${text.slice(0, -embedded[1].length)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  let groups: string[]
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length
    if (fill < 0) return null
    groups = [...head, ...new Array<string>(fill).fill('0'), ...tail]
  } else {
    groups = head
  }
  if (groups.length !== 8) return null
  const numbers = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN))
  return numbers.some((n) => Number.isNaN(n)) ? null : numbers
}

/**
 * Public IPv6 is global unicast (2000::/3) minus documentation, Teredo and 6to4.
 * Mapped, NAT64, loopback, link-local, unique-local and multicast all sit
 * outside 2000::/3, so they are refused by the first test.
 */
export function isPublicIPv6(address: string): boolean {
  const g = ipv6Groups(address)
  if (!g) return false
  if ((g[0] & 0xe000) !== 0x2000) return false
  if (g[0] === 0x2002) return false // 6to4
  if (g[0] === 0x2001 && g[1] === 0x0000) return false // Teredo
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false // documentation
  return true
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isPublicIPv4(address)
  if (family === 6) return isPublicIPv6(address)
  return false
}

// ---- Custom endpoint -------------------------------------------------------

/** Syntax only (no DNS): https, a host name, no credentials, no query or fragment. */
export function checkBaseUrlSyntax(raw: unknown): Check<{ baseUrl: string; host: string }> {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text || text.length > MAX_BASE_URL_LENGTH) return fail('Enter a base URL of up to 2048 characters.')
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return fail('The base URL is not a valid address.')
  }
  if (url.protocol !== 'https:') return fail('The base URL must start with https://.')
  if (url.username || url.password) return fail('The base URL cannot contain a username or password.')
  if (url.search || url.hash) return fail('The base URL cannot contain a query string or fragment.')
  if (url.hostname.startsWith('[') || isIP(url.hostname)) return fail('Use a host name, not an IP address.')
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!host.includes('.') || INTERNAL_HOST.test(host)) return fail('That host name is not allowed.')
  const path = url.pathname.replace(/\/+$/, '')
  return { ok: true, value: { baseUrl: `${url.origin}${path}`, host } }
}

/**
 * Syntax plus DNS. Every address the host resolves to must be public. The
 * first one is returned so the connection can be pinned to it (pinned-post.ts).
 */
export async function checkCustomEndpoint(raw: unknown): Promise<Check<CustomEndpoint>> {
  const syntax = checkBaseUrlSyntax(raw)
  if (!syntax.ok) return syntax
  let records: Array<{ address: string; family: number }>
  try {
    records = await lookup(syntax.value.host, { all: true, verbatim: true })
  } catch {
    return fail('That host name could not be resolved.')
  }
  if (!records.length || !records.every((r) => isPublicAddress(r.address))) {
    return fail('That host name points to a private, loopback, link-local or reserved address.')
  }
  return {
    ok: true,
    value: {
      baseUrl: syntax.value.baseUrl,
      address: records[0].address,
      family: records[0].family === 6 ? 6 : 4,
    },
  }
}

/** One model id. Error text never includes the value. */
export function checkModelId(raw: unknown): Check<string> {
  const id = typeof raw === 'string' ? raw.trim() : ''
  if (!id) return fail('Choose a model for the custom endpoint.')
  if (!MODEL_ID.test(id)) return fail('Model ids are 1 to 100 characters: letters, digits, and . _ / : @ -.')
  return { ok: true, value: id }
}

/** Shape only. The value is never stored, logged or echoed back. */
export function checkProviderKey(raw: unknown): Check<string> {
  const key = typeof raw === 'string' ? raw.trim() : ''
  if (!PROVIDER_KEY.test(key)) return fail('That API key format is not valid.')
  return { ok: true, value: key }
}
