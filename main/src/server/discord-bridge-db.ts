import { query, getPool } from './db.js'
import { emit, DISCORD_BRIDGE_OWNER_KEY } from './events.js'
import type { BridgeInteraction } from './discord-interactions.js'
import { webIdentityKey } from './chat-identity-key.ts'

export interface BridgeChannel {
  id: number
  channelId: string
  guildId: string
  name: string
  topic: string
  position: number
  enabled: boolean
  locked: boolean
  // The channel's Discord category (migration 029), null when uncategorized.
  parentId: string | null
  // @everyone can VIEW it on Discord (computed by the bot, migration 029).
  // The fail-closed fallback when the guild snapshot is unavailable: only
  // such channels stay readable (FALSE until the bot has synced it).
  everyoneCanView: boolean
  // Discord channel type (migration 038): 0 text, 5 announcement, 15 forum,
  // 16 media. A forum/media channel holds posts only, no messages of its own.
  type: number
  // Discord channel flags (REQUIRE_TAG 16 on a forum).
  flags: number
  // The forum's settings for type 15/16 (null for every other type).
  forum: ForumMeta | null
}

// --- Forum channels (migration 038) -------------------------------------------
// A forum (15) or media (16) channel holds only posts. A post is a Discord
// thread; its id is the thread id, or `post:<n>` (discord_bridge_post.id n)
// while a web-created post waits for its webhook delivery. Messages in a post
// are ordinary rows whose channel_id is the post id. See holt
// docs/forum/contract.md.

export const FORUM_CHANNEL_TYPES: ReadonlySet<number> = new Set([15, 16])
export const CHANNEL_FLAG_PINNED = 1 << 1
export const CHANNEL_FLAG_REQUIRE_TAG = 1 << 4

export function isForumType(type: number | null | undefined): boolean {
  return typeof type === 'number' && FORUM_CHANNEL_TYPES.has(type)
}

export interface ForumTag {
  id: string
  name: string
  moderated: boolean
  emoji: { id: string | null; name: string | null } | null
}

export interface ForumMeta {
  availableTags: ForumTag[]
  defaultReactionEmoji: { id: string | null; name: string | null } | null
  // 0 latest activity, 1 creation date, null = not set (activity).
  defaultSortOrder: 0 | 1 | null
  // 0 not set (list), 1 list, 2 gallery.
  defaultLayout: 0 | 1 | 2
  requireTag: boolean
  // The forum topic: Discord's Post Guidelines (markdown, up to 4096 chars).
  guidelines: string
  media: boolean
}

function emojiOf(id: unknown, name: unknown): { id: string | null; name: string | null } | null {
  const eid = typeof id === 'string' && id ? id : null
  const ename = typeof name === 'string' && name ? name : null
  return eid || ename ? { id: eid, name: ename } : null
}

// Discord's tag objects ({id, name, moderated, emoji_id, emoji_name}, as
// stored) or discord.js's ({..., emoji: {id, name}}) → the contract shape.
// Malformed entries are dropped. Pure.
export function normalizeForumTags(raw: unknown): ForumTag[] {
  if (!Array.isArray(raw)) return []
  const out: ForumTag[] = []
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue
    const o = t as Record<string, unknown>
    if (typeof o.id !== 'string' || !o.id) continue
    const nested = o.emoji && typeof o.emoji === 'object' ? (o.emoji as Record<string, unknown>) : null
    out.push({
      id: o.id,
      name: typeof o.name === 'string' ? o.name : '',
      moderated: o.moderated === true,
      emoji: nested ? emojiOf(nested.id, nested.name) : emojiOf(o.emoji_id, o.emoji_name),
    })
  }
  return out
}

// The stored default_reaction_emoji ({emoji_id, emoji_name} or {id, name}). Pure.
export function normalizeReactionEmoji(raw: unknown): { id: string | null; name: string | null } | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  return 'emoji_id' in o || 'emoji_name' in o ? emojiOf(o.emoji_id, o.emoji_name) : emojiOf(o.id, o.name)
}

// The forum block of a channel row (null for non-forum types). Pure.
export function forumMetaOf(row: {
  type: number
  topic: string
  flags: number
  available_tags?: unknown
  default_reaction_emoji?: unknown
  default_sort_order?: number | null
  default_forum_layout?: number | null
}): ForumMeta | null {
  if (!isForumType(row.type)) return null
  const sort = row.default_sort_order
  const layout = row.default_forum_layout
  return {
    availableTags: normalizeForumTags(row.available_tags),
    defaultReactionEmoji: normalizeReactionEmoji(row.default_reaction_emoji),
    defaultSortOrder: sort === 0 || sort === 1 ? sort : null,
    defaultLayout: layout === 1 || layout === 2 ? layout : 0,
    requireTag: (row.flags & CHANNEL_FLAG_REQUIRE_TAG) !== 0,
    guidelines: (row.topic || '').slice(0, 4096),
    media: row.type === 16,
  }
}

export interface BridgeMessage {
  id: number
  channelId: string
  direction: 'discord' | 'web'
  discordMessageId: string | null
  /** A forum post's first message: Discord gives it the thread's own id. */
  starter?: boolean
  authorKey: string
  authorName: string
  authorAvatar: string | null
  authorColor: string | null
  authorRole: string | null
  // Discord APP tag: a Discord-originated row authored by a bot/webhook.
  authorBot: boolean
  content: string
  attachments: unknown[]
  embeds: unknown[]
  mentions: unknown[]
  replyTo: string | null
  // Reply "@ ON/OFF": whether this reply pings the replied-to author.
  // Always true for non-replies (column default).
  replyMention: boolean
  clientId: string | null
  createdAt: string
  editedAt: string | null
  deletedAt: string | null
  reactions: BridgeReaction[]
  // Forward snapshot (Discord's Forward): the source message's content/
  // attachments/embeds at forward time. null for ordinary messages.
  forwarded: ForwardSnapshot | null
  // Application-command / components data (migration 019). messageType is
  // Discord's message type (20 slash command, 23 context-menu command);
  // interaction is the "{user} used /cmd" metadata; components the normalized
  // V1/V2 tree (discord-interactions.ts); flags Discord's message flags.
  messageType?: number
  interaction?: BridgeInteraction | null
  components?: unknown[]
  flags?: number
}

// Discord message_snapshots[0].message, normalized. Rendered under the
// "Forwarded" header; its mentions are display-only and never ping.
export interface ForwardSnapshot {
  content: string
  attachments: unknown[]
  embeds: unknown[]
  mentions: unknown[]
  createdAt: string | null
  channelId: string | null
  messageId: string | null
  guildId: string | null
  // Components of the forwarded source (Discord snapshots carry them).
  components?: unknown[]
}

// One emoji's reaction state on a message: the total count of real reactors
// (webhooks + Discord users + other bots, never the bridge bot itself) and the
// reactor keys, so the client can tell whether the caller reacted.
export interface BridgeReaction {
  emoji: string
  count: number
  reactorKeys: string[]
}

export interface RecordMessageInput {
  channelId: string
  direction: 'discord' | 'web'
  discordMessageId?: string | null
  authorKey: string
  authorName: string
  authorAvatar?: string | null
  authorColor?: string | null
  authorRole?: string | null
  authorBot?: boolean
  content: string
  attachments?: unknown[]
  embeds?: unknown[]
  mentions?: unknown[]
  replyTo?: string | null
  replyMention?: boolean
  clientId?: string | null
  createdAt?: Date
  forwarded?: ForwardSnapshot | null
}

interface ChannelRow {
  id: string
  channel_id: string
  guild_id: string
  name: string
  topic: string
  position: number
  enabled: boolean
  locked: boolean
  parent_id?: string | null
  everyone_can_view?: boolean | null
  type?: number | null
  flags?: number | null
  available_tags?: unknown
  default_reaction_emoji?: unknown
  default_sort_order?: number | null
  default_forum_layout?: number | null
}

interface MessageRow {
  id: string
  channel_id: string
  direction: 'discord' | 'web'
  discord_message_id: string | null
  author_key: string
  author_name: string
  author_avatar: string | null
  author_color: string | null
  author_role: string | null
  author_bot?: boolean | null
  message_type?: number | null
  interaction?: BridgeInteraction | null
  components?: unknown[] | null
  flags?: number | null
  content: string
  attachments: unknown[]
  embeds: unknown[]
  mentions: unknown[]
  reply_to: string | null
  reply_mention?: boolean | null
  client_id: string | null
  created_at: string
  edited_at: string | null
  deleted_at: string | null
  forwarded?: ForwardSnapshot | null
}

function toChannel(row: ChannelRow): BridgeChannel {
  const type = typeof row.type === 'number' ? row.type : 0
  const flags = typeof row.flags === 'number' ? row.flags : 0
  return {
    type,
    flags,
    forum: forumMetaOf({ ...row, type, flags, topic: row.topic }),
    id: Number(row.id),
    channelId: row.channel_id,
    guildId: row.guild_id,
    name: row.name,
    topic: row.topic,
    position: row.position,
    enabled: row.enabled,
    locked: row.locked ?? false,
    parentId: row.parent_id ?? null,
    everyoneCanView: row.everyone_can_view === true,
  }
}

export async function setChannelLocked(channelId: string, locked: boolean): Promise<void> {
  await query(`UPDATE discord_bridge_channel SET locked = $2 WHERE channel_id = $1`, [channelId, locked])
}

export function toMessage(row: MessageRow): BridgeMessage {
  return {
    id: Number(row.id),
    channelId: row.channel_id,
    direction: row.direction,
    discordMessageId: row.discord_message_id,
    ...(row.discord_message_id !== null && row.discord_message_id === row.channel_id ? { starter: true } : {}),
    authorKey: row.author_key,
    authorName: row.author_name,
    authorAvatar: row.author_avatar,
    authorColor: row.author_color,
    authorRole: row.author_role ?? null,
    authorBot: row.author_bot === true,
    content: row.content,
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    embeds: Array.isArray(row.embeds) ? row.embeds : [],
    mentions: Array.isArray(row.mentions) ? row.mentions : [],
    replyTo: row.reply_to,
    replyMention: row.reply_mention !== false,
    clientId: row.client_id,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    reactions: [],
    forwarded: row.forwarded && typeof row.forwarded === 'object' ? row.forwarded : null,
    messageType: typeof row.message_type === 'number' ? row.message_type : 0,
    interaction: row.interaction && typeof row.interaction === 'object' ? row.interaction : null,
    components: Array.isArray(row.components) ? row.components : [],
    flags: typeof row.flags === 'number' ? row.flags : 0,
  }
}

export const MESSAGE_COLS = `id, channel_id, direction, discord_message_id, author_key, author_name,
  author_avatar, author_color, author_role, content, attachments, embeds, mentions, reply_to, client_id,
  created_at, edited_at, deleted_at, forwarded, reply_mention, author_bot,
  message_type, interaction, components, flags`

// Attach reaction state to a set of messages (one query for the batch).
async function withReactions(messages: BridgeMessage[]): Promise<BridgeMessage[]> {
  if (!messages.length) return messages
  const ids = messages.map((m) => m.id)
  const { rows } = await query<{ message_id: string; emoji: string; reactor_key: string }>(
    `SELECT message_id, emoji, reactor_key FROM discord_bridge_reaction
     WHERE message_id = ANY($1::bigint[]) AND reactor_key <> '__bridgebot'
     ORDER BY id`,
    [ids],
  )
  const byMessage = new Map<number, Map<string, string[]>>()
  for (const row of rows) {
    const mid = Number(row.message_id)
    if (!byMessage.has(mid)) byMessage.set(mid, new Map())
    const em = byMessage.get(mid)!
    if (!em.has(row.emoji)) em.set(row.emoji, [])
    em.get(row.emoji)!.push(row.reactor_key)
  }
  for (const message of messages) {
    const em = byMessage.get(message.id)
    if (em) {
      message.reactions = [...em.entries()].map(([emoji, reactorKeys]) => ({ emoji, count: reactorKeys.length, reactorKeys }))
    }
  }
  return messages
}

const CHANNEL_COLS = `id, channel_id, guild_id, name, topic, position, enabled, locked, parent_id, everyone_can_view,
  type, flags, available_tags, default_reaction_emoji, default_sort_order, default_forum_layout`

// `guildId` limits the list to one guild's channels.
export async function listChannels(enabledOnly = true, guildId?: string): Promise<BridgeChannel[]> {
  const where: string[] = []
  const params: unknown[] = []
  if (enabledOnly) where.push('enabled = TRUE')
  if (guildId) {
    params.push(guildId)
    where.push(`guild_id = $${params.length}`)
  }
  const { rows } = await query<ChannelRow>(
    `SELECT ${CHANNEL_COLS}
     FROM discord_bridge_channel ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY position ASC, id ASC`,
    params,
  )
  return rows.map(toChannel)
}

