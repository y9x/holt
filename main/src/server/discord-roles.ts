import { getConfig } from './config.js'
import { query } from './db.js'

const DISCORD_API = 'https://discord.com/api/v10'

type DiscordConfig = NonNullable<ReturnType<typeof getConfig>['discord']>

export function discordEnabled(): boolean {
  try {
    const d = getConfig().discord
    return Boolean(d?.botToken && d.guildId)
  } catch {
    return false
  }
}

function discordConfig(): DiscordConfig | null {
  return discordEnabled() ? (getConfig().discord as DiscordConfig) : null
}

export async function discordFetch(path: string, init: RequestInit = {}, auditReason?: string): Promise<Response> {
  const d = discordConfig()
  if (!d?.botToken) throw new Error('Discord is not configured (set discord.botToken in config.js)')
  const headers: Record<string, string> = { Authorization: `Bot ${d.botToken}` }
  if (auditReason) headers['x-audit-log-reason'] = encodeURIComponent(auditReason)
  if (init.body) headers['Content-Type'] = 'application/json'
  const response = await fetch(`${DISCORD_API}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } })
  if (response.status === 429) {

    const retry = (await response.json().catch(() => ({}))) as { retry_after?: number }
    await new Promise((r) => setTimeout(r, Math.min((retry.retry_after ?? 1) * 1000, 10_000)))
    return fetch(`${DISCORD_API}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } })
  }
  return response
}

