// holt's identity directory (table chat_identity, schema.sql 002_holt_identity): every web identity holt has
// seen, as its platform last described it. It is what lets holt answer for an identity that is not the caller
// (profiles, moderation targets, role-member lists, `/bridge` lookups by name) without asking its platform,
// and what links a Discord account to the web identity a trusted platform says owns it (one webhook, so a
// ban or timeout on either side covers both).
//
// Refreshed from each request's principal (at most once a minute per identity, or at once when anything
// changed), and from a platform's own push (`_holt/platform/identities`).

import { query } from './db.js'

export interface DirectoryIdentity {
  key: string
  platform: string
  name: string
  avatar: string | null
  discordId: string | null
  admin: boolean
  emailVerified: boolean
  firstSeen: string
}

interface Row {
  key: string
  platform: string
  name: string
  avatar: string | null
  discord_id: string | null
  admin: boolean
  email_verified: boolean
  first_seen: Date | string
}

const toIdentity = (r: Row): DirectoryIdentity => ({
  key: r.key,
  platform: r.platform,
  name: r.name,
  avatar: r.avatar,
  discordId: r.discord_id,
  admin: r.admin === true,
  emailVerified: r.email_verified === true,
  firstSeen: new Date(r.first_seen).toISOString(),
})

const COLS = 'key, platform, name, avatar, discord_id, admin, email_verified, first_seen'
const TOUCH_INTERVAL_MS = 60_000
const touched = new Map<string, { at: number; sig: string }>()

export interface IdentityInput {
  ext_key: string
  platform: string
  username: string
  avatar: string | null
  discord_id: string | null
  admin: boolean
  email_verified: boolean
}

/** Record what a platform says about an identity. A Discord id is moved off any other identity holding it. */
export async function saveIdentity(input: IdentityInput): Promise<void> {
  if (input.discord_id) {
    await query(`UPDATE chat_identity SET discord_id = NULL WHERE discord_id = $1 AND key <> $2`, [input.discord_id, input.ext_key])
  }
  await query(
    `INSERT INTO chat_identity (key, platform, name, avatar, discord_id, admin, email_verified)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (key) DO UPDATE SET platform = EXCLUDED.platform, name = EXCLUDED.name, avatar = EXCLUDED.avatar,
       discord_id = EXCLUDED.discord_id, admin = EXCLUDED.admin, email_verified = EXCLUDED.email_verified, last_seen = NOW()`,
    [input.ext_key, input.platform, input.username, input.avatar, input.discord_id, input.admin, input.email_verified],
  )
}

/** Fire-and-forget refresh from a request's principal (throttled; immediate when the description changed). */
export function touchIdentity(input: IdentityInput): void {
  const sig = JSON.stringify([input.username, input.avatar, input.discord_id, input.admin, input.email_verified])
  const hit = touched.get(input.ext_key)
  const now = Date.now()
  if (hit && hit.sig === sig && now - hit.at < TOUCH_INTERVAL_MS) return
  touched.set(input.ext_key, { at: now, sig })
  if (touched.size > 20_000) touched.delete(touched.keys().next().value as string)
  void saveIdentity(input).catch((error) => {
    touched.delete(input.ext_key)
    console.warn('[identity] save failed:', error instanceof Error ? error.message : error)
  })
}

/** Forget what a push said was stale, so the next request rewrites it. */
export function forgetTouched(key: string): void {
  touched.delete(key)
}

export async function identityByKey(key: string): Promise<DirectoryIdentity | null> {
  const { rows } = await query<Row>(`SELECT ${COLS} FROM chat_identity WHERE key = $1`, [key])
  return rows[0] ? toIdentity(rows[0]) : null
}

export async function identitiesByKeys(keys: string[]): Promise<Map<string, DirectoryIdentity>> {
  if (!keys.length) return new Map()
  const { rows } = await query<Row>(`SELECT ${COLS} FROM chat_identity WHERE key = ANY($1::text[])`, [keys])
  return new Map(rows.map((r) => [r.key, toIdentity(r)]))
}

/** The web identity a trusted platform says owns this Discord account, or null. */
export async function identityByDiscordId(discordId: string): Promise<DirectoryIdentity | null> {
  const { rows } = await query<Row>(`SELECT ${COLS} FROM chat_identity WHERE discord_id = $1 LIMIT 1`, [discordId])
  return rows[0] ? toIdentity(rows[0]) : null
}

/** Identities named `name` (case-insensitive), newest first: `/bridge` targets typed as a name. */
export async function identitiesByName(name: string, limit = 5): Promise<DirectoryIdentity[]> {
  const { rows } = await query<Row>(`SELECT ${COLS} FROM chat_identity WHERE lower(name) = lower($1) ORDER BY last_seen DESC LIMIT $2`, [name, limit])
  return rows.map(toIdentity)
}

/** An account was deleted on its platform: drop what holt keeps about it (messages stay, as on Discord). */
export async function forgetIdentity(key: string): Promise<void> {
  forgetTouched(key)
  await query(`DELETE FROM chat_identity WHERE key = $1`, [key])
  await query(`DELETE FROM chat_presence WHERE key = $1`, [key])
  await query(`DELETE FROM chat_guild_folders WHERE key = $1`, [key])
  await query(`DELETE FROM discord_bridge_onboarding_state WHERE identity_key = $1`, [key])
}
