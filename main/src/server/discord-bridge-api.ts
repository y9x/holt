import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, ViteDevServer } from 'vite'
import { dbConfigured, ensureSchema, query } from './db.js'
import { absolutizeSiteAvatars, FOREIGN_PAGE_HEADER, isExtUser, resolveChatIdentity, siteOriginOf, type ChatUser } from './chat-caller.ts'
import { effectiveChatName } from './chat-display-name.js'
import { parseRequestUrl } from './request-url.ts'
import { rateLimit, sendRateLimited } from './rate-limit.ts'
import { DISCORD_BRIDGE_OWNER_KEY, emit, subscribe } from './events.js'
import { presencePublicFor, type PublicPresence } from './presence.js'
import { loadConfig } from './config.js'
import * as bridge from './discord-bridge-db.js'
import { messageLinks, unfurlUrl } from './discord-unfurl.js'
import { attachmentsFromApi, type RawApiAttachment } from './discord-media.js'
import { refreshMessageMedia } from './discord-cdn-refresh.js'
import { botCanManageMessages, suppressOnDiscord } from './discord-embed-suppress.js'
import { componentsFromRaw, flagsFromRaw, interactionFromRaw, type RawInteractionFields } from './discord-interactions.js'
import {
  Perm,
  hasPerm,
  applyDiscordChannelPerms,
  canManagePosts,
  chatPermsForUser,
  chatPermsForChannel,
  chatPermsForIdentity,
  extKeyOf,
  activeTimeout,
  webhookOverwrites,
  memberOverwrite,
  moderationDenial,
  parseWebhookTarget,
  resolveWebhookTarget,
  setWebhookPerm,
  siteAdminRole,
  subjectOfUser,
  webhookKey,
  webhookKeys,
  writeDenialCore,
  validateTagChange,
  ForumErrorCode,
  type ActiveTimeout,
  type EffectiveOverwrite,
  type ModerationAction,
  type WebhookSubject,
  type WriteAction,
} from './discord-chat-perms.js'
import { moderateWebhook, webhookBanFor, type ModerationRequest } from './discord-chat-moderation.js'
import {
  automodBlockedBody,
  mentionLimiter,
  mentionSpamCheck,
  mentionTargetKey,
  pingClassFor,
  resolveMentionLimits,
  type MentionLimitConfig,
  type NeutralizeReason,
  type PingClass,
} from './discord-mention-limits.js'
import { discordFetch, fetchMemberProfile } from './discord-roles.js'
import { writeSealedJson } from './api-crypto.ts'
import { authorStyleFor, authorStylesFor, roleColorsFor, webAuthorStyle, type AuthorStyle } from './discord-author-style.js'
import { guildTagProfile } from './discord-guild-tag.js'
import { approvedAvatarUrlForUser } from './avatar-store.ts'
import { handleOnboardingRequest, isOnboardingRoute } from './discord-onboarding-api.js'
import { siteChatKey, siteChatKeys, siteIdOfChatKey } from './chat-identity-key.ts'
import { bridgeTargets } from './bridge-config.ts'
import {
  channelAccess,
  configuredGuildId,
  discordChannelBits,
  discordViewAllowed,
  invalidateForChannelsChanged,
  onboardingRoleHolders,
  visibleSidebar,
  type ChannelAccess,
} from './discord-channel-access.js'

export const OUTBOX_NOTIFY_CHANNEL = 'abulxt_bridge_outbox'

// Web-originated edits are handed to the bot over this pg_notify channel; the
// bot LISTENs and PATCHes the delivered Discord message. Payload:
// { discordMessageId, channelId, content }.
export const EDIT_NOTIFY_CHANNEL = 'abulxt_bridge_edit'

// Web-originated deletes are handed to the bot over this pg_notify channel; the
// bot LISTENs and deletes the Discord-side copy (a webhook-delivered web
// message, or a Discord-originated message a staff webhook removed from the
// web). Payload: { discordMessageId, channelId }.
export const DELETE_NOTIFY_CHANNEL = 'abulxt_bridge_delete'

// Discord JSON error codes, mirrored so the web client can render
// Discord-style error toasts. https://discord.com/developers/docs/topics/opcodes-and-status-codes#json
export const DiscordError = {
  MISSING_ACCESS: 50001,      // can't view the channel/resource
  MISSING_PERMISSIONS: 50013, // lacks the permission bit
  UNKNOWN_MESSAGE: 10008,     // message id doesn't exist
  UNKNOWN_CHANNEL: 10003,     // channel id doesn't exist
  AUTOMOD_BLOCKED: 200000,    // message blocked by AutoMod (mention spam)
  RATE_LIMITED: 429,          // conventional HTTP code; body also carries retryAfter
} as const

// Discord Administrator bypass: admins/owners are never denied by channel
// overwrites.
function bypassesOverwrites(tier: string): boolean {
  return tier === 'admin' || tier === 'owner'
}

const ALL_ALLOWED: EffectiveOverwrite = { view: true, send: true, react: true, reply: true }

// The caller's effective overwrite for a channel (admins/owners bypass).
async function overwriteFor(
  channelId: string,
  subject: WebhookSubject,
  perms: { tier: string; roleId: string | null; roleIds?: string[]; permissions: bigint },
): Promise<EffectiveOverwrite> {
  if (bypassesOverwrites(perms.tier)) return { ...ALL_ALLOWED }
  // Role overwrites match ANY effective role (incl. onboarding-granted ones).
  const roleIds = perms.roleIds || (perms.roleId ? [perms.roleId] : [])
  return webhookOverwrites(channelId, subject, roleIds, perms as Parameters<typeof webhookOverwrites>[3])
}

// The caller's chat perms for ONE channel: the channel-agnostic tier perms
// (chatPermsForUser, with effective roles) → Discord's channel permission
// math over those roles (applyDiscordChannelPerms: role grants, then Discord
// denies) → active timeout (VIEW-only). Bridge webhook overwrites and the
// lockdown are applied on top by writeDenialCore via `overwrite` / `locked`.
// See applyDiscordChannelPerms in discord-chat-perms.ts for the precedence.
// `channelId` is the channel the gates run on: for a forum post, its FORUM
// (threads inherit the forum's overwrites and timeouts); `context` 'post'
// then maps Discord's SEND_MESSAGES_IN_THREADS (replying).
async function channelPermsFor(
  user: ChatUser | null | undefined,
  basePerms: ResolvedChatPerms,
  channelId: string,
  subject: WebhookSubject,
  guildId: string,
  context: 'channel' | 'post' = 'channel',
): Promise<{ perms: ResolvedChatPerms; timeout: ActiveTimeout | null }> {
  const discord = await discordChannelBits(user, basePerms, channelId, guildId).catch(() => null)
  return chatPermsForChannel(applyDiscordChannelPerms(basePerms, discord, context), channelId, subject)
}

// What a channel-scoped request names: an ordinary channel, a forum (posts
// only, no messages) or a post inside a forum. Every gate runs on
// scope.channel (the forum for a post); messages live under scope.id.
function scopeKind(scope: bridge.BridgeScope): 'channel' | 'forum' | 'post' {
  return scope.post ? 'post' : bridge.isForumType(scope.channel.type) ? 'forum' : 'channel'
}

// A web post that has not reached Discord yet takes no messages (contract:
// 409 for sending to a `post:<n>` id).
const PENDING_POST = { error: 'This post has not reached Discord yet.' } as const
function pendingPost(scope: bridge.BridgeScope | null): boolean {
  return Boolean(scope?.post?.pending)
}

// A message landed in a post: bump "Recently Active" and push the refreshed
// card (bridge.post.updated: counts, activity) to the forum's viewers.
async function touchPostActivity(postId: string, at: string | Date): Promise<void> {
  await bridge.touchPost(postId, new Date(at)).catch(() => false)
  const post = await bridge.postFor(postId).catch(() => null)
  if (post && !post.deletedAt) await bridge.emitPostEvent('bridge.post.updated', post).catch(() => {})
}

// A forum post's state for the write gate.
function gatePost(scope: bridge.BridgeScope | null): { locked: boolean; archived: boolean } | null {
  return scope?.post ? { locked: scope.post.locked, archived: scope.post.archived } : null
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}

// Read-only GETs that the client fetches through cryptoFetch (guilds,
// channels): sealed per session when config.apiCrypto.enabled and the client
// negotiated it (PLAN-API.md; sealed bodies are private, no-store), else the
// plain JSON response.
async function sendSealedJson(request: IncomingMessage, response: ServerResponse, body: unknown): Promise<void> {
  const config = await loadConfig().catch(() => null)
  if (config?.apiCrypto?.enabled && writeSealedJson(request, response, JSON.stringify(body), 200)) return
  response.setHeader('Cache-Control', 'private, no-store')
  sendJson(response, 200, body)
}

const UNKNOWN_GUILD = { error: 'Unknown Guild', code: 10004 } as const

// A `guild` param validated against the bridged guild set (guilds with at
// least one enabled bridged channel). null = missing, malformed or not
// bridged (callers answer 404 Unknown Guild).
async function bridgedGuildParam(raw: unknown): Promise<string | null> {
  if (typeof raw !== 'string' || !/^\d{15,22}$/.test(raw)) return null
  const ids = await bridge.bridgedGuildIds().catch(() => [] as string[])
  return ids.includes(raw) ? raw : null
}

// The guild for a guild-level request that names none: the HOME guild when
// it is bridged, else the first bridged guild (else the home guild id, so a
// not-yet-bridged install still resolves perms the old way).
async function defaultBridgedGuild(): Promise<string> {
  const home = configuredGuildId()
  const ids = await bridge.bridgedGuildIds().catch(() => [] as string[])
  if (home && ids.includes(home)) return home
  return ids[0] || home
}

// Every bridge POST body is a small JSON object (content is capped at 2000
// chars); anything past this is drained without buffering and treated as {}.
const MAX_BODY_BYTES = 64 * 1024

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  let overflow = false
  for await (const chunk of request) {
    const buf = Buffer.from(chunk)
    total += buf.length
    if (total > MAX_BODY_BYTES) overflow = true
    if (!overflow) chunks.push(buf)
  }
  if (overflow || !chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

// Basic XSS/abuse hygiene for web-originated content: neutralize Discord
// invite links and cap length. Mention tokens are handled separately by the
// permission-aware parseMentions() below (this function deliberately leaves
// @everyone/@here, <@id>, and <@&id> untouched so the mention pass can decide
// per-permission whether each pings or degrades to inert plain text).
function sanitizeContent(input: string): string {
  let output = input.replace(/(discord\.gg|discord(?:app)?\.com\/invite)\/\S+/gi, '[invite removed]')
  return output.trim().slice(0, 2000)
}

// Full message column list (shared with discord-bridge-db.ts) so the unfurl
// UPDATE below can RETURNING a complete message row.
const UNFURL_MESSAGE_COLS = bridge.MESSAGE_COLS

// Attach Discord-style link unfurls to an already-stored web message. Called
// fire-and-forget from the send endpoint: the message is persisted, broadcast,
// and answered first; the embeds then appear a moment later on every client
// via a bridge.message.edited event - the same delayed-embed UX as Discord.
// Every linked URL (up to MAX_UNFURL_LINKS, in content order) is unfurled in
// parallel into Discord-shaped embeds (link/article/image/video/gifv).
//
// When the message is delivered to Discord, Discord's own unfurl of the
// webhook message replaces these (discord-bridge-bot.ts messageUpdate), which
// brings Discord's media-proxy URLs. The UPDATE below therefore only fills an
// EMPTY embeds column - if Discord's embeds already landed, ours are dropped.
// Deleted messages are left alone. Every failure path is a silent no-op.
const MAX_UNFURL_LINKS = 5
async function unfurlMessageEmbeds(messageId: number, links: string[]): Promise<void> {
  const targets = links.slice(0, MAX_UNFURL_LINKS)
  if (!targets.length) return
  const results = await Promise.all(targets.map((link) => unfurlUrl(link).catch(() => null)))
  const embeds = results.filter((e) => e !== null)
  if (!embeds.length) return
  // Race guard: only attach when the stored content still links to the first
  // URL. If the user edited the message (or removed the link) while the fetch
  // was in flight, embedding the old target would be wrong - skip it.
  const { rows } = await query<Record<string, unknown>>(
    `UPDATE discord_bridge_message
       SET embeds = $2::jsonb
     WHERE id = $1 AND direction = 'web' AND deleted_at IS NULL
       AND position($3 in content) > 0
       AND jsonb_array_length(COALESCE(embeds, '[]'::jsonb)) = 0
     RETURNING ${UNFURL_MESSAGE_COLS}`,
    [messageId, JSON.stringify(embeds), targets[0]],
  ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }))
  if (!rows[0]) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updated = bridge.toMessage(rows[0] as any)
  // The UPDATE above touches ONLY the embeds column - edited_at is deliberately
  // left alone so the message doesn't gain an "(edited)" marker from a link
  // preview. `embedOnly: true` makes that explicit for clients: this echo is a
  // Discord-style delayed embed, not a user edit.
  await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.message.edited', { message: updated, embedOnly: true }).catch(() => {})
}

export interface BridgeMention {
  // 'reply' = the replied-to author, recorded only when the reply pings them
  // (reply "@ ON"). Drives the web highlight; the bot's allowedMentions
  // ignores it (the reply ping rides on allowed_mentions.replied_user).
  type: 'everyone' | 'role' | 'user' | 'reply'
  id?: string
  username?: string
  name?: string
  color?: string | null
  // Neutralized by the ping limits (discord-mention-limits.ts): the chip
  // still renders, but it pings nobody - left out of allowed_mentions and
  // never highlights on the web (Discord's non-pinging mention).
  inert?: boolean
}

// Discord's default-avatar index for the post-2023 username system: the user
// id's snowflake bits 22..27 mod 6 pick one of the six embed/avatars/N.png
// defaults. Matches what Discord shows for a user with no custom avatar.
function defaultAvatarIndex(userId: string): number {
  try {
    return Number((BigInt(userId) >> 22n) % 6n)
  } catch {
    return 0
  }
}

// Resolve a directory member's stored avatar into a COMPLETE, renderable CDN
// url for the mention autocomplete. The bot syncs `avatar` from
// member.displayAvatarURL(), so the column holds a FULL url (custom-avatar or
// the embed/avatars/N.png default), never a bare hash - but be defensive: a
// bare-hash row (older/manual writes) is expanded to the avatars/ url, and a
// null/missing avatar falls back to the user's default-avatar-by-id. Returning
// a ready-to-use url means the client never has to guess the form (it used to
// wrap `avatar` as a hash unconditionally, producing garbage like
// `…/avatars/<id>/https://cdn…/embed/avatars/0.png.webp` - the broken-image bug).
// Short-lived cache for the profile endpoint (two Discord REST calls per
// miss); keyed guild:user, FIFO-capped at 500 entries.
const profileCache = new Map<string, { expires: number; body: unknown }>()

// The profile popout's author cosmetics: the directory style, overridden by
// the fresher REST member/user objects the profile call just fetched (guild
// decoration first, then the user's; server tag; nameplate; display-name
// font when Discord includes display_name_styles). Role colors come from the
// member's live role list.
function profileStyle(
  stored: Awaited<ReturnType<typeof authorStyleFor>>,
  raw: Awaited<ReturnType<typeof fetchMemberProfile>>,
  roleRows: Array<{ color: string | null; position: number; colors?: bridge.RoleColorsJson | null }>,
) {
  const u = raw.user
  const m = raw.member
  const deco = m?.avatar_decoration_data || u?.avatar_decoration_data || null
  const pg = u?.primary_guild
  const plate = m?.collectibles?.nameplate || u?.collectibles?.nameplate || null
  const colorRole = [...roleRows].sort((a, b) => b.position - a.position)
    .find((r) => Boolean((r.color && r.color.toLowerCase() !== '#000000') || r.colors?.primary)) || null
  const dns = u?.display_name_styles
  return {
    color: colorRole ? (colorRole.colors?.primary || colorRole.color) : (stored?.color ?? null),
    colors: colorRole ? roleColorsFor(colorRole) : (stored?.colors ?? null),
    decoration: deco?.asset ? { asset: deco.asset, skuId: deco.sku_id ?? null } : (u ? null : stored?.decoration ?? null),
    nameplate: plate?.asset
      ? { asset: plate.asset, palette: plate.palette ?? null, label: plate.label ?? null, skuId: plate.sku_id ?? null }
      : (u ? null : stored?.nameplate ?? null),
    guildTag: pg && pg.identity_enabled && pg.tag && pg.identity_guild_id
      ? { guildId: pg.identity_guild_id, tag: pg.tag, badge: pg.badge ?? null }
      : (u ? null : stored?.guildTag ?? null),
    fontId: dns && typeof dns.font_id === 'number' ? dns.font_id : (stored?.fontId ?? null),
    joinedAt: m?.joined_at || stored?.joinedAt || null,
    rejoined: m ? ((m.flags ?? 0) & 1) === 1 : (stored?.rejoined ?? false),
    bot: Boolean(u?.bot ?? stored?.bot),
  }
}

// === Search (GET /search) limits ===
// Discord-like cadence on the shared sliding-window limiter: a burst of 5,
// then 1 per 2s sustained (5 hits / 10s window), per identity (user, or
// guest = per IP). A looser per-IP bucket stops one address cycling accounts.
const SEARCH_USER_LIMIT = { limit: 5, windowMs: 10_000 }
const SEARCH_IP_LIMIT = { limit: 15, windowMs: 10_000 }
const SEARCH_MAX_CONTENT = 512       // chars of free text (Discord caps at 1024)
const SEARCH_MAX_OFFSET = 9975       // Discord's own search offset ceiling (400 pages)
const SEARCH_PAGE_SIZE = 25          // Discord's results page size
const SEARCH_MAX_IDS = 10            // max from:/mentions: values (ids + names, per filter)
const SEARCH_MAX_NAME = 64           // chars per typed from:/mentions: name
const SEARCH_HAS = new Set<bridge.SearchHas>(['link', 'embed', 'file', 'video', 'image', 'sound', 'forward'])
const SNOWFLAKE = /^\d{15,22}$/

// Bridged (persisted) channel ids the caller can VIEW: Discord VIEW_CHANNEL in
// the channel's guild, VIEW_MESSAGES on the caller's chat bitfield there, plus
// the channel's webhook view overwrite (admins/owners bypass overwrites -
// Discord Administrator). Perms are resolved once per guild. `guildId` limits
// the result to one guild. Search and the guild rail never touch a channel
// that fails this, so results can't leak hidden channels.
async function viewableBridgedChannels(user: ChatUser | null, guildId?: string): Promise<bridge.BridgeChannel[]> {
  const byGuild = new Map<string, bridge.BridgeChannel[]>()
  for (const c of await bridge.listChannels(true, guildId)) {
    if (!c.guildId) continue
    const list = byGuild.get(c.guildId) || []
    list.push(c)
    byGuild.set(c.guildId, list)
  }
  const subject = subjectOfUser(user)
  const out: bridge.BridgeChannel[] = []
  for (const [gid, list] of byGuild) {
    const perms = await chatPermsForUser(user, gid)
    if (!hasPerm(perms.permissions, Perm.VIEW_MESSAGES)) continue
    // Discord-side VIEW_CHANNEL first (live roles + overwrites; without
    // the guild snapshot only @everyone-viewable channels - fail closed).
    const visible: bridge.BridgeChannel[] = []
    for (const c of list) {
      const access = await channelAccess(user, perms, c.channelId, gid).catch(() => null)
      if (discordViewAllowed(access, c.everyoneCanView)) visible.push(c)
    }
    if (bypassesOverwrites(perms.tier)) { out.push(...visible); continue }
    const checks = await Promise.all(visible.map((c) =>
      overwriteFor(c.channelId, subject, perms).then((o) => o.view).catch(() => false)))
    out.push(...visible.filter((_, i) => checks[i]))
  }
  return out
}

// YYYY-MM-DD in the caller's timezone (tz = Date#getTimezoneOffset minutes)
// → that local day's midnight as an absolute instant.
function localDayStart(value: string, tzOffsetMin: number, addDays = 0): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + addDays) + tzOffsetMin * 60_000
  const d = new Date(ms)
  return Number.isFinite(ms) && d.getUTCFullYear() >= 2015 && d.getUTCFullYear() <= 2100 ? d : null
}

// Discord's 429 body: { message, retry_after (seconds, float), global }.
function sendSearchRateLimited(response: ServerResponse, retryAfterSec: number) {
  return sendRateLimited(response, retryAfterSec)
}

