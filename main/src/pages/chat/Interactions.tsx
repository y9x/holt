// Discord application commands + message components for the chatbox:
//
// - InteractionHeader: the "{user} used /command" line Discord renders above a
//   slash-command (type 20) or context-menu-command (type 23) response. It
//   reuses the reply line's layout (repliedMessage + spine) with Discord's
//   executedCommand pieces: 16px invoker avatar (cozy) or the 16px badge with
//   the slash glyph (compact), the dimmed invoker name, "used", and the
//   commandName chip in link color.
// - ThinkingContent: a deferred response's LOADING state, "{bot} is thinking"
//   followed by Discord's pulsing three dots.
// - MessageComponents: action rows (buttons in every style, all select kinds)
//   and the Components V2 layout (container with accent bar, section with
//   thumbnail/button accessory, text display, media gallery, file, separator).
//
// Interactivity: the bridge has no interaction tokens, so it cannot press a
// button or submit a select on the viewer's behalf. Components render with
// Discord's enabled visuals (disabled ones with Discord's disabled look);
// link buttons open their URL; everything else shows a short tooltip on click
// pointing the viewer to Discord.

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import type { BridgeComponent, BridgeComponentEmoji, BridgeComponentMedia, BridgeMessage } from '../../lib/bridge'
import { twemojify } from './twemoji'
import { isTrustedDomain, showLeavingModal } from './LinkGuard'
import './interactions.css'

export const MESSAGE_FLAG_LOADING = 1 << 7
export const MESSAGE_FLAG_IS_COMPONENTS_V2 = 1 << 15

const INTERACT_NOTICE = 'Use Discord to interact with this'

// --- link opener --------------------------------------------------------------
// Link buttons (style 5) open their URL. Like Discord, untrusted domains go
// through the "Leaving Discord" warning; trusted ones open in a new tab.
type LinkOpener = (url: string, event: ReactMouseEvent) => void
const defaultLinkOpener: LinkOpener = (url) => {
  if (isTrustedDomain(url)) window.open(url, '_blank', 'noopener,noreferrer')
  else showLeavingModal(url)
}
let linkOpener: LinkOpener | null = defaultLinkOpener
export function setInteractionLinkOpener(fn: LinkOpener | null): void {
  linkOpener = fn
}

// --- header ---------------------------------------------------------------------

// Discord renders the executed-command header for CHAT_INPUT_COMMAND (20) and
// CONTEXT_MENU_COMMAND (23) messages. Older payloads without messageType fall
// back to the interaction type (2 = application command).
export function hasInteractionHeader(message: BridgeMessage): boolean {
  const ix = message.interaction
  if (!ix) return false
  if (typeof message.messageType === 'number') return message.messageType === 20 || message.messageType === 23
  return ix.type === 2
}

function isContextMenuCommand(message: BridgeMessage): boolean {
  if (message.messageType === 23) return true
  const t = message.interaction?.commandType
  return t === 2 || t === 3
}

// The command label as Discord shows it: "/name sub" for slash commands, the
// bare display name for context-menu commands.
export function interactionCommandLabel(message: BridgeMessage): string {
  const name = message.interaction?.name || ''
  if (isContextMenuCommand(message)) return name
  return `/${name}`
}

// Reply-preview placeholder for a replied-to command response with no text
// (Discord's repliedTextPlaceholder, italic).
export function interactionReplyPlaceholder(message: BridgeMessage): string | null {
  if (message.content) return null
  if (hasInteractionHeader(message)) return 'Click to see command'
  if (isThinking(message)) return `${message.authorName} is thinking...`
  return null
}

// Discord's commandIcon: the 5x9 slash glyph inside the compact replyBadge.
function CommandSlashIcon() {
  return (
    <svg className="ix-commandIcon" width="5" height="9" viewBox="0 0 5 9" aria-hidden="true">
      <path fill="currentColor" d="M3.8 0H5L1.2 9H0L3.8 0Z" />
    </svg>
  )
}

