// Discord message accessories, 1:1 with the live client: embeds (rich /
// link / article / image / video / gifv, Spotify), attachment media mosaics,
// file cards, audio/video players, text-file previews, spoilers and alt text.
//
// Structure, class roles and sizing are ported from Discord's web client:
// - Embed (175671 class `el`): normalize (659674 L()), inline-media test
//   (659674 v()), field rows (≤3 inline per row, gridColumn 12/n spans), the
//   400×300 (or 400×450 vertical YouTube) media box, 80×80 thumbnails, the
//   max-width rules (getMaxWidth), footer "text • timestamp".
// - Video embeds (ea()): thumbnail + play pill; play swaps in a sandboxed
//   provider iframe - ONLY for allow-listed players (YouTube, Vimeo, Twitch);
//   Spotify links render Discord's Spotify iframe. Nothing else ever iframes.
// - Attachments: Discord's newMosaicStyle grids (1/2/3/4/3×3), the 432px
//   file card with file-type icons, audio/video players, plaintext previews.
//
// Security: every URL is http(s)-checked before it reaches an href/src
// (safeHttpUrl); every anchor is target=_blank rel="noreferrer noopener";
// media loads from Discord's media proxy when the row carries proxy URLs;
// markup links go through the masked-link guard (LinkGuard.tsx).

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { bridgeSuppressEmbeds, type BridgeAttachment, type BridgeEmbedSuppressPolicy, type BridgeMessage } from '../../lib/bridge'
import { openOverlay } from './overlay'
import { Popout } from './popout'
import { guardLinkClick, safeHttpUrl, showLeavingModal, isTrustedDomain } from './LinkGuard'
import { openMediaModal, type MediaModalItem } from './MediaModal'
import { fitMedia, sizedProxyUrl } from './mediaSize'
import { MediaPlayer } from './MediaPlayer'
import { handleCodeCopyClick } from './markdown'
import { contentLinks, singleLinkContent } from './linkMarkup'
import './embeds.css'

type ContextAction = { kind: 'link'; url: string } | { kind: 'image'; url: string }

// ---------------------------------------------------------------------------
// Embed suppression policy (Discord's hover X). ChatPage publishes the active
// channel's policy from /perms; every embed reads it without prop drilling.
// ---------------------------------------------------------------------------

let suppressPolicy: BridgeEmbedSuppressPolicy | null = null
const suppressListeners = new Set<() => void>()
export function setEmbedSuppressPolicy(policy: BridgeEmbedSuppressPolicy | null | undefined): void {
  suppressPolicy = policy ?? null
  for (const l of suppressListeners) l()
}
function useSuppressPolicy(): BridgeEmbedSuppressPolicy | null {
  return useSyncExternalStore(
    (l) => { suppressListeners.add(l); return () => { suppressListeners.delete(l) } },
    () => suppressPolicy,
    () => null,
  )
}

// Discord: the author, or Manage Messages. Discord-originated rows can only
// be edited by the bot when it holds MANAGE_MESSAGES there.
function canSuppress(message: BridgeMessage, policy: BridgeEmbedSuppressPolicy | null): boolean {
  if (!policy || !policy.bridged || !message.discordMessageId || !(message.id > 0)) return false
  const isAuthor = policy.selfKeys.includes(message.authorKey)
  if (message.direction === 'web') return isAuthor || policy.staff
  return policy.botManageMessages && (isAuthor || policy.staff)
}

function requestSuppress(message: BridgeMessage, skipConfirm: boolean, onDone: () => void): void {
  // The realtime bridge.message.edited echo updates every client; the caller
  // also hides the embeds immediately on success.
  const run = () => { void bridgeSuppressEmbeds(message.id).then(onDone).catch(() => {}) }
  if (skipConfirm) { run(); return }
  openOverlay((close) => <SuppressConfirm onCancel={close} onConfirm={() => { close(); run() }} />)
}

function SuppressConfirm({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    confirmRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])
  return (
    <div className="dcModalBackdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="dcLinkModal" role="dialog" aria-modal="true" aria-labelledby="dcSuppressTitle">
        <div className="dcLinkModalHeader">
          <h1 id="dcSuppressTitle" className="dcLinkModalTitle">Remove Embeds</h1>
        </div>
        <div className="dcLinkModalBody">
          <div className="dcLinkModalText">Are you sure you want to remove all embeds on this message? This will remove them for everyone.</div>
          <div className="dcSuppressTip">Protip: hold shift when clicking the remove button to skip this confirmation.</div>
        </div>
        <div className="dcLinkModalFooter">
          <button type="button" className="dcButton dcButtonSecondary" onClick={onCancel}>Cancel</button>
          <button type="button" ref={confirmRef} className="dcButton dcButtonDanger" onClick={onConfirm}>Remove All Embeds</button>
        </div>
      </div>
    </div>
  )
}

export interface AccessoriesProps {
  message: BridgeMessage
  // Renders Discord markdown (the chat's own renderer) to an HTML string.
  renderMarkdown: (text: string) => string
  onContextAction?: (action: ContextAction, event: ReactMouseEvent) => void
}

const EMBED_FLAG_IS_ANIMATED = 1 << 5
const ATTACHMENT_FLAG_IS_ANIMATED = 1 << 5
const MESSAGE_FLAG_SUPPRESS_EMBEDS = 1 << 2

// ---------------------------------------------------------------------------
// Icons (paths ripped from Discord's icon modules)
// ---------------------------------------------------------------------------

const PATH_PLAY = 'M9.25 3.35C7.87 2.45 6 3.38 6 4.96v14.08c0 1.58 1.87 2.5 3.25 1.61l10.85-7.04a1.9 1.9 0 0 0 0-3.22L9.25 3.35Z'
const PATH_DOWNLOAD = 'M12 2a1 1 0 0 1 1 1v10.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V3a1 1 0 0 1 1-1ZM3 20a1 1 0 1 0 0 2h18a1 1 0 1 0 0-2H3Z'
const PATH_IMAGE = 'M2 5a3 3 0 0 1 3-3h14a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V5Zm13.35 8.13 3.5 4.67c.37.5.02 1.2-.6 1.2H5.81a.75.75 0 0 1-.59-1.22l1.86-2.32a1.5 1.5 0 0 1 2.34 0l.5.64 2.23-2.97a2 2 0 0 1 3.2 0ZM10.2 5.98c.23-.91-.88-1.55-1.55-.9a.93.93 0 0 1-1.3 0c-.67-.65-1.78-.01-1.55.9a.93.93 0 0 1-.65 1.12c-.9.26-.9 1.54 0 1.8.48.14.77.63.65 1.12-.23.91.88 1.55 1.55.9a.93.93 0 0 1 1.3 0c.67.65 1.78.01 1.55-.9a.93.93 0 0 1 .65-1.12c.9-.26.9-1.54 0-1.8a.93.93 0 0 1-.65-1.12Z'
const PATH_CHEVRON_DOWN = 'M5.3 9.3a1 1 0 0 1 1.4 0l5.3 5.29 5.3-5.3a1 1 0 1 1 1.4 1.42l-6 6a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.42Z'
const PATH_CHEVRON_UP = 'M5.3 14.7a1 1 0 0 0 1.4 0L12 9.42l5.3 5.3a1 1 0 0 0 1.4-1.42l-6-6a1 1 0 0 0-1.4 0l-6 6a1 1 0 0 0 0 1.42Z'
const PATH_X_SMALL = 'M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z'

function Icon({ d, size = 24, className }: { d: string; size?: number; className?: string }) {
  return (
    <svg className={className} aria-hidden="true" role="img" width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path fill="currentColor" d={d} />
    </svg>
  )
}

