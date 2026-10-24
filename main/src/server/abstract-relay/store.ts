// Database access for Abstract AI usage. Clock reads and writes use the
// database NOW(), as the Go service does (usage.go:180-199, 281-290).
// Pure window rules are in windows.ts.

import { getPool, query } from '../db.js'
import { WINDOW_KINDS, WINDOW_LENGTH_MS, type WindowKind, type WindowRow } from './windows.ts'

export type WindowSnapshot = {
  nowMs: number
  rows: Partial<Record<WindowKind, WindowRow>>
}

/** Both windows for one user, plus the database clock, read in one statement. */
export async function readWindowSnapshot(userId: number): Promise<WindowSnapshot> {
  const { rows } = await query<{
    kind: WindowKind | null
    used: number | null
    start_ms: number | null
    now_ms: number
  }>(
    `SELECT w.kind,
            w.used_units::float8 AS used,
            (EXTRACT(EPOCH FROM w.window_start) * 1000)::float8 AS start_ms,
            n.now_ms
       FROM (SELECT (EXTRACT(EPOCH FROM NOW()) * 1000)::float8 AS now_ms) n
       LEFT JOIN usage_window w ON w.user_id = $1`,
    [userId],
  )
  const snapshot: WindowSnapshot = { nowMs: Number(rows[0]?.now_ms ?? Date.now()), rows: {} }
  for (const row of rows) {
    if (!row.kind || row.start_ms === null || row.used === null) continue
    snapshot.rows[row.kind] = { startMs: Number(row.start_ms), used: Number(row.used) }
  }
  return snapshot
}

export type UsageRecord = {
  userId: number
  model: string
  multiplier: number
  units: number
  inputTokens: number
  outputTokens: number
}

function clampInt(value: number): number {
  return Math.min(2_147_483_647, Math.max(0, Math.trunc(value)))
}

/**
 * Adds one request to both windows and writes the event row, in one
 * transaction. A window that has expired restarts at this request.
 */
export async function recordUsage(record: UsageRecord): Promise<void> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO usage_event (user_id, model, multiplier, units, input_tokens, output_tokens)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        record.userId,
        record.model,
        record.multiplier,
        record.units,
        clampInt(record.inputTokens),
        clampInt(record.outputTokens),
      ],
    )
    for (const kind of WINDOW_KINDS) {
      const seconds = WINDOW_LENGTH_MS[kind] / 1000
      await client.query(
        `INSERT INTO usage_window (user_id, kind, window_start, used_units)
         VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (user_id, kind) DO UPDATE SET
           window_start = CASE WHEN usage_window.window_start < NOW() - make_interval(secs => $4::float8)
                               THEN NOW() ELSE usage_window.window_start END,
           used_units = CASE WHEN usage_window.window_start < NOW() - make_interval(secs => $4::float8)
                             THEN EXCLUDED.used_units
                             ELSE usage_window.used_units + EXCLUDED.used_units END`,
        [record.userId, kind, record.units, seconds],
      )
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
