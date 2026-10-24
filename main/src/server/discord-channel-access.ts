import { getConfig, loadConfig } from './config.js'
import { query } from './db.js'
import {
  Perm,
  bypassesOverwrites,
  chatPermsForUser,
  effectivePosition,
  hasPerm,
  subjectOfUser,
  unionEffectiveRoles,
  webhookKeys,
  webhookOverwrites,
  type ChatPerms,
  type DiscordChannelBits,
} from './discord-chat-perms.js'
import { cachedGuildMemberRoles, discordFetch, forgetCachedMemberRoles } from './discord-roles.js'
import { listChannels, type BridgeMessage, type BridgeReaction, type ForwardSnapshot } from './discord-bridge-db.js'
import { attachmentsFromApi, type RawApiAttachment } from './discord-media.js'
import { componentsFromRaw, flagsFromRaw, interactionFromRaw, type RawInteractionFields } from './discord-interactions.js'
import {
  defaultStateRow,
  emulatedRoleIds,
  hasChatHistory,
  loadOnboardingState,
  onboardingConfig,
  sidebarOptInFilter,
  type OnboardingConfig,
  type OnboardingStateRow,
} from './discord-onboarding.js'
import { chatKeyOfUser, siteChatKey, siteChatKeys, siteIdOfChatKey, type ChatSubjectUser } from './chat-identity-key.ts'

// Discord-side channel visibility for the web chatbox, per bridged guild
// (every function takes the guild the channel / perms belong to).
//
// The chat permission bitfields in discord-chat-perms.ts gate what a webhook
// may DO in the bridge; this module answers the Discord question "can this
// caller even see the channel?" by running Discord's own permission algorithm
// (https://discord.com/developers/docs/topics/permissions#permission-overwrites)
// over the live guild roles + channel permission_overwrites, so the web
// sidebar shows exactly what the caller would see on Discord: staff channels
// (and categories whose channels are all hidden) disappear.

// Real Discord permission bits (NOT the chat bitfield in discord-chat-perms).
export const DiscordPermission = {
  ADMINISTRATOR: 1n << 3n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  READ_MESSAGE_HISTORY: 1n << 16n,
} as const

const ALL_PERMISSIONS = (1n << 64n) - 1n

export const DiscordChannelType = {
  GUILD_TEXT: 0,
  GUILD_CATEGORY: 4,
  GUILD_ANNOUNCEMENT: 5,
} as const

// Channel types the web chatbox can render as a message list. Voice/stage
// (2/13) have no text surface here, forum/media (15/16) are thread lists the
// chatbox has no UI for, so they're left out rather than rendered as dead rows.
export const RENDERABLE_CHANNEL_TYPES: ReadonlySet<number> = new Set([
  DiscordChannelType.GUILD_TEXT,
  DiscordChannelType.GUILD_ANNOUNCEMENT,
])

export interface DiscordOverwrite {
  id: string
  type: number | string // 0 / 'role', 1 / 'member'
  allow: string
  deny: string
}

export interface DiscordGuildChannel {
  id: string
  type: number
  name: string
  topic?: string | null
  position: number
  parent_id?: string | null
  permission_overwrites?: DiscordOverwrite[]
}

export interface DiscordGuildRole {
  id: string
  name: string
  permissions: string
  position: number
  color: number
}

// The identity Discord's algorithm runs over: the member id (for member
// overwrites; null for web-only webhooks) and the guild roles held (the
// @everyone role is implicit). `bypass` = the chat tier's Administrator
// semantics (admin/owner chat tiers bypass overwrites, as everywhere else in
// the bridge).
export interface ChannelViewer {
  memberId: string | null
  roleIds: string[]
  bypass?: boolean
}

export interface GuildPermissionContext {
  guildId: string
  ownerId: string | null
  roles: Map<string, DiscordGuildRole>
}

function toBits(value: string | number | undefined | null): bigint {
  try {
    return BigInt(value ?? 0)
  } catch {
    return 0n
  }
}

function isRoleOverwrite(o: DiscordOverwrite): boolean {
  return o.type === 0 || o.type === 'role' || o.type === '0'
}

function isMemberOverwrite(o: DiscordOverwrite): boolean {
  return o.type === 1 || o.type === 'member' || o.type === '1'
}

// Discord compute_base_permissions: guild owner = everything; else @everyone's
// permissions OR every held role's; ADMINISTRATOR = everything.
export function computeBasePermissions(guild: GuildPermissionContext, viewer: ChannelViewer): bigint {
  if (viewer.memberId && guild.ownerId && viewer.memberId === guild.ownerId) return ALL_PERMISSIONS
  let permissions = toBits(guild.roles.get(guild.guildId)?.permissions)
  for (const roleId of viewer.roleIds) {
    const role = guild.roles.get(roleId)
    if (role) permissions |= toBits(role.permissions)
  }
  if (permissions & DiscordPermission.ADMINISTRATOR) return ALL_PERMISSIONS
  return permissions
}

// Discord compute_overwrites: ADMINISTRATOR bypass; then the @everyone
// overwrite; then all of the viewer's role overwrites aggregated (deny then
// allow); then the member-specific overwrite.
export function computeOverwrites(
  base: bigint,
  channel: Pick<DiscordGuildChannel, 'permission_overwrites'>,
  guildId: string,
  viewer: ChannelViewer,
): bigint {
  if (base & DiscordPermission.ADMINISTRATOR) return ALL_PERMISSIONS
  const overwrites = channel.permission_overwrites || []
  let permissions = base

  const everyone = overwrites.find((o) => o.id === guildId && isRoleOverwrite(o))
  if (everyone) {
    permissions &= ~toBits(everyone.deny)
    permissions |= toBits(everyone.allow)
  }

  const held = new Set(viewer.roleIds)
  let allow = 0n
  let deny = 0n
  for (const o of overwrites) {
    if (!isRoleOverwrite(o) || o.id === guildId || !held.has(o.id)) continue
    allow |= toBits(o.allow)
    deny |= toBits(o.deny)
  }
  permissions &= ~deny
  permissions |= allow

  if (viewer.memberId) {
    const member = overwrites.find((o) => o.id === viewer.memberId && isMemberOverwrite(o))
    if (member) {
      permissions &= ~toBits(member.deny)
      permissions |= toBits(member.allow)
    }
  }
  return permissions
}

export function channelPermissions(guild: GuildPermissionContext, channel: DiscordGuildChannel, viewer: ChannelViewer): bigint {
  if (viewer.bypass) return ALL_PERMISSIONS
  return computeOverwrites(computeBasePermissions(guild, viewer), channel, guild.guildId, viewer)
}