// A member's role ids in `guildId` (default: the HOME guild, config
// discord.guildId - entitlement/verification paths). null = not a member.
export async function guildMemberRoles(discordId: string, guildId?: string): Promise<string[] | null> {
  const d = discordConfig()
  if (!d) return null
  const response = await discordFetch(`/guilds/${guildId || d.guildId}/members/${discordId}`)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Discord member fetch failed: HTTP ${response.status}`)
  const member = (await response.json()) as { roles?: string[] }
  return member.roles || []
}

// Member role lookups cached 30s per guild + user (keyed `guildId:discordId`)
// and deduped while in flight, shared by the chat-perm resolver
// (discordRolePerms) and the effective-role / visibility code, so one
// request costs one REST call per guild at most. null = not a member. A
// failed lookup (429, outage) serves the last known value for a few seconds
// if there is one, else throws - it is never cached as "not a member".
const memberRolesCache = new Map<string, { expires: number; roles: string[] | null }>()
const memberRolesInflight = new Map<string, Promise<string[] | null>>()
const MEMBER_ROLES_TTL_MS = 30_000

export async function cachedGuildMemberRoles(discordId: string, guildId: string): Promise<string[] | null> {
  const key = `${guildId}:${discordId}`
  const hit = memberRolesCache.get(key)
  if (hit && hit.expires > Date.now()) return hit.roles
  let inflight = memberRolesInflight.get(key)
  if (!inflight) {
    inflight = guildMemberRoles(discordId, guildId)
      .then((roles) => {
        memberRolesCache.set(key, { expires: Date.now() + MEMBER_ROLES_TTL_MS, roles })
        if (memberRolesCache.size > 4000) memberRolesCache.delete(memberRolesCache.keys().next().value as string)
        return roles
      })
      .catch((error) => {
        if (hit) {
          memberRolesCache.set(key, { expires: Date.now() + 5_000, roles: hit.roles })
          return hit.roles
        }
        throw error
      })
      .finally(() => { memberRolesInflight.delete(key) })
    memberRolesInflight.set(key, inflight)
  }
  return inflight
}

// Drop cached member roles: one Discord user (every guild), one guild (every
// user), or everything.
export function forgetCachedMemberRoles(opts: { discordId?: string | null; guildId?: string | null } = {}): void {
  if (!opts.discordId && !opts.guildId) {
    memberRolesCache.clear()
    return
  }
  for (const key of memberRolesCache.keys()) {
    if (opts.discordId && key.endsWith(`:${opts.discordId}`)) memberRolesCache.delete(key)
    else if (opts.guildId && key.startsWith(`${opts.guildId}:`)) memberRolesCache.delete(key)
  }
}

async function addRole(discordId: string, roleId: string, reason: string): Promise<void> {
  const d = discordConfig()
  if (!d) return
  const response = await discordFetch(`/guilds/${d.guildId}/members/${discordId}/roles/${roleId}`, { method: 'PUT' }, reason)
  if (!response.ok && response.status !== 404 && response.status !== 204) {
    throw new Error(`Discord role grant failed: HTTP ${response.status}`)
  }
}

async function removeRole(discordId: string, roleId: string, reason: string): Promise<void> {
  const d = discordConfig()
  if (!d) return
  const response = await discordFetch(`/guilds/${d.guildId}/members/${discordId}/roles/${roleId}`, { method: 'DELETE' }, reason)
  if (!response.ok && response.status !== 404 && response.status !== 204) {
    throw new Error(`Discord role revoke failed: HTTP ${response.status}`)
  }
}

function welcomeEmbed(): { title: string; description: string; color: number } {
  return {
    title: 'Abstract',
    description: 'Thanks for linking your Discord with Abstract',
    color: 0x4b4b4b,
  }
}

/** Welcome DM after Discord is linked. Ignores closed DMs. */
export async function sendWelcomeDm(discordId: string): Promise<boolean> {
  if (!discordEnabled()) return false
  const embed = welcomeEmbed()
  try {
    const dmRes = await discordFetch('/users/@me/channels', {
      method: 'POST',
      body: JSON.stringify({ recipient_id: discordId }),
    })
    if (!dmRes.ok) {
      const err = await dmRes.json().catch(() => ({})) as { code?: number; message?: string }
      console.error(`[discord] welcome DM open failed for ${discordId}: HTTP ${dmRes.status}`, err.code, err.message)
      return false
    }
    const channel = (await dmRes.json()) as { id?: string }
    if (!channel.id) return false

    const msgRes = await discordFetch(`/channels/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        embeds: [
          {
            title: embed.title,
            description: embed.description,
            color: embed.color,
            footer: { text: 'Abstract' },
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    })
    if (!msgRes.ok) {
      const err = await msgRes.json().catch(() => ({})) as { code?: number; message?: string }
      console.error(`[discord] welcome DM send failed for ${discordId}: HTTP ${msgRes.status}`, err.code, err.message)
      return false
    }
    return true
  } catch (error) {
    console.error(
      `[discord] welcome DM failed for ${discordId}:`,
      error instanceof Error ? error.message : error,
    )
    return false
  }
}

export async function discordUserExists(discordId: string): Promise<boolean | 'unreachable'> {
  try {
    const response = await discordFetch(`/users/${discordId}`)
    if (response.status === 404) return false
    if (!response.ok) throw new Error(`Discord user lookup failed: HTTP ${response.status}`)
    return true
  } catch (error) {
    console.error(
      `[discord] user lookup failed for ${discordId}:`,
      error instanceof Error ? error.message : error,
    )
    return 'unreachable'
  }
}

export type DiscordUserRow = {
  id: number
  discord_id: string | null
  /** Entitlements (ai-plans.ts planForEntitlement). */
  paid_until?: Date | null
  noads_until?: Date | null
}

// Roles every linked member keeps. The retired paid-tier roles are no longer
// granted, managed or revoked here.
export function desiredEntitlementRoles(roleIds: DiscordConfig['roleIds']): Set<string> {
  const desired = new Set<string>()
  if (!roleIds) return desired
  if (roleIds.member) desired.add(roleIds.member)
  if (roleIds.holt) desired.add(roleIds.holt)
  return desired
}

export function managedEntitlementRoles(roleIds: DiscordConfig['roleIds']): string[] {
  if (!roleIds) return []
  return [roleIds.member, roleIds.holt].filter((r): r is string => Boolean(r))
}