// Discord's video-embed external-link glyph (the 16px "open" box arrow).
function ExternalBoxIcon({ className }: { className?: string }) {
  return (
    <svg className={className} aria-hidden="true" width={16} height={16} viewBox="0 0 24 24">
      <path fill="currentColor" transform="translate(3.000000, 4.000000)" d="M16 0H2a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4v-2H2V4h14v10h-4v2h4c1.1 0 2-.9 2-2V2a2 2 0 0 0-2-2zM9 6l-4 4h3v6h2v-6h3L9 6z" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// The `filesize` lib output Discord uses (base-2, "KB"/"MB", ≤2 decimals).
export function formatFileSize(bytes: number | undefined | null): string {
  const n = typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  if (n < 1024) return `${n} bytes`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${Number(value.toFixed(2))} ${units[unit]}`
}

// Discord's calendar timestamp (embed footers): "Today at 3:45 PM",
// "Yesterday at 3:45 PM", else "1/5/2025 3:45 PM".
function formatCalendar(date: Date): string {
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const now = new Date()
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOf(now) - startOf(date)) / 86400000)
  if (days === 0) return `Today at ${time}`
  if (days === 1) return `Yesterday at ${time}`
  return `${date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: 'numeric' })} ${time}`
}

function stripAnchors(html: string): string {
  return html.replace(/<a\b[^>]*>/gi, '').replace(/<\/a>/gi, '')
}

// Click delegation for injected markup: masked-link guard + spoiler reveal
// + the code-block copy button.
function onMarkupClick(e: ReactMouseEvent<HTMLElement>) {
  const target = e.target as HTMLElement | null
  if (handleCodeCopyClick(target)) return
  const spoiler = target?.closest('.spoiler')
  if (spoiler) {
    spoiler.classList.toggle('revealed')
    return
  }
  const anchor = target?.closest('a[href]') as HTMLAnchorElement | null
  if (anchor) guardLinkClick(e, anchor)
}

function Markup({ html, className }: { html: string; className: string }) {
  return <div className={className} onClick={onMarkupClick} dangerouslySetInnerHTML={{ __html: html }} />
}

// An anchor whose text may differ from its target (embed title/author/
// provider links): Discord routes those through the masked-link warning
// unless the text is the URL itself or the domain is trusted.
function ExternalLink({ href, className, children, text }: { href: string; className?: string; children: ReactNode; text?: string }) {
  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(e) => {
        if (e.button !== 0) return
        const shown = (text ?? '').trim()
        if (shown && shown !== href && !isTrustedDomain(href)) {
          e.preventDefault()
          showLeavingModal(href)
        }
      }}
    >
      {children}
    </a>
  )
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Embed normalization (Discord 659674 L())
// ---------------------------------------------------------------------------

interface NMedia {
  url: string
  // Loadable src (proxy when available).
  src: string
  width: number
  height: number
  description?: string
  animated: boolean
  hasProxy: boolean
}

interface NEmbed {
  type: string
  url?: string
  rawTitle?: string
  rawDescription?: string
  color?: string
  timestamp?: Date
  author?: { name: string; url?: string; icon?: string }
  provider?: { name: string; url?: string }
  footer?: { text?: string; icon?: string }
  thumbnail?: NMedia
  image?: NMedia
  images?: NMedia[]
  video?: NMedia & { rawUrl: string }
  fields: Array<{ name: string; value: string; inline: boolean }>
}

type Raw = Record<string, unknown>
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

function rawMedia(v: unknown): NMedia | undefined {
  if (!v || typeof v !== 'object') return undefined
  const m = v as Raw
  const url = safeHttpUrl(m.url)
  const proxy = safeHttpUrl(m.proxy_url ?? m.proxyURL)
  if (!url && !proxy) return undefined
  const flags = typeof m.flags === 'number' ? m.flags : 0
  const src = proxy || url!
  return {
    url: url || proxy!,
    src,
    width: num(m.width),
    height: num(m.height),
    description: str(m.description),
    animated: (flags & EMBED_FLAG_IS_ANIMATED) !== 0 || /\.gif(\?|$)/i.test(src),
    hasProxy: Boolean(proxy),
  }
}

// Discord requires width>0 && height>0 for embed media (O()); legacy site
// unfurl rows lack dimensions, so those are kept and sized naturally.
function sized(m: NMedia | undefined, legacy: boolean): NMedia | undefined {
  if (!m) return undefined
  if (m.width > 0 && m.height > 0) return m
  return legacy ? m : undefined
}

const FIELD_TYPES = new Set(['rich', 'auto_moderation_message', 'auto_moderation_notification', 'safety_policy_notice', 'safety_system_notification', 'voice_channel', 'poll_result'])
const NO_DESCRIPTION_TYPES = new Set(['image', 'video', 'gifv'])
const HIDE_CONTENT_TYPES = new Set(['image', 'gifv'])

function normalizeEmbed(raw: Raw): NEmbed | null {
  const type = str(raw.type) || 'rich'
  // Pre-Discord-shape site unfurls ({type:'rich', siteName, image:{url}}).
  // Direct-media unfurls (type image/video) may lack dimensions when the server
  // could not sniff them (e.g. an mp4 whose moov atom sits past the probe
  // window); keep them and let the browser size the media from its own metadata.
  const legacy = typeof raw.siteName === 'string' || type === 'image' || type === 'video' || (raw.image != null && typeof raw.image === 'object' && !('width' in (raw.image as Raw)))
  const e: NEmbed = { type, url: safeHttpUrl(raw.url) || undefined, fields: [] }
  e.rawTitle = str(raw.title)
  e.rawDescription = str(raw.description)
  const footer = raw.footer as Raw | undefined
  if (footer && typeof footer === 'object') {
    e.footer = { text: str(footer.text), icon: safeHttpUrl(footer.proxy_icon_url) || safeHttpUrl(footer.icon_url) || undefined }
  }
  const author = raw.author as Raw | undefined
  if (author && typeof author === 'object' && str(author.name)) {
    e.author = {
      name: str(author.name)!,
      url: safeHttpUrl(author.url) || undefined,
      icon: safeHttpUrl(author.proxy_icon_url) || safeHttpUrl(author.icon_url) || undefined,
    }
  }
  const provider = raw.provider as Raw | undefined
  if (provider && typeof provider === 'object' && str(provider.name)) {
    e.provider = { name: str(provider.name)!, url: safeHttpUrl(provider.url) || undefined }
  } else if (str(raw.siteName)) {
    e.provider = { name: str(raw.siteName)! }
  }
  if (str(raw.timestamp)) {
    const d = new Date(raw.timestamp as string)
    if (!Number.isNaN(d.getTime())) e.timestamp = d
  }
  if (typeof raw.color === 'number' && Number.isFinite(raw.color)) {
    e.color = `#${Math.max(0, Math.min(0xffffff, raw.color)).toString(16).padStart(6, '0')}`
  }
  const thumb = sized(rawMedia(raw.thumbnail), legacy)
  if (thumb) {
    if (type === 'article' || type === 'image') e.image = thumb
    else e.thumbnail = thumb
  }
  const image = sized(rawMedia(raw.image), legacy)
  if (image) e.image = image
  const video = rawMedia(raw.video)
  if (video) {
    if (!e.thumbnail && video.hasProxy && video.width > 0 && video.height > 0) {
      try {
        const poster = new URL(video.src)
        poster.searchParams.set('format', 'webp')
        e.thumbnail = { ...video, src: poster.toString(), url: poster.toString(), animated: false }
      } catch { /* no poster */ }
    }
    const secure = video.hasProxy || /^https:/i.test(video.url)
    const rawUrl = safeHttpUrl((raw.video as Raw).url) || video.url
    if (e.thumbnail && secure && video.width > 0 && video.height > 0) e.video = { ...video, rawUrl }
    else if (!e.thumbnail && secure) e.video = { ...video, rawUrl } // direct video link (site unfurl)
  }
  if (FIELD_TYPES.has(type) && Array.isArray(raw.fields)) {
    e.fields = (raw.fields as Raw[])
      .filter((f) => f && typeof f === 'object')
      .map((f) => ({ name: typeof f.name === 'string' ? f.name : '', value: typeof f.value === 'string' ? f.value : '', inline: f.inline === true }))
  }
  return e
}

