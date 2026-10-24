import {
  Client,
  WebhookClient,
  ChannelType,
  Routes,
  MessageReferenceType,
  type Guild,
  type GuildMember,
  type PartialGuildMember,
  type Message,
  type MessageMentionOptions,
  type NewsChannel,
  type Role,
  type TextChannel,
} from 'discord.js'
import { getPool, query } from './db.js'
import { getConfig } from './config.js'
import { emit, DISCORD_BRIDGE_OWNER_KEY, startEventRelay } from './events.js'
import { OUTBOX_NOTIFY_CHANNEL, EDIT_NOTIFY_CHANNEL, DELETE_NOTIFY_CHANNEL } from './discord-bridge-api.js'
import * as bridge from './discord-bridge-db.js'
import { attachmentFromDjs } from './discord-media.js'
import { messageLinks } from './discord-unfurl.js'
import { type DiscordApiUserRaw } from './discord-channel-access.js'
import {
  CATEGORY_CHANNEL_TYPE,
  changedGuilds,
  configuredIds,
  everyoneCanView,
  layoutSignatures,
  overwritesKey,
  protectedFromDisable,
  resolveBridgedChannels,
  type LayoutEntry,
} from './discord-bridge-categories.js'
import { absoluteAvatarUrl, isApprovedSha, shaFromAvatarUrl } from './avatar-store.js'
import { componentsFromRaw, interactionFromRaw, MessageFlag } from './discord-interactions.js'

// Bridges guild text/announcement channels with the site chatbox, across
// every guild the bot is in: each channel inside a configured category
// (config.discord.bridgeCategories) plus the legacy per-channel list
// (config.discord.bridgeChannels). Discord-originated messages are persisted
// to discord_bridge_message and broadcast over the realtime bus;
// web-originated rows (written by the app server) are delivered back to
// Discord through each channel's webhook with the sender's identity.

const discordCdn = 'https://cdn.discordapp.com'

// Text (0) and announcement (5) channels: both have webhooks + messages.
type BridgeTextChannel = TextChannel | NewsChannel

interface BridgeRuntime {
  client: Client
  // Guilds with at least one bridged channel (the bridged guild set).
  guildIds: Set<string>
  // Guilds holding a configured category or legacy channel: their channel
  // events can change the bridged set.
  watchGuildIds: Set<string>
  webhooks: Map<string, WebhookClient>
  channels: Map<string, BridgeTextChannel>
  recentSends: Map<string, number[]>
  sweepTimer: NodeJS.Timeout | null
  dirSyncTimer: NodeJS.Timeout | null
  // Per-guild sidebar layout signature (discord-bridge-categories.ts).
  layout: Map<string, string>
  onGuildsChanged: ((guildIds: string[]) => void) | null
}

let runtime: BridgeRuntime | null = null

// The bridged guild set as the bot resolved it (empty before startBridge).
export function bridgedGuildIds(): string[] {
  return runtime ? [...runtime.guildIds] : []
}

function avatarUrl(message: Message): string | null {
  const url = message.author.displayAvatarURL({ extension: 'webp', size: 64 })
  return url || null
}

function roleColor(message: Message): string | null {
  if (!message.member) return null
  const hex = message.member.displayHexColor
  return hex && hex !== '#000000' ? hex : null
}

function mentionPayload(message: Message) {
  const mentions: Array<Record<string, string | null>> = []
  for (const [id, user] of message.mentions.users) {
    mentions.push({ type: 'user', id, username: message.mentions.members?.get(id)?.displayName || user.username })
  }
  for (const [id, channel] of message.mentions.channels) {
    mentions.push({ type: 'channel', id, name: 'name' in channel ? String(channel.name) : id })
  }
  // Role mentions: record the role's name + color so the site can render the
  // same role-colored chip the web-originated path produces. role.color is a
  // number (0 = no color); role.hexColor is always a string ('#000000' when
  // colorless), so only use it when color !== 0 - otherwise null lets the
  // chip fall back to blurple.
  for (const [id, role] of message.mentions.roles) {
    mentions.push({ type: 'role', id, name: role.name, color: role.color !== 0 ? role.hexColor : null })
  }
  // @everyone / @here: the client's everyone-chip + highlight key off this.
  if (message.mentions.everyone) {
    mentions.push({ type: 'everyone' })
  }
  return mentions
}

// Every Discord attachment field the client renders (proxy URL, alt text,
// spoiler/remix flags, voice-message duration/waveform…) - see discord-media.ts.
function attachmentPayload(message: Pick<Message, 'attachments'>) {
  return message.attachments.map(attachmentFromDjs).filter((a) => a !== null)
}

function embedPayload(message: Message) {
  return message.embeds.map((e) => e.toJSON() as Record<string, unknown>)
}

// Embeds from a webhook-send result: discord.js Embed objects (Message) or raw
// API objects (APIMessage / the REST reply path) - always the raw API shape.
function rawEmbedList(list: unknown): Record<string, unknown>[] {
  if (!Array.isArray(list)) return []
  return list
    .map((e) => (e && typeof (e as { toJSON?: unknown }).toJSON === 'function' ? (e as { toJSON: () => unknown }).toJSON() : e))
    .filter((e): e is Record<string, unknown> => e != null && typeof e === 'object')
}

// Raw API interaction fields from a gateway message: interaction_metadata
// (who ran it) + the deprecated `interaction` (the only one carrying the full
// "cmd sub" name path; discord.js exposes it as commandName).
function rawInteractionFields(message: Message) {
  const meta = message.interactionMetadata
  const legacy = message.interaction
  return {
    type: message.type as number,
    interaction_metadata: meta ? { id: meta.id, type: meta.type as number, user: rawUser(meta.user) } : null,
    interaction: legacy ? { id: legacy.id, type: legacy.type as number, name: legacy.commandName, user: rawUser(legacy.user) } : null,
  }
}

// Slash / context-menu command header data, the component tree and flags
// (discord-interactions.ts). Components V2 media referencing attachment://
// resolve against `attachments`; the urls they consumed come back so the row
// doesn't render those files a second time as plain attachments.
function interactionPayload(message: Message, attachments: Array<{ url: string; name?: string }>) {
  const fields = rawInteractionFields(message)
  const userId = fields.interaction_metadata?.user.id || fields.interaction?.user.id
  const member = userId ? message.guild?.members.cache.get(userId) : undefined
  const interaction = interactionFromRaw(fields, {
    displayName: () => member?.displayName,
    avatar: () => member?.displayAvatarURL({ extension: 'webp', size: 64 }),
    color: () => (member && member.displayHexColor !== '#000000' ? member.displayHexColor : null),
  })
  const { components, usedAttachmentUrls } = componentsFromRaw(message.components.map((c) => c.toJSON()), attachments)
  return { messageType: message.type as number, interaction, components, flags: message.flags.bitfield, usedAttachmentUrls }
}

// Discord forwards (message_reference.type === FORWARD) carry the source in
// message_snapshots and have EMPTY content of their own. Normalize the first
// snapshot so the site renders the "Forwarded" block instead of a blank row.
function forwardPayload(message: Message): bridge.ForwardSnapshot | null {
  if (message.reference?.type !== MessageReferenceType.Forward) return null
  const snap = message.messageSnapshots?.first()
  if (!snap) return null
  return {
    content: snap.content || '',
    attachments: snap.attachments ? attachmentPayload(snap) : [],
    embeds: snap.embeds ? snap.embeds.map((e) => e.toJSON() as Record<string, unknown>) : [],
    mentions: [],
    components: snap.components ? componentsFromRaw(snap.components.map((c) => c.toJSON()), snap.attachments ? attachmentPayload(snap) : []).components : [],
    createdAt: snap.createdTimestamp ? new Date(snap.createdTimestamp).toISOString() : null,
    channelId: message.reference.channelId || null,
    messageId: message.reference.messageId || null,
    guildId: message.reference.guildId || null,
  }
}

// `broadcast: false` is used by the startup history reconciliation: rows are stored
// exactly as live ones are, but nothing is pushed over the realtime bus.
// Our own slash-command replies are bridged like a user's message; other bot output is not.
function isOwnBotReply(message: Message, botId: string | undefined): boolean {
  return Boolean(botId && message.author.id === botId && message.interactionMetadata)
}

