import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import { usePopoutPosition } from './popout'
import { GuildTagPopout } from './GuildTagPopout'
import { subscribeBridge } from '../../lib/rt'
import { bridgeAuthors, type BridgeAuthorStyle, type BridgeMessage, type BridgeRoleColors } from '../../lib/bridge'

/* Discord author cosmetics for the bridged chatbox, 1:1 with the web client:
 *
 *  - Enhanced role colors (gradient / holographic role styles). Discord's
 *    message username (module 799162 + gradient hook 36075 / CSS e5de78):
 *      <span class="username_c19a55 twoColorGradient|threeColorGradient
 *                   usernameGradient convenienceGlowGradient
 *                   [convenienceGlowGradientActive animateGradient]"
 *            style="--custom-gradient-color-1..3; text-decoration-color: c1"
 *            data-text="Name">Name</span>
 *    The gradient animates (and the blurred ::after glow fades in) while the
 *    MESSAGE is hovered (BaseMessage provides {animate} on mouseenter).
 *  - Avatar decorations: /avatar-decoration-presets/{asset}.png?size=N&
 *    passthrough={animate}, drawn at --decoration-to-avatar-ratio (1.2x).
 *  - Server tags (primary_guild) chiplet after the name.
 *  - Display-name fonts (display_name_styles.font_id → dnsFont classes).
 *  - New member badge ("I'm new here, say hi!"): joined <= 7 days ago, not a
 *    rejoin (member flag DID_REJOIN), not a bot (module 351001 HU()).
 */

export type AuthorStyle = BridgeAuthorStyle

const CDN = 'https://cdn.discordapp.com'
// Discord's CDN image sizes (kr() rounds a requested px size up to these).
const CDN_SIZES = [16, 20, 22, 24, 28, 32, 40, 44, 48, 56, 60, 64, 80, 96, 100, 128, 160, 240, 256, 300, 320, 480, 512, 600, 640, 1024, 1280, 1536, 2048, 3072, 4096]
function cdnSize(px: number): number {
  const want = Math.ceil(px * (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1))
  return CDN_SIZES.find((s) => s >= want) || 4096
}

export function decorationUrl(asset: string, px: number, animate: boolean): string {
  return `${CDN}/avatar-decoration-presets/${asset}.png?size=${cdnSize(px)}&passthrough=${animate}`
}

export function clanBadgeUrl(guildId: string, badge: string, px = 16): string {
  return `${CDN}/clan-badges/${guildId}/${badge}.png?size=${cdnSize(px)}`
}

// --- Author style cache + batched fetch -------------------------------------

const TTL_MS = 5 * 60_000
const styleCache = new Map<string, { at: number; style: AuthorStyle | null }>()
const inflight = new Set<string>()
const subscribers = new Set<() => void>()
let queue: Map<string, Set<string>> = new Map()
let flushTimer: ReturnType<typeof setTimeout> | undefined

function key(channelId: string, userId: string) { return `${channelId}:${userId}` }

function flush() {
  flushTimer = undefined
  const batches = queue
  queue = new Map()
  for (const [channelId, ids] of batches) {
    const list = [...ids]
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100)
      bridgeAuthors(channelId, chunk)
        .then((authors) => {
          const now = Date.now()
          for (const id of chunk) styleCache.set(key(channelId, id), { at: now, style: authors[id] ?? null })
        })
        .catch(() => {
          // Leave uncached so a later render retries (after the TTL backoff).
          const now = Date.now() - TTL_MS + 30_000
          for (const id of chunk) styleCache.set(key(channelId, id), { at: now, style: null })
        })
        .finally(() => {
          for (const id of chunk) inflight.delete(key(channelId, id))
          for (const fn of subscribers) fn()
        })
    }
  }
}

function request(channelId: string, userId: string) {
  const k = key(channelId, userId)
  if (inflight.has(k)) return
  const hit = styleCache.get(k)
  if (hit && Date.now() - hit.at < TTL_MS) return
  inflight.add(k)
  let ids = queue.get(channelId)
  if (!ids) { ids = new Set(); queue.set(channelId, ids) }
  ids.add(userId)
  if (!flushTimer) flushTimer = setTimeout(flush, 40)
}

