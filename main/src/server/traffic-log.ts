import type { IncomingMessage } from 'node:http'
import { query } from './db.js'

export type TrafficKind = 'ai' | 'wisp'

export function clientGeo(request: IncomingMessage): { country?: string; city?: string; region?: string } {
  const h = request.headers
  const one = (key: string) => {
    const v = h[key]
    if (typeof v === 'string' && v.trim() && v.trim() !== 'XX') return v.trim()
    if (Array.isArray(v) && v[0]?.trim() && v[0].trim() !== 'XX') return v[0].trim()
    return undefined
  }
  // Cloudflare: CF-IPCountry / CF-IPCity / CF-Region (city-level when available).
  return {
    country: one('cf-ipcountry') || one('x-country') || one('x-vercel-ip-country'),
    city: one('cf-ipcity') || one('x-city') || one('x-vercel-ip-city'),
    region: one('cf-region') || one('cf-region-code') || one('x-region') || one('x-vercel-ip-country-region'),
  }
}

export async function logTraffic(opts: {
  kind: TrafficKind
  ip: string
  country?: string | null
  city?: string | null
  region?: string | null
  userId?: number | null
  path?: string | null
  meta?: Record<string, unknown>
}): Promise<void> {
  const ip = (opts.ip || 'unknown').slice(0, 128)
  if (!ip || ip === 'unknown') return
  try {
    await query(
      `INSERT INTO traffic_events (kind, ip, country, city, region, user_id, path, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        opts.kind,
        ip,
        opts.country || null,
        opts.city || null,
        opts.region || null,
        opts.userId ?? null,
        opts.path || null,
        JSON.stringify(opts.meta || {}),
      ],
    )
  } catch (error) {
    // Never fail the user request because logging broke.
    console.warn('[traffic-log]', error instanceof Error ? error.message : error)
  }
}

function requestIp(request: IncomingMessage): string {
  const cf = request.headers['cf-connecting-ip']
  if (typeof cf === 'string' && cf.trim()) return cf.trim()
  if (Array.isArray(cf) && cf[0]?.trim()) return cf[0].trim()
  const fwd = request.headers['x-forwarded-for']
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim()
  if (Array.isArray(fwd) && fwd[0]?.trim()) return fwd[0].split(',')[0].trim()
  const real = request.headers['x-real-ip']
  if (typeof real === 'string' && real.trim()) return real.trim()
  return request.socket?.remoteAddress || 'unknown'
}

export async function logTrafficFromRequest(
  request: IncomingMessage,
  opts: { kind: TrafficKind; userId?: number | null; path?: string | null; meta?: Record<string, unknown> },
): Promise<void> {
  const geo = clientGeo(request)
  await logTraffic({
    kind: opts.kind,
    ip: requestIp(request),
    country: geo.country,
    city: geo.city,
    region: geo.region,
    userId: opts.userId,
    path: opts.path || request.url || null,
    meta: opts.meta,
  })
}