// Discord (659674 y()): consecutive embeds sharing a URL collapse into one
// embed with an image gallery (multi-image tweets etc.).
function mergeGalleries(list: NEmbed[]): NEmbed[] {
  const byUrl = new Map<string, NEmbed>()
  const out: NEmbed[] = []
  for (const e of list) {
    if (!e.url) { out.push(e); continue }
    const first = byUrl.get(e.url)
    if (!first) { out.push(e); byUrl.set(e.url, e); continue }
    if (e.image) {
      if (!first.images) {
        first.images = []
        if (first.image) first.images.push(first.image)
      }
      first.images.push(e.image)
    }
  }
  return out
}

function isInlineEmbed(e: NEmbed): boolean {
  return (e.image != null || e.video != null) && (e.type === 'gifv' || (e.type !== 'rich' && e.author == null && e.rawTitle == null))
}

// Direct media links preview client-side, like Discord's image/video/gifv
// embeds of a bare media URL, until (or when no) stored embed covers the link:
// Discord's own unfurl of a Discord-originated message arrives a moment later
// over MESSAGE_UPDATE, and a web message's site/Discord unfurl can be missing
// (Discord CDN links 404 without a fresh signature, sniffing can fail).
// Only https; links are read off the same markdown AST the content renders
// from (code, <url> and [x](<url>) never embed). A preview whose media fails
// to load is dropped again and the link text comes back (useMediaFallbacks),
// so a URL that only LOOKS like media never leaves a broken box behind.
const DIRECT_IMAGE_PATH_RE = /\.(png|jpe?g|gif|webp|avif)$/i
const DIRECT_VIDEO_PATH_RE = /\.(mp4|webm|mov)$/i
const DISCORD_CDN_HOST_RE = /^(cdn|media)\.discordapp\.(com|net)$/i
const SIGNED_CDN_PATH_RE = /^\/(attachments|ephemeral-attachments)\//
const SYNTHETIC = '__clientPreview'
const MAX_EMBEDS = 10

// Identity of a media URL for matching content links against stored embeds:
// Discord CDN attachment URLs compare by path (cdn ↔ media proxy, and the
// ex/is/hm signature is rotated by discord-cdn-refresh.ts), others by href.
function mediaKey(url: string | undefined | null): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    if (DISCORD_CDN_HOST_RE.test(u.hostname) && SIGNED_CDN_PATH_RE.test(u.pathname)) return `discordcdn:${u.pathname}`
    u.hash = ''
    return u.href
  } catch {
    return url
  }
}

// A signed Discord CDN URL whose signature has lapsed 404s ("This content is
// no longer available"); unsigned attachment URLs do too.
function cdnSignatureDead(u: URL): boolean {
  if (!DISCORD_CDN_HOST_RE.test(u.hostname) || !SIGNED_CDN_PATH_RE.test(u.pathname)) return false
  const ex = u.searchParams.get('ex')
  if (!ex || !/^[0-9a-f]{1,12}$/i.test(ex)) return true
  return parseInt(ex, 16) * 1000 <= Date.now()
}

function directMediaRaw(link: string): Raw | null {
  let u: URL
  try {
    u = new URL(link)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password || cdnSignatureDead(u)) return null
  const host = u.hostname.toLowerCase()
  const path = u.pathname
  // Imgur's .gifv page is an mp4 loop (Discord: gifv embed).
  if (host === 'i.imgur.com' && /\.gifv$/i.test(path)) {
    const mp4 = new URL(u.toString())
    mp4.pathname = path.replace(/\.gifv$/i, '.mp4')
    return { type: 'gifv', url: link, video: { url: mp4.toString() }, [SYNTHETIC]: true }
  }
  if (DIRECT_IMAGE_PATH_RE.test(path)) return { type: 'image', url: link, thumbnail: { url: link }, [SYNTHETIC]: true }
  if (DIRECT_VIDEO_PATH_RE.test(path)) return { type: 'video', url: link, video: { url: link }, [SYNTHETIC]: true }
  return null
}

// Media URLs whose client preview failed to load (shared store so the
// content above the accessories re-renders when a preview is withdrawn).
const failedPreviews = new Set<string>()
let failedVersion = 0
const failedListeners = new Set<() => void>()
function markPreviewFailed(key: string): void {
  if (!key || failedPreviews.has(key)) return
  failedPreviews.add(key)
  failedVersion++
  for (const l of failedListeners) l()
}
// MessageBody calls this so a withdrawn preview re-shows the link text.
export function useMediaFallbacks(): number {
  return useSyncExternalStore(
    (l) => { failedListeners.add(l); return () => { failedListeners.delete(l) } },
    () => failedVersion,
    () => 0,
  )
}

// The embeds a message renders: the stored Discord/unfurl embeds, then a
// client-side direct-media preview for every media link no stored embed covers.
function renderableRaws(message: BridgeMessage): Raw[] {
  const stored = (Array.isArray(message.embeds) ? message.embeds : []) as Raw[]
  if (((message.flags ?? 0) & MESSAGE_FLAG_SUPPRESS_EMBEDS) !== 0) return stored
  const links = contentLinks(message.content)
  if (!links.length) return stored
  const covered = new Set<string>()
  for (const raw of stored) {
    covered.add(mediaKey(str(raw.url)))
    for (const k of ['thumbnail', 'image', 'video'] as const) {
      const m = raw[k] as Raw | undefined
      if (m && typeof m === 'object') covered.add(mediaKey(str(m.url)))
    }
  }
  const out = [...stored]
  for (const link of links) {
    if (out.length >= MAX_EMBEDS) break
    if (link.suppressed) continue
    const key = mediaKey(link.url)
    if (covered.has(key) || failedPreviews.has(key)) continue
    const raw = directMediaRaw(link.url)
    if (!raw) continue
    covered.add(key)
    out.push(raw)
  }
  return out
}

// Discord's hideSimpleEmbedContent (448767 k5/iz): the text is hidden when the
// message has exactly ONE embed, of type image/gifv, that renders inline
// (659674 v(): media and no title/author), and the content is exactly one
// link (url or CDN attachmentLink) - Discord does NOT compare the URL itself,
// which also keeps re-signed CDN embed URLs from un-hiding the link.
export function shouldHideContent(message: BridgeMessage): boolean {
  if (((message.flags ?? 0) & MESSAGE_FLAG_SUPPRESS_EMBEDS) !== 0) return false
  const embeds = renderableRaws(message)
  if (embeds.length !== 1) return false
  const raw = embeds[0] as Raw
  const type = str(raw.type)
  if (!type || !HIDE_CONTENT_TYPES.has(type)) return false
  const normalized = normalizeEmbed(raw)
  if (!normalized || !isInlineEmbed(normalized)) return false
  return singleLinkContent(message.content) != null
}

// Embed URL wrapped in ||spoiler|| in the content → the embed is a spoiler.
function isSpoilerUrl(content: string, url: string | undefined): boolean {
  if (!url || !content.includes('||')) return false
  const key = mediaKey(url)
  return contentLinks(content).some((l) => l.spoiler && mediaKey(l.url) === key)
}

function mediaMaxBox(e: NEmbed): { maxWidth: number; maxHeight: number } {
  const vertical = e.video != null && e.video.height > e.video.width && (e.provider?.name === 'YouTube' || /youtube\.com/i.test(e.video.url))
  return e.provider?.name === 'TikTok' || vertical ? { maxWidth: 400, maxHeight: 450 } : { maxWidth: 400, maxHeight: 300 }
}

// ---------------------------------------------------------------------------
// Image primitive (Discord imageWrapper): aspect-ratio box sized with fitMedia,
// lazy-loaded, click → image modal.
// ---------------------------------------------------------------------------