// What the viewer's HELD roles contribute in a channel, without @everyone's
// implicit grants (see DiscordChannelBits.granted in discord-chat-perms.ts):
// base = the held roles' permissions only; the @everyone overwrite can only
// deny; then the aggregated role overwrites (deny then allow) and the member
// overwrite. Pure.
export function heldRoleChannelPermissions(guild: GuildPermissionContext, channel: Pick<DiscordGuildChannel, 'permission_overwrites'>, viewer: ChannelViewer): bigint {
  if (viewer.bypass) return ALL_PERMISSIONS
  let base = 0n
  for (const roleId of viewer.roleIds) {
    if (roleId === guild.guildId) continue
    const role = guild.roles.get(roleId)
    if (role) base |= toBits(role.permissions)
  }
  if (base & DiscordPermission.ADMINISTRATOR) return ALL_PERMISSIONS
  const overwrites = channel.permission_overwrites || []
  const everyone = overwrites.find((o) => o.id === guild.guildId && isRoleOverwrite(o))
  if (everyone) base &= ~toBits(everyone.deny)
  return computeOverwrites(base, { permission_overwrites: overwrites.filter((o) => o !== everyone) }, guild.guildId, viewer)
}

export function canViewChannel(guild: GuildPermissionContext, channel: DiscordGuildChannel, viewer: ChannelViewer): boolean {
  return (channelPermissions(guild, channel, viewer) & DiscordPermission.VIEW_CHANNEL) !== 0n
}

// Discord's sidebar order: position, ties broken by snowflake.
function byPosition(a: DiscordGuildChannel, b: DiscordGuildChannel): number {
  if (a.position !== b.position) return a.position - b.position
  const ai = toBits(a.id)
  const bi = toBits(b.id)
  return ai < bi ? -1 : ai > bi ? 1 : 0
}

export interface SidebarLayout {
  // Categories in sidebar order (bridged-first; see buildSidebar).
  categories: Array<{ id: string; name: string; position: number }>
  // Renderable channels in exact sidebar order, contiguous per group (the
  // client renders groups in the order their channels appear).
  channels: DiscordGuildChannel[]
}

// Build the sidebar the caller would see: renderable channels they can VIEW,
// and only the categories that still have at least one visible channel
// (Discord hides a category whose channels are all hidden from you).
//
// Group order (single source of truth; the client never re-sorts): groups
// holding at least one bridged channel come first, then the rest:
// [bridged uncategorized] → bridged categories → remaining categories.
// Channels without a category are hidden from the sidebar unless bridged (a
// headerless group below a category reads as part of that category; bridged
// ones stay so they're always reachable). Categories keep Discord position
// order within each section, and channels keep position order within a group.
export function buildSidebar(
  all: DiscordGuildChannel[],
  canView: (channel: DiscordGuildChannel) => boolean,
  isBridged: (channel: DiscordGuildChannel) => boolean = () => false,
): SidebarLayout {
  const visible = all.filter((c) => RENDERABLE_CHANNEL_TYPES.has(c.type) && canView(c))
  const categoryById = new Map(all.filter((c) => c.type === DiscordChannelType.GUILD_CATEGORY).map((c) => [c.id, c]))
  const usedCategoryIds = new Set(visible.map((c) => c.parent_id).filter((id): id is string => Boolean(id && categoryById.has(id))))
  const uncategorized = visible.filter((c) => (!c.parent_id || !usedCategoryIds.has(c.parent_id)) && isBridged(c)).sort(byPosition)
  const groups = [...usedCategoryIds].map((id) => categoryById.get(id)!).sort(byPosition)
    .map((cat) => ({ category: cat as DiscordGuildChannel | null, channels: visible.filter((c) => c.parent_id === cat.id).sort(byPosition) }))
  if (uncategorized.length) groups.unshift({ category: null, channels: uncategorized })
  const bridgedGroup = (g: (typeof groups)[number]) => g.channels.some(isBridged)
  const ordered = [...groups.filter(bridgedGroup), ...groups.filter((g) => !bridgedGroup(g))]
  return {
    categories: ordered.flatMap((g) => (g.category ? [{ id: g.category.id, name: g.category.name, position: g.category.position }] : [])),
    channels: ordered.flatMap((g) => g.channels),
  }
}

// --- Live guild snapshot (roles + channels), cached ---------------------------

export interface GuildSnapshot extends GuildPermissionContext {
  channels: DiscordGuildChannel[]
  byId: Map<string, DiscordGuildChannel>
  chatTiers: Map<string, string> // chat-role id -> tier (for author badges)
}

const SNAPSHOT_TTL_MS = 45_000
// When Discord is unreachable, every gate falls back to bridge-only checks
// (fail open) once no snapshot is available - which would expose bridged
// channels hidden only by Discord overwrites. The last good snapshot is a far
// better approximation than none, so it is served for a long outage window.
const SNAPSHOT_STALE_MS = 24 * 60 * 60_000
const SNAPSHOT_FAIL_BACKOFF_MS = 10_000
// Per guild (every bridged guild has its own snapshot).
const snapshots = new Map<string, { fetchedAt: number; value: GuildSnapshot }>()
const snapshotInflight = new Map<string, Promise<GuildSnapshot | null>>()
const snapshotFailedAt = new Map<string, number>()
// Last-known owner per guild (never expires): the guild owner stays
// un-moderatable even while a snapshot is unavailable.
const knownGuildOwners = new Map<string, string>()

async function fetchSnapshot(guildId: string): Promise<GuildSnapshot | null> {
  const [guildRes, channelsRes] = await Promise.all([
    discordFetch(`/guilds/${guildId}`).catch(() => null),
    discordFetch(`/guilds/${guildId}/channels`).catch(() => null),
  ])
  if (!guildRes?.ok || !channelsRes?.ok) return null
  const guild = (await guildRes.json().catch(() => null)) as { owner_id?: string; roles?: DiscordGuildRole[] } | null
  const channels = (await channelsRes.json().catch(() => null)) as DiscordGuildChannel[] | null
  if (!guild || !Array.isArray(guild.roles) || !Array.isArray(channels)) return null
  if (guild.owner_id) knownGuildOwners.set(guildId, guild.owner_id)
  const tiers = await query<{ role_id: string; tier: string }>(
    `SELECT role_id, tier FROM discord_bridge_chat_role`,
  ).then((r) => r.rows).catch(() => [] as Array<{ role_id: string; tier: string }>)
  return {
    guildId,
    ownerId: guild.owner_id || null,
    roles: new Map(guild.roles.map((r) => [r.id, r])),
    channels,
    byId: new Map(channels.map((c) => [c.id, c])),
    chatTiers: new Map(tiers.map((t) => [t.role_id, t.tier])),
  }
}

