// Persistence + URL helpers for uploaded chat avatars (table user_avatar,
// migration 015). Shared by avatar-api (upload/serve), admin-api (review),
// discord-bridge-api (author_avatar on send/forward) and the bridge bot
// (delivery-time re-check). Only rows with status 'approved' are ever served
// or handed to Discord.
import { query } from './db.js'
import { loadConfig } from './config.js'

export type AvatarStatus = 'pending' | 'approved' | 'rejected' | 'removed'

export const AVATAR_PATH_PREFIX = '/api/avatars/'
const SHA_RE = /^[a-f0-9]{64}$/

export interface AvatarRow {
  id: string
  user_id: number | null
  sha256: string
  source_sha256: string
  source_format: string
  width: number
  height: number
  status: AvatarStatus
  categories: string[]
  reason: string | null
  model: string | null
  auto_activate: boolean
  reviewed_by: number | null
  reviewed_at: Date | null
  created_at: Date
}

const COL_NAMES = ['user_id', 'sha256', 'source_sha256', 'source_format', 'width', 'height', 'status', 'categories', 'reason', 'model', 'auto_activate', 'reviewed_by', 'reviewed_at', 'created_at']
function cols(alias = ''): string {
  const p = alias ? `${alias}.` : ''
  return [`${p}id::text AS id`, ...COL_NAMES.map((c) => `${p}${c}`)].join(', ')
}
const ROW_COLS = cols()

export async function publicAvatarOrigin(): Promise<string> {
  const config = await loadConfig()
  const raw = (config.avatars?.publicOrigin || config.mail?.publicOrigin || '').trim().replace(/\/+$/, '')
  return /^https?:\/\/[^/\s]+$/i.test(raw) ? raw : ''
}

// Same-origin path of an approved avatar. Clients load it from the site they
// are on; only Discord needs an absolute URL (see absoluteAvatarUrl).
export async function avatarUrlForSha(sha256: string): Promise<string | null> {
  if (!SHA_RE.test(sha256)) return null
  return `${AVATAR_PATH_PREFIX}${sha256}.webp`
}

// Absolute URL for Discord's webhook avatar_url (Discord fetches it from the
// outside). Our own avatars, relative or stored with any origin, are rebased
// onto the public origin; other URLs (Discord CDN) pass through. Null when our
// avatar has no public origin configured.
export async function absoluteAvatarUrl(url: string | null | undefined): Promise<string | null> {
  if (!url) return null
  const sha = shaFromAvatarUrl(url)
  if (!sha) return url
  const origin = await publicAvatarOrigin()
  return origin ? `${origin}${AVATAR_PATH_PREFIX}${sha}.webp` : null
}

// Our own avatar URL as a same-origin path (older rows stored it absolute).
export function sameOriginAvatarUrl(url: string | null | undefined): string | null {
  if (!url) return url ?? null
  const sha = shaFromAvatarUrl(url)
  return sha ? `${AVATAR_PATH_PREFIX}${sha}.webp` : url
}

// Extract the sha from one of OUR avatar URLs (any origin), else null.
export function shaFromAvatarUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const m = /^\/api\/avatars\/([a-f0-9]{64})\.webp$/.exec(new URL(url, 'http://x').pathname)
    return m ? m[1] : null
  } catch {
    return null
  }
}

export async function isApprovedSha(sha256: string): Promise<boolean> {
  const { rows } = await query(`SELECT 1 FROM user_avatar WHERE sha256 = $1 AND status = 'approved' AND bytes IS NOT NULL LIMIT 1`, [sha256])
  return rows.length > 0
}

// Same-origin URL of the user's ACTIVE approved avatar, or null (callers
// fall back to the Discord-linked avatar, then the default).
export async function approvedAvatarUrlForUser(userId: number): Promise<string | null> {
  const { rows } = await query<{ sha256: string }>(
    `SELECT a.sha256 FROM users u JOIN user_avatar a ON a.id = u.chat_avatar_id
     WHERE u.id = $1 AND a.status = 'approved' AND a.bytes IS NOT NULL`,
    [userId],
  ).catch(() => ({ rows: [] as Array<{ sha256: string }> }))
  return rows[0] ? avatarUrlForSha(rows[0].sha256) : null
}

export async function approvedAvatarBytes(sha256: string): Promise<Buffer | null> {
  if (!SHA_RE.test(sha256)) return null
  const { rows } = await query<{ bytes: Buffer }>(
    `SELECT bytes FROM user_avatar WHERE sha256 = $1 AND status = 'approved' AND bytes IS NOT NULL ORDER BY id LIMIT 1`,
    [sha256],
  )
  return rows[0]?.bytes ?? null
}