const DISCORD_SNOWFLAKE = /^\d{17,20}$/

export function normalizeDiscordId(raw: string): string | null {
  const id = String(raw || '').trim()
  return DISCORD_SNOWFLAKE.test(id) ? id : null
}

/** Link a Discord snowflake by hand (no OAuth profile). Grants holt + entitlement roles. */
export async function linkDiscordId(
  userId: number,
  discordIdRaw: string,
): Promise<{ status: 'synced' | 'not-in-guild' | 'disabled'; discordId: string; dmSent: boolean }> {
  const discordId = normalizeDiscordId(discordIdRaw)
  if (!discordId) throw new Error('Discord ID must be a numeric snowflake (17–20 digits).')

  if (discordEnabled()) {
    const exists = await discordUserExists(discordId)
    if (exists === false) {
      throw new Error('That Discord ID does not exist. Enable Developer Mode, right-click your profile, Copy User ID.')
    }
    // exists === 'unreachable' → continue; role sync/DM will surface the real failure.
  }

  const { rows: taken } = await query<{ id: number }>(
    'SELECT id FROM users WHERE discord_id = $1 AND id <> $2',
    [discordId, userId],
  )
  if (taken.length) throw new Error('That Discord ID is already linked to another account.')

  await query(
    `UPDATE users SET discord_id = $1, discord_username = COALESCE(discord_username, $1), discord_name = COALESCE(discord_name, $1), discord_updated = NOW()
     WHERE id = $2`,
    [discordId, userId],
  )

  const { rows } = await query<DiscordUserRow>(
    'SELECT id, discord_id FROM users WHERE id = $1',
    [userId],
  )
  if (!rows[0]) throw new Error('User not found.')
  if (!discordEnabled()) return { status: 'disabled', discordId, dmSent: false }

  const status = await syncDiscordRoles(rows[0])
  const dmSent = await sendWelcomeDm(discordId).catch(() => false)
  if (status === 'no-discord') return { status: 'disabled', discordId, dmSent }
  return {
    status: status === 'synced' ? 'synced' : status === 'not-in-guild' ? 'not-in-guild' : 'disabled',
    discordId,
    dmSent,
  }
}

export async function syncDiscordRoles(user: DiscordUserRow): Promise<'synced' | 'not-in-guild' | 'no-discord' | 'disabled'> {
  const d = discordConfig()
  if (!d) return 'disabled'
  if (!user.discord_id) return 'no-discord'
  const current = await guildMemberRoles(user.discord_id)
  if (current === null) return 'not-in-guild'
  const desired = desiredEntitlementRoles(d.roleIds)
  for (const roleId of managedEntitlementRoles(d.roleIds)) {
    const has = current.includes(roleId)
    const wants = desired.has(roleId)
    if (wants && !has) await addRole(user.discord_id, roleId, 'abulxt entitlement sync: role granted')
    else if (!wants && has) await removeRole(user.discord_id, roleId, 'abulxt entitlement sync: entitlement ended')
  }
  return 'synced'
}

export function syncDiscordRolesForUser(userId: number): void {
  if (!discordEnabled()) return
  void (async () => {
    const { rows } = await query<DiscordUserRow>(
      'SELECT id, discord_id FROM users WHERE id = $1',
      [userId],
    )
    if (rows[0]) await syncDiscordRoles(rows[0])
  })().catch((error) => console.error(`[discord] role sync failed for user ${userId}:`, error instanceof Error ? error.message : error))
}

export async function userForDiscordId(discordId: string): Promise<DiscordUserRow | null> {
  const { rows } = await query<DiscordUserRow>(
    'SELECT id, discord_id, paid_until, noads_until FROM users WHERE discord_id = $1',
    [discordId],
  )
  return rows[0] || null
}

