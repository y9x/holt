import { apiUrl } from './api-base'
import { apiFetchQueued } from './api-fetch'
import { cryptoFetch } from './api-crypto-fetch'
import { getAuthToken } from './auth-api'
import { routeBucket, type RateLimitOptions } from './rate-limit-queue'

export interface BridgeChannel {
  channelId: string
  name: string
  topic: string
  position: number
  locked?: boolean
  // Whether this guild text channel is bridged to the web chat. The /channels
  // endpoint returns ALL guild text channels; `bridged: true` channels have
  // history and can be sent to, while `false` ones are browsable (read-only)
  // on the web - their /history and /send routes 404. Optional so older
  // payloads (which only returned bridged channels) typecheck; treat any value
  // other than an explicit `false` as bridged.
  bridged?: boolean
  // Discord channel type (0 text, 5 announcement) and parent category id
  // (null = uncategorized). The server returns channels in Discord's exact
  // sidebar order and only the ones the caller can VIEW on Discord.
  type?: number
  parentId?: string | null
  // The guild this channel belongs to (multi-guild bridge; always present on
  // current payloads, optional so older ones typecheck).
  guildId?: string
  // Id of the newest non-deleted bridge message in the channel (null = none):
  // seeds the unread badge for channels this client hasn't opened.
  lastMessageId?: number | null
}

// A guild category (Discord channel type 4) with at least one visible channel.
export interface BridgeCategory {
  id: string
  name: string
  position: number
}

export interface BridgeMessage {
  id: number
  channelId: string
  direction: 'discord' | 'web'
  discordMessageId: string | null
  authorKey: string
  authorName: string
  authorAvatar: string | null
  authorColor: string | null
  authorRole: 'mod' | 'admin' | 'owner' | null
  // Discord APP tag: a Discord-originated message from a bot/webhook author.
  // Optional so older payloads typecheck; web (direction 'web') messages are
  // webhook deliveries and always tagged.
  authorBot?: boolean
  content: string
  attachments: BridgeAttachment[]
  embeds: Array<Record<string, unknown>>
  // `inert`: a mention neutralized by the server's ping limits - it still
  // renders as a chip but pings nobody (Discord's non-pinging mention), so it
  // never highlights or counts toward mention badges.
  mentions: Array<{ type: string; id: string; username?: string; name?: string; inert?: boolean }>
  replyTo: string | null
  // Reply "@ ON/OFF": false = a quiet reply that doesn't ping/highlight the
  // replied-to author. Optional (absent on older payloads = true).
  replyMention?: boolean
  clientId: string | null
  createdAt: string
  editedAt: string | null
  deletedAt: string | null
  reactions: BridgeReaction[]
  // Discord forward snapshot: present on forwarded messages (content is then
  // empty). Rendered under the "Forwarded" header; its mentions never ping.
  // Optional so older payloads typecheck.
  forwarded?: BridgeForwardSnapshot | null
  // Application commands + message components (server discord-interactions.ts).
  // messageType: Discord message type (20 slash command, 23 context-menu
  // command). interaction: the "{user} used /cmd" header data. components:
  // normalized V1 action rows / V2 layout tree. flags: Discord message flags
  // (LOADING = "is thinking...", IS_COMPONENTS_V2). All optional (older
  // payloads and web rows omit them).
  messageType?: number
  interaction?: BridgeInteraction | null
  components?: BridgeComponent[]
  flags?: number
  // Client-only (never sent by the server): Discord's SEND_FAILED message
  // state for an own optimistic row whose /send failed. Rendered red with
  // Retry / Delete; kept for the session only.
  sendState?: 'failed'
}

export interface BridgeInteraction {
  type: number
  commandType: number | null
  name: string | null
  userId: string
  userName: string
  userAvatar: string | null
  userColor: string | null
}

export interface BridgeComponentEmoji { id: string | null; name: string | null; animated?: boolean }
export interface BridgeComponentMedia { url: string; contentType?: string | null; width?: number | null; height?: number | null; name?: string | null; size?: number | null }

// Normalized Discord component (see server cleanComponent). `type` follows
// Discord: 1 action row, 2 button, 3/5/6/7/8 selects, 9 section, 10 text
// display, 11 thumbnail, 12 media gallery, 13 file, 14 separator, 17 container.
export interface BridgeComponent {
  type: number
  components?: BridgeComponent[]
  // button
  style?: number
  label?: string | null
  emoji?: BridgeComponentEmoji | null
  url?: string | null
  disabled?: boolean
  skuId?: string | null
  // selects
  placeholder?: string | null
  minValues?: number
  maxValues?: number
  options?: Array<{ label: string; description?: string | null; emoji?: BridgeComponentEmoji | null; default?: boolean }>
  defaultCount?: number
  // section
  accessory?: BridgeComponent | null
  // text display
  content?: string
  // thumbnail / file
  media?: BridgeComponentMedia | null
  file?: BridgeComponentMedia | null
  description?: string | null
  spoiler?: boolean
  name?: string | null
  size?: number | null
  // media gallery
  items?: Array<{ media: BridgeComponentMedia | null; description?: string | null; spoiler?: boolean }>
  // separator
  divider?: boolean
  spacing?: number
  // container
  accentColor?: number | null
}