async function persistDiscordMessage(message: Message, opts: { broadcast: boolean } = { broadcast: true }): Promise<boolean> {
  const channel = runtime?.channels.get(message.channelId)
  if (channel) {
    // Metadata only: never (re-)enables the row (only the bridge-set sync
    // does), so a late message can't revive a channel just disabled.
    await bridge.updateChannelMetadata({
      channelId: channel.id,
      name: channel.name,
      topic: channel.topic || '',
      position: channel.position,
      parentId: channel.parentId ?? null,
    }).catch(() => {})
  }
  // Resolve the author's chat tier (in this channel's guild) for the role
  // badge (MOD/ADMIN/OWNER).
  const { chatPermsForDiscord } = await import('./discord-chat-perms.js')
  const authorPerms = message.guildId ? await chatPermsForDiscord(message.author.id, message.guildId).catch(() => null) : null
  const authorRole = authorPerms && authorPerms.tier !== 'member' && authorPerms.tier !== 'guest' ? authorPerms.tier : null

  // Reply "@ ON/OFF" for Discord-originated replies: the reply pinged its
  // target iff the referenced author is in the message's resolved mentions
  // (discord.js sets repliedUser to the referenced author either way). When it
  // pinged, record a 'reply' mention so the web highlights it for the target -
  // including a web author (webhook delivery), matched by author name.
  const isReply = Boolean(message.reference) && message.reference?.type !== MessageReferenceType.Forward
  const repliedUser = isReply ? message.mentions.repliedUser : null
  const replyMention = Boolean(repliedUser && message.mentions.users.has(repliedUser.id))
  const mentions: Array<Record<string, string | null>> = mentionPayload(message)
  if (replyMention && message.reference?.messageId) {
    const target = await bridge.byDiscordMessageId(message.reference.messageId).catch(() => null)
    if (target && !target.deletedAt) {
      const discordId = target.authorKey.startsWith('discord:') ? target.authorKey.slice('discord:'.length) : ''
      mentions.push({ type: 'reply', id: discordId, username: target.authorName })
    }
  }

  const attachments = attachmentPayload(message)
  const ix = interactionPayload(message, attachments)
  const { existed } = await bridge.recordMessage({
    channelId: message.channelId,
    direction: 'discord',
    discordMessageId: message.id,
    authorKey: `discord:${message.author.id}`,
    authorName: message.member?.displayName || message.author.username,
    authorAvatar: avatarUrl(message),
    authorColor: roleColor(message),
    authorRole,
    // Discord renders the APP botTag for bot and webhook authors.
    authorBot: Boolean(message.webhookId) || message.author.bot,
    content: message.content,
    attachments: attachments.filter((a) => !ix.usedAttachmentUrls.has(a.url)),
    embeds: embedPayload(message),
    mentions,
    replyMention: isReply ? replyMention : true,
    // Only a real reply threads; a forward's reference points at the
    // forwarded source and is carried by `forwarded` instead.
    replyTo: message.reference && message.reference.type !== MessageReferenceType.Forward
      ? message.reference.messageId || null
      : null,
    createdAt: message.createdAt,
    forwarded: forwardPayload(message),
  })
  if (existed) return false
  if (ix.interaction || ix.components.length || ix.flags || ix.messageType) {
    await bridge.setInteractionFields(message.id, ix).catch((error) => {
      console.error('[abulxt-discord] failed to store interaction fields:', error instanceof Error ? error.message : error)
    })
  }
  if (opts.broadcast) {
    const stored = await bridge.byDiscordMessageId(message.id)
    if (stored) await bridge.broadcastMessage(stored)
  }
  return true
}

// --- Startup history reconciliation for bridged channels ---------------------
// The live path only sees gateway events, so anything that happened while the
// bot was offline (messages deleted, edited or sent) is invisible to it. Every
// time the bot comes online, each enabled bridged channel is reconciled against
// Discord's most recent RECONCILE_WINDOW messages (one REST call per channel).
// Runs in the background after ready; never blocks startup.

const RECONCILE_WINDOW = 100
const RECONCILE_PAUSE_MS = 2_000
const DISCORD_EPOCH_MS = 1420070400000n

// Lowest snowflake created at or after `ms` (used as an upper bound when the
// fetch came back empty and there is no fetched id to bound by).
function snowflakeAt(ms: number): string {
  return ((BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH_MS) << 22n).toString()
}

// What the reconciler compares: the Discord-side view of one message, in the
// same shape persistDiscordMessage / the live messageUpdate handler write.
export interface ReconcileRow {
  discordMessageId: string
  content: string
  attachments: unknown[]
  embeds: unknown[]
  // Discord's edited_timestamp as ISO, or null when Discord reports no edit.
  editedAt: string | null
}

export interface StoredReconcileRow extends ReconcileRow {
  id: number
  flags: number
}

export interface ReconcilePlan {
  insert: string[]
  update: string[]
  remove: string[]
}

// Key-sorted, undefined-free JSON: jsonb reorders object keys on write, so a
// plain JSON.stringify comparison would report every stored embed as changed.
function canonicalJson(value: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon)
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      return Object.fromEntries(Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => [k, canon(o[k])]))
    }
    return v
  }
  return JSON.stringify(canon(value))
}

// Whether a stored Discord row no longer matches Discord. An edit counts only
// when Discord reports an edited_timestamp, mirroring the live messageUpdate path.
export function reconcileRowChanged(fetched: ReconcileRow, stored: ReconcileRow): boolean {
  if (fetched.content !== stored.content) return true
  if (canonicalJson(fetched.attachments) !== canonicalJson(stored.attachments)) return true
  if (canonicalJson(fetched.embeds) !== canonicalJson(stored.embeds)) return true
  return fetched.editedAt !== null && fetched.editedAt !== stored.editedAt
}

// Pure diff for one channel. `fetched` holds the messages the live path would
// persist; `windowIds` holds every id in the fetched window (including skipped
// ones, so a skipped message is never mistaken for a deletion); `stored` holds
// the non-deleted Discord-origin rows inside the reconciled id range.
export function planDiscordReconcile(input: {
  fetched: ReconcileRow[]
  windowIds: string[]
  stored: StoredReconcileRow[]
}): ReconcilePlan {
  const storedById = new Map(input.stored.map((s) => [s.discordMessageId, s]))
  const windowSet = new Set(input.windowIds)
  const insert: string[] = []
  const update: string[] = []
  for (const f of input.fetched) {
    const s = storedById.get(f.discordMessageId)
    if (!s) insert.push(f.discordMessageId)
    else if (reconcileRowChanged(f, s)) update.push(f.discordMessageId)
  }
  const remove = input.stored.filter((s) => !windowSet.has(s.discordMessageId)).map((s) => s.discordMessageId)
  return { insert, update, remove }
}

function isoOrNull(value: string | number | Date | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null
  return new Date(value).toISOString()
}

function reconcileRowFor(message: Message): { row: ReconcileRow; ix: ReturnType<typeof interactionPayload> } {
  const attachments = attachmentPayload(message)
  const ix = interactionPayload(message, attachments)
  return {
    row: {
      discordMessageId: message.id,
      content: message.content,
      attachments: attachments.filter((a) => !ix.usedAttachmentUrls.has(a.url)),
      embeds: embedPayload(message),
      editedAt: isoOrNull(message.editedTimestamp),
    },
    ix,
  }
}