// Guild ids with at least one ENABLED bridged channel: the bridged guild set.
export async function bridgedGuildIds(): Promise<string[]> {
  const { rows } = await query<{ guild_id: string }>(
    `SELECT DISTINCT guild_id FROM discord_bridge_channel WHERE enabled = TRUE AND guild_id <> '' ORDER BY guild_id`,
  )
  return rows.map((r) => r.guild_id)
}

// Stop bridging a channel (moved out of a bridged category, deleted, or no
// longer configured). The row, its webhook and its history are kept, so a
// channel moved back in resumes with its old messages (upsertChannel
// re-enables it). Returns whether a row was enabled before.
export async function disableChannel(channelId: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE discord_bridge_channel SET enabled = FALSE WHERE channel_id = $1 AND enabled = TRUE`,
    [channelId],
  )
  return Boolean(rowCount)
}

// Newest non-deleted message id per channel (one query; unread badges for
// channels the client hasn't opened). Channels without messages map to null.
// A forum (no messages of its own) maps to the newest message in any of its
// live posts.
export async function lastMessageIds(channelIds: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>()
  if (!channelIds.length) return out
  const { rows } = await query<{ channel_id: string; id: string | null }>(
    `SELECT c.channel_id,
            GREATEST(
              (SELECT m.id FROM discord_bridge_message m
                WHERE m.channel_id = c.channel_id AND m.deleted_at IS NULL
                ORDER BY m.id DESC LIMIT 1),
              (SELECT max(x.id) FROM discord_bridge_post p
                 CROSS JOIN LATERAL (SELECT m.id FROM discord_bridge_message m
                   WHERE m.channel_id = COALESCE(p.thread_id, 'post:' || p.id) AND m.deleted_at IS NULL
                   ORDER BY m.id DESC LIMIT 1) x
                WHERE p.channel_id = c.channel_id AND p.deleted_at IS NULL)
            ) AS id
     FROM unnest($1::text[]) AS c(channel_id)`,
    [channelIds],
  )
  for (const r of rows) out.set(r.channel_id, r.id === null ? null : Number(r.id))
  return out
}

export async function channelFor(channelId: string): Promise<BridgeChannel | null> {
  const { rows } = await query<ChannelRow>(
    `SELECT ${CHANNEL_COLS}
     FROM discord_bridge_channel WHERE channel_id = $1`,
    [channelId],
  )
  return rows[0] ? toChannel(rows[0]) : null
}

export async function upsertChannel(input: {
  channelId: string
  guildId: string
  name: string
  topic?: string
  position?: number
  // Discord category id (null = uncategorized). undefined keeps the stored one.
  parentId?: string | null
  // @everyone VIEW_CHANNEL (see BridgeChannel.everyoneCanView). undefined
  // keeps the stored value.
  everyoneCanView?: boolean
  webhookId?: string | null
  webhookToken?: string | null
  // Discord channel type (0 / 5 / 15 / 16). undefined keeps the stored one.
  type?: number
  // Discord channel flags for a non-forum channel. undefined keeps them.
  flags?: number
  // A forum's settings (type 15/16), Discord's raw shapes. undefined keeps
  // the stored ones.
  forum?: ForumChannelInput
}): Promise<void> {
  // ONLY the bot's bridge-set sync calls this: it (re-)enables the row.
  // Message persistence uses updateChannelMetadata, which never enables.
  const f = input.forum
  await query(
    `INSERT INTO discord_bridge_channel (channel_id, guild_id, name, topic, position, webhook_id, webhook_token, parent_id, everyone_can_view,
       type, available_tags, default_reaction_emoji, default_sort_order, default_forum_layout, flags,
       default_thread_rate_limit_per_user, rate_limit_per_user)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($10::boolean, FALSE),
       COALESCE($11::smallint, 0), COALESCE($13::jsonb, '[]'::jsonb), $14::jsonb, $15::smallint, COALESCE($16::smallint, 0), COALESCE($17::int, 0),
       COALESCE($18::int, 0), COALESCE($19::int, 0))
     ON CONFLICT (channel_id) DO UPDATE SET
       name = EXCLUDED.name,
       topic = EXCLUDED.topic,
       position = EXCLUDED.position,
       guild_id = EXCLUDED.guild_id,
       parent_id = CASE WHEN $9::boolean THEN EXCLUDED.parent_id ELSE discord_bridge_channel.parent_id END,
       everyone_can_view = COALESCE($10::boolean, discord_bridge_channel.everyone_can_view),
       webhook_id = COALESCE(EXCLUDED.webhook_id, discord_bridge_channel.webhook_id),
       webhook_token = COALESCE(EXCLUDED.webhook_token, discord_bridge_channel.webhook_token),
       type = COALESCE($11::smallint, discord_bridge_channel.type),
       available_tags = CASE WHEN $12::boolean THEN COALESCE($13::jsonb, '[]'::jsonb) ELSE discord_bridge_channel.available_tags END,
       default_reaction_emoji = CASE WHEN $12::boolean THEN $14::jsonb ELSE discord_bridge_channel.default_reaction_emoji END,
       default_sort_order = CASE WHEN $12::boolean THEN $15::smallint ELSE discord_bridge_channel.default_sort_order END,
       default_forum_layout = CASE WHEN $12::boolean THEN COALESCE($16::smallint, 0) ELSE discord_bridge_channel.default_forum_layout END,
       flags = COALESCE($17::int, discord_bridge_channel.flags),
       default_thread_rate_limit_per_user = COALESCE($18::int, discord_bridge_channel.default_thread_rate_limit_per_user),
       rate_limit_per_user = COALESCE($19::int, discord_bridge_channel.rate_limit_per_user),
       enabled = TRUE`,
    [
      input.channelId,
      input.guildId,
      input.name,
      input.topic || '',
      input.position ?? 0,
      input.webhookId ?? null,
      input.webhookToken ?? null,
      input.parentId ?? null,
      input.parentId !== undefined,
      input.everyoneCanView ?? null,
      typeof input.type === 'number' ? input.type : null,
      f !== undefined,
      f ? JSON.stringify(f.availableTags || []) : null,
      f && f.defaultReactionEmoji ? JSON.stringify(f.defaultReactionEmoji) : null,
      f && (f.defaultSortOrder === 0 || f.defaultSortOrder === 1) ? f.defaultSortOrder : null,
      f ? (f.defaultForumLayout ?? 0) : null,
      f ? (f.flags ?? 0) : (typeof input.flags === 'number' ? input.flags : null),
      f ? (f.defaultThreadRateLimitPerUser ?? 0) : null,
      f ? (f.rateLimitPerUser ?? 0) : null,
    ],
  )
}

// A forum's settings as the bot reads them from Discord (raw API shapes:
// tags {id, name, moderated, emoji_id, emoji_name}, default reaction
// {emoji_id, emoji_name}).
export interface ForumChannelInput {
  availableTags: Array<{ id: string; name: string; moderated: boolean; emoji_id: string | null; emoji_name: string | null }>
  defaultReactionEmoji: { emoji_id: string | null; emoji_name: string | null } | null
  defaultSortOrder: number | null
  defaultForumLayout: number
  flags: number
  defaultThreadRateLimitPerUser: number
  rateLimitPerUser: number
}

// Refresh an EXISTING row's display metadata (message persistence path).
// Never inserts and never touches `enabled`, so a late message can't
// re-enable a channel the sync just disabled.
export async function updateChannelMetadata(input: {
  channelId: string
  name: string
  topic?: string
  position?: number
  parentId?: string | null
}): Promise<void> {
  await query(
    `UPDATE discord_bridge_channel SET name = $2, topic = $3, position = $4, parent_id = $5 WHERE channel_id = $1`,
    [input.channelId, input.name, input.topic || '', input.position ?? 0, input.parentId ?? null],
  )
}

// Store a (re)created webhook on an existing row; never touches `enabled`.
export async function setChannelWebhook(channelId: string, webhookId: string, webhookToken: string): Promise<void> {
  await query(
    `UPDATE discord_bridge_channel SET webhook_id = $2, webhook_token = $3 WHERE channel_id = $1`,
    [channelId, webhookId, webhookToken],
  )
}

export async function history(channelId: string, beforeId: number | null, limit: number): Promise<BridgeMessage[]> {
  const capped = Math.min(Math.max(limit, 1), 100)
  const { rows } = beforeId
    ? await query<MessageRow>(
      `SELECT ${MESSAGE_COLS} FROM discord_bridge_message
       WHERE channel_id = $1 AND id < $2 ORDER BY id DESC LIMIT $3`,
      [channelId, beforeId, capped],
    )
    : await query<MessageRow>(
      `SELECT ${MESSAGE_COLS} FROM discord_bridge_message
       WHERE channel_id = $1 ORDER BY id DESC LIMIT $2`,
      [channelId, capped],
    )
  return withReactions(rows.map(toMessage).reverse())
}

// One windowed history page, Discord-style (GET /channels/{id}/messages):
// `before` / `after` page away from a cursor, `around` centers on a message
// (jump-to-message), none = the newest page. Each side probes one extra row so
// hasMoreBefore / hasMoreAfter are exact. `around` may be a bridge id or a
// Discord snowflake (reply references carry either); an unknown snowflake
// yields an empty page with `missing: true`.
export interface HistoryWindow {
  messages: BridgeMessage[]
  hasMoreBefore: boolean
  hasMoreAfter: boolean
  missing?: boolean
}

export async function historyWindow(
  channelId: string,
  cursor: { before?: number | null; after?: number | null; around?: string | null },
  limit: number,
): Promise<HistoryWindow> {
  const capped = Math.min(Math.max(limit, 1), 100)
  const older = async (beforeId: number | null, count: number, inclusive = false) => {
    const { rows } = beforeId
      ? await query<MessageRow>(
        `SELECT ${MESSAGE_COLS} FROM discord_bridge_message
         WHERE channel_id = $1 AND id ${inclusive ? '<=' : '<'} $2 ORDER BY id DESC LIMIT $3`,
        [channelId, beforeId, count + 1],
      )
      : await query<MessageRow>(
        `SELECT ${MESSAGE_COLS} FROM discord_bridge_message
         WHERE channel_id = $1 ORDER BY id DESC LIMIT $2`,
        [channelId, count + 1],
      )
    return { rows: rows.slice(0, count).reverse(), more: rows.length > count }
  }
  const newer = async (afterId: number, count: number) => {
    const { rows } = await query<MessageRow>(
      `SELECT ${MESSAGE_COLS} FROM discord_bridge_message
       WHERE channel_id = $1 AND id > $2 ORDER BY id ASC LIMIT $3`,
      [channelId, afterId, count + 1],
    )
    return { rows: rows.slice(0, count), more: rows.length > count }
  }

  if (cursor.around) {
    let target = 0
    if (/^\d{17,20}$/.test(cursor.around)) {
      const { rows } = await query<{ id: string | number }>(
        `SELECT id FROM discord_bridge_message WHERE channel_id = $1 AND discord_message_id = $2 LIMIT 1`,
        [channelId, cursor.around],
      )
      target = rows[0] ? Number(rows[0].id) : 0
      if (!target) return { messages: [], hasMoreBefore: false, hasMoreAfter: false, missing: true }
    } else {
      target = Number(cursor.around)
    }
    if (!Number.isFinite(target) || target <= 0) return { messages: [], hasMoreBefore: false, hasMoreAfter: false, missing: true }
    // Discord splits an around page as ceil(limit/2) at-or-before the target
    // and floor(limit/2) after it.
    const half = Math.floor(capped / 2)
    const [b, a] = await Promise.all([older(target, capped - half, true), newer(target, half)])
    return {
      messages: await withReactions([...b.rows, ...a.rows].map(toMessage)),
      hasMoreBefore: b.more,
      hasMoreAfter: a.more,
    }
  }
  if (cursor.after && cursor.after > 0) {
    const a = await newer(cursor.after, capped)
    return { messages: await withReactions(a.rows.map(toMessage)), hasMoreBefore: true, hasMoreAfter: a.more }
  }
  const b = await older(cursor.before && cursor.before > 0 ? cursor.before : null, capped)
  return {
    messages: await withReactions(b.rows.map(toMessage)),
    hasMoreBefore: b.more,
    // A `before` page is detached from the present only if newer rows exist
    // past the cursor - the client tracks that itself, so report false here.
    hasMoreAfter: false,
  }
}

// Insert a message. Discord-origin rows dedupe on discord_message_id;
// web-origin rows dedupe on (author_key, client_id) for idempotent sends.
// Returns { message, existed } so callers can skip re-broadcasting dupes.
export async function recordMessage(input: RecordMessageInput): Promise<{ message: BridgeMessage; existed: boolean }> {
  if (input.discordMessageId) {
    const { rows } = await query<MessageRow>(
      `INSERT INTO discord_bridge_message
         (channel_id, direction, discord_message_id, author_key, author_name, author_avatar,
          author_color, author_role, content, attachments, embeds, mentions, reply_to, client_id, created_at, forwarded, reply_mention, author_bot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, COALESCE($15, NOW()), $16::jsonb, $17, $18)
       ON CONFLICT (discord_message_id) WHERE discord_message_id IS NOT NULL DO NOTHING
       RETURNING ${MESSAGE_COLS}`,
      [
        input.channelId, input.direction, input.discordMessageId, input.authorKey, input.authorName,
        input.authorAvatar ?? null, input.authorColor ?? null, input.authorRole ?? null, input.content,
        JSON.stringify(input.attachments || []), JSON.stringify(input.embeds || []),
        JSON.stringify(input.mentions || []), input.replyTo ?? null, input.clientId ?? null,
        input.createdAt ?? null, input.forwarded ? JSON.stringify(input.forwarded) : null, input.replyMention !== false,
        input.authorBot === true,
      ],
    )
    if (rows[0]) return { message: toMessage(rows[0]), existed: false }
    const existing = await byDiscordMessageId(input.discordMessageId)
    if (existing) return { message: existing, existed: true }
  }

  if (input.clientId) {
    const { rows } = await query<MessageRow>(
      `INSERT INTO discord_bridge_message
         (channel_id, direction, author_key, author_name, author_avatar, author_color, author_role,
          content, attachments, embeds, mentions, reply_to, client_id, created_at, forwarded, reply_mention)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, COALESCE($14, NOW()), $15::jsonb, $16)
       ON CONFLICT (author_key, client_id) WHERE client_id IS NOT NULL DO NOTHING
       RETURNING ${MESSAGE_COLS}`,
      [
        input.channelId, input.direction, input.authorKey, input.authorName,
        input.authorAvatar ?? null, input.authorColor ?? null, input.authorRole ?? null, input.content,
        JSON.stringify(input.attachments || []), JSON.stringify(input.embeds || []),
        JSON.stringify(input.mentions || []), input.replyTo ?? null, input.clientId,
        input.createdAt ?? null, input.forwarded ? JSON.stringify(input.forwarded) : null, input.replyMention !== false,
      ],
    )
    if (rows[0]) return { message: toMessage(rows[0]), existed: false }
    const { rows: dup } = await query<MessageRow>(
      `SELECT ${MESSAGE_COLS} FROM discord_bridge_message
       WHERE author_key = $1 AND client_id = $2`,
      [input.authorKey, input.clientId],
    )
    if (dup[0]) return { message: toMessage(dup[0]), existed: true }
  }

  const { rows } = await query<MessageRow>(
    `INSERT INTO discord_bridge_message
       (channel_id, direction, author_key, author_name, author_avatar, author_color, author_role,
        content, attachments, embeds, mentions, reply_to, client_id, created_at, forwarded, reply_mention)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, COALESCE($14, NOW()), $15::jsonb, $16)
     RETURNING ${MESSAGE_COLS}`,
    [
      input.channelId, input.direction, input.authorKey, input.authorName,
      input.authorAvatar ?? null, input.authorColor ?? null, input.authorRole ?? null, input.content,
      JSON.stringify(input.attachments || []), JSON.stringify(input.embeds || []),
      JSON.stringify(input.mentions || []), input.replyTo ?? null, input.clientId ?? null,
      input.createdAt ?? null, input.forwarded ? JSON.stringify(input.forwarded) : null, input.replyMention !== false,
    ],
  )
  return { message: toMessage(rows[0]), existed: false }
}

// Store a Discord row's application-command fields (migration 019). Written
// as a follow-up UPDATE right after recordMessage() / before
// editByDiscordMessageId() re-reads the row, so both the insert and edit paths
// broadcast the complete message. `interaction`/`messageType` are omitted on
// edits (they never change after creation).
export async function setInteractionFields(
  discordMessageId: string,
  fields: { messageType?: number; interaction?: BridgeInteraction | null; components: unknown[]; flags: number },
): Promise<void> {
  await query(
    `UPDATE discord_bridge_message
       SET components = $2::jsonb,
           flags = $3,
           message_type = COALESCE($4, message_type),
           interaction = CASE WHEN $5::boolean THEN $6::jsonb ELSE interaction END
     WHERE discord_message_id = $1`,
    [
      discordMessageId, JSON.stringify(fields.components || []), fields.flags | 0,
      typeof fields.messageType === 'number' ? fields.messageType : null,
      fields.interaction !== undefined, fields.interaction ? JSON.stringify(fields.interaction) : null,
    ],
  )
}

export async function messageFor(id: number): Promise<BridgeMessage | null> {
  const { rows } = await query<MessageRow>(
    `SELECT ${MESSAGE_COLS} FROM discord_bridge_message WHERE id = $1`,
    [id],
  )
  if (!rows[0]) return null
  const [message] = await withReactions([toMessage(rows[0])])
  return message
}

export async function byDiscordMessageId(discordMessageId: string): Promise<BridgeMessage | null> {
  const { rows } = await query<MessageRow>(
    `SELECT ${MESSAGE_COLS} FROM discord_bridge_message WHERE discord_message_id = $1`,
    [discordMessageId],
  )
  return rows[0] ? toMessage(rows[0]) : null
}

// Live Discord-origin rows for a channel whose Discord snowflake lies in
// [lo, hi] (inclusive; lo null = no lower bound). Snowflakes are ordered by
// (length, text), which is numeric order for decimal ids. Deleted rows are
// excluded; they need no reconciliation.
export async function discordRowsInWindow(channelId: string, lo: string | null, hi: string): Promise<BridgeMessage[]> {
  const { rows } = await query<MessageRow>(
    `SELECT ${MESSAGE_COLS} FROM discord_bridge_message
     WHERE channel_id = $1 AND direction = 'discord' AND deleted_at IS NULL
       AND discord_message_id IS NOT NULL
       AND (length(discord_message_id), discord_message_id) <= (length($2::text), $2::text)
       AND ($3::text IS NULL OR (length(discord_message_id), discord_message_id) >= (length($3::text), $3::text))
     ORDER BY id`,
    [channelId, hi, lo],
  )
  return rows.map((row) => toMessage(row))
}

export async function attachDiscordMessageId(id: number, discordMessageId: string): Promise<void> {
  await query(
    `UPDATE discord_bridge_message SET discord_message_id = $1 WHERE id = $2 AND discord_message_id IS NULL`,
    [discordMessageId, id],
  ).catch(() => {})
}

// Discord-side messageUpdate. Discord fires MESSAGE_UPDATE both for real
// content edits (edited_timestamp set) and for server-side embed resolution
// (link unfurls, edited_timestamp null). Only a real edit stamps edited_at -
// otherwise every message with a link would show "(edited)". Embeds are
// refreshed either way. Deleted rows are never resurrected. Reactions are
// attached so the client's in-place replace doesn't blank them.
export async function editByDiscordMessageId(
  discordMessageId: string,
  content: string,
  opts: { edited?: boolean; editedAt?: Date | null; embeds?: unknown[]; attachments?: unknown[] } = {},
): Promise<BridgeMessage | null> {
  const edited = opts.edited !== false
  // Stamp Discord's own edited_timestamp when known, so a later embed-only
  // update on an already-edited message doesn't move the "(edited)" time.
  const { rows } = await query<MessageRow>(
    `UPDATE discord_bridge_message
       SET content = $1,
           embeds = COALESCE($3::jsonb, embeds),
           attachments = COALESCE($6::jsonb, attachments),
           edited_at = CASE WHEN $4::boolean THEN COALESCE($5::timestamptz, NOW()) ELSE edited_at END
     WHERE discord_message_id = $2 AND deleted_at IS NULL RETURNING ${MESSAGE_COLS}`,
    [content, discordMessageId, opts.embeds ? JSON.stringify(opts.embeds) : null, edited, opts.editedAt ?? null,
      opts.attachments ? JSON.stringify(opts.attachments) : null],
  )
  if (!rows[0]) return null
  const [message] = await withReactions([toMessage(rows[0])])
  return message
}

// Discord's own embed resolution for a row (MESSAGE_UPDATE carrying embeds):
// replaces ONLY the embeds column - content and edited_at are untouched, so a
// web-originated row never gains "(edited)" and its text stays authoritative.
// Used for web rows (Discord's unfurl of the webhook delivery supersedes the
// site's own preview and carries media-proxy URLs). Returns null when the row
// is gone/deleted or the embeds are unchanged.
export async function setEmbedsByDiscordMessageId(
  discordMessageId: string,
  embeds: unknown[],
): Promise<BridgeMessage | null> {
  const { rows } = await query<MessageRow>(
    `UPDATE discord_bridge_message
       SET embeds = $2::jsonb
     WHERE discord_message_id = $1 AND deleted_at IS NULL
       AND embeds IS DISTINCT FROM $2::jsonb
     RETURNING ${MESSAGE_COLS}`,
    [discordMessageId, JSON.stringify(embeds)],
  )
  if (!rows[0]) return null
  const [message] = await withReactions([toMessage(rows[0])])
  return message
}

// SUPPRESS_EMBEDS (flags | 4): Discord's "Remove embeds". Clears the stored
// embeds and sets the flag; content and edited_at are untouched (Discord
// doesn't mark a suppression as an edit). Deleted rows are skipped.
export async function suppressEmbedsById(id: number): Promise<BridgeMessage | null> {
  const { rows } = await query<MessageRow>(
    `UPDATE discord_bridge_message
       SET flags = flags | 4, embeds = '[]'::jsonb
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING ${MESSAGE_COLS}`,
    [id],
  )
  if (!rows[0]) return null
  const [message] = await withReactions([toMessage(rows[0])])
  return message
}

// Web-originated edit: the caller may only edit their own web message. The
// WHERE clause enforces both ownership (author_key) and direction so a forged
// request can't rewrite a Discord-originated row or someone else's message.
// The mentions array is persisted alongside the content so the permission-aware
// mention gate (applied by the edit endpoint before this call) is recorded
// atomically with the edit - the bot mirrors the edit to Discord using exactly
// these stored mentions for allowedMentions. Returns the updated message, or
// null when nothing matched (unknown message, not the author, or not a web
// message) - the caller distinguishes the cases.
export async function editMessage(id: number, ownerKey: string, content: string, mentions: unknown[] = []): Promise<BridgeMessage | null> {
  const { rows } = await query<MessageRow>(
    `UPDATE discord_bridge_message SET content = $1, mentions = $2, edited_at = NOW()
     WHERE id = $3 AND author_key = $4 AND direction = 'web' AND deleted_at IS NULL AND forwarded IS NULL
     RETURNING ${MESSAGE_COLS}`,
    [content, JSON.stringify(mentions || []), id, ownerKey],
  )
  if (!rows[0]) return null
  const [message] = await withReactions([toMessage(rows[0])])
  return message
}

export async function deleteByDiscordMessageId(discordMessageId: string): Promise<BridgeMessage | null> {
  const { rows } = await query<MessageRow>(
    `UPDATE discord_bridge_message SET deleted_at = NOW(), content = '', attachments = '[]', embeds = '[]'
     WHERE discord_message_id = $1 AND deleted_at IS NULL RETURNING ${MESSAGE_COLS}`,
    [discordMessageId],
  )
  return rows[0] ? toMessage(rows[0]) : null
}

// Soft-delete a message by its bridge id (web-originated delete flow). Mirrors
// deleteByDiscordMessageId: stamps deleted_at and scrubs content/attachments/
// embeds so nothing lingers in history. Returns the deleted message (null when
// the id is unknown or already deleted) - the caller needs its direction +
// discordMessageId to decide whether to mirror the delete to Discord.
export async function deleteMessage(id: number): Promise<BridgeMessage | null> {
  const { rows } = await query<MessageRow>(
    `UPDATE discord_bridge_message SET deleted_at = NOW(), content = '', attachments = '[]', embeds = '[]'
     WHERE id = $1 AND deleted_at IS NULL RETURNING ${MESSAGE_COLS}`,
    [id],
  )
  return rows[0] ? toMessage(rows[0]) : null
}

export async function broadcastMessage(message: BridgeMessage): Promise<void> {
  await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.message', { message })
}

// --- Reactions -----------------------------------------------------------
// The bridge bot's own reaction is stored under the sentinel '__bridgebot' so
// it never counts as a real webhook/user reaction and is excluded from the
// client-facing count. Real reactors (webhooks, Discord users, other bots) use
// their own keys. The bot reacts at most once per emoji per message.
export const BRIDGE_BOT_KEY = '__bridgebot'

export interface ReactionAggregate {
  emoji: string
  count: number          // real reactors only (excludes the bot)
  botReacted: boolean    // whether the bridge bot currently reacts
}

// Record a reaction. Returns the aggregate for (message, emoji) after the write.
export async function addReaction(messageId: number, emoji: string, reactorKey: string): Promise<ReactionAggregate> {
  await query(
    `INSERT INTO discord_bridge_reaction (message_id, emoji, reactor_key)
     VALUES ($1, $2, $3) ON CONFLICT (message_id, emoji, reactor_key) DO NOTHING`,
    [messageId, emoji, reactorKey],
  )
  return reactionAggregate(messageId, emoji)
}

// Remove a reaction. Returns the aggregate after the write.
export async function removeReaction(messageId: number, emoji: string, reactorKey: string): Promise<ReactionAggregate> {
  await query(
    `DELETE FROM discord_bridge_reaction WHERE message_id = $1 AND emoji = $2 AND reactor_key = $3`,
    [messageId, emoji, reactorKey],
  )
  return reactionAggregate(messageId, emoji)
}

// The aggregate for one emoji on one message: real-reactor count + bot flag.
export async function reactionAggregate(messageId: number, emoji: string): Promise<ReactionAggregate> {
  const { rows } = await query<{ count: string; bot: boolean }>(
    `SELECT
       COUNT(*) FILTER (WHERE reactor_key <> $3) AS count,
       BOOL_OR(reactor_key = $3) AS bot
     FROM discord_bridge_reaction WHERE message_id = $1 AND emoji = $2`,
    [messageId, emoji, BRIDGE_BOT_KEY],
  )
  return { emoji, count: Number(rows[0]?.count || 0), botReacted: Boolean(rows[0]?.bot) }
}

// The caller's reaction state for a batch of messages (which emojis they
// reacted to), used to render the reacted highlight client-side.
export async function reactionsFor(messageId: number): Promise<BridgeReaction[]> {
  const { rows } = await query<{ emoji: string; reactor_key: string }>(
    `SELECT emoji, reactor_key FROM discord_bridge_reaction
     WHERE message_id = $1 AND reactor_key <> $2 ORDER BY id`,
    [messageId, BRIDGE_BOT_KEY],
  )
  const byEmoji = new Map<string, string[]>()
  for (const row of rows) {
    if (!byEmoji.has(row.emoji)) byEmoji.set(row.emoji, [])
    byEmoji.get(row.emoji)!.push(row.reactor_key)
  }
  return [...byEmoji.entries()].map(([emoji, reactorKeys]) => ({ emoji, count: reactorKeys.length, reactorKeys }))
}

// Ban scope (migration 029): a row's guild_id NULL = global, else that guild
// only. `guildId` = the guild the check runs in: global rows always match,
// plus that guild's own rows; null/undefined = guild-independent checks
// (avatar uploads), which only global bans cover. Pure.
export function banAppliesIn(rowGuildId: string | null, guildId: string | null | undefined): boolean {
  return rowGuildId === null || (Boolean(guildId) && rowGuildId === guildId)
}

export async function isBanned(subjectType: 'user' | 'discord' | 'ip' | 'ext', subject: string, guildId?: string | null): Promise<string | null> {
  const { rows } = await query<{ reason: string }>(
    `SELECT reason FROM discord_bridge_ban
     WHERE subject_type = $1 AND subject = $2 AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())
       AND (guild_id IS NULL OR guild_id = $3)
     ORDER BY id DESC LIMIT 1`,
    [subjectType, subject, guildId || ''],
  )
  return rows[0] ? rows[0].reason || 'Banned from the community chat.' : null
}

// `guildId` null = a global ban (every guild); a guild id scopes it to that
// guild's bridged channels.
export async function addBan(input: {
  subjectType: 'user' | 'discord' | 'ip' | 'ext'
  subject: string
  reason?: string
  createdBy?: string
  expiresAt?: Date | null
  guildId?: string | null
  // The guild the ban was issued in (moderation_event.guild_id); defaults
  // to the ban's own scope.
  issuedInGuildId?: string | null
}): Promise<void> {
  await query(
    `INSERT INTO discord_bridge_ban (subject_type, subject, reason, created_by, expires_at, guild_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.subjectType, input.subject, input.reason || '', input.createdBy || '', input.expiresAt ?? null, input.guildId ?? null],
  )
  await logModeration({
    actor: input.createdBy || '',
    action: 'ban',
    subject: `${input.subjectType}:${input.subject}`,
    reason: input.reason || '',
    meta: { guildId: input.guildId ?? null },
    guildId: input.issuedInGuildId !== undefined ? input.issuedInGuildId : (input.guildId ?? null),
  })
}