// Guild roles + channels with permission_overwrites, cached ~45s (one GET
// /guilds/{id} + one GET /guilds/{id}/channels per window, deduped across
// concurrent requests). A failed refresh serves the last good snapshot for up
// to 24 hours and backs off 10s so a Discord outage can't be hammered.
export async function guildSnapshot(guildId: string): Promise<GuildSnapshot | null> {
  if (!guildId) return null
  const now = Date.now()
  const current = snapshots.get(guildId) || null
  if (current && now - current.fetchedAt < SNAPSHOT_TTL_MS) return current.value
  const stale = current && now - current.fetchedAt < SNAPSHOT_STALE_MS ? current.value : null
  if (now - (snapshotFailedAt.get(guildId) || 0) < SNAPSHOT_FAIL_BACKOFF_MS) return stale
  let inflight = snapshotInflight.get(guildId)
  if (!inflight) {
    inflight = fetchSnapshot(guildId)
      .catch(() => null)
      .then((value) => {
        if (value) snapshots.set(guildId, { fetchedAt: Date.now(), value })
        else snapshotFailedAt.set(guildId, Date.now())
        return value
      })
      .finally(() => { snapshotInflight.delete(guildId) })
    snapshotInflight.set(guildId, inflight)
  }
  return (await inflight) || stale
}

// Force the next guildSnapshot() call to refetch (role definitions or the
// bridged channel layout changed). No guild = every guild.
export function invalidateGuildSnapshot(guildId?: string | null): void {
  for (const [id, entry] of snapshots) {
    if (!guildId || id === guildId) snapshots.set(id, { ...entry, fetchedAt: 0 })
  }
  if (guildId) snapshotFailedAt.delete(guildId)
  else snapshotFailedAt.clear()
}

// Member role lookups (GET /guilds/{g}/members/{u}): the shared 30s
// per-guild cache in discord-roles.ts (also used by the chat-perm
// resolver). A failed lookup resolves as "not a member" here.
export async function cachedMemberRoles(discordId: string, guildId: string): Promise<string[] | null> {
  return cachedGuildMemberRoles(discordId, guildId).catch(() => null)
}

// Drop one Discord user's cached member roles in every guild.
function forgetMemberRoles(discordId: string): void {
  forgetCachedMemberRoles({ discordId })
}

// The caller's effective Discord identity. A linked guild member uses their
// real guild roles + member id. Anyone else (guest, web-only webhook, linked
// account that left the guild) is @everyone plus the roles their chat tier
// maps to: the resolved chat role (if any) and, for a member-tier webhook that
// holds no mapped role (incl. the paid-perk member floor in
// chatPermsForUser), the configured chatRoles.member roles.
//
// A web-only site account additionally holds the roles its Server Onboarding
// answers grant (discord-onboarding.ts emulatedRoleIds) - emulated locally for
// this algorithm only, never assigned on Discord. Linked guild members use
// their real roles (Discord already applied their onboarding).
//
// This is the ONE effective-role resolver (unionEffectiveRoles is the pure
// core). chatPermsForUser / chatPermsForIdentity attach its result to the
// perms (perms.roleIds / memberId), and everything downstream - channel
// visibility, the Discord channel permission math, bridge role overwrites,
// hierarchy position, mention highlighting, author color, profile roles -
// reads it from there.
//
// Everything is per guild: `guildId` is the bridged guild the perms were
// resolved for (a linked user who isn't a member of that guild resolves as a
// non-member there, like on Discord). chatRoles.member floor roles count only
// when they exist in that guild.
export async function resolveEffectiveRoles(
  user: ChatSubjectUser | null | undefined,
  perms: Pick<ChatPerms, 'tier' | 'roleId' | 'siteAdmin'>,
  guildId: string,
): Promise<{ memberId: string | null; roleIds: string[] }> {
  const memberRoles = user?.discord_id ? await cachedMemberRoles(user.discord_id, guildId) : null
  let memberFloorRoles: string[] = []
  try {
    memberFloorRoles = getConfig().discord?.chatRoles?.member || []
  } catch {
    memberFloorRoles = []
  }
  const snap = memberFloorRoles.length ? await guildSnapshot(guildId) : null
  if (snap) memberFloorRoles = memberFloorRoles.filter((id) => snap.roles.has(id))
  const onboardingRoles = memberRoles ? [] : await onboardingRolesFor(chatKeyOfUser(user), guildId).catch(() => [])
  const roleIds = unionEffectiveRoles({
    memberRoles,
    chatRoleId: perms.roleId,
    tier: perms.tier,
    memberFloorRoles,
    onboardingRoles,
    guildId: guildId || null,
  })
  // A site admin holds the admin-tier role too (linked members included), so
  // the Admin chip, color and hierarchy position come from the same role set.
  const adminRoleId = perms.siteAdmin?.roleId
  if (adminRoleId && !roleIds.includes(adminRoleId)) roleIds.push(adminRoleId)
  return {
    memberId: memberRoles && user?.discord_id ? user.discord_id : null,
    roleIds,
  }
}

// Attach the effective roles to resolved chat perms, plus what they imply:
// the hierarchy position (highest effective role, effectivePosition) and the
// name color (highest-positioned colored effective role, Discord's color
// role). Role positions/colors come from the live guild snapshot; without it
// the tier's own position/color stand.
export async function withEffectiveRoles(
  user: { id?: number | null; discord_id?: string | null } | null | undefined,
  perms: ChatPerms,
  guildId: string,
): Promise<ChatPerms> {
  const { memberId, roleIds } = await resolveEffectiveRoles(user, perms, guildId)
  const snap = guildId ? await guildSnapshot(guildId) : null
  let position = perms.position
  let color = perms.color
  let hierarchyBypass = false
  // A site admin in a guild with no admin-tier chat role (siteAdmin.roleId
  // null) has no real role to rank by: they sit just above the guild's
  // highest role, or - with no snapshot - skip the hierarchy check (except
  // against the guild owner, see canModerate).
  const rankless = Boolean(perms.siteAdmin && perms.siteAdmin.roleId === null)
  if (snap) {
    const held = roleIds.map((id) => snap.roles.get(id)).filter((r): r is DiscordGuildRole => Boolean(r))
    position = effectivePosition(perms, held.map((r) => r.position))
    const colored = held.filter((r) => r.color).sort((a, b) => b.position - a.position)[0]
    if (colored) color = `#${colored.color.toString(16).padStart(6, '0')}`
    if (rankless) position = Math.max(position, topRolePosition(snap.roles.values()) + 1)
  } else if (rankless) {
    hierarchyBypass = true
  }
  const ownerId = snap?.ownerId || knownGuildOwners.get(guildId) || null
  const guildOwner = Boolean(memberId && ownerId && memberId === ownerId)
  return { ...perms, roleIds, memberId, position, color, hierarchyBypass, guildOwner }
}

