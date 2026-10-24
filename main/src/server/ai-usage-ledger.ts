// Person-level AI usage ledger. Limits follow the PERSON (verified email,
// linked Discord id, and every identity the account has ever held), not the
// users row, so deleting and recreating an account does not reset usage.
//
// Every request is written to ALL identity keys of the caller and the limit is
// checked against the MAX requests across those keys. ai_usage (per account)
// is kept for admin statistics only.
import { query } from './db.js'
import { loadConfig } from './config.js'
import { emailHash, identityKeysFor, normalizeEmail, type LedgerUser } from './ai-usage-identity.js'

async function ledgerSalt(): Promise<string> {
  const salt = (await loadConfig()).discord?.salt
  if (!salt) throw new Error('Discord salt is not configured (set discord.salt in config.js); AI usage ledger needs it')
  return salt
}

/**
 * Identity keys for a user: the keys it resolves to now plus every key the
 * account has held before (history survives email changes within the account).
 * `persist` records the current keys into the history table; reads pass false.
 */
export async function ledgerKeysFor(user: LedgerUser, persist: boolean): Promise<string[]> {
  const current = identityKeysFor(user, await ledgerSalt())
  if (persist) {
    await query(
      `INSERT INTO ai_usage_identity (user_id, identity_key)
       SELECT $1::int, k FROM unnest($2::text[]) AS k
       ON CONFLICT (user_id, identity_key) DO NOTHING`,
      [user.id, current],
    )
  }
  const { rows } = await query<{ identity_key: string }>(
    'SELECT identity_key FROM ai_usage_identity WHERE user_id = $1',
    [user.id],
  )
  return [...new Set([...current, ...rows.map((r) => r.identity_key)])]
}

/**
 * Add `requestDelta` requests and `tokens` to every key for today. Returns the
 * highest request count across the keys after the write.
 */
export async function ledgerAdjust(keys: string[], requestDelta: number, tokens: number): Promise<number> {
  const { rows } = await query<{ requests: number }>(
    `INSERT INTO ai_usage_ledger (identity_key, bucket_day, requests, tokens, updated_at)
     SELECT k, CURRENT_DATE, GREATEST(0, $2::int), GREATEST(0, $3::bigint), NOW()
     FROM unnest($1::text[]) AS k
     ON CONFLICT (identity_key, bucket_day) DO UPDATE
       SET requests = GREATEST(0, ai_usage_ledger.requests + $2::int),
           tokens = ai_usage_ledger.tokens + GREATEST(0, $3::bigint),
           updated_at = NOW()
     RETURNING requests`,
    [keys, requestDelta, Math.max(0, Math.floor(tokens))],
  )
  return rows.reduce((max, r) => Math.max(max, Number(r.requests) || 0), 0)
}

/** Today's usage for a person: MAX requests and MAX tokens across keys. */
export async function ledgerUsage(keys: string[]): Promise<{ requests: number; tokens: number }> {
  const { rows } = await query<{ requests: number; tokens: string | number }>(
    `SELECT COALESCE(MAX(requests), 0)::int AS requests, COALESCE(MAX(tokens), 0) AS tokens
     FROM ai_usage_ledger WHERE identity_key = ANY($1::text[]) AND bucket_day = CURRENT_DATE`,
    [keys],
  )
  return { requests: Number(rows[0]?.requests) || 0, tokens: Number(rows[0]?.tokens) || 0 }
}

/**
 * Record that a verified email's account was deleted. The ledger rows are
 * already keyed by the same hash and are never deleted, so recreating with
 * this email inherits usage; this marker is the explicit audit record.
 */
export async function markDeletedAccount(user: LedgerUser): Promise<void> {
  if (!user.email_verified || !user.email) return
  const normalized = normalizeEmail(user.email)
  if (!normalized) return
  await query(
    `INSERT INTO deleted_account_email (email_hash, deleted_at) VALUES ($1, NOW())
     ON CONFLICT (email_hash) DO UPDATE SET deleted_at = NOW()`,
    [emailHash(normalized, await ledgerSalt())],
  )
}