// Lift bans in a scope: `scope.guildId` = that guild's scoped rows;
// `scope.global` = also the global (NULL) rows. A guild moderator lifts only
// their guild's bans; site admins / home-guild staff lift global ones too.
export async function revokeBan(
  subjectType: 'user' | 'discord' | 'ip' | 'ext',
  subject: string,
  actor: string,
  // guildId = the guild the unban is issued in (its scoped rows + the log).
  scope: { guildId: string | null; global: boolean },
): Promise<number> {
  const { rowCount } = await query(
    `UPDATE discord_bridge_ban SET revoked_at = NOW()
     WHERE subject_type = $1 AND subject = $2 AND revoked_at IS NULL
       AND ((guild_id IS NULL AND $3::boolean) OR guild_id = $4)`,
    [subjectType, subject, scope.global, scope.guildId || ''],
  )
  if (rowCount) {
    await logModeration({ actor, action: 'unban', subject: `${subjectType}:${subject}`, meta: { guildId: scope.guildId, global: scope.global }, guildId: scope.guildId })
  }
  return rowCount ?? 0
}

// Active bans. `onlyGuildId` null = every row (the home guild's view);
// a guild id = ONLY that guild's scoped rows (partner guilds never see global
// bans - those can carry IP subjects and other guilds' reasons).
export async function listBans(limit = 50, onlyGuildId: string | null = null): Promise<Array<{ id: number; subjectType: string; subject: string; reason: string; createdBy: string; createdAt: string; expiresAt: string | null; guildId: string | null }>> {
  const { rows } = await query<{ id: string; subject_type: string; subject: string; reason: string; created_by: string; created_at: string; expires_at: string | null; guild_id: string | null }>(
    `SELECT id, subject_type, subject, reason, created_by, created_at, expires_at, guild_id
     FROM discord_bridge_ban WHERE revoked_at IS NULL
       AND ($2::text IS NULL OR guild_id = $2)
     ORDER BY id DESC LIMIT $1`,
    [limit, onlyGuildId],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    subjectType: r.subject_type,
    subject: r.subject,
    reason: r.reason,
    createdBy: r.created_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    guildId: r.guild_id ?? null,
  }))
}