async function reconcileChannel(rt: BridgeRuntime, channel: BridgeTextChannel): Promise<void> {
  const fetchStartedAt = Date.now()
  let fetched: Message[]
  try {
    fetched = [...(await channel.messages.fetch({ limit: RECONCILE_WINDOW })).values()]
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
  } catch (error) {
    // Nothing is touched when Discord can't tell us the current state.
    console.error(`[abulxt-discord] reconcile #${channel.name}: fetch failed, channel left unchanged:`, error instanceof Error ? error.message : error)
    return
  }

  // A short fetch means the whole channel is in the window: no lower bound.
  // Otherwise the window is [oldest fetched, newest fetched]. The upper bound
  // keeps rows created after the fetch out of the deletion candidates.
  const wholeChannel = fetched.length < RECONCILE_WINDOW
  const lo = wholeChannel ? null : fetched[0].id
  const hi = fetched.length ? fetched[fetched.length - 1].id : snowflakeAt(fetchStartedAt)
  const windowIds = fetched.map((m) => m.id)

  let stored: StoredReconcileRow[]
  try {
    const rows = await bridge.discordRowsInWindow(channel.id, lo, hi)
    stored = rows.flatMap((r) => (r.discordMessageId
      ? [{
        id: r.id,
        flags: r.flags ?? 0,
        discordMessageId: r.discordMessageId,
        content: r.content,
        attachments: r.attachments,
        embeds: r.embeds,
        editedAt: isoOrNull(r.editedAt),
      }]
      : []))
  } catch (error) {
    console.error(`[abulxt-discord] reconcile #${channel.name}: stored-row load failed, channel left unchanged:`, error instanceof Error ? error.message : error)
    return
  }

  // Same skip rules as the live messageCreate path: our own webhook deliveries
  // (already stored as direction 'web') and bot chatter without a webhook.
  const ownHook = rt.webhooks.get(channel.id)
  const persistable = fetched.filter((m) => {
    if (m.webhookId && ownHook && m.webhookId === ownHook.id) return false
    if (m.author.bot && !m.webhookId && !isOwnBotReply(m, rt.client.user?.id)) return false
    return true
  })
  const skipped = fetched.length - persistable.length
  const byId = new Map(persistable.map((m) => [m.id, m]))
  const built = new Map(persistable.map((m) => [m.id, reconcileRowFor(m)]))

  const plan = planDiscordReconcile({
    fetched: persistable.map((m) => built.get(m.id)!.row),
    windowIds,
    stored,
  })
  const storedById = new Map(stored.map((s) => [s.discordMessageId, s]))

  let inserted = 0
  let updated = 0
  let deleted = 0
  let failed = 0
  // Oldest first, so reply targets and forwards resolve against earlier rows.
  for (const id of plan.insert) {
    try {
      if (await persistDiscordMessage(byId.get(id)!, { broadcast: false })) inserted++
    } catch (error) {
      failed++
      console.error(`[abulxt-discord] reconcile #${channel.name}: insert ${id} failed:`, error instanceof Error ? error.message : error)
    }
  }
  for (const id of plan.update) {
    try {
      const message = byId.get(id)!
      const { row, ix } = built.get(id)!
      const s = storedById.get(id)!
      // Same edit/embed split as the live messageUpdate path.
      const wasLoading = (s.flags & MessageFlag.LOADING) !== 0
      const edited = !wasLoading && message.editedTimestamp !== null && message.editedTimestamp !== undefined
      await bridge.setInteractionFields(id, { components: ix.components, flags: ix.flags }).catch(() => {})
      const next = await bridge.editByDiscordMessageId(id, message.content, {
        edited,
        editedAt: edited ? new Date(message.editedTimestamp!) : null,
        embeds: row.embeds,
        attachments: row.attachments,
      })
      if (next) {
        updated++
        await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.message.edited', edited || wasLoading ? { message: next } : { message: next, embedOnly: true })
      }
    } catch (error) {
      failed++
      console.error(`[abulxt-discord] reconcile #${channel.name}: update ${id} failed:`, error instanceof Error ? error.message : error)
    }
  }
  for (const id of plan.remove) {
    try {
      const gone = await bridge.deleteByDiscordMessageId(id)
      if (gone) {
        deleted++
        await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.message.deleted', {
          id: gone.id,
          channelId: gone.channelId,
          discordMessageId: gone.discordMessageId,
        })
      }
    } catch (error) {
      failed++
      console.error(`[abulxt-discord] reconcile #${channel.name}: delete ${id} failed:`, error instanceof Error ? error.message : error)
    }
  }
  // Inserts are not broadcast one by one: a single event tells open clients to
  // refetch the channel's latest page.
  if (inserted > 0) {
    await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.channel.resync', { channelId: channel.id }).catch(() => {})
  }
  const scope = wholeChannel ? 'whole channel' : `window of ${RECONCILE_WINDOW}`
  console.log(`[abulxt-discord] reconcile #${channel.name} (${scope}): fetched ${fetched.length}, inserted ${inserted}, updated ${updated}, deleted ${deleted}, skipped ${skipped}${failed ? `, failed ${failed}` : ''}`)
}

async function reconcileBridgedHistory(): Promise<void> {
  const rt = runtime
  if (!rt) return
  const enabled = new Set((await bridge.listChannels(true).catch(() => [])).map((c) => c.channelId))
  const targets = [...rt.channels.values()].filter((c) => enabled.has(c.id))
  let first = true
  for (const channel of targets) {
    if (!first) await new Promise((resolve) => setTimeout(resolve, RECONCILE_PAUSE_MS))
    first = false
    if (runtime !== rt) return
    await reconcileChannel(rt, channel).catch((error) => {
      console.error(`[abulxt-discord] reconcile #${channel.name} crashed:`, error instanceof Error ? error.message : error)
    })
  }
}

function rawUser(user: { id: string; username: string; globalName?: string | null; avatar?: string | null }): DiscordApiUserRaw {
  return { id: user.id, username: user.username, global_name: user.globalName ?? null, avatar: user.avatar ?? null }
}

function spamKey(message: Message): string {
  return `${message.channelId}:${message.author.id}`
}

function isSpam(runtime: BridgeRuntime, message: Message): boolean {
  const now = Date.now()
  const key = spamKey(message)
  const hits = (runtime.recentSends.get(key) || []).filter((t) => t > now - 8_000)
  hits.push(now)
  runtime.recentSends.set(key, hits)
  if (hits.length >= 7) return true
  const distinct = new Set(hits.map(() => message.content))
  return hits.length >= 5 && distinct.size === 1 && message.content.length > 3
}

async function ensureWebhook(channel: BridgeTextChannel): Promise<WebhookClient | null> {
  const cached = runtime?.webhooks.get(channel.id)
  if (cached) return cached
  const row = await query<{ webhook_id: string | null; webhook_token: string | null }>(
    `SELECT webhook_id, webhook_token FROM discord_bridge_channel WHERE channel_id = $1`,
    [channel.id],
  )
  const existing = row.rows[0]
  try {
    if (existing?.webhook_id && existing?.webhook_token) {
      const hook = new WebhookClient({ id: existing.webhook_id, token: existing.webhook_token })
      await hook.fetchMessage('@original').catch(() => {})
      runtime?.webhooks.set(channel.id, hook)
      return hook
    }
  } catch {
    // stale webhook - recreate below
  }
  try {
    const created = await channel.createWebhook({ name: 'abulxt Bridge', reason: 'Site chatbox bridge' })
    const hook = new WebhookClient({ id: created.id, token: created.token! })
    // The row exists (the sync upserts before calling this); store the
    // webhook without touching `enabled`.
    await bridge.setChannelWebhook(channel.id, created.id, created.token!)
    runtime?.webhooks.set(channel.id, hook)
    return hook
  } catch (error) {
    console.error(`[abulxt-discord] failed to create webhook for #${channel.name}:`, error instanceof Error ? error.message : error)
    return null
  }
}

interface OutboxRow {
  id: string
  channel_id: string
  author_name: string
  author_avatar: string | null
  content: string
  mentions: unknown
  reply_to: string | null
  reply_mention: boolean | null
  forwarded: bridge.ForwardSnapshot | null
}

// Webhooks can't send a native FORWARD (message_reference type 1), so a web
// forward is delivered as Discord's forward look-alike: a small "Forwarded"
// header, the snapshot quoted, attachment links, and a jump-back footer. Never
// pings - the row's stored mentions are empty, so allowed_mentions is empty.
export function forwardContent(snap: bridge.ForwardSnapshot): string {
  const attachmentUrls = (Array.isArray(snap.attachments) ? snap.attachments : [])
    .map((a) => (a && typeof a === 'object' && typeof (a as { url?: unknown }).url === 'string' ? (a as { url: string }).url : ''))
    .filter(Boolean)
  const body = [snap.content || '', ...attachmentUrls].filter((s) => s.trim()).join('\n')
  const footer = snap.guildId && snap.channelId && snap.messageId && /^\d+$/.test(snap.messageId)
    ? `\n-# <#${snap.channelId}> • https://discord.com/channels/${snap.guildId}/${snap.channelId}/${snap.messageId}`
    : snap.channelId ? `\n-# <#${snap.channelId}>` : ''
  const header = '-# ↱ *Forwarded*\n'
  const budget = 2000 - header.length - footer.length
  let quoted = body.split('\n').map((line) => `> ${line}`).join('\n')
  if (quoted.length > budget) quoted = `${quoted.slice(0, Math.max(0, budget - 1))}…`
  return `${header}${quoted}${footer}`
}

// The mentions recorded on a web-originated message by the app server's
// permission gate (discord-bridge-api.ts parseMentions). The bot trusts this
// list as authoritative - the server already decided, per mention, whether
// the caller may ping it - so delivery builds Discord's allowedMentions from
// it rather than re-parsing the content.
interface PersistedMention {
  type?: string
  id?: string
  // Neutralized by the ping limits (discord-mention-limits.ts): the <@id>
  // token stays in the content (Discord renders the chip) but it is left out
  // of allowed_mentions, so nobody is pinged.
  inert?: boolean
}