function MediaImage({
  media, maxWidth, maxHeight, className, imgClassName, fill, onOpen, onContext, alt, responsive = true,
}: {
  media: NMedia
  maxWidth: number
  maxHeight: number
  className?: string
  imgClassName?: string
  fill?: boolean
  onOpen?: () => void
  onContext?: (e: ReactMouseEvent) => void
  alt?: string
  responsive?: boolean
}) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const known = media.width > 0 && media.height > 0
  const box = known ? fitMedia({ width: media.width, height: media.height, maxWidth, maxHeight }) : null
  const src = box ? sizedProxyUrl(media.src, box.width, box.height) : media.src
  const style: CSSProperties = fill
    ? {}
    : box
      ? responsive ? { width: box.width, maxWidth: '100%', aspectRatio: `${box.width} / ${box.height}` } : { width: box.width, height: box.height }
      : { maxWidth, maxHeight }
  return (
    <div
      className={`dcImageWrapper${loaded ? '' : ' loading'}${onOpen ? ' clickable' : ''}${className ? ` ${className}` : ''}`}
      style={style}
      onContextMenu={onContext}
    >
      {failed ? (
        <div className="dcImageError"><Icon d={PATH_IMAGE} size={40} /></div>
      ) : (
        <img
          className={imgClassName}
          src={src}
          alt={alt || media.description || 'Image'}
          loading="lazy"
          decoding="async"
          draggable={false}
          style={!box && !fill ? { maxWidth, maxHeight } : undefined}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          onClick={onOpen ? (e) => { e.preventDefault(); onOpen() } : undefined}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Video embeds
// ---------------------------------------------------------------------------

// Allow-listed iframe players. Returns the iframe src with Discord's
// provider params, or null when the URL isn't an allowed player.
function iframePlayerSrc(rawUrl: string): string | null {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return null
  }
  if (u.protocol !== 'https:') return null
  const host = u.hostname.toLowerCase()
  if ((host === 'www.youtube.com' || host === 'youtube.com' || host === 'www.youtube-nocookie.com') && u.pathname.startsWith('/embed/')) {
    u.searchParams.set('autoplay', '1')
    u.searchParams.set('auto_play', '1')
    return u.toString()
  }
  if (host === 'player.vimeo.com' && u.pathname.startsWith('/video/')) {
    u.searchParams.set('autoplay', '1')
    return u.toString()
  }
  if (host === 'player.twitch.tv' || (host === 'clips.twitch.tv' && u.pathname.startsWith('/embed'))) {
    u.searchParams.delete('parent')
    u.searchParams.append('parent', window.location.hostname)
    u.searchParams.set('autoplay', 'true')
    return u.toString()
  }
  return null
}

const IFRAME_SANDBOX = 'allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts'

function EmbedVideo({ embed, maxWidth, maxHeight, onContext }: { embed: NEmbed; maxWidth: number; maxHeight: number; onContext?: (e: ReactMouseEvent) => void }) {
  const [playing, setPlaying] = useState(false)
  const video = embed.video!
  const thumb = embed.thumbnail
  const baseW = video.width || thumb?.width || 400
  const baseH = video.height || thumb?.height || 225
  const fitted = fitMedia({ width: baseW, height: baseH, maxWidth, maxHeight })
  const w = Math.max(fitted.width, 150)
  const h = Math.max(fitted.height, 144)
  const player = iframePlayerSrc(video.rawUrl)

  // Discord-proxied (or direct) video files play in the native player.
  if (video.hasProxy || (!player && !thumb)) {
    return (
      <div className="dcEmbedVideo dcEmbedMedia" style={{ width: w, maxWidth: '100%' }}>
        <MediaPlayer kind="video" src={video.src} poster={thumb?.src} width={w} height={h} />
      </div>
    )
  }
  if (playing && player) {
    return (
      <div className="dcEmbedVideo dcEmbedMedia" style={{ width: w, maxWidth: '100%' }}>
        <div className="dcEmbedIframeBox" style={{ paddingBottom: `${(h / w) * 100}%` }}>
          <iframe
            className="dcEmbedIframe"
            src={player}
            title={embed.rawTitle || embed.provider?.name || 'Video'}
            allow="autoplay; fullscreen"
            allowFullScreen
            sandbox={IFRAME_SANDBOX}
            referrerPolicy="strict-origin-when-cross-origin"
            frameBorder={0}
            scrolling="no"
          />
        </div>
      </div>
    )
  }
  const external = embed.url || video.url
  return (
    <div className="dcEmbedVideo dcEmbedMedia" style={{ width: w, maxWidth: '100%' }} onContextMenu={onContext}>
      {thumb ? (
        <MediaImage
          media={thumb}
          maxWidth={w}
          maxHeight={h}
          fill
          className="dcEmbedVideoThumb"
          onOpen={player ? () => setPlaying(true) : undefined}
        />
      ) : <div className="dcEmbedVideoThumb dcImageWrapper" />}
      <div className="dcEmbedVideoActions">
        <div className="dcPlayPill">
          {player && (
            <button type="button" className="dcPlayPillIcon active" aria-label="Play" onClick={() => setPlaying(true)}>
              <Icon d={PATH_PLAY} size={16} className="dcPlayIcon" />
            </button>
          )}
          {external && (
            <ExternalLink href={external} className="dcPlayPillIcon active">
              <ExternalBoxIcon className={player ? 'dcPlayExternal margins' : 'dcPlayExternal'} />
            </ExternalLink>
          )}
        </div>
      </div>
    </div>
  )
}

function EmbedGifv({ embed, maxWidth, maxHeight }: { embed: NEmbed; maxWidth: number; maxHeight: number }) {
  const video = embed.video!
  const thumb = embed.thumbnail
  const baseW = video.width || thumb?.width || 0
  const baseH = video.height || thumb?.height || 0
  const box = baseW && baseH ? fitMedia({ width: baseW, height: baseH, maxWidth, maxHeight }) : null
  const reduce = prefersReducedMotion()
  const ref = useRef<HTMLVideoElement | null>(null)
  const [paused, setPaused] = useState(reduce)
  return (
    <div
      className="dcEmbedVideo dcEmbedMedia dcGifv dcImageWrapper"
      style={box ? { width: box.width, maxWidth: '100%', aspectRatio: `${box.width} / ${box.height}` } : { maxWidth, maxHeight }}
      onMouseEnter={() => { if (reduce) { void ref.current?.play().catch(() => {}); setPaused(false) } }}
      onMouseLeave={() => { if (reduce) { ref.current?.pause(); setPaused(true) } }}
    >
      <video
        ref={ref}
        className="dcGifvVideo"
        src={video.src}
        poster={thumb?.src}
        muted
        loop
        autoPlay={!reduce}
        playsInline
        preload="none"
        aria-label="GIF"
      />
      {paused && <span className="dcGifTag" aria-hidden="true" />}
    </div>
  )
}

// Spotify links: Discord renders Spotify's own embed player (628137).
function spotifyEmbed(e: NEmbed): { src: string; height: number } | null {
  if (!e.url || e.provider?.name !== 'Spotify' || e.type !== 'link') return null
  try {
    const u = new URL(e.url.replace(/intl-[^/]+\//, ''))
    if (u.hostname !== 'open.spotify.com') return null
    const parts = u.pathname.split('/').filter(Boolean)
    let kind = parts[0]?.toLowerCase()
    let id = parts[1]
    if (kind === 'user' && parts[2]?.toLowerCase() === 'playlist') { kind = 'playlist'; id = parts[3] }
    if (!kind || !id || !/^(track|album|playlist|artist|episode|show)$/.test(kind) || !/^[A-Za-z0-9]+$/.test(id)) return null
    const height = kind === 'track' || kind === 'episode' ? 80 : 352
    return { src: `https://open.spotify.com/embed/${kind}/${id}`, height }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Embed
// ---------------------------------------------------------------------------

function EmbedView({ embed, renderMarkdown, spoiler, mediaItems, onContextAction, onSuppress }: {
  embed: NEmbed
  renderMarkdown: (text: string) => string
  spoiler: boolean
  mediaItems: MediaModalItem[]
  onContextAction?: AccessoriesProps['onContextAction']
  onSuppress?: (skipConfirm: boolean) => void
}) {
  const [revealed, setRevealed] = useState(!spoiler)
  const hidden = !revealed
  const { maxWidth: maxMediaWidth, maxHeight: maxMediaHeight } = mediaMaxBox(embed)
  const openAt = (m: NMedia) => {
    const idx = mediaItems.findIndex((it) => it.src === m.src || it.original === m.url)
    openMediaModal(mediaItems, idx >= 0 ? idx : 0)
  }
  const imageContext = (url: string) => (e: ReactMouseEvent) => { if (onContextAction) onContextAction({ kind: 'image', url }, e) }

  const spotify = spotifyEmbed(embed)
  if (spotify) {
    return (
      <iframe
        className="dcEmbedSpotify"
        src={spotify.src}
        title="Spotify"
        style={{ height: spotify.height }}
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        allow="encrypted-media; clipboard-write"
        frameBorder={0}
        loading="lazy"
      />
    )
  }

  const renderMedia = (): ReactNode => {
    if (embed.type === 'gifv' && embed.video) return <EmbedGifv embed={embed} maxWidth={maxMediaWidth} maxHeight={maxMediaHeight} />
    if (embed.video) return <EmbedVideo embed={embed} maxWidth={maxMediaWidth} maxHeight={maxMediaHeight} onContext={embed.url ? imageContext(embed.url) : undefined} />
    if (embed.images && embed.images.length > 1) {
      const [a, b, c, d] = embed.images
      const cell = (m: NMedia | undefined, key: number) => m ? (
        <div key={key} className="dcGalleryImage">
          <MediaImage media={m} maxWidth={maxMediaWidth} maxHeight={maxMediaHeight} fill imgClassName="dcGalleryImageElement" onOpen={() => openAt(m)} onContext={imageContext(m.url)} />
        </div>
      ) : null
      return (
        <div className="dcGallery" style={{ height: maxMediaHeight }}>
          <div className="dcGallerySide">{cell(a, 0)}{d ? cell(c, 2) : null}</div>
          <div className="dcGallerySide">{cell(b, 1)}{!d && c ? cell(c, 2) : null}{d ? cell(d, 3) : null}</div>
        </div>
      )
    }
    if (embed.image) {
      const img = embed.image
      return (
        <MediaImage
          media={img}
          maxWidth={maxMediaWidth}
          maxHeight={maxMediaHeight}
          className="dcEmbedMedia dcEmbedImage"
          alt={embed.rawTitle}
          onOpen={() => openAt(img)}
          onContext={imageContext(img.url)}
        />
      )
    }
    return null
  }

  const spoilerWrap = (node: ReactNode, inline: boolean) => {
    if (!spoiler) return node
    return (
      <div
        className={`dcSpoilerContainer${inline ? ' attachment' : ' embed'}${hidden ? ' hidden' : ''}`}
        onClick={hidden ? (e) => { e.preventDefault(); e.stopPropagation(); setRevealed(true) } : undefined}
        role={hidden ? 'button' : undefined}
        tabIndex={hidden ? 0 : undefined}
        aria-label={hidden ? 'Spoiler' : undefined}
      >
        <div className="dcSpoilerInner" aria-hidden={hidden}>{node}</div>
        {hidden && <div className="dcSpoilerWarning">Spoiler</div>}
      </div>
    )
  }

  // Inline media embeds (bare image / GIFV / video links) - media only.
  if (isInlineEmbed(embed)) {
    const media = renderMedia()
    if (!media) return null
    let maxWidth: number | undefined
    if (embed.type === 'gifv') {
      const v = embed.video
      const t = embed.thumbnail
      if ((v?.width || t?.width) && (v?.height || t?.height)) {
        maxWidth = fitMedia({ width: v?.width || t!.width, height: v?.height || t!.height, maxWidth: maxMediaWidth, maxHeight: maxMediaHeight }).width
      }
    }
    return spoilerWrap(
      <div className={`dcInlineMediaEmbed${hidden ? ' isHidden' : ''}`} style={maxWidth ? { maxWidth } : undefined}>{media}</div>,
      true,
    )
  }

  const media = renderMedia()
  const showThumbnail = embed.type === 'rich' ? embed.video == null : media == null
  const thumbnail = showThumbnail ? embed.thumbnail : undefined
  const hasThumbnail = thumbnail != null

  // getMaxWidth(false): media ≥300px wide (or any video) widens the card to
  // media + 32px; a rich gallery is 520px.
  let articleMaxWidth: number | undefined
  const sizeSource = embed.image ?? embed.video
  if (sizeSource && sizeSource.width > 0 && sizeSource.height > 0) {
    const { width } = fitMedia({ width: sizeSource.width, height: sizeSource.height, maxWidth: maxMediaWidth, maxHeight: maxMediaHeight })
    if (embed.type === 'video' || width >= 300) articleMaxWidth = width + 32
  }
  if (articleMaxWidth === undefined && embed.type === 'rich' && embed.images) articleMaxWidth = 520

  const borderColor = embed.color && embed.color.toLowerCase() !== '#ffffff' && !hidden ? embed.color : undefined

  // Fields: rows of up to 3 inline fields; a non-inline field closes the
  // current row and stands alone. gridColumn spans 12/n columns.
  const fieldRows: Array<Array<{ name: string; value: string }>> = []
  let row: Array<{ name: string; value: string }> | null = null
  for (const f of embed.fields) {
    if (!f.inline && row != null) { fieldRows.push(row); row = null }
    if (row == null) row = []
    row.push({ name: f.name, value: f.value })
    if (row.length === 3 || !f.inline) { fieldRows.push(row); row = null }
  }
  if (row != null) fieldRows.push(row)

  const title = embed.rawTitle
  const titleHtml = title ? stripAnchors(renderMarkdown(title)) : ''
  const justifyAuto = embed.type === 'image' || embed.type === 'video' || embed.type === 'gifv'
    || ((embed.type === 'rich' || embed.type === 'article') && (embed.video != null || embed.image != null))

  const article = (
    <article
      className={`dcEmbed dcEmbedFull${hidden ? ' isHidden' : ''}${justifyAuto ? ' justifyAuto' : ''}`}
      style={{ borderInlineStartColor: borderColor, maxWidth: articleMaxWidth }}
      aria-hidden={hidden || undefined}
    >
      <div className="dcEmbedGridContainer">
        <div className={`dcEmbedGrid${hasThumbnail ? ' hasThumbnail' : ''}`}>
          {onSuppress && (
            <button
              type="button"
              className="dcEmbedSuppressButton"
              aria-label="Remove all embeds"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSuppress(e.shiftKey) }}
            >
              <Icon d={PATH_X_SMALL} size={16} />
            </button>
          )}
          {embed.provider && (
            <div className="dcEmbedProvider dcEmbedMargin">
              {embed.provider.url
                ? <ExternalLink className="dcEmbedLink" href={embed.provider.url} text={embed.provider.name}>{embed.provider.name}</ExternalLink>
                : <span>{embed.provider.name}</span>}
            </div>
          )}
          {embed.author && (
            <div className="dcEmbedAuthor dcEmbedMargin">
              {embed.author.icon && <img alt="" className="dcEmbedAuthorIcon" src={embed.author.icon} loading="lazy" />}
              {embed.author.url
                ? <ExternalLink className="dcEmbedAuthorName dcEmbedLink" href={embed.author.url} text={embed.author.name}>{embed.author.name}</ExternalLink>
                : <span className="dcEmbedAuthorName">{embed.author.name}</span>}
            </div>
          )}
          {title && (
            <div className="dcEmbedTitle dcEmbedMargin">
              {embed.url ? (
                <ExternalLink className="dcEmbedTitleLink dcEmbedLink" href={embed.url} text={title}>
                  <span dangerouslySetInnerHTML={{ __html: titleHtml }} />
                </ExternalLink>
              ) : <span dangerouslySetInnerHTML={{ __html: titleHtml }} />}
            </div>
          )}
          {embed.rawDescription && !NO_DESCRIPTION_TYPES.has(embed.type) && (
            <Markup className="dcEmbedDescription dcEmbedMargin dcEmbedMarkup" html={renderMarkdown(embed.rawDescription)} />
          )}
          {fieldRows.length > 0 && (
            <div className="dcEmbedFields">
              {fieldRows.map((fields, ri) => fields.map((f, fi) => {
                const span = 12 / fields.length
                const startCol = fi * span
                return (
                  <div key={`${ri}-${fi}`} className="dcEmbedField" style={{ gridColumn: `${startCol + 1} / ${startCol + span + 1}` }}>
                    <div className="dcEmbedFieldName" dangerouslySetInnerHTML={{ __html: stripAnchors(renderMarkdown(f.name)) }} />
                    <Markup className="dcEmbedFieldValue dcEmbedMarkup" html={renderMarkdown(f.value)} />
                  </div>
                )
              }))}
            </div>
          )}
          {media}
          {thumbnail && (
            <MediaImage
              media={thumbnail}
              maxWidth={80}
              maxHeight={80}
              responsive={false}
              className="dcEmbedThumbnail"
              onOpen={() => openAt(thumbnail)}
              onContext={imageContext(thumbnail.url)}
            />
          )}
          {(embed.footer || embed.timestamp) && (
            <div className="dcEmbedFooter dcEmbedMargin">
              {embed.footer?.icon && <img alt="" className="dcEmbedFooterIcon" src={embed.footer.icon} loading="lazy" />}
              <span className="dcEmbedFooterText">
                {embed.footer?.text}
                {embed.footer?.text && embed.timestamp && <span className="dcEmbedFooterSeparator">•</span>}
                {embed.timestamp && formatCalendar(embed.timestamp)}
              </span>
            </div>
          )}
        </div>
      </div>
    </article>
  )
  return spoilerWrap(article, false)
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

interface NAttachment {
  a: BridgeAttachment
  url: string
  src: string
  name: string
  kind: 'image' | 'video' | 'audio' | 'text' | 'file' | 'sticker'
  width: number
  height: number
  animated: boolean
  spoiler: boolean
  alt?: string
}

const TEXT_EXT = /\.(txt|md|log|csv|json|js|jsx|ts|tsx|mjs|cjs|py|rb|rs|go|java|kt|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|ps1|bat|lua|sql|yml|yaml|toml|ini|cfg|conf|env|xml|html|htm|css|scss|less|svelte|vue|diff|patch|swift|dart|r|pl|ex|exs|hs|ml|clj|gradle|cmake|make|dockerfile|gitignore)$/i
const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024

function normalizeAttachment(a: BridgeAttachment): NAttachment | null {
  const url = safeHttpUrl(a.url)
  if (!url) return null
  const src = safeHttpUrl(a.proxyUrl) || url
  const name = a.name || 'attachment'
  const type = (a.contentType || '').toLowerCase()
  let kind: NAttachment['kind'] = 'file'
  if (/\/stickers\//.test(url)) kind = 'sticker'
  else if (type.startsWith('image/') || (!type && /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(name))) kind = 'image'
  else if (type.startsWith('video/') || (!type && /\.(mp4|webm|mov)(\?|$)/i.test(name))) kind = 'video'
  else if (type.startsWith('audio/') || (!type && /\.(mp3|ogg|opus|wav|flac|m4a)(\?|$)/i.test(name))) kind = 'audio'
  else if ((type.startsWith('text/') || type.startsWith('application/json') || TEXT_EXT.test(name)) && (a.size ?? 0) <= MAX_TEXT_PREVIEW_BYTES) kind = 'text'
  return {
    a,
    url,
    src,
    name,
    kind,
    width: typeof a.width === 'number' && a.width > 0 ? a.width : 0,
    height: typeof a.height === 'number' && a.height > 0 ? a.height : 0,
    animated: type === 'image/gif' || ((a.flags ?? 0) & ATTACHMENT_FLAG_IS_ANIMATED) !== 0,
    spoiler: a.spoiler === true || name.startsWith('SPOILER_'),
    alt: a.description || undefined,
  }
}

// Discord file-type icon (453771 GD()).
function fileIconClass(name: string, type: string | null | undefined): string {
  const n = name.toLowerCase()
  const t = (type || '').toLowerCase()
  if (/^image\/vnd.adobe.photoshop/.test(t)) return 'ps'
  if (/^image\/svg\+xml/.test(t)) return 'webcode'
  if (/^image\//.test(t)) return 'image'
  if (/^video\//.test(t)) return 'video'
  if (/\.pdf$/.test(n)) return 'acrobat'
  if (/\.ae/.test(n)) return 'ae'
  if (/\.sketch$/.test(n)) return 'sketch'
  if (/\.ai$/.test(n)) return 'ai'
  if (/\.(?:rar|zip|7z|tar|tar\.gz)$/.test(n)) return 'archive'
  if (/\.(?:c\+\+|cpp|cc|c|h|hpp|mm|m|json|js|ts|rb|rake|py|asm|fs|pyc|dtd|cgi|bat|rss|java|graphml|idb|lua|o|gml|prl|sls|conf|cmake|make|sln|vbe|cxx|wbf|vbs|r|wml|php|bash|applescript|fcgi|yaml|ex|exs|sh|ml|actionscript)$/.test(n)) return 'code'
  if (/\.(?:txt|rtf|doc|docx|md|pages|ppt|pptx|pptm|key|log)$/.test(n)) return 'document'
  if (/\.(?:xls|xlsx|numbers|csv)$/.test(n)) return 'spreadsheet'
  if (/\.(?:html|xhtml|htm|xml|xsd|css|styl)$/.test(n)) return 'webcode'
  if (/\.(?:mp3|ogg|opus|wav|aiff|flac)$/.test(n)) return 'audio'
  return 'unknown'
}

function FileIcon({ name, type }: { name: string; type?: string | null }) {
  const klass = fileIconClass(name, type)
  return <img className="dcFileIcon" src={`/vendor/discord/file-icons/icon-file-${klass}.svg`} alt={`Attachment file type: ${klass}`} title={klass} />
}

function DownloadButton({ href, className, size = 24 }: { href: string; className?: string; size?: number }) {
  return (
    <a className={className} href={href} target="_blank" rel="noreferrer noopener" aria-label="Download" title="Download">
      <Icon d={PATH_DOWNLOAD} size={size} />
    </a>
  )
}

function FileCard({ att, onContextAction }: { att: NAttachment; onContextAction?: AccessoriesProps['onContextAction'] }) {
  return (
    <div className="dcFileWrapper">
      <div className="dcFile">
        <FileIcon name={att.name} type={att.a.contentType} />
        <div className="dcFileInner">
          <div className="dcFilenameLinkWrapper">
            <a
              className="dcFileNameLink"
              href={att.url}
              target="_blank"
              rel="noreferrer noopener"
              onContextMenu={(e) => onContextAction?.({ kind: 'link', url: att.url }, e)}
            >
              {att.name}
            </a>
          </div>
          <div className="dcFileSize">{formatFileSize(att.a.size)}</div>
        </div>
      </div>
      {/* Discord's hoverButtonGroup: a small download button that only shows
          while the card is hovered (CSS sibling selector), offset off the
          card's top-right corner. */}
      <div className="dcFileHoverGroup">
        <DownloadButton href={att.url} className="dcFileHoverButton" size={20} />
      </div>
    </div>
  )
}

// Header of the inline audio player: file icon, name, size and download.
// The bar itself is MediaPlayer (MediaPlayer.tsx).
function AudioMetaHeader({ href, name, size, downloadUrl }: { href: string; name?: string; size?: number; downloadUrl?: string }) {
  return (
    <div className="dcAudioMetadata">
      <div className="dcMetadataContent">
        <a className="dcMetadataName dcFileNameLink" href={href} target="_blank" rel="noreferrer noopener">{name}</a>
        <div className="dcMetadataSize">{formatFileSize(size)}</div>
      </div>
      {downloadUrl && <DownloadButton href={downloadUrl} className="dcMetadataDownload" />}
    </div>
  )
}

// Hover overlay of the inline video player (name, size, download).
function VideoMetaHeader({ name, size, downloadUrl }: { name?: string; size?: number; downloadUrl?: string }) {
  if (!name || !downloadUrl) return null
  return (
    <div className="dcVideoMetadata">
      <div className="dcMetadataContent">
        <div className="dcMetadataName">{name}</div>
        {size ? <div className="dcMetadataSize">{formatFileSize(size)}</div> : null}
      </div>
      <DownloadButton href={downloadUrl} className="dcMetadataDownload" />
    </div>
  )
}

function TextPreview({ att }: { att: NAttachment }) {
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    fetch(att.url, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status))
        const body = await r.text()
        if (!cancelled) setText(body.slice(0, 50000))
      })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true; controller.abort() }
  }, [att.url])
  if (failed) return <FileCard att={att} />
  const lines = text == null ? [] : text.replace(/\r\n/g, '\n').split('\n')
  const collapsible = lines.length > 6
  return (
    <div className="dcTextPreview">
      <div className={`dcTextContainer${!expanded ? ' collapsed' : ''}`} style={{ '--dc-preview-lines': 6 } as CSSProperties}>
        <pre className="dcCodeView"><code>{text == null ? '' : expanded ? text : lines.slice(0, 50).join('\n')}</code></pre>
      </div>
      <div className="dcTextFooter">
        {collapsible && (
          <button type="button" className="dcTextExpand" onClick={() => setExpanded((x) => !x)} aria-label={expanded ? 'Collapse' : 'Expand'}>
            <Icon d={expanded ? PATH_CHEVRON_UP : PATH_CHEVRON_DOWN} size={20} />
          </button>
        )}
        <div className="dcTextNameSection">
          <div className="dcTextNameContainer">
            <span className="dcTextFileName">{att.name}</span>
            <span className="dcTextFileSize">{formatFileSize(att.a.size)}</span>
          </div>
        </div>
        <div className="dcTextFooterGap" />
        <DownloadButton href={att.url} className="dcTextDownload" size={20} />
      </div>
    </div>
  )
}

function AltBadge({ alt }: { alt: string }) {
  // The popout escapes the mosaic item's overflow clip: it is portaled to the
  // chat popout layer and anchored above the badge (Popout position "top",
  // align "left", spacing 8), like Discord's layer above the chat.
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: Event) => {
      if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return
      if (e.type === 'mousedown' && ref.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])
  return (
    <div className="dcAltTextContainer">
      <button
        ref={ref}
        type="button"
        className="dcAltText"
        aria-label="Show alt text"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        ALT
      </button>
      {open && (
        <Popout anchor={() => ref.current} position="top" align="left" spacing={8}>{(pref) => (
          <div ref={pref} className="dcAltTextPopout" role="dialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className="dcAltTextPopoutTitle">Alt text</div>
            <div className="dcAltTextPopoutDescription">{alt}</div>
          </div>
        )}</Popout>
      )}
    </div>
  )
}

function MosaicItem({ att, layout, onOpen, onContextAction }: {
  att: NAttachment
  layout: 'single' | 'grid'
  onOpen: () => void
  onContextAction?: AccessoriesProps['onContextAction']
}) {
  const [revealed, setRevealed] = useState(!att.spoiler)
  const hidden = !revealed
  const media: NMedia = {
    url: att.url,
    src: att.src,
    width: att.width,
    height: att.height,
    description: att.alt,
    animated: att.animated,
    hasProxy: att.src !== att.url,
  }
  const single = layout === 'single'
  const singleBox = single && att.width && att.height
    ? fitMedia({ width: att.width, height: att.height, maxWidth: 550, maxHeight: 350 })
    : null
  let body: ReactNode
  if (att.kind === 'video') {
    let poster: string | undefined
    if (att.src !== att.url) {
      try {
        const p = new URL(att.src)
        p.searchParams.set('format', 'webp')
        poster = p.toString()
      } catch { /* none */ }
    }
    body = <MediaPlayer kind="video" src={att.src} poster={poster} width={att.width || 16} height={att.height || 9} header={<VideoMetaHeader name={att.name} size={att.a.size} downloadUrl={att.url} />} />
  } else {
    body = (
      <MediaImage
        media={media}
        maxWidth={single ? 550 : 550}
        maxHeight={single ? 350 : 350}
        fill={!single}
        className={single ? 'dcMosaicSingleImage' : 'dcMosaicFillImage'}
        imgClassName={single ? undefined : 'dcLazyImg'}
        alt={att.alt || 'Image'}
        onOpen={hidden ? undefined : onOpen}
        onContext={(e) => onContextAction?.({ kind: 'image', url: att.url }, e)}
      />
    )
  }
  return (
    <div
      className={`dcVisualMediaItem${single ? ' single' : ''}`}
      style={singleBox ? { width: singleBox.width, aspectRatio: `${singleBox.width} / ${singleBox.height}` } : undefined}
    >
      <div
        className={`dcMosaicItemContent${att.spoiler ? ' dcSpoilerContainer attachment' : ''}${hidden ? ' hidden' : ''}`}
        onClick={hidden ? (e) => { e.preventDefault(); e.stopPropagation(); setRevealed(true) } : undefined}
      >
        <div className={`dcMosaicItemMedia${hidden ? ' dcObscured' : ''}`} aria-hidden={hidden || undefined}>{body}</div>
        {hidden && <div className="dcSpoilerWarning">Spoiler</div>}
        {!hidden && att.animated && att.kind === 'image' && prefersReducedMotion() && <span className="dcGifTag" aria-hidden="true" />}
        {!hidden && att.alt && <AltBadge alt={att.alt} />}
        {!hidden && att.kind === 'image' && (
          <div className="dcHoverButtonGroup">
            <DownloadButton href={att.url} className="dcHoverButton" size={20} />
          </div>
        )}
      </div>
    </div>
  )
}

function Mosaic({ items, onOpen, onContextAction }: {
  items: NAttachment[]
  onOpen: (att: NAttachment) => void
  onContextAction?: AccessoriesProps['onContextAction']
}) {
  const n = items.length
  const item = (att: NAttachment, layout: 'single' | 'grid', cls?: string) => (
    <div key={att.url} className={cls}>
      <MosaicItem att={att} layout={layout} onOpen={() => onOpen(att)} onContextAction={onContextAction} />
    </div>
  )
  if (n === 1) {
    return <div className="dcMosaic"><div className="dcOneByOneGrid dcOneByOneGridSingle">{item(items[0], 'single', 'dcItemContentContainer')}</div></div>
  }
  if (n === 2) {
    return (
      <div className="dcMosaic dcMosaicMulti">
        <div className="dcOneByTwoGrid">{items.map((a) => item(a, 'grid', 'dcOneByTwoGridItem dcOneByTwoDuoItem'))}</div>
      </div>
    )
  }
  if (n === 3) {
    return (
      <div className="dcMosaic dcMosaicMulti">
        <div className="dcOneByTwoGrid dcOneByTwoLayoutThreeGrid">
          {item(items[0], 'grid', 'dcOneByTwoGridItem dcOneByTwoSoloItem')}
          <div className="dcOneByTwoGridItem dcOneByTwoDuoItem">
            <div className="dcTwoByOneGrid">
              {items.slice(1).map((a) => item(a, 'grid', 'dcTwoByOneGridItem'))}
            </div>
          </div>
        </div>
      </div>
    )
  }
  if (n === 4) {
    return <div className="dcMosaic dcMosaicMulti"><div className="dcTwoByTwoGrid">{items.map((a) => item(a, 'grid', 'dcGridCell'))}</div></div>
  }
  // 5+: a lead row (1 or 2 items) when n isn't a multiple of 3, then 3×3 rows.
  const lead = n % 3
  const head = items.slice(0, lead)
  const rest = items.slice(lead)
  return (
    <div className="dcMosaic dcMosaicMulti">
      {lead === 1 && <div className="dcOneByOneGrid dcOneByOneGridMosaic">{item(head[0], 'grid', 'dcItemContentContainer')}</div>}
      {lead === 2 && <div className="dcOneByTwoGrid">{head.map((a) => item(a, 'grid', 'dcOneByTwoGridItem dcOneByTwoDuoItem'))}</div>}
      <div className="dcThreeByThreeGrid">{rest.map((a) => item(a, 'grid', 'dcGridCell dcSquare'))}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Accessories
// ---------------------------------------------------------------------------

export function MessageAccessories({ message, renderMarkdown, onContextAction }: AccessoriesProps) {
  const attachments = useMemo(
    () => (Array.isArray(message.attachments) ? message.attachments : []).map(normalizeAttachment).filter((a): a is NAttachment => a !== null),
    [message.attachments],
  )
  const policy = useSuppressPolicy()
  const suppressible = canSuppress(message, policy)
  // SUPPRESS_EMBEDS (1 << 2): the author removed the message's embeds.
  const [locallySuppressed, setLocallySuppressed] = useState(false)
  const suppressed = locallySuppressed || ((message.flags ?? 0) & MESSAGE_FLAG_SUPPRESS_EMBEDS) !== 0
  const fallbackVersion = useMediaFallbacks()
  const embeds = useMemo(() => {
    if (suppressed) return []
    const raws = renderableRaws(message)
    return mergeGalleries(raws.map(normalizeEmbed).filter((e): e is NEmbed => e !== null))
    // fallbackVersion: a failed client preview drops out of renderableRaws.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message, suppressed, fallbackVersion])
  // Client previews (renderableRaws) whose media fails to load are withdrawn
  // - media error events don't bubble, so listen in the capture phase.
  const previewKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const raw of renderableRaws(message)) {
      if (raw[SYNTHETIC] !== true) continue
      keys.add(mediaKey(str(raw.url)))
      const v = raw.video as Raw | undefined
      if (v) keys.add(mediaKey(str(v.url)))
    }
    return keys
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message, fallbackVersion])
  const accessoriesRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = accessoriesRef.current
    if (!el || !previewKeys.size) return
    const onError = (e: Event) => {
      const t = e.target as HTMLElement | null
      if (!t || (t.tagName.toUpperCase() !== 'IMG' && t.tagName.toUpperCase() !== 'VIDEO')) return
      const key = mediaKey(t.getAttribute('src'))
      if (!previewKeys.has(key)) return
      // Withdraw the link's preview (by its content URL key).
      for (const raw of renderableRaws(message)) {
        const v = raw.video as Raw | undefined
        if (raw[SYNTHETIC] === true && (mediaKey(str(raw.url)) === key || (v && mediaKey(str(v.url)) === key))) markPreviewFailed(mediaKey(str(raw.url)))
      }
    }
    el.addEventListener('error', onError, true)
    return () => el.removeEventListener('error', onError, true)
  }, [message, previewKeys])

  const visual = attachments.filter((a) => a.kind === 'image' || a.kind === 'video')
  const stickers = attachments.filter((a) => a.kind === 'sticker')
  const nonVisual = attachments.filter((a) => a.kind === 'audio' || a.kind === 'text' || a.kind === 'file')

  // Every openable visual item in the message, in render order, so the image
  // modal can page through them.
  const mediaItems: MediaModalItem[] = useMemo(() => {
    const items: MediaModalItem[] = []
    for (const a of visual) {
      if (a.kind === 'image') items.push({ src: a.src, original: a.url, width: a.width, height: a.height, kind: 'image', alt: a.alt })
    }
    for (const e of embeds) {
      const add = (m: NMedia | undefined) => { if (m) items.push({ src: m.src, original: m.url, width: m.width, height: m.height, kind: 'image', alt: m.description }) }
      if (e.images) e.images.forEach(add)
      else add(e.image)
      if (!e.video) add(e.thumbnail)
    }
    return items
  }, [visual, embeds])

  if (!attachments.length && !embeds.length) return null
  const content = message.content || ''
  const openAttachment = (att: NAttachment) => {
    const idx = mediaItems.findIndex((m) => m.original === att.url)
    openMediaModal(mediaItems, idx >= 0 ? idx : 0)
  }
  return (
    <div className="dcAccessories" ref={accessoriesRef}>
      {visual.length > 0 && <Mosaic items={visual.slice(0, 10)} onOpen={openAttachment} onContextAction={onContextAction} />}
      {nonVisual.length > 0 && (
        <div className="dcNonVisualMediaContainer">
          {nonVisual.map((att) => (
            <div key={att.url} className="dcNonVisualMediaItem">
              {att.kind === 'audio'
                ? <MediaPlayer kind="audio" src={att.src} durationHint={att.a.durationSecs} header={<AudioMetaHeader href={att.url || att.src} name={att.name} size={att.a.size} downloadUrl={att.url} />} />
                : att.kind === 'text'
                  ? <TextPreview att={att} />
                  : <FileCard att={att} onContextAction={onContextAction} />}
            </div>
          ))}
        </div>
      )}
      {stickers.map((s) => (
        <div key={s.url} className="dcStickerAsset">
          <img src={s.src} alt={s.name} title={s.name} width={160} height={160} loading="lazy" draggable={false} />
        </div>
      ))}
      {embeds.map((e, i) => (
        <EmbedView
          key={`${e.url || ''}-${i}`}
          embed={e}
          renderMarkdown={renderMarkdown}
          spoiler={isSpoilerUrl(content, e.url)}
          mediaItems={mediaItems}
          onContextAction={onContextAction}
          onSuppress={suppressible ? (skip) => requestSuppress(message, skip, () => setLocallySuppressed(true)) : undefined}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Reply preview text (Discord repliedTextPreview): attachment-only replies
// read "Click to see attachment" (italic placeholder) + the image glyph; text
// replies with attachments get the glyph trailing.
// ---------------------------------------------------------------------------

export function ReplyPreviewText({ message, fallback }: { message: BridgeMessage; fallback?: string }) {
  const hasAttachments = (Array.isArray(message.attachments) && message.attachments.length > 0)
    || (Array.isArray(message.embeds) && message.embeds.length > 0 && !message.content)
  const content = shouldHideContent(message) ? '' : (message.content || '')
  if (content) {
    return (
      <>
        <span className="dcRepliedTextContent">{content}</span>
        {hasAttachments && <Icon d={PATH_IMAGE} size={20} className="dcRepliedTextIcon trailing" />}
      </>
    )
  }
  if (hasAttachments || message.embeds?.length) {
    return (
      <>
        <span className="dcRepliedTextPlaceholder">Click to see attachment</span>
        <Icon d={PATH_IMAGE} size={20} className="dcRepliedTextIcon trailing" />
      </>
    )
  }
  return <>{fallback ?? ''}</>
}

// Route a click on an <a> inside message content markup through Discord's
// masked-link warning. Exported for MessageBody's delegation handler.
export { guardLinkClick } from './LinkGuard'
