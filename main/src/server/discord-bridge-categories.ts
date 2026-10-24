// Category-based bridging (config.discord.bridgeCategories), pure core.
//
// Every text (0) / announcement (5) channel inside a configured category is
// bridged, plus the individually configured legacy channels
// (config.discord.bridgeChannels). The bot (discord-bridge-bot.ts) feeds this
// the gateway's channel cache on startup and after every channel / guild
// gateway event, then upserts the result, disables enabled rows outside it,
// and emits `bridge.channels.changed { guildId }` for every guild whose
// bridged set or layout signature changed.

// Discord channel types the bridge mirrors (the chatbox renders both).
export const BRIDGEABLE_CHANNEL_TYPES: ReadonlySet<number> = new Set([0, 5])
export const CATEGORY_CHANNEL_TYPE = 4

export interface BridgeChannelLike {
  id: string
  type: number
  guildId: string
  parentId: string | null
}

// Is this channel bridged under the configured categories / legacy ids?
export function isBridgeable(
  channel: Pick<BridgeChannelLike, 'id' | 'type' | 'parentId'>,
  categoryIds: ReadonlySet<string>,
  legacyIds: ReadonlySet<string>,
): boolean {
  if (!BRIDGEABLE_CHANNEL_TYPES.has(channel.type)) return false
  return legacyIds.has(channel.id) || Boolean(channel.parentId && categoryIds.has(channel.parentId))
}

// The bridged subset of `channels` (any guilds), in input order, deduped.
export function resolveBridgedChannels<T extends BridgeChannelLike>(
  channels: Iterable<T>,
  categoryIds: ReadonlySet<string>,
  legacyIds: ReadonlySet<string>,
): T[] {
  const out: T[] = []
  const seen = new Set<string>()
  for (const channel of channels) {
    if (seen.has(channel.id) || !isBridgeable(channel, categoryIds, legacyIds)) continue
    seen.add(channel.id)
    out.push(channel)
  }
  return out
}

// What the web sidebar shows of one guild: each bridged channel's name,
// topic, position, type, category and permission overwrites, and each of
// their categories' name, position and overwrites. Any change here means the
// guild's /channels response may differ.
export interface LayoutEntry {
  id: string
  guildId: string
  kind: 'channel' | 'category'
  name: string
  topic?: string
  position: number
  type: number
  parentId: string | null
  overwrites: string
}

export function layoutSignatures(entries: Iterable<LayoutEntry>): Map<string, string> {
  const byGuild = new Map<string, string[]>()
  for (const e of entries) {
    const list = byGuild.get(e.guildId) || []
    list.push([e.kind, e.id, e.name, e.topic || '', e.position, e.type, e.parentId || '', e.overwrites].join('\u0001'))
    byGuild.set(e.guildId, list)
  }
  const out = new Map<string, string>()
  for (const [guildId, list] of byGuild) out.set(guildId, list.sort().join('\u0002'))
  return out
}

// Guilds whose signature differs between two snapshots (added, removed or
// changed), sorted.
export function changedGuilds(prev: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>): string[] {
  const out = new Set<string>()
  for (const [guildId, sig] of next) if (prev.get(guildId) !== sig) out.add(guildId)
  for (const guildId of prev.keys()) if (!next.has(guildId)) out.add(guildId)
  return [...out].sort()
}

// A stable string for a channel's permission overwrites (order-insensitive).
export function overwritesKey(overwrites: Iterable<{ id: string; type: number | string; allow: string | bigint; deny: string | bigint }>): string {
  return [...overwrites]
    .map((o) => `${o.id}:${o.type}:${String(o.allow)}:${String(o.deny)}`)
    .sort()
    .join(',')
}

// Configured ids, cleaned (non-empty strings, deduped).
export function configuredIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim()))]
}

// Can @everyone VIEW this channel on Discord? The guild's @everyone role
// permissions, then the channel's own @everyone overwrite (a category-synced
// channel carries its category's overwrites, so that is covered too).
// Administrator on @everyone = everything. Stored as
// discord_bridge_channel.everyone_can_view: the fail-closed fallback gate
// while a guild snapshot is unavailable. Pure.
const ADMINISTRATOR = 1n << 3n
const VIEW_CHANNEL = 1n << 10n
export function everyoneCanView(input: {
  guildId: string
  everyonePermissions: bigint
  overwrites: Iterable<{ id: string; type: number | string; allow: bigint; deny: bigint }>
}): boolean {
  let bits = input.everyonePermissions
  if (bits & ADMINISTRATOR) return true
  for (const o of input.overwrites) {
    const isRole = o.type === 0 || o.type === 'role' || o.type === '0'
    if (!isRole || o.id !== input.guildId) continue
    bits = (bits & ~o.deny) | o.allow
  }
  return (bits & VIEW_CHANNEL) !== 0n
}

// Rows the sync must NOT disable even though they fell out of the resolved
// set: a configured category or legacy channel that failed to resolve (a
// typo, a foreign or deleted id, a non-category id) would otherwise silently
// disable everything bridged under it. Such rows stay as they are until the
// config is fixed (the sync logs the id loudly). Pure.
export function protectedFromDisable(
  row: { channelId: string; parentId: string | null },
  unresolvedCategoryIds: ReadonlySet<string>,
  unresolvedLegacyIds: ReadonlySet<string>,
): boolean {
  return unresolvedLegacyIds.has(row.channelId) || Boolean(row.parentId && unresolvedCategoryIds.has(row.parentId))
}