// The `guilds` route (rail icon + server header + sidebar banner): one Discord
// REST call per bridged guild, cached per guild for 5 minutes.
interface BridgeGuildOut {
  id: string
  name: string
  icon: string | null
  banner: string | null
  /** Server Boost level (0-3) - Discord's premium_tier. */
  premiumTier: number
  /** Number of active Server Boosts - Discord's premium_subscription_count. */
  premiumSubscriptionCount: number
  /** Guild feature flags (COMMUNITY / DISCOVERABLE / VERIFIED / PARTNERED …):
   *  the guild tooltip's badge picks its glyph from these like Discord does. */
  features: string[]
  /** The guild's rules channel (Discord rules_channel_id): the client swaps
   *  that channel's hash for Discord's BookCheckIcon, like the real sidebar. */
  rulesChannelId: string | null
  /** https://discord.gg/<vanity> when the guild has a vanity invite code. */
  inviteUrl: string | null
}
const GUILDS_CACHE_MS = 5 * 60 * 1000
// Per guild; a failed fetch is cached as null for a short while.
const guildInfoCache = new Map<string, { expires: number; guild: BridgeGuildOut | null }>()

function resolveMemberAvatarUrl(userId: string, avatar: string | null): string {
  if (avatar) {
    if (/^https?:\/\//i.test(avatar)) return avatar
    // Bare hash: animated avatars start with 'a_'; serve webp like the client.
    return `https://cdn.discordapp.com/avatars/${userId}/${avatar}.webp?size=64`
  }
  return `https://cdn.discordapp.com/embed/avatars/${defaultAvatarIndex(userId)}.png`
}

// The 'reply' mention entry for a reply with "@ ON": identifies the
// replied-to author so the web client highlights the reply for them (Discord
// highlights a pinging reply for its target). Discord-origin targets carry the
// author's snowflake; web targets carry the author name (the site username the
// client matches against). Returns null for an unknown/deleted target.
async function replyMentionFor(replyTo: string, channelId: string): Promise<BridgeMention | null> {
  const asId = Number(replyTo)
  const target = Number.isInteger(asId) && String(asId) === replyTo.trim()
    ? await bridge.messageFor(asId).catch(() => null)
    : await bridge.byDiscordMessageId(replyTo).catch(() => null)
  if (!target || target.deletedAt || target.channelId !== channelId) return null
  const discordId = target.authorKey.startsWith('discord:') ? target.authorKey.slice('discord:'.length) : ''
  return { type: 'reply', id: discordId, username: target.authorName }
}

// Permission-aware mention handling for a web-originated send. Mirrors
// Discord's own behavior: the message always sends, but each mention pings
// only if the caller holds the matching permission; otherwise it degrades to
// inert plain text (no chip, no ping).
//
// - @everyone/@here: kept as a live token only with MENTION_EVERYONE
//   (recorded as {type:'everyone'}); otherwise stripped to 'everyone'/'here'.
// - <@&roleId> / @RoleName: kept as a chip only with MENTION_ROLES or
//   MENTION_EVERYONE, and only when the role exists in the guild (resolved via
//   bridge.guildRoleFor); otherwise degraded to '@RoleName' plain text.
// - <@userId> / @username: any member may mention a user (Discord's default).
//   Resolved via bridge.guildMemberFor and recorded as {type:'user'} so the
//   mention-highlight and profile popout work for web-originated messages.
//
// The stored content keeps the renderable token form (<@id> / <@&id>) that the
// client's renderContent converts to chips, matching the regex
// &lt;@!?ID&gt; / <@ID> and the message.mentions array.
async function parseMentions(
  content: string,
  perms: { permissions: bigint },
  guildId: string,
): Promise<{ content: string; mentions: BridgeMention[] }> {
  const mentions: BridgeMention[] = []
  const canEveryone = hasPerm(perms.permissions, Perm.MENTION_EVERYONE)
  const canRoles = canEveryone || hasPerm(perms.permissions, Perm.MENTION_ROLES)
  let out = content

  // @everyone / @here
  if (canEveryone) {
    if (/@everyone/i.test(out) || /@here/i.test(out)) {
      mentions.push({ type: 'everyone' })
    }
  } else {
    out = out.replace(/@everyone/gi, 'everyone').replace(/@here/gi, 'here')
  }

  // Role mentions by token: <@&roleId>
  const roleTokenIds = new Set<string>()
  for (const m of out.matchAll(/<@&(\d+)>/g)) roleTokenIds.add(m[1])
  for (const roleId of roleTokenIds) {
    const role = canRoles ? await bridge.guildRoleFor(guildId, roleId).catch(() => null) : null
    if (role) {
      mentions.push({ type: 'role', id: roleId, name: role.name, color: role.color })
    } else {
      // No permission or unknown role: degrade to plain text (@RoleName when
      // resolvable without perms, else a generic placeholder).
      const known = await bridge.guildRoleFor(guildId, roleId).catch(() => null)
      out = out.replace(new RegExp(`<@&${roleId}>`, 'g'), `@${known?.name || 'role'}`)
    }
  }

  // User mentions by token: <@userId> / <@!userId>. Anyone may mention a user;
  // resolve against the guild directory so the chip + badge light up.
  const userTokenIds = new Set<string>()
  for (const m of out.matchAll(/<@!?(\d+)>/g)) userTokenIds.add(m[1])
  for (const userId of userTokenIds) {
    const member = await bridge.guildMemberFor(guildId, userId).catch(() => null)
    if (member) {
      mentions.push({ type: 'user', id: userId, username: member.displayName || member.username })
    }
    // Unresolvable user ids are left as-is (harmless; Discord ignores them and
    // the client renders no chip without a matching mentions entry).
  }

  return { content: out, mentions }
}

// === Ping limits (discord-mention-limits.ts) ===
async function mentionLimits(): Promise<MentionLimitConfig> {
  const config = await loadConfig().catch(() => null)
  return resolveMentionLimits(config?.discord?.bridge?.mentionLimits)
}

function pingClassOf(perms: { tier: string; permissions: bigint }): PingClass {
  return pingClassFor(perms.tier, hasPerm(perms.permissions, Perm.MENTION_EVERYONE))
}

// Audit trail for moderators (moderation_event, /bridge events): AutoMod
// blocks and neutralized mention bursts, throttled to one row per identity
// per minute (`folded` = limit events since the last row).
function logMentionLimit(
  pingKey: string,
  action: 'automod-block' | 'mention-limit',
  reason: string,
  meta: Record<string, unknown>,
): void {
  const folded = mentionLimiter.takeLogSlot(pingKey)
  if (!folded) return
  console.warn(`[abulxt-bridge] ${action} ${pingKey}: ${reason}`)
  void bridge.logModeration({ actor: 'AutoMod', action, subject: pingKey, reason, meta: { ...meta, folded } }).catch(() => {})
}

function neutralizedReason(list: Array<{ target: string; reason: NeutralizeReason }>): string {
  const by = new Map<NeutralizeReason, number>()
  for (const n of list) by.set(n.reason, (by.get(n.reason) || 0) + 1)
  return `Neutralized ${list.length} mention(s): ${[...by].map(([r, n]) => `${n} ${r}`).join(', ')}`
}

// Bridge ban for a signed-in caller (site user, linked Discord id, or IP) in
// one guild: global bans plus that guild's own. Returns the reason or null.
// The caller's chat key: `abulxt:<id>` for a site account, the ext key (`<namespace>:<subject>`) for
// another platform's user (chat-caller.ts).
function callerKey(user: ChatUser): string {
  return isExtUser(user) ? user.ext_key : siteChatKey(user.id)
}

// Every key the caller's own messages may carry (a site account also has its pre-037 key).
function callerKeys(user: ChatUser): string[] {
  return isExtUser(user) ? [user.ext_key] : siteChatKeys(user.id)
}

// Did the caller write this web message? Compared by key: two other-platform users have no site id, so an
// id comparison would make every one of them the author of every other's messages.
function authoredBy(authorKey: string, user: ChatUser | null | undefined): boolean {
  if (!user) return false
  return isExtUser(user) ? authorKey === user.ext_key : siteIdOfChatKey(authorKey) === user.id
}

// The avatar a web message carries: a site account's approved upload, else its linked Discord avatar.
// Another platform's user gets Discord's default: holt has no moderation path for avatar URLs a platform
// supplies, and only moderated avatars are ever shown or sent to Discord.
async function callerAvatar(user: ChatUser): Promise<string | null> {
  if (isExtUser(user)) return null
  return (await approvedAvatarUrlForUser(user.id)) ?? (user.discord_avatar
    ? `https://cdn.discordapp.com/avatars/${user.discord_id}/${user.discord_avatar}.webp?size=64`
    : null)
}

// holt's sessionSecret (holt-config.ts): verifies the X-Holt-Principal holt-service signs for other
// platforms' users. holt-chat reads the same config.js; without the key no principal is accepted.
async function holtSessionSecret(): Promise<string | null> {
  const config = await loadConfig().catch(() => null) as { sessionSecret?: unknown } | null
  return typeof config?.sessionSecret === 'string' && config.sessionSecret.length >= 32 ? config.sessionSecret : null
}

async function bridgeBanFor(user: ChatUser, ip: string, guildId: string): Promise<string | null> {
  return (await webhookBanFor(subjectOfUser(user), guildId)) || (await bridge.isBanned('ip', ip, guildId))
}

type ResolvedChatPerms = Awaited<ReturnType<typeof chatPermsForUser>>
const VIEW_DENIED = { error: 'You do not have permission to view this channel.', code: DiscordError.MISSING_ACCESS } as const

type WriteGate =
  | { ok: true; perms: ResolvedChatPerms; basePerms: ResolvedChatPerms; timeout: ActiveTimeout | null; subject: WebhookSubject; scope: bridge.BridgeScope }
  | { ok: false; status: number; body: Record<string, unknown> }

// THE write gate. Every write path (send, edit, forward, typing, react,
// own-message delete/suppress, staff pin/delete/suppress, moderation) calls
// this with its action so the checks can't drift: bridged-only channel,
// email verification (composing actions), bridge ban (site account, linked
// Discord, IP), Discord VIEW + chat VIEW bit + view overwrite, active timeout
// (either side of the webhook identity), then the action's own bits -
// SEND_MESSAGES + send overwrite + channel lock for composing actions,
// ADD_REACTIONS + react overwrite for reactions, Manage Messages for staff
// message actions. The decision itself is the pure writeDenialCore.
// A forum post (scope.post) is gated on its FORUM: the forum's Discord
// permissions (SEND_MESSAGES_IN_THREADS for replies), overwrites, timeouts,
// lockdown and bans, plus the post's locked / archived state. `extra.tags`
// are a new post's tags ('post-create').
async function writeDenial(
  user: ChatUser,
  ip: string,
  scope: bridge.BridgeScope | null,
  action: WriteAction,
  extra: { tags?: string[] } = {},
): Promise<WriteGate> {
  const channel = scope?.channel ?? null
  if (!scope || !channel || !channel.enabled) {
    return { ok: false, status: 404, body: { error: 'Unknown channel.', code: DiscordError.UNKNOWN_CHANNEL } }
  }
  const kind = scopeKind(scope)
  const subject = subjectOfUser(user)
  const guildId = channel.guildId
  const basePerms = await chatPermsForUser(user, guildId)
  const [{ perms, timeout }, banned, viewDenied] = await Promise.all([
    channelPermsFor(user, basePerms, channel.channelId, subject, guildId, kind === 'post' ? 'post' : 'channel'),
    bridgeBanFor(user, ip, guildId),
    discordViewDenied(user, basePerms, channel.channelId, guildId, channel.everyoneCanView),
  ])
  // Our overwrites apply on top of the channel-adjusted perms: Discord grants
  // (e.g. a Members role allow on #general) must reach the send gate.
  const overwrite = await overwriteFor(channel.channelId, subject, perms)
  const denial = writeDenialCore({
    action,
    perms,
    emailVerified: Boolean(user.email_verified),
    banned,
    discordView: !viewDenied,
    overwrite,
    locked: Boolean(channel.locked),
    timeout,
    scope: kind,
    post: gatePost(scope),
    tags: action === 'post-create' && channel.forum && extra.tags ? { forum: channel.forum, applied: extra.tags } : null,
  })
  if (denial) return { ok: false, status: denial.status, body: denial.body }
  return { ok: true, perms, basePerms, timeout, subject, scope }
}

// Discord-side VIEW_CHANNEL check (live guild roles + channel overwrites, see
// discord-channel-access.ts). Returns the 403 body when the caller can't see
// the channel on Discord, null otherwise. When the guild snapshot is
// unavailable (Discord unreachable) this FAILS CLOSED: only channels
// @everyone can view (everyone_can_view) pass (discordViewAllowed).
async function discordViewDenied(
  user: ChatUser | null | undefined,
  perms: ResolvedChatPerms,
  channelId: string,
  guildId: string,
  everyoneCanView: boolean,
): Promise<Record<string, unknown> | null> {
  const access = await channelAccess(user, perms, channelId, guildId)
  return discordViewAllowed(access, everyoneCanView) ? null : { ...VIEW_DENIED }
}

type ViewGate =
  | { ok: true; perms: ResolvedChatPerms; bridged: bridge.BridgeChannel; scope: bridge.BridgeScope; access: ChannelAccess; guildId: string }
  | { ok: false; status: number; body: Record<string, unknown> }

// The read gate every channel-scoped GET shares (history, pins, profile,
// members, role-members, search). Only ENABLED bridged channels are readable
// (unbridged live reads were dropped with multi-guild bridging: they 404).
// The guild is the channel's own (discord_bridge_channel.guild_id) and perms
// are resolved there. Readable when the caller can VIEW the channel on
// Discord AND holds the chat VIEW_MESSAGES bit with no webhook view-deny
// overwrite (admins/owners bypass overwrites). A forum post (a thread id or a
// pending `post:<n>`) is readable exactly when its forum is: `bridged` is the
// forum, `scope.id` the post.
async function viewGate(
  user: ChatUser | null | undefined,
  channelId: string,
): Promise<ViewGate> {
  const unknown = { ok: false as const, status: 404, body: { error: 'Unknown channel.', code: DiscordError.UNKNOWN_CHANNEL } }
  const denied = { ok: false as const, status: 403, body: { ...VIEW_DENIED } }
  if (!channelId) return unknown
  const scope = await bridge.scopeFor(channelId).catch(() => null)
  const row = scope?.channel
  const bridged = row && row.enabled && row.guildId ? row : null
  if (!scope || !bridged) return unknown
  const perms = await chatPermsForUser(user, bridged.guildId)
  const access = await channelAccess(user, perms, bridged.channelId, bridged.guildId)
  if (!discordViewAllowed(access, bridged.everyoneCanView)) return denied
  const overwrite = await overwriteFor(bridged.channelId, subjectOfUser(user), perms)
  if (!hasPerm(perms.permissions, Perm.VIEW_MESSAGES) || !overwrite.view) return denied
  return { ok: true, perms, bridged, scope, access, guildId: bridged.guildId }
}

// The snapshot a forward carries: the source message's content/attachments/
// embeds. Forwarding a forward re-forwards the inner snapshot (Discord does
// the same - a forward never nests).
function forwardSnapshotOf(source: bridge.BridgeMessage, guildId: string): bridge.ForwardSnapshot {
  if (source.forwarded) return source.forwarded
  return {
    content: source.content,
    attachments: source.attachments,
    embeds: source.embeds,
    mentions: source.mentions,
    createdAt: source.createdAt,
    channelId: source.channelId,
    // Discord snowflake only (used for the jump link); null when the source
    // never reached Discord.
    messageId: source.discordMessageId,
    guildId,
  }
}

// ---------------------------------------------------------------------------
// Pins + role-member directory (live Discord REST with the bot token).
// ---------------------------------------------------------------------------

interface DiscordApiUser { id: string; username: string; global_name?: string | null; avatar?: string | null; bot?: boolean }
interface DiscordApiMessage {
  id: string
  channel_id: string
  content?: string
  timestamp: string
  edited_timestamp?: string | null
  author: DiscordApiUser
  webhook_id?: string
  member?: { nick?: string | null }
  attachments?: RawApiAttachment[]
  embeds?: Array<Record<string, unknown>>
  mentions?: DiscordApiUser[]
  type?: number
  interaction_metadata?: RawInteractionFields['interaction_metadata']
  interaction?: RawInteractionFields['interaction']
  components?: unknown[]
  flags?: number
}

// Pinned messages for a channel. Tries Discord's current paginated pins route
// (GET /channels/{id}/messages/pins → { items: [{ pinned_at, message }] }),
// falling back to the legacy array route. null = Discord refused / unreachable.
async function fetchDiscordPins(token: string, channelId: string): Promise<Array<{ pinnedAt: string; message: DiscordApiMessage }> | null> {
  const headers = { Authorization: `Bot ${token}` }
  const modern = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/pins?limit=50`, { headers }).catch(() => null)
  if (modern && modern.ok) {
    const body = (await modern.json().catch(() => null)) as { items?: Array<{ pinned_at: string; message: DiscordApiMessage }> } | null
    if (body && Array.isArray(body.items)) return body.items.map((i) => ({ pinnedAt: i.pinned_at, message: i.message }))
  }
  const legacy = await fetch(`https://discord.com/api/v10/channels/${channelId}/pins`, { headers }).catch(() => null)
  if (!legacy || !legacy.ok) return null
  const list = (await legacy.json().catch(() => null)) as DiscordApiMessage[] | null
  return Array.isArray(list) ? list.map((m) => ({ pinnedAt: m.timestamp, message: m })) : null
}

// Pin/unpin a delivered message on Discord (modern route, legacy fallback).
// Returns the Discord HTTP status (204 on success) or 0 when unreachable.
async function setDiscordPin(token: string, channelId: string, discordMessageId: string, pinned: boolean): Promise<number> {
  const init = { method: pinned ? 'PUT' : 'DELETE', headers: { Authorization: `Bot ${token}`, 'X-Audit-Log-Reason': 'Pinned from the web chat' } }
  const modern = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/pins/${discordMessageId}`, init).catch(() => null)
  if (modern && modern.status !== 404) return modern.status
  const legacy = await fetch(`https://discord.com/api/v10/channels/${channelId}/pins/${discordMessageId}`, init).catch(() => null)
  return legacy ? legacy.status : 0
}

// A pinned Discord message the bridge never recorded (pinned before the
// channel was bridged): normalize it into the bridge message shape so the
// client renders it with the same component. id 0 = not jumpable.
function pinnedToBridgeMessage(m: DiscordApiMessage, channelId: string): bridge.BridgeMessage {
  const name = m.member?.nick || m.author.global_name || m.author.username
  const allAttachments = attachmentsFromApi(m.attachments)
  const ix = componentsFromRaw(m.components, allAttachments)
  return {
    id: 0,
    channelId,
    direction: 'discord',
    discordMessageId: m.id,
    authorKey: `discord:${m.author.id}`,
    authorName: name,
    authorAvatar: resolveMemberAvatarUrl(m.author.id, m.author.avatar || null),
    authorColor: null,
    authorRole: null,
    authorBot: Boolean(m.webhook_id) || m.author.bot === true,
    content: m.content || '',
    attachments: allAttachments.filter((a) => !ix.usedAttachmentUrls.has(a.url)),
    embeds: Array.isArray(m.embeds) ? m.embeds : [],
    mentions: (m.mentions || []).map((u) => ({ type: 'user', id: u.id, username: u.global_name || u.username })),
    messageType: typeof m.type === 'number' ? m.type : 0,
    interaction: interactionFromRaw({ type: m.type, interaction_metadata: m.interaction_metadata, interaction: m.interaction }),
    components: ix.components,
    flags: flagsFromRaw(m.flags),
    replyTo: null,
    replyMention: true,
    clientId: null,
    createdAt: m.timestamp,
    editedAt: m.edited_timestamp || null,
    deletedAt: null,
    reactions: [],
    forwarded: null,
  }
}

// --- Web (webhook) identities: effective roles for display ------------------
//
// A web identity (`user:<siteId>`) shows the roles it EFFECTIVELY holds -
// chatPermsForIdentity's roleIds (tier/perk chat roles ∪ onboarding grants, or
// a linked member's real roles) - exactly like Discord member roles: profile
// role pills, name color (incl. gradient role colors), role-mention popout
// membership. Only site-side data is served (username, approved avatar, site
// join date): never a Discord id, Discord dates, or a Discord avatar URL.
interface WebIdentityView {
  userId: number
  key: string
  /** Effective chat name (chat display name, else the site username). */
  username: string
  /** The site account username (the secondary handle line). */
  siteUsername: string
  /** The raw chat display name, null when the site username is used. */
  chatDisplayName: string | null
  avatar: string | null
  memberSince: string | null
  // True when the account is a linked guild member (already listed as a
  // Discord member in role-member lists).
  guildMember: boolean
  roles: bridge.GuildRole[]
  style: AuthorStyle
}

const WEB_IDENTITY_TTL_MS = 30_000
// Role id for the synthetic Admin chip of a site admin with no admin-tier chat role.
const SITE_ADMIN_ROLE_ID = 'site-admin'
const webIdentityCache = new Map<string, { expires: number; value: Promise<WebIdentityView | null> }>()

function webIdentityView(guildId: string, userId: number): Promise<WebIdentityView | null> {
  const cacheKey = `${guildId}:${userId}`
  const hit = webIdentityCache.get(cacheKey)
  if (hit && hit.expires > Date.now()) return hit.value
  const value = (async (): Promise<WebIdentityView | null> => {
    const target = await resolveWebhookTarget({ kind: 'site', userId })
    if (!target?.user) return null
    const perms = await chatPermsForIdentity(target, guildId)
    const roleIds = (perms.roleIds || []).filter((id) => id !== guildId)
    const [guildRoles, style, avatar, created] = await Promise.all([
      bridge.guildRolesByIds(guildId, roleIds).catch(() => [] as bridge.GuildRole[]),
      webAuthorStyle(guildId, roleIds),
      approvedAvatarUrlForUser(userId).catch(() => null),
      query<{ created: Date | null }>(`SELECT created FROM users WHERE id = $1`, [userId])
        .then((r) => r.rows[0]?.created ?? null).catch(() => null),
    ])
    // A site admin always shows the Admin chip, even when the guild role row
    // is missing (no admin-tier chat role configured): a synthetic entry.
    const admin = perms.siteAdmin
    const roles: bridge.GuildRole[] = admin && !guildRoles.some((r) => r.roleId === admin.roleId)
      ? [{ guildId, roleId: admin.roleId ?? SITE_ADMIN_ROLE_ID, name: admin.name, color: admin.color, position: admin.position, colors: null }, ...guildRoles]
      : guildRoles
    const memberSince = created ? new Date(created).toISOString() : null
    return {
      userId,
      key: siteChatKey(userId),
      username: effectiveChatName(target.user.username, target.user.chat_display_name),
      siteUsername: target.user.username,
      chatDisplayName: effectiveChatName(target.user.username, target.user.chat_display_name) === target.user.username
        ? null
        : target.user.chat_display_name?.trim() || null,
      avatar: avatar ?? null,
      memberSince,
      guildMember: Boolean(perms.memberId),
      roles,
      // The new member badge (isNewMember: joined ≤7 days ago) keys off the
      // same date the profile popout shows as "Member Since" - the site join
      // date, never a Discord date. A web identity is never a rejoin or a bot.
      style: { ...style, joinedAt: memberSince },
    }
  })()
  webIdentityCache.set(cacheKey, { expires: Date.now() + WEB_IDENTITY_TTL_MS, value })
  value.catch(() => webIdentityCache.delete(cacheKey))
  if (webIdentityCache.size > 2000) webIdentityCache.delete(webIdentityCache.keys().next().value as string)
  return value
}

// Drop cached web identity views (perks / onboarding / role changes).
function forgetWebIdentity(userId: number | null): void {
  // Other platforms' users have no site id to target: any identity change drops their (30s) views too.
  extIdentityCache.clear()
  if (userId === null) { webIdentityCache.clear(); return }
  for (const key of webIdentityCache.keys()) if (key.endsWith(`:${userId}`)) webIdentityCache.delete(key)
}

// Discord's default avatar for another platform's user, stable per key.
function extDefaultAvatar(key: string): string {
  let hash = 0
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return `https://cdn.discordapp.com/embed/avatars/${hash % 6}.png`
}

// Profile popout for another platform's user in one guild: the name they last posted under (or their own,
// for themselves), the roles their onboarding answers there grant, and when they first posted in the guild.
const extIdentityCache = new Map<string, { expires: number; value: Promise<Record<string, unknown> | null> }>()

function extIdentityView(guildId: string, key: string, ownName: string | null): Promise<Record<string, unknown> | null> {
  const cacheKey = `${guildId}:${key}:${ownName ?? ''}`
  const hit = extIdentityCache.get(cacheKey)
  if (hit && hit.expires > Date.now()) return hit.value
  const value = loadExtIdentityView(guildId, key, ownName)
  extIdentityCache.set(cacheKey, { expires: Date.now() + WEB_IDENTITY_TTL_MS, value })
  value.catch(() => extIdentityCache.delete(cacheKey))
  if (extIdentityCache.size > 2000) extIdentityCache.delete(extIdentityCache.keys().next().value as string)
  return value
}

async function loadExtIdentityView(guildId: string, key: string, ownName: string | null): Promise<Record<string, unknown> | null> {
  const seen = await query<{ author_name: string; first_at: Date | null }>(
    `SELECT (array_agg(m.author_name ORDER BY m.id DESC))[1] AS author_name, MIN(m.created_at) AS first_at
     FROM discord_bridge_message m JOIN discord_bridge_channel c ON c.channel_id = m.channel_id
     WHERE m.author_key = $1 AND c.guild_id = $2`,
    [key, guildId],
  ).then((r) => r.rows[0]).catch(() => undefined)
  const name = ownName || seen?.author_name
  if (!name) return null
  const perms = await chatPermsForIdentity({ userId: null, discordId: null, extKey: key, name, user: null }, guildId)
  const roleIds = (perms.roleIds || []).filter((id) => id !== guildId)
  const [roles, style] = await Promise.all([
    bridge.guildRolesByIds(guildId, roleIds).catch(() => [] as bridge.GuildRole[]),
    webAuthorStyle(guildId, roleIds),
  ])
  return {
    key,
    username: name,
    displayName: name,
    chatDisplayName: null,
    avatar: extDefaultAvatar(key),
    memberSince: seen?.first_at ? new Date(seen.first_at).toISOString() : null,
    pronouns: null,
    aboutMe: null,
    roles: roles.map((r) => ({ roleId: r.roleId, name: r.name, color: r.color, colors: roleColorsFor(r) })),
    style,
  }
}

// Discord's default avatar for a web identity without an approved upload
// (keyed by the site id, never a Discord id).
function webDefaultAvatar(userId: number): string {
  return `https://cdn.discordapp.com/embed/avatars/${userId % 6}.png`
}

// A reactor on the reactions popout / tooltip. Web reactors carry the site
// key ('user:<siteId>') and never a Discord id; Discord reactors carry the
// snowflake (their author key is public in history anyway).
export interface ReactorView {
  key: string
  name: string
  avatar: string
  color: string | null
  direction: 'web' | 'discord'
  discordId: string | null
}

const REACTOR_REST_LOOKUPS = 25
const reactorRestCache = new Map<string, { expires: number; name: string; avatar: string }>()

// Resolve stored reactor keys to display names/avatars. Web keys go through
// webIdentityView (site username, approved avatar or default, role colour).
// Discord keys use the bot-synced guild directory; a miss falls back to a
// cached REST member lookup, at most REACTOR_REST_LOOKUPS per request.
async function reactorViews(guildId: string, keys: string[]): Promise<ReactorView[]> {
  const unique = [...new Set(keys)].filter((k) => siteIdOfChatKey(k) !== null || /^discord:\d{15,22}$/.test(k) || extKeyOf(k) !== null).slice(0, 200)
  let restBudget = REACTOR_REST_LOOKUPS
  const discordIds = unique.filter((k) => k.startsWith('discord:')).map((k) => k.slice(8))
  const styles: Record<string, AuthorStyle | null> = discordIds.length
    ? await authorStylesFor(guildId, discordIds).catch(() => ({} as Record<string, AuthorStyle | null>))
    : {}
  const views = await Promise.all(unique.map(async (key): Promise<ReactorView> => {
    if (extKeyOf(key)) {
      const view = await extIdentityView(guildId, key, null).catch(() => null)
      return {
        key,
        name: typeof view?.username === 'string' ? view.username : 'Unknown user',
        avatar: extDefaultAvatar(key),
        color: (view?.style as AuthorStyle | null | undefined)?.color ?? null,
        direction: 'web',
        discordId: null,
      }
    }
    const webId = siteIdOfChatKey(key)
    if (webId !== null) {
      const userId = webId
      const view = await webIdentityView(guildId, userId).catch(() => null)
      return {
        key,
        name: view?.username || 'Unknown user',
        avatar: view?.avatar || webDefaultAvatar(userId),
        color: view?.style?.color ?? null,
        direction: 'web',
        discordId: null,
      }
    }
    const id = key.slice(8)
    const color = styles[id]?.color ?? null
    const stored = await bridge.guildMemberFor(guildId, id).catch(() => null)
    if (stored) {
      return { key, name: stored.displayName || stored.username, avatar: resolveMemberAvatarUrl(id, stored.avatar), color, direction: 'discord', discordId: id }
    }
    const cacheKey = `${guildId}:${id}`
    const cached = reactorRestCache.get(cacheKey)
    if (cached && cached.expires > Date.now()) {
      return { key, name: cached.name, avatar: cached.avatar, color, direction: 'discord', discordId: id }
    }
    if (restBudget <= 0) return { key, name: 'Unknown user', avatar: resolveMemberAvatarUrl(id, null), color, direction: 'discord', discordId: id }
    restBudget -= 1
    const raw = await fetchMemberProfile(guildId, id).catch(() => null)
    const u = raw?.user
    const m = raw?.member
    const name = m?.nick || u?.global_name || u?.username || 'Unknown user'
    const avatar = m?.avatar
      ? `https://cdn.discordapp.com/guilds/${guildId}/users/${id}/avatars/${m.avatar}.webp?size=64`
      : resolveMemberAvatarUrl(id, u?.avatar ?? null)
    reactorRestCache.set(cacheKey, { expires: Date.now() + 5 * 60 * 1000, name, avatar })
    if (reactorRestCache.size > 2000) reactorRestCache.delete(reactorRestCache.keys().next().value as string)
    return { key, name, avatar, color, direction: 'discord', discordId: id }
  }))
  return views
}

// Web identities holding `roleId` through their effective roles, for the
// role-mention popout: onboarding grants. Only identities with a webhook
// presence (chat history or an onboarding answer) are considered. Linked guild
// members are excluded (Discord already lists them).
async function webRoleHolders(guildId: string, roleId: string): Promise<WebIdentityView[]> {
  const candidates = new Set<number>(await onboardingRoleHolders(guildId, roleId, 300).catch(() => []))
  const views = await Promise.all([...candidates].slice(0, 300).map((id) => webIdentityView(guildId, id).catch(() => null)))
  return views.filter((v): v is WebIdentityView => Boolean(v && !v.guildMember && v.roles.some((r) => r.roleId === roleId)))
}

// Guild member list (id + display fields + role ids) for the role-mention
// popout. One paginated REST sweep per guild, cached briefly so repeated
// clicks don't hammer Discord. Capped at 5000 members.
const guildMemberListCache = new Map<string, { expires: number; members: Array<{ userId: string; username: string; displayName: string; avatar: string; roles: string[] }> }>()
async function guildMemberList(token: string, guildId: string) {
  const cached = guildMemberListCache.get(guildId)
  if (cached && cached.expires > Date.now()) return cached.members
  const members: Array<{ userId: string; username: string; displayName: string; avatar: string; roles: string[] }> = []
  let after = '0'
  for (let page = 0; page < 5; page++) {
    const resp = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members?limit=1000&after=${after}`, {
      headers: { Authorization: `Bot ${token}` },
    }).catch(() => null)
    if (!resp || !resp.ok) {
      if (page === 0) return null
      break
    }
    const list = (await resp.json().catch(() => [])) as Array<{ user?: DiscordApiUser & { bot?: boolean }; nick?: string | null; roles?: string[] }>
    for (const m of list) {
      if (!m.user) continue
      members.push({
        userId: m.user.id,
        username: m.user.username,
        displayName: m.nick || m.user.global_name || m.user.username,
        avatar: resolveMemberAvatarUrl(m.user.id, m.user.avatar || null),
        roles: Array.isArray(m.roles) ? m.roles : [],
      })
    }
    if (list.length < 1000) break
    after = list[list.length - 1]?.user?.id || after
  }
  guildMemberListCache.set(guildId, { expires: Date.now() + 60_000, members })
  return members
}

// Effective roles changed (a member's roles, chat-role definitions, a web
// identity's perks or onboarding answers): drop the cached web identity views
// so profiles / author colors / role-member lists pick it up.
let webIdentityInvalidation: (() => void) | null = null
function watchWebIdentityChanges(): void {
  if (webIdentityInvalidation) return
  webIdentityInvalidation = subscribe(DISCORD_BRIDGE_OWNER_KEY, (event) => {
    // The bot changed a guild's bridged channel set / layout: refetch that
    // guild's snapshot and its rail entry (the rail lists bridged guilds).
    if (event.type === 'bridge.channels.changed') {
      const payload = event.payload || {}
      invalidateForChannelsChanged(event.seq, payload)
      if (typeof payload.guildId === 'string') guildInfoCache.delete(payload.guildId)
      else guildInfoCache.clear()
      return
    }
    if (event.type !== 'bridge.perms.changed' && event.type !== 'bridge.onboarding.updated') return
    const payload = event.payload || {}
    const keys = [
      ...(Array.isArray(payload.keys) ? payload.keys : []),
      ...(Array.isArray(payload.targetKeys) ? payload.targetKeys : []),
    ].filter((k): k is string => typeof k === 'string')
    const siteIds = keys.map((k) => siteIdOfChatKey(k)).filter((id): id is number => id !== null)
    if (typeof payload.userId === 'number') siteIds.push(payload.userId)
    if (!siteIds.length) forgetWebIdentity(null)
    else for (const id of siteIds) forgetWebIdentity(id)
  })
}

// A page on another platform's origin (holt-service sets FOREIGN_PAGE_HEADER): abulxt's same-origin avatar
// paths in JSON bodies become absolute (chat-caller.ts absolutizeSiteAvatars). Sealed (binary) bodies are
// left alone; channel and guild lists, the sealed ones, carry no avatars.
let foreignPageSiteOrigin: string | null = null

function rewriteForForeignPage(response: ServerResponse): void {
  const origin = foreignPageSiteOrigin
  const end = response.end.bind(response) as (...args: unknown[]) => ServerResponse
  ;(response as unknown as { end: (...args: unknown[]) => ServerResponse }).end = (chunk?: unknown, ...rest: unknown[]) => {
    if (typeof chunk === 'string') chunk = absolutizeSiteAvatars(chunk, origin)
    return end(chunk, ...rest)
  }
}

// A refused Discord call (post-moderate): Discord's status and JSON code
// where they map, else 502.
async function discordFailure(response: ServerResponse, res: Response): Promise<void> {
  const body = (await res.json().catch(() => null)) as { code?: number; message?: string } | null
  if (res.status === 403) return sendJson(response, 403, { error: 'Missing Permissions', code: DiscordError.MISSING_PERMISSIONS })
  if (res.status === 404) return sendJson(response, 404, { error: 'Unknown post.', code: DiscordError.UNKNOWN_CHANNEL })
  if (res.status === 400 && typeof body?.code === 'number') {
    return sendJson(response, 400, { error: body.message || 'Discord refused the change.', code: body.code })
  }
  return sendJson(response, 502, { error: `Discord refused the change (HTTP ${res.status}).` })
}

export function discordBridgeApi(): Plugin {
  function register(server: { middlewares: ViteDevServer['middlewares'] }) {
    watchWebIdentityChanges()
    void loadConfig().then((config) => { foreignPageSiteOrigin = siteOriginOf(config) }).catch(() => {})
    // Any thrown error (e.g. a DB error from an out-of-range id) becomes a
    // generic 500 instead of an unhandled rejection that leaves the request
    // hanging; details stay in the server log.
    server.middlewares.use('/api/discord/bridge/', (request, response) => {
      if (request.headers[FOREIGN_PAGE_HEADER] === 'holt') rewriteForForeignPage(response)
      handleBridgeRequest(request, response).catch((error) => {
        console.warn('[bridge-api] request failed', error instanceof Error ? error.message : error)
        if (!response.headersSent) sendJson(response, 500, { error: 'Request failed.' })
        else response.end()
      })
    })
  }

  async function handleBridgeRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    {
      if (!dbConfigured()) return sendJson(response, 503, { error: 'Accounts database is not configured.' })
      await ensureSchema()
      const req = request as IncomingMessage
      const url = parseRequestUrl(req.url)
      // Connect strips the mount prefix ('/api/discord/bridge/'), so req.url is
      // already the sub-path ('/channels', '/history?…'). Normalize it.
      const path = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
      const identity = await resolveChatIdentity(req, await holtSessionSecret())

      // Server Onboarding + Browse Channels (discord-onboarding-api.ts).
      if (isOnboardingRoute(path)) return handleOnboardingRequest(path, req, response, identity)

      if (path === 'channels') {
        if (req.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' })
        const config = await loadConfig()
        const targets = bridgeTargets(config as Parameters<typeof bridgeTargets>[0])
        const configured = Boolean(config.discord?.botToken && (targets.channelIds.length || targets.categoryIds.length))
        // One bridged guild's sidebar (`guild` REQUIRED, validated against
        // the bridged guild set).
        const guildId = await bridgedGuildParam(url.searchParams.get('guild'))
        if (!guildId) return sendJson(response, 404, { ...UNKNOWN_GUILD })

        // Only BRIDGED channels are listed (unbridged live channels were
        // dropped), filtered by the caller's Discord sidebar 1:1: Discord's
        // permission-overwrite algorithm over the guild's live roles +
        // channel overwrites (cached ~45s, discord-channel-access.ts),
        // grouped under the real categories in Discord's order; a category is
        // listed only when it holds at least one listed channel.
        const bridged = await bridge.listChannels(true, guildId)
        const byId = new Map(bridged.map((c) => [c.channelId, c]))
        const perms = await chatPermsForUser(identity.user, guildId)
        const selfSubject = subjectOfUser(identity.user)
        // Bridged channels also honor the chat VIEW bit + webhook view
        // overwrites (the same gate /history applies), so the sidebar never
        // lists a channel whose history would 403.
        const viewableBridged = new Set<string>()
        if (hasPerm(perms.permissions, Perm.VIEW_MESSAGES)) {
          for (const c of bridged) if ((await overwriteFor(c.channelId, selfSubject, perms)).view) viewableBridged.add(c.channelId)
        }
        const lastIds = await bridge.lastMessageIds([...viewableBridged]).catch(() => new Map<string, number | null>())
        const channelOut = (c: { id: string; name: string; topic: string; position: number; type: number; parentId: string | null }) => {
          const known = byId.get(c.id)
          return {
            channelId: c.id,
            name: c.name || known?.name || c.id,
            topic: c.topic || known?.topic || '',
            position: c.position,
            type: c.type,
            parentId: c.parentId,
            locked: Boolean(known?.locked),
            bridged: true,
            guildId,
            // A forum's newest message in any post (bridge.lastMessageIds).
            lastMessageId: lastIds.get(c.id) ?? null,
            // Forum / media channels: tags, defaults, guidelines (contract.md).
            ...(known?.forum ? { forum: { ...known.forum, guidelines: c.topic || known.forum.guidelines } } : {}),
          }
        }
        const layout = config.discord?.botToken
          ? await visibleSidebar(identity.user, perms, guildId, (c) => viewableBridged.has(c.id), { optIn: true, onlyBridged: true }).catch(() => null)
          : null
        if (layout) {
          const channels = layout.channels.map((c) => channelOut({
            id: c.id, name: c.name, topic: c.topic || '', position: c.position, type: c.type, parentId: c.parent_id || null,
          }))
          const parents = new Set(channels.map((c) => c.parentId).filter(Boolean))
          const categories = layout.categories.filter((cat) => parents.has(cat.id))
          return sendSealedJson(req, response, { configured, categories, channels })
        }
        // Fallback: the guild snapshot is unavailable (token hiccup, Discord
        // outage). FAIL CLOSED: only channels @everyone can view on Discord
        // (everyone_can_view) that also pass the chat VIEW bit + webhook
        // overwrites; everything else stays hidden until the snapshot
        // returns. Category names aren't known without the snapshot, so the
        // list is categoryless (parentId null), but channels stay grouped by
        // their stored category (parent_id, migration 029) in position order.
        const fallback = bridged
          .filter((c) => c.everyoneCanView && viewableBridged.has(c.channelId))
          .sort((a, b) => (a.parentId || '').localeCompare(b.parentId || '') || a.position - b.position)
          .map((c) => channelOut({ id: c.channelId, name: c.name, topic: c.topic, position: c.position, type: c.type, parentId: null }))
        return sendSealedJson(req, response, { configured, categories: [], channels: fallback })
      }

      // Guilds (servers) for the left server rail: every BRIDGED guild (at
      // least one enabled discord_bridge_channel row) in which the caller can
      // VIEW at least one bridged channel (guests included). Each guild's
      // Discord REST object is cached per guild for 5 minutes; the
      // per-caller visibility filter runs on every request.
      if (path === 'guilds') {
        if (req.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' })
        const config = await loadConfig()
        const token = config.discord?.botToken
        if (!token) return sendSealedJson(req, response, { guilds: [] })

        type RestGuild = {
          id: string
          name: string
          icon: string | null
          banner?: string | null
          premium_tier?: number
          premium_subscription_count?: number
          features?: string[]
          rules_channel_id?: string | null
          vanity_url_code?: string | null
        }
        const toGuild = (g: RestGuild): BridgeGuildOut => ({
          id: g.id,
          name: g.name,
          icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.webp?size=96` : null,
          // Guild banner (GET /guilds/{id} → banner hash): Discord's channel
          // sidebar renders it at the top under the server header. Animated
          // hashes (a_ prefix) are GIFs.
          banner: g.banner
            ? `https://cdn.discordapp.com/banners/${g.id}/${g.banner}.${g.banner.startsWith('a_') ? 'gif' : 'webp'}?size=480`
            : null,
          // Boost level/count + features feed the guild-rail tooltip's badge
          // (Discord's GuildBadge: boosted Community servers get the
          // purple→pink flower).
          premiumTier: typeof g.premium_tier === 'number' ? g.premium_tier : 0,
          premiumSubscriptionCount: typeof g.premium_subscription_count === 'number' ? g.premium_subscription_count : 0,
          features: Array.isArray(g.features) ? g.features.filter((f): f is string => typeof f === 'string') : [],
          rulesChannelId: typeof g.rules_channel_id === 'string' ? g.rules_channel_id : null,
          inviteUrl: typeof g.vanity_url_code === 'string' && /^[\w-]{1,64}$/.test(g.vanity_url_code)
            ? `https://discord.gg/${g.vanity_url_code}`
            : null,
        })
        const guildInfo = async (id: string): Promise<BridgeGuildOut | null> => {
          const hit = guildInfoCache.get(id)
          if (hit && hit.expires > Date.now()) return hit.guild
          const resp = await fetch(`https://discord.com/api/v10/guilds/${id}`, {
            headers: { Authorization: `Bot ${token}` },
          }).catch(() => null)
          const g = resp && resp.ok ? ((await resp.json().catch(() => null)) as RestGuild | null) : null
          const guild = g && g.id && g.name ? toGuild(g) : null
          // A failed fetch is retried after 30s instead of the full window.
          guildInfoCache.set(id, { guild, expires: Date.now() + (guild ? GUILDS_CACHE_MS : 30_000) })
          return guild
        }

        // Bridged guilds the caller can view at least one channel in, in a
        // stable order: the home guild first, then by guild id.
        const viewable = await viewableBridgedChannels(identity.user)
        const home = configuredGuildId()
        const ids = [...new Set(viewable.map((c) => c.guildId))]
          .sort((a, b) => (a === home ? -1 : b === home ? 1 : a < b ? -1 : a > b ? 1 : 0))
        const guilds: BridgeGuildOut[] = []
        for (const id of ids) {
          const guild = await guildInfo(id)
          if (guild) guilds.push(guild)
        }
        return sendSealedJson(req, response, { guilds })
      }

      // Expressions config: exposes the KLIPY app key + gating to the web client.
      // Requests to KLIPY originate from the client's browser per KLIPY's terms;
      // the server only reveals the key to signed-in users who may send embeds.
      if (path === 'expressions') {
        if (req.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' })
        const channelId = url.searchParams.get('channel') || ''
        // The channel's guild (any bridged row), else the default guild.
        const exprChannel = channelId ? (await bridge.scopeFor(channelId).catch(() => null))?.channel ?? null : null
        const perms = await chatPermsForUser(identity.user, exprChannel?.guildId || (await defaultBridgedGuild()))
        const config = await loadConfig()
        const canSendEmbeds = hasPerm(perms.permissions, Perm.SEND_EMBEDS)
        return sendJson(response, 200, {
          provider: 'klipy',
          canSendEmbeds,
          // Only reveal the key when the caller may actually send embeds.
          klipyKey: canSendEmbeds ? (config.klipy?.apiKey || null) : null,
          channelId,
        })
      }

      // The caller's chat permissions for a channel: tier, bitfield, and any
      // active timeout. Drives the composer (disabled state, timeout countdown).
      // canSend / canReact come from the same writeDenialCore every write
      // route uses, so the composer can never disagree with /send or /react.
      // The guild is the channel's; with no channel, `guild` (validated
      // against the bridged set) or the default bridged guild.
      if (path === 'perms') {
        if (req.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' })
        const channelId = url.searchParams.get('channel') || ''
        // A forum post resolves to its forum: every gate below runs there.
        const scope = channelId ? await bridge.scopeFor(channelId) : null
        const channel = scope?.channel ?? null
        const gateChannelId = channel?.channelId || channelId
        const kind = scope ? scopeKind(scope) : 'channel'
        const permContext = kind === 'post' ? 'post' : 'channel'
        const post = scope?.post ?? null
        let permsGuildId: string
        if (channelId) {
          permsGuildId = channel?.guildId || (await defaultBridgedGuild())
        } else if (url.searchParams.get('guild')) {
          const g = await bridgedGuildParam(url.searchParams.get('guild'))
          if (!g) return sendJson(response, 404, { ...UNKNOWN_GUILD })
          permsGuildId = g
        } else {
          permsGuildId = await defaultBridgedGuild()
        }
        const basePerms = await chatPermsForUser(identity.user, permsGuildId)
        const subject = subjectOfUser(identity.user)
        const discordId = subject.discordId
        // A timed-out webhook's perms collapse to VIEW-only (Discord's muted
        // member) - for web-only, linked, and Discord identities alike.
        // Discord's channel permission math over the caller's effective roles
        // applies to guests too (a guest's onboarding role may grant SEND).
        const { perms, timeout } = channelId && identity.user
          ? await channelPermsFor(identity.user, basePerms, gateChannelId, subject, permsGuildId, permContext)
          : channelId
            ? { perms: applyDiscordChannelPerms(basePerms, await discordChannelBits(identity.user, basePerms, gateChannelId, permsGuildId).catch(() => null), permContext), timeout: null }
            : { perms: basePerms, timeout: null }
        const overwrites: EffectiveOverwrite = channelId
          ? await overwriteFor(gateChannelId, subject, perms)
          : { view: true, send: false, react: true, reply: false }
        const locked = Boolean(channel?.locked)
        // Discord-side VIEW_CHANNEL (live roles + overwrites), and writes only
        // ever land in bridged channels: an unbridged or unviewable channel is
        // read-only (or invisible) regardless of the chat bitfield.
        const discordView = channelId ? !(await discordViewDenied(identity.user, basePerms, gateChannelId, permsGuildId, Boolean(channel?.everyoneCanView))) : true
        const writable = !channelId || (Boolean(channel?.enabled) && discordView)
        const banned = identity.user ? await bridgeBanFor(identity.user, identity.ip, permsGuildId) : null
        const gateInput = {
          perms,
          // The composer prompts verification on Enter (requiresVerification
          // from /send); don't render it as a permission denial here.
          emailVerified: true,
          banned,
          discordView,
          overwrite: overwrites,
          locked,
          timeout,
          scope: kind,
          post: gatePost(scope),
        }
        // A pending post takes nothing yet; a forum takes posts, not messages
        // (writeDenialCore refuses 'send' there). In a post, canSend = canReply.
        const usable = writable && Boolean(identity.user) && !pendingPost(scope)
        const canSendFlag = usable && !writeDenialCore({ ...gateInput, action: 'send' })
        const canReactFlag = channelId
          ? usable && !writeDenialCore({ ...gateInput, action: 'react' })
          : hasPerm(perms.permissions, Perm.ADD_REACTIONS)
        const inForum = kind !== 'channel'
        const canCreatePostFlag = inForum && writable && Boolean(identity.user)
          && !writeDenialCore({ ...gateInput, scope: 'forum', post: null, action: 'post-create' })
        // Mention-permission flags (drive the composer's @everyone/@here and
        // role autocomplete gating). MENTION_EVERYONE implies MENTION_ROLES,
        // matching Discord's single-permission semantics. The timeout-reduced
        // bitfield drops both mention bits, muting mentions too.
        const canMentionEveryone = hasPerm(perms.permissions, Perm.MENTION_EVERYONE)
        const canMentionRoles = hasPerm(perms.permissions, Perm.MENTION_ROLES) || canMentionEveryone
        // The viewer's EFFECTIVE guild role set (real roles for a linked
        // member; tier + perk + onboarding roles for a web identity), so the
        // client can highlight role mentions for ANY role they hold
        // (perms.roleId is only their top chat role). Tolerant of Discord
        // outages - an empty list just means role pings won't highlight until
        // the next perms fetch. Always this guild's roles (no home fallback).
        const guildRoleIds = basePerms.roleIds || []
        // Moderation flags reflect the channel-effective (timeout-reduced)
        // bitfield and bans: a muted or banned moderator can't moderate.
        const canModerateHere = !banned
        return sendJson(response, 200, {
          tier: perms.tier,
          roleId: perms.roleId,
          roleName: perms.roleName,
          color: perms.color,
          position: perms.position,
          permissions: perms.permissions.toString(),
          guildRoleIds,
          guildId: permsGuildId,
          locked,
          // The caller's chat identity (the client calls it ownerKey): the chat key for a signed-in user,
          // never the account's event key. Guests keep their guest key.
          ownerKey: identity.user ? callerKey(identity.user) : identity.ownerKey,
          webhookKeys: webhookKeys(subject),
          canView: hasPerm(perms.permissions, Perm.VIEW_MESSAGES) && overwrites.view && discordView,
          canSend: canSendFlag,
          // Forum channels (contract.md): create a post here / reply in this
          // post / staff post actions (lock, pin, archive, tags, rename, delete).
          canCreatePost: canCreatePostFlag,
          canReply: kind === 'post' && canSendFlag,
          canManagePosts: inForum && !banned && canManagePosts(perms.permissions),
          ...(post ? { post: { id: post.id, forumId: post.forumId, locked: post.locked, archived: post.archived, pinned: post.pinned, ownerKey: post.ownerKey } } : {}),
          // Email verification is reported explicitly so the composer can say
          // "verify your email" (not a permission error) when that is the only
          // thing blocking sends in a channel that would otherwise allow them.
          emailVerified: identity.user ? Boolean(identity.user.email_verified) : null,
          sendBlockedByEmail: Boolean(identity.user) && !identity.user!.email_verified && canSendFlag,
          canReact: canReactFlag,
          canTimeout: canModerateHere && (hasPerm(perms.permissions, Perm.TIMEOUT_WEBHOOKS) || hasPerm(perms.permissions, Perm.MANAGE_WEBHOOKS)),
          canBan: canModerateHere && (hasPerm(perms.permissions, Perm.BAN_WEBHOOKS) || hasPerm(perms.permissions, Perm.MANAGE_WEBHOOKS)),
          canManageWebhook: canModerateHere && hasPerm(perms.permissions, Perm.MANAGE_WEBHOOKS),
          canMentionEveryone,
          canMentionRoles,
          canSendEmbeds: hasPerm(perms.permissions, Perm.SEND_EMBEDS) && canSendFlag,
          // Embed suppression (Discord's hover X on embeds): staff may remove
          // anyone's embeds, authors their own; Discord-originated messages
          // additionally need the bot's MANAGE_MESSAGES in this channel.
          embedSuppress: {
            bridged: Boolean(channel?.enabled),
            staff: canModerateHere && (hasPerm(perms.permissions, Perm.MANAGE_WEBHOOKS) || hasPerm(perms.permissions, Perm.BAN_WEBHOOKS)),
            botManageMessages: channelId && channel?.enabled ? await botCanManageMessages(gateChannelId, channel.guildId) : false,
            selfKeys: [...(identity.user ? callerKeys(identity.user) : [identity.ownerKey]), ...(discordId ? [`discord:${discordId}`] : [])],
          },
          banned,
          timeout,
        })
      }

      // Moderation view of ONE webhook (the user context menu / profile
      // popout): which moderation actions the caller may take against it in
      // this channel (bits + Discord role hierarchy + not-self, with the
      // caller's own timeout/ban applied), plus the target's active timeout,
      // ban, and member overwrite here. `target` is an author key
      // ('user:<siteId>' / 'discord:<snowflake>') or a bare snowflake;
      // web-only, linked, and Discord webhooks resolve identically.
      if (path === 'target') {
        if (req.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' })
        if (identity.isGuest || !identity.user) return sendJson(response, 401, { error: 'Sign in to chat.' })
        const channelId = url.searchParams.get('channel') || ''
        const parsed = parseWebhookTarget(url.searchParams.get('target'))
        if (!channelId || !parsed) return sendJson(response, 400, { error: 'Missing channel or target.' })
        const targetGate = await viewGate(identity.user, channelId)
        if (!targetGate.ok) return sendJson(response, targetGate.status, targetGate.body)
        const targetLimit = rateLimit(`bridge:target:${identity.ownerKey}`, { limit: 60, windowMs: 60_000, error: 'Too many requests. Slow down.' })
        if (!targetLimit.ok) {
          return sendRateLimited(response, targetLimit.retryAfterSec, targetLimit.error)
        }
        const target = await resolveWebhookTarget(parsed).catch(() => null)
        if (!target) return sendJson(response, 404, { error: 'Unknown webhook.' })
        const actorGate = await writeDenial(identity.user, identity.ip, targetGate.scope, 'moderate')
        const targetPerms = await chatPermsForIdentity(target, targetGate.guildId)
        const may = (action: ModerationAction) => actorGate.ok
          && !moderationDenial(action, { perms: actorGate.perms, subject: actorGate.subject }, { perms: targetPerms, subject: target })
        const staff = may('timeout') || may('ban') || may('unban') || may('webhook-perm')
        // Timeouts and overwrites live on the channel the gates run on (a
        // post's forum).
        const modChannelId = targetGate.bridged.channelId
        const overwrite = staff ? await memberOverwrite(modChannelId, target) : null
        return sendJson(response, 200, {
          key: webhookKey(target),
          keys: webhookKeys(target),
          userId: target.userId,
          discordId: target.discordId,
          name: target.name,
          tier: targetPerms.tier,
          position: targetPerms.position,
          canTimeout: may('timeout'),
          canUntimeout: may('untimeout'),
          canBan: may('ban'),
          canUnban: may('unban'),
          canManageWebhook: may('webhook-perm'),
          // Moderation state is staff-only detail.
          timeout: staff ? await activeTimeout(modChannelId, target) : null,
          banned: staff ? await webhookBanFor(target, targetGate.guildId) : null,
          overwrite: overwrite ? { allow: overwrite.allow.toString(), deny: overwrite.deny.toString() } : null,
          // Ping-limit counters since the app server started (in-memory):
          // neutralized mentions and AutoMod mention-spam blocks.
          mentionLimit: staff ? mentionLimiter.statsFor(webhookKeys(target)) : null,
        })
      }

      if (path === 'history') {
        if (req.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' })
        const channelId = url.searchParams.get('channel') || ''
        if (!channelId) return sendJson(response, 400, { error: 'Missing channel.' })
        // Gate viewing on Discord VIEW_CHANNEL plus the VIEW_MESSAGES bit and
        // webhook view overwrites (see viewGate; bridged channels only).
        const gate = await viewGate(identity.user, channelId)
        if (!gate.ok) return sendJson(response, gate.status, gate.body)
        const historyLimit = rateLimit(`bridge:history:${identity.ownerKey}`, {
          limit: 120,
          windowMs: 60_000,
          error: 'Too many history requests. Slow down.',
        })
        if (!historyLimit.ok) {
          return sendRateLimited(response, historyLimit.retryAfterSec, historyLimit.error)
        }
        // Discord-style cursors (GET /channels/{id}/messages): one of
        // before / after / around, limit 50 by default, max 100. `around`
        // serves jump-to-message (deep links, search/pins Jump, reply
        // previews) in one request instead of paging back to the target.
        const cursorParam = (name: string) => {
          const raw = url.searchParams.get(name)
          return raw && /^\d{1,20}$/.test(raw) ? raw : null
        }
        const beforeRaw = cursorParam('before')
        const afterRaw = cursorParam('after')
        const aroundRaw = cursorParam('around')
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100)
        // A post's messages live under its id (a delivered `post:<n>` resolves
        // to the thread); a forum itself has none.
        const page = await bridge.historyWindow(gate.scope.id, {
          before: beforeRaw ? Number(beforeRaw) : null,
          after: afterRaw ? Number(afterRaw) : null,
          around: aroundRaw,
        }, limit)
        return sendJson(response, 200, {
          // Expiring signed CDN URLs are refreshed (and persisted) first.
          messages: await refreshMessageMedia(page.messages, { persist: true }),
          hasMore: page.hasMoreBefore,
          hasMoreBefore: page.hasMoreBefore,
          hasMoreAfter: page.hasMoreAfter,
          ...(page.missing ? { missing: true } : {}),
        })
      }

      // Member/role directory for @mention autocomplete: resolves the channel
      // to its guild and returns matching members + roles. Requires the caller
      // can VIEW the channel (you can't autocomplete who you can't see).
      if (path === 'members') {
        if (req.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' })
        const channelId = url.searchParams.get('channel') || ''
        if (!channelId) return sendJson(response, 400, { error: 'Missing channel.' })
        // Composer autocomplete: same VIEW gate as /history.
        const membersGate = await viewGate(identity.user, channelId)
        if (!membersGate.ok) return sendJson(response, membersGate.status, membersGate.body)
        const channel = membersGate.bridged
        const membersLimit = rateLimit(`bridge:members:${identity.ownerKey}`, {
          limit: 60,
          windowMs: 60_000,
          error: 'Too many autocomplete requests. Slow down.',
        })
        if (!membersLimit.ok) {
          return sendRateLimited(response, membersLimit.retryAfterSec, membersLimit.error)
        }
        const q = (url.searchParams.get('q') || '').slice(0, 100)
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 8, 1), 25)
        const [members, roles] = await Promise.all([
          bridge.searchGuildMembers(channel.guildId, q, limit).catch(() => []),
          bridge.searchGuildRoles(channel.guildId, q, limit).catch(() => []),
        ])
        // Channels for the '#' autocomplete trigger: this guild's bridged
        // channels (the same ones its sidebar shows), name-filtered by q.
        // Discord's '#q' matches case-insensitively against channel names.
        const qLower = q.toLowerCase()
        const candidates = (await bridge.listChannels(true, channel.guildId).catch(() => []))
          .filter((c) => !qLower || c.name.toLowerCase().includes(qLower))
        // Never suggest a channel the caller can't VIEW on Discord.
        const channels: typeof candidates = []
        for (const c of candidates) {
          if (channels.length >= limit) break
          const access = await channelAccess(identity.user, membersGate.perms, c.channelId, channel.guildId)
          if (discordViewAllowed(access, c.everyoneCanView)) channels.push(c)
        }
        return sendJson(response, 200, {
          members: members.map((m) => ({ userId: m.userId, username: m.username, displayName: m.displayName, avatar: resolveMemberAvatarUrl(m.userId, m.avatar) })),
          roles: roles.map((r) => ({ roleId: r.roleId, name: r.name, color: r.color, colors: roleColorsFor(r) })),
          channels: channels.map((c) => ({ channelId: c.channelId, name: c.name })),
        })
      }

      // Discord's message search (channel-header search bar → results
      // sidebar). Query params, Discord's search API names where they exist:
      //   content, author_id (repeat, from:), mentions (repeat), has (repeat),
      //   author_name / mention_name (repeat; a typed from:/mentions: name the
      //   client has no id for - resolved server-side, no match = no results),
      //   before / after / during (YYYY-MM-DD, caller-local via tz=minutes),
      //   min_time / max_time (ISO instants - the client resolves Discord's
      //   date answers like `today`, `june`, `2024` to a [start, end) range,
      //   the way Discord sends min_id/max_id), author_type (repeat;
      //   user|bot|webhook, `-x` negates), has accepts `-x` negation too,
      //   channel_id (repeat, in:), sort = newest|oldest|relevance, offset.
      // Only bridged channels the caller can VIEW are searched; a requested
      // channel_id outside that set is silently dropped (no existence leak).
      // Deleted messages never match. Rate limited Discord-style (429 +
      // { message, retry_after }).
      if (path === 'search') {
        if (req.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' })
        const sp = url.searchParams
        const content = (sp.get('content') || '').slice(0, SEARCH_MAX_CONTENT)
        const authorIds = [...new Set(sp.getAll('author_id'))].filter((id) => SNOWFLAKE.test(id)).slice(0, SEARCH_MAX_IDS)
        const mentionIds = [...new Set(sp.getAll('mentions'))].filter((id) => SNOWFLAKE.test(id)).slice(0, SEARCH_MAX_IDS)
        // Typed from:/mentions: names the client couldn't resolve to an id
        // (resolved in searchMessages: username, then display name). They
        // share the SEARCH_MAX_IDS cap with the ids of the same filter.
        const searchNames = (key: string, cap: number) => [...new Set(sp.getAll(key).map((n) => n.trim().toLowerCase()))]
          .filter((n) => n.length > 0 && n.length <= SEARCH_MAX_NAME).slice(0, Math.max(0, cap))
        const authorNames = searchNames('author_name', SEARCH_MAX_IDS - authorIds.length)
        const mentionNames = searchNames('mention_name', SEARCH_MAX_IDS - mentionIds.length)
        const hasRaw = [...new Set(sp.getAll('has'))].slice(0, 20)
        const has = hasRaw.filter((h): h is bridge.SearchHas => SEARCH_HAS.has(h as bridge.SearchHas))
        const notHas = hasRaw.filter((h) => h.startsWith('-')).map((h) => h.slice(1))
          .filter((h): h is bridge.SearchHas => SEARCH_HAS.has(h as bridge.SearchHas))
        const AUTHOR_TYPES = new Set<bridge.SearchAuthorType>(['user', 'bot', 'webhook'])
        const atRaw = [...new Set(sp.getAll('author_type'))].slice(0, 6)
        const authorTypes = atRaw.filter((t): t is bridge.SearchAuthorType => AUTHOR_TYPES.has(t as bridge.SearchAuthorType))
        const notAuthorTypes = atRaw.filter((t) => t.startsWith('-')).map((t) => t.slice(1))
          .filter((t): t is bridge.SearchAuthorType => AUTHOR_TYPES.has(t as bridge.SearchAuthorType))
        const requestedChannels = [...new Set(sp.getAll('channel_id'))].filter((id) => SNOWFLAKE.test(id)).slice(0, 50)
        // Optional `guild`: limit results to that bridged guild's channels.
        const searchGuildRaw = sp.get('guild')
        const searchGuild = searchGuildRaw ? await bridgedGuildParam(searchGuildRaw) : null
        if (searchGuildRaw && !searchGuild) return sendJson(response, 404, { ...UNKNOWN_GUILD })
        const tzRaw = Number(sp.get('tz') || 0)
        const tz = Number.isFinite(tzRaw) ? Math.max(-840, Math.min(840, Math.trunc(tzRaw))) : 0
        let minTime: Date | null = null
        let maxTime: Date | null = null
        const later = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a > b ? a : b)
        const earlier = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a < b ? a : b)
        const before = sp.get('before')
        const after = sp.get('after')
        const during = sp.get('during')
        // before: → strictly before that local day; after: → from the next
        // local day on; during: → that local day only (Discord semantics).
        if (before) { const d = localDayStart(before, tz); if (!d) return sendJson(response, 400, { error: 'Invalid before date.' }); maxTime = earlier(maxTime, d) }
        if (after) { const d = localDayStart(after, tz, 1); if (!d) return sendJson(response, 400, { error: 'Invalid after date.' }); minTime = later(minTime, d) }
        if (during) {
          const start = localDayStart(during, tz)
          const end = localDayStart(during, tz, 1)
          if (!start || !end) return sendJson(response, 400, { error: 'Invalid during date.' })
          minTime = later(minTime, start)
          maxTime = earlier(maxTime, end)
        }
        // Explicit instants (Discord min_id/max_id analogue). Bounded to the
        // service's lifetime so a bogus value can't produce an absurd range.
        const instant = (v: string | null) => {
          if (!v || v.length > 40) return null
          const d = new Date(v)
          const y = d.getUTCFullYear()
          return Number.isFinite(d.getTime()) && y >= 2015 && y <= 2100 ? d : null
        }
        const minRaw = sp.get('min_time')
        const maxRaw = sp.get('max_time')
        if (minRaw) { const d = instant(minRaw); if (!d) return sendJson(response, 400, { error: 'Invalid min_time.' }); minTime = later(minTime, d) }
        if (maxRaw) { const d = instant(maxRaw); if (!d) return sendJson(response, 400, { error: 'Invalid max_time.' }); maxTime = earlier(maxTime, d) }
        const sortRaw = sp.get('sort') || 'newest'
        const sort: bridge.SearchSort = sortRaw === 'oldest' || sortRaw === 'relevance' ? sortRaw : 'newest'
        const offsetRaw = Number(sp.get('offset') || 0)
        const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.min(SEARCH_MAX_OFFSET, Math.trunc(offsetRaw))) : 0
        if (!content.trim() && !authorIds.length && !mentionIds.length && !authorNames.length && !mentionNames.length && !has.length && !notHas.length && !authorTypes.length && !notAuthorTypes.length && !minTime && !maxTime && !sp.getAll('channel_id').length) {
          return sendJson(response, 400, { error: 'Search query is empty.' })
        }

        const userHit = rateLimit(`bridge:search:${identity.ownerKey}`, SEARCH_USER_LIMIT)
        if (!userHit.ok) return sendSearchRateLimited(response, userHit.retryAfterSec)
        if (!identity.isGuest) {
          const ipHit = rateLimit(`bridge:search-ip:${identity.ip}`, SEARCH_IP_LIMIT)
          if (!ipHit.ok) return sendSearchRateLimited(response, ipHit.retryAfterSec)
        }

        const viewable = await viewableBridgedChannels(identity.user, searchGuild || undefined)
        // A forum's messages live in its posts: a viewable forum makes its
        // posts searchable (and `channel_id` may name a forum or one post).
        const forums = viewable.filter((c) => bridge.isForumType(c.type))
        const posts = await bridge.postsOfForums(forums.map((c) => c.channelId)).catch(() => [] as Array<{ id: string; forumId: string; name: string }>)
        const forumGuild = new Map(forums.map((c) => [c.channelId, c.guildId]))
        const postsByForum = new Map<string, string[]>()
        for (const p of posts) postsByForum.set(p.forumId, [...(postsByForum.get(p.forumId) || []), p.id])
        const viewableIds = new Set([...viewable.filter((c) => !bridge.isForumType(c.type)).map((c) => c.channelId), ...posts.map((p) => p.id)])
        const channelGuild = new Map<string, string>([
          ...viewable.map((c): [string, string] => [c.channelId, c.guildId]),
          ...posts.map((p): [string, string] => [p.id, forumGuild.get(p.forumId) || '']),
        ])
        const requestedPostIds = [...new Set(sp.getAll('channel_id'))].filter((id) => bridge.parsePendingPostId(id) !== null).slice(0, 50)
        const requested = [...requestedChannels, ...requestedPostIds].flatMap((id) => postsByForum.get(id) || [id])
        const channelIds = requested.length
          ? [...new Set(requested.filter((id) => viewableIds.has(id)))]
          : [...viewableIds]
        if (!channelIds.length) {
          return sendJson(response, 200, { totalResults: 0, offset, limit: SEARCH_PAGE_SIZE, messages: [], channels: [] })
        }
        try {
          const { total, messages } = await bridge.searchMessages({
            channelIds,
            guildIds: [...new Set(channelIds.map((id) => channelGuild.get(id) || '').filter(Boolean))],
            content,
            authorIds,
            mentionIds,
            authorNames,
            mentionNames,
            has,
            notHas,
            authorTypes,
            notAuthorTypes,
            minTime,
            maxTime,
            sort,
            offset,
            limit: SEARCH_PAGE_SIZE,
          })
          const names = new Map([...viewable.map((c): [string, string] => [c.channelId, c.name]), ...posts.map((p): [string, string] => [p.id, p.name])])
          const used = [...new Set(messages.map((m) => m.channelId))]
          return sendJson(response, 200, {
            totalResults: total,
            offset,
            limit: SEARCH_PAGE_SIZE,
            messages: await refreshMessageMedia(messages, { persist: true }),
            // A post result also names its forum (the jump target's parent).
            channels: used.map((id) => {
              const forumId = posts.find((p) => p.id === id)?.forumId
              return { channelId: id, name: names.get(id) || 'unknown', ...(forumId ? { forumId } : {}) }
            }),
          })
        } catch (err) {
          // 57014 = query_canceled (statement_timeout).
          const timedOut = (err as { code?: string })?.code === '57014'
          return sendJson(response, timedOut ? 503 : 500, {
            error: timedOut ? 'Search took too long. Try a more specific query.' : 'Search failed.',
          })
        }
      }

      // Author cosmetics for Discord-side message authors (the web client
      // batches the discord:<id> author keys it renders): enhanced role
      // colors (gradient/holographic names), avatar decoration, server tag,
      // nameplate, display-name font, and joined_at for the new-member badge.
      // Read from the bot-synced directory (60s cache, no Discord REST), same
      // VIEW gate as /history. Unknown ids map to null.
      if (path === 'authors') {
        if (req.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' })
        const channelId = url.searchParams.get('channel') || ''
        const requested = (url.searchParams.get('ids') || '').split(',')
        const ids = requested.filter((id) => /^\d{15,22}$/.test(id)).slice(0, 100)
        // Web (webhook) authors by key ('user:<siteId>'): their effective
        // roles' color (incl. gradients); no member cosmetics.
        const webKeys = [...new Set(requested.filter((key) => siteIdOfChatKey(key) !== null || extKeyOf(key) !== null))].slice(0, 50)
        if (!channelId) return sendJson(response, 400, { error: 'Missing channel.' })
        if (!ids.length && !webKeys.length) return sendJson(response, 200, { authors: {} })
        const authorsGate = await viewGate(identity.user, channelId)
        if (!authorsGate.ok) return sendJson(response, authorsGate.status, authorsGate.body)
        const authorsLimit = rateLimit(`bridge:authors:${identity.ownerKey}`, {
          limit: 120,
          windowMs: 60_000,
          error: 'Too many requests. Slow down.',
        })
        if (!authorsLimit.ok) {
          return sendRateLimited(response, authorsLimit.retryAfterSec, authorsLimit.error)
        }
        const authors: Record<string, AuthorStyle | null> = ids.length ? await authorStylesFor(authorsGate.guildId, ids).catch(() => ({})) : {}
        const webStyles = await Promise.all(webKeys.map((key) => (extKeyOf(key)
          ? extIdentityView(authorsGate.guildId, key, null).then((v) => (v?.style as AuthorStyle | undefined) ?? null)
          : webIdentityView(authorsGate.guildId, siteIdOfChatKey(key)!).then((v) => v?.style ?? null)).catch(() => null)))
        webKeys.forEach((key, i) => { authors[key] = webStyles[i] ?? null })
        return sendJson(response, 200, { authors })
      }

      // Reactors for one emoji on one message (Discord's reactions popout and
      // the reaction tooltip). The bridge bot never counts. Same VIEW gate as
      // /history on the message's channel; per-identity rate limit.
      if (path === 'reactors') {
        if (req.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' })
        const messageId = Number(url.searchParams.get('message') || '')
        const emoji = (url.searchParams.get('emoji') || '').slice(0, 64)
        if (!Number.isSafeInteger(messageId) || messageId <= 0 || !emoji) {
          return sendJson(response, 400, { error: 'Missing message or emoji.' })
        }
        const message = await bridge.messageFor(messageId)
        if (!message || message.deletedAt) {
          return sendJson(response, 404, { error: 'Unknown message.', code: DiscordError.UNKNOWN_MESSAGE })
        }
        const reactorsGate = await viewGate(identity.user, message.channelId)
        if (!reactorsGate.ok) return sendJson(response, reactorsGate.status, reactorsGate.body)
        const reactorsLimit = rateLimit(`bridge:reactors:${identity.ownerKey}`, {
          limit: 60,
          windowMs: 60_000,
          error: 'Too many requests. Slow down.',
        })
        if (!reactorsLimit.ok) {
          return sendRateLimited(response, reactorsLimit.retryAfterSec, reactorsLimit.error)
        }
        const reaction = (await bridge.reactionsFor(messageId)).find((r) => r.emoji === emoji)
        const keys = reaction ? reaction.reactorKeys : []
        const reactors = await reactorViews(reactorsGate.guildId, keys)
        return sendJson(response, 200, { emoji, count: keys.length, reactors })
      }

      // Server-tag popout (Discord's GuildProfile card opened from a
      // primary_guild chiplet): whatever public guild info the bot token can
      // read - /guilds/{id}/profile, /preview, the guild itself when the bot
      // is a member, or the public widget. Cached per guild (discord-guild-
      // tag.ts), same VIEW gate as /authors, per-identity rate limit.
      if (path === 'guild-tag') {
        if (req.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' })
        const channelId = url.searchParams.get('channel') || ''
        const guildId = url.searchParams.get('guild') || ''
        if (!channelId || !/^\d{15,22}$/.test(guildId)) return sendJson(response, 400, { error: 'Missing channel or guild.' })
        const tagGate = await viewGate(identity.user, channelId)
        if (!tagGate.ok) return sendJson(response, tagGate.status, tagGate.body)
        const tagLimit = rateLimit(`bridge:guild-tag:${identity.ownerKey}`, {
          limit: 30,
          windowMs: 60_000,
          error: 'Too many requests. Slow down.',
        })
        if (!tagLimit.ok) {
          return sendRateLimited(response, tagLimit.retryAfterSec, tagLimit.error)
        }
        const profile = await guildTagProfile(guildId).catch(() => null)
        if (!profile) return sendJson(response, 502, { error: 'Unable to load server profile' })
        return sendJson(response, 200, profile)
      }

      // Profile popout data for a Discord-side author (authorKey 'discord:<id>'
      // or a <@id> mention): Discord's bite-size popout fields that a bot can
      // read - username/global name/nick, avatar, banner/accent color, bot
      // flag, account-created + guild-joined dates, and the member's roles
      // (names/colors from the synced role table). Web (webhook) authors have
      // no Discord identity exposed here; the client renders them from the
      // message fields alone. Same VIEW gate as `members`.
      if (path === 'profile') {
        if (req.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' })
        const channelId = url.searchParams.get('channel') || ''
        const userId = url.searchParams.get('user') || ''
        if (!channelId || !/^\d{15,22}$/.test(userId)) return sendJson(response, 400, { error: 'Missing channel or user.' })
        // Same VIEW gate as /history.
        const profileGate = await viewGate(identity.user, channelId)
        if (!profileGate.ok) return sendJson(response, profileGate.status, profileGate.body)
        const channel = { guildId: profileGate.guildId }
        const cacheKey = `${channel.guildId}:${userId}`
        const cached = profileCache.get(cacheKey)
        if (cached && cached.expires > Date.now()) return sendJson(response, 200, cached.body)
        const profileLimit = rateLimit(`bridge:profile:${identity.ownerKey}`, {
          limit: 30,
          windowMs: 60_000,
          error: 'Too many profile requests. Slow down.',
        })
        if (!profileLimit.ok) {
          return sendRateLimited(response, profileLimit.retryAfterSec, profileLimit.error)
        }
        const raw = await fetchMemberProfile(channel.guildId, userId).catch(() => ({ member: null, user: null }))
        const stored = await bridge.guildMemberFor(channel.guildId, userId).catch(() => null)
        if (!raw.user && !stored) return sendJson(response, 404, { error: 'Unknown user.' })
        const roleIds = new Set(raw.member?.roles || [])
        const roleRows = roleIds.size
          ? (await bridge.searchGuildRoles(channel.guildId, '', 50).catch(() => [])).filter((r) => roleIds.has(r.roleId))
          : []
        for (const id of roleIds) {
          if (roleRows.some((r) => r.roleId === id)) continue
          const r = await bridge.guildRoleFor(channel.guildId, id).catch(() => null)
          if (r) roleRows.push(r)
        }
        roleRows.sort((a, b) => b.position - a.position)
        const u = raw.user
        const m = raw.member
        const cdn = 'https://cdn.discordapp.com'
        const avatar = m?.avatar
          ? `${cdn}/guilds/${channel.guildId}/users/${userId}/avatars/${m.avatar}.webp?size=128`
          : u?.avatar
            ? `${cdn}/avatars/${userId}/${u.avatar}.webp?size=128`
            : resolveMemberAvatarUrl(userId, stored?.avatar ?? null)
        const bannerHash = m?.banner || u?.banner || null
        const banner = bannerHash
          ? (m?.banner ? `${cdn}/guilds/${channel.guildId}/users/${userId}/banners/${bannerHash}.webp?size=600` : `${cdn}/banners/${userId}/${bannerHash}.webp?size=600`)
          : null
        // Discord snowflake → account creation time (ms since the 2015 epoch).
        const createdAt = new Date(Number((BigInt(userId) >> 22n) + 1420070400000n)).toISOString()
        const body = {
          userId,
          username: u?.username || stored?.username || userId,
          globalName: u?.global_name || null,
          displayName: m?.nick || u?.global_name || stored?.displayName || u?.username || stored?.username || userId,
          avatar,
          banner,
          accentColor: typeof u?.accent_color === 'number' ? `#${u.accent_color.toString(16).padStart(6, '0')}` : null,
          bot: Boolean(u?.bot),
          createdAt,
          joinedAt: m?.joined_at || null,
          inGuild: Boolean(m),
          roles: roleRows
            .filter((r) => r.roleId !== channel.guildId) // @everyone
            .map((r) => ({ roleId: r.roleId, name: r.name, color: r.color, colors: roleColorsFor(r) })),
          style: profileStyle(await authorStyleFor(channel.guildId, userId).catch(() => null), raw, roleRows),
        }
        profileCache.set(cacheKey, { expires: Date.now() + 5 * 60_000, body })
        if (profileCache.size > 500) profileCache.delete(profileCache.keys().next().value as string)
        return sendJson(response, 200, body)
      }

      // The signed-in user's own account popout (user panel). Guild-independent
      // and channel-free: site username, approved site avatar (else the linked
      // Discord avatar, else the default), site join date ("Member Since") and
      // the linked Discord identity from the users table. No guild roles, guild
      // join date, guild name/icon or guild tags. Auth only, no VIEW gate.
      if (path === 'self-profile') {
        if (req.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' })
        if (identity.isGuest || !identity.user) return sendJson(response, 401, { error: 'Sign in to chat.' })
        const selfLimit = rateLimit(`bridge:self-profile:${identity.ownerKey}`, { limit: 30, windowMs: 60_000, error: 'Too many profile requests. Slow down.' })
        if (!selfLimit.ok) return sendRateLimited(response, selfLimit.retryAfterSec, selfLimit.error)
        // Another platform's user: the name their platform gave holt. Roles show per guild (webhook-profile).
        if (isExtUser(identity.user)) {
          const ext = identity.user
          return sendJson(response, 200, {
            userId: ext.ext_key, username: ext.username, displayName: ext.username, chatDisplayName: null,
            avatar: extDefaultAvatar(ext.ext_key), memberSince: null, pronouns: null, aboutMe: null, roles: [], discord: null,
          })
        }
        const me = identity.user
        const [siteAvatar, created] = await Promise.all([
          approvedAvatarUrlForUser(me.id).catch(() => null),
          query<{ created: Date | null }>(`SELECT created FROM users WHERE id = $1`, [me.id])
            .then((r) => r.rows[0]?.created ?? null).catch(() => null),
        ])
        // Site admins show the Admin chip (guild-independent: only the admin
        // role entry, never the guild's roles; the default guild's admin role).
        const adminChip = me.admin ? await siteAdminRole(await defaultBridgedGuild()) : null
        const discordId = me.discord_id || null
        const discordAvatar = discordId && me.discord_avatar
          ? (/^https?:\/\//i.test(me.discord_avatar)
            ? me.discord_avatar
            : `https://cdn.discordapp.com/avatars/${discordId}/${me.discord_avatar}.webp?size=128`)
          : null
        return sendJson(response, 200, {
          userId: String(me.id),
          username: me.username,
          displayName: effectiveChatName(me.username, me.chat_display_name),
          chatDisplayName: me.chat_display_name?.trim() || null,
          avatar: siteAvatar ?? discordAvatar ?? webDefaultAvatar(me.id),
          memberSince: created ? new Date(created).toISOString() : null,
          pronouns: me.pronouns ?? null,
          aboutMe: me.about_me ?? null,
          roles: adminChip
            ? [{ roleId: adminChip.roleId ?? SITE_ADMIN_ROLE_ID, name: adminChip.name, color: adminChip.color, colors: null }]
            : [],
          discord: discordId
            ? { username: me.discord_username || null, name: me.discord_name || null, avatar: discordAvatar }
            : null,
        })
      }

      // Profile popout data for a web (webhook) identity - another author's
      // `user:<siteId>` key, or `self` for the signed-in caller's account
      // popout: display name, approved avatar, site join date ("Member
      // Since") and the EFFECTIVE roles it holds (webIdentityView), sorted by
      // position like Discord member roles. Never a Discord id/date/avatar.
      // Same VIEW gate as `profile`.
      // Public presence for web identities ('user:<siteId>' keys): online /
      // idle / dnd / offline (invisible reads offline). Same VIEW gate as the
      // author rows it decorates; site ids only, never a Discord id.
      if (path === 'presence') {
        if (req.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' })
        const channelId = url.searchParams.get('channel') || ''
        const presenceKeys = [...new Set((url.searchParams.get('keys') || '').split(',')
          .filter((key) => siteIdOfChatKey(key) !== null))].slice(0, 100)
        if (!channelId) return sendJson(response, 400, { error: 'Missing channel.' })
        const presenceGate = await viewGate(identity.user, channelId)
        if (!presenceGate.ok) return sendJson(response, presenceGate.status, presenceGate.body)
        const presence: Record<string, PublicPresence> = {}
        for (const key of presenceKeys) presence[key] = presencePublicFor(siteIdOfChatKey(key)!)
        return sendJson(response, 200, { presence })
      }

      if (path === 'webhook-profile') {
        if (req.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' })
        const channelId = url.searchParams.get('channel') || ''
        const rawKey = url.searchParams.get('key') || ''
        const selfKey = rawKey === 'self'
        const parsedKey = selfKey ? null : parseWebhookTarget(rawKey)
        // Another platform's user (their key, or `self` for one): their effective roles in this guild.
        const extKey = selfKey ? (isExtUser(identity.user) ? identity.user.ext_key : null) : parsedKey?.kind === 'ext' ? parsedKey.key : null
        if (channelId && extKey) {
          const extGate = await viewGate(identity.user, channelId)
          if (!extGate.ok) return sendJson(response, extGate.status, extGate.body)
          const extLimit = rateLimit(`bridge:profile:${identity.ownerKey}`, { limit: 30, windowMs: 60_000, error: 'Too many profile requests. Slow down.' })
          if (!extLimit.ok) return sendRateLimited(response, extLimit.retryAfterSec, extLimit.error)
          const ownName = isExtUser(identity.user) && identity.user.ext_key === extKey ? identity.user.username : null
          const view = await extIdentityView(extGate.guildId, extKey, ownName).catch(() => null)
          if (!view) return sendJson(response, 404, { error: 'Unknown user.' })
          return sendJson(response, 200, view)
        }
        const siteId = selfKey ? (identity.user?.id ?? null) : parsedKey?.kind === 'site' ? parsedKey.userId : null
        if (!channelId || (!selfKey && siteId === null)) return sendJson(response, 400, { error: 'Missing channel or key.' })
        if (siteId === null) return sendJson(response, 401, { error: 'Sign in to chat.' })
        const whGate = await viewGate(identity.user, channelId)
        if (!whGate.ok) return sendJson(response, whGate.status, whGate.body)
        const whLimit = rateLimit(`bridge:profile:${identity.ownerKey}`, { limit: 30, windowMs: 60_000, error: 'Too many profile requests. Slow down.' })
        if (!whLimit.ok) return sendRateLimited(response, whLimit.retryAfterSec, whLimit.error)
        const view = await webIdentityView(whGate.guildId, siteId).catch(() => null)
        if (!view) return sendJson(response, 404, { error: 'Unknown user.' })
        const profileText = await query<{ pronouns: string | null; about_me: string | null }>(
          'SELECT pronouns, about_me FROM users WHERE id = $1', [siteId],
        ).then((r) => ({ pronouns: r.rows[0]?.pronouns ?? null, aboutMe: r.rows[0]?.about_me ?? null })).catch(() => ({ pronouns: null, aboutMe: null }))
        return sendJson(response, 200, {
          key: view.key,
          username: view.siteUsername,
          displayName: view.username,
          chatDisplayName: view.chatDisplayName,
          avatar: view.avatar,
          memberSince: view.memberSince,
          presence: presencePublicFor(siteId),
          pronouns: profileText.pronouns,
          aboutMe: profileText.aboutMe,
          roles: view.roles.map((r) => ({ roleId: r.roleId, name: r.name, color: r.color, colors: roleColorsFor(r) })),
          style: view.style,
        })
      }

      if (path === 'send') {
        if (req.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' })
        if (identity.isGuest || !identity.user) {
          return sendJson(response, 401, { error: 'Sign in to chat.' })
        }
        const sendLimit = rateLimit(`bridge:send:${identity.ownerKey}`, {
          limit: 12,
          windowMs: 10_000,
          error: 'You are sending messages too fast.',
        })
        if (!sendLimit.ok) {
          return sendRateLimited(response, sendLimit.retryAfterSec, sendLimit.error)
        }

        const body = await readBody(req)
        const channelId = typeof body.channelId === 'string' ? body.channelId : ''
        // A post id sends a reply in that post (gated on its forum).
        const scope = channelId ? await bridge.scopeFor(channelId) : null
        if (pendingPost(scope)) return sendJson(response, 409, { ...PENDING_POST })
        // The shared write gate: bridged channel, email verification, ban,
        // VIEW, timeout, SEND_MESSAGES + overwrites, lockdown (staff bypass;
        // admins/owners bypass overwrites - Discord Administrator). In a post:
        // SEND_IN_POSTS and the post's locked state; a forum takes no messages.
        const sendGate = await writeDenial(identity.user, identity.ip, scope, 'send')
        if (!sendGate.ok) return sendJson(response, sendGate.status, sendGate.body)
        if (!scope) return sendJson(response, 404, { error: 'Unknown channel.', code: DiscordError.UNKNOWN_CHANNEL })
        const channel = scope.channel
        const sendPerms = sendGate.perms

        const rawContent = sanitizeContent(typeof body.content === 'string' ? body.content : '')
        // Permission-aware mention pass: decides per-mention whether it pings
        // (kept as a live token + recorded in message.mentions) or degrades to
        // inert plain text, exactly mirroring Discord. Runs after the basic
        // sanitize (invites/length) and needs the caller's resolved perms plus
        // the channel's guild directory.
        const { content, mentions: parsedMentions } = await parseMentions(rawContent, sendPerms, channel.guildId)
        if (!content) return sendJson(response, 400, { error: 'Message is empty.' })
        // Ping limits. AutoMod mention spam first: too many unique user+role
        // mentions blocks the whole message (400 / code 200000, never a 429 -
        // the client's queue would silently retry it).
        const limits = await mentionLimits()
        const pingClass = pingClassOf(sendPerms)
        const pingKey = webhookKey(sendGate.subject) || identity.ownerKey
        const spam = mentionSpamCheck(content, pingClass, limits)
        if (spam.blocked) {
          mentionLimiter.noteBlocked(pingKey)
          logMentionLimit(pingKey, 'automod-block', `Mention spam: ${spam.count} unique mentions (limit ${spam.limit})`, {
            channelId: scope.id, count: spam.count, limit: spam.limit, content: content.slice(0, 300),
          })
          return sendJson(response, 400, automodBlockedBody(false, spam.count, spam.limit))
        }
        const mentions = parsedMentions
        const clientId = typeof body.clientId === 'string' && body.clientId.length <= 64 ? body.clientId : null
        // Optional reply reference: the bridge message id being replied to (stored
        // in reply_to; Discord-origin replies store the Discord snowflake there).
        const replyTo = typeof body.replyTo === 'string' && body.replyTo.length <= 64 ? body.replyTo : null
        // Discord's reply "@ ON/OFF" toggle: only an explicit false silences
        // the reply (default ON, like Discord). With ON, record the replied
        // author as a 'reply' mention so the web highlights it for them; with
        // OFF the bot delivers replied_user=false and nothing highlights.
        let replyMention = replyTo ? body.replyMention !== false : true
        if (replyTo && replyMention) {
          const replyEntry = await replyMentionFor(replyTo, scope.id)
          if (replyEntry) mentions.push(replyEntry)
        }
        // Ping budget + per-target protection: the message still sends; the
        // excess pings are made inert. A neutralized reply ping becomes a
        // quiet "@ OFF" reply (replied_user=false, no highlight).
        const limited = mentionLimiter.apply(pingKey, mentions, { cls: pingClass, limits })
        const finalMentions = limited.mentions.filter((m) => {
          if (m.type !== 'reply' || !m.inert) return true
          replyMention = false
          return false
        })

        const user = identity.user
        // Web messages show the account's chat display name (fallback: site username).
        const authorName = effectiveChatName(user.username, user.chat_display_name)
        // Uploaded + APPROVED chat avatar first (absolute public URL, see
        // avatar-store.ts), else the linked Discord avatar, else null (the
        // bot/web fall back to Discord's default). Client-supplied avatar
        // URLs are never accepted.
        const authorAvatar = await callerAvatar(user)

        const { message, existed } = await bridge.recordMessage({
          channelId: scope.id,
          direction: 'web',
          authorKey: callerKey(user),
          authorName,
          authorAvatar,
          // Name color = the highest colored EFFECTIVE role (perk/tier +
          // onboarding roles, or a linked member's real roles); gradients are
          // served live by /authors.
          authorColor: sendPerms.color,
          authorRole: sendPerms.tier === 'member' || sendPerms.tier === 'guest' ? null : sendPerms.tier,
          content,
          mentions: finalMentions,
          clientId,
          replyTo,
          replyMention,
        })
        if (limited.neutralized.length) {
          logMentionLimit(pingKey, 'mention-limit', neutralizedReason(limited.neutralized), {
            channelId: scope.id, messageId: message.id, neutralized: limited.neutralized.slice(0, 25),
          })
        }
        if (!existed) {
          await bridge.broadcastMessage(message)
          if (scope.post) await touchPostActivity(scope.id, message.createdAt)
          // Hand the message to the bot service for webhook delivery. The bot
          // LISTENs on this channel; its periodic sweep is the backstop if the
          // notification is missed (row stays undelivered until then).
          await query(
            `SELECT pg_notify($1, $2)`,
            [OUTBOX_NOTIFY_CHANNEL, JSON.stringify({ id: message.id })],
          ).catch(() => {})
          // Discord-style link unfurl: if the content carries an http(s) URL,
          // fetch it and attach a rich embed. This runs AFTER the response
          // (fire-and-forget) so sends stay fast - exactly like Discord, where
          // the message lands first and the embed pops in a moment later via a
          // message-edit event. Unfurl is for everyone (the SEND_EMBEDS perm
          // gates manual embeds, not link previews). Best-effort: failures are
          // swallowed inside unfurlMessageEmbeds/unfurlUrl.
          const links = messageLinks(content)
          if (links.length) void unfurlMessageEmbeds(message.id, links)
        }
        return sendJson(response, existed ? 200 : 201, { message })
      }

      // Forward a message (Discord's Forward action) into a bridged channel.
      // Stored as a web row with empty content + a `forwarded` snapshot of the
      // source; the bot delivers it through the destination channel's webhook
      // as a quoted "Forwarded" block (webhooks can't send native
      // message_reference FORWARDs). Destination gating is identical to /send
      // (bridged + SEND bit + overwrites + lock + timeout); the caller must
      // also be able to VIEW the source channel. Forwards never ping: the row's
      // mentions are empty, so the webhook's allowed_mentions is empty.
      if (path === 'forward') {
        if (req.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' })
        if (identity.isGuest || !identity.user) return sendJson(response, 401, { error: 'Sign in to chat.' })
        const forwardLimit = rateLimit(`bridge:send:${identity.ownerKey}`, {
          limit: 12,
          windowMs: 10_000,
          error: 'You are sending messages too fast.',
        })
        if (!forwardLimit.ok) {
          return sendRateLimited(response, forwardLimit.retryAfterSec, forwardLimit.error)
        }

        const body = await readBody(req)
        const messageId = Number(body.messageId)
        const channelId = typeof body.channelId === 'string' ? body.channelId : ''
        if (!messageId || !channelId) return sendJson(response, 400, { error: 'Missing message or channel.' })
        const source = await bridge.messageFor(messageId)
        if (!source || source.deletedAt) {
          return sendJson(response, 404, { error: 'Unknown message.', code: DiscordError.UNKNOWN_MESSAGE })
        }
        // Source visibility: you can only forward what you can see (the same
        // read gate as /history).
        const sourceGate = await viewGate(identity.user, source.channelId)
        if (!sourceGate.ok) {
          return sendJson(response, 404, { error: 'Unknown message.', code: DiscordError.UNKNOWN_MESSAGE })
        }
        // Destination: the shared write gate (bridged only, email, ban, VIEW,
        // timeout, SEND + overwrites, lock).
        const destination = await bridge.scopeFor(channelId)
        if (pendingPost(destination)) return sendJson(response, 409, { ...PENDING_POST })
        const forwardGate = await writeDenial(identity.user, identity.ip, destination, 'forward')
        if (!forwardGate.ok) return sendJson(response, forwardGate.status, forwardGate.body)
        if (!destination) return sendJson(response, 404, { error: 'Unknown channel.', code: DiscordError.UNKNOWN_CHANNEL })
        const viewPerms = forwardGate.perms

        // The jump link points at the SOURCE message's guild (a forward may
        // cross bridged guilds, like on Discord).
        const snapshot = forwardSnapshotOf(source, sourceGate.guildId)
        if (!snapshot.content && !snapshot.attachments.length && !snapshot.embeds.length) {
          return sendJson(response, 400, { error: 'Message is empty.' })
        }
        const clientId = typeof body.clientId === 'string' && body.clientId.length <= 64 ? body.clientId : null
        const user = identity.user
        const { message, existed } = await bridge.recordMessage({
          channelId: destination.id,
          direction: 'web',
          authorKey: callerKey(user),
          authorName: effectiveChatName(user.username, user.chat_display_name),
          authorAvatar: await callerAvatar(user),
          authorColor: viewPerms.color,
          authorRole: viewPerms.tier === 'member' || viewPerms.tier === 'guest' ? null : viewPerms.tier,
          content: '',
          mentions: [],
          clientId,
          forwarded: snapshot,
        })
        if (!existed) {
          await bridge.broadcastMessage(message)
          if (destination.post) await touchPostActivity(destination.id, message.createdAt)
          await query(
            `SELECT pg_notify($1, $2)`,
            [OUTBOX_NOTIFY_CHANNEL, JSON.stringify({ id: message.id })],
          ).catch(() => {})
        }
        return sendJson(response, existed ? 200 : 201, { message })
      }

      // Edit a web-originated message (Discord's Edit Message flow). Only the
      // message's author may edit it, and only direction 'web' rows - a
      // Discord-originated message is owned by its Discord author and can only
      // be edited from Discord itself. Mirrors to Discord via the bot.
      if (path === 'edit') {
        if (req.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' })
        if (identity.isGuest || !identity.user) return sendJson(response, 401, { error: 'Sign in to chat.' })
        const editLimit = rateLimit(`bridge:edit:${identity.ownerKey}`, {
          limit: 12,
          windowMs: 10_000,
          error: 'You are editing messages too fast.',
        })
        if (!editLimit.ok) {
          return sendRateLimited(response, editLimit.retryAfterSec, editLimit.error)
        }
        const body = await readBody(req)
        const messageId = Number(body.messageId)
        if (!messageId) return sendJson(response, 400, { error: 'Missing message.' })
        const rawContent = sanitizeContent(typeof body.content === 'string' ? body.content : '')

        // Authorize: the target must exist, be a web message, and belong to the
        // caller. Discord's own client returns 10008 for a message that doesn't
        // exist and 50013 when you can't edit it - mirror that split here.
        const target = await bridge.messageFor(messageId)
        if (!target || target.deletedAt) {
          return sendJson(response, 404, { error: 'Unknown message.', code: DiscordError.UNKNOWN_MESSAGE })
        }
        if (target.direction !== 'web' || !authoredBy(target.authorKey, identity.user)) {
          return sendJson(response, 403, { error: 'You can only edit your own messages.', code: DiscordError.MISSING_PERMISSIONS })
        }
        // Discord forwards are immutable - there is no edit for a forward.
        if (target.forwarded) {
          return sendJson(response, 403, { error: 'Forwarded messages cannot be edited.', code: DiscordError.MISSING_PERMISSIONS })
        }

        // An edit re-checks the CURRENT effective permissions exactly like a
        // send: bridged channel, email verification, ban, VIEW (Discord +
        // chat bit + view overwrite), active timeout, SEND_MESSAGES + send
        // overwrite (role + webhook member overwrites), and the channel lock.
        // Permissions granted when the message was sent don't carry over.
        // In a post: Discord's archived (50083) / locked rules apply.
        const editScope = await bridge.scopeFor(target.channelId)
        const editGate = await writeDenial(identity.user, identity.ip, editScope, 'edit')
        if (!editGate.ok) return sendJson(response, editGate.status, editGate.body)
        if (!editScope) return sendJson(response, 404, { error: 'Unknown channel.', code: DiscordError.UNKNOWN_CHANNEL })
        const channel = editScope.channel
        // Permission-aware mention pass - identical to the send path, over the
        // same channel-effective perms: an edit can't smuggle in an
        // @everyone/role ping the caller couldn't send directly.
        const editPerms = editGate.perms
        const { content, mentions: parsedMentions } = await parseMentions(rawContent, editPerms, channel.guildId)
        if (!content) return sendJson(response, 400, { error: 'Message is empty.' })

        // Ping limits on edit: AutoMod mention spam blocks the edit (Discord's
        // "can't be edited" AutoMod notice). Mentions that were LIVE before
        // stay live for free; previously-inert ones can't be revived by an
        // edit; NEW mentions are charged against the budget like a send - so
        // an edit can never add pings beyond the budget.
        const limits = await mentionLimits()
        const pingClass = pingClassOf(editPerms)
        const pingKey = webhookKey(editGate.subject) || identity.ownerKey
        const spam = mentionSpamCheck(content, pingClass, limits)
        if (spam.blocked) {
          mentionLimiter.noteBlocked(pingKey)
          logMentionLimit(pingKey, 'automod-block', `Mention spam (edit): ${spam.count} unique mentions (limit ${spam.limit})`, {
            channelId: target.channelId, messageId, count: spam.count, limit: spam.limit, content: content.slice(0, 300),
          })
          return sendJson(response, 400, automodBlockedBody(true, spam.count, spam.limit))
        }
        const carriedLive = new Set<string>()
        const carriedInert = new Set<string>()
        for (const m of (target.mentions || []) as BridgeMention[]) {
          const key = m ? mentionTargetKey(m) : null
          if (!key || m.type === 'reply') continue
          ;(m.inert ? carriedInert : carriedLive).add(key)
        }
        const limited = mentionLimiter.apply(pingKey, parsedMentions, { cls: pingClass, limits, carriedLive, carriedInert })
        const mentions = limited.mentions
        if (limited.neutralized.some((n) => n.reason !== 'edit')) {
          logMentionLimit(pingKey, 'mention-limit', neutralizedReason(limited.neutralized), {
            channelId: target.channelId, messageId, edit: true, neutralized: limited.neutralized.slice(0, 25),
          })
        }

        // The reply-ping entry isn't in the content, so parseMentions drops it -
        // carry it over (an edit never changes the reply "@ ON/OFF" choice).
        for (const m of target.mentions as BridgeMention[]) {
          if (m && m.type === 'reply') mentions.push(m)
        }
        const updated = await bridge.editMessage(messageId, callerKey(identity.user), content, mentions)
        if (!updated) {
          return sendJson(response, 404, { error: 'Unknown message.', code: DiscordError.UNKNOWN_MESSAGE })
        }

        // Mirror the edit to Discord: the bot LISTENs on abulxt_bridge_edit and
        // PATCHes the delivered Discord message. Skip when the message hasn't
        // been delivered yet (no discord_message_id) - the outbox delivery
        // always sends the latest persisted content.
        if (updated.discordMessageId) {
          await query(
            `SELECT pg_notify($1, $2)`,
            [EDIT_NOTIFY_CHANNEL, JSON.stringify({ discordMessageId: updated.discordMessageId, channelId: updated.channelId, content })],
          ).catch(() => {})
        }
        await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.message.edited', { message: updated })
        return sendJson(response, 200, { message: updated })
      }

      // Toggle a reaction on a message. The web user's reaction is recorded
      // under their webhook identity (ownerKey); the bot mirrors it to Discord
      // exactly once per emoji per message (removing only when the last real
      // reactor unreacts). The bot never persists its own reaction as a webhook.
      if (path === 'react') {
        if (req.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' })
        if (identity.isGuest || !identity.user) return sendJson(response, 401, { error: 'Sign in to chat.' })
        const reactLimit = rateLimit(`bridge:react:${identity.ownerKey}`, {
          limit: 30,
          windowMs: 10_000,
          error: 'You are reacting too fast.',
        })
        if (!reactLimit.ok) {
          return sendRateLimited(response, reactLimit.retryAfterSec, reactLimit.error)
        }
        const body = await readBody(req)
        const messageId = Number(body.messageId)
        const emoji = typeof body.emoji === 'string' ? body.emoji.slice(0, 64) : ''
        if (!messageId || !emoji) return sendJson(response, 400, { error: 'Missing message or emoji.' })
        const message = await bridge.messageFor(messageId)
        if (!message || message.deletedAt) {
          return sendJson(response, 404, { error: 'Unknown message.', code: DiscordError.UNKNOWN_MESSAGE })
        }
        // The shared write gate with the 'react' action: bridged channel,
        // ban, VIEW (you can't react to what you can't see), timeout (a muted
        // webhook is view-only), then the dedicated ADD_REACTIONS bit + react
        // overwrite (1:1 with Discord: a member who can't SEND can still
        // react; a channel lock doesn't block reactions).
        const reactScope = await bridge.scopeFor(message.channelId)
        // Reactions on a pending post's starter could never reach Discord.
        if (pendingPost(reactScope)) return sendJson(response, 409, { ...PENDING_POST })
        const reactGate = await writeDenial(identity.user, identity.ip, reactScope, 'react')
        if (!reactGate.ok) return sendJson(response, reactGate.status, reactGate.body)

        const reactorKey = callerKey(identity.user)
        const before = await bridge.reactionAggregate(messageId, emoji)
        const alreadyReacted = message.reactions.some((r) => r.emoji === emoji && r.reactorKeys.includes(reactorKey))
        const aggregate = alreadyReacted
          ? await bridge.removeReaction(messageId, emoji, reactorKey)
          : await bridge.addReaction(messageId, emoji, reactorKey)

        // Mirror to Discord via the bot: it reacts once when the first real
        // reactor appears and unreacts when the last one leaves. The bot service
        // LISTENs on the reactions channel and applies the delta.
        if (message.discordMessageId && aggregate.count !== before.count) {
          await query(
            `SELECT pg_notify($1, $2)`,
            ['abulxt_bridge_reaction', JSON.stringify({
              discordMessageId: message.discordMessageId,
              channelId: message.channelId,
              emoji,
              count: aggregate.count,
              botShouldReact: aggregate.count > 0,
            })],
          ).catch(() => {})
        }

        const reactions = await bridge.reactionsFor(messageId)
        await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.reaction', {
          messageId,
          channelId: message.channelId,
          emoji,
          reactions,
        })
        // A post's starter reactions show on its card.
        const reactedPost = reactScope?.post
        if (reactedPost && reactedPost.starterMessageId === messageId) await bridge.emitPostEvent('bridge.post.updated', reactedPost).catch(() => {})
        return sendJson(response, 200, { messageId, emoji, reactions, reacted: !alreadyReacted })
      }

      // Delete a message (Discord's delete flow, web → Discord). A user may
      // delete their own web-originated message; staff with MANAGE_WEBHOOKS or
      // BAN_WEBHOOKS (Discord's Manage Messages) may delete ANY message,
      // including Discord-originated ones (the bot deletes those on Discord).
      // The row is soft-deleted (deleted_at + content scrub) and removed from
      // every client's view via bridge.message.deleted.
      // Remove embeds (Discord's SUPPRESS_EMBEDS hover X). Authors may
      // suppress their own messages' embeds; staff (MANAGE_WEBHOOKS /
      // BAN_WEBHOOKS, the Manage Messages analogue) anyone's. Web rows are
      // edited through the channel webhook; Discord rows by the bot, which
      // needs MANAGE_MESSAGES in the channel. Only delivered messages in
      // bridged channels.
      if (path === 'suppress-embeds') {
        if (req.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' })
        if (identity.isGuest || !identity.user) return sendJson(response, 401, { error: 'Sign in to chat.' })
        const suppressLimit = rateLimit(`bridge:suppress:${identity.ownerKey}`, { limit: 10, windowMs: 10_000, error: 'You are doing that too fast.' })
        if (!suppressLimit.ok) {
          return sendRateLimited(response, suppressLimit.retryAfterSec, suppressLimit.error)
        }
        const body = await readBody(req)
        const messageId = Number(body.messageId)
        if (!Number.isSafeInteger(messageId) || messageId <= 0) return sendJson(response, 400, { error: 'Missing message.' })
        const target = await bridge.messageFor(messageId)
        if (!target || target.deletedAt) return sendJson(response, 404, { error: 'Unknown Message', code: DiscordError.UNKNOWN_MESSAGE })
        const suppressScope = await bridge.scopeFor(target.channelId)
        if (!suppressScope || !suppressScope.channel.enabled) return sendJson(response, 404, { error: 'Unknown channel.', code: DiscordError.UNKNOWN_CHANNEL })
        // The shared write gate: your own message ('own-message': ban + VIEW;
        // a timeout doesn't stop you tidying your own messages, like Discord)
        // or anyone's with Manage Messages ('manage-messages': + timeout +
        // MANAGE/BAN bit). A message you can't see is Unknown Message.
        const linked = identity.user.discord_id || null
        const isAuthor = (target.direction === 'web' && authoredBy(target.authorKey, identity.user))
          || (target.direction === 'discord' && linked !== null && target.authorKey === `discord:${linked}`)
        const suppressGate = await writeDenial(identity.user, identity.ip, suppressScope, isAuthor ? 'own-message' : 'manage-messages')
        if (!suppressGate.ok) {
          if (suppressGate.body.code === DiscordError.MISSING_ACCESS) return sendJson(response, 404, { error: 'Unknown Message', code: DiscordError.UNKNOWN_MESSAGE })
          return sendJson(response, suppressGate.status, suppressGate.body)
        }
        if (!target.discordMessageId) return sendJson(response, 409, { error: 'This message has not reached Discord yet.' })
        // In a post the forum's webhook / permissions apply, on the thread.
        const result = await suppressOnDiscord({
          direction: target.direction,
          channelId: target.channelId,
          discordMessageId: target.discordMessageId,
          parentId: suppressScope.post ? suppressScope.channel.channelId : null,
        })
        if (!result.ok) {
          return sendJson(response, result.status, { error: result.error, ...(result.status === 403 ? { code: DiscordError.MISSING_PERMISSIONS } : {}) })
        }
        const updated = await bridge.suppressEmbedsById(messageId)
        if (!updated) return sendJson(response, 404, { error: 'Unknown Message', code: DiscordError.UNKNOWN_MESSAGE })
        // Same realtime path as Discord's own embed updates: clients swap in
        // the (now empty) embeds without treating it as a content edit.
        await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.message.edited', { message: updated, embedOnly: true }).catch(() => {})
        return sendJson(response, 200, { message: updated })
      }

      if (path === 'delete') {
        if (req.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' })
        if (identity.isGuest || !identity.user) return sendJson(response, 401, { error: 'Sign in to chat.' })
        const deleteLimit = rateLimit(`bridge:delete:${identity.ownerKey}`, {
          limit: 20,
          windowMs: 10_000,
          error: 'You are deleting messages too fast.',
        })
        if (!deleteLimit.ok) {
          return sendRateLimited(response, deleteLimit.retryAfterSec, deleteLimit.error)
        }
        const body = await readBody(req)
        const messageId = Number(body.messageId)
        if (!messageId) return sendJson(response, 400, { error: 'Missing message.' })
        const message = await bridge.messageFor(messageId)
        // Discord returns 10008 Unknown Message both for a missing id and for
        // one the caller may not see - never confirm existence on denial.
        if (!message || message.deletedAt) {
          return sendJson(response, 404, { error: 'Unknown Message', code: DiscordError.UNKNOWN_MESSAGE })
        }
        // Authorization (1:1 with Discord) through the shared write gate: your
        // own web-originated message ('own-message'), or anyone's - any
        // webhook, web or Discord - with Manage Messages ('manage-messages':
        // MANAGE_WEBHOOKS/BAN_WEBHOOKS, not timed out, not banned). Both need
        // VIEW on the channel; without it the message is Unknown (staff can't
        // walk sequential ids into channels hidden from them).
        const isOwnWebMessage = message.direction === 'web' && authoredBy(message.authorKey, identity.user)
        const deleteScope = await bridge.scopeFor(message.channelId)
        const deleteGate = await writeDenial(identity.user, identity.ip, deleteScope, isOwnWebMessage ? 'own-message' : 'manage-messages')
        if (!deleteGate.ok) {
          if (deleteGate.status === 404 || deleteGate.body.code === DiscordError.MISSING_ACCESS) {
            return sendJson(response, 404, { error: 'Unknown Message', code: DiscordError.UNKNOWN_MESSAGE })
          }
          return sendJson(response, deleteGate.status, deleteGate.body)
        }

        const deleted = await bridge.deleteMessage(messageId)
        if (!deleted) {
          // Lost a race with another delete - treat as Unknown Message.
          return sendJson(response, 404, { error: 'Unknown Message', code: DiscordError.UNKNOWN_MESSAGE })
        }

        // Mirror to Discord: the bot LISTENs on abulxt_bridge_delete and calls
        // message.delete() for the Discord-side copy. Web-originated messages
        // have a discordMessageId once the bot delivered them (webhook post);
        // Discord-originated ones always do.
        if (deleted.discordMessageId) {
          await query(
            `SELECT pg_notify($1, $2)`,
            [DELETE_NOTIFY_CHANNEL, JSON.stringify({ discordMessageId: deleted.discordMessageId, channelId: deleted.channelId })],
          ).catch(() => {})
        }

        await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.message.deleted', {
          id: deleted.id,
          channelId: deleted.channelId,
          discordMessageId: deleted.discordMessageId,
        })
        // Deleting a pending post's starter withdraws the post (it never
        // reaches Discord). A delivered post outlives its starter, like Discord.
        const deletedPost = deleteScope?.post
        if (deletedPost?.pending && deletedPost.starterMessageId === deleted.id) {
          const dropped = await bridge.dropPendingPost(deletedPost.pk, null).catch(() => null)
          if (dropped) await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.post.deleted', { channelId: dropped.forumId, postId: dropped.id })
        } else if (deletedPost && !deletedPost.pending) {
          await touchPostActivity(deletedPost.id, deletedPost.lastActivityAt)
        }
        return sendJson(response, 200, {
          ok: true,
          messageId: deleted.id,
          direction: deleted.direction,
          discordMessageId: deleted.discordMessageId,
        })
      }

      // Webhook moderation. Every action targets a WEBHOOK identity - a
      // web-only site account ('user:<id>'), a linked account (either key),
      // or a Discord user ('discord:<id>' / bare snowflake) - and runs through
      // moderateWebhook (shared with the Discord-side /bridge commands):
      //   timeout {seconds, reason} / untimeout   (TIMEOUT or MANAGE bit)
      //   ban {reason} / unban                    (BAN or MANAGE bit)
      //   webhook-perm {allow, deny}              (MANAGE; per-channel member
      //     overwrite; subjectType 'role' + target = chat role id for a role
      //     overwrite)
      //   lockdown {locked}                       (channel-scoped; no target)
      // The actor passes the shared write gate ('moderate': bridged channel,
      // ban, VIEW, not timed out) and Discord role hierarchy (you can't act on
      // a webhook at or above your own position; never yourself).
      if (path === 'moderate') {
        if (req.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' })
        if (identity.isGuest || !identity.user) return sendJson(response, 401, { error: 'Sign in to chat.' })
        const moderateLimit = rateLimit(`bridge:moderate:${identity.ownerKey}`, { limit: 20, windowMs: 10_000, error: 'Slow down.' })
        if (!moderateLimit.ok) {
          return sendRateLimited(response, moderateLimit.retryAfterSec, moderateLimit.error)
        }
        const body = await readBody(req)
        const action = typeof body.action === 'string' ? body.action : ''
        const channelId = typeof body.channelId === 'string' ? body.channelId : ''
        // From inside a post, moderation (timeouts, overwrites, lockdown) acts
        // on its forum: threads inherit all of it.
        const modScope = channelId ? await bridge.scopeFor(channelId) : null
        const channel = modScope?.channel ?? null
        if (!modScope || !channel || !channel.enabled) return sendJson(response, 404, { error: 'Unknown channel.' })
        // Moderators act only from channels they can VIEW (no locking/timing
        // out in staff channels hidden from them), and not while muted/banned.
        const actorGate = await writeDenial(identity.user, identity.ip, modScope, 'moderate')
        if (!actorGate.ok) {
          if (actorGate.body.code === DiscordError.MISSING_ACCESS) return sendJson(response, 404, { error: 'Unknown channel.' })
          return sendJson(response, actorGate.status, actorGate.body)
        }
        const actorPerms = actorGate.perms
        const actorName = identity.user.discord_name || identity.user.username

        if (action === 'lockdown') {
          // Lockdown: mod+ locks/unlocks the channel, disabling sends for
          // regular webhooks. Broadcast so connected clients flip their composer.
          if (!hasPerm(actorPerms.permissions, Perm.TIMEOUT_WEBHOOKS) && !hasPerm(actorPerms.permissions, Perm.MANAGE_WEBHOOKS)) {
            return sendJson(response, 403, { error: 'You do not have permission to lock this channel.' })
          }
          const locked = body.locked !== false
          await bridge.setChannelLocked(channel.channelId, locked)
          await bridge.logModeration({ actor: actorName, action: locked ? 'lockdown' : 'unlock', subject: `channel:${channel.channelId}`, reason: '', guildId: channel.guildId }).catch(() => {})
          await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.lockdown', { channelId: channel.channelId, locked, issuedByName: actorName })
          return sendJson(response, 200, { ok: true, locked })
        }

        const bitsOf = (v: unknown): bigint | null => {
          const str = typeof v === 'string' || typeof v === 'number' ? String(v) : '0'
          return /^\d{1,19}$/.test(str) ? BigInt(str) : null
        }

        if (action === 'webhook-perm' && body.subjectType === 'role') {
          // Role overwrite: MANAGE bit, and only for roles below the actor
          // (Discord: you can't edit overwrites for roles at/above your own).
          if (!hasPerm(actorPerms.permissions, Perm.MANAGE_WEBHOOKS)) {
            return sendJson(response, 403, { error: 'You do not have permission to manage webhook permissions.' })
          }
          const roleId = typeof body.target === 'string' && SNOWFLAKE.test(body.target) ? body.target : ''
          if (!roleId) return sendJson(response, 400, { error: 'Missing target role.' })
          // The role must belong to this channel's guild (positions only
          // compare within a guild): unknown / foreign roles are 404 Unknown
          // Role, never written. Chat-role rows without guild_id count as
          // the home guild's.
          const role = await query<{ position: number }>(
            `SELECT position FROM discord_bridge_chat_role
              WHERE role_id = $1 AND (guild_id = $2 OR (guild_id IS NULL AND $2 = $3))
             UNION ALL SELECT position FROM discord_bridge_guild_role WHERE role_id = $1 AND guild_id = $2 LIMIT 1`,
            [roleId, channel.guildId, configuredGuildId()],
          ).then((r) => r.rows[0]).catch(() => undefined)
          if (!role) return sendJson(response, 404, { error: 'Unknown Role', code: 10011 })
          if (!actorPerms.hierarchyBypass && role.position >= actorPerms.position) {
            return sendJson(response, 403, { error: 'You cannot moderate a webhook at or above your own role.' })
          }
          const allow = bitsOf(body.allow)
          const deny = bitsOf(body.deny)
          if (allow === null || deny === null) return sendJson(response, 400, { error: 'Invalid permission bits.' })
          await setWebhookPerm({ channelId: channel.channelId, subjectType: 'role', subject: roleId, allow, deny, createdBy: actorName })
          await bridge.logModeration({ actor: actorName, action: 'webhook-perm', subject: `role:${roleId}`, meta: { channelId: channel.channelId, allow: allow.toString(), deny: deny.toString() }, guildId: channel.guildId }).catch(() => {})
          // Role overwrites can change anyone's visibility: global refresh.
          await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.perms.changed', { channelId: channel.channelId })
          return sendJson(response, 200, { ok: true })
        }

        const parsedTarget = parseWebhookTarget(body.target)
        if (!parsedTarget) return sendJson(response, 400, { error: 'Missing target webhook.' })
        const target = await resolveWebhookTarget(parsedTarget).catch(() => null)
        if (!target) return sendJson(response, 404, { error: 'Unknown webhook.' })

        let request: ModerationRequest
        const reason = typeof body.reason === 'string' ? body.reason : ''
        if (action === 'timeout') request = { action, seconds: Number(body.seconds) || 0, reason }
        else if (action === 'untimeout') request = { action }
        else if (action === 'ban') request = { action, reason }
        else if (action === 'unban') request = { action }
        else if (action === 'webhook-perm') {
          const allow = bitsOf(body.allow)
          const deny = bitsOf(body.deny)
          if (allow === null || deny === null) return sendJson(response, 400, { error: 'Invalid permission bits.' })
          request = { action, allow, deny }
        } else return sendJson(response, 400, { error: 'Unknown moderation action.' })

        const result = await moderateWebhook(
          { perms: actorPerms, subject: actorGate.subject, name: actorName, id: identity.user ? callerKey(identity.user) : identity.ownerKey },
          target,
          channel.channelId,
          request,
          channel.guildId,
        )
        if (!result.ok) return sendJson(response, result.status, { error: result.error, code: DiscordError.MISSING_PERMISSIONS })
        return sendJson(response, 200, result.body)
      }

      if (path === 'typing') {
        if (req.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' })
        if (identity.isGuest || !identity.user) return sendJson(response, 401, { error: 'Sign in to chat.' })
        const typingLimit = rateLimit(`bridge:typing:${identity.ownerKey}`, {
          limit: 6,
          windowMs: 10_000,
          error: 'Slow down.',
        })
        if (!typingLimit.ok) return sendRateLimited(response, typingLimit.retryAfterSec, typingLimit.error)
        const body = await readBody(req)
        const channelId = typeof body.channelId === 'string' ? body.channelId : ''
        const typingScope = channelId ? await bridge.scopeFor(channelId) : null
        if (pendingPost(typingScope)) return sendJson(response, 409, { ...PENDING_POST })
        // Typing is only broadcast for webhooks that could actually send here
        // (the shared write gate): a banned, muted (timed-out), locked-out, or
        // SEND-denied webhook can't type. In a post: whoever may reply.
        const typingGate = await writeDenial(identity.user, identity.ip, typingScope, 'typing')
        if (!typingGate.ok) return sendJson(response, typingGate.status, typingGate.body)
        if (!typingScope) return sendJson(response, 404, { error: 'Unknown channel.' })
        await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.typing', {
          channelId: typingScope.id,
          authorKey: callerKey(identity.user),
          authorName: effectiveChatName(identity.user.username, identity.user.chat_display_name),
        })
        return sendJson(response, 200, { ok: true })
      }

      // Pinned messages (Discord's channel-header Pins popout). Pins live on
      // Discord, so they're read live with the bot token. Gated exactly like
      // /history: bridged channel + VIEW_MESSAGES + channel view overwrite.
      // Pinned messages the bridge recorded come back as their bridge row (so
      // the client can jump to them); older ones are normalized (id 0).
      if (path === 'pins') {
        if (req.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' })
        const channelId = url.searchParams.get('channel') || ''
        if (!channelId) return sendJson(response, 400, { error: 'Missing channel.' })
        // Same VIEW gate as /history.
        const pinsGate = await viewGate(identity.user, channelId)
        if (!pinsGate.ok) return sendJson(response, pinsGate.status, pinsGate.body)
        const pinsLimit = rateLimit(`bridge:pins:${identity.ownerKey}`, { limit: 30, windowMs: 60_000, error: 'Too many requests. Slow down.' })
        if (!pinsLimit.ok) {
          return sendRateLimited(response, pinsLimit.retryAfterSec, pinsLimit.error)
        }
        // A post's pins live on its thread; a forum and a pending post have none.
        if (scopeKind(pinsGate.scope) === 'forum' || pendingPost(pinsGate.scope)) return sendJson(response, 200, { pins: [] })
        const token = (await loadConfig()).discord?.botToken
        const pinned = token ? await fetchDiscordPins(token, pinsGate.scope.id) : null
        if (!pinned) return sendJson(response, 502, { error: 'Could not load pinned messages.' })
        const pins: Array<{ pinnedAt: string; message: bridge.BridgeMessage }> = []
        for (const entry of pinned) {
          const row = await bridge.byDiscordMessageId(entry.message.id).catch(() => null)
          if (row?.deletedAt) continue
          pins.push({ pinnedAt: entry.pinnedAt, message: row || pinnedToBridgeMessage(entry.message, pinsGate.scope.id) })
        }
        // Refresh expiring signed CDN URLs (persisted on the bridged rows).
        const refreshedPins = await refreshMessageMedia(pins.map((p) => p.message), { persist: true })
        return sendJson(response, 200, { pins: pins.map((p, i) => ({ ...p, message: refreshedPins[i] })) })
      }

      // Pin / unpin a message (Discord's Pin Message). Staff-only - the same
      // Manage Messages analogue the delete route uses (MANAGE_WEBHOOKS or
      // BAN_WEBHOOKS) - and only for messages already delivered to Discord.
      if (path === 'pin') {
        if (req.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' })
        if (identity.isGuest || !identity.user) return sendJson(response, 401, { error: 'Sign in to chat.' })
        const pinLimit = rateLimit(`bridge:pin:${identity.ownerKey}`, { limit: 10, windowMs: 10_000, error: 'Slow down.' })
        if (!pinLimit.ok) {
          return sendRateLimited(response, pinLimit.retryAfterSec, pinLimit.error)
        }
        const body = await readBody(req)
        const messageId = Number(body.messageId)
        const pinned = body.pinned !== false
        if (!messageId) return sendJson(response, 400, { error: 'Missing message.' })
        const message = await bridge.messageFor(messageId)
        if (!message || message.deletedAt || !message.discordMessageId) {
          return sendJson(response, 404, { error: 'Unknown Message', code: DiscordError.UNKNOWN_MESSAGE })
        }
        // The shared write gate ('manage-messages'): bridged channel, ban,
        // VIEW (staff can't pin in channels hidden from them - Unknown
        // Message), timeout (a muted moderator can't pin), MANAGE/BAN bit.
        const pinScope = await bridge.scopeFor(message.channelId)
        const pinGate = await writeDenial(identity.user, identity.ip, pinScope, 'manage-messages')
        if (!pinGate.ok) {
          if (pinGate.status === 404 || pinGate.body.code === DiscordError.MISSING_ACCESS) {
            return sendJson(response, 404, { error: 'Unknown Message', code: DiscordError.UNKNOWN_MESSAGE })
          }
          return sendJson(response, pinGate.status, pinGate.body)
        }
        const token = (await loadConfig()).discord?.botToken
        if (!token) return sendJson(response, 503, { error: 'Chat is not set up yet.' })
        const status = await setDiscordPin(token, message.channelId, message.discordMessageId, pinned)
        if (status === 403) return sendJson(response, 403, { error: 'Missing Permissions', code: DiscordError.MISSING_PERMISSIONS })
        if (status === 404) return sendJson(response, 404, { error: 'Unknown Message', code: DiscordError.UNKNOWN_MESSAGE })
        if (status < 200 || status >= 300) {
          // Discord caps a channel at 250 pins (error 30003 → HTTP 400).
          return sendJson(response, 400, { error: pinned ? 'Could not pin the message.' : 'Could not unpin the message.' })
        }
        await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.pins', { channelId: message.channelId, messageId: message.id, pinned })
        return sendJson(response, 200, { ok: true, pinned })
      }

      // Role-mention popout: the members holding a role (Discord opens a
      // member list when a role mention is clicked). Gated on VIEW for the
      // channel the mention appeared in; the role must exist in that guild.
      if (path === 'role-members') {
        if (req.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' })
        const channelId = url.searchParams.get('channel') || ''
        const roleId = url.searchParams.get('role') || ''
        if (!channelId || !/^\d{5,25}$/.test(roleId)) return sendJson(response, 400, { error: 'Missing channel or role.' })
        const rmGate = await viewGate(identity.user, channelId)
        if (!rmGate.ok) return sendJson(response, rmGate.status, rmGate.body)
        const channel = { guildId: rmGate.guildId }
        const rmLimit = rateLimit(`bridge:role-members:${identity.ownerKey}`, { limit: 20, windowMs: 60_000, error: 'Too many requests. Slow down.' })
        if (!rmLimit.ok) {
          return sendRateLimited(response, rmLimit.retryAfterSec, rmLimit.error)
        }
        const role = await bridge.guildRoleFor(channel.guildId, roleId).catch(() => null)
        if (!role) return sendJson(response, 404, { error: 'Unknown Role', code: 10011 })
        const token = (await loadConfig()).discord?.botToken
        const all = token ? await guildMemberList(token, channel.guildId) : null
        if (!all) return sendJson(response, 502, { error: 'Could not load role members.' })
        const holders: Array<{ userId: string; username: string; displayName: string; avatar: string; webhook?: boolean }> = all
          .filter((m) => m.roles.includes(roleId))
          .map(({ userId, username, displayName, avatar }) => ({ userId, username, displayName, avatar }))
        // Web (webhook) identities that EFFECTIVELY hold the role (onboarding
        // grant / perk floor), flagged so the popout marks them as webhooks.
        const webHolders = await webRoleHolders(channel.guildId, roleId).catch(() => [])
        for (const w of webHolders) {
          holders.push({ userId: w.key, username: w.username, displayName: w.username, avatar: w.avatar || webDefaultAvatar(w.userId), webhook: true })
        }
        holders.sort((a, b) => a.displayName.localeCompare(b.displayName))
        return sendJson(response, 200, {
          role: { id: role.roleId, name: role.name, color: role.color },
          total: holders.length,
          members: holders.slice(0, 100),
        })
      }

      // === Forum channels (docs/forum/contract.md) ===
      //
      // GET posts: one page of a forum's posts (pinned first on the first
      // page), VIEW-gated like /history and sealed like /channels.
      if (path === 'posts') {
        if (req.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' })
        const sp = url.searchParams
        const channelId = sp.get('channel') || ''
        if (!channelId) return sendJson(response, 400, { error: 'Missing channel.' })
        const postsGate = await viewGate(identity.user, channelId)
        if (!postsGate.ok) return sendJson(response, postsGate.status, postsGate.body)
        const forum = postsGate.bridged.forum
        if (postsGate.scope.post || !forum) return sendJson(response, 400, { error: 'Not a forum channel.', code: DiscordError.UNKNOWN_CHANNEL })
        const postsLimit = rateLimit(`bridge:posts:${identity.ownerKey}`, { limit: 120, windowMs: 60_000, error: 'Too many requests. Slow down.' })
        if (!postsLimit.ok) return sendRateLimited(response, postsLimit.retryAfterSec, postsLimit.error)
        const sortRaw = sp.get('sort')
        // No sort asked: the forum's own default (null = Recently Active).
        const sort: bridge.PostListSort = sortRaw === 'created' || sortRaw === 'activity'
          ? sortRaw
          : forum.defaultSortOrder === 1 ? 'created' : 'activity'
        const tags = [...new Set((sp.get('tags') || '').split(','))].filter((id) => SNOWFLAKE.test(id)).slice(0, 20)
        const beforeRaw = sp.get('before')
        const cursor = beforeRaw ? bridge.decodePostCursor(beforeRaw, sort) : null
        if (beforeRaw && !cursor) return sendJson(response, 400, { error: 'Invalid cursor.' })
        const page = await bridge.listPosts({
          forumId: postsGate.bridged.channelId,
          sort,
          tags,
          match: sp.get('match') === 'all' ? 'all' : 'some',
          q: (sp.get('q') || '').slice(0, 100),
          cursor,
          limit: Math.min(Math.max(Number(sp.get('limit')) || 25, 1), 50),
        })
        // Cards carry owner avatars: a partner page needs them absolute even
        // inside a sealed body (rewriteForForeignPage only sees plain JSON).
        const out = request.headers[FOREIGN_PAGE_HEADER] === 'holt'
          ? JSON.parse(absolutizeSiteAvatars(JSON.stringify(page), foreignPageSiteOrigin)) as typeof page
          : page
        return sendSealedJson(req, response, out)
      }

      // POST post: create a forum post (title, body, tags). Stored at once as
      // a pending `post:<n>` with its starter message; the bot delivers it
      // through the forum webhook (thread_name + applied_tags) and re-keys it
      // to the thread id (bridge.post.delivered). Idempotent on clientId.
      if (path === 'post') {
        if (req.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' })
        if (identity.isGuest || !identity.user) return sendJson(response, 401, { error: 'Sign in to chat.' })
        // Separate from /send: Discord's forum slowmode limits post creation.
        const postLimit = rateLimit(`bridge:post:${identity.ownerKey}`, { limit: 4, windowMs: 60_000, error: 'You are creating posts too fast.' })
        if (!postLimit.ok) return sendRateLimited(response, postLimit.retryAfterSec, postLimit.error)
        const body = await readBody(req)
        const forumId = typeof body.channelId === 'string' ? body.channelId : ''
        const name = typeof body.name === 'string' ? body.name.replace(/\s+/g, ' ').trim() : ''
        if (!name || name.length > 100) {
          return sendJson(response, 400, { error: 'A post title must be 1-100 characters.', code: ForumErrorCode.INVALID_FORM_BODY })
        }
        const rawBody = typeof body.content === 'string' ? body.content : ''
        // Webhook messages cap at 2000 characters; refuse rather than truncate.
        if (rawBody.trim().length > 2000) {
          return sendJson(response, 400, { error: 'A post message must be 2000 characters or fewer.', code: ForumErrorCode.INVALID_FORM_BODY })
        }
        const appliedTags = Array.isArray(body.appliedTags) ? body.appliedTags.filter((t): t is string => typeof t === 'string') : []
        if (appliedTags.length > 5 || appliedTags.some((t) => !SNOWFLAKE.test(t))) {
          return sendJson(response, 400, { error: 'A post can have at most 5 tags.', code: ForumErrorCode.INVALID_FORM_BODY })
        }
        const forumScope = forumId ? await bridge.scopeFor(forumId) : null
        // The shared write gate, 'post-create': everything /send checks on the
        // forum (SEND_MESSAGES there), plus REQUIRE_TAG / known / moderated tags.
        const postGate = await writeDenial(identity.user, identity.ip, forumScope, 'post-create', { tags: appliedTags })
        if (!postGate.ok) return sendJson(response, postGate.status, postGate.body)
        if (!forumScope) return sendJson(response, 404, { error: 'Unknown channel.', code: DiscordError.UNKNOWN_CHANNEL })
        const forum = forumScope.channel
        const postPerms = postGate.perms
        const { content, mentions: parsedMentions } = await parseMentions(sanitizeContent(rawBody), postPerms, forum.guildId)
        if (!content) return sendJson(response, 400, { error: 'A post needs a message.', code: ForumErrorCode.INVALID_FORM_BODY })
        const limits = await mentionLimits()
        const pingClass = pingClassOf(postPerms)
        const pingKey = webhookKey(postGate.subject) || identity.ownerKey
        const spam = mentionSpamCheck(content, pingClass, limits)
        if (spam.blocked) {
          mentionLimiter.noteBlocked(pingKey)
          logMentionLimit(pingKey, 'automod-block', `Mention spam (post): ${spam.count} unique mentions (limit ${spam.limit})`, {
            channelId: forum.channelId, count: spam.count, limit: spam.limit, content: content.slice(0, 300),
          })
          return sendJson(response, 400, automodBlockedBody(false, spam.count, spam.limit))
        }
        const limited = mentionLimiter.apply(pingKey, parsedMentions, { cls: pingClass, limits })
        const user = identity.user
        const clientId = typeof body.clientId === 'string' && body.clientId.length <= 64 ? body.clientId : null
        const { post, message, existed } = await bridge.createWebPost({
          forumId: forum.channelId,
          guildId: forum.guildId,
          name,
          appliedTags,
          ownerKey: callerKey(user),
          ownerName: effectiveChatName(user.username, user.chat_display_name),
          ownerAvatar: await callerAvatar(user),
          ownerColor: postPerms.color,
          authorRole: postPerms.tier === 'member' || postPerms.tier === 'guest' ? null : postPerms.tier,
          content,
          mentions: limited.mentions,
          clientId,
        })
        if (limited.neutralized.length) {
          logMentionLimit(pingKey, 'mention-limit', neutralizedReason(limited.neutralized), {
            channelId: forum.channelId, messageId: message.id, neutralized: limited.neutralized.slice(0, 25),
          })
        }
        const view = await bridge.forumPostView(post)
        if (!existed) {
          await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.post.created', { channelId: forum.channelId, post: view })
          await query(`SELECT pg_notify($1, $2)`, [OUTBOX_NOTIFY_CHANNEL, JSON.stringify({ id: message.id })]).catch(() => {})
          const links = messageLinks(content)
          if (links.length) void unfurlMessageEmbeds(message.id, links)
        }
        return sendJson(response, existed ? 200 : 201, { post: view, message })
      }

      // POST post-moderate: lock / unlock, pin / unpin, archive / unarchive,
      // tags, rename, delete. Staff (canManagePosts) may do all of it; the
      // post's owner may rename, retag, archive / unarchive and delete their
      // own post (not while it is locked, except delete). Performed on Discord
      // with the bot token (Modify Thread / Delete Channel); the result is
      // stored and broadcast at once (the gateway echo then changes nothing).
      if (path === 'post-moderate') {
        if (req.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' })
        if (identity.isGuest || !identity.user) return sendJson(response, 401, { error: 'Sign in to chat.' })
        const pmLimit = rateLimit(`bridge:post-moderate:${identity.ownerKey}`, { limit: 10, windowMs: 10_000, error: 'Slow down.' })
        if (!pmLimit.ok) return sendRateLimited(response, pmLimit.retryAfterSec, pmLimit.error)
        const body = await readBody(req)
        const action = typeof body.action === 'string' ? body.action : ''
        const postId = typeof body.postId === 'string' ? body.postId : ''
        const ACTIONS = new Set(['lock', 'unlock', 'pin', 'unpin', 'archive', 'unarchive', 'tags', 'rename', 'delete'])
        if (!ACTIONS.has(action)) return sendJson(response, 400, { error: 'Unknown post action.' })
        const pmScope = postId ? await bridge.scopeFor(postId) : null
        const post = pmScope?.post ?? null
        if (!pmScope || !post) return sendJson(response, 404, { error: 'Unknown post.', code: DiscordError.UNKNOWN_CHANNEL })
        if (post.pending || !post.threadId) return sendJson(response, 409, { ...PENDING_POST })
        // Not banned, not timed out, can VIEW the forum.
        const pmGate = await writeDenial(identity.user, identity.ip, pmScope, 'moderate')
        if (!pmGate.ok) {
          if (pmGate.body.code === DiscordError.MISSING_ACCESS) return sendJson(response, 404, { error: 'Unknown post.', code: DiscordError.UNKNOWN_CHANNEL })
          return sendJson(response, pmGate.status, pmGate.body)
        }
        const staff = canManagePosts(pmGate.perms.permissions)
        const linked = identity.user.discord_id || null
        const owner = authoredBy(post.ownerKey, identity.user) || (linked !== null && post.ownerKey === `discord:${linked}`)
        const ownerActions = new Set(['rename', 'tags', 'archive', 'unarchive', 'delete'])
        if (!staff && !(owner && ownerActions.has(action))) {
          return sendJson(response, 403, { error: 'Missing Permissions', code: DiscordError.MISSING_PERMISSIONS })
        }
        // Discord: a locked post's title/tags and its unarchiving are staff-only.
        if (!staff && post.locked && action !== 'delete' && action !== 'archive') {
          return sendJson(response, 403, { error: 'This post is locked.', code: ForumErrorCode.THREAD_LOCKED, postLocked: true })
        }
        const forum = pmScope.channel
        const actorName = identity.user.discord_name || identity.user.username
        const reason = `Post ${action} from the web chat by ${actorName}`.slice(0, 200)
        const threadId = post.threadId
        if (action === 'delete') {
          const res = await discordFetch(`/channels/${threadId}`, { method: 'DELETE' }, reason).catch(() => null)
          if (!res) return sendJson(response, 502, { error: 'Could not reach Discord.' })
          if (!res.ok && res.status !== 404) return discordFailure(response, res)
          await res.body?.cancel().catch(() => {})
          const gone = await bridge.deletePostByThread(threadId)
          if (gone) await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.post.deleted', { channelId: forum.channelId, postId: threadId })
          await bridge.logModeration({ actor: actorName, action: 'post-delete', subject: `post:${threadId}`, meta: { channelId: forum.channelId }, guildId: forum.guildId }).catch(() => {})
          return sendJson(response, 200, { deleted: true })
        }
        let patch: Record<string, unknown>
        if (action === 'lock' || action === 'unlock') patch = { locked: action === 'lock' }
        else if (action === 'archive' || action === 'unarchive') patch = { archived: action === 'archive' }
        else if (action === 'pin' || action === 'unpin') {
          patch = { flags: action === 'pin' ? post.flags | bridge.CHANNEL_FLAG_PINNED : post.flags & ~bridge.CHANNEL_FLAG_PINNED }
          // A pinned post is unarchived (archiving unpins it on Discord).
          if (action === 'pin' && post.archived) patch.archived = false
        } else if (action === 'rename') {
          const newName = typeof body.name === 'string' ? body.name.replace(/\s+/g, ' ').trim() : ''
          if (!newName || newName.length > 100) return sendJson(response, 400, { error: 'A post title must be 1-100 characters.', code: ForumErrorCode.INVALID_FORM_BODY })
          patch = { name: newName }
        } else {
          const next = Array.isArray(body.appliedTags) ? body.appliedTags.filter((t): t is string => typeof t === 'string' && SNOWFLAKE.test(t)) : null
          if (!next) return sendJson(response, 400, { error: 'Missing tags.', code: ForumErrorCode.INVALID_FORM_BODY })
          const denial = forum.forum ? validateTagChange(post.appliedTags, next, forum.forum, staff) : null
          if (denial) return sendJson(response, denial.status, denial.body)
          patch = { applied_tags: next }
        }
        // Owner edits of an archived post: Discord unarchives first.
        if (!staff && post.archived && (action === 'rename' || action === 'tags')) patch.archived = false
        const res = await discordFetch(`/channels/${threadId}`, { method: 'PATCH', body: JSON.stringify(patch) }, reason).catch(() => null)
        if (!res) return sendJson(response, 502, { error: 'Could not reach Discord.' })
        if (!res.ok) return discordFailure(response, res)
        const fields = bridge.postFieldsFromRawThread(await res.json().catch(() => null), forum.guildId)
        let updated = post
        if (fields && fields.threadId === threadId) {
          const result = await bridge.upsertDiscordPost(fields)
          updated = result.post
          if (result.changed) await bridge.emitPostEvent('bridge.post.updated', updated).catch(() => {})
        }
        await bridge.logModeration({ actor: actorName, action: `post-${action}`, subject: `post:${threadId}`, meta: { channelId: forum.channelId }, guildId: forum.guildId }).catch(() => {})
        return sendJson(response, 200, { post: await bridge.forumPostView(updated) })
      }

      return sendJson(response, 404, { error: 'Not found' })
    }
  }

  return {
    name: 'abulxt-discord-bridge-api',
    configureServer(server) {
      register(server)
    },
    configurePreviewServer(server) {
      register(server)
    },
  }
}
