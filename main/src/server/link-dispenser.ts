// Discord link dispenser (/links, /linkadmin). Staff keep a pool of site
// links in link_dispenser_link; a verified home-guild member draws from it
// with a monthly quota by plan. Quotas count per identity: the Discord id
// plus, when linked, the site account, so relinking a second Discord account
// to the same site account doesn't reset the month. A link is never handed to
// the same identity twice, and the least-handed-out link (last 30 days) goes
// first so no single link spreads faster than the rest. Only someone who drew
// a link can report it blocked; REPORTS_TO_RETIRE distinct identities within
// 30 days retire it. A report never refunds a draw.
import { getPool, query } from './db.js'
import { userForDiscordId } from './discord-roles.js'

// Only the free allowance remains; the old paid-tier allowances were retired.
export type LinkPlan = 'free'

export const MONTHLY_LINKS: Record<LinkPlan, number> = { free: 2 }

export const PLAN_NAMES: Record<LinkPlan, string> = { free: 'Free' }

export const REPORTS_TO_RETIRE = 3

export interface LinkIdentity {
  discordId: string
  userId: number | null
  plan: LinkPlan
}

// Quota months are calendar months in UTC.
export function monthWindow(now: Date = new Date()): { start: Date; reset: Date } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    reset: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  }
}

export function quotaFor(plan: LinkPlan, used: number): { limit: number; used: number; left: number } {
  const limit = MONTHLY_LINKS[plan]
  return { limit, used, left: Math.max(0, limit - used) }
}

export async function linkIdentity(discordId: string): Promise<LinkIdentity> {
  const user = await userForDiscordId(discordId)
  if (!user) return { discordId, userId: null, plan: 'free' }
  return { discordId, userId: user.id, plan: 'free' }
}

const IDENTITY_MATCH = '(g.discord_id = $1 OR g.user_id = $2::int)'

export async function usedThisMonth(identity: LinkIdentity, now: Date = new Date()): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM link_dispenser_grant g WHERE ${IDENTITY_MATCH} AND g.granted_at >= $3`,
    [identity.discordId, identity.userId, monthWindow(now).start],
  )
  return Number(rows[0]?.n || 0)
}

export type DispenseResult =
  | { kind: 'granted'; linkId: number; url: string; limit: number; used: number; left: number }
  | { kind: 'exhausted'; limit: number; used: number; left: 0 }
  // Nothing left in the pool that this identity hasn't already had. Costs
  // nothing from the quota.
  | { kind: 'empty'; limit: number; used: number; left: number }

export async function dispenseLink(identity: LinkIdentity, now: Date = new Date()): Promise<DispenseResult> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    // Serialize draws per identity so a double-click can't overshoot.
    const lockKey = identity.userId !== null ? `link-dispenser:u:${identity.userId}` : `link-dispenser:d:${identity.discordId}`
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey])
    const { rows: usedRows } = await client.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM link_dispenser_grant g WHERE ${IDENTITY_MATCH} AND g.granted_at >= $3`,
      [identity.discordId, identity.userId, monthWindow(now).start],
    )
    const quota = quotaFor(identity.plan, Number(usedRows[0]?.n || 0))
    if (quota.left <= 0) {
      await client.query('ROLLBACK')
      return { kind: 'exhausted', limit: quota.limit, used: quota.used, left: 0 }
    }
    const { rows: picked } = await client.query<{ id: number; url: string }>(
      `SELECT l.id, l.url FROM link_dispenser_link l
       WHERE l.retired_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM link_dispenser_grant g WHERE g.link_id = l.id AND ${IDENTITY_MATCH})
       ORDER BY (SELECT COUNT(*) FROM link_dispenser_grant r WHERE r.link_id = l.id AND r.granted_at > NOW() - INTERVAL '30 days'), random()
       LIMIT 1`,
      [identity.discordId, identity.userId],
    )
    const link = picked[0]
    if (!link) {
      await client.query('ROLLBACK')
      return { kind: 'empty', ...quota }
    }
    await client.query(
      'INSERT INTO link_dispenser_grant (link_id, discord_id, user_id, plan) VALUES ($1, $2, $3, $4)',
      [link.id, identity.discordId, identity.userId, identity.plan],
    )
    await client.query('COMMIT')
    const after = quotaFor(identity.plan, quota.used + 1)
    return { kind: 'granted', linkId: link.id, url: link.url, ...after }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

export interface DrawnLink {
  linkId: number
  url: string
  grantedAt: Date
  retired: boolean
  reported: boolean
}

// This month's draws, newest first. Retired links are flagged so the user
// knows not to bother with them; reported = this identity already reported it.
export async function linksThisMonth(identity: LinkIdentity, now: Date = new Date()): Promise<DrawnLink[]> {
  const { rows } = await query<{ id: number; url: string; granted_at: Date; retired: boolean; reported: boolean }>(
    `SELECT l.id, l.url, g.granted_at, l.retired_at IS NOT NULL AS retired,
            EXISTS (SELECT 1 FROM link_dispenser_report p WHERE p.link_id = l.id AND (p.discord_id = $1 OR p.user_id = $2::int)) AS reported
     FROM link_dispenser_grant g JOIN link_dispenser_link l ON l.id = g.link_id
     WHERE ${IDENTITY_MATCH} AND g.granted_at >= $3
     ORDER BY g.granted_at DESC`,
    [identity.discordId, identity.userId, monthWindow(now).start],
  )
  return rows.map((r) => ({ linkId: r.id, url: r.url, grantedAt: r.granted_at, retired: r.retired, reported: r.reported }))
}