// moderation_event.guild_id (migration 029) = the guild the action happened
// in. Writers pass `guildId`; when they don't, it's resolved from
// meta.channelId (the bridged channel's guild). NULL = no guild known
// (global actions), shown only in the home guild's modlog.
export async function logModeration(input: {
  actor: string
  action: string
  subject?: string
  reason?: string
  meta?: Record<string, unknown>
  guildId?: string | null
}): Promise<void> {
  const metaChannel = typeof input.meta?.channelId === 'string' ? input.meta.channelId : null
  await query(
    `INSERT INTO moderation_event (actor, action, subject, reason, meta, guild_id)
     VALUES ($1, $2, $3, $4, $5,
       COALESCE($6::text, (SELECT guild_id FROM discord_bridge_channel WHERE channel_id = $7::text)))`,
    [input.actor, input.action, input.subject || '', input.reason || '', JSON.stringify(input.meta || {}), input.guildId ?? null, metaChannel],
  ).catch(() => {})
}

// `onlyGuildId` null = every event (the home guild's view); a guild id =
// only that guild's events.
export async function listModerationEvents(limit = 25, onlyGuildId: string | null = null): Promise<Array<{ id: number; actor: string; action: string; subject: string; reason: string; createdAt: string }>> {
  const { rows } = await query<{ id: string; actor: string; action: string; subject: string; reason: string; created_at: string }>(
    `SELECT id, actor, action, subject, reason, created_at FROM moderation_event
     WHERE ($2::text IS NULL OR guild_id = $2)
     ORDER BY id DESC LIMIT $1`,
    [limit, onlyGuildId],
  )
  return rows.map((r) => ({ id: Number(r.id), actor: r.actor, action: r.action, subject: r.subject, reason: r.reason, createdAt: r.created_at }))
}

// --- Guild member/role directory -------------------------------------------
// A synced snapshot of the guild's members and roles, kept fresh by the
// discord service from gateway events. Powers @mention autocomplete and role
// mention resolution in the web chatbox without a Discord API round-trip per
// keystroke.

export interface GuildMember {
  guildId: string
  userId: string
  username: string
  displayName: string
  avatar: string | null
}

export interface GuildRole {
  guildId: string
  roleId: string
  name: string
  color: string | null
  position: number
  // Enhanced role colors (gradient / holographic); null = solid role color.
  colors?: RoleColorsJson | null
}

interface GuildMemberRow {
  guild_id: string
  user_id: string
  username: string
  display_name: string
  avatar: string | null
}

interface GuildRoleRow {
  guild_id: string
  role_id: string
  name: string
  color: string | null
  position: number
  colors?: RoleColorsJson | null
}

function toGuildMember(row: GuildMemberRow): GuildMember {
  return {
    guildId: row.guild_id,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    avatar: row.avatar,
  }
}

function toGuildRole(row: GuildRoleRow): GuildRole {
  return {
    guildId: row.guild_id,
    roleId: row.role_id,
    name: row.name,
    color: row.color,
    position: Number(row.position ?? 0),
    colors: row.colors ?? null,
  }
}

// Author cosmetics (019_discord_bridge_author_style): role ids, join date,
// member flags, bot flag and the user's cosmetic `style` JSON. Optional so
// callers that only know name/avatar keep the stored values (COALESCE); the
// style JSON is merged key-wise, so a gateway update that lacks
// displayNameStyles (discord.js drops it) never clears the raw-captured one.
export interface GuildMemberStyleInput {
  roleIds?: string[]
  joinedAt?: Date | string | null
  memberFlags?: number
  bot?: boolean
  style?: Record<string, unknown> | null
}

export async function upsertGuildMember(m: {
  guildId: string
  userId: string
  username: string
  displayName: string
  avatar?: string | null
} & GuildMemberStyleInput): Promise<void> {
  await query(
    `INSERT INTO discord_bridge_guild_member
       (guild_id, user_id, username, display_name, avatar, role_ids, joined_at, member_flags, bot, style)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 0), COALESCE($9, FALSE), $10::jsonb)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET
       username = EXCLUDED.username,
       display_name = EXCLUDED.display_name,
       avatar = EXCLUDED.avatar,
       role_ids = COALESCE($6, discord_bridge_guild_member.role_ids),
       joined_at = COALESCE($7, discord_bridge_guild_member.joined_at),
       member_flags = COALESCE($8, discord_bridge_guild_member.member_flags),
       bot = COALESCE($9, discord_bridge_guild_member.bot),
       style = CASE WHEN $10::jsonb IS NULL THEN discord_bridge_guild_member.style
                    ELSE COALESCE(discord_bridge_guild_member.style, '{}'::jsonb) || $10::jsonb END`,
    [
      m.guildId, m.userId, m.username, m.displayName, m.avatar ?? null,
      m.roleIds ?? null,
      m.joinedAt ? new Date(m.joinedAt) : null,
      typeof m.memberFlags === 'number' ? m.memberFlags : null,
      typeof m.bot === 'boolean' ? m.bot : null,
      m.style ? JSON.stringify(m.style) : null,
    ],
  )
}