/** Discord snowflake of a Discord-side author key ('discord:<id>'), else null. */
export function discordAuthorId(message: Pick<BridgeMessage, 'authorKey' | 'direction'>): string | null {
  if (message.direction !== 'discord') return null
  return message.authorKey.startsWith('discord:') ? message.authorKey.slice('discord:'.length) : null
}

/** Style lookup key for a message author: the Discord snowflake for
 *  Discord-side authors, the 'user:<siteId>' webhook key for web authors
 *  (their effective roles' name color / gradient), else null. */
export function authorStyleKey(message: Pick<BridgeMessage, 'authorKey' | 'direction'>): string | null {
  if (message.direction === 'web') return /^user:\d+$/.test(message.authorKey || '') ? message.authorKey : null
  return discordAuthorId(message)
}

/** Drop cached styles for these author keys / ids in every channel (their
 *  effective roles changed) and re-request on next render. */
export function forgetAuthorStyles(keys: string[]) {
  if (!keys.length) return
  const ids = new Set(keys.map((k) => (k.startsWith('discord:') ? k.slice('discord:'.length) : k)))
  for (const k of [...styleCache.keys()]) {
    const id = k.slice(k.indexOf(':') + 1)
    if (ids.has(id)) styleCache.delete(k)
  }
  for (const fn of subscribers) fn()
}

/** Styles for the authors of `messages` in `channelId` (Discord-side members
 *  and web webhook identities). */
export function useAuthorStyles(channelId: string | null, messages: BridgeMessage[]): (message: BridgeMessage) => AuthorStyle | null {
  const [, setVersion] = useState(0)
  useEffect(() => {
    const fn = () => setVersion((v) => v + 1)
    subscribers.add(fn)
    return () => { subscribers.delete(fn) }
  }, [])
  // Targeted effective-role changes (perks, onboarding answers, member roles)
  // re-style that author's rows.
  useEffect(() => subscribeBridge((event) => {
    if (event.type !== 'bridge.perms.changed' && event.type !== 'bridge.onboarding.updated') return
    const p = (event.payload || {}) as { keys?: unknown; targetKeys?: unknown; discordId?: unknown }
    const keys = [...(Array.isArray(p.keys) ? p.keys : []), ...(Array.isArray(p.targetKeys) ? p.targetKeys : [])].map(String)
    if (typeof p.discordId === 'string' && p.discordId) keys.push(p.discordId)
    forgetAuthorStyles(keys)
  }), [])
  useEffect(() => {
    if (!channelId) return
    for (const m of messages) {
      const id = authorStyleKey(m)
      if (id && (!m.authorBot || m.direction === 'web')) request(channelId, id)
    }
  }, [channelId, messages])
  return (message: BridgeMessage) => {
    if (!channelId) return null
    const id = authorStyleKey(message)
    if (!id) return null
    return styleCache.get(key(channelId, id))?.style ?? null
  }
}

/** Style for one Discord user id (e.g. the signed-in user's linked account
 *  for the user panel). */
export function useUserStyle(channelId: string | null, userId: string | null | undefined): AuthorStyle | null {
  const [, setVersion] = useState(0)
  useEffect(() => {
    const fn = () => setVersion((v) => v + 1)
    subscribers.add(fn)
    return () => { subscribers.delete(fn) }
  }, [])
  useEffect(() => {
    if (channelId && userId) request(channelId, userId)
  }, [channelId, userId])
  if (!channelId || !userId) return null
  return styleCache.get(key(channelId, userId))?.style ?? null
}

/** Seed the cache from a profile payload's style (keeps popout + rows in sync). */
export function primeAuthorStyle(channelId: string, userId: string, style: AuthorStyle | null | undefined) {
  if (style === undefined) return
  styleCache.set(key(channelId, userId), { at: Date.now(), style })
  for (const fn of subscribers) fn()
}

// --- New member badge -------------------------------------------------------

const NEW_MEMBER_DAYS = 7

/** Discord's HU(): joined within 7 days, not a rejoin, not a bot. */
export function isNewMember(style: AuthorStyle | null, bot = false): boolean {
  if (!style?.joinedAt || style.rejoined || style.bot || bot) return false
  const age = Date.now() - new Date(style.joinedAt).getTime()
  return age >= 0 && age <= NEW_MEMBER_DAYS * 86_400_000
}