// Build Discord's allowedMentions from the persisted mentions array. pg
// returns JSONB pre-parsed, but accept a raw string too so a driver quirk can
// never break delivery. Any parse/shape error falls back to pinging nothing.
function allowedMentionsFromStored(raw: unknown, repliedUser: boolean): MessageMentionOptions {
  const base: MessageMentionOptions = { parse: [], users: [], roles: [], repliedUser }
  try {
    const list: unknown = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw
    if (!Array.isArray(list)) return base
    const mentions = (list as PersistedMention[]).filter((m) => m && m.inert !== true)
    const everyone = mentions.some((m) => m?.type === 'everyone')
    const users = mentions.filter((m) => m?.type === 'user' && typeof m?.id === 'string').map((m) => m.id!)
    const roles = mentions.filter((m) => m?.type === 'role' && typeof m?.id === 'string').map((m) => m.id!)
    return {
      parse: everyone ? ['everyone'] : [],
      users,
      roles,
      repliedUser,
    }
  } catch (error) {
    console.error('[abulxt-discord] failed to build allowedMentions from stored mentions:', error instanceof Error ? error.message : error)
    return base
  }
}

// Resolve a web message's reply_to to a Discord message snowflake for
// message_reference threading. reply_to normally holds the internal bridge
// message id (web replies); a Discord snowflake also works (defensive - the
// client can resolve either form). Returns null when the target is unknown or
// was never delivered to Discord (no discord_message_id yet).
async function resolveReplyMessageId(replyTo: string | null): Promise<string | null> {
  if (!replyTo) return null
  try {
    const asInternalId = Number(replyTo)
    if (Number.isInteger(asInternalId) && String(asInternalId) === replyTo.trim()) {
      const target = await bridge.messageFor(asInternalId).catch(() => null)
      if (target?.discordMessageId) return target.discordMessageId
    }
    const bySnowflake = await bridge.byDiscordMessageId(replyTo).catch(() => null)
    if (bySnowflake?.discordMessageId) return bySnowflake.discordMessageId
  } catch (error) {
    console.error('[abulxt-discord] failed to resolve reply_to for threading:', error instanceof Error ? error.message : error)
  }
  return null
}

// Rows currently being delivered. The LISTEN handler and the 15s outbox sweep
// both call deliverWebMessage; without this claim a sweep that lands while a
// notify-triggered webhook POST is still in flight (discord_message_id still
// NULL) re-delivers the same row - the user's message appears TWICE on
// Discord while the site shows it once.
const delivering = new Set<number>()

async function deliverWebMessage(id: number): Promise<void> {
  if (delivering.has(id)) return
  delivering.add(id)
  try {
    await deliverWebMessageOnce(id)
  } finally {
    delivering.delete(id)
  }
}

async function deliverWebMessageOnce(id: number): Promise<void> {
  const { rows } = await query<OutboxRow>(
    `SELECT id, channel_id, author_name, author_avatar, content, mentions, reply_to, reply_mention, forwarded
     FROM discord_bridge_message
     WHERE id = $1 AND direction = 'web' AND discord_message_id IS NULL AND deleted_at IS NULL`,
    [id],
  )
  const row = rows[0]
  if (!row) return
  const channel = runtime?.channels.get(row.channel_id)
  if (!channel) return
  const hook = await ensureWebhook(channel)
  if (!hook) return
  try {
    const replyMessageId = await resolveReplyMessageId(row.reply_to)
    // Reply "@ ON/OFF": replied_user pings the referenced author only when the
    // sender left the toggle on (reply_mention defaults TRUE).
    const allowedMentions = allowedMentionsFromStored(row.mentions, Boolean(replyMessageId) && row.reply_mention !== false)
    const username = row.author_name.slice(0, 80)
    const content = row.forwarded ? forwardContent(row.forwarded) : row.content
    // An uploaded avatar is only handed to Discord while it is still
    // APPROVED (a moderator may have rejected/removed it after the send).
    const ownAvatarSha = shaFromAvatarUrl(row.author_avatar)
    const avatarOk = !ownAvatarSha || (await isApprovedSha(ownAvatarSha).catch(() => false))
    const avatarURL = (avatarOk && (await absoluteAvatarUrl(row.author_avatar).catch(() => null))) || `${discordCdn}/embed/avatars/0.png`
    let sentId: string
    let sentEmbeds: Record<string, unknown>[] = []
    if (replyMessageId) {
      // Reply threading: discord.js v14's typed webhook send can't carry
      // message_reference (WebhookMessageCreateOptions omits `reply`, and the
      // payload builder crashes resolving it against a webhook target), so
      // post the webhook route directly with the same body hook.send would
      // build, plus message_reference. fail_if_not_exists: false keeps
      // delivery alive when the referenced message was deleted on Discord.
      const body = {
        content,
        username,
        avatar_url: avatarURL,
        allowed_mentions: {
          parse: allowedMentions.parse,
          users: allowedMentions.users,
          roles: allowedMentions.roles,
          replied_user: allowedMentions.repliedUser,
        },
        message_reference: { message_id: replyMessageId, fail_if_not_exists: false },
      }
      const sent = (await hook.client.rest.post(Routes.webhook(hook.id, hook.token!), {
        body,
        query: new URLSearchParams({ wait: 'true' }),
        auth: false,
      })) as { id: string; embeds?: unknown[] }
      sentId = sent.id
      sentEmbeds = rawEmbedList(sent.embeds)
    } else {
      const sent = await hook.send({
        username,
        avatarURL,
        content,
        allowedMentions,
      })
      sentId = sent.id
      sentEmbeds = rawEmbedList(sent.embeds)
    }
    await bridge.attachDiscordMessageId(Number(row.id), sentId)
    // Discord resolves links it has already unfurled (a GIF/image/CDN link
    // posted before) synchronously: the embeds come back in the webhook
    // response and NO embed MESSAGE_UPDATE follows - adopt them here, or the
    // web row would never get Discord's (media-proxy) embeds.
    if (sentEmbeds.length) {
      const updated = await bridge.setEmbedsByDiscordMessageId(sentId, sentEmbeds).catch(() => null)
      if (updated) {
        await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.message.edited', { message: updated, embedOnly: true }).catch(() => {})
      }
    }
  } catch (error) {
    console.error('[abulxt-discord] webhook delivery failed:', error instanceof Error ? error.message : error)
  }
}

let sweeping = false
async function outboxSweep(): Promise<void> {
  // A slow sweep (rate-limited webhooks) must not overlap the next tick.
  if (sweeping) return
  sweeping = true
  try {
    await outboxSweepOnce()
  } finally {
    sweeping = false
  }
}

