

export type Geo = { city: string | null; region: string | null; country: string | null }

const geoCache = new Map<string, { at: number; geo: Geo }>()
const GEO_TTL_MS = 6 * 60 * 60 * 1000

function isPrivateIp(ip: string): boolean {
  return (
    ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.') ||
    ip.startsWith('10.') || ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || ip.startsWith('fc') || ip.startsWith('fe80')
  )
}

export async function geoForIp(ip: string | null): Promise<Geo> {
  const empty: Geo = { city: null, region: null, country: null }
  if (!ip || isPrivateIp(ip)) return empty
  const cached = geoCache.get(ip)
  if (cached && Date.now() - cached.at < GEO_TTL_MS) return cached.geo
  try {
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,city,regionName,country`, {
      signal: AbortSignal.timeout(3000),
    })
    const data = (await res.json()) as { status?: string; city?: string; regionName?: string; country?: string }
    const geo: Geo = data.status === 'success'
      ? { city: data.city || null, region: data.regionName || null, country: data.country || null }
      : empty
    geoCache.set(ip, { at: Date.now(), geo })
    return geo
  } catch {
    return empty
  }
}

export function deviceFromUA(ua: string | null | undefined): string | null {
  if (!ua) return null
  const s = ua

  let os = ''
  if (/windows nt 10/i.test(s)) os = 'Windows'
  else if (/windows nt/i.test(s)) os = 'Windows'
  else if (/android/i.test(s)) os = 'Android'
  else if (/iphone|ipod/i.test(s)) os = 'iPhone'
  else if (/ipad/i.test(s)) os = 'iPad'
  else if (/mac os x/i.test(s)) os = 'macOS'
  else if (/cros/i.test(s)) os = 'ChromeOS'
  else if (/linux/i.test(s)) os = 'Linux'

  let browser = ''
  if (/edg\//i.test(s)) browser = 'Edge'
  else if (/opr\/|opera/i.test(s)) browser = 'Opera'
  else if (/firefox|fxios/i.test(s)) browser = 'Firefox'
  else if (/crios/i.test(s)) browser = 'Chrome'
  else if (/chrome|chromium/i.test(s)) browser = 'Chrome'
  else if (/version\/.*safari/i.test(s)) browser = 'Safari'
  else if (/safari/i.test(s)) browser = 'Safari'

  if (browser && os) return `${browser} on ${os}`
  if (os) return os
  if (browser) return browser
  return null
}