// `perms` must have been resolved for `guildId` (its roleIds are that
// guild's effective roles).
// Highest role position in a guild (0 for none). Pure.
export function topRolePosition(roles: Iterable<Pick<DiscordGuildRole, 'position'>>): number {
  let top = 0
  for (const r of roles) if (r.position > top) top = r.position
  return top
}

export async function viewerFor(
  user: { id?: number | null; discord_id?: string | null } | null | undefined,
  perms: ChatPerms,
  guildId: string,
): Promise<ChannelViewer> {
  const bypass = bypassesOverwrites(perms.tier)
  if (perms.roleIds) return { memberId: perms.memberId ?? null, roleIds: perms.roleIds, bypass }
  const { memberId, roleIds } = await resolveEffectiveRoles(user, perms, guildId)
  return { memberId, roleIds, bypass }
}

// Discord's permission math for one channel over the caller's effective roles
// (full + held-role contribution; see applyDiscordChannelPerms). null when the
// guild snapshot or the channel is unknown.
export async function discordChannelBits(
  user: { id?: number | null; discord_id?: string | null } | null | undefined,
  perms: ChatPerms,
  channelId: string,
  guildId: string,
): Promise<DiscordChannelBits | null> {
  const snap = guildId ? await guildSnapshot(guildId) : null
  const channel = snap?.byId.get(channelId)
  if (!snap || !channel) return null
  const viewer = await viewerFor(user, perms, guildId)
  return { full: channelPermissions(snap, channel, viewer), granted: heldRoleChannelPermissions(snap, channel, viewer) }
}

// --- Server Onboarding (emulated) ---------------------------------------------

export function onboardingIdentityKey(userId: number): string {
  return siteChatKey(userId)
}

// `key` = the caller's chat identity key (chatKeyOfUser): a site account or another platform's identity.
async function onboardingRolesFor(key: string | null, guildId: string): Promise<string[]> {
  if (key === null) return []
  const snap = guildId ? await guildSnapshot(guildId) : null
  if (!snap) return []
  const row = await loadOnboardingState(guildId, key)
  if (!row || !row.responses.length) return []
  const config = await onboardingConfig(guildId, { roles: snap.roles, channels: snap.byId })
  return emulatedRoleIds(config, row.responses, snap.roles)
}

// Site account ids whose Server Onboarding answers grant `roleId` (the
// role-mention popout lists them as webhook holders). Only options whose
// emulated roles include it count, so elevated/managed roles never match.
export async function onboardingRoleHolders(guildId: string, roleId: string, limit = 500): Promise<number[]> {
  const snap = guildId ? await guildSnapshot(guildId) : null
  if (!snap) return []
  const config = await onboardingConfig(guildId, { roles: snap.roles, channels: snap.byId }).catch(() => null)
  if (!config) return []
  const optionIds = config.prompts.flatMap((p) => p.options)
    .filter((o) => emulatedRoleIds(config, [o.id], snap.roles).includes(roleId))
    .map((o) => o.id)
  if (!optionIds.length) return []
  const { rows } = await query<{ identity_key: string }>(
    `SELECT identity_key FROM discord_bridge_onboarding_state
     WHERE guild_id = $1 AND (identity_key LIKE 'abulxt:%' OR identity_key LIKE 'user:%') AND responses && $2::text[]
     LIMIT $3`,
    [guildId, optionIds, limit],
  ).catch(() => ({ rows: [] as Array<{ identity_key: string }> }))
  return rows.map((r) => siteIdOfChatKey(r.identity_key)).filter((id): id is number => id !== null)
}

export interface OnboardingView {
  guildId: string
  snapshot: GuildSnapshot
  config: OnboardingConfig | null
  // Effective state (the stored row, or the default a row-less identity
  // starts from). null for guests: nothing persists, nothing is filtered.
  row: OnboardingStateRow | null
  persisted: boolean
  // A linked account that is a real guild member.
  member: boolean
}

// The caller's onboarding config + effective state in one bridged guild.
// null when the guild snapshot is unavailable.
export async function onboardingView(
  user: ChatSubjectUser | null | undefined,
  guildId: string,
): Promise<OnboardingView | null> {
  const snap = guildId ? await guildSnapshot(guildId) : null
  if (!snap) return null
  const config = await onboardingConfig(guildId, { roles: snap.roles, channels: snap.byId }).catch(() => null)
  const member = Boolean(user?.discord_id && (await cachedMemberRoles(user.discord_id, guildId)))
  const key = chatKeyOfUser(user)
  if (key === null) return { guildId, snapshot: snap, config, row: null, persisted: false, member }
  const stored = await loadOnboardingState(guildId, key)
  const row = stored || defaultStateRow(member || (await hasChatHistory(key, guildId)))
  return { guildId, snapshot: snap, config, row, persisted: Boolean(stored), member }
}

// The HOME guild (config.discord.guildId): verification, entitlement roles,
// /ai, account link. Nothing chat-related may assume it; per-guild code takes
// the channel's guild (discord_bridge_channel.guild_id) instead.
export function configuredGuildId(): string {
  try {
    return getConfig().discord?.guildId || ''
  } catch {
    return ''
  }
}

export interface ChannelAccess {
  // false = the guild snapshot is unavailable (no token/guild, Discord down):
  // callers fall back to bridge-only gating.
  known: boolean
  channel: DiscordGuildChannel | null
  view: boolean
  // VIEW_CHANNEL + READ_MESSAGE_HISTORY: Discord shows no past messages
  // without the latter, so live (unbridged) history/pins require it.
  history: boolean
}

// Discord-side VIEW for a BRIDGED channel. With the guild snapshot: Discord's
// own answer. Without it (Discord unreachable, nothing cached): FAIL CLOSED -
// only channels @everyone can view on Discord (discord_bridge_channel
// .everyone_can_view, computed by the bot) stay readable, and they still need
// the chat VIEW bit + webhook overwrites at the call site. Pure.
export function discordViewAllowed(access: Pick<ChannelAccess, 'known' | 'view'> | null | undefined, everyoneCanView: boolean): boolean {
  if (access && access.known) return access.view
  return everyoneCanView
}