async function outboxSweepOnce(): Promise<void> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM discord_bridge_message
     WHERE direction = 'web' AND discord_message_id IS NULL AND deleted_at IS NULL
       AND created_at > NOW() - INTERVAL '10 minutes'
     ORDER BY id ASC LIMIT 25`,
  )
  for (const row of rows) {
    await deliverWebMessage(Number(row.id))
  }
}

// The bot mirrors a reaction to Discord exactly once per emoji per message:
// it reacts when the first real reactor appears and unreacts when the last one
// leaves. Driven by pg_notify from the app server (abulxt_bridge_reaction).
const REACTION_NOTIFY_CHANNEL = 'abulxt_bridge_reaction'

async function applyBotReaction(payload: { discordMessageId?: string; channelId?: string; emoji?: string; botShouldReact?: boolean }): Promise<void> {
  if (!runtime || !payload.discordMessageId || !payload.channelId || !payload.emoji) return
  const channel = runtime.channels.get(payload.channelId)
  if (!channel) return
  const message = await channel.messages.fetch(payload.discordMessageId).catch(() => null)
  if (!message) return
  // Find the bot's own current reaction to this emoji (the bot never counts as
  // a real reactor).
  const me = message.reactions.cache.find((r) => r.emoji.name === payload.emoji && r.users.cache.has(runtime!.client.user!.id))
  if (payload.botShouldReact && !me) {
    await message.react(payload.emoji).catch(() => {})
  } else if (!payload.botShouldReact && me) {
    await me.users.remove(runtime.client.user!.id).catch(() => {})
  }
}

// Web-originated edits/deletes are mirrored to Discord over pg_notify (the web
// endpoints in discord-bridge-api.ts notify after persisting). Edits go through
// the channel webhook (Discord only lets the webhook that sent a message edit
// it); deletes use the bot token, which can remove any message in its bridged
// channels - webhook deliveries and Discord-originated messages alike.
async function applyBotEdit(payload: { discordMessageId?: string; channelId?: string; content?: string }): Promise<void> {
  if (!runtime || !payload.discordMessageId || !payload.channelId || typeof payload.content !== 'string') return
  try {
    const channel = runtime.channels.get(payload.channelId)
    if (!channel) return
    // Build allowedMentions from the persisted mentions for this message -
    // the same authoritative list the delivery path uses. The edit endpoint
    // re-ran the permission gate and stored the gated mentions, so the Discord
    // edit pings exactly what the caller is allowed to ping and nothing more.
    // Without this, discord.js's DEFAULT allowedMentions would re-parse the
    // content and ping @everyone/roles the caller has no right to.
    const stored = await bridge.byDiscordMessageId(payload.discordMessageId).catch(() => null)
    const allowedMentions = allowedMentionsFromStored(stored?.mentions ?? [], false)
    const hook = await ensureWebhook(channel)
    if (hook) {
      await hook.editMessage(payload.discordMessageId, { content: payload.content, allowedMentions })
      return
    }
    const message = await channel.messages.fetch(payload.discordMessageId).catch(() => null)
    if (message) await message.edit({ content: payload.content, allowedMentions })
  } catch (error) {
    console.error('[abulxt-discord] failed to mirror web edit to Discord:', error instanceof Error ? error.message : error)
  }
}

async function applyBotDelete(payload: { discordMessageId?: string; channelId?: string }): Promise<void> {
  if (!runtime || !payload.discordMessageId || !payload.channelId) return
  try {
    const channel = runtime.channels.get(payload.channelId)
    if (!channel) return
    const message = await channel.messages.fetch(payload.discordMessageId).catch(() => null)
    if (message) await message.delete()
  } catch (error) {
    console.error('[abulxt-discord] failed to mirror web delete to Discord:', error instanceof Error ? error.message : error)
  }
}

async function listenOutbox(): Promise<void> {
  try {
    const client = await getPool().connect()
    client.on('notification', (message) => {
      if (!message.payload) return
      if (message.channel === OUTBOX_NOTIFY_CHANNEL) {
        try {
          const parsed = JSON.parse(message.payload) as { id?: number }
          if (typeof parsed.id === 'number') void deliverWebMessage(parsed.id)
        } catch {
          // ignore malformed payloads
        }
      } else if (message.channel === REACTION_NOTIFY_CHANNEL) {
        try {
          void applyBotReaction(JSON.parse(message.payload))
        } catch {
          // ignore malformed payloads
        }
      } else if (message.channel === EDIT_NOTIFY_CHANNEL) {
        try {
          void applyBotEdit(JSON.parse(message.payload))
        } catch {
          // ignore malformed payloads
        }
      } else if (message.channel === DELETE_NOTIFY_CHANNEL) {
        try {
          void applyBotDelete(JSON.parse(message.payload))
        } catch {
          // ignore malformed payloads
        }
      }
    })
    client.on('error', () => {})
    await client.query(`LISTEN ${OUTBOX_NOTIFY_CHANNEL}`)
    await client.query(`LISTEN ${REACTION_NOTIFY_CHANNEL}`)
    await client.query(`LISTEN ${EDIT_NOTIFY_CHANNEL}`)
    await client.query(`LISTEN ${DELETE_NOTIFY_CHANNEL}`)
  } catch {
    // sweep backstop covers missed notifications
  }
}

// --- Guild directory sync (members + roles) --------------------------------
// Keeps the bridge directory tables current for @mention autocomplete and role
// mentions in the site chatbox. The full guild is synced at startup; gateway
// events (member add/remove/update, role create/update/delete) keep it fresh.
// All failures are logged and swallowed - directory drift must never crash the
// bridge.

// Author cosmetics a bot can read (019_discord_bridge_author_style): the
// member's role ids (color role → gradient/holographic name), joined_at +
// DID_REJOIN flag (new-member badge), and the user's avatar decoration
// (guild-member decoration wins, like Discord), nameplate and server tag.
function memberStyle(member: GuildMember | PartialGuildMember): Record<string, unknown> {
  const decoration = member.avatarDecorationData ?? member.user.avatarDecorationData ?? null
  const nameplate = member.collectibles?.nameplate ?? member.user.collectibles?.nameplate ?? null
  const pg = member.user.primaryGuild
  return {
    decoration: decoration?.asset ? { asset: decoration.asset, skuId: decoration.skuId ?? null } : null,
    nameplate: nameplate?.asset
      ? { asset: nameplate.asset, palette: nameplate.palette ?? null, label: nameplate.label ?? null, skuId: nameplate.skuId ?? null }
      : null,
    guildTag: pg && pg.identityEnabled && pg.tag && pg.identityGuildId
      ? { guildId: pg.identityGuildId, tag: pg.tag, badge: pg.badge ?? null }
      : null,
  }
}

function memberInput(member: GuildMember | PartialGuildMember) {
  return {
    guildId: member.guild.id,
    userId: member.id,
    username: member.user.username,
    displayName: member.displayName || member.user.username,
    avatar: member.displayAvatarURL({ extension: 'webp', size: 64 }) || null,
    roleIds: member.partial ? undefined : [...member.roles.cache.keys()],
    joinedAt: member.joinedAt ?? null,
    memberFlags: member.flags ? Number(member.flags.bitfield) : undefined,
    bot: Boolean(member.user.bot),
    style: memberStyle(member),
  }
}

function hexOrNull(n: number | null | undefined): string | null {
  return typeof n === 'number' && n > 0 ? `#${n.toString(16).padStart(6, '0')}` : null
}

function roleInput(role: Role) {
  const c = role.colors
  return {
    guildId: role.guild.id,
    roleId: role.id,
    name: role.name,
    color: role.hexColor,
    position: role.position,
    colors: c ? { primary: hexOrNull(c.primaryColor), secondary: hexOrNull(c.secondaryColor), tertiary: hexOrNull(c.tertiaryColor) } : null,
  }
}

// discord.js doesn't parse the user's display_name_styles ({font_id,
// effect_id, colors}); when Discord includes it on a gateway user object,
// merge it into the directory row's style JSON straight from the raw packet.
function captureRawDisplayNameStyles(packet: { t?: string | null; d?: unknown }, guildIds: ReadonlySet<string>): void {
  const d = packet.d as { guild_id?: string; user?: Record<string, unknown>; author?: Record<string, unknown>; members?: Array<{ user?: Record<string, unknown> }> } | null
  // Only bridged guilds keep a directory.
  if (!d || !d.guild_id || !guildIds.has(d.guild_id)) return
  const guildId = d.guild_id
  const users: Array<Record<string, unknown> | undefined> = []
  if (packet.t === 'GUILD_MEMBER_ADD' || packet.t === 'GUILD_MEMBER_UPDATE') users.push(d.user)
  else if (packet.t === 'MESSAGE_CREATE') users.push(d.author)
  else if (packet.t === 'GUILD_MEMBERS_CHUNK') for (const m of d.members || []) users.push(m.user)
  for (const u of users) {
    if (!u || typeof u.id !== 'string' || !('display_name_styles' in u)) continue
    const raw = u.display_name_styles as { font_id?: number; effect_id?: number; colors?: number[] } | null
    const displayNameStyles = raw
      ? { fontId: raw.font_id ?? null, effectId: raw.effect_id ?? null, colors: Array.isArray(raw.colors) ? raw.colors : [] }
      : null
    void bridge.mergeGuildMemberStyle(guildId, u.id, { displayNameStyles }).catch(() => {})
  }
}

async function syncGuildDirectory(guild: Guild): Promise<void> {
  try {
    const roles = await guild.roles.fetch()
    await bridge.syncGuildRoles(guild.id, roles.map(roleInput))
    const members = await guild.members.fetch()
    let synced = 0
    for (const [, member] of members) {
      await bridge.upsertGuildMember(memberInput(member)).catch(() => {})
      synced++
    }
    console.log(`[abulxt-discord] directory sync: ${synced} member(s), ${roles.size} role(s) for guild ${guild.id}`)
  } catch (error) {
    console.error('[abulxt-discord] directory sync failed:', error instanceof Error ? error.message : error)
  }
}

// --- Bridged channel set (categories + legacy channels) -----------------------

function isBridgeTextChannel(channel: unknown): channel is BridgeTextChannel {
  const c = channel as { type?: number; guildId?: string } | null
  return Boolean(c && c.guildId && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement))
}

type OverwriteHolder = {
  permissionOverwrites?: { cache: { values(): Iterable<{ id: string; type: number; allow: { bitfield: bigint }; deny: { bitfield: bigint } }> } }
}

// @everyone VIEW_CHANNEL for a bridged channel (discord_bridge_channel
// .everyone_can_view): the guild's @everyone role + the channel's overwrites.
function everyoneViews(channel: BridgeTextChannel): boolean {
  const cache = (channel as unknown as OverwriteHolder).permissionOverwrites?.cache
  return everyoneCanView({
    guildId: channel.guildId,
    everyonePermissions: channel.guild.roles.everyone?.permissions.bitfield ?? 0n,
    overwrites: cache ? [...cache.values()].map((o) => ({ id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield })) : [],
  })
}

function overwritesOf(channel: OverwriteHolder): string {
  const cache = channel.permissionOverwrites?.cache
  if (!cache) return ''
  return overwritesKey([...cache.values()].map((o) => ({ id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield })))
}

