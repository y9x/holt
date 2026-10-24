import crypto from 'node:crypto'
import { getConfig } from './config.js'
import { query } from './db.js'

type DiscordConfig = NonNullable<ReturnType<typeof getConfig>['discord']>

function discordConfig(): DiscordConfig {
  const d = getConfig().discord
  if (!d?.clientId || !d.clientSecret || !d.redirectUri) {
    throw new Error('Discord OAuth is not configured (set discord.clientId / clientSecret / redirectUri in config.js)')
  }
  return d
}

export function authorizeUrl(state?: string): string {
  const d = discordConfig()
  const params = new URLSearchParams({
    client_id: d.clientId!,
    response_type: 'code',
    redirect_uri: d.redirectUri!,
    scope: 'identify',
  })
  if (state) params.set('state', state)
  return `https://discord.com/api/oauth2/authorize?${params}`
}

export async function getToken(authCode: string): Promise<string> {
  const d = discordConfig()
  const response = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: d.clientId!,
      client_secret: d.clientSecret!,
      code: authCode,
      grant_type: 'authorization_code',
      redirect_uri: d.redirectUri!,
      scope: 'identify',
    }),
  })
  const data = (await response.json()) as { access_token?: string; error?: string }
  if (!data.access_token) throw new Error(`Discord token exchange failed: ${data.error || `HTTP ${response.status}`}`)
  return data.access_token
}

export async function getUserData(accessToken: string): Promise<{ id: string; username: string; global_name?: string | null; avatar?: string | null }> {
  const response = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) throw new Error(`Discord user fetch failed: HTTP ${response.status}`)
  return (await response.json()) as { id: string; username: string; global_name?: string | null; avatar?: string | null }
}

export async function invalidateToken(accessToken: string): Promise<void> {
  const d = discordConfig()
  await fetch('https://discord.com/api/oauth2/token/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: d.clientId!,
      client_secret: d.clientSecret!,
      token: accessToken,
    }),
  }).catch(() => {})
}

export function clientIp(headers: Record<string, string | string[] | undefined>, socketIp?: string | null): string | null {
  const cf = headers['cf-connecting-ip']
  if (typeof cf === 'string' && cf.trim()) return cf.trim()
  const xff = headers['x-forwarded-for']
  const chain = (Array.isArray(xff) ? xff[0] : xff)?.split(',').map((p) => p.trim()).filter(Boolean) || []

  for (const candidate of chain) {
    if (isPublicIp(candidate)) return candidate
  }
  return chain[0] || socketIp || null
}

function isPublicIp(ip: string): boolean {
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('127.') || ip === '::1') return false
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return false
  if (ip.toLowerCase().startsWith('fc') || ip.toLowerCase().startsWith('fd') || ip.toLowerCase().startsWith('fe80')) return false
  return true
}

export type IpData = {
  status?: string
  country?: string
  timezone?: string
  isp?: string
  org?: string
  as?: string
  asname?: string
  mobile?: boolean
  proxy?: boolean
  hosting?: boolean
}

export async function getIpData(ip: string): Promise<IpData> {
  try {
    const response = await fetch(`http://ip-api.com/json/${ip}?fields=66842623`)
    return (await response.json()) as IpData
  } catch {
    return {}
  }
}

function hashIp(ip: string): string {
  const salt = getConfig().discord?.salt
  if (!salt) throw new Error('Discord salt is not configured (set discord.salt in config.js)')
  return crypto.createHash('sha256').update(salt).update(ip).digest('base64')
}

export async function checkIp(ip: string): Promise<string | null> {
  const { rows } = await query<{ discord_id: string }>(
    'SELECT discord_id FROM discord_verification WHERE ip_hash = $1 LIMIT 1',
    [hashIp(ip)],
  )
  return rows[0]?.discord_id || null
}

export async function setVerification(discordId: string, ip: string): Promise<void> {
  await query(
    `INSERT INTO discord_verification (discord_id, ip_hash) VALUES ($1, $2)
     ON CONFLICT (discord_id) DO UPDATE SET ip_hash = EXCLUDED.ip_hash, verified_at = NOW()`,
    [discordId, hashIp(ip)],
  )
}

export async function deleteVerification(discordId: string): Promise<void> {
  await query('DELETE FROM discord_verification WHERE discord_id = $1', [discordId])
}

export async function queueDeletion(discordId: string): Promise<void> {
  await query('INSERT INTO discord_pending_deletion (discord_id) VALUES ($1) ON CONFLICT DO NOTHING', [discordId])
}

export async function cancelDeletion(discordId: string): Promise<void> {
  await query('DELETE FROM discord_pending_deletion WHERE discord_id = $1', [discordId])
}

export async function processPendingDeletions(): Promise<string[]> {
  const { rows } = await query<{ discord_id: string }>('SELECT discord_id FROM discord_pending_deletion')
  const ids = rows.map((r) => r.discord_id)
  if (ids.length) {
    await query('DELETE FROM discord_verification WHERE discord_id = ANY($1)', [ids])
    await query('DELETE FROM discord_pending_deletion WHERE discord_id = ANY($1)', [ids])
  }
  return ids
}

export async function isVerified(discordId: string): Promise<boolean> {
  const { rows } = await query('SELECT 1 FROM discord_verification WHERE discord_id = $1', [discordId])
  return rows.length > 0
}

export async function logWebhook(content: string, botIdentity?: { username?: string; avatarUrl?: string }): Promise<void> {
  const url = getConfig().discord?.webhookUrl
  if (!url) return
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: botIdentity?.username || 'abulxt',
      avatar_url: botIdentity?.avatarUrl,
      content,
    }),
  }).catch(() => {})
}