function defaultAvatarFor(id: string): string {
  let index = 0
  try { index = Number((BigInt(id) >> 22n) % 6n) } catch { index = 0 }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`
}

export function InteractionHeader({ message, appearance, onOpenUser, className = '' }: {
  message: BridgeMessage
  appearance: 'cozy' | 'compact'
  // Extra classes, e.g. 'ix-noSpine' where there is no avatar gutter.
  className?: string
  onOpenUser?: (user: { id: string; name: string }, event: ReactMouseEvent) => void
}) {
  const notice = useInteractNotice()
  if (!hasInteractionHeader(message) || !message.interaction) return null
  const ix = message.interaction
  const contextMenu = isContextMenuCommand(message)
  const label = interactionCommandLabel(message)
  const openUser = onOpenUser
    ? (e: ReactMouseEvent) => { e.stopPropagation(); onOpenUser({ id: ix.userId, name: ix.userName }, e) }
    : undefined
  return (
    <div
      className={`messageReply executedCommand${contextMenu ? ' contextCommandMessage' : ''}${className ? ` ${className}` : ''}`}
      aria-label={`${ix.userName} used ${label}`}
    >
      {appearance === 'cozy' ? (
        <img
          className="messageReplyAvatar executedCommandAvatar"
          src={ix.userAvatar || defaultAvatarFor(ix.userId)}
          alt=""
          aria-hidden="true"
          loading="lazy"
          onError={(e) => { const img = e.currentTarget; if (!img.dataset.fallback) { img.dataset.fallback = '1'; img.src = defaultAvatarFor(ix.userId) } }}
          onClick={openUser}
        />
      ) : (
        <span className="messageReplyIcon executedCommandBadge" aria-hidden="true"><CommandSlashIcon /></span>
      )}
      <span
        className="messageReplyName executedCommandUser"
        style={ix.userColor ? { color: ix.userColor } : undefined}
        onClick={openUser}
      >
        {ix.userName}
      </span>
      <span className="executedCommandUsed">used </span>
      {label && (
        <span
          className="executedCommandName clickable"
          role="button"
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); notice.show(e.currentTarget) }}
        >
          {label}
        </span>
      )}
      {notice.node}
    </div>
  )
}

// --- thinking ---------------------------------------------------------------------

export function isThinking(message: BridgeMessage): boolean {
  return ((message.flags ?? 0) & MESSAGE_FLAG_LOADING) !== 0 && !message.content
}

export function ThinkingContent({ message }: { message: BridgeMessage }) {
  if (!isThinking(message)) return null
  return (
    <div className="content ix-thinking">
      <span>{message.authorName} is thinking</span>
      <span className="ix-thinkingDots" aria-hidden="true"><i /><i /><i /></span>
    </div>
  )
}

// --- tooltip notice -------------------------------------------------------------

function useInteractNotice() {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const timer = useRef<number | null>(null)
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])
  const show = useCallback((el: HTMLElement) => {
    const rect = el.getBoundingClientRect()
    setAnchor({ x: rect.left + rect.width / 2, y: rect.top })
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setAnchor(null), 2400)
  }, [])
  const node: ReactNode = anchor ? (
    <div
      className="d-tooltip d-tooltipPrimary ix-notice"
      role="tooltip"
      style={{ left: anchor.x, top: anchor.y }}
    >
      <div className="d-tooltipPointer ix-noticePointer" />
      <div className="d-tooltipContent">{INTERACT_NOTICE}</div>
    </div>
  ) : null
  return { show, node }
}

// --- components -----------------------------------------------------------------

function emojiHtml(name: string): string {
  const escaped = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  return twemojify(escaped)
}

function ComponentEmoji({ emoji, className = '' }: { emoji: BridgeComponentEmoji | null | undefined; className?: string }) {
  if (!emoji) return null
  if (emoji.id) {
    const ext = emoji.animated ? 'gif' : 'webp'
    return (
      <img
        className={`emoji ix-emoji ${className}`}
        src={`https://cdn.discordapp.com/emojis/${emoji.id}.${ext}?size=48`}
        alt={emoji.name ? `:${emoji.name}:` : ''}
        draggable={false}
      />
    )
  }
  if (!emoji.name) return null
  return <span className={`ix-emoji ix-emojiNative ${className}`} dangerouslySetInnerHTML={{ __html: emojiHtml(emoji.name) }} />
}

// Discord's LinkExternalSmallIcon (16px) trailing a link button's label.
function LinkExternalIcon() {
  return (
    <svg className="ix-linkIcon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path fill="currentColor" d="M15 2a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0V4.41l-4.3 4.3a1 1 0 1 1-1.4-1.42L19.58 3H16a1 1 0 0 1-1-1Z" />
      <path fill="currentColor" d="M5 2a3 3 0 0 0-3 3v14a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3v-6a1 1 0 1 0-2 0v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h6a1 1 0 1 0 0-2H5Z" />
    </svg>
  )
}