// Can the caller VIEW this guild channel on Discord? Unknown channel ids (and
// non-renderable types) resolve to view: false. `guildId` = the channel's
// guild (perms resolved for that guild).
export async function channelAccess(
  user: { discord_id?: string | null } | null | undefined,
  perms: ChatPerms,
  channelId: string,
  guildId: string,
): Promise<ChannelAccess> {
  const snap = guildId ? await guildSnapshot(guildId) : null
  if (!snap) return { known: false, channel: null, view: false, history: false }
  const channel = snap.byId.get(channelId) || null
  if (!channel || !RENDERABLE_CHANNEL_TYPES.has(channel.type)) return { known: true, channel, view: false, history: false }
  const viewer = await viewerFor(user, perms, guildId)
  const bits = channelPermissions(snap, channel, viewer)
  const view = (bits & DiscordPermission.VIEW_CHANNEL) !== 0n
  return { known: true, channel, view, history: view && (bits & DiscordPermission.READ_MESSAGE_HISTORY) !== 0n }
}

// `options.optIn`: also apply Server Onboarding's opt-in channel model
// (sidebarOptInFilter) - the /channels sidebar does; realtime visibility
// doesn't (an opted-out channel is hidden from the list, not unreadable).
// `options.onlyBridged`: list only channels `isBridged` accepts (the chatbox
// sidebar shows bridged channels only, plus the categories that hold them).
export async function visibleSidebar(
  user: { id?: number | null; discord_id?: string | null } | null | undefined,
  perms: ChatPerms,
  guildId: string,
  isBridged?: (channel: DiscordGuildChannel) => boolean,
  options: { optIn?: boolean; onlyBridged?: boolean } = {},
): Promise<(SidebarLayout & { snapshot: GuildSnapshot }) | null> {
  const snap = guildId ? await guildSnapshot(guildId) : null
  if (!snap) return null
  const viewer = await viewerFor(user, perms, guildId)
  const bridgedFn = isBridged || (() => false)
  let optIn: (channel: DiscordGuildChannel) => boolean = () => true
  if (options.optIn) {
    const view = await onboardingView(user, guildId).catch(() => null)
    if (view?.row) {
      const everyone: ChannelViewer = { memberId: null, roleIds: [] }
      optIn = sidebarOptInFilter(view.config, view.row, (c) => canViewChannel(snap, c, everyone), bridgedFn)
    }
  }
  const canView = (c: DiscordGuildChannel) => (!options.onlyBridged || bridgedFn(c)) && canViewChannel(snap, c, viewer) && optIn(c)
  return { ...buildSidebar(snap.channels, canView, isBridged), snapshot: snap }
}

// --- Live history for unbridged channels -------------------------------------
//
// Currently unused: multi-guild bridging dropped unbridged live reads (the
// sidebar lists bridged channels only and viewGate refuses the rest). Kept
// for now; nothing calls fetchLiveMessages / liveMessageToBridge.

export interface DiscordApiUserRaw {
  id: string
  username: string
  global_name?: string | null
  avatar?: string | null
  bot?: boolean
}

export interface DiscordApiMessageRaw {
  id: string
  channel_id: string
  type: number
  content?: string
  timestamp: string
  edited_timestamp?: string | null
  author: DiscordApiUserRaw
  webhook_id?: string
  attachments?: RawApiAttachment[]
  embeds?: Array<Record<string, unknown>>
  mentions?: DiscordApiUserRaw[]
  mention_roles?: string[]
  mention_everyone?: boolean
  reactions?: Array<{ count: number; emoji: { id: string | null; name: string | null } }>
  sticker_items?: Array<{ id: string; name: string; format_type: number }>
  message_reference?: { type?: number; message_id?: string; channel_id?: string; guild_id?: string }
  referenced_message?: DiscordApiMessageRaw | null
  message_snapshots?: Array<{ message: Partial<DiscordApiMessageRaw> }>
  // Application commands + components (discord-interactions.ts).
  interaction_metadata?: RawInteractionFields['interaction_metadata']
  interaction?: RawInteractionFields['interaction']
  components?: unknown[]
  flags?: number
}

export class DiscordLiveError extends Error {
  status: number
  retryAfter: number
  constructor(status: number, retryAfter = 0) {
    super(`Discord message fetch failed: HTTP ${status}`)
    this.status = status
    this.retryAfter = retryAfter
  }
}

// Message types rendered as ordinary rows (default, reply, slash-command and
// context-menu command responses). System messages (joins, pins, boosts…)
// have no row UI in the chatbox and would render blank, so they're skipped.
export const RENDERED_MESSAGE_TYPES = new Set([0, 19, 20, 23])

// Live message ids: the bridge's numeric BridgeMessage.id must be ordered and
// JS-safe, and a snowflake (≈2^60) isn't. Dropping the 12 increment bits keeps
// the timestamp + worker/process bits (≈2^48, safe) and Discord's ordering.
export function liveMessageId(snowflake: string): number {
  try {
    return Number(BigInt(snowflake) >> 12n)
  } catch {
    return 0
  }
}

const liveCache = new Map<string, { expires: number; messages: DiscordApiMessageRaw[] }>()
const LIVE_TTL_MS = 15_000

// GET /channels/{id}/messages (newest first) with the bot token, cached 15s
// per channel+cursor. Throws DiscordLiveError (429 carries retry_after after
// discordFetch's own single retry; 403 = the bot itself can't read it).
// `after` / `around` (snowflakes) take precedence over `before`, matching
// Discord's own query semantics (one cursor per request).
export async function fetchLiveMessages(
  channelId: string,
  before: string | null,
  limit: number,
  extra?: { after?: string | null; around?: string | null },
): Promise<DiscordApiMessageRaw[]> {
  const capped = Math.min(Math.max(limit, 1), 100)
  const around = extra?.around || null
  const after = around ? null : extra?.after || null
  const beforeCursor = around || after ? null : before
  const key = `${channelId}:${beforeCursor || ''}:${after ? `a${after}` : ''}:${around ? `r${around}` : ''}:${capped}`
  const hit = liveCache.get(key)
  if (hit && hit.expires > Date.now()) return hit.messages
  const params = new URLSearchParams({ limit: String(capped) })
  if (around) params.set('around', around)
  else if (after) params.set('after', after)
  else if (beforeCursor) params.set('before', beforeCursor)
  const response = await discordFetch(`/channels/${channelId}/messages?${params}`)
  if (response.status === 429) {
    const body = (await response.json().catch(() => ({}))) as { retry_after?: number }
    throw new DiscordLiveError(429, Math.max(1, Math.ceil(body.retry_after ?? 1)))
  }
  if (!response.ok) throw new DiscordLiveError(response.status)
  const list = (await response.json().catch(() => [])) as DiscordApiMessageRaw[]
  const messages = Array.isArray(list) ? list : []
  liveCache.set(key, { expires: Date.now() + LIVE_TTL_MS, messages })
  if (liveCache.size > 300) liveCache.delete(liveCache.keys().next().value as string)
  return messages
}

