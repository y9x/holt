import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type SyntheticEvent } from 'react'
import { getAuthToken, invalidateMe, me, savePresenceStatus, type AbulxtUser } from '../../lib/auth-api'
import { fetchGuildFolders, saveGuildFolders, type GuildFolder } from '../../lib/guild-folders'
import { rtConnected, subscribeBridge, subscribeRt, type RtEvent } from '../../lib/rt'
import { useDeveloperMode } from './developerMode'
import {
  bridgeChannels,
  bridgeDelete,
  bridgeEdit,
  bridgeExpressions,
  bridgeForward,
  bridgeGuildPerms,
  bridgeGuilds,
  bridgeHistory,
  bridgeHistoryPage,
  bridgeHistoryWindow,
  bridgeMembers,
  bridgeModTarget,
  bridgeModerate,
  bridgePerms,
  bridgePin,
  bridgePins,
  bridgeReact,
  bridgeRoleMembers,
  bridgeSend,
  bridgeTyping,
  isForumType,
  isPendingPostId,
  moderatePost,
  type ForumPost,
  type PostModerateAction,
  type BridgeCategory,
  type BridgeChannel,
  type BridgeChannelSuggestion,
  type BridgeChannelsResult,
  type BridgeGuild,
  type BridgeMemberSuggestion,
  type BridgeMembersResult,
  type BridgeMessage,
  type BridgeModTarget,
  type BridgePerms,
  type BridgePin,
  ChatPermBit,
  BRIDGE_ONBOARDING_EVENT,
  type BridgeRoleMembers,
  type BridgeRoleSuggestion,
  type BridgeReaction,
  type BridgeReactor,
  effectiveChatDisplayName,
} from '../../lib/bridge'
import { loadBrowserPreferences, type BrowserPreferences } from '../settings/preferences'
import { AuthModal } from '../../components/AuthGate'
import { HolyText } from '../../components/common/HolyText'
import { HolyRich } from '../../components/common/HolyRich'
import { Composer, type MentionSuggestionItem } from './Composer'
import { VerificationCard } from './VerificationCard'
import { ExpressionPicker, type PickerContextAction, type PickerTab } from './ExpressionPicker'
import { GuildTooltip } from './GuildTooltip'
import { ChannelTypeIcon, channelIconKind, channelIconSvgHtml, type ChannelIconKind } from './channelIcons'
import { ContextMenu, MenuReactionIcon, MenuUserIcon, nativeLinkLabels, COPY_SHORTCUT, CUT_SHORTCUT, PASTE_SHORTCUT, backdropDismissProps, eventWithinSelector, type MenuEntry } from './ContextMenu'
import { Popout, anchorSelector, type PopoutOptions } from './popout'
import { ProfilePopout, type ProfileData } from './ProfilePopout'
import { ReactionPill, ReactorsPopout } from './ReactorsPopout'
import { ModerationModal, type ModerationModalKind, type ModerationModalTarget } from './ModerationModals'
import { SearchBar, SearchResults, useChannelSearch } from './ChannelSearch'
import { notifyDesktop, useChatPrefs } from './chatPrefs'
import { OnboardingGate, useBridgeOnboarding } from './Onboarding'
import { GuildRail, type GuildBadge } from './GuildRail'
import { guildAcronymFontSize } from './guildIcon'
import { avatarMe } from '../../lib/avatar'
import { navigateTo } from '../../lib/navigate'
import { Emoji } from './Emoji'
import { GuildNotificationsModal } from './GuildNotificationsModal'
import { MUTE_DURATIONS, NOTIF_LEVEL_LABELS, mutedUntilText, useNotificationSettings, type NotifLevel as BaseNotifLevel } from './notifSettings'
import { allEmoji, type EmojiEntry } from './emoji-data'
import { frecentEmoji, onEmojiUsage, quickReactionEmoji, recordEmojiUse, recordEmojiUsesInText } from './emoji-frecency'
import { applyTone, getEmojiTone, onEmojiTone } from './emoji-tone'
import { AvatarDecoration, GuildTagChiplet, HoverTooltip, NewMemberBadge, discordAuthorId, isNewMember, roleNameProps, useAuthorStyles, useUserStyle } from './author-style'
import { PRESENCE_TEXT, presenceGlyph, seedSelfChoice, setSelfChoice, useSelfPresence } from './presence'
import { twemojify, twemojiUrl } from './twemoji'
import { escapeHtml, handleCodeCopyClick, mapOutsideCode, messageHasCodeBlock, renderMarkdown } from './markdown'
import { highlightCode, useHighlighterReady } from './highlight'
import './codeblock.css'
import {
  insertEmojiChip,
  insertMentionChip,
  normalizeEmpty,
  pastePlainText,
  replaceWithEmojiChip,
  serializeComposer,
  serializedCaretOffset,
} from './composerRich'
import { convertTypedShortcode, detectTrigger, emojiSuggestionItems, mentionChipFor, type AutocompleteTrigger } from './richAutocomplete'
import { MessageEditor, type MessageEditorHandle } from './MessageEditor'
import './chat.css'
import './chat-backdrop.css'
import './chat-theme.css'
import { ChannelsAndRolesPage, ChannelsAndRolesSidebarRow, useChannelsAndRoles, type ChannelsAndRolesSection } from './ChannelsAndRoles'
import { MessageAccessories, ReplyPreviewText, guardLinkClick, setEmbedSuppressPolicy, shouldHideContent, useMediaFallbacks } from './Embeds'
import { InteractionHeader, MessageComponents, ThinkingContent, hasInteractionHeader, interactionReplyPlaceholder } from './Interactions'
import { ForumPostTagsRow, ForumView, PostActionModal, PostGlyph, markPostSeen, postMenuEntries } from './Forum'

// Discord's message length cap; the composer shows the remaining count when
// within this threshold of the limit and blocks sends over it.
const CHAT_MAX_LENGTH = 2000
const CHAT_COUNTER_THRESHOLD = 100

// Resolve a stored reply reference to the message it points at. Discord-origin
// replies store the Discord snowflake (discordMessageId); web-origin replies
// store the internal bridge message id. Only messages currently loaded can
// resolve - older references render as "Original message was deleted" like
// Discord does when the target is unavailable.
function resolveReplyTarget(replyTo: string | null, messages: BridgeMessage[]): BridgeMessage | undefined {
  if (!replyTo) return undefined
  return messages.find((m) => String(m.id) === replyTo || (m.discordMessageId !== null && m.discordMessageId === replyTo))
}

interface TypingUser {
  authorKey: string
  authorName: string
  expires: number
}

// Discord groups consecutive same-author messages only when they're within its
// MESSAGE_GROUPING window (~7 minutes); longer gaps start a new group even with
// the same author. (A day divider already breaks groups at the rows level.)
const MESSAGE_GROUPING_WINDOW_MS = 7 * 60 * 1000
// Discord's sidebar banner geometry: --custom-guild-banner-height (130px on
// container_f37cb1) and --custom-channel-header-height (49px).
const GUILD_BANNER_HEIGHT = 130
const GUILD_HEADER_HEIGHT = 49

// --- Multi-guild switching ---------------------------------------------------
// The home guild's invite: the fallback for a guild without a vanity invite
// (BridgeGuild.inviteUrl null).
const FALLBACK_INVITE_URL = 'https://discord.gg/zKV3atanu'
// Last-opened guild id, last channel per guild ({ guildId: channelId }), and
// Hide Muted Channels per guild (Discord stores it per server). The legacy
// single flag ('abulxt:chat-hide-muted') is the default for guilds without a
// stored value.
const LAST_GUILD_KEY = 'abulxt:chat-last-guild'
const LAST_CHANNEL_KEY = 'abulxt:chat-last-channel'
const HIDE_MUTED_KEY = 'abulxt:chat-hide-muted-guilds'
const LEGACY_HIDE_MUTED_KEY = 'abulxt:chat-hide-muted'
const CHAT_LINK_KEY = 'abulxt:chat-link'
// A cached guild sidebar older than this is refreshed (in the background) when
// the guild is opened; a `stale` one always is.
const GUILD_CHANNELS_MAX_AGE_MS = 60_000

// One guild's cached sidebar (bridgeChannels(guildId)). `stale` = a realtime
// change made it out of date; refreshed on the next open.
interface GuildChannelsEntry {
  configured: boolean
  categories: BridgeCategory[]
  channels: BridgeChannel[]
  stale: boolean
  fetchedAt: number
}
const EMPTY_CHANNELS: BridgeChannel[] = []
const EMPTY_CATEGORIES: BridgeCategory[] = []

function readStoredMap<T>(key: string): Record<string, T> {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '{}') as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, T>) : {}
  } catch {
    return {}
  }
}
function readLastGuild(): string | null {
  try { return localStorage.getItem(LAST_GUILD_KEY) } catch { return null }
}
function rememberLastChannel(guildId: string, channelId: string) {
  const map = readStoredMap<string>(LAST_CHANNEL_KEY)
  if (map[guildId] === channelId) return
  map[guildId] = channelId
  try { localStorage.setItem(LAST_CHANNEL_KEY, JSON.stringify(map)) } catch { /* ignore */ }
}
// A guild's landing channel (Discord: the last channel you had open there),
// else #general, else the first bridged channel, else the first row.
function defaultChannelFor(guildId: string, list: BridgeChannel[]): string | null {
  if (!list.length) return null
  const last = readStoredMap<string>(LAST_CHANNEL_KEY)[guildId]
  if (last && list.some((c) => c.channelId === last)) return last
  const bridged = list.filter((c) => c.bridged !== false)
  const pickFrom = bridged.length ? bridged : list
  return (pickFrom.find((c) => c.name.toLowerCase() === 'general') || pickFrom[0]).channelId
}
type ChatLinkTarget = { guild?: string | null; channel?: string | null; message?: string | null }
function readChatLink(): ChatLinkTarget | null {
  try { return JSON.parse(sessionStorage.getItem(CHAT_LINK_KEY) || 'null') as ChatLinkTarget | null } catch { return null }
}
function clearChatLink() {
  try { sessionStorage.removeItem(CHAT_LINK_KEY) } catch { /* ignore */ }
}

// Button-triggered menu placements (shared popout helper, popout.tsx).
// Server-header dropdown: hangs off the full-width server header (the whole
// sidebar column), 8px below it, spanning the header minus an 8px gutter on
// each side; follows the header while the sidebar is resized.
const GUILD_HEADER_MENU_ANCHOR = anchorSelector('.bar .d-serverHeader')
const GUILD_HEADER_MENU_PLACEMENT: PopoutOptions = { position: 'bottom', align: 'left', spacing: 8, offset: 8, matchWidth: { inset: 8 } }
const BELL_MENU_ANCHOR = anchorSelector('.d-headerToolbar .d-headerIconBell')
const BELL_MENU_PLACEMENT: PopoutOptions = { position: 'bottom', align: 'right', spacing: 8, autoInvert: false }
// Expression picker (Discord: ExpressionPicker positionTargetRef = the
// channelTextArea, position "top", align "right", ReferencePositionLayer
// spacing 8, autoInvert) - right edge flush with the composer, 8px above it.
const COMPOSER_PICKER_ANCHOR = anchorSelector('.inputFields .d-channelTextArea')
const COMPOSER_PICKER_PLACEMENT: PopoutOptions = { position: 'top', align: 'right', spacing: 8 }
// Hover-toolbar More (⋯): right-aligned under the button.
const MSG_MORE_MENU_PLACEMENT: PopoutOptions = { position: 'bottom', align: 'right', spacing: 4 }
function sameGroup(a: BridgeMessage | undefined, b: BridgeMessage): boolean {
  if (!a) return false
  if (a.deletedAt || b.deletedAt) return false
  if (new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() > MESSAGE_GROUPING_WINDOW_MS) return false
  // Command responses always start a group (their "used /cmd" header).
  if (hasInteractionHeader(b)) return false
  // Replies and forwards always start a group (they carry their own header).
  if (b.replyTo || b.forwarded) return false
  return a.authorAvatar === b.authorAvatar && a.authorName === b.authorName && a.authorKey === b.authorKey
}

function formatDay(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })
}

// Original timestamp rendering: "Today at h:mm" / "Yesterday at h:mm" / date.
function formatTimestamp(iso: string): string {
  const time = new Date(iso)
  const now = new Date()
  const timeStr = time.toLocaleString(undefined, { hour: 'numeric', minute: 'numeric' })
  if (time.getDate() === now.getDate() && time.getMonth() === now.getMonth() && time.getFullYear() === now.getFullYear()) {
    return `Today at ${timeStr}`
  }
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (time.getDate() === yesterday.getDate() && time.getMonth() === yesterday.getMonth() && time.getFullYear() === yesterday.getFullYear()) {
    return `Yesterday at ${timeStr}`
  }
  return new Intl.DateTimeFormat('en-US', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(time)
}

// Bare "2:55 PM" - compact gutter timestamp and the jump-to-present bar ("N new
// messages since 2:55 PM"). Discord shows no brackets on either.
function formatShortTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' })
}

// Map a bridge API failure to Discord's phrasing. The server returns
// `{ error, code }` with Discord's own error codes (50013 missing-permissions,
// 50001 missing-access, 10008 unknown-message); when the code reaches us on
// the thrown error we surface Discord's short label, otherwise we fall back to
// the server's message text. Rate limits never surface: the request layer
// (lib/rate-limit-queue.ts) waits them out like Discord's client, and one it
// finally gave up on reads as the action's ordinary failure (`fallback`).
function discordErrorMessage(err: unknown, fallback: string): string {
  const e = err as (Error & { code?: number; rateLimited?: boolean }) | null
  if (e?.rateLimited) return fallback
  const code = typeof e?.code === 'number' ? e.code : null
  const raw = (e?.message || '').trim()
  if (code === 50013) return 'Missing Permissions'
  if (code === 50001) return 'Missing Access'
  if (code === 10008) return 'Unknown Message'
  // Older server responses have no code - map the known permission denials to
  // Discord's label so the toast reads like the real client.
  if (/do not have permission/i.test(raw)) return 'Missing Permissions'
  return raw || fallback
}

// Permission denials never get a toast in Discord: the control that would
// trigger the action is hidden or disabled instead (Add Reaction, Edit, Pin,
// Delete, Forward, GIF/sticker buttons), so a denial that still comes back from
// the server is dropped silently rather than shown as an error notice.
function isPermissionDenial(err: unknown): boolean {
  const e = err as (Error & { code?: number }) | null
  if (e?.code === 50013 || e?.code === 50001) return true
  return /do not have permission/i.test((e?.message || '').trim())
}

// Toggle the caller's own reaction locally (optimistic reaction pill): remove
// it when `selfKey` already reacted with `emoji`, add it otherwise. Applying it
// twice restores the original list, which is how a failed toggle reverts.
function toggleOwnReaction(reactions: BridgeReaction[] | undefined, emoji: string, selfKey: string): BridgeReaction[] {
  const list = reactions || []
  const index = list.findIndex((r) => r.emoji === emoji)
  if (index < 0) return [...list, { emoji, count: 1, reactorKeys: [selfKey] }]
  const r = list[index]
  const keys = Array.isArray(r.reactorKeys) ? r.reactorKeys : []
  if (keys.includes(selfKey)) {
    if (r.count <= 1) return list.filter((_, i) => i !== index)
    return list.map((x, i) => (i === index ? { ...x, count: x.count - 1, reactorKeys: keys.filter((k) => k !== selfKey) } : x))
  }
  return list.map((x, i) => (i === index ? { ...x, count: x.count + 1, reactorKeys: [...keys, selfKey] } : x))
}

// Optimistic (still-sending) rows get unique negative ids, even for several
// sends inside one millisecond.
let optimisticSeq = 0
function nextOptimisticId(): number {
  optimisticSeq += 1
  return -(Date.now() + optimisticSeq)
}

function defaultAvatar(name: string): string {
  let hash = 0
  for (let i = 0; i < (name || '').length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return `https://cdn.discordapp.com/embed/avatars/${Math.abs(hash) % 6}.png`
}

// Discord's five legacy default-avatar palette colors (blurple/grey/green/
// yellow/red family), reused for the offline initial-avatar fallback so the
// last-resort image still reads as Discord.
const AVATAR_FALLBACK_COLORS = ['#5865f2', '#57f287', '#fee75c', '#eb459e', '#ed4245', '#949cf7']

function hashName(name: string): number {
  let hash = 0
  for (let i = 0; i < (name || '').length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return Math.abs(hash)
}

// Last-resort avatar that can never fail to render: a data-URI SVG colored
// circle with the author's first letter. Used when both the author's real
// avatar URL and the Discord CDN default fail (expired CDN hash, offline,
// CDN blocked by the network the site is being browsed through, ...).
function initialAvatar(name: string): string {
  // color is drawn from the fixed AVATAR_FALLBACK_COLORS palette (constant hex
  // literals), so it is safe to interpolate into the attribute as-is. letter is
  // author-derived, so escape it so it can't break out of the <text> element.
  const color = AVATAR_FALLBACK_COLORS[hashName(name) % AVATAR_FALLBACK_COLORS.length]
  const letter = escapeHtml((name || '?').trim().charAt(0).toUpperCase() || '?')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">` +
    `<rect width="64" height="64" fill="${color}"/>` +
    `<text x="32" y="42" font-family="Arial,Helvetica,sans-serif" font-size="32" font-weight="700" ` +
    `fill="#ffffff" text-anchor="middle">${letter}</text></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

// <img> onError chain for message avatars: real CDN url → Discord default
// (cdn.discordapp.com/embed/avatars/N.png) → data-URI initial avatar. The
// dataset flag records which step we're on so the handler doesn't loop.
function onAvatarError(event: SyntheticEvent<HTMLImageElement>, authorName: string): void {
  const img = event.currentTarget
  if (img.dataset.fallback === 'initial') return // already at the end of the chain
  if (img.dataset.fallback === 'default') {
    img.dataset.fallback = 'initial'
    img.src = initialAvatar(authorName)
  } else {
    img.dataset.fallback = 'default'
    img.src = defaultAvatar(authorName)
  }
}

// Message markdown is Discord's own parser, ported 1:1 in markdown.ts
// (simple-markdown fork + the message rule set); this file only supplies the
// mention chips, :name: emoji lookup and code highlighting it renders with.
const sanatize = escapeHtml

// :name: / :name::skin-tone-N: → surrogate (Discord's emoji rule). Built
// lazily from the emoji dataset on first use.
let emojiNameMap: Map<string, string> | null = null
function emojiFromName(name: string): string | null {
  if (!emojiNameMap) {
    emojiNameMap = new Map()
    for (const entry of allEmoji) emojiNameMap.set(entry[0], entry[1])
  }
  const tone = /^(.+?)::skin-tone-([1-5])$/.exec(name)
  if (tone) return emojiNameMap.get(`${tone[1]}_tone${tone[2]}`) ?? null
  return emojiNameMap.get(name) ?? null
}

// A role mention's color arrives as a Discord hex string ('#rrggbb') or null.
// Only a strict hex value is allowed into the style attribute - anything else
// falls back to the standard blurple chip styling (no inline style emitted).
function roleChipStyle(color: unknown): string {
  if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) return ''
  const r = parseInt(color.slice(1, 3), 16)
  const g = parseInt(color.slice(3, 5), 16)
  const b = parseInt(color.slice(5, 7), 16)
  // Discord's role-mention look: the role color as the text color over a
  // low-alpha tint of the same color.
  return ` style="color: ${color}; background-color: rgba(${r},${g},${b},0.24)"`
}

// Channel id → Discord channel-icon kind (text / announcement / rules) for the
// static mention-chip HTML below. Refreshed by ChatPage whenever the channel
// list or the guild's rules channel changes (before message rows render).
const channelIconKinds = new Map<string, ChannelIconKind>()

// Render message content to HTML with Discord's markdown (markdown.ts):
// mention tokens become the interactive .mention chips below (resolved
// against message.mentions; unknown targets read @unknown-user /
// @unknown-role / #unknown like Discord), fenced blocks highlight through the
// lazily-loaded highlight.js grammars, then native emoji outside code become
// Twemoji and emoji-only messages get the jumbo size.
function renderContent(message: BridgeMessage): string {
  const users = new Map<string, string>()
  const channels = new Map<string, string>()
  const roles = new Map<string, string>()
  for (const mention of message.mentions || []) {
    if (!mention.id) continue
    if (mention.type === 'user') {
      users.set(mention.id, `<span class="mention interactive" data-mention-type="user" id="${sanatize(mention.id)}">@${sanatize(mention.username || mention.id)}</span>`)
    } else if (mention.type === 'channel') {
      // Discord's channel mention (channelWithIcon, module 232042): non-text
      // channels lead with their type glyph (icon_b75563: 1em, 4px gap)
      // instead of '#' - announcement → AnnouncementsIcon, rules → BookCheck.
      const iconKind = channelIconKinds.get(mention.id) || 'text'
      const chipName = sanatize(mention.name || mention.id)
      const chipBody = iconKind === 'text'
        ? `#${chipName}`
        : `<span class="channelWithIcon">${channelIconSvgHtml(iconKind, 'chat-channelMentionIcon')}<span class="chat-channelMentionName">${chipName}</span></span>`
      channels.set(mention.id, `<span class="mention interactive" data-mention-type="channel" id="${sanatize(mention.id)}">${chipBody}</span>`)
    } else if (mention.type === 'role') {
      // Role-colored chip (@RoleName); the payload's hex color is read
      // defensively and an invalid one falls back to the blurple chip.
      const style = roleChipStyle((mention as { color?: unknown }).color)
      roles.set(mention.id, `<span class="mention interactive role"${style} data-mention-type="role" id="${sanatize(mention.id)}">@${sanatize(mention.name || mention.id)}</span>`)
    }
  }
  const html = renderMarkdown(message.content || '', {
    userMention: (id) => users.get(id) ?? null,
    channelMention: (id) => channels.get(id) ?? null,
    roleMention: (id) => roles.get(id) ?? null,
    // @everyone/@here always render as the (non-interactive) mention chip,
    // as in Discord; whether they pinged is decided by message.mentions.
    everyoneMention: (which) => `<span class="mention" data-mention-type="everyone">@${which}</span>`,
    emojiFromName,
    highlight: highlightCode,
  })
  return applyJumbo(mapOutsideCode(html, twemojify))
}

/* Jumbo emoji: a message whose content is ONLY emoji (no text) renders larger in
 * Discord (~32px). After the content is fully rendered, detect the emoji-only
 * case by stripping every emoji <img> and confirming nothing but whitespace
 * remains. When it qualifies (and the emoji count is within Discord's ~27 cap),
 * add a `jumboable` class to each emoji <img> so the .content .emoji.jumboable
 * CSS rule upsizes them.
 *
 * Detection runs on the rendered HTML string (no DOM needed): an "emoji img" is
 * any <img … class="…emoji…"> tag. Removing all of them plus whitespace must
 * leave an empty string. */
const JUMBO_CAP = 27
const EMOJI_IMG_RE = /<img\b[^>]*\bclass="[^"]*\bemoji\b[^"]*"[^>]*>/g
// Custom guild emoji are emitted as <img …></img> (explicit closer) while
// twemoji imgs self-close - strip any stray </img> when testing emoji-only.
const IMG_CLOSE_RE = /<\/img>/g
function applyJumbo(html: string): string {
  const emojiTags = html.match(EMOJI_IMG_RE)
  if (!emojiTags || emojiTags.length === 0 || emojiTags.length > JUMBO_CAP) return html
  // Strip all emoji imgs (+ their optional </img> closers) and any whitespace;
  // if anything else remains, there is real text/markup and the message is not
  // emoji-only.
  const rest = html.replace(EMOJI_IMG_RE, '').replace(IMG_CLOSE_RE, '').replace(/\s+/g, '')
  if (rest !== '') return html
  return html.replace(EMOJI_IMG_RE, (tag) =>
    tag.replace(/\bclass="([^"]*)"/, (_m, cls: string) => `class="${cls} jumboable"`),
  )
}

// The identity pieces used to decide whether a message mentions the signed-in
// user: their linked Discord snowflake plus the display names a mention chip
// could carry (Discord display name/username, site username, chat nickname),
// and the chat role ids they hold (from the /perms payload) for role-ping
// highlighting.
interface MentionSelf {
  discordId: string | null
  names: string[]
  roleIds: string[]
}

// Discord's mentioned-message test: the message's mentions array names the
// caller (by Discord user id or by display name), mentions @everyone/@here,
// or mentions a role the caller holds; or the raw content pings their
// snowflake (<@id>/<@!id>) or one of their @names. Mention chips carry
// the mentioned party's display name (guild displayName for Discord users,
// the site username for web-originated messages), so the name check is what
// catches web-to-web pings - their <@id> tokens are rewritten to plain text
// server-side, while Discord pings keep both the token and the mentions row.
// Name matches are escaped and word-boundaried so "al" doesn't ping "alice".
// `suppress` mirrors the server's Notification Settings checkboxes (Suppress
// @everyone and @here / Suppress All Role @mentions): those pings stop
// counting toward unread-mention badges; the row highlight passes none.
function messageMentionsUser(message: BridgeMessage, self: MentionSelf, suppress?: { everyone: boolean; roles: boolean }): boolean {
  // Inert mentions (neutralized by the server's ping limits) keep their chip
  // but never highlight - Discord's non-pinging mention. One naming the
  // caller also disables the raw-content fallback below for this message.
  let inertSelf = false
  for (const mention of message.mentions || []) {
    if (mention.inert) {
      if ((self.discordId && mention.id === self.discordId) || (mention.username && self.names.includes(mention.username))) inertSelf = true
      continue
    }
    if (mention.type === 'everyone') {
      if (suppress?.everyone) continue
      return true
    }
    if (mention.type === 'role') {
      if (suppress?.roles) continue
      // A role ping highlights when the caller holds that role. The caller's
      // own role id comes from the /perms payload (perms.roleId).
      if (mention.id && self.roleIds.includes(mention.id)) return true
      continue
    }
    // Reply ping: the replied-to author, recorded by the server only when the
    // reply was sent with "@ ON" (a quiet "@ OFF" reply never highlights).
    if (mention.type === 'reply') {
      if (message.replyMention === false) continue
      if (self.discordId && mention.id === self.discordId) return true
      if (mention.username && self.names.includes(mention.username)) return true
      continue
    }
    if (mention.type !== 'user') continue
    if (self.discordId && mention.id === self.discordId) return true
    if (mention.username && self.names.includes(mention.username)) return true
  }
  if (inertSelf) return false
  const content = message.content || ''
  if (self.discordId && new RegExp(`<@!?${self.discordId}>`).test(content)) return true
  for (const name of self.names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`@${escaped}(?!\\w)`, 'i').test(content)) return true
  }
  return false
}

// Discord message-toolbar glyphs (ripped from the live client's SVGs).
function ToolbarReplyIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path fill="currentColor" d="M2.3 7.3a1 1 0 0 0 0 1.4l5 5a1 1 0 0 0 1.4-1.4L5.42 9H11a7 7 0 0 1 7 7v4a1 1 0 1 0 2 0v-4a9 9 0 0 0-9-9H5.41l3.3-3.3a1 1 0 0 0-1.42-1.4l-5 5Z"/>
    </svg>
  )
}

function ToolbarEditIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path fill="currentColor" d="m13.96 5.46 4.58 4.58a1 1 0 0 0 1.42 0l1.38-1.38a2 2 0 0 0 0-2.82l-3.18-3.18a2 2 0 0 0-2.82 0l-1.38 1.38a1 1 0 0 0 0 1.42ZM2.11 20.16l.73-4.22a3 3 0 0 1 .83-1.61l7.87-7.87a1 1 0 0 1 1.42 0l4.58 4.58a1 1 0 0 1 0 1.42l-7.87 7.87a3 3 0 0 1-1.6.83l-4.23.73a1.5 1.5 0 0 1-1.73-1.73Z"/>
    </svg>
  )
}

function ToolbarMoreIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d="M4 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm10-2a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm8 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z"/>
    </svg>
  )
}

// Discord's ReactionIcon (the plain filled smiley, module 460905) at size
// "sm" (18px), as the reactions row's add-reaction button renders it.
function ReactionBarIcon() {
  return (
    <svg className="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d="M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22ZM6.5 13a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm11 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm-9.8 1.17a1 1 0 0 1 1.39.27 3.5 3.5 0 0 0 5.82 0 1 1 0 0 1 1.66 1.12 5.5 5.5 0 0 1-9.14 0 1 1 0 0 1 .27-1.4Z" />
    </svg>
  )
}

// Whether this author gets Discord's APP botTag on the website. Only
// Discord-originated bot/app authors (real bots, foreign webhooks: authorBot).
// Web messages (direction 'web') are our own site users delivered through the
// channel webhook; on the website they're first-class users, so they never
// get the tag even though Discord itself shows APP on the webhook delivery.
function isAppAuthor(message: Pick<BridgeMessage, 'direction' | 'authorBot'>): boolean {
  return message.direction !== 'web' && message.authorBot === true
}

// Discord's BotTag (type BOT, unverified) as the message header renders it:
// botTag + botTagRegular + rem sizing, plus botTagCompact (before the name)
// or botTagCozy (after it). Verified apps add a check icon; webhooks and the
// bridge's own deliveries are never verified, so it is plain "APP".
function BotTag({ compact }: { compact: boolean }) {
  return (
    <span className={`botTag ${compact ? 'botTagCompact' : 'botTagCozy'} botTagRegular`}>
      <span className="botText">APP</span>
    </span>
  )
}

// Reply-line glyph - Discord's replyBadge: a small 12×8 curved reply arrow
// pointing back toward the replied-to message, distinct from the hover
// toolbar's 24px reply icon.
function ReplyBadgeIcon() {
  return (
    <svg width="12" height="8" viewBox="0 0 12 8" aria-hidden="true" fill="none">
      <path fill="currentColor" d="M0.809739 3.59646L5.12565 0.468433C5.17446 0.431163 5.23323 0.408043 5.2951 0.401763C5.35698 0.395482 5.41943 0.406298 5.4752 0.432954C5.53096 0.45961 5.57776 0.50101 5.61013 0.552343C5.64251 0.603676 5.65914 0.662833 5.6581 0.722939V2.3707C10.3624 2.3707 11.2539 5.52482 11.3991 7.21174C11.4028 7.27916 11.3848 7.34603 11.3474 7.40312C11.3101 7.46021 11.2554 7.50471 11.1908 7.53049C11.1262 7.55626 11.0549 7.56204 10.9868 7.54703C10.9187 7.53201 10.857 7.49695 10.8104 7.44666C8.72224 5.08977 5.6581 5.63359 5.6581 5.63359V7.28135C5.65831 7.34051 5.64141 7.39856 5.60931 7.44894C5.5772 7.49932 5.53117 7.54004 5.4764 7.5665C5.42163 7.59296 5.3603 7.60411 5.29932 7.59869C5.23834 7.59328 5.18014 7.57151 5.13128 7.53585L0.809739 4.40892C0.744492 4.3616 0.691538 4.30026 0.655067 4.22975C0.618596 4.15925 0.599609 4.08151 0.599609 4.00269C0.599609 3.92386 0.618596 3.84612 0.655067 3.77562C0.691538 3.70511 0.744492 3.64377 0.809739 3.59646Z"/>
    </svg>
  )
}

// Discord's "Add Reaction" smiley-plus glyph (the icon in the hover toolbar's
// Add Reaction button and the reactions row's add button). The face is an
// evenodd ring (not a solid disc) so the eyes/smile read; a plus badge sits in
// the bottom-right. The previous single-path version filled the whole face AND
// the features with currentColor, rendering as a featureless white circle.
function AddReactionIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path fill="currentColor" d="M19 14a1 1 0 0 1 .1 0l.05.01h.04l.01.01.07.02h.01l.06.02h.02A1 1 0 0 1 20 15v3h3a1 1 0 1 1 0 2h-3v3a1 1 0 1 1-2 0v-3h-3a1 1 0 0 1-.96-.72l-.01-.05A1 1 0 0 1 14 19a1.01 1.01 0 0 1 .35-.76l.02-.02a.95.95 0 0 1 .05-.04c.01 0 .02 0 .03-.02a.96.96 0 0 1 .06-.03l.02-.01.05-.03.04-.02a.98.98 0 0 1 .07-.02h.01a1 1 0 0 1 .2-.05H18v-3a1 1 0 0 1 1-1Z"/>
      <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d="M10.67 1.33a9.33 9.33 0 0 1 9.22 10.76c-.04.29-.34.45-.63.42L19 12.5a2.5 2.5 0 0 0-2.5 2.5v1a.5.5 0 0 1-.5.5h-1a2.5 2.5 0 0 0-2.49 2.24l-.01.26.01.26c.03.29-.13.59-.42.63a9.31 9.31 0 0 1-10.76-9.22 9.33 9.33 0 0 1 9.34-9.34Zm3.64 11.18a.85.85 0 0 0-1.17.23 2.97 2.97 0 0 1-4.94 0 .85.85 0 1 0-1.41.94 4.66 4.66 0 0 0 7.76 0 .85.85 0 0 0-.24-1.17ZM6 8.97a1.27 1.27 0 1 0 0 2.54 1.27 1.27 0 0 0 0-2.54Zm9.33 0a1.27 1.27 0 1 0 0 2.55 1.27 1.27 0 0 0 0-2.55Z"/>
    </svg>
  )
}

// Forward - Discord's share-arrow glyph (the reply arrow mirrored: bends right
// and points forward). Used by the toolbar/menu Forward action and the
// "Forwarded" header on forwarded messages.
function ToolbarForwardIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path fill="currentColor" d="M21.7 7.3a1 1 0 0 1 0 1.4l-5 5a1 1 0 0 1-1.4-1.4L18.58 9H13a7 7 0 0 0-7 7v4a1 1 0 1 1-2 0v-4a9 9 0 0 1 9-9h5.59l-3.3-3.3a1 1 0 0 1 1.42-1.4l5 5Z"/>
    </svg>
  )
}

// Server-header dropdown chevron (Discord's header chevron).
function ChevronDownIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" className="serverHeaderChevron">
      <path fill="currentColor" d="M5.3 9.3a1 1 0 0 1 1.4 0l5.3 5.29 5.3-5.3a1 1 0 1 1 1.4 1.42l-6 6a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.42Z"/>
    </svg>
  )
}

// Invite-to-server (person-add) glyph from the live client's invite button.
function InviteIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path fill="currentColor" d="M14.5 8a3 3 0 1 0-2.7-4.3c-.2.4.06.86.44 1.12a5 5 0 0 1 2.14 3.08c.01.06.06.1.12.1ZM16.62 13.17c-.22.29-.65.37-.92.14-.34-.3-.7-.57-1.09-.82-.52-.33-.7-1.05-.47-1.63.11-.27.2-.57.26-.87.11-.54.55-1 1.1-.92 1.6.2 3.04.92 4.15 1.98.3.27-.25.95-.65.95a3 3 0 0 0-2.38 1.17ZM15.19 15.61c.13.16.02.39-.19.39a3 3 0 0 0-1.52 5.59c.2.12.26.41.02.41h-8a.5.5 0 0 1-.5-.5v-2.1c0-.25-.31-.33-.42-.1-.32.67-.67 1.58-.88 2.54a.2.2 0 0 1-.2.16A1.5 1.5 0 0 1 2 20.5a7.5 7.5 0 0 1 13.19-4.89ZM9.5 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM15.5 22Z"/>
      <path fill="currentColor" d="M19 14a1 1 0 0 1 1 1v3h3a1 1 0 0 1 0 2h-3v3a1 1 0 0 1-2 0v-3h-3a1 1 0 1 1 0-2h3v-3a1 1 0 0 1 1-1Z"/>
    </svg>
  )
}

// Channel-type glyphs (text / announcement / rules) live in channelIcons.tsx,
// ripped from Discord's bundle (the old hand-drawn megaphone was invented).

// Welcome-block hash glyph - the same open-center Discord hash as the channel
// row, rendered at Discord's 48px welcome-icon size (inside the 68px circle).
// Same path + fillRule="evenodd" as channelIcons.tsx TEXT_ICON_PATH.
function WelcomeHashIcon({ size = 48, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path fillRule="evenodd" clipRule="evenodd" d="M10.99 3.16A1 1 0 1 0 9 2.84L8.15 8H4a1 1 0 0 0 0 2h3.82l-.67 4H3a1 1 0 1 0 0 2h3.82l-.8 4.84a1 1 0 0 0 1.97.32L8.85 16h4.97l-.8 4.84a1 1 0 0 0 1.97.32l.86-5.16H20a1 1 0 1 0 0-2h-3.82l.67-4H21a1 1 0 1 0 0-2h-3.82l.8-4.84a1 1 0 1 0-1.97-.32L15.15 8h-4.97l.8-4.84ZM14.15 14l.67-4H9.85l-.67 4h4.97Z"/>
    </svg>
  )
}

// Category-header chevron (Discord's icon__29444): a 12px down-chevron that
// rotates -90° when the category is collapsed (CSS owns the rotation).
function CategoryChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path fill="currentColor" d="M5.3 9.3a1 1 0 0 1 1.4 0l5.3 5.29 5.3-5.3a1 1 0 1 1 1.4 1.42l-6 6a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.42Z"/>
    </svg>
  )
}

// Channel-header toolbar glyphs (ripped from the live client). The bridge only
// has real surfaces for Notifications, Pinned, Inbox, Help, and Search, so the
// toolbar shows exactly those five (dead icons would be worse than absent).
function BellIcon({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M9.7 2.89c.18-.07.32-.24.37-.43a2 2 0 0 1 3.86 0c.05.2.19.36.38.43A7 7 0 0 1 19 9.5v2.09c0 .12.05.24.13.33l1.1 1.22a3 3 0 0 1 .77 2.01v.28c0 .67-.34 1.29-.95 1.56-1.31.6-4 1.51-8.05 1.51-4.05 0-6.74-.91-8.05-1.5-.61-.28-.95-.9-.95-1.57v-.28a3 3 0 0 1 .77-2l1.1-1.23a.5.5 0 0 0 .13-.33V9.5a7 7 0 0 1 4.7-6.61ZM9.18 19.84A.16.16 0 0 0 9 20a3 3 0 1 0 6 0c0-.1-.09-.17-.18-.16a24.86 24.86 0 0 1-5.64 0Z"/>
    </svg>
  )
}

// Discord's header Help glyph (question mark in a circle).
function HelpIcon({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22Zm-.28-16c-.98 0-1.81.47-2.27 1.14A1 1 0 1 1 7.8 7.01 4.73 4.73 0 0 1 11.72 5c2.5 0 4.65 1.88 4.65 4.38 0 2.1-1.54 3.77-3.52 4.24l.14 1a1 1 0 0 1-1.98.27l-.28-2a1 1 0 0 1 .99-1.14c1.54 0 2.65-1.14 2.65-2.38 0-1.23-1.1-2.37-2.65-2.37ZM13 17.88a1.13 1.13 0 1 1-2.25 0 1.13 1.13 0 0 1 2.25 0Z"/>
    </svg>
  )
}

// Discord's community flower-star badge (the small flower shown before the
// server name in the header of a Community server).
// Community server flowerStar - markup lifted from live Discord's server
// header: tier-2 purple→pink gradient flower with a white house glyph
// centred on top (.flowerStarContainer / .flowerStar / .childContainer).
function CommunityFlowerBadge() {
  const gradId = `flowerStar-${useId().replace(/:/g, '')}`
  return (
    <div className="flowerStarContainer" style={{ width: 18, height: 18 }}>
      <svg className="flowerStar" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <defs>
          <linearGradient id={gradId} gradientTransform="rotate(45)">
            <stop offset="0" stopColor="var(--premium-tier-2-purple)" />
            <stop offset="1" stopColor="var(--premium-tier-2-pink)" />
          </linearGradient>
        </defs>
        <path fill={`url(#${gradId})`} fillRule="evenodd" clipRule="evenodd" d="M5.52995 0.431867C6.27995 0.181867 7.2 1.23199 8 1.23199C8.8 1.23199 9.75007 0.231867 10.4701 0.431867C11.19 0.631965 11.38 2.07173 12 2.52171C12.62 2.9717 14.0003 2.70184 14.4603 3.32184C14.9199 3.94191 14.2303 5.16178 14.4603 5.91169C14.6903 6.66159 15.9998 7.21166 16 8.00153C16 8.79146 14.72 9.38146 14.4798 10.0914C14.2398 10.8014 14.9198 12.0919 14.4798 12.6819C14.0397 13.2716 12.6401 13.0321 12.0202 13.482C11.4002 13.932 11.2298 15.3219 10.4798 15.5719C9.72987 15.8216 8.80967 14.7717 8.00973 14.7717C7.2098 14.7719 6.25964 15.7718 5.53971 15.5719C4.81995 15.3716 4.61982 13.9321 4 13.482C3.38 13.032 1.99971 13.3019 1.53971 12.6819C1.07975 12.0619 1.76971 10.8414 1.53971 10.0914C1.30939 9.34159 0 8.79139 0 8.00153C0.000177681 7.21159 1.2802 6.62163 1.52018 5.91169C1.76012 5.20167 1.08021 3.91183 1.52018 3.32184C1.96018 2.73184 3.36999 3.0017 4 2.52171C4.62997 2.04173 4.78003 0.681954 5.52995 0.431867Z"/>
      </svg>
      <div className="childContainer">
        <svg width="11" height="11" fill="none" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="var(--white)" d="m2.4 8.4 8.38-6.46a2 2 0 0 1 2.44 0l8.39 6.45a2 2 0 0 1-.79 3.54l-.32.07-.82 8.2a2 2 0 0 1-1.99 1.8H16a1 1 0 0 1-1-1v-5a3 3 0 1 0-6 0v5a1 1 0 0 1-1 1H6.31a2 2 0 0 1-1.99-1.8L3.5 12l-.32-.07a2 2 0 0 1-.79-3.54Z"/>
        </svg>
      </div>
    </div>
  )
}

// The ✕ the server-header chevron swaps to while the server-actions menu is
// open (live Discord replaces the chevron with a close glyph).
function HeaderCloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" className="serverHeaderChevron">
      <path fill="currentColor" d="M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z"/>
    </svg>
  )
}

function PinIcon({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M19.38 11.38a3 3 0 0 0 4.24 0l.03-.03a.5.5 0 0 0 0-.7L13.35.35a.5.5 0 0 0-.7 0l-.03.03a3 3 0 0 0 0 4.24L13 5l-2.92 2.92-3.65-.34a2 2 0 0 0-1.6.58l-.62.63a1 1 0 0 0 0 1.42l9.58 9.58a1 1 0 0 0 1.42 0l.63-.63a2 2 0 0 0 .58-1.6l-.34-3.64L19 11l.38.38ZM9.07 17.07a.5.5 0 0 1-.08.77l-5.15 3.43a.5.5 0 0 1-.63-.06l-.42-.42a.5.5 0 0 1-.06-.63L6.16 15a.5.5 0 0 1 .77-.08l2.14 2.14Z"/>
    </svg>
  )
}

// Discord's Inbox (tray) glyph - the rightmost channel-header toolbar button.
function InboxIcon({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M5 2a3 3 0 0 0-3 3v14a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V5a3 3 0 0 0-3-3H5ZM4 5.5C4 4.67 4.67 4 5.5 4h13c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5h-2.65c-.5 0-.85.5-.85 1a3 3 0 1 1-6 0c0-.5-.35-1-.85-1H5.5A1.5 1.5 0 0 1 4 11.5v-6Z"/>
    </svg>
  )
}

/* === Context-menu / misc filled glyphs ===
 * Discord's icon set is SOLID FILLED - every menu glyph below is a filled
 * path (fill="currentColor", viewBox 0 0 24 24), never a lucide stroked
 * outline. Default size is 18px to match the context-menu icon slot. */

// Copy Message ID / Copy Server Info - Discord's filled copy glyph.
function MenuCopyIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M15.3 14.48c-.46.45-1.08.67-1.86.67h-1.39V9.2h1.39c.78 0 1.4.22 1.86.67.46.45.68 1.22.68 2.31 0 1.1-.22 1.86-.68 2.31Z"/>
      <path fillRule="evenodd" clipRule="evenodd" d="M5 2a3 3 0 0 0-3 3v14a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V5a3 3 0 0 0-3-3H5Zm1 15h2.04V7.34H6V17Zm4-9.66V17h3.44c1.46 0 2.6-.42 3.38-1.25.8-.83 1.2-2.02 1.2-3.58s-.4-2.75-1.2-3.58c-.79-.83-1.92-1.25-3.38-1.25H10Z"/>
    </svg>
  )
}

// Resend message - Discord's RefreshIcon (two chasing arrows).
function MenuResendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M21 2a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 1 1 0-2h3.93A8 8 0 0 0 6.97 5.78a1 1 0 0 1-1.26-1.56A9.98 9.98 0 0 1 20 6V3a1 1 0 0 1 1-1ZM3 22a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H5.07a8 8 0 0 0 11.96 2.22 1 1 0 1 1 1.26 1.56A9.99 9.99 0 0 1 4 18v3a1 1 0 0 1-1 1Z" />
    </svg>
  )
}

// Failed-message hover bar Retry - Discord's RetryIcon (one circular arrow).
function ToolbarRetryIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M4 12a8 8 0 0 1 14.93-4H15a1 1 0 1 0 0 2h6a1 1 0 0 0 1-1V3a1 1 0 1 0-2 0v3a9.98 9.98 0 0 0-18 6 10 10 0 0 0 16.29 7.78 1 1 0 0 0-1.26-1.56A8 8 0 0 1 4 12Z" />
    </svg>
  )
}

// Copy Text - filled clipboard-with-lines glyph.
function MenuCopyTextIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M3 16a1 1 0 0 1-1-1v-5a8 8 0 0 1 8-8h5a1 1 0 0 1 1 1v.5a.5.5 0 0 1-.5.5H10a6 6 0 0 0-6 6v5.5a.5.5 0 0 1-.5.5H3Z"/>
      <path d="M6 18a4 4 0 0 0 4 4h8a4 4 0 0 0 4-4v-4h-3a5 5 0 0 1-5-5V6h-4a4 4 0 0 0-4 4v8Z"/>
      <path d="M21.73 12a3 3 0 0 0-.6-.88l-4.25-4.24a3 3 0 0 0-.88-.61V9a3 3 0 0 0 3 3h2.73Z"/>
    </svg>
  )
}

// Copy Message Link - Discord's filled chain-link glyph.
function MenuLinkIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M16.32 14.72a1 1 0 0 1 0-1.41l2.51-2.51a3.98 3.98 0 0 0-5.62-5.63l-2.52 2.51a1 1 0 0 1-1.41-1.41l2.52-2.52a5.98 5.98 0 0 1 8.45 8.46l-2.52 2.51a1 1 0 0 1-1.41 0ZM7.68 9.29a1 1 0 0 1 0 1.41l-2.52 2.51a3.98 3.98 0 1 0 5.63 5.63l2.51-2.52a1 1 0 0 1 1.42 1.42l-2.52 2.51a5.98 5.98 0 0 1-8.45-8.45l2.51-2.51a1 1 0 0 1 1.42 0Z"/>
      <path d="M14.7 10.7a1 1 0 0 0-1.4-1.4l-4 4a1 1 0 1 0 1.4 1.4l4-4Z"/>
    </svg>
  )
}

// Delete Message - Discord's filled trash glyph.
function MenuTrashIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M14.25 1c.41 0 .75.34.75.75V3h5.25c.41 0 .75.34.75.75v.5c0 .41-.34.75-.75.75H3.75A.75.75 0 0 1 3 4.25v-.5c0-.41.34-.75.75-.75H9V1.75c0-.41.34-.75.75-.75h4.5Z"/>
      <path fillRule="evenodd" clipRule="evenodd" d="M5.06 7a1 1 0 0 0-1 1.06l.76 12.13a3 3 0 0 0 3 2.81h8.36a3 3 0 0 0 3-2.81l.75-12.13a1 1 0 0 0-1-1.06H5.07ZM11 12a1 1 0 1 0-2 0v6a1 1 0 1 0 2 0v-6Zm3-1a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1Z"/>
    </svg>
  )
}

// Mute Server menu entry + muted-server header badge - Discord's filled
// crossed-out bell.
function MenuBellOffIcon({ size = 18, className, label }: { size?: number; className?: string; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-label={label} aria-hidden={label ? undefined : true} role={label ? 'img' : undefined}>
      <path d="M1.3 21.3a1 1 0 1 0 1.4 1.4l20-20a1 1 0 0 0-1.4-1.4l-20 20ZM3.13 16.13c.11.27.46.28.66.08L15.73 4.27a.47.47 0 0 0-.07-.74 6.97 6.97 0 0 0-1.35-.64.62.62 0 0 1-.38-.43 2 2 0 0 0-3.86 0 .62.62 0 0 1-.38.43A7 7 0 0 0 5 9.5v2.09a.5.5 0 0 1-.13.33l-1.1 1.22A3 3 0 0 0 3 15.15v.28c0 .24.04.48.13.7ZM18.64 9.36c.13-.13.36-.05.36.14v2.09c0 .12.05.24.13.33l1.1 1.22a3 3 0 0 1 .77 2.01v.28c0 .67-.34 1.29-.95 1.56-1.31.6-4 1.51-8.05 1.51-.46 0-.9-.01-1.33-.03a.48.48 0 0 1-.3-.83l8.27-8.28ZM9.18 19.84A.16.16 0 0 0 9 20a3 3 0 1 0 6 0c0-.1-.09-.17-.18-.16a24.84 24.84 0 0 1-5.64 0Z"/>
    </svg>
  )
}

// Mark Unread - filled open-envelope glyph.
function MenuMailOpenIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12.93 21.96c.25-.03.43-.23.47-.47a3 3 0 0 1 .08-.35.66.66 0 0 0-.24-.71A3 3 0 0 1 12 18v-3a3 3 0 0 1 4.35-2.68c.14.07.3.09.44.04a7 7 0 0 1 4.58.05c.3.1.63-.1.63-.41a10 10 0 1 0-18.45 5.36c.13.19.11.44-.04.61l-2.06 2.37A1 1 0 0 0 2.2 22H12c.32 0 .63-.01.93-.04Z"/>
      <path d="M18 17h-1.24a3 3 0 1 1 .26 4.25 1 1 0 1 0-1.33 1.5A4.98 4.98 0 0 0 24 19a5 5 0 0 0-8-4 1 1 0 0 0-2 0v3a1 1 0 0 0 1 1h3a1 1 0 1 0 0-2Z"/>
    </svg>
  )
}

// Open Link / Open Original (link & image menus) - Discord's filled
// arrow-out-of-box ("open in new") glyph.
function MenuOpenIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M15 2a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0V4.41l-4.3 4.3a1 1 0 1 1-1.4-1.42L19.58 3H16a1 1 0 0 1-1-1Z"/>
      <path d="M5 2a3 3 0 0 0-3 3v14a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3v-6a1 1 0 1 0-2 0v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h6a1 1 0 1 0 0-2H5Z"/>
    </svg>
  )
}

// Set Status (own-avatar menu) - Discord's filled status dot glyph.
function MenuStatusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M16 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM2 20.53A9.53 9.53 0 0 1 11.53 11h.94c1.28 0 2.5.25 3.61.7.41.18.36.77-.05.96a7 7 0 0 0-3.65 8.6c.11.36-.13.74-.5.74H6.15a.5.5 0 0 1-.5-.55l.27-2.6c.02-.26-.27-.37-.41-.16-.48.74-1.03 1.8-1.32 2.9a.53.53 0 0 1-.5.41h-.22C2.66 22 2 21.34 2 20.53Z"/>
      <path d="M24 19a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z"/>
    </svg>
  )
}

// Error toast - Discord's filled circle-exclamation.
function MenuCircleAlertIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d="M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22Zm1.44-15.94L13.06 14a1.06 1.06 0 0 1-2.12 0l-.38-6.94a1 1 0 0 1 1-1.06h.88a1 1 0 0 1 1 1.06Zm-.19 10.69a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z"/>
    </svg>
  )
}

// Close (×) - Discord's filled X (same path as HeaderCloseIcon, parametrized
// for the toast / reply-preview / settings close buttons).
function MenuCloseIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z"/>
    </svg>
  )
}

// User-panel User Settings - Discord's filled cog glyph.

// "Pick a channel" placeholder - filled speech-bubble glyph.
function PlaceholderChatIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 22a10 10 0 1 0-8.45-4.64c.13.19.11.44-.04.61l-2.06 2.37A1 1 0 0 0 2.2 22H12Z"/>
    </svg>
  )
}

// Auth modal icon - filled chat-bubble glyph.
function AuthChatIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 22a10 10 0 1 0-8.45-4.64c.13.19.11.44-.04.61l-2.06 2.37A1 1 0 0 0 2.2 22H12Z"/>
    </svg>
  )
}

type PresenceStatusValue = 'online' | 'idle' | 'dnd' | 'invisible'

// Discord presence glyphs - the live client's svg-mask-status-* definitions
// (maskContentUnits="objectBoundingBox", viewBox 0 0 1 1) scaled to 10×10:
//   online    = circle r.5
//   idle      = circle r.5 minus circle (.25,.25) r.375
//   dnd       = circle r.5 minus rounded rect x.125 y.375 w.75 h.25 r.125
//   invisible = circle r.5 minus circle r.25 (svg-mask-status-offline)
// The glyph always fills its box; the wrapping .status span's border acts as
// the cutout ring of panel/card background (Discord's mask trick).
function StatusIcon({ status }: { status: PresenceStatusValue }) {
  const maskId = `statusMask-${useId().replace(/:/g, '')}`
  let cutout: React.ReactNode = null
  if (status === 'idle') cutout = <circle fill="black" cx="2.5" cy="2.5" r="3.75" />
  else if (status === 'dnd') cutout = <rect fill="black" x="1.25" y="3.75" width="7.5" height="2.5" rx="1.25" ry="1.25" />
  else if (status === 'invisible') cutout = <circle fill="black" cx="5" cy="5" r="2.5" />
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true">
      {cutout && (
        <mask id={maskId}>
          <circle fill="white" cx="5" cy="5" r="5" />
          {cutout}
        </mask>
      )}
      <circle cx="5" cy="5" r="5" fill="currentColor" mask={cutout ? `url(#${maskId})` : undefined} />
    </svg>
  )
}

// Genuine user edit vs. server-side embed resolution. Both stamp edited_at
// and arrive via bridge.message.edited: (a) the author editing content (the
// "(edited)" tag's real signal), and (b) Discord's messageUpdate when a
// webhook-delivered message's link unfurl or reply context resolves (the bot
// mirrors it through editByDiscordMessageId), plus the bridge's own unfurl
// echo. (b) lands within a moment of creation and must NOT render "(edited)";
// a real edit always comes later. Gate the tag on the stamp being meaningfully
// after createdAt (Discord's own embed-resolution updates arrive in ~1-2s).
const USER_EDIT_MIN_AGE_MS = 4000
function isUserEdit(message: BridgeMessage): boolean {
  if (!message.editedAt) return false
  const edited = new Date(message.editedAt).getTime()
  const created = new Date(message.createdAt).getTime()
  if (!Number.isFinite(edited) || !Number.isFinite(created)) return Boolean(message.editedAt)
  return edited - created > USER_EDIT_MIN_AGE_MS
}

// Discord's "(edited)" marker (edited_c19a55 inside a <time>): hovering it
// shows the black tooltip with the full edit timestamp, e.g. "Wednesday,
// October 8, 2026 at 1:16 AM" (Discord's LLLL calendar format).
function EditedTag({ editedAt }: { editedAt: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const date = new Date(editedAt)
  const full = Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'short' }).format(date)
    : ''
  return (
    <span className="editedTag" onMouseEnter={(e) => setAnchor(e.currentTarget)} onMouseLeave={() => setAnchor(null)}>
      <time dateTime={editedAt} aria-label={full ? `Edited ${full}` : undefined}>(edited)</time>
      {anchor && full && <HoverTooltip anchor={anchor}>{full}</HoverTooltip>}
    </span>
  )
}

function MessageBody({ message, onOpenMention, onContextAction }: {
  message: BridgeMessage
  onOpenMention?: (mention: { type: string; id: string; username?: string; name?: string }, event: React.MouseEvent) => void
  /* Right-click routing for elements inside the rendered content. The handler
     receives the resolved element kind + payload; the parent owns the menus. */
  onContextAction?: (action:
    | { kind: 'link'; url: string }
    | { kind: 'emoji'; name: string; surrogates: string }
    | { kind: 'code'; code: string }
    | { kind: 'image'; url: string },
    event: React.MouseEvent) => void
}) {
  // Fenced blocks render plain until the lazily-loaded highlight.js grammars
  // arrive, then this re-renders them highlighted (Discord's renderFallback →
  // render swap in its codeBlock rule).
  useHighlighterReady(messageHasCodeBlock(message))
  // A direct-media link preview that failed to load is withdrawn (Embeds.tsx);
  // re-render so shouldHideContent shows the link text again.
  useMediaFallbacks()
  // Hover tooltip for markup elements that carry one (<t:…> timestamps show
  // their full date, Discord's timestamp tooltip).
  const [mdTooltip, setMdTooltip] = useState<{ anchor: Element; text: string } | null>(null)
  // Discord forward: a small "Forwarded" header (share arrow + italic label),
  // then the source snapshot inside a left-barred quote block with the
  // source's timestamp underneath. The snapshot renders through MessageBody
  // itself (forwarded cleared) so markdown/mentions/embeds look identical;
  // the snapshot's mentions are display-only (the row's own mentions are
  // empty, so a forward never pings or highlights).
  if (message.forwarded) {
    const snap = message.forwarded
    const inner: BridgeMessage = {
      ...message,
      content: snap.content || '',
      attachments: Array.isArray(snap.attachments) ? snap.attachments : [],
      embeds: Array.isArray(snap.embeds) ? snap.embeds : [],
      mentions: Array.isArray(snap.mentions) ? snap.mentions : [],
      editedAt: null,
      forwarded: null,
      components: Array.isArray(snap.components) ? snap.components : [],
      interaction: null,
      messageType: 0,
      flags: 0,
    }
    return (
      <div className="msgForward">
        <div className="msgForwardHeader">
          <ToolbarForwardIcon size={16} />
          <span>Forwarded</span>
        </div>
        <div className="msgForwardBody">
          <MessageBody message={inner} onOpenMention={onOpenMention} onContextAction={onContextAction} />
          {snap.createdAt && (
            <div className="msgForwardFooter">
              <time dateTime={snap.createdAt}>{formatTimestamp(snap.createdAt)}</time>
            </div>
          )}
        </div>
      </div>
    )
  }
  // Discord hides the text of a message that is only the URL of its single
  // image/GIFV embed (pasted GIFs and image links show just the media).
  const hideContent = shouldHideContent(message)
  // Content is injected via dangerouslySetInnerHTML, so interactive elements
  // inside it (spoilers, mention chips) are handled by event delegation here:
  // - .spoiler toggles .revealed (click-to-reveal).
  // - .mention.interactive resolves the chip's id against message.mentions and
  //   hands it to the parent: user → profile popout, channel → navigate to
  //   that channel, role → role-members popout. @everyone/@here chips aren't
  //   .interactive (Discord doesn't make them clickable).
  const onContentHover = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement | null)?.closest('[data-md-tooltip]')
    if (el && el !== mdTooltip?.anchor) setMdTooltip({ anchor: el, text: el.getAttribute('data-md-tooltip') || '' })
  }
  const onContentHoverOut = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!mdTooltip) return
    const to = e.relatedTarget as Node | null
    if (to && mdTooltip.anchor.contains(to)) return
    setMdTooltip(null)
  }
  const onContentClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null
    // Code-block copy button (codeActions, shown on hover).
    if (handleCodeCopyClick(target)) return
    const spoiler = target?.closest('.spoiler')
    if (spoiler) {
      spoiler.classList.toggle('revealed')
      return
    }
    const chip = target?.closest('.mention.interactive') as HTMLElement | null
    if (chip && onOpenMention) {
      const id = chip.id || chip.getAttribute('id') || ''
      const mention = (message.mentions || []).find((m) => m.id === id)
      if (mention && (mention.type === 'user' || mention.type === 'channel' || mention.type === 'role')) onOpenMention(mention, e)
    }
    // Masked links ([text](url)) to untrusted domains get Discord's
    // "Leaving Discord" confirmation before navigating.
    const anchor = target?.closest('a[href]') as HTMLAnchorElement | null
    if (anchor) guardLinkClick(e, anchor)
  }
  // Right-click delegation over the injected content HTML (same pattern as
  // onContentClick). Priority matches Discord: a link wins over everything it
  // wraps; then emoji imgs; then code (block <pre><code> or inline <code>).
  const onContentContext = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onContextAction) return
    const target = e.target as HTMLElement | null
    // Emoji imgs (twemoji + custom guild emoji) - check before links so an
    // emoji inside a masked link still gets the emoji menu (Discord shows the
    // emoji menu when the pointer is on the emoji itself).
    const emojiImg = target?.closest('img.emoji') as HTMLImageElement | null
    if (emojiImg) {
      // Custom guild emoji carry data=":name:" + alt=name; twemoji carry
      // alt=<surrogates> and the name isn't known - fall back to the glyph.
      const data = emojiImg.getAttribute('data') || ''
      const name = data.replace(/:/g, '') || emojiImg.alt || ''
      onContextAction({ kind: 'emoji', name, surrogates: emojiImg.alt || '' }, e)
      return
    }
    const link = target?.closest('a[href]') as HTMLAnchorElement | null
    if (link) {
      onContextAction({ kind: 'link', url: link.href }, e)
      return
    }
    const codeEl = target?.closest('pre code, code, pre') as HTMLElement | null
    if (codeEl) {
      // Right-click on the <pre>'s own padding copies the block too (the
      // <code> child holds the text either way).
      const holder = codeEl.tagName.toUpperCase() === 'PRE' ? (codeEl.querySelector('code') as HTMLElement | null) ?? codeEl : codeEl
      onContextAction({ kind: 'code', code: holder.textContent || '' }, e)
      return
    }
  }
  // Only a genuine user edit renders the (edited) tag - server-side embed
  // resolution (link unfurl / Discord's webhook messageUpdate) stamps
  // edited_at within a moment of creation and must not make a fresh message
  // look edited.
  const showEdited = isUserEdit(message)
  return (
    <>
      <ThinkingContent message={message} />
      {message.content && !hideContent && (
        <div className="content" onClick={onContentClick} onContextMenu={onContentContext} onMouseOver={onContentHover} onMouseOut={onContentHoverOut}>
          {/* The edited tag is the LAST inline child of the content flow
              (Discord renders "(edited)" inline at the end of the text, not as
              a sibling after the content). The content HTML is injected in a
              nested span so the tag can follow it inline. */}
          {/* isSending: Discord dims a not-yet-delivered message's markup
              (opacity .5) - optimistic rows have negative ids until /send
              (possibly after a quiet rate-limit wait) reconciles them. */}
          <span className={message.sendState === 'failed' ? 'isFailed' : message.id < 0 ? 'isSending' : undefined} dangerouslySetInnerHTML={{ __html: renderContent(message) }} />
          {showEdited && message.editedAt && <EditedTag editedAt={message.editedAt} />}
          {mdTooltip && mdTooltip.anchor.isConnected && <HoverTooltip anchor={mdTooltip.anchor}>{mdTooltip.text}</HoverTooltip>}
        </div>
      )}
      {/* Discord message accessories: attachment mosaics / file cards /
          players / text previews, then embeds (Embeds.tsx, 1:1 with the
          Discord client). */}
      <MessageAccessories
        message={message}
        renderMarkdown={(content) => renderContent({ ...message, content })}
        onContextAction={onContextAction}
      />
      {/* Message components (action rows, Components V2) after the embeds,
          as in Discord's message accessories. Text displays render through
          the same markdown/mention pipeline as the content. */}
      <MessageComponents message={message} renderMarkdown={(content) => renderContent({ ...message, content })} />
    </>
  )
}

// Deterministic pseudo-random widths for the skeleton rows so the stack reads
// like real message text (varying header/content widths) without re-laying-out
// on every render. 12 rows matches Discord's initial placeholder density.
const SKELETON_ROWS: Array<{ header: number; lines: number[] }> = Array.from({ length: 12 }, (_, i) => {
  const seed = (i * 2654435761) % 1000 / 1000 // 0..1, stable per index
  const header = 18 + Math.round(seed * 22) // header blob 18%..40%
  const lineCount = 1 + (i % 3) // 1..3 content blobs
  const lines = Array.from({ length: lineCount }, (_l, j) => {
    const s = ((i * 7 + j * 13) * 2654435761) % 1000 / 1000
    // Last line of a multi-line message is shorter (like real wrapped text).
    return j === lineCount - 1 ? 34 + Math.round(s * 34) : 62 + Math.round(s * 30)
  })
  return { header, lines }
})

// Discord's message-list skeleton: a stack of placeholder rows shown while
// channel history loads, replacing the old bare "Loading…" line. Cozy rows are
// a 40px avatar circle + header blob + content blob(s); compact rows swap the
// avatar for the small left gutter (timestamp) blob. Every blob is a
// low-opacity shimmer div (see .chat-skeleton-* in chat.css).
// === Discord's ChannelMessages windowing (web build, constants module
// 652215 + MessageStore) ===
// MAX_MESSAGES_PER_CHANNEL (EMb) = 30: page size for loading older/newer
// chunks and for Jump To Present. MAX_LOADED_MESSAGES (UNo) = 120: once a
// chunk load leaves more than this in the window, the far end is truncated
// down to TRUNCATED_MESSAGE_VIEW_SIZE (rLJ) = 60 - truncating the newest end
// sets hasMoreAfter, which is the ONLY thing that shows the "You're Viewing
// Older Messages" bar. Jump-to-message fetches `around` the target with
// limit d7Q = 30.
const MESSAGES_PER_FETCH = 30
const MAX_LOADED_MESSAGES = 120
const TRUNCATED_MESSAGE_VIEW_SIZE = 60
const JUMP_FETCH_LIMIT = 30
// Discord's initial fetch (module 326337, "MessageManager.initialFetch"):
// enough rows to fill the viewport - max(10, min(30, ceil(1.05 *
// ceil(max(innerHeight - 145, 400) / (compact ? 65 : 91))))) at the default
// 16px font. The top placeholder then preloads the next chunk.
function initialFetchLimit(compact: boolean): number {
  const height = Math.max((typeof window !== 'undefined' ? window.innerHeight : 800) - 145, 400)
  return Math.max(10, Math.min(MESSAGES_PER_FETCH, Math.ceil(1.05 * Math.ceil(height / (compact ? 65 : 91)))))
}
// How close (px) the scroller may get to a placeholder edge before the next
// chunk is requested. Discord renders placeholder rows at a window edge that
// has more history (hasMoreBefore / hasMoreAfter) and loads when they near the
// viewport, so a normal scroll rarely sees them.
const LOAD_MORE_THRESHOLD_PX = 600
// Discord's isAtBottom (DimensionStore) is exact (scrollTop === scrollHeight
// - offsetHeight); allow a couple of px for fractional scroll positions.
const AT_BOTTOM_EPSILON_PX = 2
// Reaching the present again: realtime arrivals held back while the window
// was detached (newer than the rows being attached) join the tail.
function appendArrivals(rows: BridgeMessage[], held: BridgeMessage[]): BridgeMessage[] {
  if (!held.length) return rows
  const newest = rows.reduce((max, m) => Math.max(max, m.id), 0)
  const have = new Set(rows.map((m) => m.id))
  return [...rows, ...held.filter((m) => m.id > newest && !have.has(m.id))]
}

function MessageSkeleton({ appearance }: { appearance: 'compact' | 'cozy' }) {
  const compact = appearance !== 'cozy'
  return (
    <div className="chat-skeleton" aria-hidden="true">
      {SKELETON_ROWS.map((row, i) => (
        <div key={i} className={`chat-skeleton-row ${compact ? 'compact' : 'cozy'}`}>
          <div className="chat-skeleton-blob chat-skeleton-avatar" />
          <div className="chat-skeleton-body">
            <div className="chat-skeleton-blob chat-skeleton-header" style={{ width: `${row.header}%` }} />
            {row.lines.map((width, j) => (
              <div
                key={j}
                className={`chat-skeleton-blob chat-skeleton-content ${width < 60 ? 'short' : 'long'}`}
                style={{ width: `${width}%` }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export function ChatPage() {
  // Every bridged guild the caller can view (the rail), in server order.
  const [guilds, setGuilds] = useState<BridgeGuild[]>([])
  const guildsRef = useRef<BridgeGuild[]>([])
  guildsRef.current = guilds
  // The guild list answered at least once (empty or not).
  const [guildsSettled, setGuildsSettled] = useState(false)
  // Per-guild sidebar cache. Every guild's list is fetched at startup (the
  // rail badges need them all); the open guild's entry is what the sidebar
  // renders. Written only through setGuildChannels.
  const [channelsByGuild, setChannelsByGuild] = useState<Record<string, GuildChannelsEntry>>({})
  const channelsByGuildRef = useRef(channelsByGuild)
  channelsByGuildRef.current = channelsByGuild
  // The open guild (rail selection). The ref is written synchronously with the
  // state so callbacks in the same tick see the switch; the id is persisted
  // as the last-used guild.
  const [activeGuildId, setActiveGuildIdState] = useState<string | null>(null)
  const activeGuildIdRef = useRef<string | null>(null)
  const setActiveGuildId = useCallback((guildId: string | null) => {
    activeGuildIdRef.current = guildId
    setActiveGuildIdState(guildId)
    if (guildId) { try { localStorage.setItem(LAST_GUILD_KEY, guildId) } catch { /* ignore */ } }
  }, [])
  // Derived views of the open guild: the render code keeps reading
  // `channels` / `categories`.
  const activeGuildEntry = activeGuildId ? channelsByGuild[activeGuildId] : undefined
  const channels = activeGuildEntry?.channels ?? EMPTY_CHANNELS
  const categories = activeGuildEntry?.categories ?? EMPTY_CATEGORIES
  const bridgeConfigured = !guildsSettled || (guilds.length > 0 && activeGuildEntry?.configured !== false)
  const channelsLoaded = guildsSettled && (!activeGuildId || Boolean(activeGuildEntry))
  // channel id → guild id / channel row, across every cached guild (read
  // state, mention counts, deep links and realtime routing are global).
  const channelGuild = useMemo(() => {
    const map = new Map<string, string>()
    for (const [guildId, entry] of Object.entries(channelsByGuild)) for (const c of entry.channels) map.set(c.channelId, guildId)
    return map
  }, [channelsByGuild])
  const channelGuildRef = useRef(channelGuild)
  channelGuildRef.current = channelGuild
  const allChannels = useMemo(() => {
    const map = new Map<string, BridgeChannel>()
    for (const entry of Object.values(channelsByGuild)) for (const c of entry.channels) map.set(c.channelId, c)
    return map
  }, [channelsByGuild])
  const allChannelsRef = useRef(allChannels)
  allChannelsRef.current = allChannels
  // Late-bound guild switch (defined below, once every piece of UI state it
  // resets exists) for earlier-declared callbacks.
  const selectGuildRef = useRef<(guildId: string, target?: { channelId?: string | null }) => void>(() => {})
  // Late-bound deep-link resolver (see applyChatLink).
  const applyChatLinkRef = useRef<() => 'none' | 'wait' | 'done'>(() => 'none')
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null)
  // The open forum post (Discord's "Open in Full View"): activeChannelId is
  // then the post (thread) id and the message view, history, composer and
  // every per-channel route run against it (contract.md). Cleared when any
  // other channel opens.
  const [openPost, setOpenPostState] = useState<ForumPost | null>(null)
  const openPostRef = useRef<ForumPost | null>(null)
  const setOpenPost = useCallback((post: ForumPost | null) => {
    openPostRef.current = post
    setOpenPostState(post)
  }, [])
  // Post moderation modal (rename / edit tags / delete) for the open post.
  const [postModal, setPostModal] = useState<{ kind: 'rename' | 'tags' | 'delete'; post: ForumPost } | null>(null)
  const [messages, setMessages] = useState<BridgeMessage[]>([])
  const [typing, setTyping] = useState<TypingUser[]>([])
  const [user, setUser] = useState<AbulxtUser | null>(null)
  const [showAuth, setShowAuth] = useState(false)
  const [error, setErrorState] = useState<string | null>(null)
  const [needsVerification, setNeedsVerification] = useState(false)
  // Channel the caller can't view (history denied): shown in the channel body.
  const [viewDeniedChannelId, setViewDeniedChannelId] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(false)
  // Per-category collapse (Discord's collapsible category chevron), keyed by
  // category id and persisted like Discord. Clicking a header hides/shows its
  // channel rows (the selected/unread ones stay, as on Discord) and the
  // chevron rotates -90°.
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('abulxt:chat-collapsed-categories') || '{}') as unknown
      return raw && typeof raw === 'object' ? (raw as Record<string, boolean>) : {}
    } catch {
      return {}
    }
  })
  const setCategoryCollapsed = useCallback((ids: string[], collapsed: boolean | 'toggle') => {
    setCollapsedCategories((current) => {
      const next = { ...current }
      for (const id of ids) {
        const value = collapsed === 'toggle' ? !current[id] : collapsed
        if (value) next[id] = true
        else delete next[id]
      }
      try { localStorage.setItem('abulxt:chat-collapsed-categories', JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [])
  const [sending, setSending] = useState(false)
  // In-flight reaction toggles per message id (optimistic reconcile waits for
  // the last one so queued toggles don't flicker).
  const pendingReactsRef = useRef(new Map<number, number>())
  // Own sends that failed (Discord's SEND_FAILED rows), by clientId, for the
  // session only (not persisted across reloads, like Discord).
  const failedSendsRef = useRef(new Map<string, { message: BridgeMessage; replyMention: boolean | undefined }>())
  const [emojiMenuOpen, setEmojiMenuOpen] = useState(false)
  const chatPrefs = useChatPrefs()
  // Default appearance = cozy. The shared default lives in preferences.ts
  // (chatAppearance: "cozy"); the `?? 'cozy'` here is a defensive fallback.
  // Compact stays available via the appearance settings.
  const [appearance, setAppearance] = useState<BrowserPreferences['chatAppearance']>(
    () => loadBrowserPreferences().chatAppearance ?? 'cozy',
  )
  // Read by the history loader (initial fetch size depends on density)
  // without making appearance a reload dependency.
  const appearanceRef = useRef(appearance)
  appearanceRef.current = appearance
  const [nickname] = useState(() => loadBrowserPreferences().chatNickname)
  // Active APPROVED uploaded avatar url ('' = none; fall back to the linked
  // Discord avatar, then the default). Loaded from /api/avatars/me; the old
  // free-form avatar URL preference is gone.
  const [chatAvatar, setChatAvatar] = useState('')
  const [perms, setPerms] = useState<BridgePerms | null>(null)
  // Publish the channel's embed-suppress (hover X) policy to Embeds.tsx.
  useEffect(() => { setEmbedSuppressPolicy(perms?.embedSuppress) }, [perms])
  const [timeoutRemaining, setTimeoutRemaining] = useState<number | null>(null)
  const [klipyKey, setKlipyKey] = useState<string | null>(null)
  const [canSendEmbeds, setCanSendEmbeds] = useState(false)
  const [profile, setProfile] = useState<ProfileData | null>(null)
  // Guild-rail hover tooltip + right-click context menu.
  const [guildTip, setGuildTip] = useState<{ guildId: string; anchorY: number } | null>(null)
  const [guildMenu, setGuildMenu] = useState<{ guildId: string; x: number; y: number; anchored?: boolean } | null>(null)
  // Message-level context menu (right-click on a message row, or the hover
  // toolbar's "More" ⋯ button). Anchored either to the cursor (right-click) or
  // to the More button (toolbar). `reactTarget` arms the expression picker in
  // react-to-this-message mode. (The pending reply target lives with the
  // composer state below - the context menu's Reply item calls startReply().)
  const [msgMenu, setMsgMenu] = useState<{ message: BridgeMessage; x: number; y: number; anchor?: Element } | null>(null)
  const [reactTarget, setReactTarget] = useState<BridgeMessage | null>(null)
  // Where the react-mode picker hangs (the clicked Add Reaction button);
  // null = composer mode, anchored to the channel text area.
  const [reactAnchor, setReactAnchor] = useState<{ el: Element; placement: PopoutOptions } | null>(null)
  // Live picker/react state for onAddReaction's toggle check (read without
  // making the callback depend on it).
  const reactStateRef = useRef<{ open: boolean; targetId: number | null; anchorEl: Element | null }>({ open: false, targetId: null, anchorEl: null })
  reactStateRef.current = { open: emojiMenuOpen, targetId: reactTarget?.id ?? null, anchorEl: reactAnchor?.el ?? null }
  /* Element context menus - Discord shows a right-click menu on nearly every
     chat surface, each with its own action set: channel rows, message authors,
     links/images/emoji/code inside message content, reaction chips, the
     user-panel avatar, and the channel header. One slot covers them all (only
     one menu is ever open at a time); the entries are built at open time so
     they close over the target. */
  const [elemMenu, setElemMenu] = useState<{ entries: MenuEntry[]; x: number; y: number; ariaLabel: string } | null>(null)
  // Discord's delete confirmation modal ("Delete Message - Are you sure?").
  // Set by onDelete(); the dialog's Delete button runs the bridge delete.
  const [deleteTarget, setDeleteTarget] = useState<BridgeMessage | null>(null)
  const [deleting, setDeleting] = useState(false)
  // Forward Message dialog (Discord's forward modal): the message being
  // forwarded, per-channel send progress, and the channel ids that already
  // received it (their Send button flips to a disabled "Sent" state).
  const [forwardTarget, setForwardTarget] = useState<BridgeMessage | null>(null)
  const [forwardingTo, setForwardingTo] = useState<string | null>(null)
  const [forwardedTo, setForwardedTo] = useState<string[]>([])
  const guildTipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Server-header element - the left-click server-actions menu anchors to its
  // bottom-left corner (live Discord behavior) instead of the cursor.
  const guildHeaderRef = useRef<HTMLDivElement>(null)
  // Discord's ChannelMessages.hasMoreAfter: the loaded window is detached
  // from the present (newer messages were truncated off the bottom, or a
  // jump-to-message landed in older history). This - not scroll position -
  // is what shows the "You're Viewing Older Messages" bar. (hasMore above is
  // hasMoreBefore.) The ref mirrors it for the rt event handler.
  const [hasMoreAfter, setHasMoreAfterState] = useState(false)
  const hasMoreAfterRef = useRef(false)
  const setHasMoreAfter = useCallback((value: boolean) => {
    hasMoreAfterRef.current = value
    setHasMoreAfterState(value)
  }, [])
  // Jump To Present in flight: the bar swaps its button for Discord's pulsing
  // ellipsis (jumpToPresentBar with no onClick).
  const [jumpLoading, setJumpLoading] = useState(false)
  // One chunk load at a time (Discord's ChannelMessages.loadingMore).
  const loadingMoreRef = useRef(false)
  // Messages that arrived over rt while detached: not rendered (Discord keeps
  // them out of the window), merged back in when Jump To Present lands.
  const detachedArrivalsRef = useRef<BridgeMessage[]>([])
  // Scroll anchor for prepends/truncations: the first visible row and its
  // offset from the list top, restored after the window changes.
  const scrollAnchorRef = useRef<{ id: number; top: number } | null>(null)
  // Post-trim direction lock: after a chunk load truncates the far end, the
  // opposite edge's placeholder may land inside the trigger zone. Discord's
  // anchor keeps it out; we also refuse that direction until the USER scrolls
  // toward it (lastScrollTopRef tracks user scroll direction; programmatic
  // anchor restores re-sync it so they never count as a user scroll).
  const suppressLoadRef = useRef<'before' | 'after' | null>(null)
  const lastScrollTopRef = useRef(0)
  // Live mirror of the loaded window for the rt handler's truncation checks.
  const messagesRef = useRef<BridgeMessage[]>([])
  messagesRef.current = messages
  // Jump-bar new-message counter (Discord's "N new messages since <time>" bar
  // text): count + timestamp of the first message that arrived in the active
  // channel while the user was scrolled up. Reset on jump-to-present, on
  // reaching the bottom, and on channel switch.
  const [newSinceScrollUp, setNewSinceScrollUp] = useState<{ count: number; since: string | null }>({ count: 0, since: null })
  // Unread "NEW" divider (Discord's .isUnread__908e2): the message id the red
  // divider sits above - the first unread message in the loaded window. Pinned
  // when history loads (captured from the pre-load read marker, since markRead
  // advances lastRead to the newest message immediately); live arrivals while
  // scrolled up extend below it without moving it. Cleared on channel switch
  // and once the user catches up (jumps to present / reads the channel).
  const [unreadDivider, setUnreadDivider] = useState<{ channelId: string; beforeId: number } | null>(null)
  // Read state: newest message id seen per channel, persisted across sessions.
  const [lastRead, setLastRead] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem('abulxt:chat-read') || '{}') } catch { return {} }
  })
  // A browser with no read state at all (first visit): each guild's first
  // sidebar load marks its channels read (Discord acks a server you join)
  // instead of lighting up every channel ever posted in.
  const firstVisitRef = useRef<boolean | null>(null)
  if (firstVisitRef.current === null) {
    try { firstVisitRef.current = localStorage.getItem('abulxt:chat-read') === null } catch { firstVisitRef.current = false }
  }
  // Latest message id seen per channel (drives unread badges for inactive
  // channels). Seeded from each channel's lastMessageId (max only) and bumped
  // by bridge.message.
  const [latestByChannel, setLatestByChannel] = useState<Record<string, number>>({})
  const latestByChannelRef = useRef(latestByChannel)
  latestByChannelRef.current = latestByChannel
  // The caller's guild role ids per guild (role-mention counting for guilds
  // that aren't open): fetched per guild at sign-in (`perms?guild=`) and
  // refreshed from the open channel's perms.
  const [guildRoleIds, setGuildRoleIds] = useState<Record<string, string[]>>({})
  const guildRoleIdsRef = useRef(guildRoleIds)
  guildRoleIdsRef.current = guildRoleIds
  // Unread mention counts per channel for the sidebar's red mention badge.
  // Seeded from each channel's loaded history and bumped live by bridge.message
  // events for inactive channels; markRead zeroes it.
  const [unreadMentions, setUnreadMentions] = useState<Record<string, number>>({})

  const listRef = useRef<HTMLDivElement>(null)
  const listContentRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const typingSentAt = useRef(0)
  const activeChannelRef = useRef<string | null>(null)
  activeChannelRef.current = activeChannelId
  // The channel whose history is currently in `messages` (null while a
  // channel switch is loading) - gates the message-jump pager.
  const historyChannelRef = useRef<string | null>(null)
  // Paging cursor for a live (unbridged) channel: the live id just past the
  // oldest Discord message of the last page (null = use the oldest row).
  // nextAfter is the same past the newest Discord message (detached paging).
  const liveCursorRef = useRef<{ channelId: string; nextBefore: number | null; nextAfter: number | null } | null>(null)
  // Late-bound handlers used by earlier-declared callbacks/rt events.
  const pinsRefreshRef = useRef<((channelId: string) => void) | null>(null)
  const userRef = useRef<AbulxtUser | null>(null)
  userRef.current = user
  // Live mirror of the caller's perms (webhook keys) for the rt handler's
  // "does this moderation event target me?" check.
  const permsRef = useRef<BridgePerms | null>(null)
  useEffect(() => { permsRef.current = perms }, [perms])
  // Member-moderation modal (Timeout / Ban) for a webhook identity, and the
  // per-target moderation view cache (server `target` route) that decides
  // which moderation entries a user menu shows.
  const [modModal, setModModal] = useState<{ kind: ModerationModalKind; target: ModerationModalTarget; channelId: string } | null>(null)
  const modTargetCache = useRef(new Map<string, { at: number; value: BridgeModTarget | null }>())
  // Live mirror of the channel list for the rt event handler + callbacks that
  // must check a channel's `bridged` flag without re-subscribing (same pattern
  // as activeChannelRef/userRef). `bridged !== false` = bridged.
  const channelsRef = useRef<BridgeChannel[]>([])
  channelsRef.current = channels
  // Live mirror of mentionSelf for the rt event handler (same pattern as
  // activeChannelRef/userRef - applyEvent is subscribed once and reads refs).
  const mentionSelfRef = useRef<MentionSelf>({ discordId: null, names: [], roleIds: [] })
  // Server notification suppress flags for mention counting (kept current below).
  const mentionSuppressRef = useRef({ everyone: false, roles: false })
  // Auto-dismiss timer for the Discord-style error toast: a new error restarts
  // the clock; unmount clears it. (Discord notices are ephemeral, not pinned.)
  const errorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Message-row hover state drives the hover action toolbar (.msgButtons). CSS
  // :hover chaining (message:hover → pointer-events:auto on the pill) races the
  // pill's own hit area when the pointer travels into the pill's 25px overhang
  // above the row; React mouseenter/leave are DOM-containment based, so the
  // toolbar (a child of .message) keeps the row "hovered" no matter where the
  // pointer is inside it. The `hovered` class is gated in our appended CSS.
  const [hoveredMsgId, setHoveredMsgId] = useState<number | null>(null)
  // Shift held while hovering a message expands Discord's hover bar (extra
  // Copy ID / Copy Link / Mark Unread / Pin / Reply-self / Delete buttons,
  // quick reactions hidden). Tracked globally; blur resets it.
  const [shiftHeld, setShiftHeld] = useState(false)
  useEffect(() => {
    const down = (e: globalThis.KeyboardEvent) => { if (e.key === 'Shift') setShiftHeld(true) }
    const up = (e: globalThis.KeyboardEvent) => { if (e.key === 'Shift') setShiftHeld(false) }
    const reset = () => setShiftHeld(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', reset)
    }
  }, [])
  // Quick-reaction hover tooltip (Discord's two-line ":name:" / "Click to
  // react" bubble) - the hovered quick-react button.
  const [quickReactTip, setQuickReactTip] = useState<{ el: Element; name: string; remove: boolean } | null>(null)
  // The hover bar's 3 frecent emoji, in the user's skin tone; re-read when
  // usage or the tone changes.
  const [quickReacts, setQuickReacts] = useState<EmojiEntry[]>(() => quickReactionEmoji().map((e) => applyTone(e, getEmojiTone())))
  useEffect(() => {
    const refresh = () => setQuickReacts(quickReactionEmoji().map((e) => applyTone(e, getEmojiTone())))
    const offUsage = onEmojiUsage(refresh)
    const offTone = onEmojiTone(refresh)
    return () => { offUsage(); offTone() }
  }, [])
  // Pending reply target (Discord's "Replying to <name>" composer strip). Set
  // by startReply() from the hover-toolbar Reply button or the context menu;
  // cleared by the strip's × or after a successful send. The payload carries
  // the referenced message id so the bridge can persist reply_to.
  const [replyTo, setReplyTo] = useState<{ id: number; authorName: string; content: string; self: boolean } | null>(null)
  // Discord's reply-bar "@ ON/OFF" switch: whether the reply pings the
  // replied-to author (allowed_mentions.replied_user). Re-armed ON per reply.
  const [replyMention, setReplyMention] = useState(true)
  // Composer content mirror (the contenteditable is uncontrolled, so we track
  // its text length here to drive the send button + 2000-char counter).
  const [composerLength, setComposerLength] = useState(0)
  // Mention autocomplete (Discord's @-tab). `mentionTrigger` is the live
  // trigger span in the composer text: `trigger` is '@', '#', or '@&' (role
  // mention), `start` the offset of that trigger in textContent, `query` the
  // text after it up to the caret. Non-null while the caret sits in a mention
  // query; the debounced fetch fills `mentionSuggestions` and the Composer
  // renders the popup above the bar.
  const [mentionTrigger, setMentionTrigger] = useState<AutocompleteTrigger | null>(null)
  const [mentionSuggestions, setMentionSuggestions] = useState<{ members: BridgeMemberSuggestion[]; roles: BridgeRoleSuggestion[]; channels: BridgeChannelSuggestion[] } | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const mentionFetchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mentionFetchSeq = useRef(0)
  // Inline message edit (Discord's Edit flow): the message id currently being
  // edited plus the textarea's draft. Set by startEdit() from the hover-toolbar
  // Edit button or context menu; Enter saves, Esc cancels. Only one message can
  // be in edit mode at a time, matching Discord.
  const [editingMsgId, setEditingMsgId] = useState<number | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  // The rich inline editor (MessageEditor.tsx) - its imperative handle lets
  // the expression picker insert emoji while `editPickerOpen` routes picks to
  // it instead of the composer.
  const editorRef = useRef<MessageEditorHandle>(null)
  const [editPickerAnchor, setEditPickerAnchor] = useState<HTMLElement | null>(null)
  // Composer expression-picker tab: the GIF and Sticker buttons deep-link the
  // picker to their tab (like Discord); the emoji button/hover toolbar use the
  // emoji tab. Reset to 'emoji' every time the picker closes.
  const [pickerTab, setPickerTab] = useState<PickerTab>('emoji')
  // Channel-header Pinned Messages popover. Pins are read live from Discord
  // (GET /pins) each time the popover opens; `pinnedIds` mirrors the active
  // channel's pinned bridge message ids for the message menu's Pin/Unpin.
  const [pinsOpen, setPinsOpen] = useState(false)
  const [pins, setPins] = useState<BridgePin[] | null>(null)
  const [pinsError, setPinsError] = useState<string | null>(null)
  const [pinnedIds, setPinnedIds] = useState<{ channelId: string; ids: number[] } | null>(null)
  // Reactions popout (Discord's reactions list: tabs per emoji, reactor rows).
  // The message is looked up live from `messages`, so counts stay current.
  const [reactorsPopout, setReactorsPopout] = useState<{ messageId: number; emoji: string; anchor: Element } | null>(null)
  // Role-mention popout (Discord opens a member list for a clicked @role).
  const [rolePopout, setRolePopout] = useState<{
    roleId: string
    name: string
    color: string | null
    // The clicked mention chip (Discord anchors the popout to it).
    anchor: Element
    data: BridgeRoleMembers | null
    error: string | null
  } | null>(null)
  // Pending message jump (Copy Message Link deep links, pinned-message Jump):
  // switch to the channel, page history back until the message is loaded,
  // then scroll to it and flash it.
  const [pendingJump, setPendingJump] = useState<{ channelId: string; messageId: number } | null>(null)
  // Mirror for the channel-load effect: a jump into a channel that isn't open
  // loads `around` the target directly instead of the newest page first.
  const pendingJumpRef = useRef(pendingJump)
  pendingJumpRef.current = pendingJump
  // The `around` fetch for the pending jump: in flight, or done (a target
  // still missing afterwards was deleted - give up instead of refetching).
  const jumpAroundRef = useRef<{ key: string; done: boolean } | null>(null)
  // Channel-header Inbox (Mentions) popover. Discord's Inbox sits at the far
  // right of the header; its Mentions tab lists recent messages that ping the
  // caller. The bridge has no inbox endpoint, so opening the popover pulls the
  // recent history of every loaded channel and filters client-side with the
  // same messageMentionsUser() test that drives the mentioned-row highlight.
  const [inboxOpen, setInboxOpen] = useState(false)
  const [inboxLoading, setInboxLoading] = useState(false)
  const [inboxMentions, setInboxMentions] = useState<Array<{ message: BridgeMessage; channelName: string; guildName: string | null }>>([])
  // Channel-header Help ("About this chat") popover. A small floating panel
  // explaining what the bridge is and linking to the Discord invite.
  const [helpOpen, setHelpOpen] = useState(false)
  // Channel-header Search (Discord's searchBar + search autocomplete popout +
  // searchResultsWrap sidebar; see ChannelSearch.tsx). searchOpen is the
  // autocomplete popout; the shared query/results state lives in the hook so
  // the header bar and the right-hand results sidebar stay in sync.
  const [searchOpen, setSearchOpen] = useState(false)
  const search = useChannelSearch(activeGuildId)
  // Channel-header Notification Settings popover. No notif backend exists, so
  // the level is a localStorage-persisted per-channel preference (radio rows,
  // Discord's per-channel notif flyout shape).
  const [notifOpen, setNotifOpen] = useState(false)
  // Server "Notification Settings" modal (guild context menu / header dropdown).
  const [guildNotifModal, setGuildNotifModal] = useState<string | null>(null)
  const bellDownOpen = useRef(false)
  // 'muted' is the derived "channel (or its category) is muted" state; the
  // stored levels + timed mutes live in useNotificationSettings (notifSettings.ts).
  type NotifLevel = BaseNotifLevel | 'muted'
  const notif = useNotificationSettings()
  // User-panel presence status (Discord's avatar "Set status" popover). The
  // choice is stored server-side (users.presence_status) and seeded from the
  // account; the shown state (live sockets, invisible) arrives on the realtime bus.
  type PresenceStatus = 'online' | 'idle' | 'dnd' | 'invisible'
  const [statusOpen, setStatusOpen] = useState(false)
  const selfPresence = useSelfPresence()
  const presence: PresenceStatus = selfPresence.choice === 'idle' || selfPresence.choice === 'dnd' || selfPresence.choice === 'invisible'
    ? selfPresence.choice
    : 'online'
  const ownShown = selfPresence.shown && selfPresence.shown !== 'offline' ? selfPresence.shown : presence
  useEffect(() => { seedSelfChoice(user?.presenceStatus) }, [user?.presenceStatus])
  // Live mirror of the notification store for the realtime handler (per-guild
  // suppress flags when counting mentions in any guild).
  const notifRef = useRef(notif)
  notifRef.current = notif
  // Hide Muted Channels (guild context menu) - a localStorage-persisted client
  // view preference, per guild (Discord stores it per server). Guilds with no
  // stored value inherit the old single flag. Server mutes live in
  // useNotificationSettings.
  const [hideMutedDefault] = useState(() => { try { return localStorage.getItem(LEGACY_HIDE_MUTED_KEY) === '1' } catch { return false } })
  const [hideMutedByGuild, setHideMutedByGuild] = useState<Record<string, boolean>>(() => readStoredMap<boolean>(HIDE_MUTED_KEY))
  const isHideMuted = useCallback((guildId: string | null | undefined) => (
    guildId && guildId in hideMutedByGuild ? Boolean(hideMutedByGuild[guildId]) : hideMutedDefault
  ), [hideMutedByGuild, hideMutedDefault])
  const hideMutedChannels = isHideMuted(activeGuildId)
  // Developer Mode (User Settings > Advanced): gates the "Copy … ID" menu entries.
  const developerMode = useDeveloperMode()
  // Channels & Roles (ChannelsAndRoles.tsx): the open section replaces the
  // chat column (Discord's customize-community / channel-browser routes);
  // its writes refetch the sidebar.
  const [crSection, setCrSection] = useState<ChannelsAndRolesSection | null>(null)
  // Navigating to a channel (search jump, deep link, View) leaves the page.
  useEffect(() => { setCrSection(null) }, [activeChannelId])
  // Channel-sidebar width (Discord's draggable splitter on the sidebar's right
  // edge). Applied to .bar (and the floating user panel, which spans rail +
  // sidebar) via the --chat-sidebar-width custom property on .chat-page;
  // persisted to localStorage. Double-clicking the handle resets to 240px.
  const SIDEBAR_MIN = 180
  const SIDEBAR_MAX = 400
  const SIDEBAR_DEFAULT = 240
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem('abulxt:chat-sidebar-width'))
    return Number.isFinite(saved) && saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX ? saved : SIDEBAR_DEFAULT
  })

  // Discord-style error surface: set an error and it auto-dismisses after ~5s
  // (like Discord's transient notices). Passing null clears immediately. A new
  // error also drops any stale verification flag - callers re-assert it after
  // setError when the failure IS a verification gate.
  const setError = useCallback((message: string | null) => {
    clearTimeout(errorTimer.current)
    errorTimer.current = undefined
    setErrorState(message)
    setNeedsVerification(false)
    if (message) {
      errorTimer.current = setTimeout(() => {
        errorTimer.current = undefined
        setErrorState(null)
      }, 5000)
    }
  }, [])

  useEffect(() => () => clearTimeout(errorTimer.current), [])

  // The ONE writer of a guild's sidebar cache. Also seeds the unread state
  // from each channel's lastMessageId (only ever raising latestByChannel), and
  // when the open channel disappeared from the open guild (moved out,
  // deleted, lost VIEW) drops it so the guild's default channel opens.
  const setGuildChannels = useCallback((guildId: string, result: BridgeChannelsResult) => {
    const list = Array.isArray(result.channels) ? result.channels : []
    const previous = channelsByGuildRef.current[guildId]
    const entry: GuildChannelsEntry = { configured: result.configured, categories: Array.isArray(result.categories) ? result.categories : [], channels: list, stale: false, fetchedAt: Date.now() }
    channelsByGuildRef.current = { ...channelsByGuildRef.current, [guildId]: entry }
    setChannelsByGuild((current) => ({ ...current, [guildId]: entry }))
    const seeds = list.filter((c) => typeof c.lastMessageId === 'number' && c.lastMessageId > 0)
    if (seeds.length) {
      setLatestByChannel((current) => {
        let next = current
        for (const c of seeds) {
          if ((next[c.channelId] || 0) >= c.lastMessageId!) continue
          if (next === current) next = { ...current }
          next[c.channelId] = c.lastMessageId!
        }
        return next
      })
      if (firstVisitRef.current && !previous) {
        setLastRead((current) => {
          let next = current
          for (const c of seeds) {
            if ((next[c.channelId] || 0) >= c.lastMessageId!) continue
            if (next === current) next = { ...current }
            next[c.channelId] = c.lastMessageId!
          }
          if (next !== current) { try { localStorage.setItem('abulxt:chat-read', JSON.stringify(next)) } catch { /* ignore */ } }
          return next
        })
      }
    }
    const open = activeChannelRef.current
    if (activeGuildIdRef.current === guildId && open
      && previous?.channels.some((c) => c.channelId === open) && !list.some((c) => c.channelId === open)) {
      setActiveChannelId(null)
    }
  }, [])

  // Fetch one guild's sidebar into the cache. Per-guild sequence numbers drop
  // a response overtaken by a newer request for the same guild.
  const channelsSeqRef = useRef<Record<string, number>>({})
  const loadGuildChannels = useCallback((guildId: string) => {
    const seq = (channelsSeqRef.current[guildId] || 0) + 1
    channelsSeqRef.current[guildId] = seq
    bridgeChannels(guildId)
      .then((result) => { if (channelsSeqRef.current[guildId] === seq) setGuildChannels(guildId, result) })
      .catch((e) => {
        if (channelsSeqRef.current[guildId] !== seq) return
        // Keep any cached list (flagged stale); a guild that never loaded gets
        // an empty stale entry so it stops counting as "loading".
        setChannelsByGuild((current) => ({
          ...current,
          [guildId]: current[guildId] ? { ...current[guildId], stale: true } : { configured: true, categories: [], channels: [], stale: true, fetchedAt: 0 },
        }))
        if (activeGuildIdRef.current === guildId) setError(e instanceof Error ? e.message : 'Failed to load channels')
      })
  }, [setGuildChannels, setError])
  const markGuildsStale = useCallback((guildIds: string[]) => {
    if (!guildIds.length) return
    setChannelsByGuild((current) => {
      let next = current
      for (const id of guildIds) {
        if (!current[id] || current[id].stale) continue
        if (next === current) next = { ...current }
        next[id] = { ...current[id], stale: true }
      }
      return next
    })
  }, [])

  // Take a fresh guild list: load every guild's sidebar that isn't cached (or
  // is stale), and make sure a listed guild is open - the deep-link target,
  // else the last-used guild, else the first. An open guild that vanished
  // from the list (lost access, unbridged) falls back the same way.
  const applyGuildList = useCallback((list: BridgeGuild[]) => {
    guildsRef.current = list
    setGuilds(list)
    setGuildsSettled(true)
    const cached = channelsByGuildRef.current
    for (const g of list) if (!cached[g.id] || cached[g.id].stale) loadGuildChannels(g.id)
    const current = activeGuildIdRef.current
    if (current && list.some((g) => g.id === current)) return
    if (!list.length) {
      if (current) { setActiveGuildId(null); setActiveChannelId(null) }
      return
    }
    const link = readChatLink()
    const linkGuild = link?.guild ? String(link.guild) : null
    const last = readLastGuild()
    const pick = (linkGuild && list.some((g) => g.id === linkGuild) ? linkGuild : null)
      || (last && list.some((g) => g.id === last) ? last : null)
      || list[0].id
    if (current) selectGuildRef.current(pick)
    else setActiveGuildId(pick)
  }, [loadGuildChannels, setActiveGuildId])
  const reloadGuilds = useCallback(() => {
    bridgeGuilds().then(applyGuildList).catch(() => {})
  }, [applyGuildList])

  // Server Onboarding for the open guild - loaded ONCE here and shared by the
  // onboarding gate and Channels & Roles so the two can't disagree.
  const onboarding = useBridgeOnboarding(activeGuildId)
  const channelsRoles = useChannelsAndRoles(onboarding, loadGuildChannels)

  // Mention-autocomplete avatar backstop. The suggestion <img> is rendered by
  // Composer (no onError prop), so chat.tsx owns an equivalent fallback via a
  // CAPTURE-phase error listener: <img> error events don't bubble, but they do
  // capture, so a document-level capture listener sees a failed CDN avatar
  // inside .mentionAutocomplete and swaps it to the never-broken data-URI
  // initial avatar (the terminal step of the message-avatar onAvatarError
  // chain). The dataset flag guards against loops; a data-URI that somehow
  // still errors is left alone. The alt text is empty, so the display name is
  // recovered from the row's label span.
  useEffect(() => {
    const onImgError = (event: Event) => {
      const img = event.target as HTMLImageElement | null
      if (!img || img.tagName.toUpperCase() !== 'IMG' || !img.closest('.mentionAutocomplete')) return
      if (img.dataset.fallback === 'initial') return
      img.dataset.fallback = 'initial'
      const label = img.closest('.mentionAutocompleteItem')?.querySelector('.mentionAutocompleteLabel')?.textContent || ''
      img.src = initialAvatar(label)
    }
    document.addEventListener('error', onImgError, true)
    return () => document.removeEventListener('error', onImgError, true)
  }, [])

  // Mark the active channel read up to its newest message and persist it.
  // Reading a channel also clears its unread-mention count (Discord's badge
  // disappears once you've seen the channel).
  const markRead = useCallback((channelId: string, messageId: number) => {
    if (!channelId || messageId <= 0) return
    setLastRead((current) => {
      if ((current[channelId] || 0) >= messageId) return current
      const next = { ...current, [channelId]: messageId }
      try { localStorage.setItem('abulxt:chat-read', JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
    setUnreadMentions((current) => (current[channelId] ? { ...current, [channelId]: 0 } : current))
  }, [])

  // The caller's mention identity: linked Discord snowflake + every display
  // name a mention chip could carry for them (Discord display name/username,
  // site username, local chat nickname), plus the guild role ids they hold
  // (perms.guildRoleIds from the /perms payload - the full role set, not just
  // the top chat role) so role pings highlight for any held role. Used for
  // the mentioned-row highlight and the per-channel unread-mention badge.
  const mentionSelf = useMemo<MentionSelf>(() => {
    const names = new Set<string>()
    if (user) {
      names.add(user.username)
      names.add(effectiveChatDisplayName(user))
      if (user.discord?.username) names.add(user.discord.username)
      if (user.discord?.name) names.add(user.discord.name)
    }
    const nick = nickname.trim()
    if (nick) names.add(nick)
    // The open guild's roles (kept current from the open channel's perms).
    const roleIds = (activeGuildId ? guildRoleIds[activeGuildId] : undefined) ?? perms?.guildRoleIds ?? (perms?.roleId ? [perms.roleId] : [])
    return { discordId: user?.discord?.id || null, names: [...names], roleIds }
  }, [user, nickname, activeGuildId, guildRoleIds, perms?.guildRoleIds, perms?.roleId])
  mentionSelfRef.current = mentionSelf
  // The caller's mention identity / suppress flags in ANY guild (realtime
  // mention counting, desktop notifications, the inbox). Role ids come from
  // that guild's `perms?guild=` (empty until it lands: user mentions still
  // count).
  const mentionSelfFor = useCallback((guildId: string | null | undefined): MentionSelf => {
    const self = mentionSelfRef.current
    if (!guildId || guildId === activeGuildIdRef.current) return self
    return { ...self, roleIds: guildRoleIdsRef.current[guildId] ?? [] }
  }, [])
  const suppressFor = useCallback((guildId: string | null | undefined) => {
    const id = guildId || 'community'
    return { everyone: notifRef.current.suppressEveryone(id), roles: notifRef.current.suppressRoles(id) }
  }, [])

  // Keep appearance in sync if it's changed elsewhere (Settings page, another tab).
  useEffect(() => {
    const sync = (event: Event) => {
      const prefs = (event as CustomEvent<BrowserPreferences>).detail
      if (prefs?.chatAppearance) setAppearance(prefs.chatAppearance)
    }
    const onStorage = () => setAppearance(loadBrowserPreferences().chatAppearance)
    document.addEventListener('dusk:preferences', sync)
    window.addEventListener('storage', onStorage)
    return () => {
      document.removeEventListener('dusk:preferences', sync)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  // Load the signed-in user's approved uploaded avatar for the user panel and
  // self profile (the account page is the place that changes it).
  const avatarOwner = user?.username || ''
  useEffect(() => {
    if (!avatarOwner) return
    let live = true
    avatarMe().then((s) => { if (live) setChatAvatar(s.active?.url || '') }).catch(() => {})
    return () => { live = false }
  }, [avatarOwner])


  useEffect(() => {
    if (getAuthToken()) {
      me().then(setUser).catch(() => {})
    }
    // The rail's guild list (each guild's sidebar loads from applyGuildList).
    // The endpoint can momentarily return an empty list (bot still starting,
    // Discord hiccup), so retry a few times until a guild arrives - otherwise
    // the rail would stay on the "ab" fallback until a full page reload.
    let live = true
    let guildRetry: ReturnType<typeof setTimeout> | undefined
    let guildAttempts = 0
    const loadGuilds = () => {
      bridgeGuilds()
        .then((list) => {
          if (!live) return
          if (!list.length && ++guildAttempts < 6) {
            setGuildsSettled(true)
            guildRetry = setTimeout(loadGuilds, 3000)
            return
          }
          applyGuildList(list)
        })
        .catch((e) => {
          if (!live) return
          if (++guildAttempts < 6) guildRetry = setTimeout(loadGuilds, 3000)
          else {
            setGuildsSettled(true)
            setError(e instanceof Error ? e.message : 'Failed to load channels')
          }
        })
    }
    loadGuilds()
    return () => { live = false; clearTimeout(guildRetry) }
  }, [applyGuildList, setError])

  // The open guild's landing channel: once its sidebar is cached and nothing
  // is open, a pending deep link wins (resolved below in applyChatLink, which
  // may wait for every guild's list), else the guild's default channel.
  useEffect(() => {
    if (applyChatLinkRef.current() !== 'none') return
    if (!activeGuildId || activeChannelId) return
    const entry = channelsByGuild[activeGuildId]
    if (!entry) return
    const pick = defaultChannelFor(activeGuildId, entry.channels)
    if (pick) setActiveChannelId(pick)
  }, [activeGuildId, activeChannelId, channelsByGuild, guilds])
  // Remember the open channel per guild (the guild's landing channel next
  // time, across reloads).
  useEffect(() => {
    if (!activeGuildId || !activeChannelId) return
    if ((channelGuild.get(activeChannelId) ?? activeGuildId) !== activeGuildId) return
    const post = openPostRef.current
    rememberLastChannel(activeGuildId, post && post.id === activeChannelId ? post.forumId : activeChannelId)
  }, [activeGuildId, activeChannelId, channelGuild])

  // Leaving a post for any other channel closes it.
  useEffect(() => {
    if (openPostRef.current && openPostRef.current.id !== activeChannelId) setOpenPost(null)
  }, [activeChannelId, setOpenPost])
  // Replies seen in the open post (its forum card's "(N New)" count).
  useEffect(() => {
    if (openPost) markPostSeen(openPost.id, openPost.messageCount)
  }, [openPost])

  // Sign-in: the caller's roles in every guild (role-mention counting in
  // guilds that aren't open). Signed out, there's nothing to count.
  const signedInKey = user ? user.username : null
  const signedInKeyRef = useRef(signedInKey)
  signedInKeyRef.current = signedInKey
  const rolesInFlight = useRef(new Set<string>())
  useEffect(() => {
    if (!signedInKey) { setGuildRoleIds({}); return }
    for (const g of guilds) {
      if (guildRoleIdsRef.current[g.id] || rolesInFlight.current.has(g.id)) continue
      rolesInFlight.current.add(g.id)
      const key = signedInKey
      bridgeGuildPerms(g.id)
        .then((p) => { if (signedInKeyRef.current === key) setGuildRoleIds((current) => ({ ...current, [g.id]: p.guildRoleIds ?? (p.roleId ? [p.roleId] : []) })) })
        .catch(() => {})
        .finally(() => rolesInFlight.current.delete(g.id))
    }
  }, [signedInKey, guilds])

  // Server rail layout (folders) for the signed-in account: loaded once
  // signed in, cleared on sign-out, replaced live by account.guild_folders
  // (another device) and saved optimistically (reverted on error).
  const [guildFolders, setGuildFolders] = useState<GuildFolder[]>([])
  const guildFoldersRef = useRef(guildFolders)
  guildFoldersRef.current = guildFolders
  const guildFoldersSeq = useRef(0)
  useEffect(() => {
    guildFoldersSeq.current += 1
    if (!signedInKey) { setGuildFolders([]); return }
    const seq = guildFoldersSeq.current
    fetchGuildFolders()
      .then((folders) => { if (guildFoldersSeq.current === seq) setGuildFolders(folders) })
      .catch(() => {})
  }, [signedInKey])
  useEffect(() => subscribeRt((event) => {
    if (event.type !== 'account.guild_folders' || !userRef.current) return
    const folders = (event.payload as { guildFolders?: unknown }).guildFolders
    if (!Array.isArray(folders)) return
    guildFoldersSeq.current += 1
    setGuildFolders(folders as GuildFolder[])
  }), [])
  const saveLayout = useCallback((folders: GuildFolder[]) => {
    const previous = guildFoldersRef.current
    const seq = ++guildFoldersSeq.current
    setGuildFolders(folders)
    saveGuildFolders(folders)
      .then((saved) => { if (guildFoldersSeq.current === seq) setGuildFolders(saved) })
      .catch(() => { if (guildFoldersSeq.current === seq) setGuildFolders(previous) })
  }, [])

  // What kind of history source the open channel has: bridged (DB-backed) or
  // live (non-bridged, served read-only from Discord), or unknown while the
  // channel list hasn't listed it. A stable primitive, so the history effect
  // below reloads only when the open channel or its source changes, never on
  // unrelated channel-list updates (lock toggles, onboarding refreshes,
  // Channels & Roles edits) that replace the `channels` array.
  const activeChannelKind: 'bridged' | 'live' | 'forum' | 'unknown' = (() => {
    const row = activeChannelId ? channels.find((c) => c.channelId === activeChannelId) : undefined
    if (!row) return 'unknown'
    // A forum has no messages of its own: the forum view (Forum.tsx) loads
    // its posts instead of history.
    if (isForumType(row.type)) return 'forum'
    return row.bridged === false ? 'live' : 'bridged'
  })()

  useEffect(() => {
    if (!activeChannelId || activeChannelKind === 'forum') {
      // A guild switch with nothing to open yet (its sidebar is loading):
      // never leave the previous guild's channel on screen. A forum shows
      // its post list instead of a message history.
      historyChannelRef.current = null
      setMessages([])
      setReplyTo(null)
      setUnreadDivider(null)
      setLoading(false)
      return
    }
    // Switching channels always clears the previous channel's messages + reply
    // and resets the scroll/new-message state, so a non-bridged channel never
    // shows the previous channel's history behind its read-only notice.
    setLoading(true)
    setMessages([])
    setHasMore(true)
    setHasMoreAfter(false)
    setJumpLoading(false)
    loadingMoreRef.current = false
    detachedArrivalsRef.current = []
    scrollAnchorRef.current = null
    suppressLoadRef.current = null
    // Switching channels drops a pending reply (Discord parity - a reply is
    // scoped to the channel it was armed in).
    setReplyTo(null)
    // Reset the scrolled-up new-message counter + the NEW divider; the divider
    // re-derives below from the freshly loaded history.
    setNewSinceScrollUp({ count: 0, since: null })
    setUnreadDivider(null)
    historyChannelRef.current = null
    stickToBottom.current = true
    // Non-bridged channels the caller can view are served live from Discord
    // by the same /history route (read-only); their pages carry hasMore +
    // nextBefore for paging past filtered system messages.
    liveCursorRef.current = null
    const channelId = activeChannelId
    // A pending jump into this channel loads `around` its target (Discord's
    // jumpToMessage: one fetch, limit 30) instead of the newest page; the
    // jump effect below then scrolls to + flashes it. Otherwise Discord's
    // viewport-sized initial fetch.
    const jumpTarget = pendingJumpRef.current?.channelId === channelId ? pendingJumpRef.current.messageId : null
    // Aborted when the channel changes: cancels the stale page, including a
    // quiet rate-limit wait in the request queue (lib/rate-limit-queue.ts).
    const historyAbort = new AbortController()
    const latest = () => bridgeHistoryWindow(channelId, {}, initialFetchLimit(appearanceRef.current !== 'cozy'), historyAbort.signal)
    const request = jumpTarget
      ? bridgeHistoryWindow(channelId, { around: jumpTarget }, JUMP_FETCH_LIMIT, historyAbort.signal)
        // An unknown/deleted target leaves an empty around page: fall back to
        // the newest page (the jump effect then gives up quietly).
        .then((page) => (page.messages.length ? page : latest()))
      : latest()
    request
      .then((page) => {
        if (activeChannelRef.current !== channelId) return
        const history = page.messages
        historyChannelRef.current = activeChannelId
        if (jumpTarget) jumpAroundRef.current = { key: `${channelId}:${jumpTarget}`, done: true }
        const detached = Boolean(jumpTarget && page.hasMoreAfter)
        stickToBottom.current = !detached
        setMessages(history)
        if (page.live) liveCursorRef.current = { channelId: activeChannelId, nextBefore: page.nextBefore, nextAfter: page.nextAfter }
        setHasMore(page.hasMoreBefore ?? history.length >= MESSAGES_PER_FETCH)
        setHasMoreAfter(detached)
        if (detached) return // read state + NEW divider wait for the present
        const newest = history.length ? Math.max(...history.map((m) => m.id)) : 0
        // Seed the channel's mention badge from the loaded history: mentions
        // in messages newer than the last-read marker (messages just loaded
        // into the open channel are being read, so they don't count).
        const readMark = activeChannelRef.current === activeChannelId ? newest : (lastReadRef.current[activeChannelId] || 0)
        const mentionCount = history.filter((m) => !m.deletedAt && m.id > readMark && messageMentionsUser(m, mentionSelfRef.current, mentionSuppressRef.current)).length
        setUnreadMentions((current) => ({ ...current, [activeChannelId]: mentionCount }))
        if (newest > 0) {
          // Pin the unread "NEW" divider: the read marker BEFORE this load's
          // markRead below advances it - the divider sits above the first
          // loaded message newer than what the user had already read. Discord
          // only shows it when there IS something unread, so a channel read up
          // to its newest message gets no divider.
          const persistedRead = lastReadRef.current[activeChannelId] || 0
          if (newest > persistedRead) {
            const firstUnread = history.find((m) => !m.deletedAt && m.id > persistedRead)
            if (firstUnread) setUnreadDivider({ channelId: activeChannelId, beforeId: firstUnread.id })
          }
          setViewDeniedChannelId((current) => (current === activeChannelId ? null : current))
          markRead(activeChannelId, newest)
          setLatestByChannel((current) => ({ ...current, [activeChannelId]: Math.max(current[activeChannelId] || 0, newest) }))
        }
      })
      .catch((e) => {
        if (historyAbort.signal.aborted || activeChannelRef.current !== channelId) return
        // No view access: the channel body explains it (no toast).
        if (isPermissionDenial(e)) setViewDeniedChannelId(channelId)
        else setError(e instanceof Error ? e.message : 'Failed to load history')
      })
      .finally(() => { if (!historyAbort.signal.aborted && activeChannelRef.current === channelId) setLoading(false) })
    // mentionSelf is read through its ref: it changes identity whenever /perms
    // lands (per channel switch), and depending on it re-ran this effect,
    // wiping and refetching the history a second time on every channel open.
    // Likewise `channels` is NOT a dependency (any list update would wipe and
    // refetch the open channel); only the channel's source kind is.
    return () => historyAbort.abort()
  }, [activeChannelId, activeChannelKind, markRead, setHasMoreAfter])

  // Live refresh fallback for an open unbridged channel. Normally its new,
  // edited and deleted messages arrive over the realtime bus (the bot
  // broadcasts them; rt-api delivers each only to sockets that can VIEW the
  // channel). While the socket is down, re-read the newest page every 15s
  // (the server caches each page 15s) and splice it over the tail: new
  // messages append, edits and deletes inside the window apply.
  const activeIsLive = activeChannelKind === 'live'
  useEffect(() => {
    if (!activeChannelId || !activeIsLive) return
    const channelId = activeChannelId
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (rtConnected()) return
      if (historyChannelRef.current !== channelId) return
      // Detached from the present: the newest page doesn't belong under an
      // older window (Jump To Present refetches it).
      if (hasMoreAfterRef.current) return
      bridgeHistoryPage(channelId)
        .then((page) => {
          if (!page.live || activeChannelRef.current !== channelId || historyChannelRef.current !== channelId) return
          const latest = page.messages
          if (!latest.length) return
          const floor = latest[0].id
          setMessages((current) => [...current.filter((m) => m.id < floor), ...latest])
          const newest = latest[latest.length - 1].id
          markRead(channelId, newest)
          setLatestByChannel((current) => ({ ...current, [channelId]: Math.max(current[channelId] || 0, newest) }))
        })
        .catch(() => { /* transient; next tick retries */ })
    }, 15_000)
    return () => clearInterval(timer)
  }, [activeChannelId, activeIsLive, markRead])

  // Load the caller's perms for `channelId` and apply them only while it's
  // still the open channel; the held guild roles also feed that guild's
  // role-mention counting. `clearOnError`: the initial load (a failed
  // refresh keeps the last good perms).
  const refreshPerms = useCallback((channelId: string, clearOnError = false) => {
    bridgePerms(channelId)
      .then((p) => {
        if (activeChannelRef.current !== channelId) return
        setPerms(p)
        const guildId = channelGuildRef.current.get(channelId)
        if (guildId && (p.guildRoleIds || p.roleId)) setGuildRoleIds((current) => ({ ...current, [guildId]: p.guildRoleIds ?? (p.roleId ? [p.roleId] : []) }))
      })
      .catch(() => { if (clearOnError && activeChannelRef.current === channelId) setPerms(null) })
  }, [])

  // Fetch the caller's chat permissions for the active channel (tier + active
  // timeout). Re-fetch when the channel or the signed-in user changes.
  useEffect(() => {
    // Non-bridged channels are read-only: perms/expressions are send-related
    // state, so skip those fetches (their routes aren't meaningful without a
    // bridge) and clear the stale per-channel values.
    const bridged = activeChannelKind !== 'live'
    if (!activeChannelId || !user || !bridged) {
      setPerms(null)
      setKlipyKey(null)
      setCanSendEmbeds(false)
      return
    }
    // Responses for a channel that's no longer open (fast channel / guild
    // switches) are dropped.
    const channelId = activeChannelId
    refreshPerms(channelId, true)
    // Expressions config (KLIPY key, embed gating) for the GIF/sticker tabs.
    bridgeExpressions(channelId)
      .then((expr) => {
        if (activeChannelRef.current !== channelId) return
        setKlipyKey(expr.klipyKey)
        setCanSendEmbeds(expr.canSendEmbeds)
      })
      .catch(() => {
        if (activeChannelRef.current !== channelId) return
        setKlipyKey(null)
        setCanSendEmbeds(false)
      })
  }, [activeChannelId, activeChannelKind, user, refreshPerms])

  // Mirror lastRead into a ref so the history effect can read the persisted
  // marker without depending on it (depending on lastRead would re-run the
  // fetch every time markRead advances the marker).
  const lastReadRef = useRef(lastRead)
  lastReadRef.current = lastRead

  // Tick the active timeout countdown every second, clearing when it expires.
  useEffect(() => {
    if (!perms?.timeout) {
      setTimeoutRemaining(null)
      return
    }
    const update = () => {
      const remaining = Math.max(0, Math.floor((new Date(perms.timeout!.timeoutUntil).getTime() - Date.now()) / 1000))
      setTimeoutRemaining(remaining)
    }
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [perms?.timeout])

  const applyEvent = useCallback((event: RtEvent) => {
    const payload = event.payload as Record<string, unknown>
    if (event.type === 'bridge.message') {
      const message = payload.message as BridgeMessage | undefined
      if (!message) return
      // The message's own guild decides mention roles, suppress flags and
      // which server/category mutes apply.
      const guildId = String(payload.guildId || channelGuildRef.current.get(message.channelId) || '')
      const mentioned = !message.deletedAt && messageMentionsUser(message, mentionSelfFor(guildId), suppressFor(guildId))
      // Desktop notifications (Settings > Notifications); our own messages never notify.
      if (!message.deletedAt && !mentionSelfRef.current.names.includes(message.authorName)) {
        notifyDesktop(message, mentioned, { guildId: guildId || 'community', parentId: allChannelsRef.current.get(message.channelId)?.parentId ?? null })
      }
      // Track the newest message per channel (for unread badges on inactive channels).
      setLatestByChannel((current) => {
        if ((current[message.channelId] || 0) >= message.id) return current
        return { ...current, [message.channelId]: message.id }
      })
      // A message in a forum post (channelId = post id) also lights the
      // forum's sidebar row, unless that forum (or one of its posts) is open.
      const forumId = payload.forumId ? String(payload.forumId) : ''
      if (forumId) {
        setLatestByChannel((current) => ((current[forumId] || 0) >= message.id ? current : { ...current, [forumId]: message.id }))
        if (activeChannelRef.current === forumId || openPostRef.current?.forumId === forumId) markRead(forumId, message.id)
      }
      if (message.channelId === activeChannelRef.current) {
        markRead(message.channelId, message.id)
      } else {
        // Inactive channel (any guild): an incoming mention bumps that
        // channel's badge (and its guild's rail badge).
        if (mentioned) {
          setUnreadMentions((current) => ({ ...current, [message.channelId]: (current[message.channelId] || 0) + 1 }))
        }
        return // not the open channel - badge handles it
      }
      // Discord's ChannelMessages.receiveMessage: a window detached from the
      // present (hasMoreAfter) never takes the arrival - the user is reading
      // older history and nothing scrolls; Jump To Present brings it in. An
      // attached window scrolled up with a full window (> MAX_LOADED_MESSAGES)
      // detaches instead of growing. Pinned to the bottom, the window is
      // trimmed to the newest TRUNCATED_MESSAGE_VIEW_SIZE (truncateTop).
      const windowNow = messagesRef.current
      const reconcilesOwn = Boolean(message.clientId && windowNow.some((m) => m.clientId === message.clientId && m.direction === 'web'))
      const alreadyLoaded = windowNow.some((m) => m.id === message.id)
      const detach = !alreadyLoaded && !reconcilesOwn && (
        hasMoreAfterRef.current || (!stickToBottom.current && windowNow.length >= MAX_LOADED_MESSAGES)
      )
      if (detach) {
        if (!detachedArrivalsRef.current.some((m) => m.id === message.id)) {
          detachedArrivalsRef.current = [...detachedArrivalsRef.current, message].slice(-MAX_LOADED_MESSAGES)
        }
        if (!hasMoreAfterRef.current) setHasMoreAfter(true)
      } else {
        const trimTop = stickToBottom.current && !alreadyLoaded && !reconcilesOwn && windowNow.length + 1 > TRUNCATED_MESSAGE_VIEW_SIZE
        if (trimTop) {
          setHasMore(true)
          if (liveCursorRef.current) liveCursorRef.current = { ...liveCursorRef.current, nextBefore: null }
        }
        setMessages((current) => {
          // Dedup by server id: the same persisted row must never render twice
          // (the /send response and the realtime echo both carry it).
          if (current.some((m) => m.id === message.id)) return current
          // Reconcile a web message by clientId: replaces the optimistic row, or
          // the already-reconciled real row when the echo arrives after the /send
          // response swapped it in. Either way the message lands EXACTLY once -
          // an echo whose clientId is already represented is never appended.
          if (message.clientId) {
            const existing = current.findIndex((m) => m.clientId === message.clientId && m.direction === 'web')
            if (existing >= 0) {
              const next = [...current]
              next[existing] = message
              return next
            }
          }
          const next = [...current, message]
          return trimTop && next.length > TRUNCATED_MESSAGE_VIEW_SIZE ? next.slice(-TRUNCATED_MESSAGE_VIEW_SIZE) : next
        })
      }
      if (stickToBottom.current && !detach) {
        requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight }))
      } else if (!message.deletedAt && !reconcilesOwn) {
        // Scrolled up / detached: the arrival is genuinely unread. Bump the
        // top newMessagesBar's "N new messages since <time>" counter and pin the NEW divider if it isn't pinned yet (e.g. the channel
        // was fully read on load and this is the first unread arrival).
        setNewSinceScrollUp((current) => ({
          count: current.count + 1,
          since: current.since || message.createdAt,
        }))
        setUnreadDivider((current) => (
          current && current.channelId === message.channelId
            ? current
            : { channelId: message.channelId, beforeId: message.id }
        ))
      }
      setTyping((current) => current.filter((t) => t.authorKey !== message.authorKey))
      return
    }
    if (event.type === 'bridge.message.edited') {
      // Update the content/embeds in place. Two producers emit this event:
      // (a) a genuine user edit (content changed, edited_at stamped), and
      // (b) a server-side embed resolution - the link unfurl (marked
      // embedOnly:true by the bridge) and Discord's own messageUpdate on
      // webhook deliveries (reply-context/embed resolution), which the bot
      // mirrors via editByDiscordMessageId. The (b) path must NOT surface as
      // "(edited)": a fresh send with a link (or any reply) would instantly
      // look edited. A content change is always a real edit; otherwise the
      // isUserEdit() age gate keeps bot-side stamps from showing the tag.
      const message = payload.message as BridgeMessage | undefined
      if (!message) return
      const embedOnly = payload.embedOnly === true
      setMessages((current) => current.map((m) => {
        if (m.id !== message.id) return m
        if (!embedOnly && (m.content !== message.content || isUserEdit(message))) return message
        // Embed-only update: take the new embeds/attachments but keep the
        // displayed content and whatever edited marker was there - a fresh
        // send with a link (or a reply) must never surface as "(edited)".
        return { ...m, embeds: message.embeds, attachments: message.attachments, reactions: message.reactions, components: message.components, flags: message.flags }
      }))
      return
    }
    if (event.type === 'bridge.channel.resync') {
      // The bot reconciled this channel with Discord and inserted messages
      // it had missed (sent while it was offline). Refetch the newest page
      // when it's the open channel and we're not detached from the present.
      const channelId = String(payload.channelId || '')
      if (!channelId || channelId !== activeChannelRef.current || historyChannelRef.current !== channelId) return
      if (hasMoreAfterRef.current) return
      bridgeHistoryWindow(channelId, {}, MESSAGES_PER_FETCH)
        .then((page) => {
          if (!page.live || activeChannelRef.current !== channelId || page.messages.length === 0) return
          const latest = page.messages
          const floor = latest[0].id
          setMessages((current) => [...current.filter((m) => m.id < floor), ...latest])
        })
        .catch(() => { /* transient; the next event or reload recovers */ })
      return
    }
    if (event.type === 'bridge.message.deleted') {
      // Original delMsg: remove the node from view entirely.
      const id = Number(payload.id)
      detachedArrivalsRef.current = detachedArrivalsRef.current.filter((m) => m.id !== id)
      setMessages((current) => current.filter((m) => m.id !== id))
      return
    }
    if (event.type === 'bridge.reaction') {
      // A reaction changed on a message (from any webhook/Discord user). Update
      // the message's reactions in place.
      const messageId = Number(payload.messageId)
      const reactions = payload.reactions as BridgeReaction[] | undefined
      if (!messageId || !reactions) return
      // Live (unbridged) rows: the bot sends Discord's counts only, so keep the
      // reactor keys this client already holds for each emoji.
      const live = payload.live === true
      setMessages((current) => current.map((m) => {
        if (m.id !== messageId) return m
        if (!live) return { ...m, reactions }
        const held = new Map((m.reactions || []).map((r) => [r.emoji, r.reactorKeys]))
        return { ...m, reactions: reactions.map((r) => ({ ...r, reactorKeys: held.get(r.emoji) || [] })) }
      }))
      return
    }
    if (event.type === 'bridge.typing') {
      if (payload.channelId !== activeChannelRef.current) return
      const authorKey = String(payload.authorKey || '')
      const authorName = String(payload.authorName || '')
      if (!authorKey) return
      // The server broadcasts the typing list to everyone (including the typer);
      // the caller is filtered out at render time in typingNames.
      setTyping((current) => {
        const next = current.filter((t) => t.authorKey !== authorKey)
        next.push({ authorKey, authorName, expires: Date.now() + 9_000 })
        return next
      })
      return
    }
    if (event.type === 'bridge.timeout' || event.type === 'bridge.untimeout' || event.type === 'bridge.ban' || event.type === 'bridge.unban') {
      // Moderation of a WEBHOOK identity (web-only, linked, or Discord). The
      // server only delivers these to the target and to moderators. Drop the
      // cached moderation view of every key the target appears under, and
      // refresh our own perms when it targets us (any of our webhook keys -
      // a web-only account matches on its 'user:<id>' key). Bans are global;
      // timeouts are per-channel.
      const targetKeys = Array.isArray(payload.targetKeys) ? payload.targetKeys.map(String) : []
      const legacyTarget = String(payload.target || '')
      for (const key of [...targetKeys, legacyTarget]) {
        for (const cacheKey of modTargetCache.current.keys()) if (cacheKey.endsWith(`|${key}`)) modTargetCache.current.delete(cacheKey)
      }
      const selfKeys = permsRef.current?.webhookKeys || (permsRef.current?.ownerKey ? [permsRef.current.ownerKey] : [])
      const selfDiscord = userRef.current?.discord?.id || null
      const targetsMe = targetKeys.some((k) => selfKeys.includes(k))
        || selfKeys.includes(legacyTarget)
        || (selfDiscord !== null && legacyTarget === selfDiscord)
      const global = event.type === 'bridge.ban' || event.type === 'bridge.unban'
      if (!targetsMe || (!global && payload.channelId !== activeChannelRef.current)) return
      const channelId = activeChannelRef.current
      if (channelId && channelsRef.current.find((c) => c.channelId === channelId)?.bridged !== false) {
        refreshPerms(channelId)
      }
      return
    }
    if (event.type === 'bridge.perms.changed') {
      // A role was promoted/demoted or a chat-role definition changed. If it's
      // a global resync (no discordId) or it targets the current user, re-fetch
      // our permissions so the composer/badges update live.
      const discordId = payload.discordId ? String(payload.discordId) : null
      const selfId = userRef.current?.discord?.id
      // Targeted events also carry `keys` (every webhook key of the target,
      // e.g. a web-only account's 'user:<id>' after a webhook overwrite).
      const keys = Array.isArray(payload.keys) ? payload.keys.map(String) : []
      const selfKeys = permsRef.current?.webhookKeys || []
      const global = !discordId && !keys.length && typeof payload.userId !== 'number'
      for (const key of keys) {
        for (const cacheKey of modTargetCache.current.keys()) if (cacheKey.endsWith(`|${key}`)) modTargetCache.current.delete(cacheKey)
      }
      // `guildId` scopes the change to one guild (null/absent = every guild).
      const scopeGuild = payload.guildId ? String(payload.guildId) : null
      if (global || (selfId && discordId === selfId) || keys.some((k) => selfKeys.includes(k))) {
        // Account state too (email verification, perks) - the send guards read it.
        if (userRef.current && !global) me().then(setUser).catch(() => {})
        const activeGuild = activeGuildIdRef.current
        const channelId = activeChannelRef.current
        if ((!scopeGuild || scopeGuild === activeGuild)
          && channelId && userRef.current && channelsRef.current.find((c) => c.channelId === channelId)?.bridged !== false) {
          refreshPerms(channelId)
        }
        // A targeted change (perks, onboarding roles, member roles) can change
        // which channels this identity's effective roles may VIEW: the open
        // guild's sidebar refetches now, every other affected guild is marked
        // stale (refetched when opened) and re-reads its roles for mention
        // counting.
        if (!global) {
          if (activeGuild && (!scopeGuild || scopeGuild === activeGuild)) loadGuildChannels(activeGuild)
          const others = (scopeGuild ? [scopeGuild] : guildsRef.current.map((g) => g.id)).filter((id) => id !== activeGuild)
          markGuildsStale(others)
          if (userRef.current) {
            for (const id of others) {
              bridgeGuildPerms(id)
                .then((p) => setGuildRoleIds((current) => ({ ...current, [id]: p.guildRoleIds ?? (p.roleId ? [p.roleId] : []) })))
                .catch(() => {})
            }
          }
        }
      }
      return
    }
    if (event.type === 'bridge.pins') {
      pinsRefreshRef.current?.(String(payload.channelId || ''))
      return
    }
    // Forum posts (contract.md Realtime). The forum view applies them to its
    // list; here only the open post follows along: renamed / tagged / locked
    // / closed (perms re-read: canReply), deleted (back to the forum), or
    // delivered (pending 'post:<n>' re-keyed to the thread id).
    if (event.type === 'bridge.post.updated' || event.type === 'bridge.post.delivered') {
      const post = payload.post as ForumPost | undefined
      const open = openPostRef.current
      if (!post || !open) return
      const pendingId = event.type === 'bridge.post.delivered' ? String(payload.pendingId || '') : ''
      if (open.id === post.id) {
        const lockChanged = open.locked !== post.locked || open.archived !== post.archived
        setOpenPost(post)
        if (lockChanged && userRef.current) refreshPerms(post.id)
      } else if (pendingId && open.id === pendingId) {
        setOpenPost(post)
        setActiveChannelId(post.id)
      }
      return
    }
    if (event.type === 'bridge.post.deleted') {
      const open = openPostRef.current
      if (open && open.id === String(payload.postId || '')) {
        setOpenPost(null)
        setActiveChannelId(open.forumId)
      }
      return
    }
    if (event.type === 'bridge.lockdown') {
      // A mod locked/unlocked a channel. Update the channel list + our perms.
      const channelId = String(payload.channelId || '')
      const locked = payload.locked !== false
      // Whichever guild's cache holds the channel (open or not).
      const guildId = String(payload.guildId || '') || channelGuildRef.current.get(channelId)
      if (guildId) {
        setChannelsByGuild((current) => {
          const entry = current[guildId]
          if (!entry || !entry.channels.some((c) => c.channelId === channelId)) return current
          return { ...current, [guildId]: { ...entry, channels: entry.channels.map((c) => (c.channelId === channelId ? { ...c, locked } : c)) } }
        })
      }
      if (channelId === activeChannelRef.current && userRef.current
        && channelsRef.current.find((c) => c.channelId === channelId)?.bridged !== false) {
        refreshPerms(channelId)
      }
      return
    }
    if (event.type === 'bridge.channels.changed') {
      // A guild's bridged channel set or layout changed (create / move /
      // rename / delete / category added): re-read the guild list (a guild
      // can appear or disappear) and that guild's sidebar.
      const guildId = payload.guildId ? String(payload.guildId) : null
      reloadGuilds()
      if (guildId) loadGuildChannels(guildId)
      return
    }
    if (event.type === BRIDGE_ONBOARDING_EVENT) {
      // This identity's onboarding / opt-ins changed in one guild (null =
      // every guild): its visible channels may differ. The open guild
      // refetches now, others are marked stale. (The onboarding payload
      // itself reloads in useBridgeOnboarding.)
      const guildId = payload.guildId ? String(payload.guildId) : null
      const activeGuild = activeGuildIdRef.current
      if (activeGuild && (!guildId || guildId === activeGuild)) loadGuildChannels(activeGuild)
      markGuildsStale((guildId ? [guildId] : guildsRef.current.map((g) => g.id)).filter((id) => id !== activeGuild))
      return
    }
  }, [markRead, setHasMoreAfter, mentionSelfFor, suppressFor, refreshPerms, loadGuildChannels, markGuildsStale, reloadGuilds, setOpenPost])

  useEffect(() => subscribeBridge(applyEvent), [applyEvent])
  // Account changes made on another device (profile, avatar, email verification,
  // plan) arrive on the user's own socket: re-read the account and the perms that
  // depend on it, so the composer and profile update without a reload.
  useEffect(() => subscribeRt((event) => {
    if (event.type !== 'account.updated' && event.type !== 'account.plan_changed' && event.type !== 'avatar.updated') return
    if (!userRef.current) return
    // me() is cached for 30s; drop the cache so the event reads fresh values.
    invalidateMe()
    me().then(setUser).catch(() => {})
    const channelId = activeChannelRef.current
    if (channelId && channelsRef.current.find((c) => c.channelId === channelId)?.bridged !== false) {
      refreshPerms(channelId)
    }
  }), [refreshPerms])

  // Open the Discord-style profile popout for a message author (avatar,
  // username, reply-preview name, author context menu). Anchored to the
  // clicked element; clicking the same element again toggles it closed
  // (Discord). Discord-side authors carry their snowflake in authorKey
  // ('discord:<id>') so the popout can load their member record.
  const openProfile = useCallback((message: BridgeMessage, event: React.MouseEvent | { currentTarget: Element | null; rect: DOMRect }) => {
    if ('stopPropagation' in event) event.stopPropagation()
    const el = event.currentTarget as Element | null
    const rect = 'rect' in event ? event.rect : (el as Element).getBoundingClientRect()
    const discordId = message.direction === 'discord' && message.authorKey?.startsWith('discord:') ? message.authorKey.slice(8) : null
    setElemMenu(null)
    setProfile((cur) => (cur && el && cur.anchorEl === el ? null : {
      kind: 'user',
      discordId,
      authorKey: message.authorKey || null,
      authorName: message.authorName,
      authorAvatar: message.authorAvatar,
      fallbackAvatar: defaultAvatar(message.authorName),
      authorColor: message.authorColor,
      authorRole: message.authorRole,
      direction: message.direction,
      anchorEl: el,
      anchorRect: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
      placement: 'right',
    }))
  }, [])

  const closeProfile = useCallback(() => setProfile(null), [])

  // User panel → your account popout (opens above the panel, left-aligned).
  // Site-side and guild-independent: no channel id is needed (the popout loads
  // `self-profile`), so it opens with no channel selected. Clicking the panel
  // again toggles it closed.
  const openAccountPopout = useCallback((event: React.MouseEvent | React.KeyboardEvent) => {
    event.stopPropagation()
    if (!user) return
    const el = event.currentTarget as Element
    const rect = el.getBoundingClientRect()
    setElemMenu(null)
    setStatusOpen(false)
    setProfile((cur) => (cur && cur.anchorEl === el ? null : {
      kind: 'self',
      discordId: null,
      authorName: effectiveChatDisplayName(user),
      username: user.username,
      authorAvatar: chatAvatar || (user.discord?.avatar
        ? `https://cdn.discordapp.com/avatars/${user.discord.id}/${user.discord.avatar}.webp?size=128`
        : defaultAvatar(user.username)),
      authorColor: null,
      authorRole: null,
      direction: 'web',
      anchorEl: el,
      anchorRect: { top: rect.top, left: rect.left - 8, right: rect.right, bottom: rect.bottom },
      placement: 'top',
    }))
  }, [user, nickname, chatAvatar])

  // Open the profile popout from a clicked user-mention chip. The mention
  // payload carries {type, id, username}; the id is the Discord snowflake, so
  // the popout loads the real member record (avatar, roles, dates) for it.
  const openMentionProfile = useCallback((mention: { type: string; id: string; username?: string; name?: string }, event: React.MouseEvent) => {
    event.stopPropagation()
    // Content clicks are delegated from the message body, so the chip is the
    // event target's .mention ancestor, not currentTarget.
    const el = ((event.target as Element | null)?.closest('.mention') || event.currentTarget) as Element
    const rect = el.getBoundingClientRect()
    setElemMenu(null)
    setProfile((cur) => (cur && cur.anchorEl === el ? null : {
      kind: 'user',
      discordId: /^\d{15,22}$/.test(mention.id) ? mention.id : null,
      authorKey: /^\d{15,22}$/.test(mention.id) ? `discord:${mention.id}` : null,
      authorName: mention.username || mention.name || mention.id,
      authorAvatar: null,
      fallbackAvatar: defaultAvatar(mention.username || mention.name || mention.id),
      authorColor: null,
      authorRole: null,
      direction: 'discord',
      anchorEl: el,
      anchorRect: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
      placement: 'right',
    }))
  }, [])

  // Begin a reply to a message: arms the composer's "Replying to <name>" strip
  // and focuses the input, exactly like Discord's Reply action. Shared by the
  // hover-toolbar Reply button and the context menu's Reply item - the context
  // menu calls this same handler (passed down as onReply).
  const startReply = useCallback((message: BridgeMessage) => {
    setReplyTo({
      id: message.id,
      authorName: message.authorName,
      content: message.content,
      // Discord hides the @ mention switch when replying to yourself.
      self: Boolean(perms?.ownerKey) && message.authorKey === perms?.ownerKey,
    })
    setReplyMention(true)
    inputRef.current?.focus()
  }, [perms])

  // Clear the pending reply (the strip's × button, or after a successful send).
  const cancelReply = useCallback(() => setReplyTo(null), [])

  // React gate. While perms are still loading (null) stay permissive -
  // Discord shows the actions and only hides them once it knows they're
  // denied. Guests (signed out) keep the buttons so clicking opens the
  // sign-in prompt.
  //
  // Prefer the server's dedicated (timeout-reduced) canReact flag; fall back
  // to canSend on older servers. A non-bridged (read-only) channel never
  // allows reacting - its perms are cleared to null there, so check the
  // channel directly rather than letting the null-perms default open it up.
  const activeIsReadOnly = channels.find((c) => c.channelId === activeChannelId)?.bridged === false
  const canReact = activeIsReadOnly ? false : perms === null ? true : (perms.canReact ?? perms.canSend)
  // Discord-side author cosmetics (gradient/holographic role names, avatar
  // decorations, server tags, display-name fonts, new-member badge) for the
  // loaded messages - batched + cached per author (author-style.tsx).
  const authorStyleOf = useAuthorStyles(activeChannelId, messages)
  // The signed-in user's linked Discord account cosmetics (user panel).
  const selfStyle = useUserStyle(activeChannelId, user?.discord?.id)

  // Toggle a reaction on a message. Requires sign-in; the server records it
  // under the caller's webhook identity and the bot mirrors it to Discord once
  // per emoji (removing only when the last real reactor unreacts). Discord
  // never offers an action you can't take - when perms say the caller can't
  // react, don't fire the request at all (the buttons are also hidden).
  const toggleReaction = useCallback(async (message: BridgeMessage, entry: EmojiEntry) => {
    if (!user) {
      setShowAuth(true)
      return
    }
    // No ADD_REACTIONS: Discord hides the react controls, so there is nothing to
    // report - just don't send the request.
    if (!canReact) return
    // Discord applies the toggle optimistically and reconciles: flip the
    // pill now; the request rides the rate-limit queue (a 429 just waits, in
    // click order), and the server's reactions replace the optimistic ones
    // once this message's last in-flight toggle settles. A real failure (or a
    // rate limit we finally gave up on) reverts silently.
    const messageId = message.id
    const emoji = entry[1]
    const selfKey = perms?.ownerKey || 'me'
    const flip = () => setMessages((current) => current.map((m) => (m.id === messageId ? { ...m, reactions: toggleOwnReaction(m.reactions, emoji, selfKey) } : m)))
    const pending = pendingReactsRef.current
    pending.set(messageId, (pending.get(messageId) || 0) + 1)
    const settle = () => {
      const left = (pending.get(messageId) || 1) - 1
      if (left > 0) pending.set(messageId, left)
      else pending.delete(messageId)
      return left === 0
    }
    flip()
    try {
      const result = await bridgeReact(messageId, emoji)
      if (settle()) setMessages((current) => current.map((m) => (m.id === messageId ? { ...m, reactions: result.reactions } : m)))
      // Emoji frecency (Discord counts reactions you ADD): the toggle added
      // when the caller is now among the emoji's reactors.
      const ownerKey = perms?.ownerKey
      const added = !ownerKey || (result.reactions || []).some((r) => r.emoji === emoji && Array.isArray(r.reactorKeys) && r.reactorKeys.includes(ownerKey))
      if (added) recordEmojiUse(entry[0])
    } catch {
      settle()
      flip()
    }
  }, [user, canReact, perms])

  // Whether the caller may edit this message: signed-in, web-originated, and
  // authored by them (the hover-toolbar Edit button is gated on this, matching
  // Discord's "you can only edit your own messages"). The server's /edit runs
  // the full send gate (ban, VIEW, timeout, SEND + overwrites, lock), so the
  // action is only offered while perms.canSend - which is that same gate.
  const canEditMessage = useCallback((message: BridgeMessage): boolean => {
    if (!user || !perms) return false
    if (message.direction !== 'web' || message.deletedAt || message.id < 0) return false
    // Forwards are immutable; a muted / banned / locked-out webhook can't edit.
    if (message.forwarded || perms.timeout || perms.banned || !perms.canSend) return false
    return Boolean(perms.ownerKey) && message.authorKey === perms.ownerKey
  }, [user, perms])

  // Enter inline-edit mode for a message (Discord replaces the message body
  // with a textarea pre-filled with the raw content).
  const startEdit = useCallback((message: BridgeMessage) => {
    if (!user) {
      setShowAuth(true)
      return
    }
    // Edit is only offered when canEditMessage (Discord hides the button otherwise).
    if (!canEditMessage(message)) return
    setEditingMsgId(message.id)
  }, [user, canEditMessage])

  const cancelEdit = useCallback(() => {
    setEditingMsgId(null)
    setEditSaving(false)
  }, [])
  // Leaving edit mode closes a picker that was opened from the editor.
  useEffect(() => {
    if (editingMsgId !== null || !editPickerAnchor) return
    setEditPickerAnchor(null)
    setEmojiMenuOpen(false)
  }, [editingMsgId, editPickerAnchor])

  // Inline editor plumbing: '<#id>' chip labels, the @/#/@& suggestion fetch
  // (the composer's /members call), and its emoji button - Discord opens the
  // expression picker anchored to that button (clicking it again closes it).
  const editorChannelName = useCallback((id: string) => allChannelsRef.current.get(id)?.name, [])
  const editorFetchSuggestions = useCallback(
    (q: string) => (activeChannelId ? bridgeMembers(activeChannelId, q, 8) : Promise.resolve({ members: [], roles: [], channels: [] })),
    [activeChannelId],
  )
  const openEditEmoji = useCallback((anchor: HTMLElement) => {
    if (emojiMenuOpen && editPickerAnchor === anchor) {
      setEmojiMenuOpen(false)
      return
    }
    setReactTarget(null)
    setEditPickerAnchor(anchor)
    setPickerTab('emoji')
    setEmojiMenuOpen(true)
  }, [emojiMenuOpen, editPickerAnchor])

  // Save the edit (Discord's MessageEditor.onSubmit): an empty value opens
  // the "Delete Message" confirmation and leaves edit mode; an unchanged one
  // just exits; otherwise optimistic content swap + a fresh editedAt marker,
  // reconciled with the server's authoritative message (rolled back on
  // failure).
  const saveEdit = useCallback(async (raw: string) => {
    if (editingMsgId === null || editSaving) return
    const content = raw.trim()
    const messageId = editingMsgId
    const previous = messages.find((m) => m.id === messageId)
    if (!previous) {
      cancelEdit()
      return
    }
    if (!content) {
      cancelEdit()
      setDeleteTarget(previous)
      return
    }
    if (content === previous.content) {
      cancelEdit()
      return
    }
    if (raw.length > CHAT_MAX_LENGTH) {
      setError(`Your message is too long. Messages can be at most ${CHAT_MAX_LENGTH} characters.`)
      return
    }
    // Optimistic: show the new content + (edited) marker immediately and
    // leave edit mode (Discord's onSubmit ends the edit before the PATCH).
    setMessages((current) => current.map((m) => (m.id === messageId ? { ...m, content, editedAt: new Date().toISOString() } : m)))
    cancelEdit()
    try {
      const updated = await bridgeEdit(messageId, content)
      setMessages((current) => current.map((m) => (m.id === messageId ? updated : m)))
    } catch (err) {
      // Roll the optimistic edit back to the pre-edit content.
      setMessages((current) => current.map((m) => (m.id === messageId ? previous : m)))
      if (!isPermissionDenial(err)) setError(discordErrorMessage(err, 'Failed to edit message'))
    }
  }, [editingMsgId, editSaving, messages, setError, cancelEdit])

  // Stick-to-bottom for the message list. While the user is pinned at the
  // bottom, ANY height change inside the list keeps the newest content in view:
  // reaction add/remove, the edit box mounting or growing, "(edited)", reply /
  // forward / embed / media blocks loading (images, video, link previews), the
  // failed-send state, rows inserted above (grouping), day/unread dividers.
  // One observer on the content wrapper covers all of them (no per-change
  // hooks). When scrolled up, nothing here moves the viewport; the browser's
  // overflow-anchor (chat.css .chat-page .messages) keeps the reading position.
  const pinToBottom = useCallback(() => {
    const el = listRef.current
    if (!el || !stickToBottom.current) return
    el.scrollTop = el.scrollHeight - el.clientHeight
    // Our own scroll is not user intent; keep the scroll bookkeeping in step.
    lastScrollTopRef.current = el.scrollTop
  }, [])
  useEffect(() => {
    const content = listContentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(pinToBottom)
    observer.observe(content)
    return () => observer.disconnect()
  }, [pinToBottom])

  // Expire typing indicators.
  useEffect(() => {
    const timer = setInterval(() => setTyping((current) => current.filter((t) => t.expires > Date.now())), 2_000)
    return () => clearInterval(timer)
  }, [])

  // Layout effect, not a passive one: a scroll event queued while the list was
  // empty (channel switch → skeleton clamps scrollTop) is dispatched before
  // passive effects flush, so onScroll would see the freshly rendered rows at
  // the old offset, clear stickToBottom, and the channel opened mid-history.
  useLayoutEffect(() => {
    pinToBottom()
  }, [messages.length, pinToBottom])

  // Keep the list pinned to the bottom when the list box itself resizes
  // (composer grows/shrinks: reply bar armed, multi-line draft, typing strip),
  // so the last message stays fully visible above the bar instead of sliding
  // under it. Content-height changes are handled by the content observer above.
  // A box that was at the bottom just before it resized is re-pinned even if
  // stickToBottom went stale (a jump that landed on the newest row without
  // emitting a scroll event): the shrink itself fires no scroll event, so
  // onScroll never gets the chance to re-derive it.
  useEffect(() => {
    const el = listRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let boxHeight = el.clientHeight
    const observer = new ResizeObserver(() => {
      const previous = boxHeight
      boxHeight = el.clientHeight
      if (!stickToBottom.current && !hasMoreAfterRef.current && el.scrollHeight - el.scrollTop - previous <= AT_BOTTOM_EPSILON_PX) {
        stickToBottom.current = true
        el.classList.remove('notAtBottom')
      }
      pinToBottom()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [activeChannelId, pinToBottom])

  // === Windowed history (Discord's ChannelMessages + message list) ===
  // The window holds at most MAX_LOADED_MESSAGES rows. Scrolling near a
  // placeholder edge loads one MESSAGES_PER_FETCH chunk in that direction;
  // when the window then exceeds the cap the FAR end is truncated to
  // TRUNCATED_MESSAGE_VIEW_SIZE (store.truncate(isBefore, isAfter)).
  // Truncating the newest end detaches the window (hasMoreAfter) - that and
  // jump-to-message are the only things that show the jump bar.
  const hasMoreRef = useRef(hasMore)
  hasMoreRef.current = hasMore

  // Remember the first visible row (and its offset from the list top) so a
  // prepend or far-end truncation restores the exact reading position.
  const captureScrollAnchor = useCallback(() => {
    const el = listRef.current
    if (!el) return
    const listTop = el.getBoundingClientRect().top
    for (const row of Array.from(el.querySelectorAll<HTMLElement>('.message[data-message-id]'))) {
      const rect = row.getBoundingClientRect()
      if (rect.bottom > listTop) {
        scrollAnchorRef.current = { id: Number(row.dataset.messageId), top: rect.top - listTop }
        return
      }
    }
  }, [])

  useLayoutEffect(() => {
    const anchor = scrollAnchorRef.current
    if (!anchor) return
    scrollAnchorRef.current = null
    const el = listRef.current
    const row = el?.querySelector<HTMLElement>(`.message[data-message-id="${anchor.id}"]`)
    if (!el || !row) return
    const delta = row.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.top
    if (delta) el.scrollTop += delta
    lastScrollTopRef.current = el.scrollTop
  }, [messages])

  const takeDetachedArrivals = useCallback((): BridgeMessage[] => {
    const held = detachedArrivalsRef.current
    detachedArrivalsRef.current = []
    return held
  }, [])

  // Self-references for the stale-page retries below.
  const loadOlderRef = useRef<() => Promise<void>>(async () => {})
  const loadNewerRef = useRef<() => Promise<void>>(async () => {})
  const loadOlder = useCallback(async () => {
    const channelId = activeChannelRef.current
    const current = messagesRef.current
    if (!channelId || !current.length || !hasMoreRef.current || loadingMoreRef.current) return
    if (historyChannelRef.current !== channelId) return
    loadingMoreRef.current = true
    // Live (unbridged) channels page by the server's cursor, which steps past
    // system messages the page filtered out; bridged ones by the oldest row.
    const live = liveCursorRef.current?.channelId === channelId ? liveCursorRef.current : null
    const oldest = current.find((m) => m.id > 0)
    const before = live?.nextBefore || oldest?.id
    const page = await bridgeHistoryWindow(channelId, { before }, MESSAGES_PER_FETCH).catch(() => null)
    loadingMoreRef.current = false
    if (activeChannelRef.current !== channelId || historyChannelRef.current !== channelId) return
    if (!page) {
      setHasMore(false)
      return
    }
    if (page.live) liveCursorRef.current = { channelId, nextBefore: page.nextBefore, nextAfter: live?.nextAfter ?? null }
    // Loop guard: a page that adds nothing new can only be followed by another
    // page if the cursor actually advanced (a live page whose filtered system
    // messages left it empty steps past them via nextBefore). Otherwise the
    // same request would repeat forever - treat the top edge as exhausted.
    const cursorAdvanced = Boolean(page.live && page.nextBefore && String(page.nextBefore) !== String(before))
    const have = new Set(messagesRef.current.map((m) => m.id))
    const older = page.messages.filter((m) => !have.has(m.id))
    // A request fired before the previous page committed (messagesRef still
    // held the old edge) comes back all-duplicate without meaning the edge is
    // exhausted: retry from the real edge instead of stopping.
    if (!older.length && !live && before !== messagesRef.current.find((m) => m.id > 0)?.id) {
      setTimeout(() => { void loadOlderRef.current() }, 0)
      return
    }
    const moreBefore = (page.hasMoreBefore ?? page.messages.length >= MESSAGES_PER_FETCH) && (older.length > 0 || cursorAdvanced)
    if (!older.length) {
      setHasMore(moreBefore)
      return
    }
    // truncate(isBefore): over the cap → keep the oldest 60 (truncateBottom),
    // which detaches the window from the present.
    const truncateBottom = older.length + messagesRef.current.length > MAX_LOADED_MESSAGES
    captureScrollAnchor()
    setMessages((rows) => {
      const next = [...older.filter((m) => !rows.some((r) => r.id === m.id)), ...rows]
      return next.length > MAX_LOADED_MESSAGES ? next.slice(0, TRUNCATED_MESSAGE_VIEW_SIZE) : next
    })
    setHasMore(moreBefore)
    if (truncateBottom) {
      stickToBottom.current = false
      suppressLoadRef.current = 'after'
      setHasMoreAfter(true)
      if (liveCursorRef.current?.channelId === channelId) liveCursorRef.current = { ...liveCursorRef.current, nextAfter: null }
    }
  }, [captureScrollAnchor, setHasMoreAfter])

  const loadNewer = useCallback(async () => {
    const channelId = activeChannelRef.current
    const current = messagesRef.current
    if (!channelId || !current.length || !hasMoreAfterRef.current || loadingMoreRef.current) return
    if (historyChannelRef.current !== channelId) return
    loadingMoreRef.current = true
    const live = liveCursorRef.current?.channelId === channelId ? liveCursorRef.current : null
    const newestRow = [...current].reverse().find((m) => m.id > 0)
    const after = live?.nextAfter || newestRow?.id
    const page = await bridgeHistoryWindow(channelId, { after }, MESSAGES_PER_FETCH).catch(() => null)
    loadingMoreRef.current = false
    if (activeChannelRef.current !== channelId || historyChannelRef.current !== channelId || !page) return
    if (page.live) liveCursorRef.current = { channelId, nextBefore: live?.nextBefore ?? null, nextAfter: page.nextAfter ?? live?.nextAfter ?? null }
    const have = new Set(messagesRef.current.map((m) => m.id))
    const newer = page.messages.filter((m) => !have.has(m.id))
    // Stale request (see loadOlder): retry from the real bottom edge.
    if (!newer.length && !live && after !== [...messagesRef.current].reverse().find((m) => m.id > 0)?.id) {
      setTimeout(() => { void loadNewerRef.current() }, 0)
      return
    }
    // Loop guard (mirrors loadOlder): zero new messages with a cursor that
    // didn't advance means the bottom edge is exhausted - re-attach to the
    // present instead of re-requesting the same page forever.
    const cursorAdvanced = Boolean(page.live && page.nextAfter && String(page.nextAfter) !== String(after))
    const moreAfter = (page.hasMoreAfter ?? page.messages.length >= MESSAGES_PER_FETCH) && (newer.length > 0 || cursorAdvanced)
    // truncate(isAfter): over the cap → keep the newest 60 (truncateTop).
    const truncateTop = newer.length + messagesRef.current.length > MAX_LOADED_MESSAGES
    const held = moreAfter ? [] : takeDetachedArrivals()
    captureScrollAnchor()
    setMessages((rows) => {
      const next = appendArrivals([...rows, ...newer.filter((m) => !rows.some((r) => r.id === m.id))], held)
      return next.length > MAX_LOADED_MESSAGES ? next.slice(-TRUNCATED_MESSAGE_VIEW_SIZE) : next
    })
    if (truncateTop) {
      suppressLoadRef.current = 'before'
      setHasMore(true)
      if (liveCursorRef.current?.channelId === channelId) liveCursorRef.current = { ...liveCursorRef.current, nextBefore: null }
    }
    // Paged back into the present: the window is attached again and the jump
    // bar goes away (the user keeps their scroll position).
    if (!moreAfter) setHasMoreAfter(false)
  }, [captureScrollAnchor, takeDetachedArrivals, setHasMoreAfter])

  useEffect(() => {
    loadOlderRef.current = loadOlder
    loadNewerRef.current = loadNewer
  }, [loadOlder, loadNewer])

  // Load the next chunk when the scroller nears a placeholder edge (Discord
  // renders placeholder rows at an edge with more history, see
  // .chat-history-edge). Also run after every window change so a short
  // window (smaller than the viewport) keeps filling without a scroll event.
  const checkLoadMore = useCallback(() => {
    const el = listRef.current
    if (!el || loadingMoreRef.current) return
    const topRoom = el.querySelector<HTMLElement>('.chat-history-edge.top')?.offsetHeight || 0
    const bottomRoom = el.querySelector<HTMLElement>('.chat-history-edge.bottom')?.offsetHeight || 0
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (hasMoreRef.current && suppressLoadRef.current !== 'before' && el.scrollTop <= topRoom + LOAD_MORE_THRESHOLD_PX) void loadOlder()
    else if (hasMoreAfterRef.current && suppressLoadRef.current !== 'after' && fromBottom <= bottomRoom + LOAD_MORE_THRESHOLD_PX) void loadNewer()
  }, [loadOlder, loadNewer])

  useEffect(() => {
    if (loading) return
    const frame = requestAnimationFrame(checkLoadMore)
    return () => cancelAnimationFrame(frame)
  }, [messages, hasMore, hasMoreAfter, loading, checkLoadMore])

  const onScroll = useCallback(() => {
    const el = listRef.current
    if (!el) return
    // Discord dismisses the message action menu when the list scrolls.
    setMsgMenu((current) => (current ? null : current))
    // User scroll direction lifts the post-trim lock for that direction.
    const moved = el.scrollTop - lastScrollTopRef.current
    lastScrollTopRef.current = el.scrollTop
    if (moved > 0 && suppressLoadRef.current === 'after') suppressLoadRef.current = null
    else if (moved < 0 && suppressLoadRef.current === 'before') suppressLoadRef.current = null
    // Discord's isAtBottom - only meaningful when the window is attached: the
    // bottom of a detached window is NOT the present.
    const atBottom = !hasMoreAfterRef.current && el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_EPSILON_PX
    // A scroll event whose scrollTop did not change is content growth (a
    // reaction, image or edit box made the list taller below the viewport) or
    // a queued event, not the user scrolling away: it must not clear the
    // pinned state. Only real movement or reaching the bottom updates it.
    const stuck = moved !== 0 || atBottom ? atBottom : stickToBottom.current
    stickToBottom.current = stuck
    // Discord swaps chatTypingGradientAtBottom ↔ NotAtBottom on this flag; the
    // class lets the composer's typing gradient (chat.css) follow it without
    // a re-render per scroll event.
    el.classList.toggle('notAtBottom', !stuck)
    // Reaching the present by hand counts as catching up: the new-messages
    // counter and the NEW divider both clear (the user has seen everything).
    if (atBottom) {
      setNewSinceScrollUp((current) => (current.count ? { count: 0, since: null } : current))
      setUnreadDivider((current) => (current ? null : current))
    }
    checkLoadMore()
  }, [checkLoadMore])

  // Discord's jumpToPresent: an attached window just scrolls to the bottom
  // (SCROLLTO_PRESENT); a detached one refetches the newest chunk (limit 30),
  // swaps the window and lands pinned at the bottom. The bar shows the pulsing
  // ellipsis while that fetch is in flight.
  const jumpLoadingRef = useRef(false)
  const jumpToPresent = useCallback(async () => {
    // Jumping to present marks everything seen - reset the counter and drop
    // the NEW divider (it must not reappear after the channel is read).
    setNewSinceScrollUp({ count: 0, since: null })
    setUnreadDivider(null)
    const channelId = activeChannelRef.current
    if (!hasMoreAfterRef.current || !channelId) {
      stickToBottom.current = true
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
      return
    }
    if (jumpLoadingRef.current) return
    jumpLoadingRef.current = true
    setJumpLoading(true)
    const page = await bridgeHistoryWindow(channelId, {}, MESSAGES_PER_FETCH).catch(() => null)
    jumpLoadingRef.current = false
    setJumpLoading(false)
    if (!page || activeChannelRef.current !== channelId) return
    const fetched = appendArrivals(page.messages, takeDetachedArrivals())
    // Keep our own still-sending rows (negative optimistic ids) at the tail.
    const pendingOwn = messagesRef.current.filter((m) => m.id < 0 && m.clientId && !fetched.some((f) => f.clientId === m.clientId))
    stickToBottom.current = true
    scrollAnchorRef.current = null
    suppressLoadRef.current = null
    loadingMoreRef.current = false
    setMessages([...fetched, ...pendingOwn])
    setHasMore(page.hasMoreBefore ?? page.messages.length >= MESSAGES_PER_FETCH)
    setHasMoreAfter(false)
    if (page.live) liveCursorRef.current = { channelId, nextBefore: page.nextBefore, nextAfter: page.nextAfter }
    const newest = fetched.reduce((max, m) => Math.max(max, m.id), 0)
    if (newest > 0) {
      markRead(channelId, newest)
      setLatestByChannel((current) => ({ ...current, [channelId]: Math.max(current[channelId] || 0, newest) }))
    }
    requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight }))
  }, [markRead, takeDetachedArrivals, setHasMoreAfter])
  const jumpToPresentRef = useRef(jumpToPresent)
  jumpToPresentRef.current = jumpToPresent

  // Deliver an own optimistic row (submit, or Retry on a failed one). The
  // same clientId is reused on Retry - the server dedupes on (author, client
  // id), so a send that actually landed is never duplicated. On failure the
  // row stays in the list in Discord's SEND_FAILED state (red, Retry /
  // Delete) instead of vanishing behind a toast; failed rows live in
  // failedSendsRef for the session so they survive channel switches. Only
  // the email-verification gate keeps its toast (it needs the user to act).
  const deliverSend = useCallback(async (pending: BridgeMessage, replyMentionFlag: boolean | undefined): Promise<boolean> => {
    const clientId = pending.clientId!
    const replyId = pending.replyTo
    try {
      const saved = await bridgeSend(pending.channelId, pending.content, clientId, replyId, replyId ? replyMentionFlag : undefined)
      // The /send endpoint doesn't persist replyTo for web sends yet (it reads
      // only channelId/content/clientId), so the echoed row comes back with
      // replyTo:null - keep the optimistic reference until the backend passes
      // the field through, rather than letting the reply line vanish on send.
      if (replyId && !saved.replyTo) saved.replyTo = replyId
      failedSendsRef.current.delete(clientId)
      setMessages((current) => current.map((m) => (m.clientId === clientId ? saved : m)))
      return true
    } catch (err) {
      const e2 = err as Error & { requiresVerification?: boolean }
      if (e2.requiresVerification) {
        failedSendsRef.current.delete(clientId)
        setMessages((current) => current.filter((m) => m.clientId !== clientId))
        setError(discordErrorMessage(err, 'Message failed to send'))
        setNeedsVerification(true)
        return false
      }
      const failed: BridgeMessage = { ...pending, sendState: 'failed' }
      failedSendsRef.current.set(clientId, { message: failed, replyMention: replyMentionFlag })
      // A realtime echo may already have reconciled the row (the send landed
      // even though the response failed) - then it is no longer optimistic.
      setMessages((current) => current.map((m) => (m.clientId === clientId && m.id < 0 ? failed : m)))
      return false
    }
  }, [setError])

  // Discord's failed-message Retry ("Retry" toolbar button / "Resend message"
  // menu item): back to the dimmed sending look, same clientId, same reply
  // target + reply-mention setting.
  const resendFailed = useCallback((message: BridgeMessage) => {
    const clientId = message.clientId
    const entry = clientId ? failedSendsRef.current.get(clientId) : undefined
    if (!clientId || !entry) return
    const pending: BridgeMessage = { ...entry.message, sendState: undefined }
    failedSendsRef.current.delete(clientId)
    setMessages((current) => current.map((m) => (m.clientId === clientId ? pending : m)))
    void deliverSend(pending, entry.replyMention)
  }, [deliverSend])

  // Delete on a failed message: local only (it never reached the server),
  // no confirmation - Discord's deleteMessage(…, isLocal) path.
  const deleteFailed = useCallback((message: BridgeMessage) => {
    if (message.clientId) failedSendsRef.current.delete(message.clientId)
    setMessages((current) => current.filter((m) => !(m.sendState === 'failed' && m.clientId === message.clientId)))
  }, [])

  // Keep the session's failed rows at the tail of their channel: a channel
  // switch or refetch replaces `messages` with server history, so re-append
  // any failed row that isn't there (only at the present, after history for
  // this channel has landed). Rows the server did deliver (a realtime echo or
  // history row carrying the same clientId) are dropped from the store.
  useEffect(() => {
    const store = failedSendsRef.current
    if (!store.size || !activeChannelId || loading || hasMoreAfter) return
    if (historyChannelRef.current !== activeChannelId) return
    const missing: BridgeMessage[] = []
    for (const [clientId, entry] of store) {
      if (entry.message.channelId !== activeChannelId) continue
      const row = messages.find((m) => m.clientId === clientId)
      if (!row) missing.push(entry.message)
      else if (row.id > 0) store.delete(clientId)
    }
    if (missing.length) setMessages((current) => [...current, ...missing.filter((f) => !current.some((m) => m.clientId === f.clientId))])
  }, [messages, activeChannelId, loading, hasMoreAfter])

  const submit = useCallback(async (e?: FormEvent) => {
    e?.preventDefault()
    // Serialize the rich composer DOM: emoji chips fold back to their unicode
    // surrogates, mention chips to their literal token (<@id> / <@&id> / …),
    // <br>/block boundaries to '\n' - exactly the string plain typing sends.
    const raw = inputRef.current ? serializeComposer(inputRef.current) : ''
    const content = raw.trim()
    // No in-flight gate: like Discord, each send gets its own optimistic
    // (dimmed, isSending) row and the request queues behind earlier sends in
    // the rate-limit queue, so a burst - even one that hits a 429 - delivers
    // in order without blocking the composer.
    if (!content) return
    // Discord's 2000-char cap: the server truncates silently, so guard here and
    // tell the user instead of dropping their tail (Discord's own client blocks
    // the send and shows the red over-limit counter).
    if (raw.length > CHAT_MAX_LENGTH) {
      setError(`Your message is too long. Messages can be at most ${CHAT_MAX_LENGTH} characters.`)
      return
    }
    if (!user) {
      setShowAuth(true)
      return
    }
    if (user.emailVerified === false) {
      setError('Verify your email to chat.')
      setNeedsVerification(true)
      return
    }
    if (!activeChannelId) return
    // Read-only channel (not bridged): the composer is hidden and Enter is
    // swallowed earlier, but guard the network call itself so a non-bridged
    // /send (which 404s) is never attempted.
    if (channelsRef.current.find((c) => c.channelId === activeChannelId)?.bridged === false) return
    setError(null)
    setNeedsVerification(false)
    const clientId = crypto.randomUUID()
    // Reply reference: the bridge persists reply_to as the referenced message
    // id string (Discord-origin replies store the Discord snowflake; web
    // replies store the internal bridge message id).
    const replyId = replyTo ? String(replyTo.id) : null
    const optimistic: BridgeMessage = {
      id: nextOptimisticId(),
      channelId: activeChannelId,
      direction: 'web',
      discordMessageId: null,
      authorKey: perms?.ownerKey || 'me',
      authorName: effectiveChatDisplayName(user),
      authorAvatar: chatAvatar || (user.discord?.avatar
        ? `https://cdn.discordapp.com/avatars/${user.discord.id}/${user.discord.avatar}.webp?size=64`
        : null),
      authorColor: null,
      authorRole: perms && perms.tier !== 'member' && perms.tier !== 'guest' ? perms.tier as 'mod' | 'admin' | 'owner' : null,
      content,
      attachments: [],
      embeds: [],
      mentions: [],
      replyTo: replyId,
      clientId,
      createdAt: new Date().toISOString(),
      editedAt: null,
      deletedAt: null,
      reactions: [],
    }
    // Discord jumps to the present when you send while viewing older
    // messages; the optimistic row rides along (jumpToPresent keeps rows
    // with a negative id until /send reconciles them).
    if (hasMoreAfterRef.current) void jumpToPresentRef.current()
    setMessages((current) => [...current, optimistic])
    if (stickToBottom.current) {
      requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight }))
    }
    if (inputRef.current) inputRef.current.textContent = ''
    setComposerLength(0)
    // Discord clears the reply bar as soon as the message is sent (the
    // pending row carries the reference).
    if (replyId) setReplyTo(null)
    // Emoji frecency: every unicode emoji the sent message uses (picker
    // inserts and typed/pasted emoji alike).
    if (await deliverSend(optimistic, replyId ? replyMention : undefined)) recordEmojiUsesInText(content)
  }, [user, chatAvatar, activeChannelId, replyTo, replyMention, perms, setError, deliverSend])

  // --- Mention autocomplete (Discord's @-tab) --------------------------------
  // The composer is an uncontrolled contenteditable, so trigger detection runs
  // on every input event: walk from the caret back to the last '@'/'#' with no
  // whitespace or '<' between. '@&' is the role-mention form - when the caret's
  // run starts with '@&' the trigger is '@&' and only roles are suggested.
  // Text and offsets live in the SERIALIZED frame (chips count as their token,
  // never their label), so typing beside a mention chip can't false-trigger on
  // the chip's label and insertMentionChip maps the span back to the same DOM.
  const updateMentionTrigger = useCallback((el: HTMLDivElement) => {
    // Discord converts a completed ':name:' shortcode to the emoji in place.
    if (convertTypedShortcode(el)) setComposerLength(serializeComposer(el).length)
    const text = serializeComposer(el)
    // Caret offset within the serialized text; falls back to end-of-input when
    // the selection is outside the editable. The shared detector (also used
    // by the inline message editor) finds '@adin', '@&mod', '#gen' and
    // ':smi' (2+ chars) tails preceded by start/whitespace, so 'email@host'
    // never opens the popup.
    const caret = serializedCaretOffset(el) ?? text.length
    setMentionTrigger(detectTrigger(text, caret))
  }, [])

  // Debounced (~150ms) suggestion fetch against /members. Out-of-order replies
  // are dropped with a sequence counter; an empty query fetches too - Discord
  // opens the popup on a bare '@' with its top suggestions.
  useEffect(() => {
    clearTimeout(mentionFetchTimer.current)
    // The ':' emoji tab is local - no /members request.
    if (!mentionTrigger || mentionTrigger.trigger === ':' || !activeChannelId) { setMentionSuggestions(null); return }
    const channelId = activeChannelId
    const q = mentionTrigger.query
    mentionFetchTimer.current = setTimeout(() => {
      const seq = ++mentionFetchSeq.current
      bridgeMembers(channelId, q, 8)
        .then((result) => { if (mentionFetchSeq.current === seq) setMentionSuggestions(result) })
        .catch(() => { if (mentionFetchSeq.current === seq) setMentionSuggestions({ members: [], roles: [], channels: [] }) })
    }, 150)
    return () => clearTimeout(mentionFetchTimer.current)
  }, [mentionTrigger, activeChannelId])

  // The popup's flat item list: '#' suggests the bridge's channels (Discord's
  // channel autocomplete), '@&' suggests roles only, plain '@' leads with the
  // mass-mention shortcuts @everyone/@here (Discord puts them at the TOP of
  // the list, unshifted ahead of members), then members, then roles matching
  // the query. @everyone/@here are offered only with MENTION_EVERYONE (the
  // real perm the server's parseMentions gates the ping on - mods hold it),
  // mirrored from the /perms payload's canMentionEveryone.
  // ':' lists unicode emoji matching the query (Discord's "Emoji matching").
  // One builder serves the composer and the inline message editor.
  const buildMentionItems = useCallback((trigger: AutocompleteTrigger, suggestions: BridgeMembersResult | null): MentionSuggestionItem[] => {
    const mentionTrigger = trigger
    const mentionSuggestions = suggestions
    if (mentionTrigger.trigger === ':') return emojiSuggestionItems(mentionTrigger.query)
    if (mentionTrigger.trigger === '#') {
      return (mentionSuggestions?.channels || []).map((channel) => ({
        kind: 'channel' as const, id: channel.channelId, label: channel.name,
        channelKind: channelIconKinds.get(channel.channelId) || 'text',
      }))
    }
    if (mentionTrigger.trigger === '@&') {
      return (mentionSuggestions?.roles || []).map((role) => ({
        kind: 'role' as const, id: role.roleId, label: role.name, color: role.color, colors: role.colors ?? null,
      }))
    }
    const q = mentionTrigger.query.toLowerCase()
    const items: MentionSuggestionItem[] = []
    if (perms?.canMentionEveryone) {
      if ('everyone'.startsWith(q)) items.push({ kind: 'everyone', id: 'everyone', label: 'everyone', sublabel: 'Notify everyone who has access to this channel' })
      if ('here'.startsWith(q)) items.push({ kind: 'here', id: 'here', label: 'here', sublabel: 'Notify everyone online in this channel' })
    }
    items.push(...(mentionSuggestions?.members || []).map((member) => ({
      kind: 'member' as const,
      id: member.userId,
      label: member.displayName,
      sublabel: `@${member.username}`,
      // The /members endpoint returns a COMPLETE avatar url (real CDN url,
      // else the embed/avatars/N.png default-by-id) - use it verbatim. Only if
      // it's somehow empty do we synthesize a never-broken data-URI initial
      // avatar. Backstop: a CDN url that 404s at render time is caught by the
      // document-level capture listener above (the Composer-owned <img> has no
      // onError prop) and swapped to the initial-avatar data URI.
      avatarUrl: member.avatar || initialAvatar(member.displayName || member.username),
    })))
    items.push(...(mentionSuggestions?.roles || []).map((role) => ({
      kind: 'role' as const, id: role.roleId, label: role.name, color: role.color, colors: role.colors ?? null,
    })))
    return items
  }, [perms?.canMentionEveryone])
  const mentionItems = useMemo<MentionSuggestionItem[]>(
    () => (mentionTrigger ? buildMentionItems(mentionTrigger, mentionSuggestions) : []),
    [mentionTrigger, mentionSuggestions, buildMentionItems],
  )

  // Reset the highlight to the first row whenever the suggestion set changes
  // (Discord highlights the top match). Render guards on items.length, so the
  // popup hides while a fetch is in flight with no prior results.
  const mentionItemsKey = mentionItems.map((i) => `${i.kind}:${i.id}`).join(',')
  useEffect(() => { setMentionIndex(0) }, [mentionItemsKey])

  const mentionOpen = mentionTrigger !== null && mentionItems.length > 0

  // Select a suggestion: swap the trigger+query text span for a non-editable
  // mention chip + trailing space and park the caret after it (Discord's rich
  // composer). The chip's data-token is the exact form Discord clients send -
  // '<@userId>' / '<@&roleId>' / '<#channelId>' / '@everyone' / '@here' - and
  // serializeComposer() folds it back to that token on send. (The bridge's
  // web-side parseMentions doesn't resolve channel tokens, so a '<#channelId>'
  // stays literal text on web sends; the renderContent channel-chip branch
  // still renders any that arrive from Discord.)
  const insertMention = useCallback((index: number) => {
    const el = inputRef.current
    const trig = mentionTrigger
    const item = mentionItems[index]
    if (!el || !trig || !item) return
    const replaceEnd = trig.start + trig.trigger.length + trig.query.length
    if (item.kind === 'emoji' && item.emoji) {
      replaceWithEmojiChip(el, trig.start, replaceEnd, item.emoji)
      recordEmojiUse(item.emoji[0])
    } else {
      insertMentionChip(el, trig.start, replaceEnd, mentionChipFor(item))
    }
    setComposerLength(serializeComposer(el).length)
    setMentionTrigger(null)
    setMentionSuggestions(null)
  }, [mentionTrigger, mentionItems])

  const onInputKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    // Mention-autocomplete nav takes priority over Enter-to-send: with the
    // popup open, up/down move the highlight, Enter/Tab select, Esc dismisses.
    if (mentionOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => (i + 1) % mentionItems.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => (i - 1 + mentionItems.length) % mentionItems.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(mentionIndex); return }
      if (e.key === 'Escape') { e.preventDefault(); setMentionTrigger(null); setMentionSuggestions(null); return }
    }
    // Discord: Up in an EMPTY composer edits your most recent editable
    // message in the channel (skipping ones you can't edit).
    if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && inputRef.current && serializeComposer(inputRef.current) === '') {
      const last = [...messagesRef.current].reverse().find((m) => m.channelId === activeChannelId && canEditMessage(m))
      if (last) {
        e.preventDefault()
        startEdit(last)
        requestAnimationFrame(() => {
          listRef.current?.querySelector(`.message[data-message-id="${last.id}"]`)?.scrollIntoView({ block: 'nearest' })
        })
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
      return
    }
    const now = Date.now()
    if (activeChannelId && now - typingSentAt.current > 4_000) {
      typingSentAt.current = now
      void bridgeTyping(activeChannelId)
    }
  }, [submit, activeChannelId, mentionOpen, mentionItems.length, mentionIndex, insertMention, canEditMessage, startEdit])

  // Insert a picked emoji into the contenteditable composer as an inline,
  // non-editable Twemoji chip at the caret (Discord's rich input); the chip
  // carries the unicode surrogates and serializes back to them on send. The
  // contenteditable is uncontrolled, so the length mirror is updated by hand
  // (no input event fires for a programmatic DOM write). Unknown surrogates
  // (not in the local catalog) fall back to plain text insertion.
  const insertEmoji = useCallback((surrogates: string, keepOpen = false) => {
    const el = inputRef.current
    if (el) {
      const entry = allEmoji.find((e) => e[1] === surrogates)
      if (entry) {
        // Usage is recorded when the message is SENT (Discord tracks the
        // emoji a sent message uses), not on insert - see submit().
        insertEmojiChip(el, entry)
      } else {
        el.textContent = `${el.textContent || ''}${surrogates}`
        el.focus()
      }
      setComposerLength(serializeComposer(el).length)
    }
    // Discord closes the picker on pick unless Shift is held.
    if (!keepOpen) setEmojiMenuOpen(false)
  }, [])

  // ExpressionPicker emoji dispatch: while `reactTarget` is armed (message
  // menu → Add Reaction), a picked emoji reacts to that message instead of
  // inserting into the composer. Same flow the hover-toolbar quick-reacts use.
  const pickEmoji = useCallback((surrogates: string, keepOpen = false) => {
    if (reactTarget) {
      const entry = allEmoji.find((e) => e[1] === surrogates)
      const target = reactTarget
      // Shift-click keeps the picker (and its react target) armed so several
      // reactions can be added in a row, like Discord.
      if (!keepOpen) {
        setReactTarget(null)
        setEmojiMenuOpen(false)
      }
      if (entry) void toggleReaction(target, entry)
      return
    }
    // Picker opened from the inline editor's emoji button: insert there.
    if (editPickerAnchor) {
      const entry = allEmoji.find((e) => e[1] === surrogates)
      if (entry) editorRef.current?.insertEmoji(entry)
      if (!keepOpen) {
        setEditPickerAnchor(null)
        setEmojiMenuOpen(false)
      }
      return
    }
    insertEmoji(surrogates, keepOpen)
  }, [reactTarget, toggleReaction, insertEmoji, editPickerAnchor])

  // Send a GIF or sticker as a standalone embed message. Discord lets every
  // member use GIFs/stickers; the content is the media URL and the bridge
  // renders it via the embed pipeline. A pending reply attaches to the embed
  // send too (Discord replies can carry stickers/GIFs), then clears.
  const sendEmbed = useCallback(async (full: { url: string; width: number; height: number }) => {
    if (!user || !activeChannelId || sending) return
    // Read-only channel: never send an embed to a non-bridged channel.
    if (channelsRef.current.find((c) => c.channelId === activeChannelId)?.bridged === false) return
    setEmojiMenuOpen(false)
    setSending(true)
    setError(null)
    const clientId = crypto.randomUUID()
    const replyId = replyTo ? String(replyTo.id) : null
    try {
      const saved = await bridgeSend(activeChannelId, full.url, clientId, replyId, replyId ? replyMention : undefined)
      if (replyId && !saved.replyTo) saved.replyTo = replyId
      // No optimistic row for embed sends, and the server broadcasts the
      // persisted row over realtime BEFORE answering /send - so the echo may
      // already have landed. Reconcile instead of blind-appending: drop the
      // insert when the id (or clientId) is already in the list, replace the
      // echoed row otherwise. This is what kept GIF/sticker sends rendering
      // twice.
      setMessages((current) => {
        if (current.some((m) => m.id === saved.id)) return current
        const echoed = saved.clientId
          ? current.findIndex((m) => m.clientId === saved.clientId && m.direction === 'web')
          : -1
        if (echoed >= 0) {
          const next = [...current]
          next[echoed] = saved
          return next
        }
        return [...current, saved]
      })
      setReplyTo(null)
      if (stickToBottom.current) {
        requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight }))
      }
    } catch (err) {
      if (!isPermissionDenial(err)) setError(discordErrorMessage(err, 'Message failed to send'))
    } finally {
      setSending(false)
    }
  }, [user, activeChannelId, sending, replyTo, replyMention, setError])

  // Open the expression picker on a given tab (Discord's GIF and Sticker
  // buttons deep-link the picker to their tab; the emoji button uses 'emoji').
  // Clicking the button for the already-open tab closes the picker. The send
  // gate mirrors composerDisabled but is computed from its inputs because this
  // callback is declared before the composerDisabled const below.
  const openPicker = useCallback((tab: PickerTab) => {
    if (!activeChannelId) return
    if (user && (user.emailVerified === false || (perms !== null && !perms.canSend))) return
    if (emojiMenuOpen && pickerTab === tab) {
      setEmojiMenuOpen(false)
      return
    }
    setPickerTab(tab)
    setEmojiMenuOpen(true)
  }, [activeChannelId, user, perms, emojiMenuOpen, pickerTab])

  // Reset the picker tab whenever the picker closes so the emoji button (which
  // doesn't set a tab first) always lands on the emoji tab.
  useEffect(() => {
    if (!emojiMenuOpen) {
      setPickerTab('emoji')
      setEditPickerAnchor(null)
    }
  }, [emojiMenuOpen])

  // No attach (+) button: the bridge has no upload path (the /send body is
  // text-only and webhook delivery runs in the bot process), so Discord's
  // upload affordance is omitted rather than left as a dead control.

  // Persist the user-panel presence choice (optimistic local, then the stored
  // value; other devices and other viewers update over the realtime bus).
  const pickStatus = useCallback((next: PresenceStatus) => {
    setSelfChoice(next)
    setStatusOpen(false)
    savePresenceStatus(next).catch(() => {})
  }, [])

  // Hide Muted Channels: a client view preference applied to one guild's
  // channel list.
  const toggleHideMuted = useCallback((guildId: string | null | undefined) => {
    if (!guildId) return
    setHideMutedByGuild((current) => {
      const next = { ...current, [guildId]: !(guildId in current ? current[guildId] : hideMutedDefault) }
      try { localStorage.setItem(HIDE_MUTED_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [hideMutedDefault])

  // Sidebar resize drag: pointer down on the handle captures the pointer and
  // tracks movement, clamping the width between SIDEBAR_MIN/SIDEBAR_MAX. The
  // width applies to .bar (and the floating user panel) through the
  // --chat-sidebar-width custom property set on .chat-page below.
  const [sidebarDragging, setSidebarDragging] = useState(false)
  const sidebarDrag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  const onSidebarHandleDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    sidebarDrag.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: sidebarWidth }
    setSidebarDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [sidebarWidth])
  const onSidebarHandleMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = sidebarDrag.current
    if (!drag || e.pointerId !== drag.pointerId) return
    const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, drag.startWidth + (e.clientX - drag.startX)))
    setSidebarWidth(next)
  }, [])
  const endSidebarDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = sidebarDrag.current
    if (!drag || e.pointerId !== drag.pointerId) return
    sidebarDrag.current = null
    setSidebarDragging(false)
    setSidebarWidth((current) => {
      try { localStorage.setItem('abulxt:chat-sidebar-width', String(current)) } catch { /* ignore */ }
      return current
    })
  }, [])
  // Double-click the handle resets to Discord's default 240px sidebar.
  const resetSidebarWidth = useCallback(() => {
    sidebarDrag.current = null
    setSidebarDragging(false)
    setSidebarWidth(SIDEBAR_DEFAULT)
    try { localStorage.setItem('abulxt:chat-sidebar-width', String(SIDEBAR_DEFAULT)) } catch { /* ignore */ }
  }, [])

  // Discord behavior: typing anywhere on the chat page focuses the composer so
  // the character lands in the message box. A global keydown (capture phase, so
  // it runs before the target's own handler) redirects single printable
  // characters - no ctrl/meta/alt - to the contenteditable when the event
  // target isn't already an editable surface (input/textarea/contenteditable).
  useEffect(() => {
    const onGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key?.length !== 1) return // single printable char only
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
      }
      const input = inputRef.current
      if (!input || input.getAttribute('contenteditable') !== 'true') return
      input.focus()
    }
    document.addEventListener('keydown', onGlobalKeyDown, true)
    return () => document.removeEventListener('keydown', onGlobalKeyDown, true)
  }, [])

  // Dismiss the small popovers (pinned messages, inbox, notification settings,
  // status picker, help, search) on outside click or Escape, matching the
  // context menu / profile popout behavior.
  useEffect(() => {
    if (!pinsOpen && !statusOpen && !inboxOpen && !notifOpen && !helpOpen && !searchOpen) return
    const close = (e: MouseEvent) => {
      // Test the event's dispatch path, not e.target.closest(): a press on a
      // row/tab that re-renders away mid-event leaves a detached target that
      // would otherwise read as "outside". Presses inside a context menu
      // opened from a popover row, or inside a modal layered above (e.g. a
      // confirm dialog), keep the popover open.
      const inside = (sel: string) => eventWithinSelector(e, sel)
      if (inside('.contextMenuLayer, .deleteConfirmBackdrop, .forwardDialogBackdrop, .settingsModalBackdrop, .gnmBackdrop, .dcSelectLayer')) return
      if (pinsOpen && !inside('.pinnedPopover') && !inside('.d-headerClickable')) setPinsOpen(false)
      if (inboxOpen && !inside('.inboxPopover') && !inside('.d-headerIconInbox')) setInboxOpen(false)
      if (notifOpen && !inside('.notifPopover') && !inside('.d-headerIconBell')) setNotifOpen(false)
      if (statusOpen && !inside('.statusPicker') && !inside('.avatarWrapper')) setStatusOpen(false)
      if (helpOpen && !inside('.helpPopover') && !inside('.d-headerIconHelp')) setHelpOpen(false)
      if (searchOpen && !inside('.headerSearchWrap, .chatSearchPopout') && !inside('.d-headerIconSearch')) setSearchOpen(false)
    }
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') { setPinsOpen(false); setInboxOpen(false); setNotifOpen(false); setStatusOpen(false); setHelpOpen(false); setSearchOpen(false) }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [pinsOpen, statusOpen, inboxOpen, notifOpen, helpOpen, searchOpen])

  // Inbox (Mentions) popover data: when opened, pull each loaded channel's
  // recent history and keep the messages that ping the caller (newest first).
  // Runs off the same messageMentionsUser() identity the row highlight uses.
  // Every cached guild is covered (Discord's inbox spans servers), each
  // guild's messages tested with that guild's roles.
  useEffect(() => {
    if (!inboxOpen || !user) return
    let cancelled = false
    setInboxLoading(true)
    const multiGuild = guilds.length > 1
    const targets = guilds.flatMap((guild) => (channelsByGuild[guild.id]?.channels ?? []).map((channel) => ({ guild, channel })))
    // Only bridged channels have a history route - skip the read-only ones
    // (their /history 404s and they'd contribute no mentions anyway).
    void Promise.all(targets.filter(({ channel }) => channel.bridged !== false).map(async ({ guild, channel }) => {
      const history = await bridgeHistory(channel.channelId, undefined, 50).catch(() => [] as BridgeMessage[])
      const self = mentionSelfFor(guild.id)
      return history
        .filter((m) => !m.deletedAt && messageMentionsUser(m, self))
        .map((message) => ({ message, channelName: channel.name, guildName: multiGuild ? guild.name : null }))
    })).then((perChannel) => {
      if (cancelled) return
      const all = perChannel.flat()
      all.sort((a, b) => b.message.id - a.message.id)
      setInboxMentions(all.slice(0, 25))
      setInboxLoading(false)
    })
    return () => { cancelled = true }
  }, [inboxOpen, user, guilds, channelsByGuild, mentionSelf, mentionSelfFor])

  // Inbox mention click → jump: the shared message-jump path (switches guild
  // and channel if needed; a target outside the loaded window loads `around`
  // it).
  const jumpToMention = useCallback((entry: { message: BridgeMessage }) => {
    setInboxOpen(false)
    jumpToMessageRef.current(entry.message.channelId, entry.message.id)
  }, [])


  // === Pins (Discord's Pinned Messages popout + Pin/Unpin Message) ===
  // Staff (Manage Messages analogue: MANAGE_WEBHOOKS / BAN_WEBHOOKS, the same
  // gate the server's /pin route enforces) can pin and unpin.
  const canPin = Boolean(perms?.canManageWebhook || perms?.canBan)
  const loadPins = useCallback((channelId: string) => {
    setPinsError(null)
    bridgePins(channelId)
      .then((list) => {
        if (activeChannelRef.current !== channelId) return
        setPins(list)
        setPinnedIds({ channelId, ids: list.map((p) => p.message.id).filter((id) => id > 0) })
      })
      .catch((e) => {
        if (activeChannelRef.current !== channelId) return
        setPins([])
        setPinsError(discordErrorMessage(e, 'Could not load pinned messages.'))
      })
  }, [])
  // Re-read pins every time the popout opens (pins can change on Discord).
  useEffect(() => {
    if (!pinsOpen || !activeChannelId) return
    setPins(null)
    loadPins(activeChannelId)
  }, [pinsOpen, activeChannelId, channels, loadPins])
  // Staff need the pinned set up front so the message menu can say Pin vs Unpin.
  useEffect(() => {
    if (!canPin || !activeChannelId) return
    if (channels.find((c) => c.channelId === activeChannelId)?.bridged === false) return
    loadPins(activeChannelId)
  }, [canPin, activeChannelId, channels, loadPins])
  // bridge.pins (a staff webhook pinned/unpinned) → refresh if it's on screen.
  useEffect(() => {
    pinsRefreshRef.current = (channelId: string) => {
      if (channelId === activeChannelId && (pinsOpen || canPin)) loadPins(channelId)
    }
  }, [activeChannelId, pinsOpen, canPin, loadPins])
  const togglePin = useCallback(async (message: BridgeMessage) => {
    const pinned = Boolean(pinnedIds && pinnedIds.channelId === message.channelId && pinnedIds.ids.includes(message.id))
    try {
      await bridgePin(message.id, !pinned)
      setPinnedIds((current) => {
        const ids = current && current.channelId === message.channelId ? current.ids : []
        return { channelId: message.channelId, ids: pinned ? ids.filter((id) => id !== message.id) : [...ids, message.id] }
      })
      if (pinsOpen) loadPins(message.channelId)
    } catch (e) {
      if (!isPermissionDenial(e)) setError(discordErrorMessage(e, pinned ? 'Could not unpin the message.' : 'Could not pin the message.'))
    }
  }, [pinnedIds, pinsOpen, loadPins, setError])

  // === Message jumps (deep links, search / pins / inbox Jump) ===
  // Discord's jumpToMessage: a target already in the window just scrolls
  // there and flashes; otherwise ONE `around` fetch (limit d7Q = 30) replaces
  // the window - detached from the present when newer messages exist, so the
  // jump bar shows. A jump into a channel that isn't open is loaded `around`
  // directly by the channel-load effect (pendingJumpRef).
  useEffect(() => {
    if (!pendingJump || loading) return
    if (pendingJump.channelId !== activeChannelId || historyChannelRef.current !== activeChannelId) return
    const { messageId, channelId } = pendingJump
    const key = `${channelId}:${messageId}`
    if (messages.some((m) => m.id === messageId && !m.deletedAt)) {
      setPendingJump(null)
      jumpAroundRef.current = null
      stickToBottom.current = false
      requestAnimationFrame(() => {
        const el = listRef.current?.querySelector(`[data-message-id="${messageId}"]`)
        el?.scrollIntoView({ block: 'center' })
        el?.classList.add('jumpHighlight')
        setTimeout(() => el?.classList.remove('jumpHighlight'), 1600)
        // A target among the newest rows can't be centred and leaves the list
        // at the bottom, often without a scroll event: re-derive the pinned
        // state here so new rows and composer resizes keep following it.
        const list = listRef.current
        if (list && !hasMoreAfterRef.current && list.scrollHeight - list.scrollTop - list.clientHeight <= AT_BOTTOM_EPSILON_PX) {
          stickToBottom.current = true
          list.classList.remove('notAtBottom')
        }
      })
      return
    }
    if (jumpAroundRef.current?.key === key) {
      // Around page already loaded without the target (deleted): give up.
      if (jumpAroundRef.current.done) {
        setPendingJump(null)
        jumpAroundRef.current = null
      }
      return
    }
    jumpAroundRef.current = { key, done: false }
    bridgeHistoryWindow(channelId, { around: messageId }, JUMP_FETCH_LIMIT)
      .then((page) => {
        if (activeChannelRef.current !== channelId || jumpAroundRef.current?.key !== key) return
        jumpAroundRef.current = { key, done: true }
        if (!page.messages.length) {
          setPendingJump(null)
          return
        }
        const detached = page.hasMoreAfter ?? false
        const rows = detached ? page.messages : appendArrivals(page.messages, takeDetachedArrivals())
        stickToBottom.current = false
        scrollAnchorRef.current = null
        suppressLoadRef.current = null
        loadingMoreRef.current = false
        setMessages(rows)
        setHasMore(page.hasMoreBefore ?? true)
        setHasMoreAfter(detached)
        if (page.live) liveCursorRef.current = { channelId, nextBefore: page.nextBefore, nextAfter: page.nextAfter }
      })
      .catch(() => {
        if (jumpAroundRef.current?.key !== key) return
        jumpAroundRef.current = null
        setPendingJump(null)
      })
  }, [pendingJump, loading, activeChannelId, messages, setHasMoreAfter, takeDetachedArrivals])

  // Open a channel in whichever cached guild holds it (switching guild
  // first, like Discord). False when no cached guild lists the channel.
  const openChannel = useCallback((channelId: string): boolean => {
    const guildId = channelGuildRef.current.get(channelId)
    if (!guildId) return false
    if (guildId !== activeGuildIdRef.current) selectGuildRef.current(guildId, { channelId })
    else { setCrSection(null); setActiveChannelId(channelId) }
    return true
  }, [])

  const jumpToMessage = useCallback((channelId: string, messageId: number) => {
    if (!channelGuildRef.current.has(channelId)) return
    jumpAroundRef.current = null
    setPendingJump({ channelId, messageId })
    openChannel(channelId)
  }, [openChannel])
  const jumpToMessageRef = useRef(jumpToMessage)
  jumpToMessageRef.current = jumpToMessage

  // Deep links (Copy Channel Link / Copy Message Link →
  // #/chat?guild=…&channel=…&message=…). App.tsx stashes the target in
  // sessionStorage (and fires abulxt:chat-link when chat is already open).
  // The channel's guild is resolved from the sidebar caches (`guild` only
  // picks the guild to open first): 'wait' while a guild list is still
  // loading, then the guild + channel (+ message) open; an unknown channel id
  // is dropped.
  const applyChatLink = useCallback((): 'none' | 'wait' | 'done' => {
    const target = readChatLink()
    if (!target?.channel) return 'none'
    const list = guildsRef.current
    if (!list.length) return 'wait'
    const channelId = String(target.channel)
    if (!channelGuildRef.current.has(channelId)) {
      const cached = channelsByGuildRef.current
      if (!list.every((g) => cached[g.id])) return 'wait'
      clearChatLink()
      return 'none'
    }
    clearChatLink()
    const messageId = Number(target.message)
    if (Number.isFinite(messageId) && messageId > 0) jumpToMessage(channelId, messageId)
    else openChannel(channelId)
    return 'done'
  }, [jumpToMessage, openChannel])
  applyChatLinkRef.current = applyChatLink
  useEffect(() => {
    const onLink = () => { applyChatLink() }
    window.addEventListener('abulxt:chat-link', onLink)
    return () => window.removeEventListener('abulxt:chat-link', onLink)
  }, [applyChatLink])

  // Mention-chip clicks (Discord): user → profile popout; channel → open
  // that channel (only if it's in the sidebar list); role → role popout
  // listing the role's members. @everyone/@here chips aren't clickable.
  const openMention = useCallback((mention: { type: string; id: string; username?: string; name?: string }, event: React.MouseEvent) => {
    if (mention.type === 'user') {
      openMentionProfile(mention, event)
      return
    }
    event.stopPropagation()
    if (mention.type === 'channel') {
      // A channel in another bridged guild switches guild first.
      openChannel(mention.id)
      return
    }
    if (mention.type !== 'role') return
    const channelId = activeChannelRef.current
    if (!channelId) return
    const chip = (event.target as HTMLElement | null)?.closest('.mention') as HTMLElement | null
    const roleId = mention.id
    setProfile(null)
    setRolePopout({
      roleId,
      name: mention.name || roleId,
      color: (mention as { color?: string | null }).color ?? null,
      anchor: chip || (event.currentTarget as HTMLElement),
      data: null,
      error: null,
    })
    bridgeRoleMembers(channelId, roleId)
      .then((data) => setRolePopout((cur) => (cur && cur.roleId === roleId ? { ...cur, data, name: data.role.name, color: data.role.color } : cur)))
      .catch((e) => setRolePopout((cur) => (cur && cur.roleId === roleId ? { ...cur, error: discordErrorMessage(e, 'Could not load role members.') } : cur)))
  }, [openMentionProfile, openChannel])

  // Dismiss the role popout on outside click / Escape.
  useEffect(() => {
    if (!rolePopout) return
    const close = (e: MouseEvent) => {
      if (!eventWithinSelector(e, '.rolePopout, .contextMenuLayer')) setRolePopout(null)
    }
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setRolePopout(null) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [rolePopout])

  // Dismiss the reactions popout on outside click / Escape (a reactor's
  // profile popout counts as inside, so it can open over the list).
  useEffect(() => {
    if (!reactorsPopout) return
    const close = (e: MouseEvent) => {
      if (!eventWithinSelector(e, '.reactorsPopout, .reactionTooltip, .profilePopout, .contextMenuLayer')) setReactorsPopout(null)
    }
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setReactorsPopout(null) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [reactorsPopout])

  // Original closes the emoji menu on any outside click.
  useEffect(() => {
    if (!emojiMenuOpen) return
    // Path-based: picker tabs, GIF category tiles, the search clear button
    // and the skin-tone flyout all re-render away under the click, so by the
    // time this document listener runs e.target is detached and .closest()
    // would wrongly report a press INSIDE the picker as outside.
    const close = (e: MouseEvent) => {
      // The react-mode triggers (hover-toolbar / reactions-row Add Reaction)
      // open the picker on this same click, so they're excluded too.
      if (!eventWithinSelector(e, '.picker, .contextMenuLayer, .chat-emojiButton, .chat-composer-btn, .d-msgHoverBarButton[aria-label="Add Reaction"], .reactionBtn')) {
        setEmojiMenuOpen(false)
      }
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [emojiMenuOpen])

  // The open post's forum (sidebar row), and the post as a channel row so the
  // header, composer placeholder and context menus read it like a channel.
  const postForum = useMemo(() => (openPost ? allChannels.get(openPost.forumId) ?? null : null), [openPost, allChannels])
  const activeChannel = useMemo<BridgeChannel | null>(() => {
    if (openPost && openPost.id === activeChannelId) {
      return { channelId: openPost.id, name: openPost.name, topic: '', position: 0, type: 11, parentId: openPost.forumId, guildId: openPost.guildId, bridged: true }
    }
    return channels.find((c) => c.channelId === activeChannelId) || null
  }, [channels, activeChannelId, openPost])
  // The forum view replaces the message list when a forum (type 15/16) is open.
  const activeForum = activeChannel && isForumType(activeChannel.type) ? activeChannel : null
  const activePost = openPost && openPost.id === activeChannelId ? openPost : null
  // Viewing a forum reads it (its unread dot tracks messages in any post).
  useEffect(() => {
    if (!activeForum) return
    const latest = latestByChannel[activeForum.channelId] || 0
    if (latest) markRead(activeForum.channelId, latest)
  }, [activeForum, latestByChannel, markRead])
  const openForumPost = useCallback((post: ForumPost) => {
    setCrSection(null)
    setOpenPost(post)
    setActiveChannelId(post.id)
  }, [setOpenPost])
  // Locked / closed state of the open post: the perms payload is the live
  // truth (contract.md perms.post), the post object the fallback.
  const postState = activePost && perms?.post?.id === activePost.id ? perms.post : activePost
  const postLocked = Boolean(postState?.locked)
  const postArchived = Boolean(postState?.archived)
  const postPending = Boolean(activePost && (activePost.pending || isPendingPostId(activePost.id)))
  const postSelfKeys = perms?.webhookKeys || (perms?.ownerKey ? [perms.ownerKey] : [])
  const runPostAction = useCallback((post: ForumPost, action: PostModerateAction) => {
    moderatePost(post.id, action)
      .then((res) => { if (res.post && openPostRef.current?.id === res.post.id) setOpenPost(res.post) })
      .catch((err) => setError(err instanceof Error ? err.message : 'Something went wrong.'))
  }, [setOpenPost, setError])
  // Read-only = the active channel exists but is NOT bridged to the web chat.
  // Discord lets members browse channels they can't send in; on the bridge a
  // non-bridged channel has no web history and its send routes 404, so the
  // message area shows a read-only notice and the composer is suppressed. Any
  // value other than an explicit `false` (undefined on older payloads) counts
  // as bridged.
  const activeChannelBridged = activeChannel?.bridged !== false
  const activeChannelReadOnly = activeChannel !== null && !activeChannelBridged
  // Pins are read live from Discord, so read-only (unbridged) channels have
  // them too.
  const pinsAvailable = activeChannel !== null && !activeForum
  const forwardChannels = channels.filter((c) => c.bridged !== false)
  // Discord never shows your own "is typing…" indicator - filter the caller
  // (perms.ownerKey) out of the typer list, keyed by authorKey.
  const typingNames = useMemo(
    () => typing.filter((t) => t.expires > Date.now() && t.authorKey !== perms?.ownerKey).map((t) => t.authorName),
    [typing, perms?.ownerKey],
  )
  const activeGuild = useMemo(() => guilds.find((g) => g.id === activeGuildId) || null, [guilds, activeGuildId])
  // Keep the module-level mention-chip icon index in sync (render-time, so
  // message rows rendered in this pass already see it): every cached guild,
  // each with its own rules channel.
  useMemo(() => {
    channelIconKinds.clear()
    for (const [guildId, entry] of Object.entries(channelsByGuild)) {
      const rulesChannelId = guilds.find((g) => g.id === guildId)?.rulesChannelId
      for (const c of entry.channels) channelIconKinds.set(c.channelId, channelIconKind(c.type, c.channelId === rulesChannelId))
    }
  }, [channelsByGuild, guilds])
  const activeGuildName = activeGuild?.name || 'Server'
  const activeGuildIcon = activeGuild?.icon || null
  // A guild's invite link: its vanity invite, else the home guild's.
  const inviteUrlFor = useCallback((guildId: string | null | undefined) => (
    (guildId ? guilds.find((g) => g.id === guildId)?.inviteUrl : null) || FALLBACK_INVITE_URL
  ), [guilds])
  const activeInviteUrl = inviteUrlFor(activeGuildId)

  // Guild-rail unread/mention state. The bridge has one guild, so every bridged
  // channel rolls up to it: the guild is "unread" when any channel has messages
  // newer than its read marker (drives the white .unread pill), and its red
  // mention badge sums the per-channel unread-mention counts.
  //
  // Notification levels / mutes (Discord semantics):
  // - a muted channel ('muted') renders dimmed, never shows the unread pill or
  //   bold unread state, and doesn't count toward the server's unread pill -
  //   but its @mention badge still shows;
  // - 'nothing' suppresses the @mention badge (and its rail contribution);
  // - 'all' / 'mentions' keep the default unread + mention indicators (the
  //   bridge has no notification sound/desktop notifications to gate);
  // - a muted server drops its rail unread pill; mentions still badge.
  // Derived views over the notification store: per channel, 'muted' when the
  // channel or its category is muted, else its resolved level (channel →
  // category → server default); per guild, whether the server is muted.
  const notifGuildId = activeGuild?.id || 'community'
  mentionSuppressRef.current = { everyone: notif.suppressEveryone(notifGuildId), roles: notif.suppressRoles(notifGuildId) }
  // Every cached channel, resolved against its OWN guild's defaults (the rail
  // badges cover every guild).
  const notifLevels = useMemo(() => {
    const out: Record<string, NotifLevel> = {}
    for (const [guildId, entry] of Object.entries(channelsByGuild)) {
      for (const c of entry.channels) {
        out[c.channelId] = notif.isChannelMuted(c.channelId) || (c.parentId ? notif.isChannelMuted(c.parentId) : false)
          ? 'muted'
          : notif.effectiveLevel(c.channelId, c.parentId, guildId)
      }
    }
    return out
  }, [channelsByGuild, notif])
  const mutedGuilds = useMemo(() => {
    const out: Record<string, boolean> = { community: notif.isGuildMuted('community') }
    for (const g of guilds) out[g.id] = notif.isGuildMuted(g.id)
    return out
  }, [guilds, notif])
  const channelMuted = useCallback((channelId: string) => (notifLevels[channelId] || 'all') === 'muted', [notifLevels])
  const channelMentionCount = useCallback(
    (channelId: string) => ((notifLevels[channelId] || 'all') === 'nothing' ? 0 : (unreadMentions[channelId] || 0)),
    [notifLevels, unreadMentions],
  )
  // Rail badges per guild, from that guild's cached channels: unread (white
  // pill) unless the server is muted - muted channels never count; mentions
  // (red badge) sum every channel's unread mentions except 'Nothing' ones.
  const guildBadges = useMemo(() => {
    const out: Record<string, GuildBadge> = {}
    for (const g of guilds) {
      const entry = channelsByGuild[g.id]
      const guildMuted = Boolean(mutedGuilds[g.id])
      let unread = false
      let mentions = 0
      for (const c of entry?.channels ?? []) {
        const level = notifLevels[c.channelId] || 'all'
        if (!unread && !guildMuted && level !== 'muted' && (latestByChannel[c.channelId] || 0) > (lastRead[c.channelId] || 0)) unread = true
        if (level !== 'nothing') mentions += unreadMentions[c.channelId] || 0
      }
      out[g.id] = { unread, mentions }
    }
    return out
  }, [guilds, channelsByGuild, mutedGuilds, notifLevels, latestByChannel, lastRead, unreadMentions])
  // Hide Muted Channels: muted channels drop out of the sidebar, except the
  // open channel and any with unread mentions (Discord keeps those visible).
  const visibleChannels = useMemo(
    () => (hideMutedChannels
      ? channels.filter((c) => !channelMuted(c.channelId) || c.channelId === activeChannelId || channelMentionCount(c.channelId) > 0)
      : channels),
    [hideMutedChannels, channels, channelMuted, activeChannelId, channelMentionCount],
  )
  // Sidebar groups in the server's order (buildSidebar is the single source of
  // truth: bridged groups first, then the rest, each in Discord order). The
  // server sends channels contiguous per group, so groups are built in order
  // of first appearance - no client-side re-sort. Groups left empty by Hide
  // Muted Channels drop out, header included.
  const sidebarGroups = useMemo(() => {
    const byId = new Map(categories.map((c) => [c.id, c]))
    const groups: Array<{ category: BridgeCategory | null; channels: BridgeChannel[] }> = []
    const groupOf = new Map<string, (typeof groups)[number]>()
    for (const channel of visibleChannels) {
      const category = (channel.parentId && byId.get(channel.parentId)) || null
      const key = category?.id || ''
      let group = groupOf.get(key)
      if (!group) {
        group = { category, channels: [] }
        groupOf.set(key, group)
        groups.push(group)
      }
      group.channels.push(channel)
    }
    return groups
  }, [categories, visibleChannels])

  // Lockdown: channel flagged locked (from the channel list or the perms call),
  // and the caller is staff (mod+) who can bypass the lock.
  const channelLocked = Boolean(activeChannel?.locked || perms?.locked)
  const isStaff = Boolean(perms?.canTimeout || perms?.canManageWebhook)

  const rows: Array<{ kind: 'day'; key: string; label: string } | { kind: 'msg'; key: string; message: BridgeMessage; grouped: boolean } | { kind: 'unread'; key: string }> = []
  let lastDay = ''
  let prev: BridgeMessage | undefined
  // The NEW divider is only live for the channel it was pinned in and only
  // while that pinned message is still in the loaded window (older-message
  // paging never un-pins it; a delete of the pinned message drops it).
  const dividerActive = unreadDivider !== null
    && unreadDivider.channelId === activeChannelId
    && messages.some((m) => m.id === unreadDivider.beforeId && !m.deletedAt)
  let dividerPlaced = false
  for (const message of messages) {
    if (message.deletedAt) continue
    const day = formatDay(message.createdAt)
    if (day !== lastDay) {
      rows.push({ kind: 'day', key: `day-${day}-${message.id}`, label: day })
      lastDay = day
      prev = undefined
    }
    // Insert the unread "NEW" divider ABOVE the first unread message (the
    // pinned beforeId) - after any day divider for that message's day, like
    // Discord (the day line stays above, the red NEW line hugs the message).
    // The message under the divider is a group start (avatar + header), and
    // following messages group relative to it.
    if (dividerActive && !dividerPlaced && message.id >= unreadDivider.beforeId) {
      rows.push({ kind: 'unread', key: `unread-${unreadDivider.beforeId}` })
      dividerPlaced = true
      prev = undefined
    }
    rows.push({ kind: 'msg', key: `m-${message.id}`, message, grouped: sameGroup(prev, message) })
    prev = message
  }

  const timedOut = timeoutRemaining !== null && timeoutRemaining > 0
  const cannotSend = perms !== null && !perms.canSend
  // The composer stays enabled and welcoming ("Message #general") unless a real
  // permission/timeout block applies; signing-in is prompted on Enter instead.
  // A non-bridged (read-only) channel is always disabled - there's nothing to
  // send to (its /send route 404s).
  const composerDisabled = activeChannelReadOnly || postPending
    || (user !== null && (perms?.emailVerified === false || !activeChannelId || timedOut || cannotSend))

  const formatCountdown = (totalSeconds: number): string => {
    const d = Math.floor(totalSeconds / 86400)
    const h = Math.floor((totalSeconds % 86400) / 3600)
    const m = Math.floor((totalSeconds % 3600) / 60)
    const s = totalSeconds % 60
    if (d > 0) return `${d}d ${h}h`
    if (h > 0) return `${h}h ${m}m`
    if (m > 0) return `${m}m ${s}s`
    return `${s}s`
  }

  // Unverified email: the composer is locked for the account, but the reason is
  // the email, not the channel. Say so, and only where the channel would
  // otherwise allow sending (perms.canSend ignores the email gate server-side).
  const verifyBlocksSending = !activeChannelReadOnly && !timedOut && perms?.sendBlockedByEmail === true
  const inputPlaceholder = activeChannelReadOnly
    ? 'You do not have permission to send messages in this channel.'
    : timedOut
      ? `You are timed out. Try again in ${formatCountdown(timeoutRemaining!)}.`
      : verifyBlocksSending
        ? 'You must verify your email before you can send messages in this server.'
        : user && cannotSend
          ? 'You do not have permission to send messages in this channel.'
          : activePost
            ? `Message "${activePost.name}"`
            : `Message #${activeChannel?.name || 'chat'}`

  // Guild tooltip: Discord's guild-rail tooltip opens immediately on hover (no
  // show delay - only the bubble's own enter animation), positioned off the rail.
  const onGuildEnter = useCallback((guildId: string, e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const page = document.querySelector('.chat-page')?.getBoundingClientRect()
    const anchorY = rect.top + rect.height / 2 - (page?.top || 0)
    clearTimeout(guildTipTimer.current)
    setGuildTip({ guildId, anchorY })
  }, [])
  const onGuildLeave = useCallback(() => {
    clearTimeout(guildTipTimer.current)
    setGuildTip(null)
  }, [])
  const onGuildContext = useCallback((guildId: string, e: React.MouseEvent) => {
    e.preventDefault()
    setGuildTip(null)
    setElemMenu(null)
    const page = document.querySelector('.chat-page')?.getBoundingClientRect()
    setGuildMenu({ guildId, x: e.clientX - (page?.left || 0), y: e.clientY - (page?.top || 0) })
  }, [])

  // Server-header left-click: live Discord opens the server-actions menu
  // ANCHORED beneath the header (flush to the header's bottom-left, not the
  // cursor), and the header chevron swaps to an ✕ while the menu is open.
  // Toggles on CLICK (a press that starts on the header and drags off does
  // nothing, like Discord). The open menu closes itself on any outside
  // mousedown - including one on the header - so the mousedown records
  // whether the menu was open, and the click that follows only re-opens it
  // when it wasn't: a click on the header while open just closes it.
  const guildHeaderDownOpen = useRef(false)
  const onGuildHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    guildHeaderDownOpen.current = guildMenu !== null
  }, [guildMenu])
  const toggleGuildHeaderMenu = useCallback((guildId: string, wasOpen: boolean) => {
    setGuildTip(null)
    const header = guildHeaderRef.current
    if (!header) return
    if (wasOpen) { setGuildMenu(null); return }
    // Anchored to the server header (GUILD_HEADER_MENU_ANCHOR below); x/y
    // are unused while anchored.
    setGuildMenu({ guildId, x: 0, y: 0, anchored: true })
  }, [])

  // Guild banner (Discord's container_f37cb1 hasBanner/bannerVisible): the
  // banner (--custom-guild-banner-height 130px) sits under the 49px server
  // header and scrolls away with the channel list; the header's glass layer
  // fades in as it scrolls under it, and once the banner's bottom passes the
  // header the bannerVisible state drops and the header reverts to its plain
  // no-banner look. Continuous values go straight to CSS vars on .bar (no
  // re-render per scroll frame); only the visible flag is React state.
  const guildBanner = activeGuild?.banner || null
  const [bannerVisible, setBannerVisible] = useState(true)
  const barRef = useRef<HTMLElement>(null)
  const onBarScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const bar = barRef.current
    if (!bar || !bar.classList.contains('d-barHasBanner')) return
    const y = Math.max(0, e.currentTarget.scrollTop)
    const reveal = GUILD_BANNER_HEIGHT - GUILD_HEADER_HEIGHT
    bar.style.setProperty('--chat-banner-scroll', `${Math.min(y, GUILD_BANNER_HEIGHT)}px`)
    bar.style.setProperty('--chat-banner-glass', String(Math.min(1, y / reveal)))
    setBannerVisible(y < reveal)
  }, [])

  // === Guild switching (rail click, deep links, cross-guild jumps) ===
  // Discord's guild select: every open menu / popout / panel closes, the
  // outgoing guild's channel is remembered (the effect after the channel
  // loader), and the new guild opens on its landing channel - or `target`'s
  // channel - straight from the cache, refreshed in the background when old
  // or stale. The banner state and the sidebar scroll reset. Clicking the
  // already-open guild just scrolls its channel list to the top.
  const selectGuild = useCallback((guildId: string, target?: { channelId?: string | null }) => {
    if (!guildsRef.current.some((g) => g.id === guildId)) return
    const scroller = barRef.current?.querySelector('.bar-scroller') ?? null
    if (guildId === activeGuildIdRef.current) {
      if (target?.channelId) { setCrSection(null); setActiveChannelId(target.channelId) }
      else scroller?.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    // Close everything that belongs to the outgoing guild's UI.
    clearTimeout(guildTipTimer.current)
    setGuildTip(null)
    setGuildMenu(null)
    setElemMenu(null)
    setMsgMenu(null)
    setProfile(null)
    setRolePopout(null)
    setReactorsPopout(null)
    setQuickReactTip(null)
    setPinsOpen(false)
    setInboxOpen(false)
    setNotifOpen(false)
    setHelpOpen(false)
    setStatusOpen(false)
    setSearchOpen(false)
    search.clear()
    setEmojiMenuOpen(false)
    setReactTarget(null)
    setReactAnchor(null)
    setEditPickerAnchor(null)
    setForwardTarget(null)
    setForwardedTo([])
    setDeleteTarget(null)
    setModModal(null)
    setGuildNotifModal(null)
    setCrSection(null)
    // Banner + sidebar scroll start fresh for the new guild.
    setBannerVisible(true)
    barRef.current?.style.removeProperty('--chat-banner-scroll')
    barRef.current?.style.removeProperty('--chat-banner-glass')
    scroller?.scrollTo({ top: 0 })
    setActiveGuildId(guildId)
    const entry = channelsByGuildRef.current[guildId]
    if (!entry || entry.stale || Date.now() - entry.fetchedAt > GUILD_CHANNELS_MAX_AGE_MS) loadGuildChannels(guildId)
    // Nothing cached yet → null; the landing-channel effect picks once the
    // sidebar arrives.
    setActiveChannelId(target?.channelId ?? (entry ? defaultChannelFor(guildId, entry.channels) : null))
  }, [search.clear, setActiveGuildId, loadGuildChannels])
  selectGuildRef.current = selectGuild

  // Mark As Read for whole guilds (server menu, the rail's Mark Folder As
  // Read): every cached channel of each guild, like the channel Mark As Read.
  const markGuildsRead = useCallback((guildIds: string[]) => {
    const open = activeChannelRef.current
    for (const guildId of guildIds) {
      for (const c of channelsByGuildRef.current[guildId]?.channels ?? []) {
        const loaded = c.channelId === open ? messagesRef.current.reduce((max, m) => Math.max(max, m.id), 0) : 0
        const latest = Math.max(latestByChannelRef.current[c.channelId] || 0, loaded)
        if (latest) markRead(c.channelId, latest)
        if (c.channelId === open) {
          setUnreadDivider(null)
          setNewSinceScrollUp((current) => (current.count ? { count: 0, since: null } : current))
        }
      }
    }
  }, [markRead])

  /* === Shared mute / notification menu items (Discord 995102 / 288104 /
     guild-context) ===
     Mute: "Mute <X> ›" - clicking the row mutes indefinitely; its submenu
     offers Discord's durations (For 15 Minutes … Until I turn it back on).
     While muted the row reads "Unmute <X>" with a "Muted until …" subtext for
     timed mutes. Notification Settings ›: radio overrides (Use Category /
     Server Default, All Messages, Only @mentions, Nothing) with the resolved
     level as subtext; the server variant adds the suppress checkboxes. */
  const onlyMentionsLabel = <>Only <strong>@mentions</strong></>
  const levelLabel = (level: BaseNotifLevel) => (level === 'mentions' ? onlyMentionsLabel : NOTIF_LEVEL_LABELS[level])
  const muteMenuItem = useCallback((kind: 'channel' | 'category' | 'guild', id: string): MenuEntry => {
    const noun = kind === 'guild' ? 'Server' : kind === 'category' ? 'Category' : 'Channel'
    const config = kind === 'guild' ? notif.guildMute(id) : notif.channelMute(id)
    const mute = (seconds: number) => (kind === 'guild' ? notif.muteGuild(id, seconds) : notif.muteChannel(id, seconds))
    if (config) {
      return { key: 'unmute', label: `Unmute ${noun}`, subtext: mutedUntilText(config) ?? undefined, onSelect: () => (kind === 'guild' ? notif.unmuteGuild(id) : notif.unmuteChannel(id)) }
    }
    return {
      key: 'mute',
      label: `Mute ${noun}`,
      onSelect: () => mute(-1),
      submenu: MUTE_DURATIONS.map((d) => ({ key: `mute-${d.seconds}`, label: d.label, onSelect: () => mute(d.seconds) })),
    }
  }, [notif])
  const channelNotifMenuItem = useCallback((id: string, parentId: string | null | undefined, isCategory = false): MenuEntry => {
    const override = notif.channelLevel(id)
    // The channel's own guild (categories aren't indexed: the open guild).
    const guildId = channelGuild.get(id) ?? notifGuildId
    const inherited = isCategory || !parentId ? notif.guildLevel(guildId) : notif.effectiveLevel(parentId, null, guildId)
    const resolved = override || inherited
    const group = `notif-${id}`
    return {
      key: 'notifications',
      label: 'Notification Settings',
      subtext: levelLabel(resolved),
      submenu: [
        { key: 'notif-default', label: !isCategory && parentId ? 'Use Category Default' : 'Use Server Default', subtext: levelLabel(inherited), affordance: 'radio', group, checked: !override, onSelect: () => notif.setChannelLevel(id, null) },
        ...(['all', 'mentions', 'nothing'] as BaseNotifLevel[]).map((level) => ({
          key: `notif-${level}`, label: levelLabel(level), affordance: 'radio' as const, group, checked: override === level, onSelect: () => notif.setChannelLevel(id, level),
        })),
      ],
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notif, notifGuildId, channelGuild])
  const guildNotifMenuItem = useCallback((guildId: string): MenuEntry => {
    const level = notif.guildLevel(guildId)
    return {
      key: 'notifications',
      label: 'Notification Settings',
      subtext: levelLabel(level),
      // Discord: clicking the row opens the Notification Settings modal; the
      // submenu holds the quick settings.
      onSelect: () => setGuildNotifModal(guildId),
      submenu: [
        ...(['all', 'mentions', 'nothing'] as BaseNotifLevel[]).map((l) => ({
          key: `gnotif-${l}`, label: levelLabel(l), affordance: 'radio' as const, group: 'guild-notifications', checked: level === l, onSelect: () => notif.setGuildLevel(guildId, l),
        })),
        'separator' as const,
        { key: 'suppress-everyone', label: <>Suppress <strong>@everyone</strong> and <strong>@here</strong></>, affordance: 'check' as const, checked: notif.suppressEveryone(guildId), onSelect: () => notif.toggleSuppressEveryone(guildId) },
        { key: 'suppress-roles', label: 'Suppress All Role @mentions', affordance: 'check' as const, checked: notif.suppressRoles(guildId), onSelect: () => notif.toggleSuppressRoles(guildId) },
      ],
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notif])
  // Discord disables Mark As Read when nothing in scope is unread.
  const hasUnread = useCallback((channelIds: string[]) => channelIds.some((id) => (latestByChannel[id] || 0) > (lastRead[id] || 0)), [latestByChannel, lastRead])

  const guildMenuEntries = useCallback((guildId: string): MenuEntry[] => {
    const guild = guilds.find((g) => g.id === guildId)
    // The TARGET guild's cached channels (not the open guild's).
    const guildChannelIds = (channelsByGuild[guildId]?.channels ?? []).map((c) => c.channelId)
    // Discord's guild-context menu (a5bca68…): [Mark As Read] [Invite to
    // Server] [Mute Server ›, Notification Settings ›, Hide Muted Channels ☐]
    // … [Copy Server ID]. Only the developer-mode ID item carries an icon;
    // Invite to Server only gets one in the server-header dropdown. Server
    // Settings / Privacy / Leave are omitted (no bridge equivalent).
    return [
      { key: 'read', label: 'Mark As Read', disabled: !hasUnread(guildChannelIds), onSelect: () => markGuildsRead([guildId]) },
      'separator',
      { key: 'invite', label: 'Invite to Server', onSelect: () => window.open(inviteUrlFor(guildId), '_blank', 'noreferrer') },
      'separator',
      muteMenuItem('guild', guildId),
      guildNotifMenuItem(guildId),
      // Hide Muted Channels: muted channels drop out of the sidebar except the
      // open one and any with unread mentions (see visibleChannels).
      { key: 'hide-muted', label: 'Hide Muted Channels', affordance: 'check', checked: isHideMuted(guildId), onSelect: () => toggleHideMuted(guildId) },
      // Show All Channels (36942 `opt-in`): Server Onboarding's opt-in view
      // (loaded for the open guild only).
      ...(channelsRoles.data && guildId === activeGuildId ? [channelsRoles.showAllMenuItem()] : []),
      ...(guild && developerMode ? ['separator' as const, { key: 'copy-id', label: 'Copy Server ID', icon: <MenuCopyIcon />, onSelect: () => { void navigator.clipboard?.writeText(guild.id).catch(() => {}) } }] : []),
    ]
  }, [guilds, channelsByGuild, activeGuildId, markGuildsRead, inviteUrlFor, hasUnread, muteMenuItem, guildNotifMenuItem, isHideMuted, toggleHideMuted, channelsRoles, developerMode])

  // Server-header dropdown (left-click) - Discord's guild-header-popout, a
  // different menu from the guild context menu: [Invite to Server (person-add
  // icon)] [Notification Settings (bell icon)] [Hide Muted Channels ☐].
  // Server Boost / Settings / Create Channel / Privacy / Leave have no bridge
  // equivalent and are omitted; Notification Settings opens the modal.
  const guildHeaderMenuEntries = useCallback((guildId: string): MenuEntry[] => {
    return [
      { key: 'invite', label: 'Invite to Server', icon: <InviteIcon size={20} />, onSelect: () => window.open(inviteUrlFor(guildId), '_blank', 'noreferrer') },
      'separator',
      { key: 'notifications', label: 'Notification Settings', icon: <BellIcon size={20} />, onSelect: () => setGuildNotifModal(guildId) },
      'separator',
      { key: 'hide-muted', label: 'Hide Muted Channels', affordance: 'check', checked: isHideMuted(guildId), onSelect: () => toggleHideMuted(guildId) },
      ...(channelsRoles.data && guildId === activeGuildId ? [channelsRoles.showAllMenuItem()] : []),
    ]
  }, [inviteUrlFor, isHideMuted, toggleHideMuted, channelsRoles, activeGuildId])

  /* === Message action menu (Discord's "More" ⋯ + right-click context menu) ===
     One menu, two entry points: right-click on the message row anchors at the
     cursor; the hover toolbar's More button anchors at the button. Both land in
     `msgMenu`, positioned in .chat-page coordinates like the guild menu. */

  // Open the message menu anchored to a cursor position (right-click).
  const openMsgMenuAt = useCallback((message: BridgeMessage, clientX: number, clientY: number) => {
    const page = document.querySelector('.chat-page')?.getBoundingClientRect()
    setMsgMenu({ message, x: clientX - (page?.left || 0), y: clientY - (page?.top || 0) })
  }, [])

  // Right-click on a message row → context menu at the cursor. The profile
  // popout's own card stopPropagations, so this never fires over the popout.
  const onMsgContext = useCallback((message: BridgeMessage, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setProfile(null)
    setElemMenu(null)
    openMsgMenuAt(message, e.clientX, e.clientY)
  }, [openMsgMenuAt])

  /* === Element context menus (Discord shows one on nearly every surface) ===
     One `elemMenu` slot serves every non-message-row element; each opener
     builds its entries at open time and anchors at the cursor in .chat-page
     coordinates (same scheme as the message menu). */

  const openElemMenu = useCallback((entries: MenuEntry[], ariaLabel: string, clientX: number, clientY: number, keepProfile = false) => {
    const page = document.querySelector('.chat-page')?.getBoundingClientRect()
    setMsgMenu(null)
    setGuildMenu(null)
    // A right-click inside the profile popout layers the menu over it
    // (Discord keeps the popout open underneath).
    if (!keepProfile) setProfile(null)
    setStatusOpen(false)
    setElemMenu({ entries, x: clientX - (page?.left || 0), y: clientY - (page?.top || 0), ariaLabel })
  }, [])

  const copyText = useCallback((text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {})
  }, [])

  // Copy Link target: #/chat?guild=…&channel=…(&message=…). `guild` is the
  // channel's guild (from the sidebar caches) so the link opens the right
  // server; App.tsx parses it.
  const chatLinkFor = useCallback((channelId: string, messageId?: number) => {
    const guildId = channelGuildRef.current.get(channelId)
    const guildPart = guildId ? `guild=${encodeURIComponent(guildId)}&` : ''
    return `${window.location.origin}${window.location.pathname}#/chat?${guildPart}channel=${encodeURIComponent(channelId)}${messageId ? `&message=${messageId}` : ''}`
  }, [])

  // Discord's Mention action on a user. With a Discord id it inserts a real
  // <@id> mention chip at the end of the composer (same chip the @-autocomplete
  // makes); webhook (web) authors have no id, so they get plain "@name ".
  // Appends - assigning textContent would wipe existing emoji/mention chips.
  const mentionUser = useCallback((name: string, discordId?: string | null) => {
    const el = inputRef.current
    if (el && discordId) {
      const end = serializeComposer(el).length
      insertMentionChip(el, end, end, { token: `<@${discordId}>`, label: `@${name}` })
      setComposerLength(serializeComposer(el).length)
      return
    }
    if (el) {
      el.append(document.createTextNode(`@${name} `))
      el.focus()
      // Park the caret at the end so typing continues after the insert.
      const sel = window.getSelection()
      if (sel) {
        const range = document.createRange()
        range.selectNodeContents(el)
        range.collapse(false)
        sel.removeAllRanges()
        sel.addRange(range)
      }
      setComposerLength(serializeComposer(el).length)
    }
  }, [])

  // Channel row (sidebar) - Discord's channel context menu: Mark As Read,
  // Invite People, Copy Link, Mute Channel, Notification Settings,
  // Edit Channel, Copy Channel ID. The bridge has no invite/edit surface;
  // the implemented set is Mark As Read / Mute Channel / Copy Link / Copy ID.
  const onChannelContext = useCallback((channel: BridgeChannel, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const channelLink = chatLinkFor(channel.channelId)
    // Discord's text-channel menu (50c638…): [Mark As Read] [… Copy Link]
    // [Mute Channel ›, Notification Settings ›] … [Copy Channel ID]. Only the
    // developer-mode Copy … ID item carries an icon (the ID glyph).
    openElemMenu([
      { key: 'read', label: 'Mark As Read', disabled: !hasUnread([channel.channelId]), onSelect: () => { if (latestByChannel[channel.channelId]) markRead(channel.channelId, latestByChannel[channel.channelId]) } },
      'separator',
      { key: 'copy-link', label: 'Copy Link', onSelect: () => copyText(channelLink) },
      'separator',
      muteMenuItem('channel', channel.channelId),
      channelNotifMenuItem(channel.channelId, channel.parentId),
      ...(developerMode ? ['separator' as const, { key: 'copy-id', label: 'Copy Channel ID', icon: <MenuCopyIcon />, onSelect: () => copyText(channel.channelId) }] : []),
    ], 'Channel Actions', e.clientX, e.clientY)
  }, [openElemMenu, hasUnread, latestByChannel, markRead, muteMenuItem, channelNotifMenuItem, copyText, developerMode, chatLinkFor])

  // Channel header (# channel-name area) - same target as the sidebar row:
  // Mark As Read + copy affordances.
  const onChannelHeaderContext = useCallback((e: React.MouseEvent) => {
    if (!activeChannel) return
    e.preventDefault()
    if (activePost) {
      // A forum post: Discord's thread context menu (post-moderate actions
      // for staff and the post's owner).
      const entries = postMenuEntries(activePost, {
        canManage: Boolean(perms?.canManagePosts),
        isOwner: postSelfKeys.includes(activePost.ownerKey),
        developerMode,
        onAction: (action) => runPostAction(activePost, action),
        onEdit: (kind) => setPostModal({ kind, post: activePost }),
        onCopyId: () => copyText(activePost.id),
      })
      if (entries.length) openElemMenu(entries, 'Post Actions', e.clientX, e.clientY)
      return
    }
    const channelLink = chatLinkFor(activeChannel.channelId)
    // Discord's channel-title menu (995269…, CHANNEL_TITLE_MENU) has no Mark
    // As Read: [Mute Channel ›] [Notification Settings ›] [Copy Link]
    // [Copy Channel ID (ID icon)].
    openElemMenu([
      muteMenuItem('channel', activeChannel.channelId),
      'separator',
      channelNotifMenuItem(activeChannel.channelId, activeChannel.parentId),
      'separator',
      { key: 'copy-link', label: 'Copy Link', onSelect: () => copyText(channelLink) },
      ...(developerMode ? ['separator' as const, { key: 'copy-id', label: 'Copy Channel ID', icon: <MenuCopyIcon />, onSelect: () => copyText(activeChannel.channelId) }] : []),
    ], 'Channel Actions', e.clientX, e.clientY)
  }, [activeChannel, activePost, perms, postSelfKeys, runPostAction, openElemMenu, copyText, muteMenuItem, channelNotifMenuItem, developerMode, chatLinkFor])

  // === Webhook moderation (user menus + profile popout) ===
  // Moderation applies to WEBHOOK identities: web authors ('user:<siteId>',
  // linked to Discord or not) and Discord authors ('discord:<id>') get the
  // same entries. Which entries show comes from the server's per-target view
  // (`target` route: bits + Discord role hierarchy + not-self, with the
  // caller's own timeout/ban applied), cached ~20s per channel+target and
  // dropped on moderation/perms events for that target.
  const isModerator = Boolean(perms?.canTimeout || perms?.canBan || perms?.canManageWebhook)
  const loadModTarget = useCallback(async (channelId: string, key: string): Promise<BridgeModTarget | null> => {
    const cacheKey = `${channelId}|${key}`
    const hit = modTargetCache.current.get(cacheKey)
    if (hit && Date.now() - hit.at < 20_000) return hit.value
    const value = await Promise.race([
      bridgeModTarget(channelId, key).catch(() => null),
      new Promise<null>((resolve) => { setTimeout(() => resolve(null), 2500) }),
    ])
    if (value) {
      modTargetCache.current.set(cacheKey, { at: Date.now(), value })
      if (modTargetCache.current.size > 200) modTargetCache.current.delete(modTargetCache.current.keys().next().value as string)
    }
    return value
  }, [])

  const runModeration = useCallback(async (channelId: string, key: string, action: string, extra: Record<string, unknown> = {}) => {
    await bridgeModerate(action, channelId, key, extra)
    modTargetCache.current.clear()
  }, [])

  // Discord's moderation group in the member context menu ("Timeout {user}"
  // / "Remove Timeout", "Ban {user}"), plus "Revoke Ban" (Discord's bans-list
  // action) for an already-banned webhook and a Channel Permissions submenu
  // (per-channel member overwrite: View Channel / Send Messages / Add
  // Reactions) for MANAGE_WEBHOOKS holders.
  const moderationMenuEntries = useCallback((channelId: string, name: string, key: string, mod: BridgeModTarget | null | undefined): MenuEntry[] => {
    if (!mod) return []
    const target: ModerationModalTarget = { key, name }
    const fail = (fallback: string) => (err: unknown) => setError(discordErrorMessage(err, fallback))
    const items: MenuEntry[] = []
    if (mod.timeout && mod.canUntimeout) {
      items.push({ key: 'remove-timeout', label: `Remove Timeout From ${name}`, danger: true, onSelect: () => { void runModeration(channelId, key, 'untimeout').catch(fail('Failed to remove timeout')) } })
    } else if (!mod.timeout && mod.canTimeout) {
      items.push({ key: 'timeout', label: `Timeout ${name}`, danger: true, onSelect: () => setModModal({ kind: 'timeout', target, channelId }) })
    }
    if (mod.banned && mod.canUnban) {
      items.push({ key: 'revoke-ban', label: 'Revoke Ban', onSelect: () => { void runModeration(channelId, key, 'unban').catch(fail('Failed to revoke ban')) } })
    } else if (!mod.banned && mod.canBan) {
      items.push({ key: 'ban', label: `Ban ${name}`, danger: true, onSelect: () => setModModal({ kind: 'ban', target, channelId }) })
    }
    if (mod.canManageWebhook && mod.overwrite) {
      const allow = BigInt(mod.overwrite.allow || '0')
      const deny = BigInt(mod.overwrite.deny || '0')
      const toggle = (bit: bigint) => {
        const denied = (deny & bit) !== 0n
        const nextDeny = denied ? deny & ~bit : deny | bit
        const nextAllow = allow & ~bit
        void runModeration(channelId, key, 'webhook-perm', { allow: nextAllow.toString(), deny: nextDeny.toString() })
          .catch(fail('Failed to update permissions'))
      }
      const permItem = (itemKey: string, label: string, bit: bigint): MenuEntry => ({
        key: itemKey,
        label,
        affordance: 'check',
        checked: (deny & bit) === 0n,
        keepOpen: false,
        onSelect: () => toggle(bit),
      })
      items.push({
        key: 'channel-perms',
        label: 'Channel Permissions',
        submenu: [
          permItem('perm-view', 'View Channel', ChatPermBit.VIEW_MESSAGES),
          permItem('perm-send', 'Send Messages', ChatPermBit.SEND_MESSAGES),
          permItem('perm-react', 'Add Reactions', ChatPermBit.ADD_REACTIONS),
        ],
      })
    }
    return items
  }, [runModeration, setError])

  // Discord's user context menu (Profile, Mention, Message, Call, Add Note,
  // Add Friend, Block, [moderation], Copy User ID). The bridge has no
  // DMs/friends/notes, so the implemented set is Profile / Mention /
  // moderation / Copy User ID; Copy User ID is only offered when there is a
  // real Discord snowflake. Moderation entries appear for ANY webhook author
  // (web or Discord) when `mod` (the server's per-target view) allows them.
  // Entries without `open` (the popout's own menu) omit Profile.
  const userMenuEntries = useCallback((target: { name: string; discordId: string | null; open?: () => void; authorKey?: string | null; channelId?: string | null; mod?: BridgeModTarget | null }) => {
    const entries: MenuEntry[] = []
    // Discord (793b89…, GuildChannelUserContextMenu): Profile and Mention are
    // icon-less (user-profile/mention pass no icon); Copy User ID keeps the
    // developer-mode ID glyph.
    if (target.open) entries.push({ key: 'profile', label: 'Profile', onSelect: target.open })
    entries.push({ key: 'mention', label: 'Mention', onSelect: () => mentionUser(target.name, target.discordId) })
    const modItems = target.authorKey && target.channelId ? moderationMenuEntries(target.channelId, target.name, target.authorKey, target.mod) : []
    if (modItems.length) entries.push('separator', ...modItems)
    if (target.discordId && developerMode) {
      const id = target.discordId
      entries.push('separator', { key: 'copy-id', label: 'Copy User ID', icon: <MenuCopyIcon />, onSelect: () => copyText(id) })
    }
    return entries
  }, [mentionUser, copyText, moderationMenuEntries, developerMode])

  const onAuthorContext = useCallback((message: BridgeMessage, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Capture the anchor NOW: the menu item's onSelect runs after the
    // contextmenu event has finished dispatching, when React has nulled
    // currentTarget.
    const el = e.currentTarget as Element
    const rect = el.getBoundingClientRect()
    const discordId = message.direction === 'discord' && message.authorKey?.startsWith('discord:') ? message.authorKey.slice(8) : null
    const { clientX, clientY } = e
    const show = (mod: BridgeModTarget | null) => openElemMenu(userMenuEntries({
      name: message.authorName,
      discordId,
      authorKey: message.authorKey,
      channelId: message.channelId,
      mod,
      open: () => openProfile(message, { currentTarget: el, rect }),
    }), 'User Actions', clientX, clientY)
    // Moderators: resolve the per-target moderation view first (web and
    // Discord authors alike) so the menu opens with the right entries.
    const bridged = channelsRef.current.find((c) => c.channelId === message.channelId)?.bridged !== false
    if (isModerator && bridged && /^(user|discord):/.test(message.authorKey || '')) {
      void loadModTarget(message.channelId, message.authorKey).then(show)
    } else show(null)
  }, [openElemMenu, openProfile, userMenuEntries, isModerator, loadModTarget])

  // Right-click anywhere on an open profile popout → the same user menu,
  // layered over the popout. On your own account popout it's the self menu.
  const onProfileContext = useCallback((p: ProfileData, data: { userId: string; displayName: string } | null, e: React.MouseEvent) => {
    if (p.kind === 'self') {
      openElemMenu([
        { key: 'status', label: 'Set Status', icon: <MenuStatusIcon />, onSelect: () => { setProfile(null); setStatusOpen(true) } },
        ...(data?.userId ? ['separator' as const, { key: 'copy-id', label: 'Copy User ID', icon: <MenuCopyIcon />, onSelect: () => copyText(data.userId) }] : []),
      ], 'User Actions', e.clientX, e.clientY, true)
      return
    }
    const { clientX, clientY } = e
    const authorKey = p.authorKey || (p.discordId ? `discord:${p.discordId}` : null)
    const channelId = activeChannelRef.current
    const show = (mod: BridgeModTarget | null) => openElemMenu(userMenuEntries({
      name: data?.displayName || p.authorName,
      discordId: data?.userId || p.discordId,
      authorKey,
      channelId,
      mod,
    }), 'User Actions', clientX, clientY, true)
    const bridged = Boolean(channelId) && channelsRef.current.find((c) => c.channelId === channelId)?.bridged !== false
    if (isModerator && bridged && channelId && authorKey) void loadModTarget(channelId, authorKey).then(show)
    else show(null)
  }, [openElemMenu, userMenuEntries, copyText, isModerator, loadModTarget])

  // User-panel avatar (your own) - Discord's menu leads with the status
  // picker; the bridge's status picker is the avatar's own popover.
  const onSelfAvatarContext = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Set Status › is a real submenu of the four presences (radio marks the
    // current one; picking closes like Discord's status menu). Copy User ID
    // only exists with a Discord id (a site username is not an ID).
    const discordId = user?.discord?.id
    openElemMenu([
      {
        key: 'status',
        label: 'Set Status',
        icon: <MenuStatusIcon />,
        onSelect: () => setStatusOpen(true),
        submenu: ([['online', 'Online'], ['idle', 'Idle'], ['dnd', 'Do Not Disturb'], ['invisible', 'Invisible']] as Array<[PresenceStatus, string]>).map(([value, text]) => (
          { key: `status-${value}`, label: text, affordance: 'radio' as const, group: 'presence', checked: presence === value, keepOpen: false, onSelect: () => pickStatus(value) }
        )),
      },
      ...(discordId ? ['separator' as const, { key: 'copy-id', label: 'Copy User ID', icon: <MenuCopyIcon />, onSelect: () => copyText(discordId) }] : []),
    ], 'User Actions', e.clientX, e.clientY)
  }, [openElemMenu, user, copyText, presence, pickStatus])

  // Reaction chip - Discord's reaction menu offers reacting again (toggle)
  // and removing reactions; the bridge implements the toggle (same as the
  // chip's left-click) plus Copy Emoji Name.
  const openReactors = useCallback((messageId: number, emoji: string, anchor: Element) => {
    setElemMenu(null)
    setProfile(null)
    setReactorsPopout({ messageId, emoji, anchor })
  }, [])

  // A reactor row in the reactions popout opens that user's profile popout,
  // built like the message-author popout (web key or Discord id).
  const openReactorProfile = useCallback((reactor: BridgeReactor, el: Element) => {
    const rect = el.getBoundingClientRect()
    setProfile((cur) => (cur && cur.anchorEl === el ? null : {
      kind: 'user',
      discordId: reactor.discordId,
      authorKey: reactor.key,
      authorName: reactor.name,
      authorAvatar: reactor.avatar,
      fallbackAvatar: defaultAvatar(reactor.name),
      authorColor: reactor.color,
      authorRole: null,
      direction: reactor.direction,
      anchorEl: el,
      anchorRect: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
      placement: 'right',
    }))
  }, [])

  const onReactionContext = useCallback((message: BridgeMessage, reaction: BridgeReaction, entry: EmojiEntry | undefined, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const emojiName = entry ? `:${entry[0]}:` : reaction.emoji
    const pill = e.currentTarget as Element
    openElemMenu([
      { key: 'view-reactors', label: 'View Reactions', onSelect: () => openReactors(message.id, reaction.emoji, pill) },
      'separator',
      // Hidden (not disabled) without react permission - the hover toolbar
      // and message menu hide their reaction actions the same way.
      ...(!user || canReact ? [{ key: 'react', label: <>React with {reaction.emoji}</>, disabled: !entry, onSelect: () => { if (entry) void toggleReaction(message, entry) } }] : []),
      'separator',
      { key: 'copy-name', label: 'Copy Emoji Name', onSelect: () => copyText(emojiName) },
    ], 'Reaction Actions', e.clientX, e.clientY)
  }, [openElemMenu, user, canReact, toggleReaction, copyText, openReactors])

  // Emoji inside message content - Discord shows the emoji-detail menu
  // (Add Reaction on the message, emoji info). The bridge implements
  // Add Reaction (react to the containing message with this emoji) +
  // Copy Emoji Name.
  const onContentEmojiContext = useCallback((message: BridgeMessage, emojiName: string, emojiSurrogates: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const entry = allEmoji.find((em) => em[1] === emojiSurrogates) || allEmoji.find((em) => em[0] === emojiName)
    // Prefer the catalog's canonical name (twemoji imgs carry only the glyph
    // in alt, so `emojiName` falls back to the glyph for those); custom guild
    // emoji arrive with their real :name: already.
    const canonical = entry?.[0] || emojiName
    openElemMenu([
      ...(!user || canReact ? [{ key: 'react', label: 'Add Reaction', disabled: !entry, onSelect: () => { if (entry) void toggleReaction(message, entry) } }] : []),
      'separator',
      { key: 'copy-name', label: 'Copy Emoji Name', onSelect: () => copyText(`:${canonical}:`) },
    ], 'Emoji Actions', e.clientX, e.clientY)
  }, [openElemMenu, user, canReact, toggleReaction, copyText])

  // Link inside message content - Discord's link menu: Open Link, Copy Link.
  // Discord's native link items (777933): Copy … Link then Open … Link, and
  // its image items (d473b7…): Save Image. All pass only a leadingAccessory,
  // so the default menu draws no icon.
  const mediaMenuItems = useCallback((kind: 'link' | 'image', url: string): MenuEntry[] => {
    const labels = nativeLinkLabels(url)
    const saveImage = () => {
      const a = document.createElement('a')
      a.href = url
      a.download = url.split('/').pop()?.split('?')[0] || 'image'
      a.target = '_blank'
      a.rel = 'noreferrer'
      document.body.appendChild(a)
      a.click()
      a.remove()
    }
    return [
      ...(kind === 'image' ? [{ key: 'save-image', label: 'Save Image', onSelect: saveImage }, 'separator' as const] : []),
      { key: 'copy-native-link', label: labels.copy, onSelect: () => copyText(url) },
      { key: 'open-native-link', label: labels.open, onSelect: () => window.open(url, '_blank', 'noreferrer') },
    ]
  }, [copyText])

  // A link / image outside a message (dialog previews, settings): just the
  // native items.
  const onContentLinkContext = useCallback((url: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    openElemMenu(mediaMenuItems('link', url), 'Link Actions', e.clientX, e.clientY)
  }, [openElemMenu, mediaMenuItems])

  const onImageContext = useCallback((url: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    openElemMenu(mediaMenuItems('image', url), 'Image Actions', e.clientX, e.clientY)
  }, [openElemMenu, mediaMenuItems])

  // Code block / inline code - Discord's code menu is a single Copy action.
  const onCodeContext = useCallback((code: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    openElemMenu([
      { key: 'copy', label: 'Copy', hint: COPY_SHORTCUT, onSelect: () => copyText(code) },
    ], 'Code Actions', e.clientX, e.clientY)
  }, [openElemMenu, copyText])

  // Hover-toolbar More (⋯) button → same menu, anchored to the button's
  // bottom-right corner (Discord opens it flush under the button).
  const onMoreClick = useCallback((message: BridgeMessage, e: React.MouseEvent) => {
    e.stopPropagation()
    // Anchored to the button (Popout position "bottom", align "right",
    // 4px under it); flips above it near the bottom of the viewport and
    // follows the button while open (the row keeps its toolbar via menuOpen).
    setMsgMenu({ message, x: 0, y: 0, anchor: e.currentTarget as HTMLElement })
  }, [])

  // Reply: delegates to the composer lane's startReply hook (arms the
  // composer's "Replying to <name>" strip + focuses the input).
  const onReply = startReply
  // Delete (Discord's flow): open the "Delete Message" confirmation modal. The
  // dialog's Delete button runs confirmDelete(), which POSTs the bridge delete
  // endpoint and removes the message from view optimistically. Discord skips
  // the confirm on shift-click - the context-menu agent can call
  // confirmDelete(message) directly for that parity.
  const onDelete = useCallback((message: BridgeMessage) => {
    if (!user) { setShowAuth(true); return }
    setMsgMenu(null)
    setDeleteTarget(message)
  }, [user])

  // Run the delete after confirmation: optimistic removal, then the endpoint
  // (own web messages soft-delete; staff deletes also mirror to Discord via
  // the bot). On failure the message is restored to the list and Discord's
  // error toast is shown.
  const confirmDelete = useCallback(async (message: BridgeMessage) => {
    if (deleting) return
    setDeleting(true)
    setMessages((current) => current.filter((m) => m.id !== message.id))
    try {
      await bridgeDelete(message.id)
      setDeleteTarget(null)
    } catch (err) {
      // Restore the optimistically-removed message (keep list order by id).
      setMessages((current) => {
        if (current.some((m) => m.id === message.id)) return current
        const next = [...current, message]
        next.sort((a, b) => a.id - b.id)
        return next
      })
      if (!isPermissionDenial(err)) setError(discordErrorMessage(err, 'Failed to delete message'))
      setDeleteTarget(null)
    } finally {
      setDeleting(false)
    }
  }, [deleting, setError])
  // Add Reaction: arm the expression picker in react-to-this-message mode.
  // onPickEmoji routes to toggleReaction(reactTarget, emoji) while armed.
  // Force the emoji tab so react mode never opens on a stale GIF/sticker tab.
  // Placement: hover-toolbar button → position "left", align "top" (the
  // picker opens beside the toolbar, inverting right when there's no room);
  // the reactions-row add button → Discord's Popout default "right"/"top".
  // Context-menu entry points (no button) anchor to the row's toolbar button.
  const onAddReaction = useCallback((message: BridgeMessage, trigger?: Element) => {
    if (!user) { setShowAuth(true); return }
    if (!canReact) return
    // Clicking the same Add Reaction button while its picker is open closes
    // it (Discord's popout trigger toggles). ExpressionPicker's outside-
    // mousedown ignores its anchor element so this click sees it still open.
    const live = reactStateRef.current
    if (trigger && live.open && live.targetId === message.id && live.anchorEl === trigger) {
      setEmojiMenuOpen(false)
      setReactTarget(null)
      return
    }
    setReactTarget(message)
    const toolbarBtn = trigger?.closest('.d-msgHoverBarButton')
      ?? document.querySelector(`.message[data-message-id="${message.id}"] .d-msgHoverBarButton[aria-label="Add Reaction"]`)
    const el = trigger && !trigger.closest('.d-msgHoverBarButton') ? trigger : toolbarBtn ?? document.querySelector(`.message[data-message-id="${message.id}"]`)
    setReactAnchor(el ? {
      el,
      placement: el.closest('.d-msgHoverBarButton')
        ? { position: 'left', align: 'top', spacing: 8 }
        : { position: 'right', align: 'top', spacing: 8 },
    } : null)
    setPickerTab('emoji')
    setEmojiMenuOpen(true)
  }, [user, canReact])

  // Forward (Discord's share-arrow action): open the "Forward Message" dialog -
  // a modal listing the bridged channels, each with a Send button that re-sends
  // the message's content to that channel. Wired to both the hover-toolbar
  // Forward button and the context-menu Forward item.
  const onForward = useCallback((message: BridgeMessage) => {
    if (!user) { setShowAuth(true); return }
    setMsgMenu(null)
    setForwardedTo([])
    setForwardingTo(null)
    setForwardTarget(message)
  }, [user])

  // Forward the message to one channel via /forward. The forwarded row
  // appears in the target channel via the normal realtime bridge.message path.
  const confirmForward = useCallback(async (channelId: string) => {
    const message = forwardTarget
    if (!message || forwardingTo) return
    setForwardingTo(channelId)
    try {
      // Server-side forward: the /forward endpoint snapshots the source row
      // (content/attachments/embeds), applies the destination's full send
      // gate (bridged, SEND bit, overwrites, lock, timeout), and the bot
      // delivers the "Forwarded" block through the webhook without pings.
      await bridgeForward(message.id, channelId, crypto.randomUUID())
      setForwardedTo((current) => (current.includes(channelId) ? current : [...current, channelId]))
    } catch (err) {
      if (!isPermissionDenial(err)) setError(discordErrorMessage(err, 'Failed to forward message'))
    } finally {
      setForwardingTo(null)
    }
  }, [forwardTarget, forwardingTo, setError])

  // Mark Unread (Discord's envelope action): roll the channel's read marker
  // back to just before this message so the channel shows unread from here
  // down. Local-only (the read marker lives in localStorage); the next real
  // read advances it again.
  const onMarkUnread = useCallback((message: BridgeMessage) => {
    setLastRead((current) => {
      const next = { ...current, [message.channelId]: Math.max(0, message.id - 1) }
      try { localStorage.setItem('abulxt:chat-read', JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
    setUnreadDivider({ channelId: message.channelId, beforeId: message.id })
  }, [])

  // Which message actions the caller may take - ONE gate shared by the hover
  // toolbar and the message context menu, mirroring the server's write gates
  // (discord-chat-perms writeDenialCore) so neither surface ever offers an
  // action the other hides or the server would refuse. Discord never shows
  // an action you can't take. While perms are still loading (null) the
  // composing actions stay visible; signed-out guests keep React/Reply/
  // Forward so the click can prompt sign-in.
  //   react   ADD_REACTIONS (perms.canReact: timeout/ban/overwrite-reduced),
  //           never in a read-only (unbridged) channel
  //   reply   SEND_MESSAGES (perms.canSend: timeout/ban/lock/overwrites)
  //   forward bridged source, not banned / timed out (the destination gate
  //           runs per target channel in the Forward dialog)
  //   edit    own web message + the send gate (canEditMessage)
  //   delete  own web message (not banned - a timed-out author may still
  //           delete, like Discord), or Manage Messages (MANAGE/BAN bits,
  //           already timeout/ban-reduced by /perms)
  //   pin     Manage Messages, delivered to Discord, not deleted
  const messageActions = useCallback((message: BridgeMessage) => {
    const bridged = channelsRef.current.find((c) => c.channelId === message.channelId)?.bridged !== false
    const pending = message.id < 0 || Boolean(message.deletedAt)
    const sendGate = perms === null ? true : perms.canSend
    const muted = Boolean(perms?.timeout || perms?.banned)
    const own = message.direction === 'web' && perms?.ownerKey !== undefined && message.authorKey === perms?.ownerKey
    const manageMessages = Boolean(perms?.canManageWebhook || perms?.canBan)
    return {
      react: bridged && !pending && (!user || canReact),
      reply: bridged && !pending && (!user || sendGate),
      forward: bridged && !pending && (!user || !muted),
      edit: canEditMessage(message),
      delete: Boolean(user) && bridged && !pending && ((own && !perms?.banned) || manageMessages),
      pin: canPin && bridged && Boolean(message.discordMessageId) && !message.deletedAt,
    }
  }, [user, perms, canReact, canEditMessage, canPin])

  const msgMenuEntries = useCallback((message: BridgeMessage): MenuEntry[] => {
    const copy = (text: string) => { void navigator.clipboard?.writeText(text).catch(() => {}) }
    // A SEND_FAILED message: Discord's menu drops every item gated on a sent
    // message (reactions, edit, reply, forward, pin, mark unread, link, ids)
    // and adds "Resend message" (RefreshIcon); "Delete Message" deletes it
    // locally without the confirm.
    if (message.sendState === 'failed') {
      return [
        { key: 'resend', label: 'Resend message', icon: <MenuResendIcon />, onSelect: () => resendFailed(message) },
        'separator',
        ...(message.content ? [{ key: 'copy-text', label: 'Copy Text', icon: <MenuCopyTextIcon />, onSelect: () => copy(message.content) }] : []),
        'separator',
        { key: 'delete', label: 'Delete Message', icon: <MenuTrashIcon />, danger: true as const, onSelect: () => deleteFailed(message) },
      ]
    }
    const can = messageActions(message)
    const link = chatLinkFor(message.channelId, message.id)
    const pinned = pinnedIds?.channelId === message.channelId && pinnedIds.ids.includes(message.id)
    // Discord's message menu (83256a…, navId "message"), groups in order:
    //   [Add Reaction ›] [Edit Message, Reply, Forward] [Copy Text, Pin
    //   Message, Mark Unread, Copy Message Link] [Delete Message] [Copy
    //   Message ID]. Every item but Add Reaction passes an `icon` (drawn at
    //   the right); Add Reaction only has a leadingAccessory → no icon.
    return [
      // Add Reaction ›: click opens the full picker (its action); hovering /
      // ArrowRight opens the submenu of frequent emoji (`:name:` rows with the
      // emoji as the icon; Shift-click keeps the menu open to add several)
      // then "View More" (smiley icon; the full picker). Hidden entirely
      // (submenu included) when the caller can't react - the same gate that
      // hides the hover toolbar's reaction buttons.
      ...(can.react ? [{
        key: 'react',
        label: 'Add Reaction',
        onSelect: () => onAddReaction(message),
        submenu: [
          // Discord: getEmojiInPriorityOrder (favorites + frecent reactions)
          // .slice(0, 12), each rendered in the user's diversity tone.
          ...frecentEmoji(12).map((base) => applyTone(base, getEmojiTone())).map((entry) => ({
            key: `react-${entry[0]}`,
            label: `:${entry[0]}:`,
            icon: <Emoji entry={entry} size={18} />,
            keepOpenOnShift: true,
            onSelect: () => { void toggleReaction(message, entry) },
          })),
          'separator' as const,
          { key: 'react-more', label: 'View More', icon: <MenuReactionIcon />, onSelect: () => onAddReaction(message) },
        ],
      }] : []),
      'separator',
      // Edit Message: own web messages only, same startEdit flow as the hover
      // toolbar's Edit button (Discord shows it only on your own messages).
      ...(can.edit
        ? [{ key: 'edit', label: 'Edit Message', icon: <ToolbarEditIcon size={18} />, onSelect: () => startEdit(message) }]
        : []),
      // Reply needs SEND here; Forward writes through the bridge (read-only
      // channels offer neither; Discord hides Reply without Send).
      ...(can.reply ? [{ key: 'reply', label: 'Reply', icon: <ToolbarReplyIcon size={18} />, onSelect: () => onReply(message) }] : []),
      ...(can.forward ? [{ key: 'forward', label: 'Forward', icon: <ToolbarForwardIcon size={18} />, onSelect: () => onForward(message) }] : []),
      'separator',
      // Copy Text only when there is text (Discord returns null otherwise).
      ...(message.content ? [{ key: 'copy-text', label: 'Copy Text', icon: <MenuCopyTextIcon />, onSelect: () => copy(message.content) }] : []),
      // Pin / Unpin Message: staff only (Discord's Manage Messages) and only
      // once the message exists on Discord (delivered webhook / Discord-side).
      ...(can.pin
        ? [{ key: 'pin', label: pinned ? 'Unpin Message' : 'Pin Message', icon: <PinIcon size={18} />, onSelect: () => { void togglePin(message) } }]
        : []),
      { key: 'mark-unread', label: 'Mark Unread', icon: <MenuMailOpenIcon />, onSelect: () => onMarkUnread(message) },
      { key: 'copy-link', label: 'Copy Message Link', icon: <MenuLinkIcon />, onSelect: () => copy(link) },
      // Delete: gated to own web messages or staff (Discord's Manage
      // Messages). Opens the "Delete Message" confirmation modal via onDelete.
      ...(can.delete
        ? ['separator' as const, { key: 'delete', label: 'Delete Message', icon: <MenuTrashIcon />, danger: true as const, onSelect: () => onDelete(message) }]
        : []),
      ...(developerMode ? ['separator' as const, { key: 'copy-id', label: 'Copy Message ID', icon: <MenuCopyIcon />, onSelect: () => copy(String(message.id)) }] : []),
    ]
  }, [messageActions, onAddReaction, onReply, onDelete, onForward, onMarkUnread, startEdit, pinnedIds, togglePin, toggleReaction, resendFailed, deleteFailed, developerMode])

  // Right-click on a link / image inside a message: Discord opens the full
  // message menu with its media group (Save Image) and native link group
  // (Copy/Open … Link) slotted in before the developer Copy Message ID group.
  const onMessageMediaContext = (message: BridgeMessage, kind: 'link' | 'image', url: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const base = msgMenuEntries(message)
    const idIdx = base.findIndex((en) => en !== 'separator' && en.key === 'copy-id')
    const cut = idIdx < 0 ? base.length : idIdx
    openElemMenu([...base.slice(0, cut), 'separator', ...mediaMenuItems(kind, url), 'separator', ...base.slice(cut)], 'Message Actions', e.clientX, e.clientY)
  }

  // Discord's channel-header bell popout (461678, navId channel-context):
  // [Mute Channel ›] then the channel's notification radios (Use Category /
  // Server Default, All Messages, Only @mentions, Nothing). Shared by the
  // bell's left-click popout and its right-click menu.
  const bellMenuEntries = (channelId: string): MenuEntry[] => {
    const bellChannel = channels.find((c) => c.channelId === channelId)
    const notifItem = channelNotifMenuItem(channelId, bellChannel?.parentId)
    return [
      muteMenuItem('channel', channelId),
      'separator',
      ...(notifItem !== 'separator' && notifItem.submenu ? notifItem.submenu : []),
    ]
  }

  /* === Context menus for every remaining chat surface ===
     User rule: every UI element in the Discord integration gets our custom
     context menu, never the browser's. Surfaces with dedicated openers above
     (message rows, authors, channel rows, guild icons, content links/images/
     emoji/code, reaction chips, the user panel / profile popout) call
     preventDefault + stopPropagation first; everything else bubbles to the
     page-root onPageContext below, which routes by DOM landmark to a
     Discord-shaped menu whose entries are all wired. Text fields get Discord's
     text-input menu via the capture-phase onPageContextCapture. */

  // Open an element menu at the cursor for a React contextmenu event.
  const openMenu = (e: React.MouseEvent, entries: MenuEntry[], ariaLabel: string) => {
    e.preventDefault()
    e.stopPropagation()
    openElemMenu(entries, ariaLabel, e.clientX, e.clientY)
  }

  const channelLinkFor = (channelId: string) => chatLinkFor(channelId)
  const messageLinkFor = (m: BridgeMessage) => chatLinkFor(m.channelId, m.id)

  // Mark a channel read (Discord's Mark As Read). For the active channel this
  // also drops the NEW divider and the jump bar's new-message counter.
  const markChannelRead = (channelId: string) => {
    const loadedLatest = channelId === activeChannelId ? messages.reduce((max, m) => Math.max(max, m.id), 0) : 0
    const latest = Math.max(latestByChannel[channelId] || 0, loadedLatest)
    if (latest) markRead(channelId, latest)
    if (channelId === activeChannelId) {
      setUnreadDivider(null)
      setNewSinceScrollUp((current) => (current.count ? { count: 0, since: null } : current))
    }
  }

  // === Escape - Discord's channel ESC keybind ===
  // Lowest priority: context menu > popouts > picker > message edit > reply
  // cancel > this. Those layers either stop/preventDefault the event (context
  // menu, picker, search, edit, mention autocomplete, settings) or are open in
  // the state snapshot of the render the key was pressed in (popovers that
  // close on the same keydown). Otherwise: an armed reply is cancelled first;
  // else jump to present when detached (hasMoreAfter) and mark the channel
  // read (Discord's handler does both).
  const markChannelReadRef = useRef(markChannelRead)
  markChannelReadRef.current = markChannelRead
  const escapeStateRef = useRef({ blocked: false, replying: false })
  escapeStateRef.current = {
    blocked: Boolean(
      msgMenu || guildMenu || profile || rolePopout || reactorsPopout || pinsOpen || inboxOpen || notifOpen || statusOpen
      || helpOpen || searchOpen || emojiMenuOpen || guildNotifModal || deleteTarget || forwardTarget || modModal
      || editingMsgId !== null || showAuth || mentionOpen,
    ),
    replying: Boolean(replyTo),
  }
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return
      if (escapeStateRef.current.blocked) return
      if (document.querySelector('.contextMenuLayer, .picker')) return
      const t = e.target instanceof HTMLElement ? e.target : null
      if (t && t !== document.body && !t.closest('.chat-page')) return
      if (t && (t.tagName.toUpperCase() === 'INPUT' || t.tagName.toUpperCase() === 'TEXTAREA' || t.tagName.toUpperCase() === 'SELECT' || (t.isContentEditable && !t.closest('.msgInput')))) return
      if (escapeStateRef.current.replying) {
        e.preventDefault()
        setReplyTo(null)
        return
      }
      const channelId = activeChannelRef.current
      if (!channelId) return
      e.preventDefault()
      if (hasMoreAfterRef.current) void jumpToPresentRef.current()
      markChannelReadRef.current(channelId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Scroll a loaded message into view with the jump highlight flash.
  const flashMessage = (id: number) => {
    const el = listRef.current?.querySelector(`[data-message-id="${id}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.add('jumpHighlight')
    setTimeout(() => el.classList.remove('jumpHighlight'), 1600)
  }

  // Discord's channel menu (same set as the sidebar row's onChannelContext).
  const channelMenuEntries = (channel: BridgeChannel): MenuEntry[] => {
    return [
      { key: 'read', label: 'Mark As Read', disabled: !hasUnread([channel.channelId]), onSelect: () => markChannelRead(channel.channelId) },
      'separator',
      { key: 'copy-link', label: 'Copy Link', onSelect: () => copyText(channelLinkFor(channel.channelId)) },
      'separator',
      muteMenuItem('channel', channel.channelId),
      channelNotifMenuItem(channel.channelId, channel.parentId),
      'separator',
      { key: 'copy-id', label: 'Copy Channel ID', icon: <MenuCopyIcon />, onSelect: () => copyText(channel.channelId) },
    ]
  }
  // No channel selected (placeholder / empty header): only the page link applies.
  const pageMenuEntries = (): MenuEntry[] => [
    { key: 'copy-link', label: 'Copy Link', onSelect: () => copyText(window.location.href) },
  ]
  const channelOrPageEntries = (): MenuEntry[] => (activeChannel ? channelMenuEntries(activeChannel) : pageMenuEntries())

  // Copy affordances for a message shown outside the list (search results,
  // inbox, delete/forward previews) - the copy group of the message menu.
  const messageCopyEntries = (m: BridgeMessage): MenuEntry[] => [
    { key: 'copy-text', label: 'Copy Text', icon: <MenuCopyTextIcon />, disabled: !m.content, onSelect: () => copyText(m.content) },
    { key: 'copy-link', label: 'Copy Message Link', icon: <MenuLinkIcon />, onSelect: () => copyText(messageLinkFor(m)) },
    ...(developerMode ? [{ key: 'copy-id', label: 'Copy Message ID', icon: <MenuCopyIcon />, onSelect: () => copyText(String(m.id)) }] : []),
  ]

  // Search result / inbox mention row: jump + the message copy group.
  const onFoundMessageContext = (m: BridgeMessage, jump: () => void, e: React.MouseEvent) => {
    openMenu(e, [
      { key: 'jump', label: 'Jump to Message', icon: <MenuOpenIcon />, onSelect: jump },
      'separator',
      ...messageCopyEntries(m),
    ], 'Message Actions')
  }

  // Forward-dialog channel row: send there + Copy Channel ID.
  const onForwardChannelContext = (channelId: string, e: React.MouseEvent) => {
    const sent = forwardedTo.includes(channelId)
    openMenu(e, [
      { key: 'send', label: sent ? 'Sent' : 'Send', icon: <ToolbarForwardIcon size={18} />, disabled: sent || forwardingTo !== null, onSelect: () => void confirmForward(channelId) },
      'separator',
      { key: 'copy-id', label: 'Copy Channel ID', icon: <MenuCopyIcon />, onSelect: () => copyText(channelId) },
    ], 'Channel Actions')
  }

  // Mention autocomplete row: Discord's Mention + Copy <kind> ID.
  const onMentionSuggestionContext = (index: number, e: React.MouseEvent) => {
    const item = mentionItems[index]
    if (!item) return
    if (item.kind === 'emoji') { e.preventDefault(); e.stopPropagation(); return }
    const idLabel = item.kind === 'member' ? 'Copy User ID' : item.kind === 'role' ? 'Copy Role ID' : item.kind === 'channel' ? 'Copy Channel ID' : null
    openMenu(e, [
      { key: 'mention', label: 'Mention', onSelect: () => insertMention(index) },
      ...(idLabel ? ['separator' as const, { key: 'copy-id', label: idLabel, icon: <MenuCopyIcon />, onSelect: () => copyText(item.id) }] : []),
    ], 'Mention Actions')
  }

  // The inline editor's suggestion rows: Copy … ID (picking stays a click).
  const onMentionSuggestionContextItem = (item: MentionSuggestionItem, e: React.MouseEvent) => {
    const idLabel = item.kind === 'member' ? 'Copy User ID' : item.kind === 'role' ? 'Copy Role ID' : item.kind === 'channel' ? 'Copy Channel ID' : null
    if (!idLabel) { e.preventDefault(); e.stopPropagation(); return }
    openMenu(e, [{ key: 'copy-id', label: idLabel, icon: <MenuCopyIcon />, onSelect: () => copyText(item.id) }], 'Mention Actions')
  }

  // Expression picker targets (tiles, section headers, tone, tabs).
  const onPickerContext = (action: PickerContextAction, e: React.MouseEvent) => {
    if (action.kind === 'emoji') {
      const [name, glyph] = action.entry
      openMenu(e, [
        // Discord's expression-picker menu (753027…): "Copy Emoji" has no icon.
        { key: 'copy-emoji', label: 'Copy Emoji', onSelect: () => copyText(glyph) },
        { key: 'copy-name', label: 'Copy Emoji Name', onSelect: () => copyText(`:${name}:`) },
      ], 'Emoji Actions')
    } else if (action.kind === 'gif' || action.kind === 'sticker') {
      const full = action.full
      const link = full?.url || action.previewUrl
      openMenu(e, [
        { key: 'send', label: 'Send', icon: <ToolbarForwardIcon size={18} />, disabled: !full || composerDisabled || sending, onSelect: () => { if (full) void sendEmbed(full) } },
        'separator',
        { key: 'copy-link', label: link ? nativeLinkLabels(link).copy : 'Copy Link', disabled: !link, onSelect: () => { if (link) copyText(link) } },
        { key: 'open', label: link ? nativeLinkLabels(link).open : 'Open Link', disabled: !link, onSelect: () => { if (link) window.open(link, '_blank', 'noreferrer') } },
      ], action.kind === 'gif' ? 'GIF Actions' : 'Sticker Actions')
    } else if (action.kind === 'section') {
      openMenu(e, [
        { key: 'collapse', label: 'Collapse Category', affordance: 'check', checked: action.collapsed, onSelect: action.toggle },
        { key: 'collapse-all', label: 'Collapse All Categories', onSelect: action.collapseAll },
      ], 'Category Actions')
    } else if (action.kind === 'tone') {
      openMenu(e, ['Default skin tone', 'Skin tone 1', 'Skin tone 2', 'Skin tone 3', 'Skin tone 4', 'Skin tone 5'].map((label, t) => (
        { key: `tone-${t}`, label, affordance: 'radio' as const, group: 'tone', checked: action.tone === t, onSelect: () => action.select(t) }
      )), 'Skin Tone')
    } else if (action.kind === 'tab') {
      openMenu(e, ([['gifs', 'GIFs'], ['stickers', 'Stickers'], ['emoji', 'Emoji']] as Array<[PickerTab, string]>).map(([t, label]) => (
        { key: `tab-${t}`, label, affordance: 'radio' as const, group: 'tab', checked: action.tab === t, onSelect: () => action.select(t) }
      )), 'Expression Picker')
    }
  }

  // Discord's text-input menu (Cut / Copy / Paste / Select All) for the
  // composer and every other text field in the chat. The selection is
  // captured at open time and restored before each action, because the menu
  // takes focus. Cut/Copy go through execCommand (same path as Ctrl+X/C, user
  // activation from the menu click) with a clipboard-API fallback; Paste reads
  // the clipboard API and inserts at the restored caret - through the
  // composer's own plain-text paste path for the rich composer.
  const openTextInputMenu = (el: HTMLElement, e: React.MouseEvent) => {
    const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null
    const editable = field ? !field.readOnly && !field.disabled : el.isContentEditable && el.getAttribute('aria-disabled') !== 'true'
    let start = 0
    let end = 0
    let range: Range | null = null
    let selected = ''
    if (field) {
      start = field.selectionStart ?? 0
      end = field.selectionEnd ?? 0
      selected = field.value.slice(start, end)
    } else {
      const sel = window.getSelection()
      if (sel && sel.rangeCount && el.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        range = sel.getRangeAt(0).cloneRange()
        selected = sel.toString()
      }
    }
    const hasSelection = field ? end > start : Boolean(range && !range.collapsed)
    const restore = () => {
      el.focus()
      if (field) {
        try { field.setSelectionRange(start, end) } catch { /* type without selection API */ }
      } else if (range) {
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      }
    }
    const insertText = (text: string) => {
      restore()
      if (el === inputRef.current) {
        // Same sanitizing path as a native paste into the composer (plain
        // text, newlines → <br>, dispatches input so the length mirror and
        // mention trigger update).
        pastePlainText({ preventDefault: () => {}, clipboardData: { getData: () => text } } as unknown as ClipboardEvent, el)
      } else {
        document.execCommand('insertText', false, text)
      }
    }
    const canReadClipboard = typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function'
    // Discord's textarea menu (82c365…): Cut / Copy (only while text is
    // selected) then Paste, each with its shortcut hint; no Select All.
    openMenu(e, [
      ...(hasSelection ? [
        ...(editable ? [{
          key: 'cut',
          label: 'Cut',
          hint: CUT_SHORTCUT,
          onSelect: () => {
            restore()
            if (!document.execCommand('cut')) { copyText(selected); document.execCommand('delete') }
          },
        }] : []),
        {
          key: 'copy',
          label: 'Copy',
          hint: COPY_SHORTCUT,
          onSelect: () => {
            restore()
            if (!document.execCommand('copy')) copyText(selected)
          },
        },
      ] : []),
      ...(editable ? [{
        key: 'paste',
        label: 'Paste',
        hint: PASTE_SHORTCUT,
        disabled: !canReadClipboard,
        onSelect: () => {
          navigator.clipboard.readText()
            .then((text) => { if (text) insertText(text) })
            .catch(() => setError('Clipboard access was blocked. Paste with Ctrl+V instead.'))
        },
      }] : []),
    ], 'Text Actions')
  }

  // Capture phase: text fields win over any enclosing surface menu (e.g. the
  // inline edit textarea inside a message row).
  const onPageContextCapture = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement
    if (t.closest('.abulxt-auth-gate')) return
    const field = t.closest<HTMLElement>('input, textarea, [contenteditable]')
    if (!field) return
    if (field instanceof HTMLInputElement && !['text', 'search', 'url', 'email', 'tel', 'password', 'number', ''].includes(field.type)) return
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && !field.isContentEditable && !field.classList.contains('msgInput')) return
    openTextInputMenu(field, e)
  }

  // Bubble phase: everything no dedicated opener claimed.
  const onPageContext = (e: React.MouseEvent) => {
    if (e.defaultPrevented) return
    const t = e.target as HTMLElement
    // Site auth modal (not Discord UI) and the user panel (avatar / name tag /
    // status picker - the profile lane's openers) are left alone; the panel's
    // settings button is ours.
    if (t.closest('.abulxt-auth-gate')) return
    if (t.closest('.panels') && !t.closest('.panels .buttons')) return
    if (t.closest('.contextMenuLayer')) { e.preventDefault(); return }

    // Server header (dropdown + invite button) and the rail's blank space:
    // Discord opens the same server menu as the guild icon.
    if (t.closest('.d-serverHeader') || t.closest('.guilds')) {
      onGuildContext(activeGuild?.id || 'community', e)
      return
    }

    let entries: MenuEntry[]
    let label = 'Actions'
    // Gear menu: the two destinations, Abstract account (#/account) and
    // Settings (#/settings). Both are real pages, not in-chat dialogs.
    const settingsEntries = (): MenuEntry[] => [
      { key: 'account', label: 'Abstract account', iconLeft: <MenuUserIcon />, onSelect: () => navigateTo('account') },
      { key: 'settings', label: 'Settings', onSelect: () => navigateTo('settings') },
    ]


    if (t.closest('.bar-header')) {
      // Category row - Discord's category menu (ed5ba7…): [Mark As Read]
      // [Collapse Category ☐, Collapse All Categories] [Mute Category ›,
      // Notification Settings ›] … [Copy Category ID].
      const categoryId = (t.closest('.bar-header') as HTMLElement).dataset.categoryId || ''
      const inCategory = channels.filter((c) => c.parentId === categoryId)
      entries = [
        { key: 'read', label: 'Mark As Read', disabled: !hasUnread(inCategory.map((c) => c.channelId)), onSelect: () => inCategory.forEach((c) => markChannelRead(c.channelId)) },
        'separator',
        { key: 'collapse', label: 'Collapse Category', affordance: 'check', checked: Boolean(collapsedCategories[categoryId]), onSelect: () => setCategoryCollapsed([categoryId], 'toggle') },
        // Discord hides this once every category is already collapsed.
        ...(categories.every((c) => collapsedCategories[c.id]) ? [] : [{ key: 'collapse-all', label: 'Collapse All Categories', onSelect: () => setCategoryCollapsed(categories.map((c) => c.id), true) }]),
        ...(categoryId ? [
          'separator' as const,
          muteMenuItem('category', categoryId),
          channelNotifMenuItem(categoryId, null, true),
          'separator' as const,
          { key: 'copy-id', label: 'Copy Category ID', icon: <MenuCopyIcon />, onSelect: () => copyText(categoryId) },
        ] : []),
      ]
      label = 'Category Actions'
    } else if (t.closest('.bar')) {
      // Channel-list blank space / resize handle - Discord's sidebar menu.
      entries = [
        { key: 'hide-muted', label: 'Hide Muted Channels', affordance: 'check', checked: hideMutedChannels, onSelect: () => toggleHideMuted(activeGuildId) },
        'separator',
        { key: 'invite', label: 'Invite to Server', onSelect: () => window.open(activeInviteUrl, '_blank', 'noreferrer') },
      ]
      label = 'Channel List Actions'
    } else if (t.closest('.panels .buttons')) {
      // Settings cog.
      entries = settingsEntries()
      label = 'Account and settings'
    } else if (t.closest('.deleteConfirmBackdrop') && deleteTarget) {
      entries = messageCopyEntries(deleteTarget)
      label = 'Message Actions'
    } else if (t.closest('.forwardDialogBackdrop') && forwardTarget) {
      entries = messageCopyEntries(forwardTarget)
      label = 'Message Actions'
    } else if ((t.closest('.d-headerIconBell') || t.closest('.notifPopover')) && activeChannelId) {
      entries = bellMenuEntries(activeChannelId)
      label = 'Notification Settings'
    } else if (t.closest('.d-headerIconHelp') || t.closest('.helpPopover')) {
      // Help → the Discord invite link: Discord's link menu.
      entries = [
        { key: 'copy-link', label: 'Copy Link', onSelect: () => copyText(activeInviteUrl) },
        { key: 'open', label: 'Open Link', onSelect: () => window.open(activeInviteUrl, '_blank', 'noreferrer') },
      ]
      label = 'Link Actions'
    } else if (t.closest('.chat-error-toast') && error) {
      const message = error
      entries = [
        { key: 'copy-text', label: 'Copy Text', icon: <MenuCopyTextIcon />, onSelect: () => copyText(message) },
        'separator',
        { key: 'dismiss', label: 'Dismiss', onSelect: () => setError(null) },
      ]
      label = 'Notice Actions'
    } else if (t.closest('.jumpToPresent')) {
      entries = [
        { key: 'jump', label: 'Jump To Present', onSelect: jumpToPresent },
        ...(activeChannelId ? [{ key: 'read', label: 'Mark As Read', onSelect: () => { markChannelRead(activeChannelId); jumpToPresent() } }] : []),
      ]
      label = 'Jump Actions'
    } else if (t.closest('.chat-unread-divider') && activeChannelId) {
      entries = [{ key: 'read', label: 'Mark As Read', onSelect: () => markChannelRead(activeChannelId) }]
      label = 'New Messages'
    } else if ((t.closest('.typers') || t.closest('.typingDots')) && typingNames.length > 0) {
      entries = typingNames.slice(0, 3).map((name) => (
        { key: `mention-${name}`, label: `Mention @${name}`, disabled: composerDisabled, onSelect: () => mentionUser(name) }
      ))
      label = 'Typing'
    } else if ((t.closest('.replyBar') || t.closest('.replyPreview')) && replyTo) {
      const reply = replyTo
      entries = [
        { key: 'jump', label: 'Jump to Message', icon: <MenuOpenIcon />, disabled: !messages.some((m) => m.id === reply.id), onSelect: () => flashMessage(reply.id) },
        ...(!reply.self ? [{ key: 'mention', label: 'Mention', affordance: 'check' as const, checked: replyMention, onSelect: () => setReplyMention((on) => !on) }] : []),
        'separator',
        { key: 'cancel', label: 'Cancel Reply', onSelect: cancelReply },
      ]
      label = 'Reply Actions'
    } else if (t.closest('.inputFields') && !t.closest('.lockdownBar')) {
      // Composer chrome (GIF / sticker / emoji / send buttons).
      const open = (tab: PickerTab) => { setReactTarget(null); if (!(emojiMenuOpen && pickerTab === tab)) openPicker(tab) }
      entries = [
        { key: 'gifs', label: 'Open GIF Picker', disabled: composerDisabled, onSelect: () => open('gifs') },
        { key: 'stickers', label: 'Open Sticker Picker', disabled: composerDisabled, onSelect: () => open('stickers') },
        { key: 'emoji', label: 'Open Emoji Picker', disabled: composerDisabled, onSelect: () => open('emoji') },
        ...(composerLength > 0 ? ['separator' as const, { key: 'send', label: 'Send Message', disabled: composerDisabled || sending, onSelect: () => void submit() }] : []),
      ]
      label = 'Message Actions'
    } else {
      // Channel header (no channel / toolbar), message-list blank space, day
      // divider, welcome + read-only headers, lockdown bar: the channel menu.
      entries = channelOrPageEntries()
      label = activeChannel ? 'Channel Actions' : 'Actions'
    }

    // Selected text under the cursor: Discord leads with Copy.
    const sel = window.getSelection()
    const selectedText = sel && sel.rangeCount && !sel.isCollapsed && sel.getRangeAt(0).intersectsNode(t) ? sel.toString() : ''
    if (selectedText.trim()) entries = [{ key: 'copy-selection', label: 'Copy', hint: COPY_SHORTCUT, onSelect: () => copyText(selectedText) }, 'separator', ...entries]
    openMenu(e, entries, label)
  }

  return (
    <div
      className={`chat-page ${appearance} ${chatPrefs.rootClassName}`}
      style={{ ...chatPrefs.rootStyle, '--chat-sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}
      onContextMenuCapture={onPageContextCapture}
      onContextMenu={onPageContext}
    >
      {/* Server rail - Discord's 64px guild nav with folders (GuildRail.tsx).
          The layout is the account's guildFolders; clicking a guild switches
          to it (selectGuild), badges come from each guild's cached sidebar. */}
      <GuildRail
        guilds={guilds}
        folders={guildFolders}
        activeGuildId={activeGuildId}
        badges={guildBadges}
        editable={Boolean(user)}
        onSelectGuild={selectGuild}
        onLayoutChange={saveLayout}
        onGuildEnter={onGuildEnter}
        onGuildLeave={onGuildLeave}
        onGuildContext={onGuildContext}
        onMarkRead={markGuildsRead}
        onDragStart={() => setGuildTip(null)}
        fallback={
          <button
            type="button"
            className="guild active"
            aria-label="Community"
            aria-current="page"
            onClick={() => document.querySelector('.chat-page .bar-scroller')?.scrollTo({ top: 0, behavior: 'smooth' })}
            onMouseEnter={(e) => onGuildEnter('community', e)}
            onMouseLeave={onGuildLeave}
            onContextMenu={(e) => onGuildContext('community', e)}
          >
            <span className="guild-pill" aria-hidden="true" />
            <span className="guild-icon guild-acronym" aria-hidden="true" style={{ fontSize: guildAcronymFontSize('AB') }}>AB</span>
          </button>
        }
      />

      <aside className={`bar${guildBanner ? ' d-barHasBanner' : ''}`} ref={barRef}>
        {/* Server header - Discord's header_f37cb1: guildDropdown (badge + name
            + chevron) on the left, invite button on the right. Transparent bg,
            1px border-bottom. */}
        <div
          className={`d-serverHeaderContainer${guildBanner ? ' hasBanner_f37cb1' : ''}${guildBanner && bannerVisible ? ' bannerVisible_f37cb1' : ''}`}
          data-has-banner={guildBanner ? 'true' : 'false'}
          data-banner-visible={guildBanner && bannerVisible ? 'true' : 'false'}
        >
        <header className="d-serverHeader">
          {/* Banner-mode header layers (headerGlass / headerEllipseBackdrop /
              headerEllipseForeground): only styled under bannerVisible. */}
          {guildBanner && bannerVisible && (
            <>
              <div className="d-serverHeaderGlass" aria-hidden="true" />
              <div className="d-serverHeaderEllipseBackdrop" aria-hidden="true" />
              <div className="d-serverHeaderEllipseForeground" aria-hidden="true" />
            </>
          )}
          <div className="d-serverHeaderContent d-serverHeaderPrimaryInfo">
            <div
              className="d-serverHeaderGuildDropdown"
              role="button"
              tabIndex={0}
              ref={guildHeaderRef}
              aria-label={`${activeGuildName}, server actions`}
              aria-expanded={guildMenu !== null}
              onMouseDown={onGuildHeaderMouseDown}
              onClick={(e) => {
                if (e.button !== 0) return
                const wasOpen = guildHeaderDownOpen.current
                guildHeaderDownOpen.current = false
                toggleGuildHeaderMenu(activeGuild?.id || 'community', wasOpen)
              }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleGuildHeaderMenu(activeGuild?.id || 'community', guildMenu !== null) } }}
            >
              <div className="d-serverHeaderBadgeAndName">
                {/* Community flower-star badge - live shows it before the name
                    of a Community server (the bridged guild is one). */}
                <span className="d-serverHeaderBadge" role="img" aria-label="Community Server" title="Community Server">
                  <CommunityFlowerBadge />
                </span>
                <h2 className="d-serverHeaderName">{activeGuildName}</h2>
                {/* Muted-server badge (localStorage toggle from the guild menu)
                    - Discord shows a crossed bell next to the muted guild's name. */}
                {mutedGuilds[activeGuild?.id || 'community'] && (
                  <MenuBellOffIcon size={14} label="Server muted" className="d-serverHeaderMuteIcon" />
                )}
              </div>
              <div className="d-serverHeaderChildren">
                {/* Live swaps the chevron for an ✕ while the server-actions
                    menu is open; it reverts when the menu closes. */}
                {guildMenu ? <HeaderCloseIcon /> : <ChevronDownIcon />}
              </div>
            </div>
            <span>
              <div
                className="d-serverHeaderInviteButton"
                role="button"
                tabIndex={0}
                aria-label="Invite to Server"
                onClick={() => window.open(activeInviteUrl, '_blank', 'noreferrer')}
              >
                <InviteIcon />
              </div>
            </span>
          </div>
        </header>
        {/* Discord's animatedContainer > bannerImage > bannerImg: absolutely
            positioned under the header, translated up as the list scrolls. */}
        {guildBanner && (
          <div className="d-guildBannerContainer" aria-hidden="true">
            <div className="d-guildBannerImage">
              <img className="d-guildBannerImg" src={guildBanner} alt="" draggable={false} />
            </div>
          </div>
        )}
        </div>
        <div className="bar-scroller" onScroll={guildBanner ? onBarScroll : undefined}>
          {/* Discord's channel list leads with the banner overhang (only when
              the guild has a banner) and then its fixed 8px list padding
              (live DOM: <div style="height: 8px">) before the first row. */}
          {guildBanner && <div className="d-guildBannerSpacer" aria-hidden="true" />}
          <div className="d-channelListTopSpacer" aria-hidden="true" />
          {/* Discord's guild-action row: Channels & Roles (Customize /
              Browse Channels); right-click → Show All Channels. */}
          <ChannelsAndRolesSidebarRow
            api={channelsRoles}
            selected={crSection !== null}
            onOpen={() => setCrSection(channelsRoles.hasPrompts ? 'customize' : 'browse')}
            onContextMenu={(e) => openElemMenu([channelsRoles.showAllMenuItem()], 'Actions', e.clientX, e.clientY)}
          />
          {/* Discord's sidebar: groups in the server's order (bridged groups
              first, then the rest; Discord order within each), each category
              (live Discord refresh header: text-sm/medium sentence case, left
              chevron) followed by its channels.
              Collapsing a category hides its rows except the selected one and
              any that are unread, as on Discord. */}
          {sidebarGroups.map((group) => {
            const collapsed = group.category ? Boolean(collapsedCategories[group.category.id]) : false
            const renderChannel = (channel: BridgeChannel) => {
              const latest = latestByChannel[channel.channelId] || 0
              const read = lastRead[channel.channelId] || 0
              const muted = channelMuted(channel.channelId)
              // Muted channels never show the unread pill / bold state (Discord).
              const unread = !muted && channel.channelId !== activeChannelId && latest > read
              // Channels & Roles open: no channel row is selected (Discord).
              const selected = channel.channelId === activeChannelId && !crSection
              // Discord's channel row DOM: interactive wrapper (hover/selected bg)
              // → link (row content) → icon + name + optional unread pill.
              // Unread rows also carry d-channelUnread (live's
              // modeUnreadImportant): name brightens to --text-strong and the
              // hash icon to --icon-strong, not just the white pill.
              const row = (
                <div
                  key={channel.channelId}
                  className={`d-channelInteractive ${selected ? 'd-channelInteractiveSelected' : ''} ${unread ? 'd-channelUnread' : ''} ${muted ? 'd-channelMuted' : ''}`}
                  onContextMenu={(e) => onChannelContext(channel, e)}
                >
                  <button
                    type="button"
                    className="d-channelLink"
                    onClick={() => { setCrSection(null); setActiveChannelId(channel.channelId) }}
                    aria-current={selected ? 'true' : undefined}
                  >
                    <span className="d-channelLinkButtonIcon"><ChannelTypeIcon kind={channelIconKind(channel.type, channel.channelId === activeGuild?.rulesChannelId)} /></span>
                    <span className="d-channelName d-channelNameFade channel-name">{channel.name || channel.channelId}</span>
                    {(() => {
                      // Real mention badge: unread messages that ping the caller.
                      // Discord's red pill shows the count, capped at 99+. The
                      // 'Nothing' notification level suppresses it.
                      const mentionCount = channelMentionCount(channel.channelId)
                      if (!mentionCount) return null
                      return (
                        <span className="mention-badge" aria-label={`${mentionCount} unread mentions`}>
                          {mentionCount > 99 ? '99+' : mentionCount}
                        </span>
                      )
                    })()}
                  </button>
                  {unread && <span className="d-channelUnreadPill" aria-hidden="true" />}
                </div>
              )
              if (!openPost || openPost.forumId !== channel.channelId) return row
              // The open forum post: Discord's thread row under its parent
              // (spine + name, selected). The post title is a data value.
              return (
                <Fragment key={channel.channelId}>
                  {row}
                  <div className={`d-channelInteractive dcfSidebarPost${openPost.id === activeChannelId && !crSection ? ' d-channelInteractiveSelected' : ''}`}>
                    <button type="button" className="d-channelLink" onClick={() => openForumPost(openPost)} aria-current={openPost.id === activeChannelId ? 'true' : undefined}>
                      <span className="d-channelName d-channelNameFade channel-name">{openPost.name}</span>
                    </button>
                  </div>
                </Fragment>
              )
            }
            const rowsShown = collapsed
              ? group.channels.filter((c) => c.channelId === activeChannelId
                || (!channelMuted(c.channelId) && (latestByChannel[c.channelId] || 0) > (lastRead[c.channelId] || 0))
                || channelMentionCount(c.channelId) > 0)
              : group.channels
            return (
              <Fragment key={group.category?.id || 'uncategorized'}>
                {group.category && (
                  <button
                    type="button"
                    className={`bar-header ${collapsed ? 'bar-header-collapsed' : ''}`}
                    data-category-id={group.category.id}
                    onClick={() => setCategoryCollapsed([group.category!.id], 'toggle')}
                    aria-expanded={!collapsed}
                    aria-label={`${group.category.name} (category)`}
                  >
                    <span className="bar-header-chevron"><CategoryChevronIcon /></span>
                    <span className="bar-header-name">{group.category.name}</span>
                  </button>
                )}
                {rowsShown.map(renderChannel)}
              </Fragment>
            )
          })}
          {!channels.length && channelsLoaded && (
            <div className="bar-empty">
              {bridgeConfigured ? 'No channels bridged yet.' : 'Chat is not set up yet.'}
            </div>
          )}
        </div>
        {/* Sidebar resize handle - Discord's draggable splitter on the channel
            sidebar's right edge. Drag resizes the sidebar (min 180 / max 400);
            double-click resets to 240px. */}
        <div
          className={`sidebarResizeHandle${sidebarDragging ? ' dragging' : ''}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize channel sidebar"
          title="Drag to resize · double-click to reset"
          onPointerDown={onSidebarHandleDown}
          onPointerMove={onSidebarHandleMove}
          onPointerUp={endSidebarDrag}
          onPointerCancel={endSidebarDrag}
          onDoubleClick={resetSidebarWidth}
        />
      </aside>

      {/* User panel - Discord .panels: avatar + nameTag(name top, status/username bottom) + mic/deafen/settings buttons.
          Lives OUTSIDE .bar as a direct child of .chat-page (position:absolute on the page root) so it overlays the
          whole sidebar - the 64px guild rail + the 240px channel list - like live Discord's .panels__5e434. */}
      <div className="panels">
        <div className="container">
          {user ? (
            <>
              {/* Discord .accountPopoutButtonWrapper__37e49: avatar + nameTag
                  are ONE hover/click target (the whole card highlights,
                  avatar included); click opens the self account popout,
                  right-click the self user menu. */}
              <div
                className={`accountPopoutButtonWrapper${profile?.kind === 'self' ? ' active' : ''}`}
                role="button"
                aria-label={`${nickname || user.discord?.name || user.username}, ${PRESENCE_TEXT[ownShown]}`}
                aria-haspopup="dialog"
                aria-expanded={profile?.kind === 'self'}
                tabIndex={0}
                onClick={openAccountPopout}
                onContextMenu={onSelfAvatarContext}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAccountPopout(e) } }}
              >
              <div className="avatarWrapper">
                <img
                  src={chatAvatar || (user.discord?.avatar
                    ? `https://cdn.discordapp.com/avatars/${user.discord.id}/${user.discord.avatar}.webp?size=64`
                    : defaultAvatar(user.username))}
                  alt=""
                />
                {/* The linked Discord account's avatar decoration over the
                    32px panel avatar (Discord's avatarDecorationContainer at
                    --decoration-to-avatar-ratio). */}
                {selfStyle?.decoration && (
                  <AvatarDecoration asset={selfStyle.decoration.asset} size={40} animate={false} className="chat-panelAvatarDecoration" />
                )}
                <span className={`status status-${ownShown}`} aria-hidden="true"><StatusIcon status={presenceGlyph(ownShown)} /></span>
              </div>
              {/* Set Status: anchored above the user panel (Popout position
                  "top", align "left", spacing 8), inset 8px on both sides like
                  the panel's own padding, portaled to the popout layer. */}
              {statusOpen && (
                <Popout anchor={anchorSelector('.panels > .container')} position="top" align="left" spacing={8} offset={8} matchWidth={{ inset: 8 }}>{(ref) => (
                <div ref={ref} className="statusPicker" role="menu" aria-label="Set status">
                  {([
                    ['online', 'Online'],
                    ['idle', 'Idle'],
                    ['dnd', 'Do Not Disturb'],
                    ['invisible', 'Invisible'],
                  ] as Array<[PresenceStatus, string]>).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={presence === value}
                      className={`statusPickerItem ${presence === value ? 'selected' : ''}`}
                      onClick={() => pickStatus(value)}
                    >
                      <span className={`statusDot status-${value}`} aria-hidden="true"><StatusIcon status={value} /></span>
                      <span className="statusPickerLabel">{label}</span>
                      {value === 'invisible' && <span className="statusPickerHint"><HolyText text="You won't appear online, but have full access." /></span>}
                    </button>
                  ))}
                </div>
                )}</Popout>
              )}
              <div className="nameTag">
                <HolyText as="div" className="title" ellipsis text={nickname || user.discord?.name || user.username} />
                {/* Discord's panel subtext: the status text by default, the
                    @username on hover (a stacked swap, no layout jump). */}
                <div className="subtext">
                  <HolyText as="span" className="subtextStatus" ellipsis text={PRESENCE_TEXT[ownShown]} />
                  <HolyText as="span" className="subtextUsername" ellipsis aria-hidden="true" text={user.username} />
                </div>
              </div>
              </div>
            </>
          ) : (
            <>
              <div className="avatarWrapper" role="button" aria-label="Sign in" tabIndex={0} onClick={() => setShowAuth(true)}>
                <img src={defaultAvatar('guest')} alt="" />
              </div>
              <div className="nameTag" role="button" aria-label="Sign in" tabIndex={0} onClick={() => setShowAuth(true)}>
                <HolyText as="div" className="title" ellipsis text="Guest" />
                {/* Plain (non-ellipsis) so the host stays display:block and
                    stacks below the inline-block title instead of flowing
                    beside it; the text is short and never truncates. */}
                <HolyText as="div" className="subtext" text="Sign in to chat" />
              </div>
            </>
          )}
        </div>
      </div>

      {crSection && (
        <ChannelsAndRolesPage
          api={channelsRoles}
          section={crSection}
          onSectionChange={setCrSection}
          guildName={activeGuildName}
          rulesChannelId={activeGuild?.rulesChannelId}
          onViewChannel={(id) => { if (!openChannel(id)) { setCrSection(null); setActiveChannelId(id) } }}
        />
      )}
      <main className={`wrapper${search.results ? ' searchResultsOpen' : ''}${crSection ? ' cr-hidden' : ''}`}>
        {/* Channel header - Discord's container__9293f: icon + title + topic
            (with divider) on the left, toolbar__9293f icon row on the right. */}
        <section className="d-headerContainer d-headerThemed" aria-label="Channel header">
          <div className="d-headerUpperContainer">
            {/* Right-click on the title/icon/topic area opens Discord's
                channel context menu (same actions as the sidebar row). */}
            <div className="d-headerChildren" onContextMenu={onChannelHeaderContext}>
              {activePost ? (
                <>
                  {/* An open forum post: forum › post breadcrumb (the forum
                      name opens the forum view). Names are data values. */}
                  <div className="d-headerChannelIcon d-headerIconWrapper">
                    <ChannelTypeIcon kind={channelIconKind(postForum?.type ?? 15)} size={24} className="d-headerIcon" />
                  </div>
                  <button type="button" className="dcfCrumbParent" onClick={() => { setCrSection(null); setActiveChannelId(activePost.forumId) }}>
                    {postForum?.name || activePost.forumId}
                  </button>
                  <svg className="dcfCrumbChevron" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none"><path fill="currentColor" d="M5.3 9.3a1 1 0 0 1 1.4 0l5.3 5.29 5.3-5.3a1 1 0 1 1 1.4 1.42l-6 6a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.42Z" /></svg>
                  <PostGlyph size={20} className="dcfCrumbPostIcon" />
                  <div className="d-headerTitleWrapper">
                    <h1 className="d-headerTitle ns">{activePost.name}</h1>
                  </div>
                </>
              ) : (
                <>
                  <div className="d-headerChannelIcon d-headerIconWrapper">
                    <ChannelTypeIcon kind={channelIconKind(activeChannel?.type, Boolean(activeChannel) && activeChannel?.channelId === activeGuild?.rulesChannelId)} size={24} className="d-headerIcon" />
                  </div>
                  <div className="d-headerTitleWrapper">
                    <h1 className="d-headerTitle ns">{activeChannel?.name || 'chat'}</h1>
                  </div>
                </>
              )}
              {/* Header divider + topic render only when the channel has a
                  non-empty topic - live Discord shows neither otherwise. A
                  forum shows its topic as Post Guidelines instead. */}
              {!activeForum && activeChannel?.topic?.trim() && (
                <>
                  <div className="d-headerDivider" aria-hidden="true" />
                  <div className="activeInfo-description ns">{activeChannel.topic}</div>
                </>
              )}
            </div>
            {/* Channel-header toolbar. Only buttons with a real surface render:
                Notification Settings (per-channel level popover, localStorage),
                Pinned Messages (live Discord pins; bridged channels only), Search (expanding input
                over the loaded messages), Inbox (Mentions list), and Help
                ("About this chat" popover). Threads and Show Member List have
                no bridge backend, so they're omitted entirely rather than
                rendered as dead buttons. */}
            <div className="d-headerToolbar">
              {!activePost && (
              <div
                className="d-headerIconWrapper d-headerClickable d-headerIconBell"
                role="button"
                aria-label="Notification Settings"
                aria-haspopup="menu"
                aria-expanded={notifOpen}
                title="Notification Settings"
                tabIndex={0}
                // The open menu closes itself on any outside mousedown (this
                // button included), so remember whether it was open: a click
                // on the bell while open just closes it.
                onMouseDown={() => { bellDownOpen.current = notifOpen }}
                onClick={() => { const wasOpen = bellDownOpen.current; bellDownOpen.current = false; setNotifOpen(!wasOpen); setPinsOpen(false); setInboxOpen(false); setHelpOpen(false); setSearchOpen(false) }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setNotifOpen((open) => !open); setPinsOpen(false); setInboxOpen(false); setHelpOpen(false); setSearchOpen(false) } }}
              >
                {/* Muted channel → Discord's crossed bell in the header. */}
                {activeChannelId && (notifLevels[activeChannelId] || 'all') === 'muted'
                  ? <MenuBellOffIcon size={24} className="d-headerIcon" />
                  : <BellIcon />}
              </div>
              )}
              {pinsAvailable && (
              <div
                className="d-headerIconWrapper d-headerClickable d-headerIconPin"
                role="button"
                aria-label="Pinned Messages"
                aria-haspopup="dialog"
                aria-expanded={pinsOpen}
                title="Pinned Messages"
                tabIndex={0}
                onClick={() => { setPinsOpen((open) => !open); setNotifOpen(false); setInboxOpen(false); setHelpOpen(false); setSearchOpen(false) }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPinsOpen((open) => !open); setNotifOpen(false); setInboxOpen(false); setHelpOpen(false); setSearchOpen(false) } }}
              >
                <PinIcon />
              </div>
              )}
              {/* Discord's header search bar (search__49676 → searchBar_c322aa):
                  tokenized query, magnifier ↔ clear icon, autocomplete popout.
                  Enter opens the results sidebar (SearchResults below). */}
              <SearchBar
                search={search}
                guildName={activeGuildName}
                suggestChannelId={activeChannelBridged && activeChannelId ? activeChannelId : (channels.find((c) => c.bridged !== false)?.channelId ?? null)}
                channels={channels}
                open={searchOpen}
                onOpenChange={setSearchOpen}
                channelKind={(id) => channelIconKinds.get(id) || 'text'}
              />
              <div
                className="d-headerIconWrapper d-headerClickable d-headerIconInbox"
                role="button"
                aria-label="Inbox"
                aria-haspopup="dialog"
                aria-expanded={inboxOpen}
                title="Inbox"
                tabIndex={0}
                onClick={() => { setInboxOpen((open) => !open); setPinsOpen(false); setNotifOpen(false); setHelpOpen(false); setSearchOpen(false) }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setInboxOpen((open) => !open); setPinsOpen(false); setNotifOpen(false); setHelpOpen(false); setSearchOpen(false) } }}
              >
                <InboxIcon />
              </div>
              <div
                className="d-headerIconWrapper d-headerClickable d-headerIconHelp"
                role="button"
                aria-label="Help"
                aria-haspopup="dialog"
                aria-expanded={helpOpen}
                title="Help"
                tabIndex={0}
                onClick={() => { setHelpOpen((open) => !open); setNotifOpen(false); setPinsOpen(false); setInboxOpen(false); setSearchOpen(false) }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setHelpOpen((open) => !open); setNotifOpen(false); setPinsOpen(false); setInboxOpen(false); setSearchOpen(false) } }}
              >
                <HelpIcon />
              </div>
            </div>
          </div>
          {/* Bell → Discord's notification popout: a Menu (not a dialog)
              anchored under the bell, position bottom / align right, no
              auto-invert (28d6bbd7: Popout position:"bottom", align:"right",
              autoInvert:false). Radio picks keep it open; Mute › durations
              and outside clicks / Escape close it. */}
          {notifOpen && activeChannelId && (
            <ContextMenu
              x={0}
              y={0}
              anchor={BELL_MENU_ANCHOR}
              anchorOptions={BELL_MENU_PLACEMENT}
              entries={bellMenuEntries(activeChannelId)}
              onClose={() => setNotifOpen(false)}
              ariaLabel="Notification Settings"
            />
          )}
          {/* Pinned Messages popover. The bridge has no pins list endpoint, so
              this always renders Discord's empty state for now - the panel and
              header match the live client's pinned-messages dropdown. */}
          {pinsOpen && pinsAvailable && (
            <Popout anchor={anchorSelector('.d-headerToolbar .d-headerIconPin')} position="bottom" align="right" spacing={8}>{(ref) => (
            <div ref={ref} className="pinnedPopover" role="dialog" aria-label="Pinned Messages">
              <div className="pinnedPopoverHeader"><HolyText text="Pinned Messages" /></div>
              <div className="pinnedPopoverBody">
                {pins === null ? (
                  <div className="pinnedPopoverEmpty"><p>Loading…</p></div>
                ) : pinsError ? (
                  <div className="pinnedPopoverEmpty"><p>{pinsError}</p></div>
                ) : pins.length === 0 ? (
                  <div className="pinnedPopoverEmpty">
                    <PinIcon />
                    <p><HolyText text="This channel has no pinned messages… yet." /></p>
                  </div>
                ) : (
                  <ul className="pinnedList">
                    {pins.map((pin) => {
                      const m = pin.message
                      return (
                        <li key={m.discordMessageId || m.id} className="pinnedItem">
                          <img className="pinnedItemAvatar" src={m.authorAvatar || defaultAvatar(m.authorName)} alt="" loading="lazy" />
                          <div className="pinnedItemMain">
                            <InteractionHeader message={m} appearance="cozy" className="ix-noSpine" />
                            <div className="pinnedItemMeta">
                              <span className="pinnedItemAuthor" style={m.authorColor ? { color: m.authorColor } : undefined}>{m.authorName}</span>
                              <time className="pinnedItemTime" dateTime={m.createdAt}>{formatTimestamp(m.createdAt)}</time>
                            </div>
                            <div className="pinnedItemBody">
                              <MessageBody message={m} onOpenMention={openMention} />
                            </div>
                          </div>
                          {m.id > 0 && (
                            <div className="pinnedItemActions">
                              <button
                                type="button"
                                className="pinnedItemJump"
                                onClick={() => { setPinsOpen(false); jumpToMessage(m.channelId, m.id) }}
                              >
                                Jump
                              </button>
                              {canPin && (
                                <button
                                  type="button"
                                  className="pinnedItemUnpin"
                                  aria-label="Unpin Message"
                                  title="Unpin Message"
                                  onClick={() => { void togglePin(m) }}
                                >
                                  <MenuCloseIcon size={16} />
                                </button>
                              )}
                            </div>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            </div>
            )}</Popout>
          )}
          {/* Inbox popover - Discord's Inbox dropdown rebuilt around its
              Mentions tab: recent messages that ping the caller across every
              loaded channel, newest first. Clicking an entry jumps to that
              channel + message. */}
          {inboxOpen && (
            <Popout anchor={anchorSelector('.d-headerToolbar .d-headerIconInbox')} position="bottom" align="right" spacing={8} autoInvert={false}>{(ref) => (
            <div ref={ref} className="inboxPopover" role="dialog" aria-label="Inbox">
              <div className="inboxPopoverHeader"><HolyText text="Inbox" /></div>
              <div className="inboxPopoverTabs" role="tablist" aria-label="Inbox">
                <span className="inboxPopoverTab active" role="tab" aria-selected="true">Mentions</span>
              </div>
              <div className="inboxPopoverBody">
                {!user ? (
                  <div className="inboxPopoverEmpty">
                    <InboxIcon />
                    <p><HolyText text="Sign in to see your mentions." /></p>
                  </div>
                ) : inboxLoading ? (
                  <div className="inboxPopoverEmpty">
                    <p>Loading…</p>
                  </div>
                ) : inboxMentions.length === 0 ? (
                  <div className="inboxPopoverEmpty">
                    <InboxIcon />
                    <p><HolyText text="No mentions" /></p>
                  </div>
                ) : (
                  <ul className="inboxPopoverList">
                    {inboxMentions.map((entry) => (
                      <li key={entry.message.id}>
                        <button
                          type="button"
                          className="inboxMentionItem"
                          onClick={() => jumpToMention(entry)}
                          onContextMenu={(e) => onFoundMessageContext(entry.message, () => jumpToMention(entry), e)}
                        >
                          <span className="inboxMentionAvatar">
                            <img src={entry.message.authorAvatar || defaultAvatar(entry.message.authorName)} alt="" loading="lazy" />
                          </span>
                          <span className="inboxMentionMain">
                            <span className="inboxMentionMeta">
                              <span className="inboxMentionAuthor" style={entry.message.authorColor ? { color: entry.message.authorColor } : undefined}>{entry.message.authorName}</span>
                              {/* Channel (and, with several servers, guild) names are data values. */}
                              <span className="inboxMentionChannel">#{entry.channelName}{entry.guildName ? ` · ${entry.guildName}` : ''}</span>
                            </span>
                            <span className="inboxMentionSnippet"><ReplyPreviewText message={entry.message} /></span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            )}</Popout>
          )}
          {/* Help ("About this chat") popover - explains what the bridge is and
              links to the Discord invite. Anchored under the Help button. */}
          {helpOpen && (
            <Popout anchor={anchorSelector('.d-headerToolbar .d-headerIconHelp')} position="bottom" align="right" spacing={8}>{(ref) => (
            <div ref={ref} className="helpPopover" role="dialog" aria-label="About this chat">
              <div className="helpPopoverHeader"><HolyText text="About this chat" /></div>
              <div className="helpPopoverBody">
                <p className="helpPopoverText">
                  Community chat bridged to the {activeGuildName} Discord server. Messages sync between web and Discord. Post here or in the app, and it shows up on both.
                </p>
                <a
                  className="helpPopoverLink"
                  href={activeInviteUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Join the Discord server
                </a>
              </div>
            </div>
            )}</Popout>
          )}
        </section>

        {/* Discord-style transient error notice: an elevated dark toast pinned
            above the composer (absolute, so it never shifts layout), red danger
            icon + message + close ×, auto-dismissed by setError's 5s timer. */}
        {error && (
          <div className="chat-error chat-error-toast" role="alert">
            <MenuCircleAlertIcon size={16} />
            <span className="chat-error-message">{error}</span>
            {needsVerification && (
              <a className="chat-error-link" href="#verify-email">Verify email</a>
            )}
            <button
              type="button"
              className="chat-error-close"
              aria-label="Dismiss"
              onClick={() => setError(null)}
            >
              <MenuCloseIcon size={14} />
            </button>
          </div>
        )}

        {/* Hover-bar quick reaction tooltip (Discord: ":name:" text-sm/medium
            text-strong over "Click to react" / "Click to remove" text-xs,
            centered - emojiTooltipText__040f0). */}
        {quickReactTip && hoveredMsgId !== null && document.contains(quickReactTip.el) && (
          <HoverTooltip anchor={quickReactTip.el}>
            <div className="chat-emojiTooltipName">:{quickReactTip.name}:</div>
            <div className="chat-emojiTooltipHint">{quickReactTip.remove ? 'Click to remove' : 'Click to react'}</div>
          </HoverTooltip>
        )}

        {activeForum && !crSection ? (
          <ForumView
            key={activeForum.channelId}
            forum={activeForum}
            perms={perms}
            signedIn={user !== null}
            selfKeys={postSelfKeys}
            lastRead={lastRead}
            developerMode={developerMode}
            openPostId={null}
            onRequireSignIn={() => setShowAuth(true)}
            onOpenPost={openForumPost}
            onError={setError}
            onCopy={copyText}
            onMarkPostRead={(post) => { if (post.lastMessageId) markRead(post.id, post.lastMessageId) }}
          />
        ) : (<>
        {/* group-spacing-* scopes Discord's --custom-group-spacing-start per
            density (cozy 17px / compact 1px) - see .messages.group-spacing-*
            in chat.css. The vendored group-spacing rules only cover
            .d-msgGroupStart; our hand-written rows use .message.groupStart. */}
        {/* New-messages bar - Discord's newMessagesBar__0f481 (tW): a blurple
            strip pinned to the top of the message area while messages that
            arrived off-screen are unread. Main button jumps to the first
            unread (the NEW divider); "Mark As Read" acks the channel. */}
        <div className="newMessagesAnchor">
          {newSinceScrollUp.count > 0 && activeChannelId && !loading && (
            <div className="newMessagesBar chatBarBase">
              <button
                type="button"
                className="chatBarButtonMain"
                onClick={() => {
                  const target = unreadDivider?.channelId === activeChannelId ? unreadDivider.beforeId : null
                  if (target) jumpToMessage(activeChannelId, target)
                  else void jumpToPresent()
                }}
              >
                <span className="chatBarSpan">
                  {`${newSinceScrollUp.count} new message${newSinceScrollUp.count === 1 ? '' : 's'}${newSinceScrollUp.since ? ` since ${formatShortTime(newSinceScrollUp.since)}` : ''}`}
                </span>
              </button>
              <div className="chatBarButtonWrapper">
                <button type="button" className="chatBarButtonAlt" onClick={() => markChannelRead(activeChannelId)}>
                  <span className="chatBarMarkAsReadText">Mark As Read</span>
                  <svg className="chatBarButtonIcon" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path fill="currentColor" d="M12.66 21.98c.4-.03.56-.51.28-.8l-.06-.06a3 3 0 1 1 4.24-4.24l.53.52c.2.2.5.2.7 0l2.53-2.52a3 3 0 0 1 .64-.5c.14-.07.24-.2.27-.34a10 10 0 1 0-18.24 3.32c.13.19.11.44-.04.61l-2.06 2.37A1 1 0 0 0 2.2 22H12c.22 0 .44 0 .66-.02Z" />
                    <path fill="currentColor" d="M23.7 17.7a1 1 0 0 0-1.4-1.4L18 20.58l-2.3-2.3a1 1 0 0 0-1.4 1.42l3 3a1 1 0 0 0 1.4 0l5-5Z" />
                  </svg>
                </button>
              </div>
            </div>
          )}
        </div>
        <div className={`messages ${appearance === 'cozy' ? 'group-spacing-16' : 'group-spacing-0'}`} ref={listRef} onScroll={onScroll}>
          <div className="messagesContent" ref={listContentRef}>
          {loading && <MessageSkeleton appearance={appearance} />}
          {!loading && activeChannelId && viewDeniedChannelId === activeChannelId && (
            <div className="chat-placeholder">
              <PlaceholderChatIcon />
              <p><HolyText text="You do not have permission to view this channel." /></p>
            </div>
          )}
          {!loading && !activeChannelId && (
            <div className="chat-placeholder">
              <PlaceholderChatIcon />
              <p>{channelsLoaded
                ? (bridgeConfigured ? 'Pick a channel to start chatting.' : 'The community chat has not been set up yet. Check back soon!')
                : 'Loading…'}</p>
            </div>
          )}
          {/* Read-only (non-bridged) channel with no messages on Discord:
              its history is read live from Discord and nothing can be sent,
              so show Discord's no-SEND notice instead of the welcome block. */}
          {!loading && activeChannelId && !messages.length && activeChannelReadOnly && (
            <div className="channel-welcome channel-readonly">
              <div className="welcome-icon"><WelcomeHashIcon /></div>
              <HolyRich as="div" className="welcome-title">#{activeChannel?.name || 'chat'}</HolyRich>
              <div className="welcome-sub"><HolyText text="You do not have permission to send messages in this channel." /></div>
            </div>
          )}
          {/* Discord shows the channel's welcome header above the first
              message once the window reaches the beginning of history
              (hasMoreBefore false), not only for an empty channel. */}
          {!loading && activeChannelId && !activePost && ((!messages.length && !activeChannelReadOnly) || (messages.length > 0 && !hasMore)) && (
            <div className="channel-welcome">
              <div className="welcome-icon"><WelcomeHashIcon /></div>
              <HolyRich as="div" className="welcome-title">Welcome to #{activeChannel?.name || 'chat'}!</HolyRich>
              <HolyRich as="div" className="welcome-sub">This is the start of the #{activeChannel?.name || 'chat'} channel.</HolyRich>
            </div>
          )}
          {!loading && activePost && !messages.length && <div className="dcfMsgs-scrollerSpacer dcfMsgs-emptyForum" aria-hidden="true" />}
          {/* Placeholder rows at a window edge with more history (Discord's
              message-list placeholders): scrolling near them loads the next
              chunk, so a normal scroll rarely sees them. */}
          {!loading && activeChannelId && messages.length > 0 && hasMore && (
            <div className="chat-history-edge top" aria-hidden="true">
              <MessageSkeleton appearance={appearance} />
            </div>
          )}
          {rows.map((row) => {
            if (row.kind === 'day') {
              return (
                <div key={row.key} className="chat-day-divider">
                  <span>{row.label}</span>
                </div>
              )
            }
            if (row.kind === 'unread') {
              // Unread "NEW" divider - Discord's .divider__908e2.isUnread: a
              // red line (--background-feedback-notification) with the NEW
              // pill (red bg, white uppercase text) riding its right end.
              return (
                <div key={row.key} className="chat-unread-divider" role="separator" aria-label="New messages">
                  <span className="chat-unread-pill">New</span>
                </div>
              )
            }
            const { message, grouped } = row
            const groupStart = !grouped
            // Discord hides reaction actions entirely when the caller can't
            // react - offer Reply/Edit/More only (signed-out guests keep them
            // so the click can prompt sign-in).
            const showReactButtons = messageActions(message).react
            // Discord paints rows that mention you with the yellow mentioned
            // background + left accent bar (see .message.mentioned in chat.css).
            const mentioned = user !== null && messageMentionsUser(message, mentionSelf)
            const rowEl = (
              <div
                key={row.key}
                data-message-id={message.id}
                className={`message ${groupStart ? 'groupStart' : 'grouped'}${hoveredMsgId === message.id ? ' hovered' : ''}${mentioned ? ' mentioned' : ''}${editingMsgId === message.id ? ' editing' : ''}${msgMenu?.message.id === message.id || (emojiMenuOpen && reactTarget?.id === message.id) ? ' menuOpen' : ''}`}
                onMouseEnter={() => setHoveredMsgId(message.id)}
                onMouseLeave={() => setHoveredMsgId((current) => (current === message.id ? null : current))}
                onContextMenu={(e) => onMsgContext(message, e)}
              >
                {/* Message-hover action bar - Discord's container__040f0 →
                    popover_f84418 + wrapper_f7ecac pill, laid out exactly like
                    the client's MessageActionBar (nA in the message chunk):
                      [3 quick reactions | separator] Add Reaction → Reply
                      (others' messages) → Edit (own) → Forward → More.
                    Holding Shift expands it (isExpanded): the quick reactions
                    and separator drop out and Copy Message ID, Copy Link, Mark
                    Unread, Pin/Unpin, Reply (own) lead the bar, Delete (red)
                    replaces More when the caller can delete. Quick reactions
                    are the caller's 3 frecent emoji (padded with Discord's
                    defaults 100 / laughing / sparkling_heart) and react
                    immediately. Visibility is driven by the row's React hover
                    state (`hovered` class). */}
                {(() => {
                  // Discord's MessageActionBar: no bar at all while a message
                  // is SENDING; a SEND_FAILED one gets only Retry + Delete
                  // (the `nf` failed-message buttons: RetryIcon "Retry",
                  // TrashIcon "Delete" - a local delete, no confirmation).
                  if (message.sendState === 'failed') {
                    return (
                      <div className="msgButtons d-msgHoverContainer" role="group" aria-label="Message Actions">
                        <div className="d-msgHoverWrapper">
                          <button type="button" className="d-msgHoverBarButton d-msgHoverButton" aria-label="Retry" title="Retry" tabIndex={-1} onClick={() => resendFailed(message)}>
                            <ToolbarRetryIcon />
                          </button>
                          <button type="button" className="d-msgHoverBarButton d-msgHoverButton" aria-label="Delete" title="Delete" tabIndex={-1} onClick={() => deleteFailed(message)}>
                            <span className="chat-hoverBarIcon"><MenuTrashIcon /></span>
                          </button>
                        </div>
                      </div>
                    )
                  }
                  if (message.id < 0) return null
                  const expanded = shiftHeld && hoveredMsgId === message.id
                  // The same per-message gate the context menu uses.
                  const can = messageActions(message)
                  const canReply = can.reply
                  const canForward = can.forward
                  const canEdit = can.edit
                  const canDeleteMsg = can.delete
                  const canPinMsg = can.pin
                  const pinnedMsg = pinnedIds?.channelId === message.channelId && pinnedIds.ids.includes(message.id)
                  const ownerKey = perms?.ownerKey
                  const barButton = (key: string, label: string, icon: ReactNode, onClick: (e: React.MouseEvent) => void, extra = '') => (
                    <button
                      key={key}
                      type="button"
                      className={`d-msgHoverBarButton d-msgHoverButton${extra}`}
                      aria-label={label}
                      title={label}
                      tabIndex={-1}
                      onClick={onClick}
                    >
                      {icon}
                    </button>
                  )
                  return (
                    <div className="msgButtons d-msgHoverContainer" role="group" aria-label="Message Actions">
                      <div className="d-msgHoverWrapper">
                        {expanded && developerMode && barButton('copy-id', 'Copy Message ID', <span className="chat-hoverBarIcon"><MenuCopyIcon /></span>, () => copyText(String(message.id)))}
                        {expanded && barButton('copy-link', 'Copy Link', <span className="chat-hoverBarIcon"><MenuLinkIcon /></span>, () => copyText(messageLinkFor(message)))}
                        {expanded && barButton('mark-unread', 'Mark Unread', <span className="chat-hoverBarIcon"><MenuMailOpenIcon /></span>, () => onMarkUnread(message))}
                        {expanded && canPinMsg && barButton('pin', pinnedMsg ? 'Unpin Message' : 'Pin Message', <PinIcon />, () => { void togglePin(message) })}
                        {expanded && canReply && canEdit && barButton('reply-self', 'Reply', <ToolbarReplyIcon />, () => startReply(message))}
                        {showReactButtons && !expanded && quickReacts.map((entry) => {
                          const reacted = Boolean(ownerKey) && (message.reactions || []).some((r) => r.emoji === entry[1] && Array.isArray(r.reactorKeys) && r.reactorKeys.includes(ownerKey!))
                          const label = reacted ? `Click to remove ${entry[0]}` : `Click to react with ${entry[0]}`
                          return (
                            <button
                              key={`quick-${entry[0]}`}
                              type="button"
                              className="d-msgHoverBarButton d-msgHoverButton chat-quickReact"
                              aria-label={label}
                              tabIndex={-1}
                              onMouseEnter={(e) => setQuickReactTip({ el: e.currentTarget, name: entry[0], remove: reacted })}
                              onMouseLeave={() => setQuickReactTip(null)}
                              onClick={() => { setQuickReactTip(null); void toggleReaction(message, entry) }}
                            >
                              <img className="emoji chat-quickReactEmoji" src={twemojiUrl(entry[3])} alt="" draggable={false} width={20} height={20} />
                            </button>
                          )
                        })}
                        {showReactButtons && !expanded && quickReacts.length > 0 && <div className="d-msgHoverSeparator" role="separator" />}
                        {showReactButtons && barButton('add-reaction', 'Add Reaction', <AddReactionIcon />, (e) => onAddReaction(message, e.currentTarget))}
                        {canReply && !canEdit && barButton('reply-other', 'Reply', <ToolbarReplyIcon />, () => startReply(message))}
                        {canEdit && barButton('edit', 'Edit', <ToolbarEditIcon />, () => startEdit(message))}
                        {canForward && barButton('forward', 'Forward', <ToolbarForwardIcon />, () => onForward(message))}
                        {expanded && canDeleteMsg && barButton('delete', 'Delete', <span className="chat-hoverBarIcon"><MenuTrashIcon /></span>, (e) => {
                          // Shift-click (the expanded bar is shown while Shift
                          // is held) deletes without the confirm, like Discord.
                          if (e.shiftKey) void confirmDelete(message)
                          else onDelete(message)
                        }, ' dangerous_f7ecac')}
                        {!(expanded && canDeleteMsg) && barButton('more', 'More', <ToolbarMoreIcon />, (e) => onMoreClick(message, e))}
                      </div>
                    </div>
                  )
                })()}
                {/* Reply reference - Discord's replied-message preview line: a
                    small "↩ @name snippet" above the message content. Rendered
                    for any message carrying replyTo; unresolved targets (target
                    not in the loaded window, or deleted) fall back to Discord's
                    "Original message was deleted" line. */}
                {/* Slash / context-menu command header ("{user} used /cmd"),
                    Discord's executedCommand line in the reply slot. */}
                <InteractionHeader
                  message={message}
                  appearance={appearance}
                  onOpenUser={(user, e) => openMention({ type: 'user', id: user.id, username: user.name }, e)}
                />
                {message.replyTo && (() => {
                  const target = resolveReplyTarget(message.replyTo, messages)
                  // repliedMessageClickableSpine - clicking the reply line (or
                  // its spine) scrolls the replied-to message into view with
                  // the same highlight flash the Inbox jump uses.
                  const jumpToTarget = target ? () => {
                    const el = listRef.current?.querySelector(`[data-message-id="${target.id}"]`)
                    if (!el) return
                    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
                    el.classList.add('jumpHighlight')
                    setTimeout(() => el.classList.remove('jumpHighlight'), 1600)
                  } : undefined
                  return (
                    <div
                      className={`messageReply${jumpToTarget ? ' clickable' : ''}`}
                      aria-label={target ? `Replying to ${target.authorName}` : 'Original message was deleted'}
                      onClick={jumpToTarget}
                    >
                      {/* Cozy shows the replied-to author's 16px avatar
                          (replyAvatar); compact - and unresolved targets -
                          show the 16px replyBadge circle with the arrow. */}
                      {appearance === 'cozy' && target ? (
                        <img
                          className="messageReplyAvatar"
                          src={target.authorAvatar || defaultAvatar(target.authorName)}
                          alt=""
                          aria-hidden="true"
                          loading="lazy"
                          onError={(e) => onAvatarError(e, target.authorName)}
                          onClick={(e) => openProfile(target, e)}
                        />
                      ) : (
                        <span className="messageReplyIcon" aria-hidden="true"><ReplyBadgeIcon /></span>
                      )}
                      {target ? (
                        <>
                          {(() => {
                            // Replied author: same username component as the
                            // header (withMentionPrefix "@"), gradient roles
                            // included, animating with the message hover.
                            const rp = roleNameProps(`@${target.authorName}`, authorStyleOf(target), target.authorColor, hoveredMsgId === message.id)
                            return (
                              <span
                                {...rp}
                                className={`messageReplyName${rp.className ? ` ${rp.className}` : ''}`}
                                onClick={(e) => openProfile(target, e)}
                                onContextMenu={(e) => onAuthorContext(target, e)}
                              />
                            )
                          })()}
                          <span className={`messageReplySnippet${!target.content && interactionReplyPlaceholder(target) ? ' messageReplyUnknown' : ''}`}>{!target.content && interactionReplyPlaceholder(target) ? interactionReplyPlaceholder(target) : <ReplyPreviewText message={target} />}</span>
                        </>
                      ) : (
                        <span className="messageReplySnippet messageReplyUnknown">Original message was deleted</span>
                      )}
                    </div>
                  )
                })()}
                {appearance === 'cozy' && groupStart && (
                  <div className="avatar">
                    {/* Real CDN avatar → Discord default → data-URI initial
                        avatar (onAvatarError), so an expired/blocked CDN hash
                        never renders the browser's broken-image icon. Clicking
                        opens the author's profile popout (like the username). */}
                    <img
                      src={message.authorAvatar || defaultAvatar(message.authorName)}
                      alt=""
                      loading="lazy"
                      onError={(e) => onAvatarError(e, message.authorName)}
                      onClick={(e) => openProfile(message, e)}
                      onContextMenu={(e) => onAuthorContext(message, e)}
                    />
                  </div>
                )}
                {/* Avatar decoration - Discord's avatarDecoration_c19a55: a
                    sibling <img> over the cozy avatar at 1.2x (48px), static
                    until the message is hovered (passthrough=true animates
                    the APNG). Cozy only (Discord drops it in compact). */}
                {appearance === 'cozy' && groupStart && authorStyleOf(message)?.decoration && (
                  <AvatarDecoration
                    asset={authorStyleOf(message)!.decoration!.asset}
                    size={48}
                    animate={hoveredMsgId === message.id}
                    className="chat-messageAvatarDecoration"
                  />
                )}
                {/* Compact gutter timestamp: plain "h:mm AM" (formatShortTime,
                    no brackets). On groupStart rows it shows always; on grouped
                    (continuation) rows Discord reveals it ONLY on row hover -
                    the CSS gates .message.grouped .timestamp on visibility so
                    the layout never shifts when it appears. */}
                {appearance === 'compact' && (
                  <span className="timestamp"><i className="chat-separator" aria-hidden="true">[</i>{formatShortTime(message.createdAt)}<i className="chat-separator" aria-hidden="true">] </i></span>
                )}
                {/* Cozy grouped (continuation) gutter timestamp: sits in the
                    72px avatar gutter (where the avatar renders on groupStart
                    rows) and is revealed ONLY on row hover - Discord's cozy
                    timestampVisibleOnHover. Absolute-positioned by CSS so it
                    never shifts the content layout when it appears. groupStart
                    rows keep the header's full "Today at h:mm" timestamp. */}
                {appearance === 'cozy' && grouped && (
                  <span className="timestamp">{formatShortTime(message.createdAt)}</span>
                )}
                <div className="message-header">
                  {/* Compact author name: groupStart rows ONLY. A grouped
                      continuation row in live Discord shows just the content
                      (plus the hover-revealed timestamp) - no username. */}
                  {/* Discord's headerText: the author name plus its badges,
                      with a .25rem trailing margin before the timestamp (cozy)
                      or the content (compact). App authors (Discord-side
                      bots/foreign webhooks with authorBot; never our own web
                      users) get the APP botTag: BEFORE the name in compact
                      (wrapped in spaces, as Discord renders decorations[0]),
                      AFTER the name and badges in cozy. The leading space is a
                      no-break space so it survives at the start of the line
                      (Discord's sits after the inline timestamp). */}
                  {(groupStart || appearance === 'compact') && (
                    <span className="headerText">
                      {appearance === 'compact' && isAppAuthor(message) && (
                        <>{' '}<BotTag compact />{' '}</>
                      )}
                      {/* Username (Discord's username_c19a55): gradient /
                          holographic role styles animate while the message is
                          hovered; display-name font when set. Followed by the
                          server-tag chiplet, then the badges (role badge,
                          new-member badge), then cozy's APP tag. */}
                      {(() => {
                        const style = authorStyleOf(message)
                        const nameProps = roleNameProps(message.authorName, style, message.authorColor, hoveredMsgId === message.id)
                        return (
                          <>
                            <span
                              {...nameProps}
                              className={`name${nameProps.className ? ` ${nameProps.className}` : ''}`}
                              data-username-has-gradient={style?.colors ? true : undefined}
                              onClick={(e) => openProfile(message, e)}
                              onContextMenu={(e) => onAuthorContext(message, e)}
                            />
                            {style?.guildTag && <GuildTagChiplet tag={style.guildTag} compact={appearance === 'compact'} channelId={activeChannelId} />}
                            {message.authorRole && <span className={`bot role-badge role-${message.authorRole}`}>{message.authorRole}</span>}
                            {isNewMember(style, message.authorBot) && (
                              <NewMemberBadge
                                username={message.authorName}
                                onMention={() => mentionUser(message.authorName, discordAuthorId(message))}
                              />
                            )}
                          </>
                        )
                      })()}
                      {appearance === 'cozy' && isAppAuthor(message) && <BotTag compact={false} />}
                    </span>
                  )}
                  {/* Compact mode: Discord renders "Name content" - the author
                      name (+ any badge), then the content with a small gap (the
                      name's margin-right). Cozy uses a trailing timestamp. The
                      separator space is groupStart-only: a grouped continuation
                      row is bare content (no name, no gap). */}
                  {appearance === 'compact' && <><i className="chat-separator">:</i>{' '}</>}
                  {appearance === 'cozy' && groupStart && (
                    <span className="timestamp"><i className="chat-separator" aria-hidden="true"> - </i>{formatTimestamp(message.createdAt)}</span>
                  )}
                  {editingMsgId === message.id ? (
                    <MessageEditor
                      ref={editorRef}
                      message={message}
                      compact={appearance === 'compact'}
                      saving={editSaving}
                      maxLength={CHAT_MAX_LENGTH}
                      counterThreshold={CHAT_COUNTER_THRESHOLD}
                      channelName={editorChannelName}
                      fetchSuggestions={editorFetchSuggestions}
                      buildItems={buildMentionItems}
                      onSave={(content) => {
                        void saveEdit(content)
                        // Back to the composer (Discord refocuses the channel
                        // text area) unless the delete confirm takes over.
                        if (content.trim()) requestAnimationFrame(() => inputRef.current?.focus())
                      }}
                      onCancel={() => { cancelEdit(); requestAnimationFrame(() => inputRef.current?.focus()) }}
                      onOpenEmoji={openEditEmoji}
                      onMentionContext={(item, e) => onMentionSuggestionContextItem(item, e)}
                    />
                  ) : (
                    <MessageBody
                      message={message}
                      onOpenMention={openMention}
                      onContextAction={(action, e) => {
                        // Right-click on an element inside the content takes
                        // priority over the message-row menu (the delegated
                        // handlers stopPropagation, so the row menu never
                        // opens for these).
                        if (action.kind === 'link' || action.kind === 'image') onMessageMediaContext(message, action.kind, action.url, e)
                        else if (action.kind === 'emoji') onContentEmojiContext(message, action.name, action.surrogates, e)
                        else if (action.kind === 'code') onCodeContext(action.code, e)
                      }}
                    />
                  )}
                </div>
                {/* Reactions row (Discord's reactions__23977 in the message
                    accessories): one pill per emoji (reaction + reactionInner,
                    reactionMe when the caller reacted) with the 20px emoji and
                    the count of real reactors (never the bot); clicking toggles
                    the caller's reaction. Block-level sibling AFTER the
                    header/content, never inside .message-header (inline in
                    compact). */}
                {message.reactions && message.reactions.length > 0 && (
                  <div className="reactions" role="group">
                    {message.reactions.map((reaction) => {
                      const entry = allEmoji.find((e) => e[1] === reaction.emoji) || allEmoji.find((e) => e[0] === reaction.emoji)
                      const reacted = perms?.ownerKey && Array.isArray(reaction.reactorKeys) ? reaction.reactorKeys.includes(perms.ownerKey) : false
                      const label = entry ? entry[0].replace(/_/g, ' ') : reaction.emoji
                      return (
                        <ReactionPill
                          key={reaction.emoji}
                          messageId={message.id}
                          reaction={reaction}
                          reacted={Boolean(reacted)}
                          className={`reaction reactionInner${reacted ? ' reactionMe' : ''}`}
                          onClick={() => entry && void toggleReaction(message, entry)}
                          onContextMenu={(e) => onReactionContext(message, reaction, entry, e)}
                          onOpenReactors={(el) => openReactors(message.id, reaction.emoji, el)}
                          ariaLabel={`${label}, ${reaction.count} reaction${reaction.count === 1 ? '' : 's'}, press to react`}
                          ariaPressed={Boolean(reacted)}
                        >
                          {entry ? <Emoji entry={entry} size={20} /> : <span className="emoji-text">{reaction.emoji}</span>}
                          <span className="reactionCount">{reaction.count}</span>
                        </ReactionPill>
                      )
                    })}
                    {/* Discord's trailing add-reaction button: reactionBtn,
                        revealed on message hover/focus, with the 18px
                        ReactionIcon smiley.
                        Clicking arms react mode + opens the picker
                        (onAddReaction, same as the hover toolbar button). */}
                    {showReactButtons && (
                      <button
                        type="button"
                        className={`reactionBtn${emojiMenuOpen && reactTarget?.id === message.id && reactAnchor?.el.classList.contains('reactionBtn') ? ' active' : ''}`}
                        aria-label="Add Reaction"
                        title="Add Reaction"
                        onClick={(e) => onAddReaction(message, e.currentTarget)}
                      >
                        <ReactionBarIcon />
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
            // An open post's starter message carries the post's tags row
            // (Discord's nonMessageContent under the starter).
            if (!activePost || !(message.starter || message.discordMessageId === activePost.id)) return rowEl
            return <Fragment key={row.key}>{rowEl}<ForumPostTagsRow post={activePost} forum={postForum} /></Fragment>
          })}
          {!loading && activeChannelId && messages.length > 0 && hasMoreAfter && (
            <div className="chat-history-edge bottom" aria-hidden="true">
              <MessageSkeleton appearance={appearance} />
            </div>
          )}
          </div>
        </div>

        {/* Jump-to-present bar - Discord's jumpToPresentBar__0f481 (tH, type
            OLD_MESSAGES) inside messagesWrapper: barButtonMain label + a
            Mana primary/sm "Jump To Present" button; the button becomes the
            pulsing ellipsis while the jump fetch runs. Rendered ONLY while
            the window is detached from the present (hasMoreAfter), never
            just because the list is scrolled up. The zero-height anchor sits
            at the message scroller's bottom edge (= messagesWrapper bottom),
            which the bar's bottom:28px is measured from. */}
        <div className="jumpToPresentAnchor">
          {hasMoreAfter && activeChannelId && !loading && (
            <div
              className="jumpToPresent jumpToPresentBar chatBarBase chatBottomBar"
              onClick={jumpLoading ? undefined : (e) => { e.stopPropagation(); void jumpToPresent() }}
            >
              <div className="chatBarButtonMain">You&apos;re Viewing Older Messages</div>
              {jumpLoading ? (
                <span className="chatBarSpinner" aria-label="Loading">
                  <span className="chatBarSpinnerItem" />
                  <span className="chatBarSpinnerItem" />
                  <span className="chatBarSpinnerItem" />
                </span>
              ) : (
                <button
                  type="button"
                  className="manaButton manaPrimary manaSm jumpToPresentAction"
                  onClick={(e) => { e.stopPropagation(); void jumpToPresent() }}
                >
                  <span className="manaButtonChildren"><HolyText text="Jump To Present" /></span>
                </button>
              )}
            </div>
          )}
        </div>

        {emojiMenuOpen && !composerDisabled && !activeChannelReadOnly && (
          <ExpressionPicker
            klipyKey={klipyKey}
            canSendEmbeds={canSendEmbeds}
            guildName={activeGuildName}
            guildIcon={activeGuildIcon}
            initialTab={pickerTab}
            reaction={Boolean(reactTarget)}
            onPickEmoji={pickEmoji}
            // GIFs/stickers can't be added to an edit - only the composer's
            // picker sends them.
            onPickGif={(full) => { if (editPickerAnchor) setEmojiMenuOpen(false); else void sendEmbed(full) }}
            onPickSticker={(full) => { if (editPickerAnchor) setEmojiMenuOpen(false); else void sendEmbed(full) }}
            onClose={() => { setEmojiMenuOpen(false); setReactTarget(null); setEditPickerAnchor(null) }}
            onContextAction={onPickerContext}
            anchor={reactTarget && reactAnchor ? reactAnchor.el : editPickerAnchor ?? COMPOSER_PICKER_ANCHOR}
            placement={reactTarget && reactAnchor ? reactAnchor.placement : COMPOSER_PICKER_PLACEMENT}
          />
        )}

        {verifyBlocksSending ? <VerificationCard hasEmail={Boolean(user?.email)} onResent={() => setError(null)} /> : (
        <Composer
          ref={inputRef}
          replyBar={replyTo && !activeChannelReadOnly ? {
            authorName: replyTo.authorName,
            showMentionToggle: !replyTo.self,
            mention: replyMention,
            onToggleMention: () => setReplyMention((on) => !on),
            onCancel: cancelReply,
            onJump: () => {
              const el = listRef.current?.querySelector(`[data-message-id="${replyTo.id}"]`)
              el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
            },
          } : undefined}
          mentionAutocomplete={mentionOpen ? {
            items: mentionItems,
            activeIndex: mentionIndex,
            onSelect: insertMention,
            onHover: setMentionIndex,
            onContext: onMentionSuggestionContext,
          } : undefined}
          placeholder={inputPlaceholder}
          disabled={composerDisabled}
          sending={sending}
          // GIF/Sticker buttons render only when the picker's GIF/sticker
          // tabs would actually work (same gate as ExpressionPicker: embed
          // permission + a KLIPY key) - Discord hides what you can't use.
          canGifs={!composerDisabled && canSendEmbeds && Boolean(klipyKey)}
          canStickers={!composerDisabled && canSendEmbeds && Boolean(klipyKey)}
          locked={activePost ? postLocked && !perms?.canManagePosts : channelLocked && !isStaff}
          lockedText={activePost ? 'This post is locked.' : undefined}
          notice={activePost && (postPending || postArchived || (postLocked && perms?.canManagePosts)) ? (
            <div className="dcfPostNotice" role="note">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" clipRule="evenodd" d="M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22Zm1.44-15.94L13.06 14a1.06 1.06 0 0 1-2.12 0l-.38-6.94a1 1 0 0 1 1-1.06h.88a1 1 0 0 1 1 1.06Zm-.19 10.69a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z" /></svg>
              <HolyText text={postPending
                ? 'This post has not reached Discord yet.'
                : postLocked
                  ? 'This post is locked. Only moderators can reply.'
                  : 'This post is closed. Sending a message will reopen it.'} />
            </div>
          ) : undefined}
          hasContent={composerLength > 0}
          charCount={composerLength}
          maxLength={CHAT_MAX_LENGTH}
          counterThreshold={CHAT_COUNTER_THRESHOLD}
          onSubmit={submit}
          onKeyDown={onInputKeyDown}
          onInput={(el) => {
            setComposerLength(serializeComposer(el).length)
            // A composer left holding only a stray <br> (last chip deleted)
            // is cleared outright so the :empty placeholder reappears.
            normalizeEmpty(el)
            updateMentionTrigger(el)
          }}
          onPaste={(el, e) => {
            pastePlainText(e.nativeEvent, el)
            setComposerLength(serializeComposer(el).length)
          }}
          onOpenEmoji={() => { setReactTarget(null); setEditPickerAnchor(null); openPicker('emoji') }}
          onOpenGifs={() => { setReactTarget(null); openPicker('gifs') }}
          onOpenStickers={() => { setReactTarget(null); openPicker('stickers') }}
          // Discord's typing indicator lives inside the form, in the strip
          // directly above the chat bar (see Composer's TypingIndicator).
          typingNames={typingNames}
        />
        )}
        </>)}
        {/* Discord's search results sidebar (searchResultsWrap, 418px). */}
        <SearchResults
          search={search}
          renderBody={(m) => <MessageBody message={m} onOpenMention={openMention} />}
          avatarSrc={(m) => m.authorAvatar || defaultAvatar(m.authorName)}
          onAvatarError={onAvatarError}
          formatTimestamp={formatTimestamp}
          onJump={(m) => jumpToMessage(m.channelId, m.id)}
          onContext={(m, e) => onFoundMessageContext(m, () => jumpToMessage(m.channelId, m.id), e)}
          channelKind={(id) => channelIconKinds.get(id) || 'text'}
          onSelectChannel={(id) => { if (!openChannel(id)) setActiveChannelId(id) }}
        />
      </main>


      {profile && (
        <ProfilePopout
          profile={profile}
          channelId={activeChannelId}
          guildName={activeGuildName}
          guildIcon={activeGuildIcon}
          onClose={closeProfile}
          onContextMenu={onProfileContext}
          renderStatus={(status) => <StatusIcon status={status} />}
          self={profile.kind === 'self' ? {
            presence: ownShown,
            choice: presence,
            onPickStatus: pickStatus,
            onEditProfile: () => { setProfile(null); navigateTo('account') },
            onCopyId: (siteId) => { copyText(siteId); setProfile(null) },
            onSignIn: () => { setProfile(null); setShowAuth(true) },
          } : undefined}
        />
      )}

      {reactorsPopout && (() => {
        const live = messages.find((m) => m.id === reactorsPopout.messageId)
        if (!live || !(live.reactions || []).length) return null
        return (
          <ReactorsPopout
            messageId={live.id}
            reactions={live.reactions || []}
            emoji={reactorsPopout.emoji}
            anchor={reactorsPopout.anchor}
            onSelectEmoji={(emoji) => setReactorsPopout((cur) => (cur ? { ...cur, emoji } : cur))}
            onOpenProfile={openReactorProfile}
          />
        )
      })()}

      {/* Role-mention popout - a clicked @role lists the members holding it. */}
      {/* Anchored like the user-mention profile popout (Discord Popout
          position "right", align "top", spacing 8; inverts left at the edge). */}
      {rolePopout && (
        <Popout anchor={rolePopout.anchor} position="right" align="top" spacing={8}>{(ref) => (
        <div
          ref={ref}
          className="rolePopout"
          role="dialog"
          aria-label={`@${rolePopout.name}`}
        >
          <div className="rolePopoutHeader">
            <span className="rolePopoutDot" style={{ backgroundColor: rolePopout.color || 'var(--interactive-muted)' }} aria-hidden="true" />
            <span className="rolePopoutName">{rolePopout.name}</span>
            {rolePopout.data && <span className="rolePopoutCount">{rolePopout.data.total}</span>}
          </div>
          <div className="rolePopoutBody">
            {rolePopout.error ? (
              <div className="rolePopoutEmpty">{rolePopout.error}</div>
            ) : !rolePopout.data ? (
              <div className="rolePopoutEmpty">Loading…</div>
            ) : rolePopout.data.members.length === 0 ? (
              <div className="rolePopoutEmpty"><HolyText text="No members have this role." /></div>
            ) : (
              <ul className="rolePopoutList">
                {rolePopout.data.members.map((m) => (
                  <li key={m.userId} className="rolePopoutMember">
                    <img src={m.avatar} alt="" loading="lazy" />
                    <span className="rolePopoutMemberName" style={rolePopout.color ? { color: rolePopout.color } : undefined}>{m.displayName}</span>
                    {/* Web identity holding the role via its effective roles
                        (onboarding grant / perk floor), not a Discord member. */}
                    {m.webhook && <span className="bot rolePopoutWebhookTag" title="Website user (webhook)">WEBHOOK</span>}
                  </li>
                ))}
                {rolePopout.data.total > rolePopout.data.members.length && (
                  <li className="rolePopoutMore">and {rolePopout.data.total - rolePopout.data.members.length} more</li>
                )}
              </ul>
            )}
          </div>
        </div>
        )}</Popout>
      )}

      {/* Guild-rail rich tooltip (hover) and context menu (right-click). */}
      {guildTip && (() => {
        const guild = guildTip.guildId === 'community'
          ? { id: 'community', name: 'Community', icon: null }
          : guilds.find((g) => g.id === guildTip.guildId)
        return guild ? <GuildTooltip guild={guild} anchorY={guildTip.anchorY} muted={Boolean(mutedGuilds[guild.id])} /> : null
      })()}
      {guildMenu && (
        <ContextMenu
          x={guildMenu.x}
          y={guildMenu.y}
          anchor={guildMenu.anchored ? GUILD_HEADER_MENU_ANCHOR : undefined}
          anchorOptions={GUILD_HEADER_MENU_PLACEMENT}
          layerClassName={guildMenu.anchored ? 'guildHeaderMenu' : undefined}
          entries={guildMenu.anchored ? guildHeaderMenuEntries(guildMenu.guildId) : guildMenuEntries(guildMenu.guildId)}
          onClose={() => setGuildMenu(null)}
          ariaLabel="Server Actions"
        />
      )}
      {guildNotifModal && (
        <GuildNotificationsModal
          guildId={guildNotifModal}
          guildName={guilds.find((g) => g.id === guildNotifModal)?.name || 'Community'}
          notif={notif}
          channels={channelsByGuild[guildNotifModal]?.channels ?? EMPTY_CHANNELS}
          categories={channelsByGuild[guildNotifModal]?.categories ?? EMPTY_CATEGORIES}
          onClose={() => setGuildNotifModal(null)}
        />
      )}

      {/* Message action menu - Discord's "More" ⋯ / right-click context menu.
          Opened by the hover toolbar's More button (anchored to it) or by
          right-clicking the message row (anchored to the cursor). */}
      {msgMenu && (
        <ContextMenu
          x={msgMenu.x}
          y={msgMenu.y}
          anchor={msgMenu.anchor}
          anchorOptions={MSG_MORE_MENU_PLACEMENT}
          entries={msgMenuEntries(msgMenu.message)}
          onClose={() => setMsgMenu(null)}
          ariaLabel="Message Actions"
          layerClassName="msgContextMenu"
        />
      )}

      {/* Element context menu - channel rows, authors, content links/images/
          emoji/code, reaction chips, the user-panel avatar, and the channel
          header all land here (one slot; the opener builds the entries). */}
      {elemMenu && (
        <ContextMenu
          x={elemMenu.x}
          y={elemMenu.y}
          entries={elemMenu.entries}
          onClose={() => setElemMenu(null)}
          ariaLabel={elemMenu.ariaLabel}
        />
      )}

      {/* Delete confirmation - Discord's "Delete Message" modal: header +
          "Are you sure you want to delete this message?" + the message preview,
          with Cancel / Delete (danger) in the footer. */}
      {postModal && (
        <PostActionModal
          kind={postModal.kind}
          post={postModal.post}
          forum={allChannels.get(postModal.post.forumId) ?? null}
          onClose={() => setPostModal(null)}
          onDone={(res) => {
            if (res.deleted && openPostRef.current?.id === postModal.post.id) { setOpenPost(null); setActiveChannelId(postModal.post.forumId) }
            else if (res.post && openPostRef.current?.id === res.post.id) setOpenPost(res.post)
          }}
        />
      )}
      {deleteTarget && (
        <div
          className="deleteConfirmBackdrop"
          role="presentation"
          {...backdropDismissProps(() => { if (!deleting) setDeleteTarget(null) })}
        >
          <div
            className="deleteConfirm"
            role="dialog"
            aria-modal="true"
            aria-label="Delete Message"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === 'Escape' && !deleting) setDeleteTarget(null) }}
          >
            <div className="deleteConfirmHeader">
              <h2 className="deleteConfirmTitle"><HolyText text="Delete Message" /></h2>
              <div className="deleteConfirmSub"><HolyText text="Are you sure you want to delete this message?" /></div>
            </div>
            <div className="deleteConfirmPreview">
              <div className="message groupStart">
                <div className="avatar">
                  <img src={deleteTarget.authorAvatar || defaultAvatar(deleteTarget.authorName)} alt="" />
                </div>
                <div className="message-header">
                  <span
                    className="name"
                    style={deleteTarget.authorColor ? { color: deleteTarget.authorColor } : undefined}
                  >
                    {deleteTarget.authorName}
                  </span>
                  <span className="timestamp">{formatTimestamp(deleteTarget.createdAt)}</span>
                  <MessageBody message={deleteTarget} onContextAction={(action, e) => {
                    if (action.kind === 'link') onContentLinkContext(action.url, e)
                    else if (action.kind === 'image') onImageContext(action.url, e)
                    else if (action.kind === 'emoji') onContentEmojiContext(deleteTarget, action.name, action.surrogates, e)
                    else if (action.kind === 'code') onCodeContext(action.code, e)
                  }} />
                </div>
              </div>
            </div>
            <div className="deleteConfirmFooter">
              <button
                type="button"
                className="deleteConfirmCancel"
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="deleteConfirmDelete"
                disabled={deleting}
                onClick={() => void confirmDelete(deleteTarget)}
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Member moderation - Discord's Timeout / Ban modals, for any webhook
          identity (web-only, linked, or Discord). */}
      {/* Server Onboarding (Onboarding.tsx): Discord's onboarding flow for a
          new web identity; refetches the sidebar when its opt-ins change. */}
      <OnboardingGate
        signedIn={Boolean(user)}
        guild={activeGuild}
        onboarding={onboarding}
        onChannelsChanged={() => { if (onboarding.guildId) loadGuildChannels(onboarding.guildId) }}
        // The default channel may not be in the refetching sidebar yet: it's
        // in the onboarded (open) guild either way.
        onNavigateChannel={(id) => { if (!openChannel(id)) setActiveChannelId(id) }}
      />
      {modModal && (
        <ModerationModal
          kind={modModal.kind}
          target={modModal.target}
          backdropProps={backdropDismissProps(() => setModModal(null))}
          onCancel={() => setModModal(null)}
          onConfirm={async ({ seconds, reason }) => {
            if (modModal.kind === 'timeout') await runModeration(modModal.channelId, modModal.target.key, 'timeout', { seconds, reason })
            else await runModeration(modModal.channelId, modModal.target.key, 'ban', { reason })
            setModModal(null)
          }}
        />
      )}

      {/* Forward Message - Discord's forward modal: a static preview of the
          message on top, then the bridged channel list with a per-row Send
          button (Sent once delivered), and Cancel in the footer. Sending to
          the current channel is allowed (Discord lets you forward into the
          same channel). */}
      {forwardTarget && (
        <div
          className="forwardDialogBackdrop"
          role="presentation"
          {...backdropDismissProps(() => { if (!forwardingTo) setForwardTarget(null) })}
        >
          <div
            className="forwardDialog"
            role="dialog"
            aria-modal="true"
            aria-label="Forward Message"
            onClick={(e) => e.stopPropagation()}
            tabIndex={-1}
            ref={(el) => { if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true }) }}
            onKeyDown={(e) => { if (e.key === 'Escape' && !forwardingTo) setForwardTarget(null) }}
          >
            <div className="forwardDialogHeader">
              <h2 className="forwardDialogTitle"><HolyText text="Forward Message" /></h2>
              <div className="forwardDialogSub"><HolyText text="Select a channel to forward this message to." /></div>
            </div>
            <div className="forwardDialogPreview">
              <div className="message groupStart">
                <div className="avatar">
                  <img src={forwardTarget.authorAvatar || defaultAvatar(forwardTarget.authorName)} alt="" />
                </div>
                <div className="message-header">
                  <span
                    className="name"
                    style={forwardTarget.authorColor ? { color: forwardTarget.authorColor } : undefined}
                  >
                    {forwardTarget.authorName}
                  </span>
                  <span className="timestamp">{formatTimestamp(forwardTarget.createdAt)}</span>
                  <MessageBody message={forwardTarget} onContextAction={(action, e) => {
                    if (action.kind === 'link') onContentLinkContext(action.url, e)
                    else if (action.kind === 'image') onImageContext(action.url, e)
                    else if (action.kind === 'emoji') onContentEmojiContext(forwardTarget, action.name, action.surrogates, e)
                    else if (action.kind === 'code') onCodeContext(action.code, e)
                  }} />
                </div>
              </div>
            </div>
            <div className="forwardDialogChannels" role="list">
              {/* Only bridged channels accept writes - read-only (non-bridged)
                  channels are never offered as forward destinations; the
                  server's /forward gate rejects them regardless. */}
              {forwardChannels.map((c) => {
                const sent = forwardedTo.includes(c.channelId)
                const busy = forwardingTo === c.channelId
                return (
                  <div key={c.channelId} className="forwardDialogChannel" role="listitem" onContextMenu={(e) => onForwardChannelContext(c.channelId, e)}>
                    <span className="forwardDialogChannelHash" aria-hidden="true"><ChannelTypeIcon kind={channelIconKind(c.type, c.channelId === activeGuild?.rulesChannelId)} size={20} /></span>
                    <span className="forwardDialogChannelName">{c.name}</span>
                    <button
                      type="button"
                      className={`forwardDialogSend${sent ? ' sent' : ''}`}
                      disabled={sent || forwardingTo !== null}
                      onClick={() => void confirmForward(c.channelId)}
                    >
                      {sent ? 'Sent' : busy ? 'Sending…' : 'Send'}
                    </button>
                  </div>
                )
              })}
              {forwardChannels.length === 0 && (
                <div className="forwardDialogEmpty"><HolyText text="No channels available." /></div>
              )}
            </div>
            <div className="forwardDialogFooter">
              <button
                type="button"
                className="forwardDialogCancel"
                disabled={forwardingTo !== null}
                onClick={() => setForwardTarget(null)}
              >
                {forwardedTo.length ? 'Done' : 'Cancel'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showAuth && (
        <AuthModal
          icon={<AuthChatIcon />}
          title="Join the conversation"
          subtitle="Sign in to chat with the community."
          onClose={() => setShowAuth(false)}
          onDone={(u) => { setUser(u); setShowAuth(false) }}
        />
      )}
    </div>
  )
}