// Discord's NewMemberBadge glyph (module 506803): a heart over open hands
// with two sparkles.
export function NewMemberIcon({ size = 20 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill="none" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M11.55 14.4c.28.17.62.17.9 0 1.6-.96 6.88-4.46 6.88-8.57A3.83 3.83 0 0 0 15.5 2c-1.56 0-2.58.6-3.5 1.5A4.66 4.66 0 0 0 8.5 2a3.83 3.83 0 0 0-3.83 3.83c0 4.1 5.29 7.61 6.88 8.57Z" />
      <path fill="currentColor" d="M3.11 14.86a1 1 0 0 0-.83 1.24l.23.89a6 6 0 0 0 6.46 4.45l2.03-.22V22a1 1 0 1 0 2 0v-.78l2.03.22A6 6 0 0 0 21.5 17l.23-.89a1 1 0 0 0-.83-1.24l-2.05-.29a6 6 0 0 0-6.1 3.07L12 19l-.74-1.36a6 6 0 0 0-6.1-3.07l-2.05.29ZM2.93 9.4a.6.6 0 0 1 1.14 0l.1.25a2 2 0 0 0 1.18 1.19l.25.1a.6.6 0 0 1 0 1.13l-.25.1a2 2 0 0 0-1.19 1.18l-.1.25a.6.6 0 0 1-1.13 0l-.1-.25a2 2 0 0 0-1.18-1.19l-.25-.1a.6.6 0 0 1 0-1.13l.25-.1a2 2 0 0 0 1.19-1.18l.1-.25ZM21.46 9.82a.49.49 0 0 0-.92 0v.03a2 2 0 0 1-1.19 1.18l-.03.01a.49.49 0 0 0 0 .92h.03a2 2 0 0 1 1.18 1.19l.01.03c.16.43.76.43.92 0v-.03a2 2 0 0 1 1.19-1.18l.03-.01a.49.49 0 0 0 0-.92h-.03a2 2 0 0 1-1.18-1.19l-.01-.03Z" />
    </svg>
  )
}

export const NEW_MEMBER_TOOLTIP = "I'm new here, say hi!"

/** The message-header new member badge (newMemberBadge_f80704) with Discord's
 *  tooltip and click popout ("Mention {username}"). */
export function NewMemberBadge({ username, onMention }: { username: string; onMention?: () => void }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [hover, setHover] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || (t as Element).closest?.('.chat-newMemberPopout')) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown, true); document.removeEventListener('keydown', onKey) }
  }, [open])
  return (
    <span
      ref={ref}
      className="chat-newMemberBadgeWrap"
      role="button"
      tabIndex={0}
      aria-label={NEW_MEMBER_TOOLTIP}
      onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v) } }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="chat-newMemberBadge"><NewMemberIcon size={20} /></div>
      {hover && !open && <HoverTooltip anchor={ref.current}>{NEW_MEMBER_TOOLTIP}</HoverTooltip>}
      {open && ref.current && (
        <AnchoredLayer anchor={ref.current} position="right">
          <div className="chat-newMemberPopout" role="dialog" aria-label={NEW_MEMBER_TOOLTIP}>
            <div className="chat-newMemberPopoutMain">
              <div className="chat-newMemberPopoutIcon"><NewMemberIcon size={40} /></div>
              <div>
                <div className="chat-newMemberPopoutHeader">{NEW_MEMBER_TOOLTIP}</div>
                <div className="chat-newMemberPopoutText">System icon for new server members.</div>
              </div>
            </div>
            {onMention && (
              <button
                type="button"
                className="chat-newMemberPopoutCta"
                autoFocus
                onClick={(e) => { e.stopPropagation(); setOpen(false); onMention() }}
              >
                Mention {username}
              </button>
            )}
          </div>
        </AnchoredLayer>
      )}
    </span>
  )
}

// --- Floating layers (tooltip / popout) --------------------------------------

function layerRoot(): Element {
  return document.querySelector('.chat-page') || document.body
}

/** Layer anchored to an element (right of it, or above) - the shared popout
 *  helper (popout.tsx): position "right"/"top", align "center", spacing 8,
 *  inverting/nudging into the viewport and following the anchor while shown. */