// Discord's ShopIcon for premium (SKU) buttons.
function ShopIcon() {
  return (
    <svg className="ix-linkIcon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path fill="currentColor" fillRule="evenodd" d="M2.63 4.19A3 3 0 0 1 5.53 2H7a1 1 0 0 1 1 1v3.98a3.07 3.07 0 0 1-.3 1.35A2.97 2.97 0 0 1 4.98 10c-2 0-3.44-1.9-2.9-3.83l.55-1.98ZM10 2a1 1 0 0 0-1 1v4a3 3 0 0 0 3 3 3 3 0 0 0 3-2.97V3a1 1 0 0 0-1-1h-4Zm7 0a1 1 0 0 0-1 1v3.98a3.07 3.07 0 0 0 .3 1.35A2.97 2.97 0 0 0 19.02 10c2 0 3.44-1.9 2.9-3.83l-.55-1.98A3 3 0 0 0 18.47 2H17Zm4 10.42a4.98 4.98 0 0 1-4-.88V19a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-7.46a4.98 4.98 0 0 1-4 .88V19a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3v-6.58Z" clipRule="evenodd" />
    </svg>
  )
}

function ChevronDownIcon() {
  return (
    <svg className="ix-selectChevron" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path fill="currentColor" d="M5.3 9.3a1 1 0 0 1 1.4 0l5.3 5.29 5.3-5.3a1 1 0 1 1 1.4 1.42l-6 6a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.42Z" />
    </svg>
  )
}

function FileIcon() {
  return (
    <svg className="ix-fileIcon" width="30" height="40" viewBox="0 0 30 40" aria-hidden="true">
      <path fill="#e3e5e8" d="M0 4a4 4 0 0 1 4-4h16.17a4 4 0 0 1 2.83 1.17l5.83 5.83A4 4 0 0 1 30 9.83V36a4 4 0 0 1-4 4H4a4 4 0 0 1-4-4V4Z" />
      <path fill="#c4c9ce" d="M20 0v6a4 4 0 0 0 4 4h6L20 0Z" />
      <path fill="#a3a9b0" d="M7 18h16v2H7zm0 5h16v2H7zm0 5h10v2H7z" />
    </svg>
  )
}

// Button style → mana Button variant (Discord's ButtonStyle mapping).
const BUTTON_VARIANT: Record<number, string> = {
  1: 'primary',
  2: 'secondary',
  3: 'active',
  4: 'critical-primary',
  5: 'secondary',
  6: 'primary',
}

function safeHref(url: string | null | undefined): string | null {
  if (!url) return null
  return /^(https?:\/\/|discord:\/\/)/i.test(url) ? url : null
}

function isVideo(media: BridgeComponentMedia): boolean {
  if (media.contentType) return media.contentType.startsWith('video/')
  return /\.(mp4|webm|mov)(\?|$)/i.test(media.url)
}

function formatSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return ''
  const units = ['bytes', 'KB', 'MB', 'GB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${i === 0 ? n : n.toFixed(2)} ${units[i]}`
}

interface RenderCtx {
  renderMarkdown: (content: string) => string
  notice: (el: HTMLElement) => void
  inContainer: boolean
}

function ComponentButton({ c, ctx }: { c: BridgeComponent; ctx: RenderCtx }) {
  const style = c.style ?? 2
  const variant = BUTTON_VARIANT[style] || 'secondary'
  const hasText = Boolean(c.label)
  const className = `ix-button ix-${variant}${hasText ? ' ix-hasText' : ''}${c.disabled ? ' ix-disabled' : ''}`
  const inner = (
    <span className="ix-buttonInner">
      {style === 6 && <ShopIcon />}
      <ComponentEmoji emoji={c.emoji} />
      {c.label && <span className="ix-buttonLabel">{c.label}</span>}
      {style === 5 && <LinkExternalIcon />}
    </span>
  )
  const href = style === 5 ? safeHref(c.url) : null
  if (href && !c.disabled) {
    return (
      <a
        className={className}
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        onClick={(e) => {
          e.stopPropagation()
          if (linkOpener) {
            e.preventDefault()
            linkOpener(href, e)
          }
        }}
      >
        {inner}
      </a>
    )
  }
  return (
    <button
      type="button"
      className={className}
      aria-disabled={c.disabled || undefined}
      disabled={c.disabled}
      onClick={(e) => { e.stopPropagation(); ctx.notice(e.currentTarget) }}
    >
      {inner}
    </button>
  )
}

const SELECT_DEFAULT_PLACEHOLDER = 'Make a selection'