export async function avatarBytesById(id: string): Promise<Buffer | null> {
  const { rows } = await query<{ bytes: Buffer | null }>(`SELECT bytes FROM user_avatar WHERE id = $1`, [id])
  return rows[0]?.bytes ?? null
}

export async function avatarById(id: string): Promise<AvatarRow | null> {
  const { rows } = await query<AvatarRow>(`SELECT ${ROW_COLS} FROM user_avatar WHERE id = $1`, [id])
  return rows[0] ?? null
}

export async function latestAvatarForUser(userId: number): Promise<AvatarRow | null> {
  const { rows } = await query<AvatarRow>(
    `SELECT ${ROW_COLS} FROM user_avatar WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [userId],
  )
  return rows[0] ?? null
}

export async function activeAvatarForUser(userId: number): Promise<AvatarRow | null> {
  const { rows } = await query<AvatarRow>(
    `SELECT ${cols('a')}
     FROM users u JOIN user_avatar a ON a.id = u.chat_avatar_id
     WHERE u.id = $1 AND a.status = 'approved' AND a.bytes IS NOT NULL`,
    [userId],
  )
  return rows[0] ?? null
}

// Hash previously judged bad (rejected or taken down)? Checked against both
// the raw-upload hash and the normalized-output hash.
export async function priorVerdictForHashes(sourceSha256: string, sha256: string): Promise<{ status: 'rejected' | 'approved'; row: AvatarRow } | null> {
  const { rows } = await query<AvatarRow>(
    `SELECT ${ROW_COLS} FROM user_avatar
     WHERE (sha256 = $1 OR source_sha256 = $2 OR sha256 = $2 OR source_sha256 = $1)
       AND status IN ('rejected', 'removed', 'approved')
     ORDER BY CASE WHEN status IN ('rejected', 'removed') THEN 0 ELSE 1 END, id DESC
     LIMIT 1`,
    [sha256, sourceSha256],
  )
  const row = rows[0]
  if (!row) return null
  if (row.status === 'rejected' || row.status === 'removed') return { status: 'rejected', row }
  // Reuse an approval only for an identical normalized output.
  return row.sha256 === sha256 ? { status: 'approved', row } : null
}

export async function recentRejections(userId: number, sinceMs: number): Promise<{ count: number; last: Date | null }> {
  const { rows } = await query<{ count: string; last: Date | null }>(
    `SELECT count(*)::text AS count, max(created_at) AS last FROM user_avatar
     WHERE user_id = $1 AND status IN ('rejected', 'removed') AND created_at > NOW() - ($2::text || ' milliseconds')::interval`,
    [userId, String(Math.floor(sinceMs))],
  )
  return { count: Number(rows[0]?.count ?? 0), last: rows[0]?.last ?? null }
}

export async function pendingInFlight(userId: number, windowMs: number): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM user_avatar WHERE user_id = $1 AND status = 'pending' AND model IS NULL
       AND created_at > NOW() - ($2::text || ' milliseconds')::interval LIMIT 1`,
    [userId, String(Math.floor(windowMs))],
  )
  return rows.length > 0
}

export interface InsertAvatar {
  userId: number
  sha256: string
  sourceSha256: string
  sourceFormat: string
  // null = don't retain pixels (e.g. a hash-dedupe rejection of known-bad content)
  bytes: Buffer | null
  width: number
  height: number
  status: AvatarStatus
  categories?: string[]
  reason?: string | null
  model?: string | null
  modelRaw?: string | null
}

// Insert a new upload row. Older rows of this user stop auto-activating so a
// late verdict on a superseded upload can never replace this one.
export async function insertAvatar(input: InsertAvatar): Promise<AvatarRow> {
  await query(`UPDATE user_avatar SET auto_activate = FALSE WHERE user_id = $1 AND auto_activate`, [input.userId])
  const { rows } = await query<AvatarRow>(
    `INSERT INTO user_avatar (user_id, sha256, source_sha256, source_format, bytes, width, height, status, categories, reason, model, model_raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${ROW_COLS}`,
    [
      input.userId, input.sha256, input.sourceSha256, input.sourceFormat,
      input.status === 'removed' ? null : input.bytes, input.width, input.height, input.status,
      input.categories ?? [], input.reason ?? null, input.model ?? null, input.modelRaw ?? null,
    ],
  )
  return rows[0]
}

