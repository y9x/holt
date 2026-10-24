import { BioText } from './BioText'
import { HolyText } from '../../components/common/HolyText'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { usePopoutPosition } from './popout'
import { popoutLayer } from './overlay'
import { bridgeProfile, bridgeSelfProfile, bridgeWebhookProfile, type BridgeProfile, type BridgeSelfProfile, type BridgeWebhookProfile } from '../../lib/bridge'
import { subscribeRt } from '../../lib/rt'
import { AvatarDecoration, GuildTagChiplet, dnsFontClass, primeAuthorStyle, roleDotStyle, WEB_IDENTITY_KEY } from './author-style'
import { PRESENCE_TEXT, presenceGlyph, usePublicPresence } from './presence'

/* Discord's bite-size user profile popout (.outer_c0bea0.user-profile-popout,
 * 300px) and, for the signed-in user, the account popout opened from the user
 * panel. Read-only toward other users: the bridge has no DMs or friends, so
 * the Message composer, Add Friend, and the "…" menu's DM/friend/block entries
 * are deliberately absent. Everything rendered is real data - message fields
 * immediately, then the Discord member record (roles, dates, banner) from the
 * bridge `profile` endpoint for Discord-side users. Webhook (web) authors -
 * and the signed-in user's own account popout - load the bridge
 * `webhook-profile` record: the roles they EFFECTIVELY hold (tier/perk chat
 * roles, onboarding grants, or a linked member's real roles) rendered exactly
 * like Discord member roles, and the site join date as "Member Since". No
 * Discord identity is ever shown for an unlinked web author. */

export type PresenceValue = 'online' | 'idle' | 'dnd' | 'invisible'

export interface ProfileData {
  kind: 'user' | 'self'
  /** Discord snowflake for Discord-side users / the signed-in user's linked account. */
  discordId: string | null
  /** Webhook key ('user:<siteId>' / 'discord:<id>') - the moderation target. */
  authorKey?: string | null
  authorName: string
  /** Secondary handle line (Discord username). Falls back to authorName. */
  username?: string | null
  authorAvatar: string | null
  /** The same deterministic default avatar the message row shows. */
  fallbackAvatar?: string | null
  authorColor: string | null
  authorRole: 'mod' | 'admin' | 'owner' | null
  direction: 'web' | 'discord'
  /** Element that opened the popout (toggle target + scroll-away tracking). */
  anchorEl: Element | null
  /** Viewport rect of the anchor at open time. */
  anchorRect: { top: number; left: number; right: number; bottom: number }
  /** 'right' = Discord's message/mention placement; 'top' = account popout. */
  placement: 'right' | 'top'
}

export interface SelfPopoutProps {
  /** What the owner's sockets show right now (offline when none). */
  presence: PresenceValue | 'offline'
  /** The stored Set Status choice (the picker's selection). */
  choice: PresenceValue
  onPickStatus: (status: PresenceValue) => void
  onEditProfile: () => void
  /** Copies the site account id (never a guild or Discord id). */
  onCopyId: ((siteId: string) => void) | null
  onSignIn: () => void
}

const profileCache = new Map<string, BridgeProfile | null>()
// Webhook profiles change with perks / onboarding answers: short client TTL.
const webhookProfileCache = new Map<string, { at: number; data: BridgeWebhookProfile | null }>()
const WEBHOOK_PROFILE_TTL_MS = 30_000
// The self popout is site-side only (no channel): one shared record per tab.
let selfProfileCache: { at: number; data: BridgeSelfProfile } | null = null
const SELF_PROFILE_TTL_MS = 30_000
const colorCache = new Map<string, string | null>()

const STATUS_LABELS: Array<[PresenceValue, string]> = [
  ['online', 'Online'],
  ['idle', 'Idle'],
  ['dnd', 'Do Not Disturb'],
  ['invisible', 'Invisible'],
]