export function AnchoredLayer({ anchor, position, children }: { anchor: Element; position: 'right' | 'top'; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  usePopoutPosition(ref, anchor, { position, align: 'center', spacing: 8 })
  // Tooltips: aim the pointer at the anchor's centre, even when the bubble was
  // nudged sideways to stay in the viewport (CSS falls back to the bubble centre).
  useEffect(() => {
    if (position !== 'top') return
    let raf = 0
    const tick = () => {
      const layer = ref.current
      const bubble = layer?.querySelector<HTMLElement>('.chat-tooltip')
      if (layer && bubble) {
        // The pointer's `left` is measured from the bubble's padding edge (inside
        // its 1px border) and in unscaled CSS px (the entrance animation scales
        // the border box), so convert the anchor centre into that space.
        const a = anchor.getBoundingClientRect()
        const b = bubble.getBoundingClientRect()
        const scale = bubble.offsetWidth ? b.width / bubble.offsetWidth : 1
        const x = (a.left + a.width / 2 - b.left) / (scale || 1) - bubble.clientLeft
        bubble.style.setProperty('--tooltip-pointer-x', `${x.toFixed(2)}px`)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [anchor, position])
  return createPortal(
    <div ref={ref} className="chat-anchoredLayer">{children}</div>,
    layerRoot(),
  )
}

/** Discord's primary tooltip (tooltip_c36707 tooltipTop): surface-high bubble,
 *  1px border-subtle, shadow-high, 8px 12px padding, pointer below. */
export function HoverTooltip({ anchor, children }: { anchor: Element | null; children: ReactNode }) {
  if (!anchor) return null
  return (
    <AnchoredLayer anchor={anchor} position="top">
      <div className="chat-tooltip chat-tooltipTop" role="tooltip">
        <div className="chat-tooltipPointer chat-tooltipPointerBg" />
        <div className="chat-tooltipPointer" />
        <div className="chat-tooltipContent">{children}</div>
      </div>
    </AnchoredLayer>
  )
}

// --- Gradient / holographic role names --------------------------------------

/** Discord's gradient style vars (36075 _()): color-1 = primary, 2 =
 *  secondary ?? primary, 3 = tertiary ?? primary. */
export function gradientVars(colors: BridgeRoleColors): CSSProperties {
  return {
    ['--custom-gradient-color-1' as string]: colors.primary,
    ['--custom-gradient-color-2' as string]: colors.secondary ?? colors.primary,
    ['--custom-gradient-color-3' as string]: colors.tertiary ?? colors.primary,
  }
}

export function gradientClass(colors: BridgeRoleColors): string {
  return colors.tertiary ? 'd-threeColorGradient' : 'd-twoColorGradient'
}

// Display-name font ids (DisplayNameFont enum 559949) → dnsFont classes (89a31).
const DNS_FONT_CLASS: Record<number, string> = {
  3: 'd-dnsCherryBomb',
  4: 'd-dnsChicle',
  6: 'd-dnsMuseoModerno',
  7: 'd-dnsNeoCastel',
  8: 'd-dnsPixelify',
  10: 'd-dnsSinistre',
  12: 'd-dnsZillaSlab',
  13: 'd-dnsPlaypenSans',
  14: 'd-dnsOrbitron',
  15: 'd-dnsNewRocker',
  16: 'd-dnsKalam',
}

export function dnsFontClass(fontId: number | null | undefined): string {
  const c = fontId != null ? DNS_FONT_CLASS[fontId] : undefined
  return c ? `d-dnsFont ${c}` : ''
}

// Discord wraps emoji in gradient names with emoji_e5de78 so they keep their
// own colors (-webkit-text-fill-color: initial).
const EMOJI_RE = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu
function withEmojiSpans(name: string): ReactNode {
  const parts: ReactNode[] = []
  let last = 0
  for (const m of name.matchAll(EMOJI_RE)) {
    if (m.index! > last) parts.push(name.slice(last, m.index))
    parts.push(<span key={m.index} className="d-gradientEmoji">{m[0]}</span>)
    last = m.index! + m[0].length
  }
  if (!parts.length) return name
  if (last < name.length) parts.push(name.slice(last))
  return parts
}

/** Props (className/style/data-text/children) for a role-colored username
 *  span: gradient + glow classes when the color role is gradient/holographic,
 *  else a solid `color`. `fallbackColor` is the message's solid authorColor. */
export function roleNameProps(
  name: string,
  style: AuthorStyle | null,
  fallbackColor: string | null,
  animate: boolean,
  opts: { glow?: boolean } = {},
): { className: string; style?: CSSProperties; 'data-text'?: string; children: ReactNode } {
  const font = dnsFontClass(style?.fontId)
  const colors = style?.colors
  if (colors) {
    const glow = opts.glow !== false
    const cls = [
      gradientClass(colors),
      'd-usernameGradient',
      glow ? 'd-convenienceGlowGradient' : '',
      glow && animate ? 'd-convenienceGlowGradientActive' : '',
      animate ? 'd-animateGradient' : '',
      font,
    ].filter(Boolean).join(' ')
    return {
      className: cls,
      style: { ...gradientVars(colors), textDecorationColor: colors.primary },
      'data-text': name,
      children: withEmojiSpans(name),
    }
  }
  const color = style?.color || fallbackColor
  return { className: font, style: color ? { color } : undefined, children: name }
}

/** Discord's role dot / pill circle, gradient-filled for enhanced roles. */
export function roleDotStyle(color: string | null, colors: BridgeRoleColors | null | undefined): CSSProperties | undefined {
  if (colors) {
    const stops = [colors.primary, colors.secondary, colors.tertiary].filter(Boolean)
    return { background: `linear-gradient(to right, ${stops.join(', ')})` }
  }
  return color ? { background: color } : undefined
}

// --- Avatar decoration --------------------------------------------------------

/** Avatar decoration overlay. `className` positions it (message / popout
 *  CSS); `size` is the rendered decoration px (avatar x 1.2). */
export function AvatarDecoration({ asset, size, animate, className = '' }: { asset: string; size: number; animate: boolean; className?: string }) {
  return (
    <img
      className={`chat-avatarDecoration ${className}`}
      src={decorationUrl(asset, size, animate)}
      alt=" "
      aria-hidden="true"
      draggable={false}
    />
  )
}

// --- Server tag chiplet --------------------------------------------------------

/** Discord's server-tag chiplet (534400 N + clanTagChiplet_c19a55). With a
 *  `channelId` it is the clickable variant (clickable__10651) that opens the
 *  guild's server-tag popout (GuildTagPopout, Popout position "right"). */
export function GuildTagChiplet({ tag, compact = false, channelId = null }: { tag: NonNullable<AuthorStyle['guildTag']>; compact?: boolean; channelId?: string | null }) {
  const badgePx = compact ? 12 : 14
  const ref = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const clickable = Boolean(channelId)
  const toggle = (e: SyntheticEvent) => { e.stopPropagation(); setOpen((v) => !v) }
  return (
    // Discord (534400 S/T/m): an unclassed container span (stopPropagation)
    // > copyOnlyText + ONE chip span carrying chipletContainerInner +
    // chipletContainerInline + clanTagChiplet + messageChipletContainerInner
    // (+ clickable). The chip classes must share one element: it is an inline
    // box whose font-size (.72rem), font and vertical-align:middle (against
    // the 16px header) set the background's height and position.
    <span onClick={clickable ? (e) => e.stopPropagation() : undefined}>
      <span className="chat-copyOnlyText" aria-hidden="true">{' '}{tag.tag},{' '}</span>
      <span
        ref={ref}
        className={`chat-chipletInner chat-chipletInline chat-clanTagChiplet chat-messageChipletInner${clickable ? ' chat-chipletClickable' : ''}`}
        {...(clickable ? {
          role: 'button',
          tabIndex: 0,
          'aria-expanded': open,
          onClick: toggle,
          onKeyDown: (e: ReactKeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e) } },
        } : {})}
      >
        <span className="chat-chipletText chat-messageChipletText">
          {tag.badge && (
            <img
              className="chat-chipletBadge chat-messageChipletBadge"
              src={clanBadgeUrl(tag.guildId, tag.badge, 16)}
              alt=""
              width={badgePx}
              height={badgePx}
            />
          )}
          <span className="chat-hiddenVisually">Server Tag: {tag.tag}</span>
          <span className="chat-chipletTagText" aria-hidden="true">{tag.tag}</span>
        </span>
      </span>
      {open && channelId && ref.current && (
        <GuildTagPopout
          anchor={ref.current}
          channelId={channelId}
          guildId={tag.guildId}
          tag={tag.tag}
          badge={tag.badge}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  )
}
