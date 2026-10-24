import { getConfig } from './config.js'
import { query } from './db.js'
import { cachedGuildMemberRoles } from './discord-roles.js'
import { siteChatKey, siteIdOfChatKey } from './chat-identity-key.ts'

// Chat permissions as Discord-style permission bitfields over guild roles -
// NOT site admin. "Webhooks" are the webhook delivery identities (web users and
// Discord users alike); webhook permission management is independent of site
// admin (revenue/analytics stay site-admin only).

// Permission bits (Discord bitfield convention).
export const Perm = {
  VIEW_MESSAGES: 1n << 0n,
  SEND_MESSAGES: 1n << 1n,
  TIMEOUT_WEBHOOKS: 1n << 2n, // time out other webhooks
  BAN_WEBHOOKS: 1n << 3n,     // ban other webhooks
  MANAGE_WEBHOOKS: 1n << 4n,  // manage webhook permissions (and moderate any webhook)
  SEND_EMBEDS: 1n << 5n,      // send embeds (GIFs, stickers, rich attachments) - gated to mod+
  ADD_REACTIONS: 1n << 6n,    // react to messages (Discord grants this to @everyone by default)
  MENTION_EVERYONE: 1n << 7n, // mention @everyone, @here, and all roles (Discord's single perm; NOT granted to members)
  MENTION_ROLES: 1n << 8n,    // mention individual roles (kept separate for granularity; MENTION_EVERYONE implies it)
} as const

export const MEMBER_PERMS = Perm.VIEW_MESSAGES | Perm.SEND_MESSAGES | Perm.ADD_REACTIONS
export const MOD_PERMS = MEMBER_PERMS | Perm.TIMEOUT_WEBHOOKS | Perm.SEND_EMBEDS | Perm.MENTION_EVERYONE | Perm.MENTION_ROLES
export const ADMIN_PERMS = MOD_PERMS | Perm.BAN_WEBHOOKS | Perm.MANAGE_WEBHOOKS
export const OWNER_PERMS = ADMIN_PERMS // owners == admins on bits; hierarchy is by position

export function hasPerm(bits: bigint, bit: bigint): boolean {
  return (bits & bit) !== 0n
}

export type ChatTier = 'guest' | 'member' | 'mod' | 'admin' | 'owner'

export interface ChatPerms {
  tier: ChatTier
  roleId: string | null       // highest matching chat role
  roleName: string | null
  color: string | null
  position: number            // Discord hierarchy position
  permissions: bigint         // bitfield
  // Effective guild roles (never @everyone) - the ONE role set every check
  // uses for this webhook (see resolveEffectiveRoleIds): channel visibility,
  // Discord channel permission math, bridge role overwrites, hierarchy
  // position, mention highlighting, author color and the profile popout.
  // Filled in by chatPermsForUser / chatPermsForIdentity (withEffectiveRoles
  // in discord-channel-access.ts); absent on the bare tier constants.
  roleIds?: string[]
  // The Discord member id the role set belongs to (a linked guild member),
  // null for web-only / non-member identities.
  memberId?: string | null
  // Set when the account is a site admin (users.admin). The site admin role
  // (see siteAdminRole) is folded into the effective roles, so it shows as the
  // "Admin" chip and drives role color / hierarchy like any other role.
  siteAdmin?: SiteAdminChip | null
  // A site admin in a guild with no admin-tier chat role while that guild's
  // snapshot is unavailable: no position to rank by, so the hierarchy check
  // is skipped (except against the guild owner). See withEffectiveRoles.
  hierarchyBypass?: boolean
  // This identity owns the guild the perms were resolved for (from the live
  // or last-known snapshot). Nobody can moderate the guild owner (Discord).
  guildOwner?: boolean
}

const TIER_RANK: Record<ChatTier, number> = { guest: 0, member: 1, mod: 2, admin: 3, owner: 4 }

export function tierAtLeast(tier: ChatTier, needed: ChatTier): boolean {
  return TIER_RANK[tier] >= TIER_RANK[needed]
}

// Discord's Administrator permission bypasses channel-specific overwrites:
// an admin/owner-tier webhook is never denied VIEW/SEND/ADD_REACTIONS by a
// channel overwrite. (Timeouts and channel lockdowns are NOT overwrites and
// still apply - lockdown is bypassed by staff separately at the call site.)
export function bypassesOverwrites(tier: ChatTier): boolean {
  return tier === 'admin' || tier === 'owner'
}

export function tierPermissions(tier: ChatTier): bigint {
  switch (tier) {
    case 'owner': return OWNER_PERMS
    case 'admin': return ADMIN_PERMS
    case 'mod': return MOD_PERMS
    case 'member': return MEMBER_PERMS
    default: return 0n
  }
}

interface ChatRoleRow {
  role_id: string
  role_name: string
  tier: 'member' | 'mod' | 'admin' | 'owner'
  position: number
  color: string
  permissions: string // BIGINT comes back as a string from pg
}

// Guests can read the public community chat but cannot send, matching
// Discord's read-only-by-default view of a public server you haven't joined.
const GUEST: ChatPerms = { tier: 'guest', roleId: null, roleName: null, color: null, position: -1, permissions: Perm.VIEW_MESSAGES }
const MEMBER: ChatPerms = { tier: 'member', roleId: null, roleName: null, color: null, position: 0, permissions: MEMBER_PERMS }

let lastPermDiag = 0
let lastEmptyProbe = 0
// Perm resolution failures must be diagnosable: an admin degrading to
// member/guest used to be completely silent. Log at most once a minute per
// process so a hot chat loop can't spam the journal.
function diag(message: string): void {
  const now = Date.now()
  if (now - lastPermDiag < 60_000) return
  lastPermDiag = now
  console.warn(`[chat-perms] ${message}`)
}

// The HOME guild (config.discord.guildId). Chat-role rows synced before
// migration 029 have no guild_id; they count as the home guild's.
function homeGuildId(): string {
  try {
    return getConfig().discord?.guildId || ''
  } catch {
    return ''
  }
}

// Resolve a webhook's chat permissions in ONE guild from its Discord roles
// there. Falls back to 'member' (Discord's @everyone default) when no mapped
// role matches, and to 'guest' when the user isn't a member of that guild (a
// linked account outside guild B is a guest in B, like on Discord).
export async function chatPermsForDiscord(discordId: string | null | undefined, guildId: string): Promise<ChatPerms> {
  if (!discordId) return GUEST
  const base = await discordRolePerms(discordId, guildId)
  // A Discord account linked to a site admin inherits the site-admin tier
  // (Discord-side paths: the bot's author badge, /bridge diagnose).
  const linkedAdmin = await linkedSiteAdmin(discordId)
  return applySiteAdmin(base, linkedAdmin ? await siteAdminRole(guildId) : null)
}