// Discord paints a banner-less profile with the avatar's dominant color. Same
// idea here: downsample to 32x32, bucket each opaque pixel to 4 bits/channel,
// and average the members of the most populated bucket.
function dominantColor(src: string): Promise<string | null> {
  if (colorCache.has(src)) return Promise.resolve(colorCache.get(src) ?? null)
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 32
        canvas.height = 32
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) throw new Error('no ctx')
        ctx.drawImage(img, 0, 0, 32, 32)
        const data = ctx.getImageData(0, 0, 32, 32).data
        const buckets = new Map<number, [number, number, number, number]>()
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 128) continue
          const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4)
          const b = buckets.get(key) || [0, 0, 0, 0]
          b[0] += data[i]; b[1] += data[i + 1]; b[2] += data[i + 2]; b[3] += 1
          buckets.set(key, b)
        }
        let best: [number, number, number, number] | null = null
        for (const b of buckets.values()) if (!best || b[3] > best[3]) best = b
        const hex = best
          ? `#${[best[0], best[1], best[2]].map((v) => Math.round(v / best![3]).toString(16).padStart(2, '0')).join('')}`
          : null
        colorCache.set(src, hex)
        resolve(hex)
      } catch {
        colorCache.set(src, null)
        resolve(null)
      }
    }
    img.onerror = () => { colorCache.set(src, null); resolve(null) }
    img.src = src
  })
}

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function DiscordMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M19.73 4.87a18.2 18.2 0 0 0-4.6-1.44c-.21.4-.4.8-.58 1.21-1.69-.25-3.4-.25-5.1 0-.18-.41-.37-.82-.59-1.2-1.6.27-3.14.75-4.6 1.43A19.04 19.04 0 0 0 .96 17.7a18.43 18.43 0 0 0 5.63 2.87c.46-.62.86-1.28 1.2-1.98-.65-.25-1.29-.55-1.9-.92.17-.12.32-.24.47-.37 3.58 1.7 7.7 1.7 11.28 0l.46.37c-.6.36-1.25.67-1.9.92.35.7.75 1.35 1.2 1.98 2.03-.63 3.94-1.6 5.64-2.87.47-4.87-.78-9.09-3.3-12.83ZM8.3 15.12c-1.1 0-2-1.02-2-2.27 0-1.24.88-2.26 2-2.26s2.02 1.02 2 2.26c0 1.25-.89 2.27-2 2.27Zm7.4 0c-1.1 0-2-1.02-2-2.27 0-1.24.88-2.26 2-2.26s2.02 1.02 2 2.26c0 1.25-.88 2.27-2 2.27Z" />
    </svg>
  )
}

// Globe for the self popout's "Member Since" site row (Discord's GlobeEarthIcon
// path, from discord-assets js/web.d3978f1210c00a8f.js). Used instead of a guild
// icon, so the self popout never shows a server identity.
function GlobeMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d="M23 12a11 11 0 1 1-22 0 11 11 0 0 1 22 0Zm-4.16 5.85A9 9 0 0 0 15 3.52V4a3 3 0 0 1-3 3h-.77c-.13 0-.23.1-.23.23A2.77 2.77 0 0 1 8.23 10c-.13 0-.23.1-.23.23v1.52c0 .14.11.25.25.25H13a3 3 0 0 1 3 3v.77c0 .13.1.23.23.23 1.2 0 2.23.77 2.61 1.85ZM3.18 10.18A9 9 0 0 0 11 20.94v-2.7c0-.14-.1-.24-.23-.24h-.65A2.12 2.12 0 0 1 8 15.88c0-.56-.22-1.1-.62-1.5l-4.2-4.2Z" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="m13.96 5.46 4.58 4.58a1 1 0 0 0 1.42 0l1.38-1.38a2 2 0 0 0 0-2.82l-3.18-3.18a2 2 0 0 0-2.82 0l-1.38 1.38a1 1 0 0 0 0 1.42ZM2.11 20.16l.73-4.22a3 3 0 0 1 .83-1.61l7.87-7.87a1 1 0 0 1 1.42 0l4.58 4.58a1 1 0 0 1 0 1.42l-7.87 7.87a3 3 0 0 1-1.6.83l-4.23.73a1.5 1.5 0 0 1-1.73-1.73Z" />
    </svg>
  )
}

function IdIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" fillRule="evenodd" d="M15.3 14.48c-.46.45-1.08.67-1.86.67h-1.39V9.2h1.39c.78 0 1.4.22 1.86.67.46.45.68 1.22.68 2.31 0 1.1-.22 1.86-.68 2.31Z" />
      <path fill="currentColor" fillRule="evenodd" d="M5 2a3 3 0 0 0-3 3v14a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V5a3 3 0 0 0-3-3H5Zm1 15h2.04V7.34H6V17Zm4-9.66V17h3.44c1.46 0 2.6-.42 3.38-1.25.8-.83 1.2-2.02 1.2-3.58s-.4-2.75-1.2-3.58c-.79-.83-1.92-1.25-3.38-1.25H10Z" />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M9.3 5.3a1 1 0 0 0 0 1.4l5.29 5.3-5.3 5.3a1 1 0 1 0 1.42 1.4l6-6a1 1 0 0 0 0-1.4l-6-6a1 1 0 0 0-1.42 0Z" />
    </svg>
  )
}

export function ProfilePopout({ profile, channelId, guildName, guildIcon, onClose, onContextMenu, renderStatus, self }: {
  profile: ProfileData
  channelId: string | null
  guildName: string
  guildIcon: string | null
  onClose: () => void
  onContextMenu: (profile: ProfileData, data: { userId: string; displayName: string } | null, e: React.MouseEvent) => void
  renderStatus: (status: PresenceValue) => ReactNode
  self?: SelfPopoutProps
}) {
  const ref = useRef<HTMLDivElement>(null)
  const isSelf = profile.kind === 'self'
  // The self popout never uses the channel-scoped member record.
  const cacheKey = !isSelf && profile.discordId && channelId ? `${channelId}:${profile.discordId}` : null
  const [data, setData] = useState<BridgeProfile | null>(() => (cacheKey ? profileCache.get(cacheKey) ?? null : null))
  const [loaded, setLoaded] = useState(() => !cacheKey || profileCache.has(cacheKey))
  const [bannerColor, setBannerColor] = useState<string | null>(null)
  const [statusMenu, setStatusMenu] = useState(false)
  const statusCloseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Discord member record (roles, dates, banner) for Discord-side users.
  useEffect(() => {
    if (!cacheKey || !profile.discordId || !channelId) return
    if (profileCache.has(cacheKey)) { setData(profileCache.get(cacheKey) ?? null); setLoaded(true); return }
    let alive = true
    const userId = profile.discordId
    bridgeProfile(channelId, userId)
      .then((p) => {
        profileCache.set(cacheKey, p)
        // The popout's fresh REST-backed cosmetics also refresh the message
        // rows' author style (gradient name, decoration, server tag).
        primeAuthorStyle(channelId, userId, p.style)
        if (alive) { setData(p); setLoaded(true) }
      })
      .catch(() => { if (alive) setLoaded(true) })
    return () => { alive = false }
  }, [cacheKey, channelId, profile.discordId])

  // Web (webhook) identity record: a web author's identity key (WEB_IDENTITY_KEY), or
  // 'self' for the account popout (works for unlinked accounts too).
  const webhookKey = !isSelf && profile.direction === 'web' && WEB_IDENTITY_KEY.test(profile.authorKey || '') ? profile.authorKey! : null
  const webhookCacheKey = webhookKey && channelId ? `${channelId}:${webhookKey}` : null
  const freshWebhook = (k: string | null) => {
    const hit = k ? webhookProfileCache.get(k) : undefined
    return hit && Date.now() - hit.at < WEBHOOK_PROFILE_TTL_MS ? hit : null
  }
  const [webhookData, setWebhookData] = useState<BridgeWebhookProfile | null>(() => freshWebhook(webhookCacheKey)?.data ?? null)
  const [webhookLoaded, setWebhookLoaded] = useState(() => !webhookCacheKey || Boolean(freshWebhook(webhookCacheKey)))
  useEffect(() => {
    if (!webhookCacheKey || !webhookKey || !channelId) return
    const hit = freshWebhook(webhookCacheKey)
    if (hit) { setWebhookData(hit.data); setWebhookLoaded(true); return }
    let alive = true
    bridgeWebhookProfile(channelId, webhookKey)
      .then((p) => {
        webhookProfileCache.set(webhookCacheKey, { at: Date.now(), data: p })
        if (alive) { setWebhookData(p); setWebhookLoaded(true) }
      })
      .catch(() => { if (alive) setWebhookLoaded(true) })
    return () => { alive = false }
  }, [webhookCacheKey, webhookKey, channelId])
  // Public presence of this web identity: live store first, then the record's.
  const webPresence = usePublicPresence(channelId, webhookKey) ?? webhookData?.presence ?? null

  // The signed-in user's site record (no channel, no guild data). 401 = guest.
  const [selfData, setSelfData] = useState<BridgeSelfProfile | null>(() =>
    isSelf && selfProfileCache && Date.now() - selfProfileCache.at < SELF_PROFILE_TTL_MS ? selfProfileCache.data : null)
  const [selfLoaded, setSelfLoaded] = useState(() =>
    !isSelf || Boolean(selfProfileCache && Date.now() - selfProfileCache.at < SELF_PROFILE_TTL_MS))
  const [selfGuest, setSelfGuest] = useState(false)
  // Bumped on `account.updated` (own socket: a chat display name / profile
  // edit made elsewhere) so an open self popout re-reads its record.
  const [selfRev, setSelfRev] = useState(0)
  useEffect(() => {
    if (!isSelf) return
    return subscribeRt((event) => {
      if (event.type !== 'account.updated') return
      selfProfileCache = null
      setSelfRev((n) => n + 1)
    })
  }, [isSelf])
  useEffect(() => {
    if (!isSelf) return
    if (selfProfileCache && Date.now() - selfProfileCache.at < SELF_PROFILE_TTL_MS) {
      setSelfData(selfProfileCache.data); setSelfLoaded(true); return
    }
    let alive = true
    bridgeSelfProfile()
      .then((p) => {
        selfProfileCache = { at: Date.now(), data: p }
        if (alive) { setSelfData(p); setSelfGuest(false); setSelfLoaded(true) }
      })
      .catch((err: { status?: number }) => {
        if (!alive) return
        setSelfGuest(err?.status === 401)
        setSelfLoaded(true)
      })
    return () => { alive = false }
  }, [isSelf, selfRev])

  const guest = isSelf && selfLoaded && selfGuest
  const avatar = isSelf
    ? guest ? profile.fallbackAvatar || null : profile.authorAvatar || selfData?.avatar || profile.fallbackAvatar || null
    : profile.authorAvatar || data?.avatar || webhookData?.avatar || profile.fallbackAvatar || null
  // Header = the effective chat display name (server `displayName`: chat
  // display name, else the site username). The site username is the secondary
  // line and only shown when it differs from the display name.
  const displayName = isSelf
    ? (guest ? 'Guest' : selfData?.displayName || profile.authorName)
    : (data?.displayName || webhookData?.displayName || profile.authorName)
  const handle = isSelf
    ? (guest ? null : selfData?.username || profile.username || null)
    : (data?.username || webhookData?.username || profile.username || null)
  const username = guest ? 'Sign in to chat' : handle || displayName
  const showUsername = guest || (Boolean(handle) && handle !== displayName)

  // Banner: image > accent color > avatar's dominant color.
  useEffect(() => {
    if (data?.banner || data?.accentColor || !avatar) return
    let alive = true
    void dominantColor(avatar).then((c) => { if (alive) setBannerColor(c) })
    return () => { alive = false }
  }, [avatar, data?.banner, data?.accentColor])

  // Placement (Discord Popout via the shared popout helper): 'right' =
  // position "right", align "top", spacing 8 - top-aligned 8px right of the
  // anchor, inverting to the left when it doesn't fit; 'top' = position
  // "top", align "left", spacing 8, offset -8 (the user-panel account popout
  // overhangs the panel button by its 8px inset). The helper clamps into the
  // viewport (12px padding) and follows the anchor on resize/layout changes;
  // card height changes (member data arriving) re-place it the same frame.
  const selfPlacement = profile.placement === 'top'
  usePopoutPosition(ref, profile.anchorEl ?? profile.anchorRect, selfPlacement
    ? { position: 'top', align: 'left', spacing: 8, offset: profile.anchorEl ? -8 : 0 }
    : { position: 'right', align: 'top', spacing: 8 })

  // Dismissal: outside mousedown (not on the anchor - its click toggles - and
  // not inside a context menu layered over the popout), Escape (unless a
  // context menu is open; it closes first), and scrolling the anchor's
  // scroller away. Focus moves into the dialog and returns to the anchor.
  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null
    ref.current?.focus({ preventScroll: true })
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null
      if (!t || ref.current?.contains(t)) return
      // Context menus and the nested server-tag popout layer over this one.
      if ((t as Element).closest?.('.contextMenuLayer, .chat-gtPopout')) return
      if (profile.anchorEl?.contains(t)) return
      onClose()
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (document.querySelector('.contextMenuLayer, .chat-gtPopout')) return
      onClose()
    }
    // Only a scroll that actually MOVED the anchor dismisses: the message list
    // emits scroll events on open (stick-to-bottom / layout settle) without
    // the anchor moving, which used to close the popout the instant it opened.
    const onScroll = (e: Event) => {
      const t = e.target
      if (!(t instanceof Node) || !profile.anchorEl || t === ref.current || ref.current?.contains(t) || !t.contains(profile.anchorEl)) return
      const r = profile.anchorEl.getBoundingClientRect()
      if (Math.abs(r.top - profile.anchorRect.top) > 2 || Math.abs(r.left - profile.anchorRect.left) > 2) onClose()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('scroll', onScroll, true)
      if (restore && document.contains(restore) && restore !== document.body) restore.focus({ preventScroll: true })
    }
  }, [onClose, profile.anchorEl, profile.anchorRect])

  // Focus trap: Tab cycles through the card's focusable controls.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !ref.current) return
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]'))
    if (!items.length) { e.preventDefault(); return }
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }

  const bannerStyle: React.CSSProperties = data?.banner
    ? { backgroundImage: `url(${data.banner})` }
    : { backgroundColor: data?.accentColor || bannerColor || undefined }

  const isWebhook = profile.kind === 'user' && profile.direction === 'web'
  // Pronouns / About Me: site-side text (users.pronouns / about_me) from the
  // self-profile (own popout) or webhook-profile (another web identity).
  const profilePronouns = (isSelf ? selfData?.pronouns : isWebhook ? webhookData?.pronouns : null) || null
  const profileAboutMe = (isSelf ? selfData?.aboutMe : isWebhook ? webhookData?.aboutMe : null) || null
  const created = isSelf ? null : formatDate(data?.createdAt)
  const joined = isSelf ? null : formatDate(data?.joinedAt)
  // Web identities: the site join date stands in for Discord's dates. The
  // self popout shows only the site join date (users.created).
  const siteSince = isSelf
    ? formatDate(selfData?.memberSince)
    : !created ? formatDate(webhookData?.memberSince) : null
  type RoleRow = { key: string; name: string; color: string | null; colors?: NonNullable<BridgeProfile['roles'][number]['colors']> | null }
  // Roles: a web identity's EFFECTIVE roles (webhook-profile, already
  // position-sorted) for web authors and the account popout; Discord member
  // roles for Discord-side users; the message's chat tier as a last resort
  // while/if neither record loads.
  // The self popout is guild-independent: only the site-admin Admin chip
  // (selfData.roles), never guild roles.
  const roles: RoleRow[] = isSelf
    ? (selfData?.roles ?? []).map((r) => ({ key: r.roleId, name: r.name, color: r.color, colors: r.colors ?? null }))
    : webhookData && isWebhook
      ? (webhookData.roles ?? []).map((r) => ({ key: r.roleId, name: r.name, color: r.color, colors: r.colors ?? null }))
      : data
        ? (data.roles ?? []).map((r) => ({ key: r.roleId, name: r.name, color: r.color, colors: r.colors ?? null }))
        : profile.authorRole && (isWebhook ? webhookLoaded : loaded)
          ? [{ key: profile.authorRole, name: profile.authorRole, color: profile.authorColor }]
          : []
  // Bot-readable Discord cosmetics: avatar decoration (animated while the
  // popout is open, like Discord's profile avatar), display-name font, server
  // tag. Profile effects / theme colors / bio are not exposed to bots. The self
  // popout carries no guild cosmetics (no server tag, no member style).
  const style = isSelf ? null : data?.style ?? null
  const showRoles = isSelf ? roles.length > 0 : webhookData && isWebhook ? true : data ? data.inGuild : roles.length > 0

  const openStatusMenu = () => { clearTimeout(statusCloseTimer.current); setStatusMenu(true) }
  const closeStatusMenuSoon = () => { clearTimeout(statusCloseTimer.current); statusCloseTimer.current = setTimeout(() => setStatusMenu(false), 150) }
  useEffect(() => () => clearTimeout(statusCloseTimer.current), [])

  return createPortal(
    <div
      className={`profilePopout${profile.kind === 'self' ? ' accountPopout' : ''}`}
      ref={ref}
      role="dialog"
      aria-label={displayName}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onContextMenu(profile, isSelf
          ? (selfData ? { userId: selfData.userId, displayName: selfData.displayName } : null)
          : data ?? (isWebhook && webhookData ? { userId: '', displayName } : null), e)
      }}
    >
      <div className="profileHeader">
        <div className={`profileBanner${data?.banner ? ' hasImage' : ''}`} style={bannerStyle} />
        <div className="profileAvatar">
          <img src={avatar || 'https://cdn.discordapp.com/embed/avatars/0.png'} alt="" />
          {style?.decoration && (
            <AvatarDecoration asset={style.decoration.asset} size={96} animate className="chat-profileAvatarDecoration" />
          )}
          {/* Self: the owner's shown state. Web identities: public presence
              (live store / webhook-profile); no dot without a known status. */}
          {self && (
            <span className={`status status-${presenceGlyph(self.presence)}`} aria-label={PRESENCE_TEXT[self.presence]}>
              {renderStatus(presenceGlyph(self.presence))}
            </span>
          )}
          {!self && isWebhook && webPresence && (
            <span className={`status status-${presenceGlyph(webPresence)}`} aria-label={PRESENCE_TEXT[webPresence]}>
              {renderStatus(presenceGlyph(webPresence))}
            </span>
          )}
        </div>
      </div>
      <div className="profileBody">
        <div className={`profileName${style?.fontId != null ? ` ${dnsFontClass(style.fontId)}` : ''}`}>{displayName}</div>
        <div className="profileUsernameRow">
          {showUsername && <span className="profileUsername">{username}</span>}
          {style?.guildTag && <GuildTagChiplet tag={style.guildTag} channelId={channelId} />}
          {/* APP only for Discord-side bots; web (webhook-delivered) site
              users are first-class users on the website - no APP/WEBHOOK tag. */}
          {data?.bot && !isWebhook && <span className="bot profileBotTag">APP</span>}
        </div>
        {profilePronouns && <div className="profilePronouns">{profilePronouns}</div>}
        {!self && isWebhook && webPresence && (
          <div className="profilePresenceLine">
            <span className={`profilePresenceDot status-${presenceGlyph(webPresence)}`} aria-hidden="true" />
            {PRESENCE_TEXT[webPresence]}
          </div>
        )}
        {(created || siteSince || showRoles || profileAboutMe) && (
          <div className="profileInner">
            {profileAboutMe && (
              <div className="profileSection">
                <div className="profileSectionTitle"><HolyText text="About Me" /></div>
                <BioText text={profileAboutMe} className="profileAboutMe" />
              </div>
            )}
            {siteSince && (
              <div className="profileSection">
                <div className="profileSectionTitle"><HolyText text="Member Since" /></div>
                <div className="profileMemberSince">
                  {isSelf ? (
                    <span className="profileMemberSinceItem" title="Site">
                      <span className="profileMemberSinceIcon"><GlobeMark /></span>
                      {siteSince}
                    </span>
                  ) : (
                    <span className="profileMemberSinceItem" title={guildName}>
                      {guildIcon
                        ? <img className="profileMemberSinceGuild" src={guildIcon} alt="" />
                        : <span className="profileMemberSinceGuild acronym">{guildName.slice(0, 1)}</span>}
                      {siteSince}
                    </span>
                  )}
                </div>
              </div>
            )}
            {siteSince && showRoles && <div className="profileDivider" />}
            {created && (
              <div className="profileSection">
                <div className="profileSectionTitle"><HolyText text="Member Since" /></div>
                <div className="profileMemberSince">
                  <span className="profileMemberSinceItem" title="Discord">
                    <span className="profileMemberSinceIcon"><DiscordMark /></span>
                    {created}
                  </span>
                  {joined && (
                    <>
                      <span className="profileMemberSinceDot" aria-hidden="true" />
                      <span className="profileMemberSinceItem" title={guildName}>
                        {guildIcon
                          ? <img className="profileMemberSinceGuild" src={guildIcon} alt="" />
                          : <span className="profileMemberSinceGuild acronym">{guildName.slice(0, 1)}</span>}
                        {joined}
                      </span>
                    </>
                  )}
                </div>
              </div>
            )}
            {created && showRoles && <div className="profileDivider" />}
            {showRoles && (
              <div className="profileSection">
                <div className="profileSectionTitle">{roles.length ? (roles.length === 1 ? 'Role' : 'Roles') : 'No Roles'}</div>
                {roles.length > 0 && (
                  <div className="roleList" role="list">
                    {roles.map((r) => (
                      <div key={r.key} className="role" role="listitem" aria-label={r.name}>
                        <span className={`roleCircle${r.colors ? ' gradientRoleCircle' : ''}`} style={roleDotStyle(r.color, r.colors)} />
                        <span className="roleName">{r.name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {isSelf && selfData?.discord && !guest && (
          <div className="profileInner">
            <div className="profileSection">
              <div className="profileSectionTitle"><HolyText text="Discord" /></div>
              <div className="profileMemberSince">
                <span className="profileMemberSinceItem" title="Linked Discord account">
                  <span className="profileMemberSinceIcon"><DiscordMark /></span>
                  {selfData.discord.name || selfData.discord.username || 'Linked'}
                </span>
              </div>
            </div>
          </div>
        )}
        {self && guest && (
          <div className="profileAccountMenu" role="menu">
            <button type="button" role="menuitem" className="profileAccountItem" onClick={self.onSignIn}>
              <span className="profileAccountLabel"><HolyText text="Sign In" /></span>
            </button>
          </div>
        )}
        {self && !guest && (
          <>
            <div className="profileAccountMenu" role="menu">
              <button type="button" role="menuitem" className="profileAccountItem" onClick={self.onEditProfile}>
                <span className="profileAccountIcon"><PencilIcon /></span>
                <span className="profileAccountLabel"><HolyText text="Abstract account" /></span>
              </button>
              <div className="profileAccountSeparator" role="separator" />
              <div className="profileAccountStatusWrap" onMouseEnter={openStatusMenu} onMouseLeave={closeStatusMenuSoon}>
                <button
                  type="button"
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={statusMenu}
                  className={`profileAccountItem${statusMenu ? ' active' : ''}`}
                  onClick={() => setStatusMenu((v) => !v)}
                  onKeyDown={(e) => { if (e.key === 'ArrowRight') { e.preventDefault(); setStatusMenu(true) } }}
                >
                  <span className={`profileAccountIcon statusDot status-${presenceGlyph(self.choice)}`}>{renderStatus(presenceGlyph(self.choice))}</span>
                  <span className="profileAccountLabel">{PRESENCE_TEXT[self.choice]}</span>
                  <span className="profileAccountChevron"><ChevronIcon /></span>
                </button>
                {statusMenu && (
                  <div className="profileStatusFlyout" role="menu" aria-label="Set status">
                    {STATUS_LABELS.map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={self.choice === value}
                        className={`statusPickerItem ${self.choice === value ? 'selected' : ''}`}
                        onClick={() => { self.onPickStatus(value); setStatusMenu(false) }}
                      >
                        <span className={`statusDot status-${value}`} aria-hidden="true">{renderStatus(value)}</span>
                        <span className="statusPickerLabel">{label}</span>
                        {value === 'invisible' && <span className="statusPickerHint"><HolyText text="You won't appear online, but have full access." /></span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {self.onCopyId && selfData && (
              <div className="profileAccountMenu" role="menu">
                <button type="button" role="menuitem" className="profileAccountItem" onClick={() => self.onCopyId?.(selfData.userId)}>
                  <span className="profileAccountIcon"><IdIcon /></span>
                  <span className="profileAccountLabel"><HolyText text="Copy User ID" /></span>
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    popoutLayer(),
  )
}