function ComponentSelect({ c, ctx }: { c: BridgeComponent; ctx: RenderCtx }) {
  const selected = c.type === 3 ? (c.options || []).filter((o) => o.default) : []
  return (
    <div
      className={`ix-select${c.disabled ? ' ix-disabled' : ''}${ctx.inContainer ? ' ix-selectFull' : ''}`}
      role="combobox"
      aria-expanded="false"
      aria-disabled={c.disabled || undefined}
      tabIndex={c.disabled ? -1 : 0}
      onClick={(e) => { e.stopPropagation(); if (!c.disabled) ctx.notice(e.currentTarget) }}
    >
      <div className="ix-selectValue">
        {selected.length > 0 ? (
          selected.map((o, i) => (
            <span key={i} className="ix-selectOption">
              <ComponentEmoji emoji={o.emoji} />
              <span>{o.label}{i < selected.length - 1 ? ',' : ''}</span>
            </span>
          ))
        ) : (
          <span className="ix-selectPlaceholder">{c.placeholder || SELECT_DEFAULT_PLACEHOLDER}</span>
        )}
      </div>
      <ChevronDownIcon />
    </div>
  )
}

function Spoiler({ children, className = '' }: { children: ReactNode; className?: string }) {
  const [revealed, setRevealed] = useState(false)
  if (revealed) return <>{children}</>
  return (
    <div className={`ix-spoiler ${className}`} onClick={(e) => { e.stopPropagation(); e.preventDefault(); setRevealed(true) }}>
      <div className="ix-spoilerContent" aria-hidden="true">{children}</div>
      <span className="ix-spoilerWarning">SPOILER</span>
    </div>
  )
}