// A persisted Discord attachment (server/discord-media.ts BridgeAttachment).
// Older rows carry only { url, name, contentType, width, height }, so every
// newer field is optional.
export interface BridgeAttachment {
  id?: string | null
  url?: string
  proxyUrl?: string | null
  name?: string
  title?: string | null
  description?: string | null
  contentType?: string | null
  size?: number
  width?: number | null
  height?: number | null
  durationSecs?: number | null
  waveform?: string | null
  flags?: number
  spoiler?: boolean
  isRemix?: boolean
  ephemeral?: boolean
}

export interface BridgeForwardSnapshot {
  content: string
  attachments: BridgeMessage['attachments']
  embeds: BridgeMessage['embeds']
  mentions: BridgeMessage['mentions']
  createdAt: string | null
  channelId: string | null
  messageId: string | null
  guildId: string | null
  components?: BridgeComponent[]
}

export interface BridgeReaction {
  emoji: string
  count: number
  reactorKeys: string[]
}

const base = apiUrl('/api/discord/bridge')

// Thrown for a failed bridge request. `rateLimited` = a 429 we gave up waiting
// on (or dropped); its message is deliberately generic - like Discord, the UI
// never shows rate-limit errors, only the action's normal failure state.
export type BridgeRequestError = Error & { status?: number; code?: number; rateLimited?: boolean; requiresVerification?: boolean }

async function toJson(response: Response, fallback: string): Promise<Record<string, unknown>> {
  const data = await response.json().catch(() => ({})) as Record<string, unknown> & { error?: string; requiresVerification?: boolean }
  if (!response.ok) {
    const rateLimited = response.status === 429
    const err = new Error(rateLimited ? fallback : typeof data.error === 'string' ? data.error : fallback) as BridgeRequestError
    err.status = response.status
    if (typeof data.code === 'number' && !rateLimited) err.code = data.code
    if (rateLimited) err.rateLimited = true
    if (data.requiresVerification) err.requiresVerification = true
    throw err
  }
  return data
}

// Every bridge call goes through the Discord-style rate-limit queue
// (apiFetchQueued): 429s are waited out and retried in route-bucket order.
async function request<T>(path: string, options: RequestInit = {}, rl: RateLimitOptions = {}): Promise<T> {
  const response = await apiFetchQueued(`${base}${path}`, options, rl)
  return await toJson(response, 'Request failed') as T
}

export interface BridgeChannelsResult {
  configured: boolean
  categories: BridgeCategory[]
  channels: BridgeChannel[]
}

