import { query } from './db.js'
import type { RoleColorsJson } from './discord-bridge-db.js'

// Discord author cosmetics for the web chatbox, resolved from the bot-synced
// guild directory (discord_bridge_guild_member + discord_bridge_guild_role,
// migration 019_discord_bridge_author_style). Everything here is data a bot
// can actually read from the API:
//   - enhanced role colors (role.colors primary/secondary/tertiary) of the
//     member's color role → Discord's gradient / holographic username style
//   - avatar_decoration_data (guild-member decoration first, then the user's)
//   - collectibles.nameplate
//   - primary_guild (server tag chiplet)
//   - display_name_styles (font id), when the gateway includes it
//   - joined_at + member flags (DID_REJOIN) + bot → new-member badge
// Web (webhook) authors get only what their EFFECTIVE roles imply (name
// color incl. gradient role colors - webAuthorStyle): no decoration,
// nameplate, server tag or font, since Discord renders webhook deliveries
// without member cosmetics. Their new-member badge date is the site join
// date, stamped by discord-bridge-api's webIdentityView ("Member Since").

export interface AuthorStyle {
  /** Solid role color of the color role ('#rrggbb'), or null. */
  color: string | null
  /** Enhanced colors when the color role has a secondary color (gradient)
   *  or tertiary (holographic). null = plain solid color. */
  colors: { primary: string; secondary: string; tertiary: string | null } | null
  decoration: { asset: string; skuId: string | null } | null
  nameplate: { asset: string; palette: string | null; label: string | null; skuId: string | null } | null
  guildTag: { guildId: string; tag: string; badge: string | null } | null
  /** Display-name font id (Discord's DisplayNameFont enum), or null. */
  fontId: number | null
  joinedAt: string | null
  /** Member flag DID_REJOIN (bit 0) - Discord hides the new-member badge. */
  rejoined: boolean
  bot: boolean
}

interface MemberStyleRow {
  user_id: string
  role_ids: string[] | null
  joined_at: Date | null
  member_flags: number | null
  bot: boolean | null
  style: {
    decoration?: AuthorStyle['decoration']
    nameplate?: AuthorStyle['nameplate']
    guildTag?: AuthorStyle['guildTag']
    displayNameStyles?: { fontId?: number | null } | null
  } | null
}

interface RoleRow {
  role_id: string
  color: string | null
  position: number
  colors: RoleColorsJson | null
}

const CACHE_MS = 60_000
const cache = new Map<string, { expires: number; style: AuthorStyle | null }>()
const roleCache = new Map<string, { expires: number; roles: Map<string, RoleRow> }>()

async function guildRoles(guildId: string): Promise<Map<string, RoleRow>> {
  const hit = roleCache.get(guildId)
  if (hit && hit.expires > Date.now()) return hit.roles
  const { rows } = await query<RoleRow>(
    `SELECT role_id, color, position, colors FROM discord_bridge_guild_role WHERE guild_id = $1`,
    [guildId],
  ).catch(() => ({ rows: [] as RoleRow[] }))
  const roles = new Map(rows.map((r) => [r.role_id, r]))
  roleCache.set(guildId, { expires: Date.now() + CACHE_MS, roles })
  return roles
}

function isColored(role: RoleRow): boolean {
  const c = role.color ? role.color.toLowerCase() : ''
  return Boolean((c && c !== '#000000') || role.colors?.primary)
}

/** Discord's color role: the highest-positioned held role with a color. */
export function colorRoleOf(roleIds: string[], roles: Map<string, RoleRow>): RoleRow | null {
  let best: RoleRow | null = null
  for (const id of roleIds) {
    const role = roles.get(id)
    if (role && isColored(role) && (!best || role.position > best.position)) best = role
  }
  return best
}

export function roleColorsFor(role: { color: string | null; colors?: RoleColorsJson | null } | null): AuthorStyle['colors'] {
  const c = role?.colors
  if (!c?.primary || !c.secondary) return null
  return { primary: c.primary, secondary: c.secondary, tertiary: c.tertiary || null }
}

function toStyle(row: MemberStyleRow, roles: Map<string, RoleRow>): AuthorStyle {
  const colorRole = colorRoleOf(row.role_ids || [], roles)
  const solid = colorRole ? (colorRole.colors?.primary || colorRole.color) : null
  const s = row.style || {}
  const fontId = s.displayNameStyles?.fontId
  return {
    color: solid && solid.toLowerCase() !== '#000000' ? solid : null,
    colors: roleColorsFor(colorRole),
    decoration: s.decoration?.asset ? s.decoration : null,
    nameplate: s.nameplate?.asset ? s.nameplate : null,
    guildTag: s.guildTag?.tag ? s.guildTag : null,
    fontId: typeof fontId === 'number' ? fontId : null,
    joinedAt: row.joined_at ? new Date(row.joined_at).toISOString() : null,
    rejoined: ((row.member_flags ?? 0) & 1) === 1,
    bot: Boolean(row.bot),
  }
}

/** Batch style lookup for Discord user ids in a guild (60s cache). */
export async function authorStylesFor(guildId: string, userIds: string[]): Promise<Record<string, AuthorStyle | null>> {
  const out: Record<string, AuthorStyle | null> = {}
  const missing: string[] = []
  const now = Date.now()
  for (const id of new Set(userIds)) {
    const hit = cache.get(`${guildId}:${id}`)
    if (hit && hit.expires > now) out[id] = hit.style
    else missing.push(id)
  }
  if (missing.length) {
    const roles = await guildRoles(guildId)
    const { rows } = await query<MemberStyleRow>(
      `SELECT user_id, role_ids, joined_at, member_flags, bot, style
       FROM discord_bridge_guild_member WHERE guild_id = $1 AND user_id = ANY($2::text[])`,
      [guildId, missing],
    ).catch(() => ({ rows: [] as MemberStyleRow[] }))
    const found = new Map(rows.map((r) => [r.user_id, r]))
    for (const id of missing) {
      const row = found.get(id)
      const style = row ? toStyle(row, roles) : null
      out[id] = style
      cache.set(`${guildId}:${id}`, { expires: now + CACHE_MS, style })
    }
    if (cache.size > 5000) {
      for (const key of [...cache.keys()].slice(0, cache.size - 5000)) cache.delete(key)
    }
  }
  return out
}

/** Style for a single user (profile popout). */
export async function authorStyleFor(guildId: string, userId: string): Promise<AuthorStyle | null> {
  return (await authorStylesFor(guildId, [userId]))[userId] ?? null
}

/** A web (webhook) identity's style from its effective guild roles: the
 *  color role (highest-positioned colored role) incl. gradient/holographic
 *  colors; every member-only cosmetic is null. */
export async function webAuthorStyle(guildId: string, roleIds: string[]): Promise<AuthorStyle> {
  const colorRole = colorRoleOf(roleIds, await guildRoles(guildId))
  const solid = colorRole ? (colorRole.colors?.primary || colorRole.color) : null
  return {
    color: solid && solid.toLowerCase() !== '#000000' ? solid : null,
    colors: roleColorsFor(colorRole),
    decoration: null,
    nameplate: null,
    guildTag: null,
    fontId: null,
    joinedAt: null,
    rejoined: false,
    bot: false,
  }
}
