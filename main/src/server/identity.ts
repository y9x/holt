// Who a request comes from, network-wise. holt has no accounts of its own: the caller's identity is the
// principal holt-service verified with the caller's platform (chat-caller.ts). This module only reads the
// client address the platform's proxy forwarded, for rate limits and IP bans.

import type { IncomingMessage } from 'node:http'

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