// Merge raw-only cosmetic keys (e.g. display_name_styles, which discord.js
// doesn't parse) into an existing directory row's style JSON.
export async function mergeGuildMemberStyle(guildId: string, userId: string, style: Record<string, unknown>): Promise<void> {
  await query(
    `UPDATE discord_bridge_guild_member
     SET style = COALESCE(style, '{}'::jsonb) || $3::jsonb
     WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId, JSON.stringify(style)],
  )
}

export interface RoleColorsJson { primary: string | null; secondary: string | null; tertiary: string | null }

export async function removeGuildMember(guildId: string, userId: string): Promise<void> {
  await query(
    `DELETE FROM discord_bridge_guild_member WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId],
  )
}

export async function upsertGuildRole(r: {
  guildId: string
  roleId: string
  name: string
  color?: string | null
  position?: number
  colors?: RoleColorsJson | null
}): Promise<void> {
  await query(
    `INSERT INTO discord_bridge_guild_role (guild_id, role_id, name, color, position, colors)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (guild_id, role_id) DO UPDATE SET
       name = EXCLUDED.name,
       color = EXCLUDED.color,
       position = EXCLUDED.position,
       colors = EXCLUDED.colors`,
    [r.guildId, r.roleId, r.name, r.color ?? null, r.position ?? 0, r.colors ? JSON.stringify(r.colors) : null],
  )
}