export interface LiveContext {
  guildId: string
  roles: Map<string, DiscordGuildRole>
  channels: Map<string, DiscordGuildChannel>
  chatTiers: Map<string, string>
  // Directory rows (display name incl. nick, full avatar url) by user id.
  directory: Map<string, { displayName: string; avatar: string | null }>
  // Guild member role ids by user id (author color/badge); optional.
  memberRoles: Map<string, string[]> | null
}

// Batch directory lookup for the authors/mentions on a page.
export async function directoryFor(guildId: string, userIds: string[]): Promise<LiveContext['directory']> {
  const ids = [...new Set(userIds)].filter(Boolean)
  if (!ids.length) return new Map()
  const { rows } = await query<{ user_id: string; display_name: string; avatar: string | null }>(
    `SELECT user_id, display_name, avatar FROM discord_bridge_guild_member
     WHERE guild_id = $1 AND user_id = ANY($2::text[])`,
    [guildId, ids],
  ).catch(() => ({ rows: [] as Array<{ user_id: string; display_name: string; avatar: string | null }> }))
  return new Map(rows.map((r) => [r.user_id, { displayName: r.display_name, avatar: r.avatar }]))
}

function defaultAvatar(userId: string): string {
  let index = 0
  try {
    index = Number((BigInt(userId) >> 22n) % 6n)
  } catch {
    index = 0
  }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`
}

function userAvatar(u: DiscordApiUserRaw): string {
  return u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.webp?size=64` : defaultAvatar(u.id)
}

function displayNameFor(u: DiscordApiUserRaw, ctx: LiveContext, isWebhook: boolean): string {
  if (isWebhook) return u.username
  return ctx.directory.get(u.id)?.displayName || u.global_name || u.username
}

// Discord's name color: the highest-positioned held role with a non-zero color.
function roleColorFor(userId: string, ctx: LiveContext): string | null {
  const held = ctx.memberRoles?.get(userId)
  if (!held) return null
  let best: DiscordGuildRole | null = null
  for (const id of held) {
    const role = ctx.roles.get(id)
    if (role && role.color && (!best || role.position > best.position)) best = role
  }
  return best ? `#${best.color.toString(16).padStart(6, '0')}` : null
}

const TIER_ORDER = ['mod', 'admin', 'owner']
function chatTierFor(userId: string, ctx: LiveContext): string | null {
  const held = ctx.memberRoles?.get(userId)
  if (!held) return null
  let best = -1
  for (const id of held) best = Math.max(best, TIER_ORDER.indexOf(ctx.chatTiers.get(id) || ''))
  return best >= 0 ? TIER_ORDER[best] : null
}

function attachmentsOf(m: Partial<DiscordApiMessageRaw>): unknown[] {
  // Full Discord attachment data (proxy URL, alt text, spoiler/remix flags,
  // duration/waveform) - same shape the gateway bot persists.
  const files = attachmentsFromApi(m.attachments)
  // Stickers render as their image (Lottie stickers, format 3, have no image).
  const stickers = (m.sticker_items || [])
    .filter((s) => s.format_type !== 3)
    .map((s) => ({
      id: s.id,
      url: `https://media.discordapp.net/stickers/${s.id}.${s.format_type === 4 ? 'gif' : 'png'}?size=160`,
      name: s.name,
      size: 0,
      contentType: s.format_type === 4 ? 'image/gif' : 'image/png',
      width: 160,
      height: 160,
    }))
  return [...files, ...stickers]
}