export type ReportResult =
  // The identity never drew this link (or it doesn't exist): reports are
  // only taken from people who were handed the link.
  | { kind: 'not-drawn' }
  | { kind: 'already-retired'; url: string }
  | { kind: 'already-reported'; url: string }
  | { kind: 'reported'; url: string; reports: number; retiredNow: boolean }

export async function reportLink(identity: LinkIdentity, linkId: number): Promise<ReportResult> {
  if (!Number.isSafeInteger(linkId) || linkId <= 0) return { kind: 'not-drawn' }
  const { rows } = await query<{ url: string; retired: boolean; reported: boolean }>(
    `SELECT l.url, l.retired_at IS NOT NULL AS retired,
            EXISTS (SELECT 1 FROM link_dispenser_report p WHERE p.link_id = l.id AND (p.discord_id = $1 OR p.user_id = $2::int)) AS reported
     FROM link_dispenser_link l
     WHERE l.id = $3 AND EXISTS (SELECT 1 FROM link_dispenser_grant g WHERE g.link_id = l.id AND ${IDENTITY_MATCH})`,
    [identity.discordId, identity.userId, linkId],
  )
  const link = rows[0]
  if (!link) return { kind: 'not-drawn' }
  if (link.retired) return { kind: 'already-retired', url: link.url }
  if (link.reported) return { kind: 'already-reported', url: link.url }
  const inserted = await query(
    'INSERT INTO link_dispenser_report (link_id, discord_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [linkId, identity.discordId, identity.userId],
  )
  if (!inserted.rowCount) return { kind: 'already-reported', url: link.url }
  const reports = await reportCount(linkId)
  // The UPDATE's row count makes exactly one concurrent reporter the retirer.
  const retiredNow = reports >= REPORTS_TO_RETIRE
    && ((await query('UPDATE link_dispenser_link SET retired_at = NOW() WHERE id = $1 AND retired_at IS NULL', [linkId])).rowCount ?? 0) > 0
  return { kind: 'reported', url: link.url, reports, retiredNow }
}

// Distinct reporting identities in the last 30 days (a site account counts
// once however many Discord accounts it has linked).
async function reportCount(linkId: number): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `SELECT COUNT(DISTINCT COALESCE('u' || user_id::text, 'd' || discord_id)) AS n
     FROM link_dispenser_report WHERE link_id = $1 AND reported_at > NOW() - INTERVAL '30 days'`,
    [linkId],
  )
  return Number(rows[0]?.n || 0)
}

// Accepts "example.com", "https://example.com/", "http://x.y/path". Stores
// https origin + path, without a trailing slash on a bare origin. null =
// not a usable link.
export function normalizeLinkUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/[<>]/g, '')
  if (!trimmed) return null
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (!url.hostname.includes('.') || url.username || url.password) return null
  url.protocol = 'https:'
  url.hash = ''
  const text = url.toString()
  return url.pathname === '/' && !url.search ? text.replace(/\/$/, '') : text
}

export async function addLinks(urls: string[], addedBy: string): Promise<{ added: string[]; restored: string[]; existing: string[] }> {
  const result = { added: [] as string[], restored: [] as string[], existing: [] as string[] }
  for (const url of urls) {
    const { rows } = await query<{ id: number; inserted: boolean; was_retired: boolean }>(
      `WITH prev AS (SELECT retired_at FROM link_dispenser_link WHERE url = $1)
       INSERT INTO link_dispenser_link (url, added_by) VALUES ($1, $2)
       ON CONFLICT (url) DO UPDATE SET retired_at = NULL
       RETURNING id, (xmax = 0) AS inserted, COALESCE((SELECT retired_at IS NOT NULL FROM prev), FALSE) AS was_retired`,
      [url, addedBy],
    )
    const row = rows[0]
    if (row?.inserted) result.added.push(url)
    else if (row?.was_retired) {
      // Staff vouched for it again: old blocked reports no longer count.
      await query('DELETE FROM link_dispenser_report WHERE link_id = $1', [row.id])
      result.restored.push(url)
    } else result.existing.push(url)
  }
  return result
}

export async function retireLink(url: string): Promise<boolean> {
  const { rowCount } = await query(
    'UPDATE link_dispenser_link SET retired_at = NOW() WHERE url = $1 AND retired_at IS NULL',
    [url],
  )
  return (rowCount ?? 0) > 0
}

export interface PoolLink {
  url: string
  retired: boolean
  month: number
  total: number
  reports: number
}

export async function poolLinks(now: Date = new Date()): Promise<PoolLink[]> {
  const { rows } = await query<{ url: string; retired: boolean; month: string; total: string; reports: string }>(
    `SELECT l.url, l.retired_at IS NOT NULL AS retired,
            COUNT(g.id) FILTER (WHERE g.granted_at >= $1) AS month, COUNT(g.id) AS total,
            (SELECT COUNT(*) FROM link_dispenser_report p WHERE p.link_id = l.id AND p.reported_at > NOW() - INTERVAL '30 days') AS reports
     FROM link_dispenser_link l LEFT JOIN link_dispenser_grant g ON g.link_id = l.id
     GROUP BY l.id ORDER BY l.retired_at IS NOT NULL, l.added_at DESC`,
    [monthWindow(now).start],
  )
  return rows.map((r) => ({ url: r.url, retired: r.retired, month: Number(r.month), total: Number(r.total), reports: Number(r.reports) }))
}