// Sealed read-only GETs (`guilds`, `channels`): fetched through cryptoFetch
// (transparent decrypt) with the same bearer token apiFetch would attach.
// GETs carry no captcha headers, so the token is the whole identity.
async function sealedRequest<T>(path: string, fallback: string): Promise<T> {
  const token = getAuthToken()
  const response = await cryptoFetch(`${base}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {})
  return await toJson(response, fallback) as T
}

/** One guild's sidebar (guild REQUIRED; every channel is bridged and carries
 *  `guildId` + `lastMessageId`). */
export async function bridgeChannels(guildId: string): Promise<BridgeChannelsResult> {
  const data = await sealedRequest<{ configured?: boolean; categories?: BridgeCategory[]; channels?: BridgeChannel[] }>(`/channels?guild=${encodeURIComponent(guildId)}`, 'Failed to load channels')
  const channels = Array.isArray(data.channels) ? data.channels.map((c) => (c.guildId ? c : { ...c, guildId })) : []
  return { configured: data.configured !== false, categories: Array.isArray(data.categories) ? data.categories : [], channels }
}

// One history page. Unbridged channels are read live from Discord (`live`);
// their pages carry `hasMore` (Discord page was full) and `nextBefore` (the
// cursor past the oldest Discord message, which may be a skipped system
// message) so paging works even when rows were filtered out.
export interface BridgeHistoryPage {
  messages: BridgeMessage[]
  live: boolean
  // Legacy alias of hasMoreBefore.
  hasMore: boolean | null
  // Discord's ChannelMessages edge flags for this page: older / newer
  // messages exist past it (null = server didn't say).
  hasMoreBefore: boolean | null
  hasMoreAfter: boolean | null
  nextBefore: number | null
  nextAfter: number | null
  // `around` target not found (deleted, or an unknown reply reference).
  missing: boolean
}

// One cursor per request, like Discord's GET /channels/{id}/messages:
// `before` / `after` page away from a message id, `around` centers on one
// (a bridge id, live id or raw Discord snowflake). None = the newest page.
export interface BridgeHistoryCursor {
  before?: number | null
  after?: number | null
  around?: number | string | null
}

// `signal` cancels the request - including a rate-limit wait - e.g. when the
// user switches channels before the page lands.
export async function bridgeHistoryWindow(channelId: string, cursor: BridgeHistoryCursor = {}, limit = 50, signal?: AbortSignal): Promise<BridgeHistoryPage> {
  const params = new URLSearchParams({ channel: channelId, limit: String(limit) })
  if (cursor.around) params.set('around', String(cursor.around))
  else if (cursor.after) params.set('after', String(cursor.after))
  else if (cursor.before) params.set('before', String(cursor.before))
  const data = await request<{
    messages: BridgeMessage[]
    live?: boolean
    hasMore?: boolean
    hasMoreBefore?: boolean
    hasMoreAfter?: boolean
    nextBefore?: number | null
    nextAfter?: number | null
    missing?: boolean
  }>(`/history?${params}`, {}, { signal })
  const hasMoreBefore = typeof data.hasMoreBefore === 'boolean' ? data.hasMoreBefore : typeof data.hasMore === 'boolean' ? data.hasMore : null
  return {
    messages: Array.isArray(data.messages) ? data.messages : [],
    live: data.live === true,
    hasMore: hasMoreBefore,
    hasMoreBefore,
    hasMoreAfter: typeof data.hasMoreAfter === 'boolean' ? data.hasMoreAfter : null,
    nextBefore: typeof data.nextBefore === 'number' ? data.nextBefore : null,
    nextAfter: typeof data.nextAfter === 'number' ? data.nextAfter : null,
    missing: data.missing === true,
  }
}

export async function bridgeHistoryPage(channelId: string, before?: number, limit = 50, signal?: AbortSignal): Promise<BridgeHistoryPage> {
  return bridgeHistoryWindow(channelId, { before }, limit, signal)
}

export async function bridgeHistory(channelId: string, before?: number, limit = 50): Promise<BridgeMessage[]> {
  const params = new URLSearchParams({ channel: channelId, limit: String(limit) })
  if (before) params.set('before', String(before))
  const data = await request<{ messages: BridgeMessage[] }>(`/history?${params}`)
  return data.messages
}

// replyMention mirrors Discord's reply-bar "@ ON/OFF" switch (allowed_mentions
// .replied_user); only sent when a reply is armed and the switch is OFF.
export async function bridgeSend(channelId: string, content: string, clientId: string, replyTo?: string | null, replyMention?: boolean): Promise<BridgeMessage> {
  const data = await request<{ message: BridgeMessage }>('/send', {
    method: 'POST',
    body: JSON.stringify({ channelId, content, clientId, ...(replyTo ? { replyTo } : {}), ...(replyTo && replyMention === false ? { replyMention: false } : {}) }),
  })
  return data.message
}

// Typing pings are dropped (never queued or retried) while rate limited, like
// Discord's client - the next keystroke sends a fresh one.
export async function bridgeTyping(channelId: string): Promise<void> {
  await request('/typing', { method: 'POST', body: JSON.stringify({ channelId }) }, { dropWhenLimited: true }).catch(() => {})
}

// Forward a message into a bridged channel (Discord's Forward action). The
// server stores a snapshot of the source and delivers it via the webhook.
export async function bridgeForward(messageId: number, channelId: string, clientId: string): Promise<BridgeMessage> {
  // Shares the send bucket (the server limits /send + /forward together), so
  // forwards and sends land in the order they were made.
  const data = await request<{ message: BridgeMessage }>('/forward', {
    method: 'POST',
    body: JSON.stringify({ messageId, channelId, clientId }),
  }, { bucket: routeBucket('POST', `${base}/send`) })
  return data.message
}

export async function bridgeEdit(messageId: number, content: string): Promise<BridgeMessage> {
  const data = await request<{ message: BridgeMessage }>('/edit', {
    method: 'POST',
    body: JSON.stringify({ messageId, content }),
  })
  return data.message
}

export interface BridgeReactResult {
  messageId: number
  emoji: string
  reactions: BridgeReaction[]
  reacted: boolean
}

export async function bridgeReact(messageId: number, emoji: string): Promise<BridgeReactResult> {
  return request<BridgeReactResult>('/react', {
    method: 'POST',
    body: JSON.stringify({ messageId, emoji }),
  })
}

export interface BridgeDeleteResult {
  ok: boolean
  messageId: number
  direction: 'discord' | 'web'
  discordMessageId: string | null
}

// Remove a message's embeds (Discord's SUPPRESS_EMBEDS).
export async function bridgeSuppressEmbeds(messageId: number): Promise<{ message: BridgeMessage }> {
  return request<{ message: BridgeMessage }>('/suppress-embeds', {
    method: 'POST',
    body: JSON.stringify({ messageId }),
  })
}

export async function bridgeDelete(messageId: number): Promise<BridgeDeleteResult> {
  return request<BridgeDeleteResult>('/delete', {
    method: 'POST',
    body: JSON.stringify({ messageId }),
  })
}

export interface BridgeGuild {
  id: string
  name: string
  icon: string | null
  /** Guild banner CDN url (sidebar banner), or null when none is configured. */
  banner?: string | null
  /** Server Boost level 0-3 (Discord premium_tier). */
  premiumTier?: number
  /** Active Server Boost count (Discord premium_subscription_count). */
  premiumSubscriptionCount?: number
  /** Discord guild feature flags (COMMUNITY, DISCOVERABLE, VERIFIED, …). */
  features?: string[]
  /** Discord rules_channel_id - rendered with the BookCheck icon. */
  rulesChannelId?: string | null
  /** `https://discord.gg/<vanity>` when the guild has a vanity code, else null. */
  inviteUrl?: string | null
}

/** Every bridged guild in which the caller can VIEW at least one channel. */
export async function bridgeGuilds(): Promise<BridgeGuild[]> {
  const data = await sealedRequest<{ guilds?: BridgeGuild[] }>('/guilds', 'Failed to load channels')
  return Array.isArray(data.guilds) ? data.guilds : []
}

// Moderate a WEBHOOK identity. `target` is the author key of any message
// ('user:<siteId>' for web authors - linked or not - or 'discord:<id>' for
// Discord authors) or a bare Discord snowflake. Actions: timeout {seconds,
// reason}, untimeout, ban {reason}, unban, webhook-perm {allow, deny} (a
// per-channel member overwrite), lockdown {locked} (channel-scoped; target
// ignored).
export async function bridgeModerate(action: string, channelId: string, target: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>('/moderate', {
    method: 'POST',
    body: JSON.stringify({ action, channelId, target, ...extra }),
  })
}

// The caller's moderation view of one webhook in a channel (server `target`
// route): which actions they may take (bits + role hierarchy + not-self) and
// the target's current timeout / ban / member overwrite (staff only).
export interface BridgeModTarget {
  key: string
  keys: string[]
  userId: number | null
  discordId: string | null
  name: string
  tier: BridgePerms['tier']
  position: number
  canTimeout: boolean
  canUntimeout: boolean
  canBan: boolean
  canUnban: boolean
  canManageWebhook: boolean
  timeout: { timeoutUntil: string; reason: string; issuedByName: string } | null
  banned: string | null
  overwrite: { allow: string; deny: string } | null
  /** Staff-only ping-limit counters (in-memory, since the app server started). Absent on older servers. */
  mentionLimit?: { neutralized: number; blocked: number; lastAt: string | null } | null
}

export async function bridgeModTarget(channelId: string, target: string): Promise<BridgeModTarget> {
  return request<BridgeModTarget>(`/target?channel=${encodeURIComponent(channelId)}&target=${encodeURIComponent(target)}`)
}

// Chat permission bits (server discord-chat-perms.ts Perm) used by the
// per-channel webhook overwrite toggles.
export const ChatPermBit = {
  VIEW_MESSAGES: 1n,
  SEND_MESSAGES: 2n,
  ADD_REACTIONS: 64n,
} as const

export interface BridgePerms {
  tier: 'guest' | 'member' | 'mod' | 'admin' | 'owner'
  roleId: string | null
  roleName: string | null
  color: string | null
  permissions: string
  // Every guild role id the viewer holds (not just their top chat role) so
  // role mentions highlight for any held role. Absent on older servers.
  guildRoleIds?: string[]
  locked?: boolean
  ownerKey?: string
  /** Discord hierarchy position of the caller's top chat role. */
  position?: number
  /** Every webhook key the caller appears under ('user:<id>', 'discord:<id>'). */
  webhookKeys?: string[]
  canView: boolean
  canSend: boolean
  // Email is unverified and this channel would otherwise allow sending.
  sendBlockedByEmail?: boolean
  emailVerified?: boolean | null
  // ADD_REACTIONS for this channel (timeout-reduced). Absent on older servers.
  canReact?: boolean
  canTimeout: boolean
  canBan: boolean
  canManageWebhook: boolean
  canMentionEveryone: boolean
  canMentionRoles: boolean
  canSendEmbeds: boolean
  /** Who may remove embeds (Discord's hover X) in this channel. */
  embedSuppress?: BridgeEmbedSuppressPolicy
  /** Active chatbox ban reason (site account, linked Discord, or IP). */
  banned?: string | null
  timeout: { timeoutUntil: string; reason: string; issuedByName: string } | null
}

export interface BridgeEmbedSuppressPolicy {
  bridged: boolean
  /** MANAGE_WEBHOOKS / BAN_WEBHOOKS: may remove anyone's embeds. */
  staff: boolean
  /** The bot holds MANAGE_MESSAGES here (needed for Discord-originated rows). */
  botManageMessages: boolean
  /** Author keys that are the caller (web owner key + linked discord:<id>). */
  selfKeys: string[]
}

export async function bridgePerms(channelId: string): Promise<BridgePerms> {
  return request<BridgePerms>(`/perms?channel=${encodeURIComponent(channelId)}`)
}

/** Guild-level perms (no channel): the caller's roles in that guild - used
 *  for role-mention counting in guilds that aren't open. */
export async function bridgeGuildPerms(guildId: string): Promise<BridgePerms> {
  return request<BridgePerms>(`/perms?guild=${encodeURIComponent(guildId)}`)
}

export interface BridgeMemberSuggestion {
  userId: string
  username: string
  displayName: string
  avatar: string | null
}

export interface BridgeRoleSuggestion {
  roleId: string
  name: string
  color: string | null
  // Enhanced role colors (gradient / holographic); absent/null = solid.
  colors?: BridgeRoleColors | null
}

// Discord enhanced role colors: secondary = gradient role style, tertiary =
// holographic. Hex strings ('#rrggbb').
export interface BridgeRoleColors {
  primary: string
  secondary: string
  tertiary: string | null
}

// Discord-side author cosmetics a bot can read (server `authors` endpoint,
// and `style` on the profile payload). Web authors ('user:<siteId>' keys) get
// only their effective roles' color/colors; null for unknown authors.
export interface BridgeAuthorStyle {
  color: string | null
  colors: BridgeRoleColors | null
  decoration: { asset: string; skuId: string | null } | null
  nameplate: { asset: string; palette: string | null; label: string | null; skuId: string | null } | null
  guildTag: { guildId: string; tag: string; badge: string | null } | null
  fontId: number | null
  joinedAt: string | null
  rejoined: boolean
  bot: boolean
}

// Batch author-style lookup for Discord user ids (max 100 per call).
export async function bridgeAuthors(channelId: string, ids: string[]): Promise<Record<string, BridgeAuthorStyle | null>> {
  const params = new URLSearchParams({ channel: channelId, ids: ids.join(',') })
  const data = await request<{ authors?: Record<string, BridgeAuthorStyle | null> }>(`/authors?${params}`)
  return data.authors || {}
}

export interface BridgeChannelSuggestion {
  channelId: string
  name: string
}

export interface BridgeMembersResult {
  members: BridgeMemberSuggestion[]
  roles: BridgeRoleSuggestion[]
  channels: BridgeChannelSuggestion[]
}

// Member/role/channel suggestions for the composer's @mention autocomplete. The
// server matches the query against usernames, display names, and role names in
// the channel's guild, plus the bridge's own channel names (the '#' trigger),
// and returns capped lists (already ranked server-side).
export async function bridgeMembers(channelId: string, q: string, limit = 8): Promise<BridgeMembersResult> {
  const params = new URLSearchParams({ channel: channelId, q, limit: String(limit) })
  const data = await request<{ members?: BridgeMemberSuggestion[]; roles?: BridgeRoleSuggestion[]; channels?: BridgeChannelSuggestion[] }>(`/members?${params}`)
  return { members: data.members || [], roles: data.roles || [], channels: data.channels || [] }
}

export interface BridgeExpressions {
  provider: 'klipy'
  canSendEmbeds: boolean
  klipyKey: string | null
}

export async function bridgeExpressions(channelId: string): Promise<BridgeExpressions> {
  return request<BridgeExpressions>(`/expressions?channel=${encodeURIComponent(channelId)}`)
}

// Discord bite-size profile popout data for a Discord-side user (see the
// server's `profile` endpoint). Webhook (web) authors have no entry.
export interface BridgeProfile {
  userId: string
  username: string
  globalName: string | null
  displayName: string
  avatar: string
  banner: string | null
  accentColor: string | null
  bot: boolean
  createdAt: string
  joinedAt: string | null
  inGuild: boolean
  roles: Array<{ roleId: string; name: string; color: string | null; colors?: BridgeRoleColors | null }>
  style?: BridgeAuthorStyle | null
}

// Profile popout data for a web (webhook) identity (server `webhook-profile`,
// key 'user:<siteId>' or 'self'): site-side fields only - never a Discord
// id/date/avatar - plus the roles it EFFECTIVELY holds (tier/perk chat roles,
// onboarding grants, or a linked member's real roles), highest first.
export interface BridgeWebhookProfile {
  key: string
  username: string
  displayName: string
  avatar: string | null
  /** Site account creation (the website's "Member Since"). */
  memberSince: string | null
  pronouns?: string | null
  aboutMe?: string | null
  roles: Array<{ roleId: string; name: string; color: string | null; colors?: BridgeRoleColors | null }>
  style?: BridgeAuthorStyle | null
  /** Public presence (invisible reads offline). */
  presence?: PublicPresenceStatus
}

/** Public presence of a web identity: invisible is reported as offline. */
export type PublicPresenceStatus = 'online' | 'idle' | 'dnd' | 'offline'

/** Batch public presence for 'user:<siteId>' keys (server `presence`). */
export async function bridgePresence(channelId: string, keys: string[]): Promise<Record<string, PublicPresenceStatus>> {
  const params = new URLSearchParams({ channel: channelId, keys: keys.join(',') })
  const data = await request<{ presence?: Record<string, PublicPresenceStatus> }>(`/presence?${params}`)
  return data.presence || {}
}

export async function bridgeWebhookProfile(channelId: string, key: string): Promise<BridgeWebhookProfile> {
  return request<BridgeWebhookProfile>(`/webhook-profile?channel=${encodeURIComponent(channelId)}&key=${encodeURIComponent(key)}`)
}

// The signed-in user's own account popout: site-side only, no channel and no
// guild data (see discord-bridge-api.ts `self-profile`).
// Mirrors server `effectiveChatName` (chat-display-name.ts): the name a site
// account's web messages show, falling back to the site username.
export function effectiveChatDisplayName(user: { username: string; chatDisplayName?: string | null }): string {
  const name = user.chatDisplayName?.trim()
  return name ? name : user.username
}

export interface BridgeSelfProfile {
  userId: string
  username: string
  displayName: string
  avatar: string
  memberSince: string | null
  pronouns?: string | null
  aboutMe?: string | null
  // Site-admin Admin chip only (guild-independent); empty for everyone else.
  roles?: Array<{ roleId: string; name: string; color: string | null; colors?: BridgeProfile['roles'][number]['colors'] | null }>
  discord: { username: string | null; name: string | null; avatar: string | null } | null
}

export async function bridgeSelfProfile(): Promise<BridgeSelfProfile> {
  return request<BridgeSelfProfile>('/self-profile')
}

// Server-tag popout (Discord's GuildProfile card): public guild info the bot
// can read, cached server-side. `restricted` = nothing readable (Discord's
// "Private Server" card); `inviteUrl` only when a real invite exists.
export interface BridgeGuildTagProfile {
  guildId: string
  restricted: boolean
  name: string | null
  description: string
  icon: string | null
  banner: string | null
  brandColor: string | null
  onlineCount: number | null
  memberCount: number | null
  traits: Array<{ label: string; emoji: { id: string | null; name: string | null; animated: boolean } | null }>
  games: Array<{ id: string; name: string; icon: string | null; level: number; score: number }>
  tag: string | null
  badge: string | null
  features: string[]
  premiumTier: number
  premiumSubscriptionCount: number
  inviteUrl: string | null
}

export async function bridgeGuildTag(channelId: string, guildId: string): Promise<BridgeGuildTagProfile> {
  return request<BridgeGuildTagProfile>(`/guild-tag?channel=${encodeURIComponent(channelId)}&guild=${encodeURIComponent(guildId)}`)
}

// Reactors for one emoji on a message (Discord's reactions popout + tooltip).
// Web reactors carry a 'user:<id>' key and no Discord id.
export interface BridgeReactor {
  key: string
  name: string
  avatar: string
  color: string | null
  direction: 'web' | 'discord'
  discordId: string | null
}

export interface BridgeReactors {
  emoji: string
  count: number
  reactors: BridgeReactor[]
}

export async function bridgeReactors(messageId: number, emoji: string): Promise<BridgeReactors> {
  return request<BridgeReactors>(`/reactors?message=${messageId}&emoji=${encodeURIComponent(emoji)}`)
}

export async function bridgeProfile(channelId: string, userId: string): Promise<BridgeProfile> {
  return request<BridgeProfile>(`/profile?channel=${encodeURIComponent(channelId)}&user=${encodeURIComponent(userId)}`)
}

// Channel pins (Discord's Pinned Messages popout). Read live from Discord by
// the server; entries whose message.id is 0 were never recorded by the bridge
// (pinned before the channel was bridged) and can't be jumped to.
export interface BridgePin {
  pinnedAt: string
  message: BridgeMessage
}

export async function bridgePins(channelId: string): Promise<BridgePin[]> {
  const data = await request<{ pins?: BridgePin[] }>(`/pins?channel=${encodeURIComponent(channelId)}`)
  return Array.isArray(data.pins) ? data.pins : []
}

// Pin / unpin a delivered message (staff only - Discord's Manage Messages).
export async function bridgePin(messageId: number, pinned: boolean): Promise<void> {
  await request('/pin', { method: 'POST', body: JSON.stringify({ messageId, pinned }) })
}

// Role-mention popout: the members holding a role in the channel's guild.
export interface BridgeRoleMembers {
  role: { id: string; name: string; color: string | null }
  total: number
  // `webhook` = a web identity holding the role through its effective roles
  // (onboarding grant / perk floor); its userId is the 'user:<siteId>' key.
  members: Array<{ userId: string; username: string; displayName: string; avatar: string; webhook?: boolean }>
}

export async function bridgeRoleMembers(channelId: string, roleId: string): Promise<BridgeRoleMembers> {
  return request<BridgeRoleMembers>(`/role-members?channel=${encodeURIComponent(channelId)}&role=${encodeURIComponent(roleId)}`)
}

// Message search (Discord's channel-header search → results sidebar). The
// server searches only bridged channels the caller can view; 25 per page.
export type BridgeSearchHas = 'link' | 'embed' | 'file' | 'video' | 'image' | 'sound' | 'forward'
export type BridgeSearchSort = 'newest' | 'oldest' | 'relevance'

export interface BridgeSearchParams {
  content?: string
  authorIds?: string[]
  mentionIds?: string[]
  // Typed from:/mentions: names with no known id - resolved server-side
  // (username first, then display name; Discord and web authors).
  authorNames?: string[]
  mentionNames?: string[]
  // `-link` negates (Discord's `has: -link`).
  has?: Array<BridgeSearchHas | `-${BridgeSearchHas}`>
  // authorType: user|bot|webhook, `-bot` negates.
  authorTypes?: string[]
  // Resolved date range (Discord sends min_id/max_id; we send instants).
  minTime?: string
  maxTime?: string
  before?: string   // YYYY-MM-DD (local)
  after?: string
  during?: string
  channelIds?: string[]
  sort?: BridgeSearchSort
  offset?: number
}

export interface BridgeSearchResult {
  totalResults: number
  offset: number
  limit: number
  messages: BridgeMessage[]
  channels: Array<{ channelId: string; name: string }>
}

export async function bridgeSearch(p: BridgeSearchParams, signal?: AbortSignal, guildId?: string | null): Promise<BridgeSearchResult> {
  const params = new URLSearchParams()
  // Limits results to that guild's channels (Discord searches one server).
  if (guildId) params.set('guild', guildId)
  if (p.content) params.set('content', p.content)
  for (const id of p.authorIds || []) params.append('author_id', id)
  for (const id of p.mentionIds || []) params.append('mentions', id)
  for (const name of p.authorNames || []) params.append('author_name', name)
  for (const name of p.mentionNames || []) params.append('mention_name', name)
  for (const h of p.has || []) params.append('has', h)
  for (const id of p.channelIds || []) params.append('channel_id', id)
  for (const t of p.authorTypes || []) params.append('author_type', t)
  if (p.minTime) params.set('min_time', p.minTime)
  if (p.maxTime) params.set('max_time', p.maxTime)
  if (p.before) params.set('before', p.before)
  if (p.after) params.set('after', p.after)
  if (p.during) params.set('during', p.during)
  if (p.before || p.after || p.during) params.set('tz', String(new Date().getTimezoneOffset()))
  if (p.sort && p.sort !== 'newest') params.set('sort', p.sort)
  if (p.offset) params.set('offset', String(p.offset))
  // 429s are waited out in the shared queue (the UI stays on "Searching…");
  // `signal` cancels a stale search, wait included.
  const response = await apiFetchQueued(`${base}/search?${params}`, {}, { signal })
  const data = await toJson(response, 'Search failed.')
  return {
    totalResults: Number(data.totalResults) || 0,
    offset: Number(data.offset) || 0,
    limit: Number(data.limit) || 25,
    messages: Array.isArray(data.messages) ? data.messages as BridgeMessage[] : [],
    channels: Array.isArray(data.channels) ? data.channels as BridgeSearchResult['channels'] : [],
  }
}

// --- Server Onboarding + Browse Channels (discord-onboarding-api.ts) ---------
//
// Discord's Server Onboarding, emulated for web webhooks: the guild's real
// onboarding config (read with the bot token) + per-identity answers and
// channel opt-ins stored by the bridge. Prompt/option fields mirror Discord's
// onboarding object (snake_case). Nothing is written to Discord.

export interface BridgeOnboardingEmoji {
  id: string | null
  name: string | null
  animated: boolean
  /** Custom emoji CDN url; null for a unicode emoji (render via Twemoji). */
  url: string | null
}

export interface BridgeOnboardingOption {
  id: string
  title: string
  description: string
  emoji: BridgeOnboardingEmoji | null
  /** Roles the option grants (emulated for web-only identities). */
  role_ids: string[]
  /** Channels (or categories) the option opts into. */
  channel_ids: string[]
}

/** 0 = MULTIPLE_CHOICE (option cards), 1 = DROPDOWN. */
export type BridgeOnboardingPromptType = 0 | 1

export interface BridgeOnboardingPrompt {
  id: string
  type: BridgeOnboardingPromptType
  title: string
  single_select: boolean
  required: boolean
  /** false = only shown in Channels & Roles (Customize), not the flow. */
  in_onboarding: boolean
  options: BridgeOnboardingOption[]
}

export interface BridgeOnboardingRules {
  description: string | null
  /** Numbered server rules (member-verification TERMS). */
  terms: string[]
  rulesChannelId: string | null
  version: string | null
}

export interface BridgeOnboardingState {
  /** Selected option ids across all prompts. */
  responses: string[]
  completed: boolean
  /** Browse Channels follows (channel or category ids). */
  optedInChannelIds: string[]
  /** Explicit unfollows of channels granted by an option/category. */
  optedOutChannelIds: string[]
  showAllChannels: boolean
  /** Show the onboarding flow (new web identity, onboarding enabled, not completed). */
  isNew: boolean
  rulesAccepted: boolean
}

export interface BridgeBrowseChannel {
  channelId: string
  name: string
  topic: string
  type: number
  parentId: string | null
  position: number
  bridged: boolean
  isDefault: boolean
  /** Shown in the sidebar under the opt-in model (ignores Show All Channels). */
  following: boolean
  /** false for bridged, default and role-gated channels (always shown). */
  removable: boolean
}

export interface BridgeOnboarding {
  enabled: boolean
  /** 0 ONBOARDING_DEFAULT, 1 ONBOARDING_ADVANCED. */
  mode: number
  prompts: BridgeOnboardingPrompt[]
  defaultChannelIds: string[]
  rules?: BridgeOnboardingRules | null
  welcomeScreen?: { description: string | null; channels: Array<{ channelId: string; description: string; emoji: BridgeOnboardingEmoji | null }> } | null
  guild?: { id: string; name: string; icon: string | null; splash: string | null; banner: string | null; description: string | null; features: string[] } | null
  /** Roles referenced by options (for the "You will receive the @role role." help text). */
  roles?: Array<{ id: string; name: string; color: string | null }>
  state: BridgeOnboardingState
  /** Browse Channels: every channel the caller can view, in sidebar order. */
  browse?: { categories: BridgeCategory[]; channels: BridgeBrowseChannel[] }
}

/** Realtime event emitted (only to the caller's own sockets) after any change;
 *  payload `{ targetKeys, state, guildId }` (guildId null = every guild).
 *  Refetch that guild's /channels on it. */
export const BRIDGE_ONBOARDING_EVENT = 'bridge.onboarding.updated'

// Every onboarding route is per guild: `guild` is a query param on GET and a
// body field on POST (validated server-side against the bridged guild set).
export async function bridgeOnboarding(guildId: string): Promise<BridgeOnboarding> {
  return request<BridgeOnboarding>(`/onboarding?guild=${encodeURIComponent(guildId)}`)
}

/** Replace the selected option ids. `completed: true` finishes onboarding
 *  (required prompts enforced; `rulesAccepted` required when rules exist). */
export async function bridgeOnboardingResponses(guildId: string, optionIds: string[], completed?: boolean, rulesAccepted?: boolean): Promise<BridgeOnboardingState> {
  return request<BridgeOnboardingState>('/onboarding/responses', {
    method: 'POST',
    body: JSON.stringify({ guild: guildId, optionIds, ...(completed !== undefined ? { completed } : {}), ...(rulesAccepted !== undefined ? { rulesAccepted } : {}) }),
  })
}

/** Browse Channels follow/unfollow (channel or category id). */
export async function bridgeChannelOptIn(guildId: string, channelId: string, optedIn: boolean): Promise<BridgeOnboardingState> {
  return request<BridgeOnboardingState>('/channel-optin', { method: 'POST', body: JSON.stringify({ guild: guildId, channelId, optedIn }) })
}

export async function bridgeShowAllChannels(guildId: string, showAllChannels: boolean): Promise<BridgeOnboardingState> {
  return request<BridgeOnboardingState>('/channel-optin/show-all', { method: 'POST', body: JSON.stringify({ guild: guildId, showAllChannels }) })
}
