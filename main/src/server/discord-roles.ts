// Discord REST helpers for the chat: the bot-token fetch, a member's roles in a guild (with a short shared
// cache), and the raw member/user objects behind the profile popout. Account linking and entitlement roles
// are the platform's (abulxt), not holt's.

import { getConfig } from './config.js'

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