// Replace the guild's role set in one transaction: upsert every given role and
// delete any stored role not in the list. Used by the discord service's full
// role sync so stale roles don't linger after deletions on Discord's side.
export async function syncGuildRoles(
  guildId: string,
  roles: Array<{ roleId: string; name: string; color?: string | null; position?: number; colors?: RoleColorsJson | null }>,
): Promise<void> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    for (const r of roles) {
      await client.query(
        `INSERT INTO discord_bridge_guild_role (guild_id, role_id, name, color, position, colors)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (guild_id, role_id) DO UPDATE SET
           name = EXCLUDED.name,
           color = EXCLUDED.color,
           position = EXCLUDED.position,
           colors = EXCLUDED.colors`,
        [guildId, r.roleId, r.name, r.color ?? null, r.position ?? 0, r.colors ? JSON.stringify(r.colors) : null],
      )
    }
    if (roles.length) {
      await client.query(
        `DELETE FROM discord_bridge_guild_role WHERE guild_id = $1 AND role_id <> ALL($2::text[])`,
        [guildId, roles.map((r) => r.roleId)],
      )
    } else {
      await client.query(`DELETE FROM discord_bridge_guild_role WHERE guild_id = $1`, [guildId])
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

// Case-insensitive prefix/substring match on display_name/username for mention
// autocomplete. Exact-prefix matches sort first, then substring matches, then
// alphabetically by display name.
export async function searchGuildMembers(guildId: string, search: string, limit = 10): Promise<GuildMember[]> {
  const capped = Math.min(Math.max(limit, 1), 50)
  const q = (search || '').trim().toLowerCase()
  if (!q) {
    const { rows } = await query<GuildMemberRow>(
      `SELECT guild_id, user_id, username, display_name, avatar
       FROM discord_bridge_guild_member WHERE guild_id = $1
       ORDER BY lower(display_name) ASC LIMIT $2`,
      [guildId, capped],
    )
    return rows.map(toGuildMember)
  }
  const { rows } = await query<GuildMemberRow>(
    `SELECT guild_id, user_id, username, display_name, avatar
     FROM discord_bridge_guild_member
     WHERE guild_id = $1
       AND (lower(display_name) LIKE '%' || $2 || '%' OR lower(username) LIKE '%' || $2 || '%')
     ORDER BY
       CASE
         WHEN lower(display_name) LIKE $2 || '%' OR lower(username) LIKE $2 || '%' THEN 0
         ELSE 1
       END,
       lower(display_name) ASC
     LIMIT $3`,
    [guildId, q, capped],
  )
  return rows.map(toGuildMember)
}

// Same search shape as searchGuildMembers, against role names.
export async function searchGuildRoles(guildId: string, search: string, limit = 10): Promise<GuildRole[]> {
  const capped = Math.min(Math.max(limit, 1), 50)
  const q = (search || '').trim().toLowerCase()
  if (!q) {
    const { rows } = await query<GuildRoleRow>(
      `SELECT guild_id, role_id, name, color, position, colors
       FROM discord_bridge_guild_role WHERE guild_id = $1
       ORDER BY position DESC, lower(name) ASC LIMIT $2`,
      [guildId, capped],
    )
    return rows.map(toGuildRole)
  }
  const { rows } = await query<GuildRoleRow>(
    `SELECT guild_id, role_id, name, color, position, colors
     FROM discord_bridge_guild_role
     WHERE guild_id = $1 AND lower(name) LIKE '%' || $2 || '%'
     ORDER BY
       CASE WHEN lower(name) LIKE $2 || '%' THEN 0 ELSE 1 END,
       position DESC,
       lower(name) ASC
     LIMIT $3`,
    [guildId, q, capped],
  )
  return rows.map(toGuildRole)
}

// Single lookups for resolving mention tokens (<@userId> / <@&roleId>) to
// display data when rendering a message.
export async function guildMemberFor(guildId: string, userId: string): Promise<GuildMember | null> {
  const { rows } = await query<GuildMemberRow>(
    `SELECT guild_id, user_id, username, display_name, avatar
     FROM discord_bridge_guild_member WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId],
  )
  return rows[0] ? toGuildMember(rows[0]) : null
}

export async function guildRoleFor(guildId: string, roleId: string): Promise<GuildRole | null> {
  const { rows } = await query<GuildRoleRow>(
    `SELECT guild_id, role_id, name, color, position, colors
     FROM discord_bridge_guild_role WHERE guild_id = $1 AND role_id = $2`,
    [guildId, roleId],
  )
  return rows[0] ? toGuildRole(rows[0]) : null
}

// Batch role lookup (profile popouts for webhook identities): the synced
// guild roles among `roleIds`, highest position first.
export async function guildRolesByIds(guildId: string, roleIds: string[]): Promise<GuildRole[]> {
  if (!roleIds.length) return []
  const { rows } = await query<GuildRoleRow>(
    `SELECT guild_id, role_id, name, color, position, colors
     FROM discord_bridge_guild_role WHERE guild_id = $1 AND role_id = ANY($2::text[])
     ORDER BY position DESC, role_id ASC`,
    [guildId, roleIds],
  )
  return rows.map(toGuildRole)
}

// === Message search (Discord's channel-header search) ===
//
// Every filter value is bound as a query parameter: the WHERE clause is built
// only from constant SQL fragments plus `$n` placeholders, never from user
// input. Content matching uses Postgres full-text search over the 'english'
// config (stemmed word match + stop words, like Discord's Elasticsearch
// analyzer and its client-side stem highlighter), backed by the
// 016_discord_bridge_message_search GIN index; input whose tsquery is empty
// (no indexable words, e.g. "???" or only stop words) falls back to an ILIKE
// substring match with LIKE wildcards escaped. The whole search runs in one transaction under a short
// statement_timeout so a pathological query can't pin a pool connection.

export type SearchHas = 'link' | 'embed' | 'file' | 'video' | 'image' | 'sound' | 'forward'
export type SearchSort = 'newest' | 'oldest' | 'relevance'
export type SearchAuthorType = 'user' | 'bot' | 'webhook'

// authorType: user / bot / webhook. Web-originated rows are webhook
// deliveries; Discord-originated rows carry author_bot (017).
const AUTHOR_TYPE_SQL: Record<SearchAuthorType, string> = {
  user: `(m.direction = 'discord' AND NOT m.author_bot)`,
  bot: `(m.direction = 'discord' AND m.author_bot)`,
  webhook: `m.direction = 'web'`,
}

export interface SearchFilters {
  channelIds: string[]          // already VIEW-filtered by the caller; never empty
  guildIds: string[]            // guilds of channelIds (member-directory scope for names)
  content: string               // free text ('' = none)
  authorIds: string[]           // Discord user ids (from:) - OR'd
  mentionIds: string[]          // Discord user ids (mentions:) - AND'd
  authorNames: string[]         // typed from: names (lowercased) - OR'd with authorIds
  mentionNames: string[]        // typed mentions: names (lowercased) - AND'd
  has: SearchHas[]              // AND'd
  notHas: SearchHas[]           // Discord's negated `has: -link` - AND NOT'd
  authorTypes: SearchAuthorType[]    // authorType: - OR'd
  notAuthorTypes: SearchAuthorType[] // authorType: -bot - AND NOT'd
  minTime: Date | null          // created_at >= minTime
  maxTime: Date | null          // created_at <  maxTime
  sort: SearchSort
  offset: number
  limit: number
}

export const SEARCH_STATEMENT_TIMEOUT_MS = 3000
// Count scan cap: the total is exact up to this many matches.
export const SEARCH_COUNT_CAP = 10_000

// Constant fragments per has: kind. jsonpath in lax mode tolerates a
// non-array/NULL column, so a malformed row just doesn't match.
const HAS_SQL: Record<SearchHas, string> = {
  link: `m.content ~* 'https?://[^\\s]'`,
  embed: `jsonb_path_exists(m.embeds, '$[*]')`,
  file: `jsonb_path_exists(m.attachments, '$[*]')`,
  image: `(jsonb_path_exists(m.attachments, '$[*] ? (@.contentType starts with "image/")')
           OR jsonb_path_exists(m.embeds, '$[*] ? (@.type == "image" || @.type == "gifv" || exists(@.image))'))`,
  video: `(jsonb_path_exists(m.attachments, '$[*] ? (@.contentType starts with "video/")')
           OR jsonb_path_exists(m.embeds, '$[*] ? (@.type == "video" || exists(@.video))'))`,
  sound: `jsonb_path_exists(m.attachments, '$[*] ? (@.contentType starts with "audio/")')`,
  forward: `m.forwarded IS NOT NULL`,
}

// --- Typed from:/mentions: names ---------------------------------------------
// A name the client couldn't resolve to an id (typed, not picked from the
// suggestions) is resolved here, Discord-style: case-insensitive EXACT
// username first (Discord username in the guild member directory); only when no username matches, exact
// display name (guild display name = nick/global name, a web identity's name in holt's identity directory, or
// a stored message author name in the searched channels - covers ex-members). Every match becomes ONE webhook
// identity: a web identity and the Discord account its trusted platform linked are searched together.

export const SEARCH_NAME_MATCH_CAP = 10 // identities per typed name

export interface SearchNameCandidate {
  discordId: string | null
  webKey: string | null
  usernames: string[]       // lowercased
  displayNames: string[]    // lowercased
}

/** Pure: the candidates a typed name selects (username tier, else display tier). */
export function pickNameMatches(name: string, candidates: SearchNameCandidate[]): SearchNameCandidate[] {
  const n = name.trim().toLowerCase()
  if (!n) return []
  const byUsername = candidates.filter((c) => c.usernames.includes(n))
  const tier = byUsername.length ? byUsername : candidates.filter((c) => c.displayNames.includes(n))
  return tier.slice(0, SEARCH_NAME_MATCH_CAP)
}

/** Pure: matched candidates (+ site↔Discord links) → author keys / Discord ids. */
export function expandSearchIdentities(
  matches: Array<Pick<SearchNameCandidate, 'discordId' | 'webKey'>>,
  links: Array<{ webKey: string; discordId: string }>,
): { authorKeys: string[]; discordIds: string[] } {
  const discordIds = new Set<string>()
  const webKeys = new Set<string>()
  for (const m of matches) {
    if (m.discordId) discordIds.add(m.discordId)
    if (m.webKey) webKeys.add(m.webKey)
  }
  for (const l of links) {
    if (discordIds.has(l.discordId)) webKeys.add(l.webKey)
    if (webKeys.has(l.webKey)) discordIds.add(l.discordId)
  }
  return {
    authorKeys: [...[...discordIds].map((id) => `discord:${id}`), ...webKeys],
    discordIds: [...discordIds],
  }
}

type Queryable = { query: <T extends Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[] }> }

async function searchNameCandidates(db: Queryable, names: string[], guildIds: string[], channelIds: string[]): Promise<SearchNameCandidate[]> {
  if (!names.length) return []
  const out: SearchNameCandidate[] = []
  const lower = (v: unknown) => (typeof v === 'string' && v ? [v.toLowerCase()] : [])
  if (guildIds.length) {
    const members = await db.query<{ user_id: string; username: string; display_name: string }>(
      `SELECT user_id, username, display_name FROM discord_bridge_guild_member
       WHERE guild_id = ANY($1::text[])
         AND (lower(username) = ANY($2::text[]) OR lower(display_name) = ANY($2::text[]))
       LIMIT 200`,
      [guildIds, names],
    )
    for (const r of members.rows) out.push({ discordId: r.user_id, webKey: null, usernames: lower(r.username), displayNames: lower(r.display_name) })
  }
  const identities = await db.query<{ key: string; name: string; discord_id: string | null }>(
    `SELECT key, name, discord_id FROM chat_identity WHERE lower(name) = ANY($1::text[]) LIMIT 200`,
    [names],
  )
  for (const r of identities.rows) out.push({ discordId: r.discord_id || null, webKey: r.key, usernames: [], displayNames: lower(r.name) })
  // Stored author names (display names) - only for names no username matched,
  // so the message scan is skipped in the common case.
  const unmatched = names.filter((n) => !out.some((c) => c.usernames.includes(n)))
  if (unmatched.length) {
    const authors = await db.query<{ author_key: string; author_name: string }>(
      `SELECT DISTINCT author_key, author_name FROM discord_bridge_message
       WHERE channel_id = ANY($1::text[]) AND deleted_at IS NULL AND lower(author_name) = ANY($2::text[])
       LIMIT 200`,
      [channelIds, unmatched],
    )
    for (const r of authors.rows) {
      const discord = /^discord:(\d{15,22})$/.exec(r.author_key)
      const web = discord ? null : webIdentityKey(r.author_key)
      if (!discord && !web) continue
      out.push({ discordId: discord ? discord[1] : null, webKey: web, usernames: [], displayNames: lower(r.author_name) })
    }
  }
  return out
}

async function searchIdentityLinks(db: Queryable, discordIds: string[], webKeys: string[]): Promise<Array<{ webKey: string; discordId: string }>> {
  if (!discordIds.length && !webKeys.length) return []
  const { rows } = await db.query<{ key: string; discord_id: string }>(
    `SELECT key, discord_id FROM chat_identity
     WHERE discord_id IS NOT NULL AND (discord_id = ANY($1::text[]) OR key = ANY($2::text[]))`,
    [discordIds, webKeys],
  )
  return rows.map((r) => ({ webKey: r.key, discordId: r.discord_id }))
}

/** from:/mentions: (ids + typed names) → author keys and per-mention Discord id groups.
 *  `null` = a requested filter resolved to nobody (Discord: no results). */
async function resolveSearchPeople(db: Queryable, f: SearchFilters): Promise<{ authorKeys: string[]; mentionGroups: string[][] } | null> {
  const names = [...new Set([...f.authorNames, ...f.mentionNames])]
  const candidates = await searchNameCandidates(db, names, f.guildIds, f.channelIds)
  const fromMatches = [
    ...f.authorIds.map((id) => ({ discordId: id, webKey: null })),
    ...f.authorNames.flatMap((n) => pickNameMatches(n, candidates)),
  ]
  const mentionMatches = f.mentionNames.map((n) => pickNameMatches(n, candidates))
  const all = [...fromMatches, ...mentionMatches.flat()]
  const links = await searchIdentityLinks(
    db,
    all.flatMap((m) => (m.discordId ? [m.discordId] : [])),
    all.flatMap((m) => (m.webKey ? [m.webKey] : [])),
  )
  const authorKeys = expandSearchIdentities(fromMatches, links).authorKeys
  if ((f.authorIds.length || f.authorNames.length) && !authorKeys.length) return null
  const mentionGroups = f.mentionIds.map((id) => [id])
  for (const matches of mentionMatches) {
    const ids = expandSearchIdentities(matches, links).discordIds
    if (!ids.length) return null
    mentionGroups.push(ids)
  }
  return { authorKeys, mentionGroups }
}

export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

export async function searchMessages(f: SearchFilters): Promise<{ total: number; messages: BridgeMessage[] }> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN READ ONLY')
    await client.query(`SET LOCAL statement_timeout = ${SEARCH_STATEMENT_TIMEOUT_MS}`)
    const result = await searchMessagesTx(client as unknown as Queryable, f)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function searchMessagesTx(client: Queryable, f: SearchFilters): Promise<{ total: number; messages: BridgeMessage[] }> {
  const people = await resolveSearchPeople(client, f)
  if (!people) return { total: 0, messages: [] }
  const params: unknown[] = []
  const bind = (value: unknown) => { params.push(value); return `$${params.length}` }
  const where: string[] = ['m.deleted_at IS NULL', `m.channel_id = ANY(${bind(f.channelIds)}::text[])`]

  const text = f.content.trim()
  // Does the text yield a non-empty english tsquery? (stop-word-only or
  // punctuation-only input doesn't - fall back to a substring match.)
  let fullText = false
  if (text !== '' && /[\p{L}\p{N}]/u.test(text)) {
    const probe = await client.query<{ n: number }>(`SELECT numnode(plainto_tsquery('english', $1)) AS n`, [text])
    fullText = Number(probe.rows[0]?.n || 0) > 0
  }
  let tsq = ''
  if (fullText) {
    tsq = `plainto_tsquery('english', ${bind(text)})`
    where.push(`to_tsvector('english', m.content) @@ ${tsq}`)
  } else if (text) {
    where.push(`m.content ILIKE ${bind(`%${escapeLike(text)}%`)} ESCAPE '\\'`)
  }
  if (people.authorKeys.length) {
    where.push(`m.author_key = ANY(${bind(people.authorKeys)}::text[])`)
  }
  // One group per mentions: value (AND'd); a typed name may resolve to
  // several Discord ids (OR'd within its group).
  for (const ids of people.mentionGroups) {
    where.push(`(${ids.map((id) => `m.mentions @> ${bind(JSON.stringify([{ type: 'user', id }]))}::jsonb`).join(' OR ')})`)
  }
  for (const kind of f.has) where.push(HAS_SQL[kind])
  for (const kind of f.notHas) where.push(`NOT ${HAS_SQL[kind]}`)
  if (f.authorTypes.length) where.push(`(${f.authorTypes.map((t) => AUTHOR_TYPE_SQL[t]).join(' OR ')})`)
  for (const t of f.notAuthorTypes) where.push(`NOT ${AUTHOR_TYPE_SQL[t]}`)
  if (f.minTime) where.push(`m.created_at >= ${bind(f.minTime.toISOString())}::timestamptz`)
  if (f.maxTime) where.push(`m.created_at < ${bind(f.maxTime.toISOString())}::timestamptz`)

  const whereSql = where.join(' AND ')
  const order = f.sort === 'oldest'
    ? 'm.id ASC'
    : f.sort === 'relevance' && fullText
      ? `ts_rank(to_tsvector('english', m.content), ${tsq}) DESC, m.id DESC`
      : 'm.id DESC'
  const countParams = [...params]
  const limitPh = bind(Math.min(Math.max(f.limit, 1), 25))
  const offsetPh = bind(Math.max(f.offset, 0))
  const cols = MESSAGE_COLS.split(',').map((c) => `m.${c.trim()}`).join(', ')

  const countRes = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM (
       SELECT 1 FROM discord_bridge_message m WHERE ${whereSql} LIMIT ${SEARCH_COUNT_CAP}
     ) t`,
    countParams,
  )
  const rowsRes = await client.query<MessageRow & Record<string, unknown>>(
    `SELECT ${cols} FROM discord_bridge_message m
     WHERE ${whereSql}
     ORDER BY ${order}
     LIMIT ${limitPh} OFFSET ${offsetPh}`,
    params,
  )
  return { total: Number(countRes.rows[0]?.n || 0), messages: rowsRes.rows.map(toMessage) }
}

// === Forum posts (migration 038) =============================================
//
// One discord_bridge_post row per post (a Discord thread in a bridged forum).
// Messages in a post are ordinary discord_bridge_message rows keyed by the
// post id (the thread id), so history, search, reactions and edits work
// unchanged; every GATE (perms, overwrites, timeouts, bans, guild) resolves
// the post to its forum first (scopeFor). A web-created post exists before
// Discord has a thread for it: its id is `post:<pk>` and its starter row has
// channel_id = 'post:<pk>' until deliverPendingPost re-keys both.

export type PostListSort = 'activity' | 'created'

export interface BridgePost {
  pk: number
  // The post id clients use: the thread id, or 'post:<pk>' while pending.
  id: string
  threadId: string | null
  forumId: string
  guildId: string
  name: string
  ownerKey: string
  ownerName: string
  ownerAvatar: string | null
  ownerColor: string | null
  appliedTags: string[]
  flags: number
  pinned: boolean
  archived: boolean
  locked: boolean
  // A web post not yet on Discord.
  pending: boolean
  direction: 'discord' | 'web'
  starterMessageId: number | null
  lastActivityAt: string
  createdAt: string
  deletedAt: string | null
  deliveryError: number | null
  // The sort keys as Postgres text (microsecond precision) for cursors.
  activityKey: string
  createdKey: string
}

// The contract's ForumPost (holt docs/forum/contract.md).
export interface ForumPostView {
  id: string
  forumId: string
  guildId: string
  name: string
  ownerKey: string
  ownerName: string
  ownerAvatar: string | null
  ownerColor: string | null
  appliedTags: string[]
  pinned: boolean
  archived: boolean
  locked: boolean
  pending: boolean
  messageCount: number
  lastMessageId: number | null
  lastActivityAt: string
  createdAt: string
  starter: {
    messageId: number | null
    content: string
    image: string | null
    reactions: Array<{ emoji: string; count: number }>
  }
}

interface PostRow {
  id: string
  thread_id: string | null
  channel_id: string
  guild_id: string
  name: string
  owner_key: string
  owner_name: string
  owner_avatar: string | null
  owner_color: string | null
  applied_tags: string[] | null
  flags: number
  archived: boolean
  locked: boolean
  direction: 'discord' | 'web'
  starter_message_id: string | null
  last_activity_at: Date | string
  created_at: Date | string
  deleted_at: Date | string | null
  delivery_error: number | null
  activity_key: string
  created_key: string
}

function postCols(alias = ''): string {
  const a = alias ? `${alias}.` : ''
  return [
    'id', 'thread_id', 'channel_id', 'guild_id', 'name', 'owner_key', 'owner_name', 'owner_avatar', 'owner_color',
    'applied_tags', 'flags', 'archived', 'locked', 'direction', 'starter_message_id', 'last_activity_at', 'created_at',
    'deleted_at', 'delivery_error',
  ].map((c) => `${a}${c}`).join(', ') + `, ${a}last_activity_at::text AS activity_key, ${a}created_at::text AS created_key`
}

function isoOf(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

const PENDING_POST_RE = /^post:(\d{1,15})$/

// 'post:<pk>' for a pending web post. Pure.
export function pendingPostId(pk: number): string {
  return `post:${pk}`
}

// The pk in a pending post id, or null for anything else. Pure.
export function parsePendingPostId(id: unknown): number | null {
  if (typeof id !== 'string') return null
  const m = PENDING_POST_RE.exec(id)
  if (!m) return null
  const n = Number(m[1])
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function toPost(row: PostRow): BridgePost {
  const pk = Number(row.id)
  const flags = Number(row.flags) || 0
  return {
    pk,
    id: row.thread_id || pendingPostId(pk),
    threadId: row.thread_id,
    forumId: row.channel_id,
    guildId: row.guild_id,
    name: row.name,
    ownerKey: row.owner_key,
    ownerName: row.owner_name || '',
    ownerAvatar: row.owner_avatar,
    ownerColor: row.owner_color,
    appliedTags: Array.isArray(row.applied_tags) ? row.applied_tags : [],
    flags,
    pinned: (flags & CHANNEL_FLAG_PINNED) !== 0,
    archived: row.archived === true,
    locked: row.locked === true,
    pending: !row.thread_id,
    direction: row.direction,
    starterMessageId: row.starter_message_id === null ? null : Number(row.starter_message_id),
    lastActivityAt: isoOf(row.last_activity_at) || '',
    createdAt: isoOf(row.created_at) || '',
    deletedAt: isoOf(row.deleted_at),
    deliveryError: row.delivery_error ?? null,
    activityKey: row.activity_key,
    createdKey: row.created_key,
  }
}

export async function postByPk(pk: number): Promise<BridgePost | null> {
  const { rows } = await query<PostRow>(`SELECT ${postCols()} FROM discord_bridge_post WHERE id = $1`, [pk])
  return rows[0] ? toPost(rows[0]) : null
}

export async function postByThreadId(threadId: string): Promise<BridgePost | null> {
  const { rows } = await query<PostRow>(`SELECT ${postCols()} FROM discord_bridge_post WHERE thread_id = $1`, [threadId])
  return rows[0] ? toPost(rows[0]) : null
}

// A post by either id form (thread id or 'post:<pk>').
export async function postFor(id: string): Promise<BridgePost | null> {
  const pk = parsePendingPostId(id)
  if (pk !== null) return postByPk(pk)
  return /^\d{15,22}$/.test(id) ? postByThreadId(id) : null
}

// What a channel-scoped request acts on. `channel` is the row every gate runs
// on: the channel itself, or the post's FORUM (threads have no overwrites of
// their own and inherit the forum's permissions, timeouts and bans). `id` is
// the message scope: the channel id or the post id (a delivered pending post
// resolves to its thread id).
export interface BridgeScope {
  id: string
  channel: BridgeChannel
  post: BridgePost | null
}

export async function scopeFor(id: string): Promise<BridgeScope | null> {
  if (!id || id.length > 40) return null
  const pk = parsePendingPostId(id)
  if (pk === null) {
    const channel = await channelFor(id)
    if (channel) return { id, channel, post: null }
  }
  const post = pk !== null ? await postByPk(pk) : await postFor(id)
  if (!post || post.deletedAt) return null
  const channel = await channelFor(post.forumId)
  if (!channel || !isForumType(channel.type)) return null
  return { id: post.id, channel, post }
}

// A thread as the bot (discord.js) or the API (raw Discord JSON) sees it.
export interface PostThreadFields {
  threadId: string
  forumId: string
  guildId: string
  name: string
  ownerId: string | null
  appliedTags: string[]
  flags: number
  archived: boolean
  locked: boolean
  autoArchiveDuration: number | null
  archiveTimestamp: string | null
  rateLimitPerUser: number
  messageCount: number
  totalMessageSent: number
  lastMessageId: string | null
  // thread_metadata.create_timestamp, else the snowflake time.
  createdAt: string
}

const DISCORD_EPOCH = 1420070400000n

// A snowflake's creation time as ISO (null when malformed). Pure.
export function snowflakeTime(id: string | null | undefined): string | null {
  if (!id || !/^\d{1,22}$/.test(id)) return null
  try {
    return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH)).toISOString()
  } catch {
    return null
  }
}

// Raw Discord thread JSON (GET/PATCH /channels/{thread}) → post fields; null
// when it isn't a thread in a channel. Pure.
export function postFieldsFromRawThread(raw: unknown, guildIdFallback = ''): PostThreadFields | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>
  if (typeof t.id !== 'string' || typeof t.parent_id !== 'string' || ![10, 11, 12].includes(Number(t.type))) return null
  const meta = (t.thread_metadata && typeof t.thread_metadata === 'object' ? t.thread_metadata : {}) as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const created = typeof meta.create_timestamp === 'string' ? isoOf(meta.create_timestamp) : null
  return {
    threadId: t.id,
    forumId: t.parent_id,
    guildId: typeof t.guild_id === 'string' ? t.guild_id : guildIdFallback,
    name: typeof t.name === 'string' ? t.name : '',
    ownerId: typeof t.owner_id === 'string' ? t.owner_id : null,
    appliedTags: Array.isArray(t.applied_tags) ? t.applied_tags.filter((x): x is string => typeof x === 'string') : [],
    flags: num(t.flags),
    archived: meta.archived === true,
    locked: meta.locked === true,
    autoArchiveDuration: typeof meta.auto_archive_duration === 'number' ? meta.auto_archive_duration : null,
    archiveTimestamp: typeof meta.archive_timestamp === 'string' ? isoOf(meta.archive_timestamp) : null,
    rateLimitPerUser: num(t.rate_limit_per_user),
    messageCount: num(t.message_count),
    totalMessageSent: num(t.total_message_sent),
    lastMessageId: typeof t.last_message_id === 'string' ? t.last_message_id : null,
    createdAt: created || snowflakeTime(t.id) || new Date().toISOString(),
  }
}