// Point the owner at this avatar if it's approved and still auto-activating.
export async function activateIfEligible(id: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE users u SET chat_avatar_id = a.id
     FROM user_avatar a
     WHERE a.id = $1 AND a.user_id = u.id AND a.status = 'approved' AND a.auto_activate AND a.bytes IS NOT NULL`,
    [id],
  )
  return (rowCount ?? 0) > 0
}

// Record the automatic verdict on a pending row (no-op if a moderator got
// there first).
export async function recordModelVerdict(id: string, v: { status: AvatarStatus; categories: string[]; reason: string; model: string; raw: string }): Promise<AvatarRow | null> {
  const { rows } = await query<AvatarRow>(
    `UPDATE user_avatar SET status = $2, categories = $3, reason = $4, model = $5, model_raw = $6
     WHERE id = $1 AND status = 'pending' AND reviewed_by IS NULL
     RETURNING ${ROW_COLS}`,
    [id, v.status, v.categories, v.reason, v.model, v.raw.slice(0, 4000)],
  )
  return rows[0] ?? null
}

// User removed their avatar: clear the pointer and stop any pending upload
// from activating later.
export async function clearUserAvatar(userId: number): Promise<void> {
  await query(`UPDATE users SET chat_avatar_id = NULL WHERE id = $1`, [userId])
  await query(`UPDATE user_avatar SET auto_activate = FALSE WHERE user_id = $1 AND auto_activate`, [userId])
}

export type ReviewAction = 'approve' | 'reject' | 'remove'

// Moderator decision. reject/remove apply to EVERY row sharing the image hash
// (dedupe copies), unset any user pointing at them, and remove also purges
// the stored bytes (hashes stay so re-uploads are rejected immediately).
export async function reviewAvatar(id: string, action: ReviewAction, reviewerId: number, reason: string | null): Promise<{ row: AvatarRow; affectedUserIds: number[] } | null> {
  const target = await avatarById(id)
  if (!target) return null
  if (action === 'approve') {
    const { rows } = await query<AvatarRow>(
      `UPDATE user_avatar SET status = 'approved', categories = '{}', reason = COALESCE($3, 'Approved by a moderator.'),
         reviewed_by = $2, reviewed_at = NOW()
       WHERE id = $1 AND bytes IS NOT NULL
       RETURNING ${ROW_COLS}`,
      [id, reviewerId, reason],
    )
    if (!rows[0]) return null
    await activateIfEligible(id)
    return { row: rows[0], affectedUserIds: rows[0].user_id ? [rows[0].user_id] : [] }
  }
  const status: AvatarStatus = action === 'remove' ? 'removed' : 'rejected'
  const finalReason = reason || (action === 'remove' ? 'Removed by a moderator.' : 'Rejected by a moderator.')
  const { rows } = await query<AvatarRow & { user_id: number | null }>(
    `UPDATE user_avatar SET status = $2, reason = $3, reviewed_by = $4, reviewed_at = NOW(),
       bytes = CASE WHEN $2 = 'removed' THEN NULL ELSE bytes END,
       categories = CASE WHEN cardinality(categories) = 0 THEN ARRAY['other'] ELSE categories END
     WHERE id = $1 OR (sha256 = $5 AND status IN ('approved', 'pending'))
     RETURNING ${ROW_COLS}`,
    [id, status, finalReason, reviewerId, target.sha256],
  )
  const ids = rows.map((r) => r.id)
  const { rows: users } = await query<{ id: number }>(
    `UPDATE users SET chat_avatar_id = NULL WHERE chat_avatar_id = ANY($1::bigint[]) RETURNING id`,
    [ids],
  )
  const row = rows.find((r) => r.id === id) ?? rows[0]
  const affected = new Set<number>(users.map((u) => u.id))
  for (const r of rows) if (r.user_id) affected.add(r.user_id)
  return { row, affectedUserIds: [...affected] }
}

export async function listAvatarsForReview(status: AvatarStatus | 'all', limit = 100): Promise<Array<AvatarRow & { username: string | null; reviewer: string | null; active: boolean }>> {
  const { rows } = await query<AvatarRow & { username: string | null; reviewer: string | null; active: boolean }>(
    `SELECT ${cols('a')}, u.username, r.username AS reviewer, (u.chat_avatar_id = a.id) AS active
     FROM user_avatar a
     LEFT JOIN users u ON u.id = a.user_id
     LEFT JOIN users r ON r.id = a.reviewed_by
     WHERE ($1::text = 'all' OR a.status = $1::text)
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT $2`,
    [status, Math.min(500, Math.max(1, limit))],
  )
  return rows
}