function MediaItem({ media, description, spoiler, className = '' }: { media: BridgeComponentMedia; description?: string | null; spoiler?: boolean; className?: string }) {
  const body = isVideo(media) ? (
    <video className="ix-mediaEl" src={media.url} controls preload="metadata" aria-label={description || undefined} />
  ) : (
    <a className="ix-mediaLink" href={media.url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
      <img className="ix-mediaEl" src={media.url} alt={description || 'Image'} loading="lazy" />
    </a>
  )
  return (
    <div className={`ix-mediaItem ${className}`}>
      {spoiler ? <Spoiler>{body}</Spoiler> : body}
    </div>
  )
}

// Discord's media mosaic (the attachments grid, isInAppComponentsV2 600px
// cap): 1 → single, 2 → 1x2, 3 → solo + 2 stacked, 4 → 2x2, 5 → 1x2 + 3x3,
// 6 → 3x3, 7 → single + 3x3, 8 → 1x2 + 3x3, 9 → 3x3, 10 → single + 3x3.
function MediaGallery({ c }: { c: BridgeComponent }) {
  const items = (c.items || []).filter((it): it is { media: BridgeComponentMedia; description?: string | null; spoiler?: boolean } => Boolean(it.media))
  if (!items.length) return null
  const n = items.length
  const render = (list: typeof items, cls = '') => list.map((it, i) => (
    <MediaItem key={i} media={it.media} description={it.description} spoiler={it.spoiler} className={cls} />
  ))
  if (n === 1) {
    const it = items[0]
    const w = it.media.width || 0
    const h = it.media.height || 0
    return (
      <div className="ix-gallery">
        <div className="ix-oneByOne ix-single" style={w && h ? { aspectRatio: `${w} / ${h}` } : undefined}>
          {render(items)}
        </div>
      </div>
    )
  }
  let head: typeof items = []
  let grid: typeof items = []
  let headKind: 'one' | 'two' | 'none' = 'none'
  if (n === 2) { head = items; headKind = 'two' } else if (n === 3) {
    return (
      <div className="ix-gallery">
        <div className="ix-oneByTwo ix-three">
          <MediaItem media={items[0].media} description={items[0].description} spoiler={items[0].spoiler} className="ix-soloItem" />
          <div className="ix-twoByOne">{render(items.slice(1))}</div>
        </div>
      </div>
    )
  } else if (n === 4) {
    return <div className="ix-gallery"><div className="ix-twoByTwo">{render(items)}</div></div>
  } else if (n === 5 || n === 8) { head = items.slice(0, 2); grid = items.slice(2); headKind = 'two' } else if (n === 6 || n === 9) { grid = items } else { head = items.slice(0, 1); grid = items.slice(1); headKind = 'one' }
  return (
    <div className="ix-gallery">
      {headKind === 'two' && <div className="ix-oneByTwo">{render(head)}</div>}
      {headKind === 'one' && <div className="ix-oneByOne ix-mosaic">{render(head)}</div>}
      {grid.length > 0 && <div className="ix-threeByThree">{render(grid)}</div>}
    </div>
  )
}

function FileComponent({ c }: { c: BridgeComponent }) {
  const file = c.file
  if (!file) return null
  const name = c.name || file.name || file.url.split('/').pop()?.split('?')[0] || 'file'
  const size = formatSize(c.size ?? file.size)
  const body = (
    <div className="ix-file">
      <FileIcon />
      <div className="ix-fileInner">
        <a className="ix-fileName" href={file.url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>{name}</a>
        {size && <div className="ix-fileSize">{size}</div>}
      </div>
    </div>
  )
  return c.spoiler ? <Spoiler>{body}</Spoiler> : body
}

function TextDisplay({ c, ctx }: { c: BridgeComponent; ctx: RenderCtx }) {
  if (!c.content) return null
  return (
    <div className="content ix-textDisplay">
      <span dangerouslySetInnerHTML={{ __html: ctx.renderMarkdown(c.content) }} />
    </div>
  )
}

function Thumbnail({ c }: { c: BridgeComponent }) {
  if (!c.media) return null
  return <MediaItem media={c.media} description={c.description} spoiler={c.spoiler} className="ix-thumbnail" />
}

function Section({ c, ctx }: { c: BridgeComponent; ctx: RenderCtx }) {
  const acc = c.accessory
  return (
    <div className={`ix-section${acc?.type === 11 ? ' ix-sectionThumb' : ''}`}>
      <div className="ix-sectionContent">
        {(c.components || []).map((child, i) => <ComponentNode key={i} c={child} ctx={ctx} />)}
      </div>
      {acc && (
        <div className="ix-sectionAccessory">
          {acc.type === 11 ? <Thumbnail c={acc} /> : acc.type === 2 ? <ComponentButton c={acc} ctx={ctx} /> : null}
        </div>
      )}
    </div>
  )
}

function Container({ c, ctx }: { c: BridgeComponent; ctx: RenderCtx }) {
  const accent = typeof c.accentColor === 'number' ? `#${c.accentColor.toString(16).padStart(6, '0')}` : null
  const inner: RenderCtx = { ...ctx, inContainer: true }
  const body = (
    <div className={`ix-container${accent ? ' ix-hasAccent' : ''}`} style={accent ? { borderInlineStartColor: accent } : undefined}>
      {(c.components || []).map((child, i) => <ComponentNode key={i} c={child} ctx={inner} />)}
    </div>
  )
  return c.spoiler ? <Spoiler className="ix-containerSpoiler">{body}</Spoiler> : body
}

function ComponentNode({ c, ctx }: { c: BridgeComponent; ctx: RenderCtx }): ReactNode {
  switch (c.type) {
    case 1:
      return (
        <div className="ix-actionRow">
          {(c.components || []).map((child, i) => <ComponentNode key={i} c={child} ctx={ctx} />)}
        </div>
      )
    case 2: return <ComponentButton c={c} ctx={ctx} />
    case 3: case 5: case 6: case 7: case 8: return <ComponentSelect c={c} ctx={ctx} />
    case 9: return <Section c={c} ctx={ctx} />
    case 10: return <TextDisplay c={c} ctx={ctx} />
    case 11: return <Thumbnail c={c} />
    case 12: return <MediaGallery c={c} />
    case 13: return <FileComponent c={c} />
    case 14: return <div className={`ix-separator ix-spacing${c.spacing === 2 ? 'Large' : 'Small'}${c.divider === false ? '' : ' ix-divider'}`} role="separator" />
    case 17: return <Container c={c} ctx={ctx} />
    default: return null
  }
}

export function MessageComponents({ message, renderMarkdown }: {
  message: BridgeMessage
  renderMarkdown: (content: string) => string
}) {
  const notice = useInteractNotice()
  const components = Array.isArray(message.components) ? message.components : []
  if (!components.length) return null
  const v2 = ((message.flags ?? 0) & MESSAGE_FLAG_IS_COMPONENTS_V2) !== 0
  const ctx: RenderCtx = { renderMarkdown, notice: notice.show, inContainer: false }
  return (
    <div className={`ix-components${v2 ? ' ix-v2' : ''}`}>
      {components.map((c, i) => <ComponentNode key={i} c={c} ctx={ctx} />)}
      {notice.node}
    </div>
  )
}
