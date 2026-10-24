import type { IncomingMessage } from 'node:http'
import { resolveAuthUser, type DbUser } from './auth-db-api.js'
import { clientGeo } from './traffic-log.js'

export function clientIp(request: IncomingMessage): string {
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

export function guestOwnerKey(ip: string): string {
  return `guest:${ip}`
}

export function userOwnerKey(userId: number): string {
  return `user:${userId}`
}

export interface Identity {
  ownerKey: string
  user: DbUser | null
  isGuest: boolean
  ip: string
  country?: string
  city?: string
  region?: string
}

export async function resolveIdentity(request: IncomingMessage): Promise<Identity> {
  const user = await resolveAuthUser(request)
  const ip = clientIp(request)
  const geo = clientGeo(request)
  if (user) return { ownerKey: userOwnerKey(user.id), user, isGuest: false, ip, ...geo }
  return { ownerKey: guestOwnerKey(ip), user: null, isGuest: true, ip, ...geo }
}