// Cache first (the Guilds intent keeps every guild's channels cached), then
// REST. `gone` = Discord says the channel doesn't exist or the bot can't see
// it (Unknown Channel / Missing Access / 403 / 404): safe to stop bridging.
// Any other failure is transient and makes the resolution incomplete.
async function fetchBridgeChannel(client: Client, id: string): Promise<{ channel: unknown; cached: boolean; gone: boolean }> {
  const cached = client.channels.cache.get(id)
  if (cached) return { channel: cached, cached: true, gone: false }
  try {
    const channel = await client.channels.fetch(id)
    return { channel, cached: false, gone: !channel }
  } catch (error) {
    const e = error as { code?: number; status?: number }
    return { channel: null, cached: false, gone: e.code === 10003 || e.code === 50001 || e.status === 404 || e.status === 403 }
  }
}

const warnedIds = new Set<string>()
function warnOnce(id: string, message: string): void {
  if (warnedIds.has(id)) return
  warnedIds.add(id)
  console.error(`[abulxt-discord] ${message}`)
}

interface BridgeResolution {
  wanted: Map<string, BridgeTextChannel>
  // Guilds holding a configured category or legacy channel.
  watchGuildIds: Set<string>
  // false = some configured id failed transiently: nothing is disabled.
  complete: boolean
  // Configured ids that resolved to nothing usable (gone, foreign, wrong
  // type - usually a config typo). Rows under them are never disabled.
  unresolvedCategoryIds: Set<string>
  unresolvedLegacyIds: Set<string>
  layout: Map<string, string>
}

// Resolve config.discord.bridgeCategories + bridgeChannels into the channels
// to bridge, from the gateway cache (REST for anything uncached).
async function resolveBridgeSet(client: Client): Promise<BridgeResolution> {
  const d = getConfig().discord || {}
  const legacyIds = configuredIds(d.bridgeChannels)
  const categoryIds = configuredIds(d.bridgeCategories)
  let complete = true
  const watchGuildIds = new Set<string>()
  const candidates: BridgeTextChannel[] = []
  const unresolvedCategoryIds = new Set<string>()
  const unresolvedLegacyIds = new Set<string>()
  for (const id of legacyIds) {
    const { channel, gone } = await fetchBridgeChannel(client, id)
    if (!channel) {
      if (gone) {
        unresolvedLegacyIds.add(id)
        warnOnce(id, `bridge channel ${id} is gone or not visible to the bot - not bridged`)
      } else complete = false
      continue
    }
    if (!isBridgeTextChannel(channel)) {
      unresolvedLegacyIds.add(id)
      warnOnce(id, `bridge channel ${id} is not a guild text/announcement channel - skipping`)
      continue
    }
    watchGuildIds.add(channel.guildId)
    candidates.push(channel)
  }
  for (const id of categoryIds) {
    const { channel, cached, gone } = await fetchBridgeChannel(client, id)
    if (!channel) {
      if (gone) {
        unresolvedCategoryIds.add(id)
        warnOnce(id, `bridge category ${id} is gone or not visible to the bot - its channels are not bridged`)
      } else complete = false
      continue
    }
    const category = channel as { type?: number; guild?: Guild }
    if (category.type !== ChannelType.GuildCategory || !category.guild) {
      unresolvedCategoryIds.add(id)
      warnOnce(id, `bridgeCategories entry ${id} is not a category channel - skipping`)
      continue
    }
    const guild = category.guild
    watchGuildIds.add(guild.id)
    // A category that wasn't cached: make sure its guild's channels are.
    if (!cached) await guild.channels.fetch().catch(() => { complete = false })
    for (const child of guild.channels.cache.values()) {
      if (child.parentId === id && isBridgeTextChannel(child)) candidates.push(child)
    }
  }
  const wanted = new Map<string, BridgeTextChannel>()
  const picked = resolveBridgedChannels(
    candidates.map((c) => ({ id: c.id, type: c.type as number, guildId: c.guildId, parentId: c.parentId ?? null, channel: c })),
    new Set(categoryIds),
    new Set(legacyIds),
  )
  for (const p of picked) wanted.set(p.id, p.channel)

  // Sidebar layout per guild: bridged channels + their categories.
  const entries: LayoutEntry[] = []
  const categoriesSeen = new Set<string>()
  for (const c of wanted.values()) {
    entries.push({
      id: c.id, guildId: c.guildId, kind: 'channel', name: c.name, topic: c.topic || '', position: c.position,
      type: c.type as number, parentId: c.parentId ?? null,
      // @everyone's view is part of the layout (it gates the fail-closed
      // fallback and guests' sidebar).
      overwrites: `${overwritesOf(c as unknown as OverwriteHolder)}|everyone=${everyoneViews(c) ? 1 : 0}`,
    })
    const parentId = c.parentId
    if (!parentId || categoriesSeen.has(parentId)) continue
    categoriesSeen.add(parentId)
    const parent = c.guild.channels.cache.get(parentId) as unknown as ({ name: string; position: number } & OverwriteHolder) | undefined
    if (parent) {
      entries.push({
        id: parentId, guildId: c.guildId, kind: 'category', name: parent.name, position: parent.position,
        type: CATEGORY_CHANNEL_TYPE, parentId: null, overwrites: overwritesOf(parent),
      })
    }
  }
  return { wanted, watchGuildIds, complete, unresolvedCategoryIds, unresolvedLegacyIds, layout: layoutSignatures(entries) }
}

// Apply the resolved set: upsert + webhook every bridged channel (re-enabling
// a previously disabled row), drop + disable everything else (rows, webhooks
// and history are kept), refresh the bridged guild set, and emit
// `bridge.channels.changed { guildId }` for every guild whose bridged set or
// layout changed (the app server drops that guild's snapshot + rail cache;
// clients refetch guilds + that guild's channels). Serialized.
let bridgeSetChain: Promise<void> = Promise.resolve()
function applyBridgeSet(client: Client, reason: string): Promise<void> {
  bridgeSetChain = bridgeSetChain
    .then(() => applyBridgeSetOnce(client, reason))
    .catch((error) => {
      console.error(`[abulxt-discord] bridge channel sync (${reason}) failed:`, error instanceof Error ? error.message : error)
    })
  return bridgeSetChain
}

let bridgeSetTimer: NodeJS.Timeout | null = null
// Channel/guild gateway events arrive in bursts (a category move fires one
// CHANNEL_UPDATE per channel): coalesce them into one resolution.
function scheduleBridgeSet(client: Client, reason: string): void {
  if (bridgeSetTimer) clearTimeout(bridgeSetTimer)
  bridgeSetTimer = setTimeout(() => {
    bridgeSetTimer = null
    void applyBridgeSet(client, reason)
  }, 1500)
  bridgeSetTimer.unref?.()
}