// Did anything a client renders change between two states of a post? Pure.
export function postStateChanged(prev: Pick<BridgePost, 'name' | 'appliedTags' | 'flags' | 'archived' | 'locked' | 'deletedAt' | 'forumId'> | null, next: Pick<BridgePost, 'name' | 'appliedTags' | 'flags' | 'archived' | 'locked' | 'deletedAt' | 'forumId'>): boolean {
  if (!prev) return true
  return prev.name !== next.name
    || prev.flags !== next.flags
    || prev.archived !== next.archived
    || prev.locked !== next.locked
    || Boolean(prev.deletedAt) !== Boolean(next.deletedAt)
    || prev.forumId !== next.forumId
    || prev.appliedTags.join(',') !== next.appliedTags.join(',')
}

// Upsert a Discord thread as a post (bot gateway/reconcile, API post-moderate
// echo). A web post keeps its owner and direction; owner display fields are
// only filled when empty. Returns the post, whether it was new, and whether
// anything a client renders changed.
export async function upsertDiscordPost(
  f: PostThreadFields,
  owner: { name?: string | null; avatar?: string | null; color?: string | null } = {},
): Promise<{ post: BridgePost; created: boolean; changed: boolean }> {
  const prev = await postByThreadId(f.threadId)
  const lastAt = snowflakeTime(f.lastMessageId)
  const { rows } = await query<PostRow>(
    `INSERT INTO discord_bridge_post (thread_id, channel_id, guild_id, name, owner_key, owner_name, owner_avatar, owner_color,
       applied_tags, flags, archived, locked, auto_archive_duration, archive_timestamp, rate_limit_per_user, message_count,
       total_message_sent, last_message_id, created_at, last_activity_at, direction)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12, $13, $14::timestamptz, $15, $16, $17, $18,
       $19::timestamptz, GREATEST($19::timestamptz, COALESCE($20::timestamptz, $19::timestamptz)), 'discord')
     ON CONFLICT (thread_id) DO UPDATE SET
       channel_id = EXCLUDED.channel_id,
       guild_id = EXCLUDED.guild_id,
       name = EXCLUDED.name,
       owner_name = CASE WHEN discord_bridge_post.owner_name = '' THEN EXCLUDED.owner_name ELSE discord_bridge_post.owner_name END,
       owner_avatar = COALESCE(discord_bridge_post.owner_avatar, EXCLUDED.owner_avatar),
       owner_color = COALESCE(discord_bridge_post.owner_color, EXCLUDED.owner_color),
       applied_tags = EXCLUDED.applied_tags,
       flags = EXCLUDED.flags,
       archived = EXCLUDED.archived,
       locked = EXCLUDED.locked,
       auto_archive_duration = EXCLUDED.auto_archive_duration,
       archive_timestamp = EXCLUDED.archive_timestamp,
       rate_limit_per_user = EXCLUDED.rate_limit_per_user,
       message_count = EXCLUDED.message_count,
       total_message_sent = EXCLUDED.total_message_sent,
       last_message_id = COALESCE(EXCLUDED.last_message_id, discord_bridge_post.last_message_id),
       last_activity_at = GREATEST(discord_bridge_post.last_activity_at, COALESCE($20::timestamptz, discord_bridge_post.last_activity_at)),
       deleted_at = NULL
     RETURNING ${postCols()}`,
    [
      f.threadId, f.forumId, f.guildId, f.name.slice(0, 100), f.ownerId ? `discord:${f.ownerId}` : 'discord:0',
      owner.name || '', owner.avatar ?? null, owner.color ?? null,
      f.appliedTags.slice(0, 5), f.flags | 0, f.archived, f.locked, f.autoArchiveDuration, f.archiveTimestamp,
      f.rateLimitPerUser | 0, f.messageCount | 0, f.totalMessageSent | 0, f.lastMessageId, f.createdAt, lastAt,
    ],
  )
  const post = toPost(rows[0])
  return { post, created: !prev, changed: postStateChanged(prev, post) }
}

// A new message landed in a post: bump "Recently Active" and remember the
// starter row. `postId` is a thread id or 'post:<pk>'.
export async function touchPost(postId: string, at: Date | string, starterMessageId: number | null = null): Promise<boolean> {
  const pk = parsePendingPostId(postId)
  const { rowCount } = await query(
    `UPDATE discord_bridge_post
        SET last_activity_at = GREATEST(last_activity_at, $2::timestamptz),
            starter_message_id = COALESCE(starter_message_id, $3::bigint)
      WHERE ${pk !== null ? 'id = $1::bigint' : 'thread_id = $1'} AND deleted_at IS NULL`,
    [pk !== null ? pk : postId, at instanceof Date ? at.toISOString() : at, starterMessageId],
  )
  return Boolean(rowCount)
}