export type DiscordProfile = {
  id: string
  username: string
  globalName?: string | null
  avatar?: string | null
}

export async function linkDiscord(userId: number, profile: DiscordProfile): Promise<void> {
  await query(
    `UPDATE users SET discord_id = $1, discord_username = $2, discord_avatar = $3, discord_name = $4, discord_updated = NOW()
     WHERE id = $5`,
    [profile.id, profile.username, profile.avatar || null, profile.globalName || profile.username, userId],
  )
  const { rows } = await query<DiscordUserRow>(
    'SELECT id, discord_id FROM users WHERE id = $1',
    [userId],
  )
  if (rows[0]) {
    await syncDiscordRoles(rows[0]).catch(() => null)
    await sendWelcomeDm(profile.id).catch(() => {})
  }
}

export async function unlinkDiscord(userId: number): Promise<void> {
  const { rows } = await query<DiscordUserRow>(
    'SELECT id, discord_id FROM users WHERE id = $1',
    [userId],
  )
  const user = rows[0]
  if (user?.discord_id && discordEnabled()) {
    const d = discordConfig()!
    const current = await guildMemberRoles(user.discord_id).catch(() => null)
    if (current) {
      for (const roleId of managedEntitlementRoles(d.roleIds)) {
        if (current.includes(roleId)) {
          await removeRole(user.discord_id, roleId, 'abulxt account unlinked').catch(() => {})
        }
      }
    }
  }
  await query(
    `UPDATE users SET discord_id = NULL, discord_username = NULL, discord_avatar = NULL, discord_name = NULL, discord_updated = NOW()
     WHERE id = $1`,
    [userId],
  )
}

// Raw guild-member + user objects for the chat profile popout. Both calls use
// the bot token: GET /guilds/{g}/members/{u} (roles, nick, joined_at, guild
// avatar/banner) and GET /users/{u} (global banner + accent_color, which the
// member's embedded user object omits). Either may be null (left guild / 404).
export interface DiscordMemberProfileRaw {
  member: {
    nick?: string | null
    avatar?: string | null
    banner?: string | null
    roles?: string[]
    joined_at?: string | null
    premium_since?: string | null
    flags?: number
    avatar_decoration_data?: { asset: string; sku_id?: string | null } | null
    collectibles?: { nameplate?: { asset: string; palette?: string | null; label?: string | null; sku_id?: string | null } | null } | null
  } | null
  user: {
    id: string
    username: string
    global_name?: string | null
    avatar?: string | null
    banner?: string | null
    accent_color?: number | null
    bot?: boolean
    system?: boolean
    public_flags?: number
    avatar_decoration_data?: { asset: string; sku_id?: string | null } | null
    collectibles?: { nameplate?: { asset: string; palette?: string | null; label?: string | null; sku_id?: string | null } | null } | null
    primary_guild?: { identity_guild_id?: string | null; identity_enabled?: boolean | null; tag?: string | null; badge?: string | null } | null
    // Undocumented; parsed only when Discord includes it.
    display_name_styles?: { font_id?: number | null; effect_id?: number | null; colors?: number[] } | null
  } | null
}

export async function fetchMemberProfile(guildId: string, userId: string): Promise<DiscordMemberProfileRaw> {
  if (!discordConfig()) return { member: null, user: null }
  const [memberRes, userRes] = await Promise.all([
    discordFetch(`/guilds/${guildId}/members/${userId}`).catch(() => null),
    discordFetch(`/users/${userId}`).catch(() => null),
  ])
  const member = memberRes && memberRes.ok ? ((await memberRes.json().catch(() => null)) as DiscordMemberProfileRaw['member'] & { user?: DiscordMemberProfileRaw['user'] }) : null
  const user = userRes && userRes.ok
    ? ((await userRes.json().catch(() => null)) as DiscordMemberProfileRaw['user'])
    : (member?.user ?? null)
  return { member, user }
}