async function applyBridgeSetOnce(client: Client, reason: string): Promise<void> {
  const rt = runtime
  if (!rt) return
  const res = await resolveBridgeSet(client)
  if (runtime !== rt) return
  const added: BridgeTextChannel[] = []
  for (const channel of res.wanted.values()) {
    const isNew = !rt.channels.has(channel.id)
    rt.channels.set(channel.id, channel)
    await bridge.upsertChannel({
      channelId: channel.id,
      guildId: channel.guildId,
      name: channel.name,
      topic: channel.topic || '',
      position: channel.position,
      parentId: channel.parentId ?? null,
      everyoneCanView: everyoneViews(channel),
    }).catch((error) => {
      console.error(`[abulxt-discord] failed to store bridge channel #${channel.name}:`, error instanceof Error ? error.message : error)
    })
    await ensureWebhook(channel)
    if (isNew) added.push(channel)
  }
  const disabledGuilds = new Set<string>()
  const removed: string[] = []
  if (res.complete) {
    const kept = new Set<string>()
    for (const row of await bridge.listChannels(true).catch(() => [] as bridge.BridgeChannel[])) {
      if (res.wanted.has(row.channelId)) continue
      // A configured category / legacy id that didn't resolve (typo, foreign
      // or deleted id) must not silently un-bridge what sits under it.
      if (protectedFromDisable(row, res.unresolvedCategoryIds, res.unresolvedLegacyIds)) {
        kept.add(row.channelId)
        const id = res.unresolvedLegacyIds.has(row.channelId) ? row.channelId : row.parentId
        console.error(`[abulxt-discord] NOT disabling #${row.name || row.channelId}: configured ${res.unresolvedLegacyIds.has(row.channelId) ? 'bridge channel' : 'bridge category'} ${id} did not resolve - fix or remove it in config.discord`)
        continue
      }
      if (await bridge.disableChannel(row.channelId).catch(() => false)) {
        disabledGuilds.add(row.guildId)
        removed.push(`#${row.name || row.channelId}`)
      }
    }
    // Stop mirroring what was disabled (protected rows stay bridged).
    for (const id of [...rt.channels.keys()]) {
      if (res.wanted.has(id) || kept.has(id)) continue
      rt.channels.delete(id)
      rt.webhooks.get(id)?.destroy()
      rt.webhooks.delete(id)
    }
  } else {
    console.warn(`[abulxt-discord] bridge channel sync (${reason}): some configured channels/categories could not be fetched - nothing disabled this pass`)
  }
  const prevGuilds = rt.guildIds
  rt.guildIds = new Set([...rt.channels.values()].map((c) => c.guildId))
  rt.watchGuildIds = new Set([...res.watchGuildIds, ...rt.guildIds])
  const changed = new Set([...changedGuilds(rt.layout, res.layout), ...disabledGuilds])
  rt.layout = res.layout
  for (const guildId of changed) {
    await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.channels.changed', { guildId }).catch(() => {})
  }
  if (added.length || removed.length) {
    console.log(`[abulxt-discord] bridge channels (${reason}): +${added.length} ${added.map((c) => `#${c.name}`).join(' ')}${removed.length ? `, disabled ${removed.join(' ')}` : ''} - ${rt.channels.size} channel(s) in ${rt.guildIds.size} guild(s)`)
  }
  // Newly bridged guilds: seed their member/role directory (mention
  // autocomplete, role pills) and tell the service (command registration,
  // chat-role sync).
  const newGuilds = [...rt.guildIds].filter((g) => !prevGuilds.has(g))
  for (const guildId of newGuilds) {
    const guild = await client.guilds.fetch(guildId).catch(() => null)
    if (guild) await syncGuildDirectory(guild)
  }
  if (newGuilds.length || [...prevGuilds].some((g) => !rt.guildIds.has(g))) {
    try { rt.onGuildsChanged?.([...rt.guildIds]) } catch { /* best-effort */ }
  }
  // Channels bridged while running (created / moved in): backfill their
  // recent history like the startup reconcile does.
  if (reason !== 'startup') {
    for (const channel of added) {
      void reconcileChannel(rt, channel).catch((error) => {
        console.error(`[abulxt-discord] reconcile #${channel.name} crashed:`, error instanceof Error ? error.message : error)
      })
    }
  }
}

// `onGuildsChanged` fires with the bridged guild set whenever it changes
// (including the first resolution): discord-service registers /bridge there
// and re-syncs chat roles.
export async function startBridge(client: Client, opts: { onGuildsChanged?: (guildIds: string[]) => void } = {}): Promise<void> {
  const config = getConfig()
  const d = config.discord || {}
  const legacyIds = configuredIds(d.bridgeChannels)
  const categoryIds = configuredIds(d.bridgeCategories)
  if (!legacyIds.length && !categoryIds.length) {
    console.log('[abulxt-discord] discord.bridgeCategories / bridgeChannels not configured - site chatbox bridge disabled.')
    return
  }

  await startEventRelay()

  runtime = {
    client,
    guildIds: new Set(),
    watchGuildIds: new Set(),
    webhooks: new Map(),
    channels: new Map(),
    recentSends: new Map(),
    sweepTimer: null,
    dirSyncTimer: null,
    layout: new Map(),
    onGuildsChanged: opts.onGuildsChanged || null,
  }

  await applyBridgeSet(client, 'startup')
  if (!runtime.channels.size && !categoryIds.length) {
    console.error('[abulxt-discord] no usable bridge channels - site chatbox bridge disabled.')
    runtime = null
    return
  }
  console.log(`[abulxt-discord] bridging ${runtime.channels.size} channel(s) in ${runtime.guildIds.size} guild(s) to the site chatbox`)

  // Raw-only author cosmetics (display_name_styles) - see captureRawDisplayNameStyles.
  client.on('raw', (packet: { t?: string | null; d?: unknown }) => {
    try { if (runtime) captureRawDisplayNameStyles(packet, runtime.guildIds) } catch { /* never break the gateway */ }
  })

  await listenOutbox()
  // Reconcile each bridged channel with Discord's recent history (catches
  // deletions/edits/sends made while the bot was offline). Fire-and-forget:
  // startup never waits on it.
  void reconcileBridgedHistory().catch((error) => {
    console.error('[abulxt-discord] history reconcile crashed:', error instanceof Error ? error.message : error)
  })
  runtime.sweepTimer = setInterval(() => void outboxSweep().catch(() => {}), 15_000)
  runtime.sweepTimer.unref()

  // Periodic directory re-sync (hourly, every bridged guild) - covers
  // anything the gateway events missed (downtime, dropped events).
  runtime.dirSyncTimer = setInterval(() => {
    const rt = runtime
    if (!rt) return
    void (async () => {
      for (const guildId of rt.guildIds) {
        const guild = await rt.client.guilds.fetch(guildId).catch(() => null)
        if (guild) await syncGuildDirectory(guild)
      }
    })().catch(() => {})
  }, 60 * 60_000)
  runtime.dirSyncTimer.unref()

  // Bridged channel set follows Discord: channels created in / moved into a
  // bridged category are bridged; moved out (and not a legacy channel) or
  // deleted are disabled; renames / reorders / overwrite changes update the
  // layout. A guild joined or left re-resolves everything.
  const watched = (guildId: string | null | undefined): boolean =>
    Boolean(runtime && guildId && (runtime.watchGuildIds.has(guildId) || runtime.guildIds.has(guildId)))
  const channelGuild = (channel: unknown): string | null => {
    const g = (channel as { guildId?: string | null } | null)?.guildId
    return typeof g === 'string' ? g : null
  }
  client.on('channelCreate', (channel) => {
    if (watched(channelGuild(channel))) scheduleBridgeSet(client, 'channel created')
  })
  client.on('channelUpdate', (_old, channel) => {
    if (watched(channelGuild(channel))) scheduleBridgeSet(client, 'channel updated')
  })
  client.on('channelDelete', (channel) => {
    if (watched(channelGuild(channel))) scheduleBridgeSet(client, 'channel deleted')
  })
  // @everyone's permissions feed everyone_can_view (the fail-closed
  // fallback gate): recompute on a change to that role.
  client.on('guildRoleUpdate', (_old, role) => {
    if (role.id === role.guild.id && watched(role.guild.id)) scheduleBridgeSet(client, '@everyone role updated')
  })
  client.on('guildCreate', () => scheduleBridgeSet(client, 'guild joined'))
  client.on('guildDelete', (guild) => {
    if (watched(guild.id)) scheduleBridgeSet(client, 'guild left')
  })

  // Only bridged channels are mirrored (unbridged channels are no longer
  // read live: nothing is persisted or broadcast for them).
  client.on('messageCreate', async (message) => {
    if (!runtime || !runtime.channels.has(message.channelId)) return
    // Ignore our own webhook deliveries (they are already persisted as
    // direction 'web') and bot chatter.
    if (message.webhookId) {
      const hook = runtime.webhooks.get(message.channelId)
      if (hook && message.webhookId === hook.id) return
    }
    const ownReply = isOwnBotReply(message, runtime.client.user?.id)
    if (message.author.bot && !message.webhookId && !ownReply) return

    if (!message.webhookId && !ownReply) {
      // Bans/timeouts target the WEBHOOK identity: a Discord author whose
      // linked site account is banned (or timed out here) is covered too.
      const { activeTimeout, resolveWebhookTarget } = await import('./discord-chat-perms.js')
      const { webhookBanFor } = await import('./discord-chat-moderation.js')
      const author = await resolveWebhookTarget({ kind: 'discord', discordId: message.author.id }).catch(() => null)
      // Global bans plus this guild's own.
      const banned = author
        ? await webhookBanFor(author, message.guildId).catch(() => null)
        : await bridge.isBanned('discord', message.author.id, message.guildId)
      if (banned) {
        await message.delete().catch(() => {})
        await bridge.logModeration({
          actor: 'automod',
          action: 'delete',
          subject: `discord:${message.author.id}`,
          reason: `banned user posted: ${banned}`,
          meta: { channelId: message.channelId, content: message.content.slice(0, 500) },
          guildId: message.guildId,
        })
        return
      }
      // A Discord author timed out in this bridged channel - directly or
      // through their linked site account - can't post here from Discord.
      const timeout = author ? await activeTimeout(message.channelId, author).catch(() => null) : null
      if (timeout) {
        await message.delete().catch(() => {})
        await bridge.logModeration({
          actor: 'automod',
          action: 'delete',
          subject: `discord:${message.author.id}`,
          reason: `timed-out webhook posted (until ${timeout.timeoutUntil})`,
          meta: { channelId: message.channelId, content: message.content.slice(0, 500) },
          guildId: message.guildId,
        })
        return
      }
      if (isSpam(runtime, message)) {
        await message.delete().catch(() => {})
        const member = message.member
        if (member) {
          await member.timeout(5 * 60_000, 'automod: spam in bridged channel').catch(() => {})
        }
        await bridge.logModeration({
          actor: 'automod',
          action: 'timeout',
          subject: `discord:${message.author.id}`,
          reason: 'spam in bridged channel',
          meta: { channelId: message.channelId },
          guildId: message.guildId,
        })
        return
      }
    }

    await persistDiscordMessage(message).catch((error) => {
      console.error('[abulxt-discord] failed to persist bridged message:', error instanceof Error ? error.message : error)
    })
    // Refresh the author's directory cosmetics (decoration / server tag /
    // roles) from the message's member - cheap, and catches profile changes
    // between member-update events.
    if (message.member && !message.webhookId) {
      void bridge.upsertGuildMember(memberInput(message.member)).catch(() => {})
    }
  })

  client.on('messageUpdate', async (_old, message) => {
    if (!runtime || !runtime.channels.has(message.channelId)) return
    const full = message.partial ? await message.fetch().catch(() => null) : message
    if (!full) return
    // Web-originated rows are authoritative in the DB: the MESSAGE_UPDATE for
    // our own webhook delivery is either Discord resolving its link embed /
    // reply reference (edited_timestamp null) or the echo of a web edit the
    // edit endpoint already persisted + broadcast. Mirroring it would stamp
    // edited_at on a fresh send - the "(edited)" on every new webhook
    // message/reply bug - and clobber the site's own unfurl embeds.
    let stored = await bridge.byDiscordMessageId(full.id)
    if (!stored && full.webhookId && runtime.webhooks.get(full.channelId)?.id === full.webhookId) {
      // Our own webhook delivery: Discord's embed MESSAGE_UPDATE can land
      // before deliverWebMessageOnce() has stored the snowflake. Give the
      // attach a moment instead of dropping Discord's embeds.
      await new Promise((resolve) => setTimeout(resolve, 1500))
      stored = await bridge.byDiscordMessageId(full.id)
    }
    if (!stored) return
    if (stored.direction === 'web') {
      // Adopt Discord's own unfurl of the webhook delivery (embeds ONLY - the
      // content/edited_at stay as the web edit endpoint wrote them). Discord's
      // embeds are the 1:1 source of truth and carry media-proxy URLs. An
      // empty embed list only clears ours once the content no longer links
      // anywhere (a mid-edit update can momentarily carry [] before Discord
      // re-resolves).
      // Embeds removed on Discord (SUPPRESS_EMBEDS, e.g. by a moderator in the
      // Discord app): mirror the suppression onto the row.
      if ((full.flags.bitfield & 4) !== 0) {
        if (((stored.flags ?? 0) & 4) !== 0) return
        const suppressed = await bridge.suppressEmbedsById(stored.id).catch(() => null)
        if (suppressed) {
          await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.message.edited', { message: suppressed, embedOnly: true }).catch(() => {})
        }
        return
      }
      const next = embedPayload(full)
      if (next.length === 0 && messageLinks(stored.content).length > 0) return
      const updated = await bridge.setEmbedsByDiscordMessageId(full.id, next).catch(() => null)
      if (updated) {
        await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.message.edited', { message: updated, embedOnly: true }).catch(() => {})
      }
      return
    }
    // Discord fires MESSAGE_UPDATE for embed resolution too; only a non-null
    // edited_timestamp is a real edit. Completing a deferred interaction
    // response (the "is thinking..." LOADING message) isn't an edit either -
    // Discord shows no "(edited)" on it.
    const wasLoading = ((stored.flags ?? 0) & MessageFlag.LOADING) !== 0
    const edited = !wasLoading && full.editedTimestamp !== null && full.editedTimestamp !== undefined
    const fullAttachments = attachmentPayload(full)
    const ix = interactionPayload(full, fullAttachments)
    await bridge.setInteractionFields(full.id, { components: ix.components, flags: ix.flags }).catch(() => {})
    const updated = await bridge.editByDiscordMessageId(full.id, full.content, {
      edited,
      editedAt: edited ? new Date(full.editedTimestamp!) : null,
      embeds: embedPayload(full),
      attachments: fullAttachments.filter((a) => !ix.usedAttachmentUrls.has(a.url)),
    })
    if (updated) {
      await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.message.edited', edited || wasLoading ? { message: updated } : { message: updated, embedOnly: true })
    }
  })

  client.on('messageDelete', async (message) => {
    if (!runtime || !runtime.channels.has(message.channelId)) return
    const deleted = await bridge.deleteByDiscordMessageId(message.id)
    if (deleted) {
      await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.message.deleted', {
        id: deleted.id,
        channelId: deleted.channelId,
        discordMessageId: deleted.discordMessageId,
      })
    }
  })

  // Discord-side reactions. A real Discord user (or another bot) reacting is
  // recorded under `discord:<id>`; the bridge bot's own reaction is ignored (it
  // never counts). Webhook deliveries' reactions come from Discord users too.
  client.on('messageReactionAdd', async (reaction, user) => {
    if (!runtime || !runtime.channels.has(reaction.message.channelId)) return
    if (user.id === runtime.client.user?.id) return // the bridge bot's own reaction
    const message = await bridge.byDiscordMessageId(reaction.message.id)
    if (!message) return
    const emoji = reaction.emoji.name || String(reaction.emoji.id || '')
    if (!emoji) return
    await bridge.addReaction(message.id, emoji, `discord:${user.id}`).catch(() => {})
    const reactions = await bridge.reactionsFor(message.id)
    await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.reaction', {
      messageId: message.id,
      channelId: message.channelId,
      emoji,
      reactions,
    })
  })

  client.on('messageReactionRemove', async (reaction, user) => {
    if (!runtime || !runtime.channels.has(reaction.message.channelId)) return
    if (user.id === runtime.client.user?.id) return
    const message = await bridge.byDiscordMessageId(reaction.message.id)
    if (!message) return
    const emoji = reaction.emoji.name || String(reaction.emoji.id || '')
    if (!emoji) return
    await bridge.removeReaction(message.id, emoji, `discord:${user.id}`).catch(() => {})
    const reactions = await bridge.reactionsFor(message.id)
    await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.reaction', {
      messageId: message.id,
      channelId: message.channelId,
      emoji,
      reactions,
    })
  })

  // Directory freshness: member and role lifecycle events keep the bridge
  // directory tables in step with the guild between full startup syncs.
  client.on('guildMemberAdd', (member) => {
    if (!runtime || !runtime.guildIds.has(member.guild.id)) return
    void bridge.upsertGuildMember(memberInput(member)).catch((error) => {
      console.error('[abulxt-discord] directory member-add failed:', error instanceof Error ? error.message : error)
    })
  })

  client.on('guildMemberRemove', (member) => {
    if (!runtime || !runtime.guildIds.has(member.guild.id)) return
    void bridge.removeGuildMember(member.guild.id, member.id).catch((error) => {
      console.error('[abulxt-discord] directory member-remove failed:', error instanceof Error ? error.message : error)
    })
  })

  client.on('guildMemberUpdate', (_oldMember, newMember) => {
    if (!runtime || !runtime.guildIds.has(newMember.guild.id)) return
    void bridge.upsertGuildMember(memberInput(newMember)).catch((error) => {
      console.error('[abulxt-discord] directory member-update failed:', error instanceof Error ? error.message : error)
    })
  })

  client.on('guildRoleCreate', (role) => {
    if (!runtime || !runtime.guildIds.has(role.guild.id)) return
    void bridge.upsertGuildRole(roleInput(role)).catch((error) => {
      console.error('[abulxt-discord] directory role-create failed:', error instanceof Error ? error.message : error)
    })
  })

  client.on('guildRoleUpdate', (_oldRole, newRole) => {
    if (!runtime || !runtime.guildIds.has(newRole.guild.id)) return
    void bridge.upsertGuildRole(roleInput(newRole)).catch((error) => {
      console.error('[abulxt-discord] directory role-update failed:', error instanceof Error ? error.message : error)
    })
  })

  client.on('guildRoleDelete', (role) => {
    if (!runtime || !runtime.guildIds.has(role.guild.id)) return
    // No dedicated removeGuildRole helper: syncGuildRoles replaces the guild's
    // role set (upserting the given roles and deleting any stored role not in
    // the list), which drops the deleted row.
    void role.guild.roles
      .fetch()
      .then((roles: { values(): Iterable<Parameters<typeof roleInput>[0]> }) => bridge.syncGuildRoles(role.guild.id, Array.from(roles.values(), roleInput)))
      .catch((error: unknown) => {
        console.error('[abulxt-discord] directory role-delete failed:', error instanceof Error ? error.message : error)
      })
  })
}