// Create a web post and its pending starter row in one transaction.
// Idempotent on (owner key, clientId): a retry returns the first post.
export async function createWebPost(input: {
  forumId: string
  guildId: string
  name: string
  appliedTags: string[]
  ownerKey: string
  ownerName: string
  ownerAvatar: string | null
  ownerColor: string | null
  authorRole: string | null
  content: string
  mentions: unknown[]
  clientId: string | null
}): Promise<{ post: BridgePost; message: BridgeMessage; existed: boolean }> {
  const client = await getPool().connect()
  const existing = async (): Promise<{ post: BridgePost; message: BridgeMessage; existed: boolean } | null> => {
    if (!input.clientId) return null
    const { rows } = await client.query<PostRow>(
      `SELECT ${postCols()} FROM discord_bridge_post WHERE owner_key = $1 AND client_id = $2`,
      [input.ownerKey, input.clientId],
    )
    if (!rows[0]) return null
    const post = toPost(rows[0])
    const message = post.starterMessageId !== null ? await messageFor(post.starterMessageId) : null
    return message ? { post, message, existed: true } : null
  }
  try {
    const dup = await existing()
    if (dup) return dup
    await client.query('BEGIN')
    const inserted = await client.query<PostRow>(
      `INSERT INTO discord_bridge_post (channel_id, guild_id, name, owner_key, owner_name, owner_avatar, owner_color,
         applied_tags, direction, client_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], 'web', $9)
       ON CONFLICT (owner_key, client_id) WHERE client_id IS NOT NULL DO NOTHING
       RETURNING ${postCols()}`,
      [input.forumId, input.guildId, input.name, input.ownerKey, input.ownerName, input.ownerAvatar, input.ownerColor,
        input.appliedTags, input.clientId],
    )
    if (!inserted.rows[0]) {
      await client.query('ROLLBACK')
      const raced = await existing()
      if (raced) return raced
      throw new Error('web post insert conflicted without an existing row')
    }
    const pk = Number(inserted.rows[0].id)
    const msg = await client.query<MessageRow>(
      `INSERT INTO discord_bridge_message
         (channel_id, direction, author_key, author_name, author_avatar, author_color, author_role, content, mentions)
       VALUES ($1, 'web', $2, $3, $4, $5, $6, $7, $8::jsonb)
       RETURNING ${MESSAGE_COLS}`,
      [pendingPostId(pk), input.ownerKey, input.ownerName, input.ownerAvatar, input.ownerColor, input.authorRole,
        input.content, JSON.stringify(input.mentions || [])],
    )
    const updated = await client.query<PostRow>(
      `UPDATE discord_bridge_post SET starter_message_id = $2 WHERE id = $1 RETURNING ${postCols()}`,
      [pk, msg.rows[0].id],
    )
    await client.query('COMMIT')
    return { post: toPost(updated.rows[0]), message: toMessage(msg.rows[0]), existed: false }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

// The webhook created the thread for pending post `pk`: in one transaction,
// give the post its thread id, re-key its rows from 'post:<pk>' to the thread
// and attach the starter's Discord id (= the thread id). A row the gateway
// raced in for the same thread / starter is dropped first. Returns the post.
export async function deliverPendingPost(pk: number, threadId: string, starterRowId: number, starterDiscordId: string): Promise<BridgePost | null> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`DELETE FROM discord_bridge_post WHERE thread_id = $1 AND id <> $2 AND direction = 'discord'`, [threadId, pk])
    await client.query(
      `DELETE FROM discord_bridge_message WHERE discord_message_id = $1 AND id <> $2 AND direction = 'discord'`,
      [starterDiscordId, starterRowId],
    )
    const { rows } = await client.query<PostRow>(
      `UPDATE discord_bridge_post SET thread_id = $2 WHERE id = $1 AND thread_id IS NULL RETURNING ${postCols()}`,
      [pk, threadId],
    )
    await client.query(`UPDATE discord_bridge_message SET channel_id = $2 WHERE channel_id = $1`, [pendingPostId(pk), threadId])
    await client.query(
      `UPDATE discord_bridge_message SET discord_message_id = $2 WHERE id = $1 AND discord_message_id IS NULL`,
      [starterRowId, starterDiscordId],
    )
    await client.query('COMMIT')
    return rows[0] ? toPost(rows[0]) : postByPk(pk)
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

// Drop a pending web post (its delivery failed for good, `code` = Discord's
// error code, or its author deleted the starter). Returns the post or null.
export async function dropPendingPost(pk: number, code: number | null): Promise<BridgePost | null> {
  const { rows } = await query<PostRow>(
    `UPDATE discord_bridge_post SET deleted_at = NOW(), delivery_error = $2
      WHERE id = $1 AND thread_id IS NULL AND deleted_at IS NULL RETURNING ${postCols()}`,
    [pk, code],
  )
  if (!rows[0]) return null
  await query(
    `UPDATE discord_bridge_message SET deleted_at = NOW() WHERE channel_id = $1 AND deleted_at IS NULL`,
    [pendingPostId(pk)],
  )
  return toPost(rows[0])
}

// The thread is gone (THREAD_DELETE, a staff delete, a reconcile pass that no
// longer finds it): tombstone the post and every message in it (Discord sends
// no per-message deletes). Returns the post, or null when already gone.
export async function deletePostByThread(threadId: string): Promise<BridgePost | null> {
  const { rows } = await query<PostRow>(
    `UPDATE discord_bridge_post SET deleted_at = NOW() WHERE thread_id = $1 AND deleted_at IS NULL RETURNING ${postCols()}`,
    [threadId],
  )
  if (!rows[0]) return null
  await query(
    `UPDATE discord_bridge_message SET deleted_at = NOW(), content = '', attachments = '[]', embeds = '[]'
      WHERE channel_id = $1 AND deleted_at IS NULL`,
    [threadId],
  )
  return toPost(rows[0])
}

// Live thread ids of one forum (reconcile: posts Discord no longer lists).
export async function forumThreadIds(forumId: string): Promise<string[]> {
  const { rows } = await query<{ thread_id: string }>(
    `SELECT thread_id FROM discord_bridge_post WHERE channel_id = $1 AND thread_id IS NOT NULL AND deleted_at IS NULL`,
    [forumId],
  )
  return rows.map((r) => r.thread_id)
}

// Live thread id → forum id for every bridged forum's posts (the bot's
// thread map at startup).
export async function liveThreadForums(): Promise<Map<string, string>> {
  const { rows } = await query<{ thread_id: string; channel_id: string }>(
    `SELECT p.thread_id, p.channel_id FROM discord_bridge_post p
       JOIN discord_bridge_channel c ON c.channel_id = p.channel_id AND c.enabled = TRUE
      WHERE p.thread_id IS NOT NULL AND p.deleted_at IS NULL`,
  )
  return new Map(rows.map((r) => [r.thread_id, r.channel_id]))
}

// Every live post of the given forums (search: a forum's messages live in its
// posts). Ids are thread ids or 'post:<pk>'.
export async function postsOfForums(forumIds: string[]): Promise<Array<{ id: string; forumId: string; name: string }>> {
  if (!forumIds.length) return []
  const { rows } = await query<{ id: string; thread_id: string | null; channel_id: string; name: string }>(
    `SELECT id, thread_id, channel_id, name FROM discord_bridge_post
      WHERE channel_id = ANY($1::text[]) AND deleted_at IS NULL
      ORDER BY last_activity_at DESC LIMIT 5000`,
    [forumIds],
  )
  return rows.map((r) => ({ id: r.thread_id || pendingPostId(Number(r.id)), forumId: r.channel_id, name: r.name }))
}

// The first image a card can show: an image attachment, else an embed's
// image / thumbnail / video thumbnail. Pure.
export function starterImage(attachments: unknown, embeds: unknown): string | null {
  const str = (v: unknown) => (typeof v === 'string' && /^https?:\/\//.test(v) ? v : null)
  if (Array.isArray(attachments)) {
    for (const a of attachments) {
      if (!a || typeof a !== 'object') continue
      const o = a as Record<string, unknown>
      const type = typeof o.contentType === 'string' ? o.contentType : typeof o.content_type === 'string' ? o.content_type : ''
      if (type.startsWith('image/')) {
        const url = str(o.proxyUrl) || str(o.url)
        if (url) return url
      }
    }
  }
  if (Array.isArray(embeds)) {
    for (const e of embeds) {
      if (!e || typeof e !== 'object') continue
      const o = e as Record<string, Record<string, unknown> | undefined>
      for (const key of ['image', 'thumbnail'] as const) {
        const media = o[key]
        const url = media ? str(media.proxy_url) || str(media.url) : null
        if (url) return url
      }
    }
  }
  return null
}

// Contract views for a batch of posts (starter preview, reply count and the
// newest message id from holt's own rows, the starter's reactions), in input
// order.
export async function forumPostViews(posts: BridgePost[]): Promise<ForumPostView[]> {
  if (!posts.length) return []
  const { rows } = await query<{
    id: string
    s_id: string | null
    s_content: string | null
    s_attachments: unknown
    s_embeds: unknown
    s_author: string | null
    replies: string | null
    last_id: string | null
  }>(
    `SELECT p.id, s.id AS s_id, s.content AS s_content, s.attachments AS s_attachments, s.embeds AS s_embeds,
            s.author_name AS s_author, st.replies::text AS replies, st.last_id
       FROM discord_bridge_post p
       LEFT JOIN LATERAL (
         SELECT m.id, m.content, m.attachments, m.embeds, m.author_name FROM discord_bridge_message m
          WHERE m.id = p.starter_message_id OR (p.thread_id IS NOT NULL AND m.discord_message_id = p.thread_id)
          ORDER BY m.id LIMIT 1
       ) s ON TRUE
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE s.id IS NULL OR m.id <> s.id) AS replies, max(m.id) AS last_id
           FROM discord_bridge_message m
          WHERE m.channel_id = COALESCE(p.thread_id, 'post:' || p.id) AND m.deleted_at IS NULL
       ) st ON TRUE
      WHERE p.id = ANY($1::bigint[])`,
    [posts.map((p) => p.pk)],
  )
  const byPk = new Map(rows.map((r) => [Number(r.id), r]))
  const starterIds = rows.map((r) => (r.s_id === null ? null : Number(r.s_id))).filter((id): id is number => id !== null)
  const reactions = new Map<number, Array<{ emoji: string; count: number }>>()
  if (starterIds.length) {
    const { rows: rx } = await query<{ message_id: string; emoji: string; n: string }>(
      `SELECT message_id, emoji, count(*)::text AS n FROM discord_bridge_reaction
        WHERE message_id = ANY($1::bigint[]) AND reactor_key <> $2
        GROUP BY message_id, emoji ORDER BY count(*) DESC, min(id) ASC`,
      [starterIds, BRIDGE_BOT_KEY],
    )
    for (const r of rx) {
      const list = reactions.get(Number(r.message_id)) || []
      list.push({ emoji: r.emoji, count: Number(r.n) })
      reactions.set(Number(r.message_id), list)
    }
  }
  return posts.map((post) => {
    const r = byPk.get(post.pk)
    const starterId = r?.s_id ? Number(r.s_id) : null
    return {
      id: post.id,
      forumId: post.forumId,
      guildId: post.guildId,
      name: post.name,
      ownerKey: post.ownerKey,
      // An owner who left the guild has no directory entry; their starter message still carries the name.
      ownerName: post.ownerName || r?.s_author || '',
      ownerAvatar: post.ownerAvatar,
      ownerColor: post.ownerColor,
      appliedTags: post.appliedTags,
      pinned: post.pinned,
      archived: post.archived,
      locked: post.locked,
      pending: post.pending,
      messageCount: Number(r?.replies || 0),
      lastMessageId: r?.last_id ? Number(r.last_id) : null,
      lastActivityAt: post.lastActivityAt,
      createdAt: post.createdAt,
      starter: {
        messageId: starterId,
        content: (r?.s_content || '').slice(0, 300),
        image: r ? starterImage(r.s_attachments, r.s_embeds) : null,
        reactions: starterId !== null ? reactions.get(starterId) || [] : [],
      },
    }
  })
}

export async function forumPostView(post: BridgePost): Promise<ForumPostView> {
  return (await forumPostViews([post]))[0]
}

// --- Post list cursors ---------------------------------------------------------
// An opaque base64url JSON {s: sort, k: the sort key (Postgres timestamptz
// text), i: post pk}. A cursor for the other sort is rejected (null).

const PG_TS_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2}){0,2}|Z)?$/

export function encodePostCursor(sort: PostListSort, key: string, pk: number): string {
  return Buffer.from(JSON.stringify({ s: sort, k: key, i: pk })).toString('base64url')
}

export function decodePostCursor(raw: string | null | undefined, sort: PostListSort): { key: string; pk: number } | null {
  if (!raw || raw.length > 200 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null
  try {
    const o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { s?: unknown; k?: unknown; i?: unknown }
    if (o.s !== sort || typeof o.k !== 'string' || !PG_TS_RE.test(o.k)) return null
    const pk = Number(o.i)
    if (!Number.isSafeInteger(pk) || pk <= 0) return null
    return { key: o.k, pk }
  } catch {
    return null
  }
}

// One page of a forum's posts (GET posts). Pinned posts come first on the
// first page only and are never repeated on later pages; `total` counts every
// match, pinned included. Every filter value is a bound parameter.
export async function listPosts(opts: {
  forumId: string
  sort: PostListSort
  tags: string[]
  match: 'some' | 'all'
  q: string
  cursor: { key: string; pk: number } | null
  limit: number
}): Promise<{ posts: ForumPostView[]; nextCursor: string | null; total: number }> {
  const params: unknown[] = []
  const bind = (value: unknown) => { params.push(value); return `$${params.length}` }
  const where = ['p.deleted_at IS NULL', `p.channel_id = ${bind(opts.forumId)}`]
  if (opts.tags.length) {
    where.push(opts.match === 'all' ? `p.applied_tags @> ${bind(opts.tags)}::text[]` : `p.applied_tags && ${bind(opts.tags)}::text[]`)
  }
  const q = opts.q.trim()
  if (q) {
    const like = bind(`%${escapeLike(q)}%`)
    where.push(`(p.name ILIKE ${like} ESCAPE '\\' OR EXISTS (
      SELECT 1 FROM discord_bridge_message m
       WHERE (m.id = p.starter_message_id OR (p.thread_id IS NOT NULL AND m.discord_message_id = p.thread_id))
         AND m.deleted_at IS NULL AND m.content ILIKE ${like} ESCAPE '\\'))`)
  }
  const baseWhere = where.join(' AND ')
  const baseParams = [...params]
  const sortCol = opts.sort === 'created' ? 'p.created_at' : 'p.last_activity_at'
  const limit = Math.min(Math.max(Math.trunc(opts.limit) || 25, 1), 50)

  const total = await query<{ n: string }>(`SELECT count(*)::text AS n FROM discord_bridge_post p WHERE ${baseWhere}`, baseParams)
  const pinned = opts.cursor
    ? []
    : (await query<PostRow>(
      `SELECT ${postCols('p')} FROM discord_bridge_post p
        WHERE ${baseWhere} AND (p.flags & ${CHANNEL_FLAG_PINNED}) <> 0
        ORDER BY ${sortCol} DESC, p.id DESC LIMIT 10`,
      baseParams,
    )).rows
  const pageWhere = [baseWhere, `(p.flags & ${CHANNEL_FLAG_PINNED}) = 0`]
  if (opts.cursor) pageWhere.push(`(${sortCol}, p.id) < (${bind(opts.cursor.key)}::timestamptz, ${bind(opts.cursor.pk)}::bigint)`)
  const limitPh = bind(limit + 1)
  const page = await query<PostRow>(
    `SELECT ${postCols('p')} FROM discord_bridge_post p
      WHERE ${pageWhere.join(' AND ')}
      ORDER BY ${sortCol} DESC, p.id DESC LIMIT ${limitPh}`,
    params,
  )
  const pageRows = page.rows.slice(0, limit).map(toPost)
  const last = pageRows[pageRows.length - 1]
  const nextCursor = page.rows.length > limit && last
    ? encodePostCursor(opts.sort, opts.sort === 'created' ? last.createdKey : last.activityKey, last.pk)
    : null
  return {
    posts: await forumPostViews([...pinned.map(toPost), ...pageRows]),
    nextCursor,
    total: Number(total.rows[0]?.n || 0),
  }
}

// A post event for the realtime bus (bridge.post.*): channelId = the forum,
// so visibility is the forum's.
export async function emitPostEvent(type: 'bridge.post.created' | 'bridge.post.updated', post: BridgePost): Promise<void> {
  await emit(DISCORD_BRIDGE_OWNER_KEY, type, { channelId: post.forumId, post: await forumPostView(post) })
}