// Discord guild roles → chat perms, without the site-admin overlay. Role ids
// are globally unique, so matching the member's roles in `guildId` against
// the chat-role table only ever hits that guild's mapped roles.
async function discordRolePerms(discordId: string, guildId: string): Promise<ChatPerms> {
  // Shared per-guild 30s cache (one REST call per user per guild per window).
  const memberRoles = await cachedGuildMemberRoles(discordId, guildId).catch((error) => {
    diag(`guild member role fetch failed for a webhook: ${error instanceof Error ? error.message : error} - resolving as guest`)
    return null
  })
  if (memberRoles === null) return GUEST

  const { rows } = await query<ChatRoleRow>(
    `SELECT role_id, role_name, tier, position, color, permissions
     FROM discord_bridge_chat_role
     WHERE role_id = ANY($1::text[])
     ORDER BY position DESC`,
    [memberRoles],
  ).catch((error) => {
    diag(`chat role lookup failed: ${error instanceof Error ? error.message : error} - resolving as member`)
    return { rows: [] as ChatRoleRow[] }
  })

  if (!rows.length) {
    // Either the webhook holds no configured chat role (fine - @everyone), or
    // the role table was never synced (config drift - worth surfacing). Probe
    // at most once a minute so regular members don't pay for the COUNT.
    if (memberRoles.length && Date.now() - lastEmptyProbe > 60_000) {
      lastEmptyProbe = Date.now()
      const { rows: synced } = await query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM discord_bridge_chat_role`,
      ).catch(() => ({ rows: [] as Array<{ count: string }> }))
      if (synced[0] && Number(synced[0].count) === 0) {
        diag('discord_bridge_chat_role is EMPTY - no configured chat roles are synced. '
          + 'Set discord.chatRoles in config.js and restart abulxt-discord (startup runs syncChatRoles).')
      }
    }
    return MEMBER
  }

  // Discord semantics: hierarchy (who you can moderate) comes from the
  // highest-position mapped role; the permission bitfield is the UNION of all
  // mapped roles' bits, and the tier is the highest tier held (so an admin who
  // also holds a lower-position owner-mapped role - or vice versa - always
  // resolves to their most powerful tier, and ties in position can't silently
  // demote them).
  let best = rows[0]
  let bits = 0n
  let topTier: ChatTier = 'member'
  for (const row of rows) {
    bits |= BigInt(row.permissions || '0')
    if (TIER_RANK[row.tier] > TIER_RANK[topTier]) topTier = row.tier
    if (row.position > best.position
      || (row.position === best.position && TIER_RANK[row.tier] > TIER_RANK[best.tier])) {
      best = row
    }
  }
  return {
    tier: topTier,
    roleId: best.role_id,
    roleName: best.role_name,
    color: best.color || null,
    position: best.position,
    // Belt and braces: the tier's canonical bitfield is always included, so a
    // stale/partial row can never strip a tier's baseline permissions.
    permissions: bits | tierPermissions(topTier),
  }
}

// Resolve a site (abulxt) user's chat permissions in ONE bridged guild via
// their linked Discord's roles there. `guildId` is required: every caller
// resolves it from the channel (discord_bridge_channel.guild_id) or a
// validated `guild` param.
export async function chatPermsForUser(
  user: {
    id?: number | null
    discord_id?: string | null
    admin?: boolean
  } | null | undefined,
  guildId: string,
): Promise<ChatPerms> {
  if (!user) return GUEST
  const base = user.discord_id ? await discordRolePerms(user.discord_id, guildId) : GUEST
  // Site admins inherit the admin tier (applySiteAdmin), linked or not.
  const admined = applySiteAdmin(base, user.admin ? await siteAdminRole(guildId) : null)
  return withEffectiveRolesSafe(user as { id?: number | null; discord_id?: string | null }, admined, guildId)
}

// Attach the identity's effective guild roles (tier/perk-mapped chat roles ∪
// Server Onboarding grants, or a linked member's real roles) and the
// hierarchy position / name color they imply. Lives in
// discord-channel-access.ts (it needs the guild snapshot + onboarding state);
// imported lazily to keep the static import graph acyclic. Resolution
// failures keep the tier-only perms (the pre-roles behavior).
async function withEffectiveRolesSafe(
  user: { id?: number | null; discord_id?: string | null },
  perms: ChatPerms,
  guildId: string,
): Promise<ChatPerms> {
  try {
    const { withEffectiveRoles } = await import('./discord-channel-access.js')
    return await withEffectiveRoles(user, perms, guildId)
  } catch (error) {
    diag(`effective role resolution failed: ${error instanceof Error ? error.message : error} - using tier roles only`)
    return perms
  }
}

// --- Effective roles + Discord channel permission math (pure) ----------------
//
// A webhook's EFFECTIVE guild roles are the single source of truth for what it
// holds:
//   - a linked guild member: their real Discord roles (Discord already applied
//     their onboarding);
//   - anyone else (web-only, linked-but-not-in-guild, guest): the chat role
//     their tier resolved to, the configured chatRoles.member roles when the
//     tier is member+ without a mapped role (incl. the paid-perk floor), and
//     the roles their Server Onboarding answers grant (emulatedRoleIds -
//     elevated/managed roles are never emulated).
export function unionEffectiveRoles(input: {
  memberRoles: string[] | null
  chatRoleId: string | null
  tier: ChatTier
  memberFloorRoles: string[]
  onboardingRoles: string[]
  guildId?: string | null
}): string[] {
  const out = new Set<string>()
  if (input.memberRoles) {
    for (const id of input.memberRoles) out.add(id)
  } else {
    if (input.chatRoleId) out.add(input.chatRoleId)
    if (!input.chatRoleId && tierAtLeast(input.tier, 'member')) for (const id of input.memberFloorRoles) out.add(id)
    for (const id of input.onboardingRoles) out.add(id)
  }
  if (input.guildId) out.delete(input.guildId) // @everyone is implicit
  return [...out]
}

// Real Discord permission bits (NOT the chat bitfield above) that the channel
// math maps onto chat bits.
export const DiscordBit = {
  ADMINISTRATOR: 1n << 3n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MENTION_EVERYONE: 1n << 17n,
} as const

// One channel's Discord permissions for a webhook, computed over its
// effective roles (discord-channel-access.ts discordChannelBits):
//   full    - Discord's own algorithm (base = @everyone ∪ held roles, then the
//             @everyone / role / member overwrites).
//   granted - what the HELD (non-@everyone) roles contribute on their own:
//             base = held roles only, the @everyone overwrite can only deny,
//             then role + member overwrites. "This role lets you send here."
export interface DiscordChannelBits {
  full: bigint
  granted: bigint
}

// Combine a webhook's channel-agnostic chat perms with Discord's permission
// math for ONE channel. PRECEDENCE (each step only sees the previous result):
//   1. Tier bits - chat role tier (+ perk floor). Moderation bits (TIMEOUT/
//      BAN/MANAGE_WEBHOOKS) come ONLY from here (Discord's MODERATE_MEMBERS
//      etc. are guild-wide, not channel bits).
//   2. Admin/owner tiers bypass all channel math (Discord Administrator).
//   3. GRANT: VIEW / SEND / ADD_REACTIONS that a held role grants in this
//      channel (role permissions or a role overwrite allow) are added - this
//      is how an onboarding-granted role lets a web identity post. @everyone
//      alone never adds bits beyond the tier (a guest stays read-only), and
//      mention/embed bits are never granted from Discord (site policy: mod+ /
//      premium), only removed.
//   4. REMOVE: any chat bit whose Discord permission the FULL channel
//      computation lacks is stripped, with Discord's implicit denies (no
//      VIEW_CHANNEL ⇒ nothing; no SEND_MESSAGES ⇒ no mentions/embeds):
//        VIEW_CHANNEL → VIEW_MESSAGES        SEND_MESSAGES → SEND_MESSAGES
//        ADD_REACTIONS → ADD_REACTIONS       MENTION_EVERYONE → MENTION_EVERYONE
//        EMBED_LINKS → SEND_EMBEDS
//   5. (call sites) bridge webhook overwrites (discord_bridge_webhook_perm,
//      role then member, deny wins then allow) - webhookOverwrites.
//   6. (call sites) active timeout ⇒ VIEW-only (applyTimeout).
//   7. (writeDenialCore) channel lockdown ⇒ staff only.
// `discord` null = the guild snapshot / channel is unknown: no channel math
// (fail open to the tier bits, like every other Discord-side gate). Pure.
export function applyDiscordChannelPerms(perms: ChatPerms, discord: DiscordChannelBits | null): ChatPerms {
  if (!discord || bypassesOverwrites(perms.tier)) return perms
  const { full, granted } = discord
  let bits = perms.permissions
  if (granted & DiscordBit.VIEW_CHANNEL) bits |= Perm.VIEW_MESSAGES
  // (VIEW itself may come from @everyone; step 4 strips these if the full
  // computation can't VIEW.)
  if (granted & DiscordBit.SEND_MESSAGES) bits |= Perm.SEND_MESSAGES
  if (granted & DiscordBit.ADD_REACTIONS) bits |= Perm.ADD_REACTIONS
  const channelBits = Perm.VIEW_MESSAGES | Perm.SEND_MESSAGES | Perm.ADD_REACTIONS | Perm.MENTION_EVERYONE | Perm.MENTION_ROLES | Perm.SEND_EMBEDS
  if (!(full & DiscordBit.VIEW_CHANNEL)) {
    bits &= ~channelBits
  } else {
    if (!(full & DiscordBit.SEND_MESSAGES)) bits &= ~(Perm.SEND_MESSAGES | Perm.MENTION_EVERYONE | Perm.MENTION_ROLES | Perm.SEND_EMBEDS)
    if (!(full & DiscordBit.ADD_REACTIONS)) bits &= ~Perm.ADD_REACTIONS
    if (!(full & DiscordBit.MENTION_EVERYONE)) bits &= ~Perm.MENTION_EVERYONE
    if (!(full & DiscordBit.EMBED_LINKS)) bits &= ~Perm.SEND_EMBEDS
  }
  return bits === perms.permissions ? perms : { ...perms, permissions: bits }
}

// Hierarchy position from the effective roles: Discord ranks a member by
// their highest role, so a webhook sits at max(chat-role position, highest
// effective role position). Pure.
export function effectivePosition(perms: Pick<ChatPerms, 'position'>, rolePositions: number[]): number {
  return rolePositions.reduce((max, p) => (p > max ? p : max), perms.position)
}

// --- Site admins -------------------------------------------------------------
//
// users.admin inherits the chat ADMIN tier: a site admin resolves to at least
// the admin tier (ADMIN_PERMS, which already contains the member and mod bits,
// so every lower permission is inherited explicitly via the union below) and
// bypasses channel overwrites like a Discord admin. The tier never goes above
// admin: an owner-tier holder keeps owner. Ban and timeout still apply.
//
// The hierarchy position is the highest admin-tier chat role position (the
// top of the admin tier), or the highest member/mod position + 1 when no admin
// chat role is configured, so a site admin outranks mods and members. Role
// positions only compare within one guild, so all of this is per guild.

export interface SiteAdminChip {
  roleId: string | null   // the admin-tier chat role id (null when unconfigured)
  name: string
  color: string | null
  position: number
}
export type SiteAdminRole = SiteAdminChip

const siteAdminRoleCache = new Map<string, { expires: number; value: SiteAdminRole }>()

// Chat-role rows of one guild (NULL guild_id = the home guild, see
// homeGuildId). $1 = guild id, $2 = home guild id.
const CHAT_ROLE_GUILD = '(guild_id = $1 OR (guild_id IS NULL AND $1 = $2))'

export async function siteAdminRole(guildId: string): Promise<SiteAdminRole> {
  const hit = siteAdminRoleCache.get(guildId)
  if (hit && hit.expires > Date.now()) return hit.value
  const { rows } = await query<{ role_id: string; role_name: string; color: string | null; position: number }>(
    `SELECT role_id, role_name, color, position FROM discord_bridge_chat_role
     WHERE tier = 'admin' AND ${CHAT_ROLE_GUILD} ORDER BY position DESC LIMIT 1`,
    [guildId, homeGuildId()],
  ).catch(() => ({ rows: [] as Array<{ role_id: string; role_name: string; color: string | null; position: number }> }))
  let value: SiteAdminRole
  if (rows[0]) {
    value = { roleId: rows[0].role_id, name: rows[0].role_name || 'Admin', color: rows[0].color || null, position: Number(rows[0].position) || 0 }
  } else {
    const { rows: top } = await query<{ position: number | null }>(
      `SELECT MAX(position) AS position FROM discord_bridge_chat_role WHERE tier IN ('member', 'mod') AND ${CHAT_ROLE_GUILD}`,
      [guildId, homeGuildId()],
    ).catch(() => ({ rows: [] as Array<{ position: number | null }> }))
    value = { roleId: null, name: 'Admin', color: null, position: (Number(top[0]?.position ?? 0) || 0) + 1 }
  }
  siteAdminRoleCache.set(guildId, { expires: Date.now() + 60_000, value })
  return value
}

// Discord account linked to a site admin account (users.admin).
async function linkedSiteAdmin(discordId: string): Promise<boolean> {
  const { rows } = await query<{ admin: boolean }>(
    `SELECT admin FROM users WHERE discord_id = $1 LIMIT 1`,
    [discordId],
  ).catch(() => ({ rows: [] as Array<{ admin: boolean }> }))
  return rows[0]?.admin === true
}

// Pure: lift perms to the site-admin tier. `admin` null = not a site admin
// (perms returned unchanged). Permissions are the union of the current bits,
// the admin tier's canonical bitfield (which includes member and mod bits)
// and the admin bits, so no lower permission is lost.
export function applySiteAdmin(perms: ChatPerms, admin: SiteAdminRole | null): ChatPerms {
  if (!admin) return perms
  const tier: ChatTier = tierAtLeast(perms.tier, 'admin') ? perms.tier : 'admin'
  return {
    ...perms,
    tier,
    permissions: perms.permissions | tierPermissions(tier) | ADMIN_PERMS,
    position: Math.max(perms.position, admin.position),
    color: perms.color || admin.color,
    siteAdmin: { roleId: admin.roleId, name: admin.name, color: admin.color, position: admin.position },
  }
}

// --- Webhook identities ------------------------------------------------------
//
// One target-identity model for every moderation action. A webhook is either
// a site account (web-originated rows: author_key `user:<id>`) or a Discord
// user (Discord-originated rows: `discord:<id>`). A site account with a linked
// Discord is ONE webhook: both keys resolve to the same identity, so a
// timeout/ban/overwrite issued against either side applies to both.
//
//   WebhookTarget   - what a caller names (parsed from an author key / id).
//   WebhookSubject  - both sides of a resolved identity (either may be null).
//   WebhookIdentity - a resolved subject + display name + site perk fields.

// A webhook identity: a site account, a Discord user, or (holt proxy embedding) an identity from another
// platform, keyed `<namespace>:<subject>` (for example `nocturne:u_77`). `abulxt:<n>` is the site account n.
export type WebhookTarget = { kind: 'site'; userId: number } | { kind: 'discord'; discordId: string } | { kind: 'ext'; key: string }

export interface WebhookSubject {
  userId: number | null
  discordId: string | null
  /** Another platform's identity (`<namespace>:<subject>`), or null. Never a site or Discord key. */
  extKey: string | null
}

export interface WebhookSiteUser {
  id: number
  username: string
  admin: boolean
  discord_id: string | null
  discord_name?: string | null
  chat_display_name?: string | null
}

export interface WebhookIdentity extends WebhookSubject {
  name: string
  user: WebhookSiteUser | null
}

const SNOWFLAKE_RE = /^\d{15,22}$/
const EXT_KEY_RE = /^([a-z][a-z0-9-]{0,31}):([A-Za-z0-9._-]{1,128})$/
/** Namespaces that are not another platform: this site's own keys, Discord, guests, holt itself. */
const RESERVED_NAMESPACES = new Set(['user', 'discord', 'guest', 'holt'])
/** This site's namespace in holt: `abulxt:<n>` is the site account n. */
const SITE_NAMESPACE = 'abulxt'

/** `<namespace>:<subject>` for another platform's identity, or null when `raw` is not one. Pure. */
export function extKeyOf(raw: string): string | null {
  const match = EXT_KEY_RE.exec(raw)
  if (!match || RESERVED_NAMESPACES.has(match[1]) || match[1] === SITE_NAMESPACE) return null
  return raw
}

// Parse a target as the client / slash commands name it: an author key
// (`user:<siteId>` / `discord:<snowflake>`) or a bare Discord snowflake.
export function parseWebhookTarget(raw: unknown): WebhookTarget | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  // `abulxt:<n>` (since migration 037) or the legacy `user:<n>`: the site account n.
  if (/^(?:abulxt|user):/.test(value)) {
    const userId = siteIdOfChatKey(value)
    return userId === null ? null : { kind: 'site', userId }
  }
  const discord = /^discord:(\d{15,22})$/.exec(value)
  if (discord) return { kind: 'discord', discordId: discord[1] }
  if (SNOWFLAKE_RE.test(value)) return { kind: 'discord', discordId: value }
  const ext = extKeyOf(value)
  return ext ? { kind: 'ext', key: ext } : null
}

// The caller's own webhook subject (a signed-in site user).
export function subjectOfUser(user: { id?: number | null; discord_id?: string | null } | null | undefined): WebhookSubject {
  return { userId: user?.id ?? null, discordId: user?.discord_id || null, extKey: null }
}

// Every author/reactor key this webhook appears under.
export function webhookKeys(subject: WebhookSubject): string[] {
  const keys: string[] = []
  if (subject.userId !== null) keys.push(siteChatKey(subject.userId))
  if (subject.discordId) keys.push(`discord:${subject.discordId}`)
  if (subject.extKey) keys.push(subject.extKey)
  return keys
}

// The canonical key for one identity (events, audit log): the site key when
// there is a site account, else the Discord key.
export function webhookKey(subject: WebhookSubject): string {
  return webhookKeys(subject)[0] || ''
}

// Same webhook? (Linked accounts match on either side.)
export function sameWebhook(a: WebhookSubject, b: WebhookSubject): boolean {
  return (a.userId !== null && a.userId === b.userId)
    || (Boolean(a.discordId) && a.discordId === b.discordId)
    || (Boolean(a.extKey) && a.extKey === b.extKey)
}

const SITE_USER_COLS = 'id, username, admin, discord_id, discord_name, chat_display_name'

// Resolve a target both ways: a site account pulls its linked Discord id; a
// Discord id pulls the site account it is linked to (if any). null = unknown
// site account (Discord ids always resolve - the user may not have linked).
export async function resolveWebhookTarget(target: WebhookTarget): Promise<WebhookIdentity | null> {
  // Another platform's identity has no site account and no Discord side. Its display name comes with its
  // messages (holt), so the key's subject stands in until then.
  if (target.kind === 'ext') {
    return { userId: null, discordId: null, extKey: target.key, name: target.key.slice(target.key.indexOf(':') + 1), user: null }
  }
  if (target.kind === 'site') {
    const { rows } = await query<WebhookSiteUser>(`SELECT ${SITE_USER_COLS} FROM users WHERE id = $1`, [target.userId])
    const user = rows[0]
    if (!user) return null
    return { userId: user.id, discordId: user.discord_id || null, extKey: null, name: user.username, user }
  }
  const { rows } = await query<WebhookSiteUser>(`SELECT ${SITE_USER_COLS} FROM users WHERE discord_id = $1`, [target.discordId])
    .catch(() => ({ rows: [] as WebhookSiteUser[] }))
  const user = rows[0] || null
  const member = await query<{ display_name: string; username: string }>(
    `SELECT display_name, username FROM discord_bridge_guild_member WHERE user_id = $1 LIMIT 1`,
    [target.discordId],
  ).then((r) => r.rows[0]).catch(() => undefined)
  return {
    userId: user ? user.id : null,
    discordId: target.discordId,
    extKey: null,
    name: member?.display_name || member?.username || user?.discord_name || user?.username || target.discordId,
    user,
  }
}

// A resolved webhook's chat perms in one guild: site accounts go through
// chatPermsForUser (linked Discord roles); Discord-only
// identities through their roles in that guild.
export async function chatPermsForIdentity(identity: WebhookIdentity, guildId: string): Promise<ChatPerms> {
  if (identity.user) return chatPermsForUser(identity.user, guildId)
  return withEffectiveRolesSafe({ id: null, discord_id: identity.discordId }, await chatPermsForDiscord(identity.discordId, guildId), guildId)
}

// A site account's Discord-side state changed: its effective roles, channel
// visibility, perms and author color may have too. Targeted bridge.perms.changed (keys + userId,
// no discordId) so only that webhook's sockets refresh perms + sidebar, and
// the app server drops its cached views of it. Best-effort.
export async function emitWebhookPermsChanged(userId: number): Promise<void> {
  try {
    const { rows } = await query<{ discord_id: string | null }>(`SELECT discord_id FROM users WHERE id = $1`, [userId])
    const keys = webhookKeys({ userId, discordId: rows[0]?.discord_id || null, extKey: null })
    const { DISCORD_BRIDGE_OWNER_KEY, emit } = await import('./events.js')
    // guildId null: perks apply in every bridged guild.
    await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.perms.changed', { userId, keys, reason: 'perks', guildId: null })
  } catch {
    // Realtime refresh is best-effort; the 45s visibility refresh catches up.
  }
}

// Hierarchy check: an actor can't moderate a webhook at or above their own
// position (mirrors Discord role hierarchy). Owners outrank admins by
// position; the guild owner can't be moderated at all; a site admin with
// hierarchyBypass (no rankable position in that guild) passes otherwise. Pure.
export function canModerate(
  actor: Pick<ChatPerms, 'position' | 'hierarchyBypass'>,
  target: Pick<ChatPerms, 'position' | 'guildOwner'>,
): boolean {
  if (target.guildOwner) return false
  if (actor.hierarchyBypass) return true
  return actor.position > target.position
}

// --- Timeouts --------------------------------------------------------------

export interface ActiveTimeout {
  id: number
  channelId: string
  subject: string
  reason: string
  issuedByName: string
  timeoutUntil: string
}

// Rows are keyed (subject_type, subject): 'discord' + snowflake or 'site' +
// site user id (migration 020). A linked identity matches either row.
export async function activeTimeout(channelId: string, subject: WebhookSubject): Promise<ActiveTimeout | null> {
  if (subject.userId === null && !subject.discordId && !subject.extKey) return null
  const row = await query<{ id: string; channel_id: string; subject: string; subject_type: string; reason: string; issued_by_name: string; timeout_until: Date }>(
    `SELECT id, channel_id, subject, subject_type, reason, issued_by_name, timeout_until
     FROM discord_bridge_timeout
     WHERE channel_id = $1 AND revoked_at IS NULL AND timeout_until > NOW()
       AND ((subject_type = 'discord' AND subject = $2) OR (subject_type = 'site' AND subject = $3)
            OR (subject_type = 'ext' AND subject = $4))
     ORDER BY timeout_until DESC LIMIT 1`,
    [channelId, subject.discordId || '', subject.userId === null ? '' : String(subject.userId), subject.extKey || ''],
  ).then((r) => r.rows[0]).catch(() => undefined)
  if (!row) return null
  return {
    id: Number(row.id),
    channelId: row.channel_id,
    subject: row.subject_type === 'site' ? siteChatKey(Number(row.subject)) : row.subject_type === 'ext' ? row.subject : `discord:${row.subject}`,
    reason: row.reason,
    issuedByName: row.issued_by_name,
    timeoutUntil: row.timeout_until.toISOString(),
  }
}

// A timed-out webhook's permissions collapse to VIEW-ONLY, mirroring a
// Discord "muted"/timed-out member: they can read the channel but can't send,
// react, or mention. Timeouts are per-channel, so this reduction is applied
// per-channel at the endpoint (where the active-timeout lookup already lives),
// not inside chatPermsForUser/chatPermsForDiscord (which are channel-agnostic).
//
// Strip every actionable bit and keep only VIEW_MESSAGES so ALL endpoints -
// send, react, mention - reject a timed-out webhook uniformly when they gate
// on the reduced bitfield. Staff moderation bits (TIMEOUT/BAN/MANAGE) are also
// stripped: a timed-out webhook can't moderate while muted, matching Discord.
export function timeoutReducedPermissions(bits: bigint): bigint {
  return bits & Perm.VIEW_MESSAGES
}

// Apply an active timeout (or none) to resolved perms. Pure.
export function applyTimeout(perms: ChatPerms, timeout: ActiveTimeout | null): ChatPerms {
  return timeout ? { ...perms, permissions: timeoutReducedPermissions(perms.permissions) } : perms
}

// Resolve a webhook's effective chat perms for a channel with any active
// timeout applied: if the webhook (either side of a linked identity) is
// currently timed out in this channel, their bitfield is reduced to
// VIEW-only. Returns the (possibly reduced) ChatPerms plus the active timeout
// (null when not timed out). Centralizing this keeps every endpoint's
// muted-webhook behavior identical for web-only, linked, and Discord webhooks.
export async function chatPermsForChannel(
  perms: ChatPerms,
  channelId: string,
  subject: WebhookSubject,
): Promise<{ perms: ChatPerms; timeout: ActiveTimeout | null }> {
  const timeout = await activeTimeout(channelId, subject)
  return { perms: applyTimeout(perms, timeout), timeout }
}

// One row per side of the identity. An 'ext' row needs the subject_type CHECK widened (holt phase 1 step 3);
// until then writing one fails at the database instead of silently skipping the ext side.
function subjectRows(subject: WebhookSubject): Array<['discord' | 'site' | 'ext', string]> {
  const rows: Array<['discord' | 'site' | 'ext', string]> = []
  if (subject.discordId) rows.push(['discord', subject.discordId])
  if (subject.userId !== null) rows.push(['site', String(subject.userId)])
  if (subject.extKey) rows.push(['ext', subject.extKey])
  return rows
}

// Issue a timeout against EVERY side of the identity (site row + Discord row
// for a linked account) so it survives a later link/unlink.
export async function issueTimeout(input: {
  channelId: string
  subject: WebhookSubject
  subjectName: string
  reason: string
  issuedBy: string
  issuedByName: string
  until: Date
}): Promise<void> {
  await revokeTimeout(input.channelId, input.subject)
  for (const [type, subject] of subjectRows(input.subject)) {
    await query(
      `INSERT INTO discord_bridge_timeout (channel_id, subject_type, subject, subject_name, reason, issued_by, issued_by_name, timeout_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [input.channelId, type, subject, input.subjectName, input.reason, input.issuedBy, input.issuedByName, input.until],
    )
  }
}

export async function revokeTimeout(channelId: string, subject: WebhookSubject): Promise<number> {
  const { rowCount } = await query(
    `UPDATE discord_bridge_timeout SET revoked_at = NOW()
     WHERE channel_id = $1 AND revoked_at IS NULL
       AND ((subject_type = 'discord' AND subject = $2) OR (subject_type = 'site' AND subject = $3)
            OR (subject_type = 'ext' AND subject = $4))`,
    [channelId, subject.discordId || '', subject.userId === null ? '' : String(subject.userId), subject.extKey || ''],
  )
  return rowCount ?? 0
}

// --- Webhook permission overrides ------------------------------------------

export interface EffectiveOverwrite {
  view: boolean
  send: boolean
  react: boolean
}

// Discord overwrite resolution over a base bitfield: role overwrites (deny
// then allow), then the member's own overwrite (deny then allow). Pure.
export function resolveOverwrites(
  base: bigint,
  role: { allow: bigint; deny: bigint },
  member: { allow: bigint; deny: bigint },
): EffectiveOverwrite {
  let bits = (base & ~role.deny) | role.allow
  bits = (bits & ~member.deny) | member.allow
  return {
    view: hasPerm(bits, Perm.VIEW_MESSAGES),
    send: hasPerm(bits, Perm.SEND_MESSAGES),
    react: hasPerm(bits, Perm.ADD_REACTIONS),
  }
}

const ALL_ALLOWED: EffectiveOverwrite = { view: true, send: true, react: true }

// The member-level overwrite rows for one webhook: Discord-user rows
// (subject_type 'user') and site-account rows (subject_type 'site',
// migration 020) are merged, so an overwrite on either side of a linked
// identity applies.
export async function memberOverwrite(channelId: string, subject: WebhookSubject): Promise<{ allow: bigint; deny: bigint }> {
  let allow = 0n
  let deny = 0n
  if (subject.userId === null && !subject.discordId && !subject.extKey) return { allow, deny }
  const rows = await query<{ allow: string; deny: string }>(
    `SELECT allow, deny FROM discord_bridge_webhook_perm
     WHERE channel_id = $1
       AND ((subject_type = 'user' AND subject = $2) OR (subject_type = 'site' AND subject = $3)
            OR (subject_type = 'ext' AND subject = $4))`,
    [channelId, subject.discordId || '', subject.userId === null ? '' : String(subject.userId), subject.extKey || ''],
  ).then((r) => r.rows).catch(() => [] as Array<{ allow: string; deny: string }>)
  for (const r of rows) { allow |= BigInt(r.allow || '0'); deny |= BigInt(r.deny || '0') }
  return { allow, deny }
}

// Compute the effective VIEW/SEND/ADD_REACTIONS bits for a webhook in a
// channel, applying role-level then member-level allow/deny overwrites
// (deny wins, then allow, matching Discord's overwrite resolution).
//
// `subject` is the webhook (site account and/or Discord id). `actorPerms` is
// its resolved chat perms (chatPermsForUser / chatPermsForIdentity):
//   1. Admin/owner tiers bypass overwrites entirely (Discord's Administrator
//      permission semantics) - a deny overwrite can NEVER strip their bits.
//   2. The base bitfield is the webhook's own tier bitfield (a mod's
//      SEND_MESSAGES can only be taken away by an explicit deny).
export async function webhookOverwrites(
  channelId: string,
  subject: WebhookSubject,
  roleIds: string[],
  actorPerms?: Pick<ChatPerms, 'tier' | 'permissions'>,
): Promise<EffectiveOverwrite> {
  // When the caller didn't pass resolved perms, resolve them from the
  // Discord id so legacy call sites get the bypass too. `roleIds` should be
  // the webhook's EFFECTIVE roles (perms.roleIds) so a role overwrite on an
  // onboarding-granted role applies to web identities too.
  let perms = actorPerms
  if (!perms && subject.discordId) {
    // Legacy call sites: resolve in the channel's own guild.
    const guildId = await query<{ guild_id: string }>(`SELECT guild_id FROM discord_bridge_channel WHERE channel_id = $1`, [channelId])
      .then((r) => r.rows[0]?.guild_id || homeGuildId()).catch(() => homeGuildId())
    const resolved = guildId ? await chatPermsForDiscord(subject.discordId, guildId).catch(() => null) : null
    if (resolved) perms = resolved
  }
  if (perms && bypassesOverwrites(perms.tier)) return { ...ALL_ALLOWED }

  let roleAllow = 0n
  let roleDeny = 0n
  if (roleIds.length) {
    const roleRows = await query<{ allow: string; deny: string }>(
      `SELECT allow, deny FROM discord_bridge_webhook_perm
       WHERE channel_id = $1 AND subject_type = 'role' AND subject = ANY($2::text[])`,
      [channelId, roleIds],
    ).then((r) => r.rows).catch(() => [] as Array<{ allow: string; deny: string }>)
    for (const r of roleRows) { roleAllow |= BigInt(r.allow || '0'); roleDeny |= BigInt(r.deny || '0') }
  }
  const member = await memberOverwrite(channelId, subject)
  return resolveOverwrites(perms ? perms.permissions : MEMBER_PERMS, { allow: roleAllow, deny: roleDeny }, member)
}

// subject_type: 'role' (chat role id), 'user' (Discord user id), 'site'
// (site account id, migration 020).
export async function setWebhookPerm(input: {
  channelId: string
  subjectType: 'user' | 'role' | 'site' | 'ext'
  subject: string
  allow: bigint
  deny: bigint
  createdBy: string
}): Promise<void> {
  await query(
    `INSERT INTO discord_bridge_webhook_perm (channel_id, subject_type, subject, allow, deny, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (channel_id, subject_type, subject)
     DO UPDATE SET allow = EXCLUDED.allow, deny = EXCLUDED.deny, created_by = EXCLUDED.created_by, created_at = NOW()`,
    [input.channelId, input.subjectType, input.subject, input.allow.toString(), input.deny.toString(), input.createdBy],
  )
}

// Set one webhook's member overwrite on every side of its identity (site row
// + Discord row for a linked account), so the overwrite follows the identity.
export async function setWebhookMemberPerm(input: {
  channelId: string
  subject: WebhookSubject
  allow: bigint
  deny: bigint
  createdBy: string
}): Promise<void> {
  if (input.subject.discordId) {
    await setWebhookPerm({ channelId: input.channelId, subjectType: 'user', subject: input.subject.discordId, allow: input.allow, deny: input.deny, createdBy: input.createdBy })
  }
  if (input.subject.userId !== null) {
    await setWebhookPerm({ channelId: input.channelId, subjectType: 'site', subject: String(input.subject.userId), allow: input.allow, deny: input.deny, createdBy: input.createdBy })
  }
  // Fails at the database until the subject_type CHECK allows 'ext' (holt phase 1 step 3): loud, not skipped.
  if (input.subject.extKey) {
    await setWebhookPerm({ channelId: input.channelId, subjectType: 'ext', subject: input.subject.extKey, allow: input.allow, deny: input.deny, createdBy: input.createdBy })
  }
}

// --- Shared write gate --------------------------------------------------------
//
// Every write path (send, edit, forward, typing, react, own-message
// delete/suppress, staff message management, moderation) resolves the same
// inputs and asks this one pure function whether the caller may act, so the
// paths can't drift. The async resolver lives in discord-bridge-api.ts
// (writeDenial); this core is unit-tested directly.

export type WriteAction =
  | 'send'            // POST /send
  | 'edit'            // POST /edit (same gate as send, at edit time)
  | 'forward'         // POST /forward (destination channel)
  | 'typing'          // POST /typing
  | 'react'           // POST /react (ADD_REACTIONS, not SEND)
  | 'own-message'     // delete / suppress-embeds on your own message
  | 'manage-messages' // pin / delete / suppress anyone's message (Manage Messages)
  | 'moderate'        // timeout / ban / overwrites / lockdown (bits checked per action)

export interface WriteGateInput {
  action: WriteAction
  /** Channel-effective perms (timeout-reduced via applyTimeout). */
  perms: ChatPerms
  emailVerified: boolean
  /** Active bridge ban reason (site account, linked Discord, or IP), or null. */
  banned: string | null
  /** Discord VIEW_CHANNEL (live roles + channel overwrites). */
  discordView: boolean
  overwrite: EffectiveOverwrite
  locked: boolean
  timeout: ActiveTimeout | null
}

export interface WriteDenial {
  status: number
  body: Record<string, unknown>
}

const MISSING_ACCESS = 50001
const MISSING_PERMISSIONS = 50013

export function isChatStaff(bits: bigint): boolean {
  return hasPerm(bits, Perm.TIMEOUT_WEBHOOKS) || hasPerm(bits, Perm.MANAGE_WEBHOOKS)
}

export function canManageMessages(bits: bigint): boolean {
  return hasPerm(bits, Perm.MANAGE_WEBHOOKS) || hasPerm(bits, Perm.BAN_WEBHOOKS)
}

export function writeDenialCore(input: WriteGateInput): WriteDenial | null {
  const { action, perms } = input
  const composing = action === 'send' || action === 'edit' || action === 'forward' || action === 'typing'
  if (composing && !input.emailVerified) {
    return { status: 403, body: { error: 'Verify your email to chat.', requiresVerification: true } }
  }
  if (input.banned) return { status: 403, body: { error: input.banned, code: MISSING_PERMISSIONS, banned: true } }
  if (!input.discordView || !hasPerm(perms.permissions, Perm.VIEW_MESSAGES) || !input.overwrite.view) {
    return { status: 403, body: { error: 'You do not have permission to view this channel.', code: MISSING_ACCESS } }
  }
  // Discord: a timed-out member keeps only VIEW/READ_HISTORY (they may still
  // delete their own messages).
  if (input.timeout && action !== 'own-message') {
    return { status: 403, body: { error: 'You are timed out in this channel.', code: MISSING_PERMISSIONS, timeout: input.timeout } }
  }
  if (composing) {
    if (!hasPerm(perms.permissions, Perm.SEND_MESSAGES) || !input.overwrite.send) {
      return { status: 403, body: { error: 'You do not have permission to send messages in this channel.', code: MISSING_PERMISSIONS } }
    }
    if (input.locked && !isChatStaff(perms.permissions)) {
      return { status: 403, body: { error: 'This channel is locked.', code: MISSING_PERMISSIONS, locked: true } }
    }
    return null
  }
  if (action === 'react') {
    if (!hasPerm(perms.permissions, Perm.ADD_REACTIONS) || !input.overwrite.react) {
      return { status: 403, body: { error: 'You do not have permission to react in this channel.', code: MISSING_PERMISSIONS } }
    }
    return null
  }
  if (action === 'manage-messages' && !canManageMessages(perms.permissions)) {
    return { status: 403, body: { error: 'Missing Permissions', code: MISSING_PERMISSIONS } }
  }
  return null
}

// Moderation bits + hierarchy for one action against one target. Pure.
export type ModerationAction = 'timeout' | 'untimeout' | 'ban' | 'unban' | 'webhook-perm'

export function moderationDenial(
  action: ModerationAction,
  actor: { perms: ChatPerms; subject: WebhookSubject },
  target: { perms: ChatPerms; subject: WebhookSubject },
): string | null {
  const bits = actor.perms.permissions
  const manage = hasPerm(bits, Perm.MANAGE_WEBHOOKS)
  if ((action === 'timeout' || action === 'untimeout') && !hasPerm(bits, Perm.TIMEOUT_WEBHOOKS) && !manage) {
    return 'You do not have permission to time out webhooks.'
  }
  if ((action === 'ban' || action === 'unban') && !hasPerm(bits, Perm.BAN_WEBHOOKS) && !manage) {
    return 'You do not have permission to ban webhooks.'
  }
  if (action === 'webhook-perm' && !manage) return 'You do not have permission to manage webhook permissions.'
  if (sameWebhook(actor.subject, target.subject)) return 'You cannot moderate yourself.'
  // Discord: lifting a ban needs only BAN_MEMBERS (the banned user has no
  // standing in the hierarchy); everything else respects role position.
  if (action !== 'unban' && !canModerate(actor.perms, target.perms)) {
    return 'You cannot moderate a webhook at or above your own role.'
  }
  return null
}

// --- Role sync --------------------------------------------------------------

// Sync the configured chat roles (config.discord.chatRoles) into the role
// table, refreshing names/positions/colors from the live role lists of the
// home guild, every bridged guild, and `extraGuildIds` (guilds the bridge bot
// just resolved). chatRoles may list role ids from any of those guilds; each
// row is stamped with the guild the role was found in (migration 029).
export async function syncChatRoles(extraGuildIds: string[] = []): Promise<number> {
  const d = getConfig().discord
  if (!d?.botToken || !d.guildId) return 0
  const chatRoles = d.chatRoles || {}
  const tiers: Array<['member' | 'mod' | 'admin' | 'owner', string[]]> = [
    ['member', chatRoles.member || []],
    ['mod', chatRoles.mod || []],
    ['admin', chatRoles.admin || []],
    ['owner', chatRoles.owner || []],
  ]
  const wanted = new Map<string, 'member' | 'mod' | 'admin' | 'owner'>()
  for (const [tier, ids] of tiers) {
    for (const id of ids) {
      // A role id listed under two tiers keeps the HIGHER tier (a duplicate
      // entry in config must never demote anyone).
      const existing = wanted.get(id)
      if (!existing || TIER_RANK[tier] > TIER_RANK[existing]) wanted.set(id, tier)
    }
  }
  if (!wanted.size) {
    console.warn('[chat-perms] discord.chatRoles is empty - every webhook will resolve to the member/guest default. '
      + 'Map the guild admin/mod role ids to tiers in config.js.')
    return 0
  }

  const bridged = await query<{ guild_id: string }>(
    `SELECT DISTINCT guild_id FROM discord_bridge_channel WHERE enabled = TRUE AND guild_id <> ''`,
  ).then((r) => r.rows.map((row) => row.guild_id)).catch(() => [] as string[])
  const guildIds = [...new Set([d.guildId, ...bridged, ...extraGuildIds].filter(Boolean))]
  const byId = new Map<string, { id: string; name: string; position: number; color: number; guildId: string }>()
  let homeOk = false
  let anyFailed = false
  for (const guildId of guildIds) {
    const response = await fetch(`https://discord.com/api/v10/guilds/${guildId}/roles`, {
      headers: { Authorization: `Bot ${d.botToken}` },
    }).catch((error) => {
      console.error(`[chat-perms] chat-role sync: guild ${guildId} role fetch errored: ${error instanceof Error ? error.message : error}`)
      return null
    })
    if (!response) { anyFailed = true; continue }
    if (!response.ok) {
      console.error(`[chat-perms] chat-role sync: guild ${guildId} role fetch returned HTTP ${response.status} - check the bot token and that the bot is in that guild.`)
      anyFailed = true
      continue
    }
    if (guildId === d.guildId) homeOk = true
    const roles = (await response.json()) as Array<{ id: string; name: string; position: number; color: number }>
    for (const r of roles) byId.set(r.id, { ...r, guildId })
  }
  if (!byId.size) {
    console.error('[chat-perms] chat-role sync FAILED: no guild role list could be fetched.')
    return 0
  }
  if (!homeOk) console.error('[chat-perms] chat-role sync: the HOME guild role list failed; its roles keep their stored names/positions.')

  let synced = 0
  const missing: string[] = []
  for (const [roleId, tier] of wanted) {
    const live = byId.get(roleId)
    if (!live) {
      missing.push(roleId)
      // A guild's role list failed: keep the stored row rather than
      // overwrite its name/position with placeholders.
      if (anyFailed) continue
    }
    const color = live ? `#${live.color.toString(16).padStart(6, '0')}` : ''
    const permissions = tierPermissions(tier)
    await query(
      `INSERT INTO discord_bridge_chat_role (role_id, role_name, tier, position, color, permissions, guild_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (role_id) DO UPDATE SET
         role_name = EXCLUDED.role_name,
         tier = EXCLUDED.tier,
         position = EXCLUDED.position,
         color = EXCLUDED.color,
         permissions = EXCLUDED.permissions,
         guild_id = COALESCE(EXCLUDED.guild_id, discord_bridge_chat_role.guild_id),
         updated_at = NOW()`,
      [roleId, live?.name || roleId, tier, live?.position ?? 0, color, permissions.toString(), live?.guildId ?? null],
    )
    synced++
  }
  // Positions changed: drop the per-guild derived caches.
  siteAdminRoleCache.clear()
  if (missing.length) {
    console.error(`[chat-perms] ${missing.length} configured chat role id(s) do NOT exist in any bridged guild: ${missing.join(', ')} - fix discord.chatRoles in config.js.`)
  }
  console.log(`[chat-perms] synced ${synced} chat role(s): ${[...wanted.entries()].map(([id, tier]) => `${tier}:${byId.get(id)?.name || id}`).join(', ')}`)
  return synced
}
