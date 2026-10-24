// Category-based bridging (config.discord.bridgeCategories), pure core.
//
// Every text (0) / announcement (5) / forum (15) channel inside a configured
// category is bridged, plus the individually configured legacy channels
// (config.discord.bridgeChannels). Media channels (16, a Discord beta) only
// with config.discord.bridge.mediaChannels === true. Threads (forum posts)
// are never configured or bridged on their own: they come with their forum. The bot (discord-bridge-bot.ts) feeds this
// the gateway's channel cache on startup and after every channel / guild
// gateway event, then upserts the result, disables enabled rows outside it,
// and emits `bridge.channels.changed { guildId }` for every guild whose
// bridged set or layout signature changed.

// Discord channel types the bridge mirrors: text and announcement channels
// (message lists) and forums (post lists).
export const BRIDGEABLE_CHANNEL_TYPES: ReadonlySet<number> = new Set([0, 5, 15])
export const MEDIA_CHANNEL_TYPE = 16
export const FORUM_CHANNEL_TYPE = 15
export const CATEGORY_CHANNEL_TYPE = 4
// Gateway-only channel flag (from 2026-11-16): the bot can't view the
// channel and its metadata is redacted. Never bridged, whatever its name.
export const CHANNEL_FLAG_OBFUSCATED = 1 << 17

export interface BridgeChannelLike {
  id: string
  type: number
  guildId: string
  parentId: string | null
  // Discord channel flags (CHANNEL_OBFUSCATED); absent = 0.
  flags?: number
}

export interface BridgeableOptions {
  // config.discord.bridge.mediaChannels === true.
  media?: boolean
}

export function isThreadOnlyType(type: number): boolean {
  return type === FORUM_CHANNEL_TYPE || type === MEDIA_CHANNEL_TYPE
}

// Is this channel bridged under the configured categories / legacy ids?
export function isBridgeable(
  channel: Pick<BridgeChannelLike, 'id' | 'type' | 'parentId' | 'flags'>,
  categoryIds: ReadonlySet<string>,
  legacyIds: ReadonlySet<string>,
  opts: BridgeableOptions = {},
): boolean {
  const typeOk = BRIDGEABLE_CHANNEL_TYPES.has(channel.type) || (opts.media === true && channel.type === MEDIA_CHANNEL_TYPE)
  if (!typeOk) return false
  if (((channel.flags ?? 0) & CHANNEL_FLAG_OBFUSCATED) !== 0) return false
  return legacyIds.has(channel.id) || Boolean(channel.parentId && categoryIds.has(channel.parentId))
}

// The bridged subset of `channels` (any guilds), in input order, deduped.
export function resolveBridgedChannels<T extends BridgeChannelLike>(
  channels: Iterable<T>,
  categoryIds: ReadonlySet<string>,
  legacyIds: ReadonlySet<string>,
  opts: BridgeableOptions = {},
): T[] {
  const out: T[] = []
  const seen = new Set<string>()
  for (const channel of channels) {
    if (seen.has(channel.id) || !isBridgeable(channel, categoryIds, legacyIds, opts)) continue
    seen.add(channel.id)
    out.push(channel)
  }
  return out
}

// What the web sidebar shows of one guild: each bridged channel's name,
// topic, position, type, category and permission overwrites, and each of
// their categories' name, position and overwrites. A forum adds its settings
// (forumSignature: tags, flags, sort / layout defaults, default reaction), so
// a tag or guidelines change emits bridge.channels.changed. Any change here
// means the guild's /channels response may differ.
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
  forum?: string
}

// A stable string for a forum's settings (order of tags kept: Discord's
// order is the display order). Pure.
export function forumSignature(f: {
  availableTags: Array<{ id: string; name: string; moderated: boolean; emoji_id: string | null; emoji_name: string | null }>
  defaultReactionEmoji: { emoji_id: string | null; emoji_name: string | null } | null
  defaultSortOrder: number | null
  defaultForumLayout: number
  flags: number
}): string {
  const tags = f.availableTags.map((t) => [t.id, t.name, t.moderated ? 1 : 0, t.emoji_id || '', t.emoji_name || ''].join(':')).join(',')
  const reaction = f.defaultReactionEmoji ? `${f.defaultReactionEmoji.emoji_id || ''}:${f.defaultReactionEmoji.emoji_name || ''}` : ''
  return [tags, reaction, f.defaultSortOrder ?? '', f.defaultForumLayout, f.flags].join('|')
}

export function layoutSignatures(entries: Iterable<LayoutEntry>): Map<string, string> {
  const byGuild = new Map<string, string[]>()
  for (const e of entries) {
    const list = byGuild.get(e.guildId) || []
    list.push([e.kind, e.id, e.name, e.topic || '', e.position, e.type, e.parentId || '', e.overwrites, e.forum || ''].join('\u0001'))
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