// Map a Discord REST message into the BridgeMessage shape the client renders,
// mirroring the bot's gateway mapping (discord-bridge-bot.ts
// persistDiscordMessage / mentionPayload / attachmentPayload / forwardPayload)
// for raw API JSON instead of discord.js objects. Returns null for message
// types the chatbox doesn't render.
export function liveMessageToBridge(m: DiscordApiMessageRaw, ctx: LiveContext): BridgeMessage | null {
  if (!RENDERED_MESSAGE_TYPES.has(m.type)) return null
  const isWebhook = Boolean(m.webhook_id)
  const author = m.author
  const directory = isWebhook ? undefined : ctx.directory.get(author.id)

  const mentions: Array<Record<string, string | null>> = []
  for (const u of m.mentions || []) {
    mentions.push({ type: 'user', id: u.id, username: ctx.directory.get(u.id)?.displayName || u.global_name || u.username })
  }
  for (const match of (m.content || '').matchAll(/<#(\d+)>/g)) {
    const channel = ctx.channels.get(match[1])
    mentions.push({ type: 'channel', id: match[1], name: channel?.name || match[1] })
  }
  for (const id of m.mention_roles || []) {
    const role = ctx.roles.get(id)
    mentions.push({ type: 'role', id, name: role?.name || 'role', color: role && role.color ? `#${role.color.toString(16).padStart(6, '0')}` : null })
  }
  if (m.mention_everyone) mentions.push({ type: 'everyone' })

  const refType = m.message_reference?.type ?? 0
  const isForward = Boolean(m.message_reference) && refType === 1
  const isReply = m.type === 19 && Boolean(m.message_reference?.message_id) && !isForward
  let replyMention = true
  if (isReply) {
    const target = m.referenced_message?.author
    replyMention = Boolean(target && (m.mentions || []).some((u) => u.id === target.id))
    if (replyMention && target) {
      mentions.push({ type: 'reply', id: target.id, username: displayNameFor(target, ctx, Boolean(m.referenced_message?.webhook_id)) })
    }
  }

  let forwarded: ForwardSnapshot | null = null
  if (isForward) {
    const snap = m.message_snapshots?.[0]?.message
    if (snap) {
      forwarded = {
        content: snap.content || '',
        attachments: attachmentsOf(snap),
        embeds: Array.isArray(snap.embeds) ? snap.embeds : [],
        mentions: [],
        components: componentsFromRaw(snap.components, attachmentsOf(snap) as Array<{ url?: string; name?: string }>).components,
        createdAt: snap.timestamp || null,
        channelId: m.message_reference?.channel_id || null,
        messageId: m.message_reference?.message_id || null,
        guildId: m.message_reference?.guild_id || null,
      }
    }
  }

  const reactions: BridgeReaction[] = (m.reactions || [])
    .map((r) => ({ emoji: r.emoji.name || String(r.emoji.id || ''), count: r.count, reactorKeys: [] as string[] }))
    .filter((r) => r.emoji)

  // Slash/context-menu command header, components (V2 attachment:// media
  // resolved; those files aren't repeated as plain attachments) and flags.
  const allAttachments = attachmentsOf(m) as Array<{ url?: string; name?: string }>
  const { components, usedAttachmentUrls } = componentsFromRaw(m.components, allAttachments)
  const interaction = interactionFromRaw(m, {
    displayName: (id) => ctx.directory.get(id)?.displayName,
    avatar: (id) => ctx.directory.get(id)?.avatar,
    color: (id) => roleColorFor(id, ctx),
  })

  return {
    id: liveMessageId(m.id),
    channelId: m.channel_id,
    direction: 'discord',
    discordMessageId: m.id,
    authorKey: `discord:${author.id}`,
    authorName: displayNameFor(author, ctx, isWebhook),
    authorAvatar: directory?.avatar || userAvatar(author),
    authorColor: isWebhook ? null : roleColorFor(author.id, ctx),
    authorRole: isWebhook ? null : chatTierFor(author.id, ctx),
    authorBot: isWebhook || author.bot === true,
    content: m.content || '',
    attachments: allAttachments.filter((a) => !a.url || !usedAttachmentUrls.has(a.url)),
    embeds: Array.isArray(m.embeds) ? m.embeds : [],
    mentions,
    replyTo: isReply ? m.message_reference!.message_id! : null,
    replyMention,
    clientId: null,
    createdAt: m.timestamp,
    editedAt: m.edited_timestamp || null,
    deletedAt: null,
    reactions,
    forwarded,
    messageType: m.type,
    interaction,
    components,
    flags: flagsFromRaw(m.flags),
  }
}

// --- Realtime fan-out filtering ------------------------------------------------
//
// Every /api/rt socket subscribes to the shared bridge bus. Without filtering,
// each socket would receive every bridge event, including messages from
// channels its identity can't VIEW (staff channels) and moderation events
// about other webhooks. rt-api.ts resolves a SocketVisibility per socket
// (cached per identity, refreshed with the guild snapshot) and passes every
// live and replayed bridge event through allowBridgeEvent().

export interface SocketVisibility {
  // Bridged channel ids this identity may read, across every bridged guild
  // (Discord VIEW_CHANNEL in that guild + the chat VIEW bit + webhook view
  // overwrites).
  channels: Set<string>
  discordId: string | null
  // Every webhook key this socket's identity appears under ('user:<id>' for a
  // site account, 'discord:<id>' for its linked Discord) - moderation events
  // targeting either side reach it.
  keys: string[]
  // Channels where this identity holds a chat moderation bit (timeout/ban/
  // manage) - per channel, because moderation tiers are per guild. Receives
  // other webhooks' timeout/ban events there.
  moderatorChannels: Set<string>
  // A site admin (users.admin): receives guild-less moderation events.
  siteAdmin: boolean
}

export const VISIBILITY_TTL_MS = 45_000
const visibilityCache = new Map<string, { expires: number; value: Promise<SocketVisibility> }>()

type VisibilityUser = (ChatSubjectUser & { admin?: boolean }) | null | undefined

async function computeVisibility(user: VisibilityUser): Promise<SocketVisibility> {
  await loadConfig()
  const subject = subjectOfUser(user)
  const channels = new Set<string>()
  const moderatorChannels = new Set<string>()
  const byGuild = new Map<string, Array<{ channelId: string; everyoneCanView: boolean }>>()
  for (const c of await listChannels(true).catch(() => [])) {
    if (!c.guildId) continue
    const list = byGuild.get(c.guildId) || []
    list.push(c)
    byGuild.set(c.guildId, list)
  }
  // Union over every bridged guild: perms (and so moderation) are per guild.
  for (const [guildId, rows] of byGuild) {
    const perms = await chatPermsForUser(user as Parameters<typeof chatPermsForUser>[0], guildId)
    const moderator = hasPerm(perms.permissions, Perm.TIMEOUT_WEBHOOKS)
      || hasPerm(perms.permissions, Perm.BAN_WEBHOOKS)
      || hasPerm(perms.permissions, Perm.MANAGE_WEBHOOKS)
    if (!hasPerm(perms.permissions, Perm.VIEW_MESSAGES)) continue
    for (const { channelId, everyoneCanView } of rows) {
      // Discord VIEW_CHANNEL; without the guild snapshot only @everyone-
      // viewable channels pass (fail closed, discordViewAllowed).
      const access = await channelAccess(user, perms, channelId, guildId).catch(() => null)
      if (!discordViewAllowed(access, everyoneCanView)) continue
      const view = bypassesOverwrites(perms.tier)
        || (await webhookOverwrites(channelId, subject, perms.roleIds || (perms.roleId ? [perms.roleId] : []), perms).catch(() => ({ view: false }))).view
      if (!view) continue
      channels.add(channelId)
      if (moderator) moderatorChannels.add(channelId)
    }
  }
  return { channels, discordId: subject.discordId, keys: webhookKeys(subject), moderatorChannels, siteAdmin: user?.admin === true }
}

// Visibility for a socket identity, shared across that identity's sockets and
// cached ~45s (the guild snapshot's TTL). `key` = the socket's owner key.
export function socketVisibility(key: string, user: VisibilityUser): Promise<SocketVisibility> {
  const hit = visibilityCache.get(key)
  if (hit && hit.expires > Date.now()) return hit.value
  const value = computeVisibility(user)
  visibilityCache.set(key, { expires: Date.now() + VISIBILITY_TTL_MS, value })
  value.catch(() => visibilityCache.delete(key))
  if (visibilityCache.size > 5000) visibilityCache.delete(visibilityCache.keys().next().value as string)
  return value
}

// A guild member's roles or a chat-role definition changed (bridge.perms
// .changed): drop cached visibility (and member roles / the guild snapshot) so
// the affected sockets recompute. Idempotent per event seq, since every socket
// sees the same event.
let lastInvalidatedSeq = -1
export function invalidateVisibility(seq: number, discordId: string | null, guildId?: string | null): void {
  if (seq === lastInvalidatedSeq) return
  lastInvalidatedSeq = seq
  if (discordId) {
    forgetMemberRoles(discordId)
  } else {
    // A guild-scoped change (role edited in guild G) only drops G's member
    // roles + snapshot; no guild = everything.
    forgetCachedMemberRoles({ guildId })
    invalidateGuildSnapshot(guildId)
  }
  // Visibility is keyed by owner key, not discord id, so clear it all; the
  // recompute is cheap (shared snapshot + 30s member-role cache).
  visibilityCache.clear()
}

// An identity's Server Onboarding state changed (emulated roles can change
// what it may VIEW): drop that identity's cached visibility.
export function invalidateIdentityVisibility(ownerKey: string): void {
  visibilityCache.delete(ownerKey)
}

// Route a bridge.perms.changed payload to the narrowest invalidation: a
// Discord member's roles changed → that member (+ all visibility); a
// web-identity-only change (perk floor, onboarding roles: `keys`/`userId`,
// no discordId) → just those identities' visibility, keeping the shared guild
// snapshot and member-role cache; no target at all → everything.
export function invalidateVisibilityForEvent(seq: number, payload: Record<string, unknown>): void {
  const discordId = typeof payload.discordId === 'string' && payload.discordId ? payload.discordId : null
  const guildId = typeof payload.guildId === 'string' && payload.guildId ? payload.guildId : null
  if (discordId || isGlobalPermsEvent(payload)) {
    invalidateVisibility(seq, discordId, guildId)
    return
  }
  const keys = Array.isArray(payload.keys) ? payload.keys.filter((k): k is string => typeof k === 'string') : []
  if (typeof payload.userId === 'number') keys.push(...siteChatKeys(payload.userId), `user:${payload.userId}`)
  for (const key of keys) {
    visibilityCache.delete(key)
    if (key.startsWith('discord:')) forgetMemberRoles(key.slice('discord:'.length))
  }
}

// A guild's bridged channel set or layout changed (bridge.channels.changed
// from the bot): refetch that guild's snapshot and recompute every socket's
// visibility (a channel may have been bridged, moved or disabled).
export function invalidateForChannelsChanged(seq: number, payload: Record<string, unknown>): void {
  if (seq === lastInvalidatedSeq) return
  lastInvalidatedSeq = seq
  const guildId = typeof payload.guildId === 'string' && payload.guildId ? payload.guildId : null
  invalidateGuildSnapshot(guildId)
  visibilityCache.clear()
}

function eventChannelId(payload: Record<string, unknown>): string | null {
  if (typeof payload.channelId === 'string' && payload.channelId) return payload.channelId
  const message = payload.message as { channelId?: unknown } | undefined
  if (message && typeof message.channelId === 'string' && message.channelId) return message.channelId
  return null
}

// Does a targeted bridge event name this identity? Moderation events carry
// `targetKeys` (every key of the target webhook; legacy events only a raw
// Discord id in `target`); perms.changed events carry `keys` and/or
// `discordId` / `userId`. Pure.
export function eventTargetsIdentity(
  payload: Record<string, unknown>,
  identity: { keys: string[]; discordId: string | null },
): boolean {
  const listed = Array.isArray(payload.targetKeys) ? payload.targetKeys : Array.isArray(payload.keys) ? payload.keys : []
  if (listed.some((k) => typeof k === 'string' && identity.keys.includes(k))) return true
  const target = typeof payload.target === 'string' ? payload.target : null
  if (target && (identity.keys.includes(target) || (identity.discordId !== null && target === identity.discordId))) return true
  const discordId = typeof payload.discordId === 'string' ? payload.discordId : null
  if (discordId && discordId === identity.discordId) return true
  const userId = typeof payload.userId === 'number' ? payload.userId : null
  return userId !== null && siteChatKeys(userId).some((key) => identity.keys.includes(key))
}

// A perms.changed event with no target at all is global (chat-role
// definitions changed).
export function isGlobalPermsEvent(payload: Record<string, unknown>): boolean {
  return !(typeof payload.discordId === 'string' && payload.discordId)
    && typeof payload.userId !== 'number'
    && !(Array.isArray(payload.keys) && payload.keys.length)
}

// Per-type delivery rule for one bridge event to one socket:
// - message / message.edited / message.deleted / reaction / typing / pins /
//   lockdown: only to sockets that can VIEW the event's channel.
// - timeout / untimeout / ban / unban (carry the target, reason, issuer): only
//   to the affected webhook (any of its keys - web-only, linked, or Discord)
//   and to moderators (in that channel's guild) who can VIEW the channel; a
//   channel-less one only to the target and site admins.
// - presence: deliberately site-wide (presence belongs to the site account,
//   not to a guild).
// - perms.changed: a targeted one only to that webhook's sockets; a global
//   one (chat-role definitions changed) to everyone.
// - onboarding.updated: only to the targeted webhook's sockets.
// - channels.changed: to every socket (it carries only the guild id; clients
//   refetch guilds + that guild's channels).
// - Any other bridge event without a channel id is withheld (fail closed).
export function allowBridgeEvent(event: { type: string; payload: Record<string, unknown> }, vis: SocketVisibility): boolean {
  const payload = event.payload || {}
  switch (event.type) {
    case 'bridge.channels.changed':
      return true
    case 'bridge.perms.changed':
      return isGlobalPermsEvent(payload) || eventTargetsIdentity(payload, vis)
    // Per-identity state (Server Onboarding answers / channel opt-ins): only
    // to that webhook's own sockets.
    case 'bridge.onboarding.updated':
      return eventTargetsIdentity(payload, vis)
    // Presence: the owner's own sockets get the shown state (self event); other
    // sockets get the public status only while they share a guild context
    // (can view some channel). Never the owner's invisible choice.
    case 'bridge.presence.self':
      return eventTargetsIdentity(payload, vis)
    case 'bridge.presence':
      return vis.channels.size > 0 && !eventTargetsIdentity(payload, vis)
    case 'bridge.timeout':
    case 'bridge.untimeout':
    case 'bridge.ban':
    case 'bridge.unban': {
      if (eventTargetsIdentity(payload, vis)) return true
      const channelId = eventChannelId(payload)
      // No channel: the target (above) and site admins only - a moderator
      // of one guild must not see another guild's moderation.
      return channelId ? vis.moderatorChannels.has(channelId) && vis.channels.has(channelId) : vis.siteAdmin
    }
    default: {
      const channelId = eventChannelId(payload)
      return channelId !== null && vis.channels.has(channelId)
    }
  }
}

// --- Live gateway messages (bot side) ---------------------------------------

// Build a LiveContext from the bot's gateway cache for liveMessageToBridge().
// `chatTiers` is read from discord_bridge_chat_role (cached 60s).
let tierCache: { expires: number; tiers: Map<string, string> } | null = null
export async function chatTierMap(): Promise<Map<string, string>> {
  if (tierCache && tierCache.expires > Date.now()) return tierCache.tiers
  const rows = await query<{ role_id: string; tier: string }>(`SELECT role_id, tier FROM discord_bridge_chat_role`)
    .then((r) => r.rows).catch(() => [] as Array<{ role_id: string; tier: string }>)
  tierCache = { expires: Date.now() + 60_000, tiers: new Map(rows.map((r) => [r.role_id, r.tier])) }
  return tierCache.tiers
}
