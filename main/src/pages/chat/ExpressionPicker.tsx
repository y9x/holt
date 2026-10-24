import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { usePopoutPosition, type PopoutAnchor, type PopoutOptions } from './popout'
import { HolyText } from '../../components/common/HolyText'
import { HolyInput } from '../../components/common/HolyAttr'
import { HolyRich } from '../../components/common/HolyRich'
import { popoutLayer } from './overlay'
import type { EmojiEntry } from './emoji-data'
import { pickerCategories, pickerEmoji, applyTone, toneSwatch, setEmojiTone, useEmojiTone } from './emoji-tone'
import { frecentEmoji, useEmojiUsageVersion } from './emoji-frecency'
import { Emoji } from './Emoji'
import { eventWithinSelector } from './ContextMenu'
import {
  klipyGifsSearch, klipyGifsTrending, klipyStickersSearch, klipyStickersTrending,
  klipyPreview, klipyFull, type KlipyObject,
} from '../../lib/klipy'

/* Discord's expression picker rebuilt to match the current visual refresh:
 * top nav (GIFs / Stickers / Emoji), a search header with the skin-tone
 * diversity selector, Discord's 48px left category rail (categoryList_c0e32c:
 * Frequently Used clock, guild icons, unicode category glyphs) beside a
 * scrolling body of collapsible section headers. Emoji glyphs
 * are Twemoji; GIFs and Stickers come from KLIPY and are gated behind the
 * SEND_EMBEDS permission (mod+). GIF/sticker grids stay in KLIPY's returned
 * order and are kept in dedicated tabs, per KLIPY's "separate content
 * sources" rule. */

/* Discord's own glyphs (web.js icon modules, verbatim) - no lucide outlines. */
function PickerChevronRightIcon({ size, className }: { size: number; className?: string }) {
  // ChevronSmallRightIcon
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path fill="currentColor" d="M9.3 5.3a1 1 0 0 0 0 1.4l5.29 5.3-5.3 5.3a1 1 0 1 0 1.42 1.4l6-6a1 1 0 0 0 0-1.4l-6-6a1 1 0 0 0-1.42 0Z" />
    </svg>
  )
}

function PickerSearchIcon({ size, className }: { size: number; className?: string }) {
  // MagnifyingGlassIcon - evenodd keeps the lens hollow.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d="M15.62 17.03a9 9 0 1 1 1.41-1.41l4.68 4.67a1 1 0 0 1-1.42 1.42l-4.67-4.68ZM17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z" />
    </svg>
  )
}

function PickerClockIcon({ size }: { size: number }) {
  // ClockIcon - the emoji picker's RECENT ("Frequently Used") category glyph.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className="pickerSectionGlyph">
      <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d="M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22Zm1-18a1 1 0 1 0-2 0v7c0 .27.1.52.3.7l3 3a1 1 0 0 0 1.4-1.4L13 11.58V5Z" />
    </svg>
  )
}

/* Category rail glyphs - the emoji picker's category icon switch (web.js
 * `categoryId → Icon`), paths verbatim: RECENT ClockIcon, PEOPLE (460905),
 * NATURE (413249), FOOD (141060), ACTIVITY GameControllerIcon, TRAVEL
 * (115979), OBJECTS (524501), SYMBOLS HeartIcon, FLAGS FlagIcon. */
const CATEGORY_ICON_PATHS: Record<string, { d: string; evenodd?: boolean }[]> = {
  recent: [{ evenodd: true, d: 'M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22Zm1-18a1 1 0 1 0-2 0v7c0 .27.1.52.3.7l3 3a1 1 0 0 0 1.4-1.4L13 11.58V5Z' }],
  people: [{ evenodd: true, d: 'M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22ZM6.5 13a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm11 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm-9.8 1.17a1 1 0 0 1 1.39.27 3.5 3.5 0 0 0 5.82 0 1 1 0 0 1 1.66 1.12 5.5 5.5 0 0 1-9.14 0 1 1 0 0 1 .27-1.4Z' }],
  nature: [{ d: 'M9.8 14.6c-.45.31-.9.6-1.37.89l-.02.01-1.15.73c-.85.57-1.68 1.2-2.4 2.1a7.75 7.75 0 0 0-.7 1.03c-.39.69-.7 1.48-.94 2.42a1 1 0 0 0 1.94.49c.12-.49.26-.9.42-1.28 1.98.08 9.05-.04 12.73-5.34 3.5-5.02 2.89-10.16 2.01-13.89-.19-.81-1.26-1-1.85-.42-1.8 1.8-3.69 2.32-5.67 2.86-2.34.63-4.8 1.3-7.35 4.15a9.13 9.13 0 0 0-2.13 8.7c.9-1.11 1.92-1.88 2.84-2.48.4-.28.8-.53 1.18-.76a13.7 13.7 0 0 0 3.55-2.83 1 1 0 1 1 1.52 1.3A13.44 13.44 0 0 1 9.8 14.6Z' }],
  food: [{ d: 'M7 1a1 1 0 0 0-1 1v.2c0 .79-.4 1.53-1.05 1.97A4.37 4.37 0 0 0 3 7.8V8a1 1 0 0 0 2 0v-.2c0-.79.4-1.53 1.05-1.97A4.37 4.37 0 0 0 8 2.2V2a1 1 0 0 0-1-1ZM10 3a1 1 0 1 1 2 0v.42a3.2 3.2 0 0 1-2.18 3.03A1.2 1.2 0 0 0 9 7.58V8a1 1 0 0 1-2 0v-.42c0-1.37.88-2.6 2.18-3.03.5-.16.82-.62.82-1.13V3ZM2 11a1 1 0 0 1 1-1h18a1 1 0 0 1 1 1 10 10 0 0 1-4.7 8.49.6.6 0 0 0-.3.51 2 2 0 0 1-2 2H9a2 2 0 0 1-2-2 .6.6 0 0 0-.3-.51A10 10 0 0 1 2 11ZM20.85 8.02c.16.52-.3.98-.85.98h-8c-.55 0-1.01-.46-.85-.98a4.07 4.07 0 0 1 1.31-1.84 5.23 5.23 0 0 1 1.63-.88 6.1 6.1 0 0 1 3.82 0c.61.2 1.16.5 1.63.87a4.07 4.07 0 0 1 1.3 1.85Z' }],
  activity: [{ evenodd: true, d: 'M20.97 4.06c0 .18.08.35.24.43.55.28.9.82 1.04 1.42.3 1.24.75 3.7.75 7.09v4.91a3.09 3.09 0 0 1-5.85 1.38l-1.76-3.51a1.09 1.09 0 0 0-1.23-.55c-.57.13-1.36.27-2.16.27s-1.6-.14-2.16-.27c-.49-.11-1 .1-1.23.55l-1.76 3.51A3.09 3.09 0 0 1 1 17.91V13c0-3.38.46-5.85.75-7.1.15-.6.49-1.13 1.04-1.4a.47.47 0 0 0 .24-.44c0-.7.48-1.32 1.2-1.47l2.93-.62c.5-.1 1 .06 1.36.4.35.34.78.71 1.28.68a42.4 42.4 0 0 1 4.4 0c.5.03.93-.34 1.28-.69.35-.33.86-.5 1.36-.39l2.94.62c.7.15 1.19.78 1.19 1.47ZM20 7.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM15.5 12a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM5 7a1 1 0 0 1 2 0v1h1a1 1 0 0 1 0 2H7v1a1 1 0 1 1-2 0v-1H4a1 1 0 1 1 0-2h1V7Z' }],
  travel: [{ evenodd: true, d: 'M15 4a1 1 0 0 0-.95 1.32l.9 2.68h-4.6l-.92-2.36A1 1 0 0 0 8.5 5H5a1 1 0 0 0 0 2h2.82l.5 1.27a1 1 0 0 0-.2.26L6.7 11.16a4.5 4.5 0 1 0 1.76.95l.78-1.45 1.83 4.7a1 1 0 1 0 1.86-.72L11.13 10h4.48l.55 1.65a4.5 4.5 0 1 0 1.9-.63L16.4 6h1.86c.41 0 .75.34.75.75V7a1 1 0 1 0 2 0v-.25A2.75 2.75 0 0 0 18.25 4H15Zm-9.3 9-1.08 2.03a1 1 0 0 0 1.76.94l1.09-2.01A2.5 2.5 0 1 1 5.7 13Zm11.13.64.72 2.18a1 1 0 0 0 1.9-.64l-.73-2.17a2.5 2.5 0 1 1-1.9.63Z' }],
  objects: [{ d: 'M10.41 3.59 11.6 2.4a2 2 0 0 1 2.82 0l1.3 1.3a1 1 0 0 0 .7.29h4.18a1.41 1.41 0 0 1 1 2.41L14.4 13.6a1.41 1.41 0 0 1-2.41-1V8.4l-3.11 3.12a2 2 0 0 0-.53 1.87L9.9 20H15a1 1 0 1 1 0 2H3a1 1 0 1 1 0-2h4.86L6.4 13.86a4 4 0 0 1 1.06-3.75L10.8 6.8l-.38-.38a2 2 0 0 1 0-2.82Z' }, { d: 'M16.99 12.43c-.21.2-.2.55.06.7a3 3 0 0 0 4.08-4.08c-.15-.26-.5-.27-.7-.06l-3.44 3.44Z' }],
  symbols: [{ d: 'M12.47 21.73a.92.92 0 0 1-.94 0C9.43 20.48 1 15.09 1 8.75A5.75 5.75 0 0 1 6.75 3c2.34 0 3.88.9 5.25 2.26A6.98 6.98 0 0 1 17.25 3 5.75 5.75 0 0 1 23 8.75c0 6.34-8.42 11.73-10.53 12.98Z' }],
  flags: [{ d: 'M3 1a1 1 0 0 1 1 1v.82l8.67-1.45A2 2 0 0 1 15 3.35v1.47l5.67-.95A2 2 0 0 1 23 5.85v7.3a2 2 0 0 1-1.67 1.98l-9 1.5a2 2 0 0 1-1.78-.6c-.2-.21-.08-.54.18-.68a5.01 5.01 0 0 0 1.94-1.94c.18-.32-.1-.66-.46-.6L4 14.18V21a1 1 0 1 1-2 0V2a1 1 0 0 1 1-1Z' }],
}

function CategoryIcon({ id }: { id: string }) {
  const paths = CATEGORY_ICON_PATHS[id]
  if (!paths) return null
  // --custom-emoji-picker-constants-unicode-category-icon-size: 24px
  return (
    <svg width={24} height={24} viewBox="0 0 24 24" fill="none" aria-hidden="true" className="pickerCategoryIcon">
      {paths.map((p, i) => (
        <path key={i} fill="currentColor" d={p.d} {...(p.evenodd ? { fillRule: 'evenodd' as const, clipRule: 'evenodd' as const } : {})} />
      ))}
    </svg>
  )
}

export type PickerTab = 'gifs' | 'stickers' | 'emoji'

/* Right-click targets inside the picker. chat.tsx owns the context menu (and
 * Discord's menu icons), so the picker only reports WHAT was right-clicked -
 * plus closures for picker-local state (section collapse, tone, tab). */
export type PickerContextAction =
  | { kind: 'emoji'; entry: EmojiEntry }
  | { kind: 'gif' | 'sticker'; obj: KlipyObject; previewUrl: string | null; full: { url: string; width: number; height: number } | null }
  | { kind: 'section'; label: string; collapsed: boolean; toggle: () => void; collapseAll: () => void }
  | { kind: 'tone'; tone: number; select: (tone: number) => void }
  | { kind: 'tab'; tab: PickerTab; select: (tab: PickerTab) => void }

export interface ExpressionPickerProps {
  klipyKey: string | null
  canSendEmbeds: boolean
  guildName: string
  guildIcon: string | null
  /** Tab the picker opens on (Discord's GIF/sticker buttons deep-link to their tab). */
  initialTab?: PickerTab
  /** Reaction intention (message Add Reaction): placeholder "Find the
      perfect reaction" instead of "Find the perfect emoji" (Discord wT). */
  reaction?: boolean
  /** Emoji tab only (Discord's profile bio input: expressionPicker onlyEmojis,
      no GIF/sticker tabs). */
  emojiOnly?: boolean
  /** keepOpen: Shift was held (Discord's isFinalSelection = !shiftKey -
      the picker stays open to pick several). */
  onPickEmoji: (surrogates: string, keepOpen?: boolean) => void
  onPickGif: (full: { url: string; width: number; height: number }, obj: KlipyObject) => void
  onPickSticker: (full: { url: string; width: number; height: number }, obj: KlipyObject) => void
  onClose: () => void
  /** Right-click on a picker element - chat.tsx opens the matching menu. */
  onContextAction?: (action: PickerContextAction, e: React.MouseEvent) => void
  /** What the picker hangs off + how (Discord: the composer's channel text
      area, position "top", align "right", spacing 8, autoInvert; the message
      toolbar's Add Reaction button for react mode). */
  anchor?: PopoutAnchor | (() => PopoutAnchor)
  placement?: PopoutOptions
}

// onClose dismisses the picker: Escape, or a mousedown outside it (the
// buttons that toggle it are excluded so their own click handler decides).

/* Skin-tone (diversity) support lives in emoji-tone.ts: the grid shows each
 * diversity-capable emoji once (variants filtered out), rendered in the
 * user's persisted tone; tone 0 = default yellow. */

const TONE_LABELS = ['None', 'Light skin tone', 'Medium-light skin tone', 'Medium skin tone', 'Medium dark skin tone', 'Dark skin tone']

/** Discord's diversity selector (diversitySelector_a45a2a, web.js tY/tW): a
 * 38px button (24px toned 👏 + 7px padding) right of the search field; the
 * open listbox overlays it (top/inset-inline-end -1px) with the CURRENT tone
 * first, then the rest in order, each a 38px row; height animates open. */
function DiversitySelector({ tone, onSelect, flyoutOpen, onToggleFlyout, onContextAction }: {
  tone: number
  onSelect: (tone: number) => void
  flyoutOpen: boolean
  onToggleFlyout: () => void
  onContextAction?: ExpressionPickerProps['onContextAction']
}) {
  const order = [tone, ...[0, 1, 2, 3, 4, 5].filter((t) => t !== tone)]
  return (
    <div className="diversityWrap" onContextMenu={(e) => onContextAction?.({ kind: 'tone', tone, select: onSelect }, e)}>
      <button
        type="button"
        className="diversitySelector"
        aria-label={`Select emoji skin tone, ${TONE_LABELS[tone]}`}
        aria-haspopup="listbox"
        aria-expanded={flyoutOpen}
        tabIndex={flyoutOpen ? -1 : 0}
        onClick={onToggleFlyout}
      >
        <Emoji entry={toneSwatch[tone]} size={24} className="diversitySwatch" />
      </button>
      {flyoutOpen && (
        <div className="diversityFlyout" role="listbox" aria-label="Skin tone" style={{ ['--diversity-count' as string]: order.length }}>
          {order.map((t, i) => (
            <button
              key={t}
              type="button"
              role="option"
              aria-selected={i === 0}
              aria-label={TONE_LABELS[t]}
              className="diversityOption"
              style={{ animationDelay: `${20 * i}ms` }}
              onClick={() => onSelect(t)}
            >
              <Emoji entry={toneSwatch[t]} size={24} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* CircleXIcon - the Mana TextInput clear button (web.js 285796). */
function PickerClearIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d="M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22Zm4.7-15.7a1 1 0 0 0-1.4 0L12 10.58l-3.3-3.3a1 1 0 0 0-1.4 1.42L10.58 12l-3.3 3.3a1 1 0 1 0 1.42 1.4L12 13.42l3.3 3.3a1 1 0 0 0 1.4-1.42L13.42 12l3.3-3.3a1 1 0 0 0 0-1.4Z" />
    </svg>
  )
}

function SectionHeader({ label, collapsed, onToggle, icon, glyph, onContextMenu }: { label: string; collapsed: boolean; onToggle: () => void; icon?: string | null; glyph?: ReactNode; onContextMenu?: (e: React.MouseEvent) => void }) {
  return (
    <div className="pickerSectionHeader" onClick={onToggle} role="button" aria-expanded={!collapsed} onContextMenu={onContextMenu}>
      <PickerChevronRightIcon size={16} className={`chevron ${collapsed ? 'collapsed' : ''}`} />
      {glyph}
      {icon && <img className="guildIcon" src={icon} alt="" />}
      <span className="pickerSectionLabel">{label}</span>
    </div>
  )
}

/* Discord's emoji category rail (categoryList_c0e32c, 48px wide, list
 * padding [8,8,0,8]) - one categoryItem per section: RECENT (clock), each
 * guild with custom emoji (32px squircle icon + a guildCategorySeparator rule
 * after the last guild), then the unicode categories. Each item carries the
 * small left pill (categoryPill, inset-inline-start -8px); unicode/recent
 * items get the selected background (categoryItemDefaultCategorySelected).
 * Clicking scrolls the body to that section; the active item follows the
 * scroll position. */
export interface PickerRailCategory { key: string; label: string; kind: 'recent' | 'guild' | 'unicode'; icon?: string | null }

function CategoryRail({ categories, active, onSelect }: { categories: PickerRailCategory[]; active: string; onSelect: (key: string) => void }) {
  const listRef = useRef<HTMLDivElement>(null)
  // Keep the active item in view as the body scrolls (Discord's
  // scrollRowIntoView on activeCategoryIndex change).
  useEffect(() => {
    const list = listRef.current
    const el = list?.querySelector<HTMLElement>('.pickerCategoryItem.selected')
    if (!list || !el) return
    if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop - 8
    else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight + 8
  }, [active])
  return (
    <div className="pickerCategoryList" ref={listRef} role="tablist" aria-orientation="vertical" aria-label="Emoji categories">
      {categories.map((c, i) => {
        const selected = c.key === active
        const next = categories[i + 1]
        const item = (
          <button
            key={c.key}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={c.label}
            title={c.label}
            className={`pickerCategoryItem ${c.kind === 'guild' ? 'pickerCategoryItemGuild' : 'pickerCategoryItemDefault'}${c.kind === 'recent' ? ' pickerCategoryItemRecent' : ''}${selected ? ' selected' : ''}`}
            onClick={() => onSelect(c.key)}
          >
            <div className="pickerCategoryPill" aria-hidden="true"><span /></div>
            {c.kind === 'guild'
              ? (c.icon ? <img className="pickerCategoryGuildIcon" src={c.icon} alt="" /> : <div className="pickerCategoryGuildIcon pickerCategoryGuildAcronym">{c.label.split(/\s+/).map((w) => w[0]).join('').slice(0, 3)}</div>)
              : <CategoryIcon id={c.kind === 'recent' ? 'recent' : c.key} />}
          </button>
        )
        return c.kind === 'guild' && next && next.kind !== 'guild'
          ? [item, <hr key={`${c.key}-sep`} className="pickerCategorySeparator" />]
          : item
      })}
    </div>
  )
}

function GifGrid({ results, onPick, loading, onItemContext }: { results: KlipyObject[]; onPick: (o: KlipyObject) => void; loading: boolean; onItemContext?: (o: KlipyObject, previewUrl: string, e: React.MouseEvent) => void }) {
  if (loading && !results.length) return <div className="pickerEmpty">Loading…</div>
  if (!results.length) return <div className="pickerEmpty"><HolyText text="No results." /></div>
  return (
    <div className="gifGrid">
      {results.map((o) => {
        const p = klipyPreview(o)
        if (!p) return null
        return (
          <button key={o.id} type="button" className="gifItem" onClick={() => onPick(o)} onContextMenu={(e) => onItemContext?.(o, p.url, e)} title={o.content_description || o.title || ''}>
            <img src={p.url} alt={o.content_description || o.title || 'gif'} loading="lazy" />
          </button>
        )
      })}
    </div>
  )
}

export function ExpressionPicker({ klipyKey, canSendEmbeds, guildName, guildIcon, initialTab, reaction, emojiOnly, onPickEmoji, onPickGif, onPickSticker, onClose, onContextAction, anchor, placement }: ExpressionPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  usePopoutPosition(rootRef, anchor, { ...(placement ?? { position: 'top', align: 'right', spacing: 8 }), enabled: anchor != null })
  const [tab, setTab] = useState<PickerTab>(initialTab || 'emoji')

  // Sync to initialTab whenever the picker is (re)opened - opening the emoji
  // menu must always land on the emoji tab, never a stale GIF/sticker tab from
  // a previous open. (useState only reads initialTab on first mount.)
  useEffect(() => {
    if (initialTab) setTab(initialTab)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab])
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [hovered, setHovered] = useState<EmojiEntry | null>(null)
  const [gifs, setGifs] = useState<KlipyObject[]>([])
  const [stickers, setStickers] = useState<KlipyObject[]>([])
  const [loadingMedia, setLoadingMedia] = useState(false)
  const tone = useEmojiTone()
  // Frequently Used - the real frecency store (emoji-frecency.ts), base
  // entries rendered in the current tone; Discord hides the section (and its
  // rail item) while it's empty.
  const usageVersion = useEmojiUsageVersion()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const frequent = useMemo(() => frecentEmoji(), [usageVersion])
  // Whether the header skin-tone selector's listbox is open.
  const [toneFlyout, setToneFlyout] = useState<'header' | null>(null)
  const toneFlyoutRef = useRef(toneFlyout)
  const onCloseRef = useRef(onClose)
  const anchorRef = useRef(anchor)
  useEffect(() => {
    toneFlyoutRef.current = toneFlyout
    onCloseRef.current = onClose
    anchorRef.current = anchor
  })
  const bodyRef = useRef<HTMLDivElement>(null)
  const [activeCategory, setActiveCategory] = useState('recent')
  // A rail click while searching clears the search first; the scroll to the
  // section happens once the category sections have rendered again.
  const pendingCategoryRef = useRef<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const selectTone = (t: number) => {
    setEmojiTone(t)
    setToneFlyout(null)
  }

  const toggle = (name: string) => {
    setCollapsed((cur) => {
      const next = new Set(cur)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  // Close the skin-tone flyout on any click outside the selector, and when
  // leaving the emoji tab (the selector only exists on that tab).
  useEffect(() => {
    if (!toneFlyout) return
    const onDocMouseDown = (e: MouseEvent) => {
      if (!eventWithinSelector(e, '.diversityWrap')) setToneFlyout(null)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [toneFlyout])

  // Dismiss (Discord): Escape closes an open tone flyout first, then the
  // picker; a mousedown outside the picker closes it. The composer's
  // emoji/GIF/sticker buttons and the shared context menu (right-click inside
  // the picker) are excluded - they toggle/act on the picker themselves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (toneFlyoutRef.current) setToneFlyout(null)
      else onCloseRef.current()
    }
    // Dispatch-path test (not e.target.closest): a press on a picker control
    // that re-renders away mid-event must still count as inside the picker.
    const onDocMouseDown = (e: MouseEvent) => {
      if (eventWithinSelector(e, '.picker, .chat-emojiButton, .chat-composer-btn, .contextMenuLayer')) return
      // A press on the element the picker hangs from (react mode: the Add
      // Reaction button) is left to that button's click, which toggles.
      const a = anchorRef.current
      if (a instanceof Element && e.composedPath().includes(a)) return
      onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDocMouseDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDocMouseDown)
    }
  }, [])

  useEffect(() => {
    if (tab !== 'emoji') setToneFlyout(null)
  }, [tab])

  // Fetch GIFs/stickers from KLIPY (debounced search, trending when blank).
  useEffect(() => {
    if (tab === 'emoji' || !klipyKey || !canSendEmbeds) return
    setLoadingMedia(true)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      const q = search.trim()
      const run = tab === 'gifs'
        ? (q ? klipyGifsSearch(klipyKey, q) : klipyGifsTrending(klipyKey))
        : (q ? klipyStickersSearch(klipyKey, q) : klipyStickersTrending(klipyKey))
      run
        .then((page) => (tab === 'gifs' ? setGifs(page.results) : setStickers(page.results)))
        .catch(() => (tab === 'gifs' ? setGifs([]) : setStickers([])))
        .finally(() => setLoadingMedia(false))
    }, 250)
    return () => clearTimeout(debounceRef.current)
  }, [tab, search, klipyKey, canSendEmbeds])

  const filteredEmoji = useMemo(
    () => (search ? pickerEmoji.filter(([name]) => name.includes(search.toLowerCase())) : pickerEmoji),
    [search],
  )

  // Custom guild emoji - the bridge doesn't expose any yet, so the guild
  // section (Discord's first emoji section) stays empty/hidden until it does.
  const guildEmoji: EmojiEntry[] = []

  // Rail categories in body order. Discord lists a guild only when it has
  // custom emoji, so the guild item appears with the guild section.
  const railCategories: PickerRailCategory[] = [
    ...(frequent.length > 0 ? [{ key: 'recent', label: 'Frequently Used', kind: 'recent' as const }] : []),
    ...(guildEmoji.length > 0 ? [{ key: 'guild', label: guildName, kind: 'guild' as const, icon: guildIcon }] : []),
    ...pickerCategories.map((c) => ({ key: c.key, label: c.label, kind: 'unicode' as const })),
  ]

  const scrollToCategory = (key: string) => {
    const body = bodyRef.current
    const section = body?.querySelector<HTMLElement>(`.pickerSection[data-category="${key}"]`)
    if (!body || !section) return
    body.scrollTop = section.offsetTop
    setActiveCategory(key)
  }
  const selectCategory = (key: string) => {
    setActiveCategory(key)
    if (search) {
      pendingCategoryRef.current = key
      setSearch('')
      return
    }
    scrollToCategory(key)
  }
  useEffect(() => {
    if (search || !pendingCategoryRef.current) return
    const key = pendingCategoryRef.current
    pendingCategoryRef.current = null
    scrollToCategory(key)
  })
  // Scroll spy: the active category is the last section whose top has
  // reached the top of the scroller (Discord's activeCategoryIndex).
  const onBodyScroll = () => {
    const body = bodyRef.current
    if (!body || search) return
    let current = railCategories[0]?.key ?? 'recent'
    for (const el of body.querySelectorAll<HTMLElement>('.pickerSection[data-category]')) {
      if (el.offsetTop <= body.scrollTop + 1) current = el.dataset.category || current
      else break
    }
    if (current !== activeCategory) setActiveCategory(current)
  }

  // Context-menu reporters (see PickerContextAction).
  const emojiContext = (entry: EmojiEntry) => (e: React.MouseEvent) => onContextAction?.({ kind: 'emoji', entry }, e)
  const sectionContext = (label: string) => (e: React.MouseEvent) => onContextAction?.({
    kind: 'section',
    label,
    collapsed: collapsed.has(label),
    toggle: () => toggle(label),
    collapseAll: () => setCollapsed(new Set([guildName, 'Frequently Used', ...pickerCategories.map((c) => c.label)])),
  }, e)
  const mediaContext = (kind: 'gif' | 'sticker') => (o: KlipyObject, previewUrl: string, e: React.MouseEvent) => onContextAction?.({ kind, obj: o, previewUrl, full: klipyFull(o) }, e)
  const selectTab = (t: PickerTab) => { setTab(t); setSearch('') }

  // Emoji tab: Discord's default placeholder, swapped for the hovered
  // emoji's :name: while inspecting (setSearchPlaceholder on inspect).
  const placeholder = tab === 'emoji'
    ? (hovered ? `:${hovered[0]}:` : reaction ? 'Find the perfect reaction' : 'Find the perfect emoji')
    : 'Search KLIPY'
  const searchRef = useRef<HTMLInputElement>(null)

  const picker = (
    <div
      ref={rootRef}
      className="picker"
      role="dialog"
      aria-label="Expression Picker"
      // Anything inside the picker without its own menu (tabs, body gaps,
      // inspector) gets the tab-switch menu; specific targets above call
      // onContextAction first and preventDefault, so this skips them.
      onContextMenu={(e) => { if (!e.defaultPrevented) onContextAction?.({ kind: 'tab', tab, select: selectTab }, e) }}
    >
      {/* Discord's expression picker (contentWrapper__08434): a 30px tab row
          (nav__08434, GIFs / Stickers / Emoji), 12px gap, then the active
          picker whose header (header_c0e32c) holds the full-width search
          field and - on the emoji tab - the skin-tone selector. */}
      <nav className="pickerNav">
        <div className="pickerNavList" role="tablist" aria-label="Expression Picker">
          {(emojiOnly ? (['emoji'] as const) : (['gifs', 'stickers', 'emoji'] as const)).map((t) => (
            <div key={t} className="pickerNavItem">
              <button
                type="button"
                role="tab"
                aria-selected={tab === t}
                className={`pickerNavButton${tab === t ? ' active' : ''}`}
                onClick={() => selectTab(t)}
              >
                {t === 'gifs' ? 'GIFs' : t === 'stickers' ? 'Stickers' : 'Emoji'}
              </button>
            </div>
          ))}
        </div>
      </nav>
      <div className="pickerContent">
      <div className="pickerHeader">
        <div className={`pickerSearchBar${search ? ' hasTrailing' : ''}`}>
          <div className="pickerSearchIcon" aria-hidden="true"><PickerSearchIcon size={16} /></div>
          <HolyInput
            ref={searchRef}
            type="text"
            className="pickerSearch"
            placeholder={placeholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
            role={tab === 'emoji' ? 'combobox' : undefined}
            aria-label={tab === 'emoji' ? 'Search emoji' : `Search ${tab === 'gifs' ? 'GIFs' : 'stickers'}`}
          />
          {search && (
            <button
              type="button"
              className="pickerSearchClear"
              aria-label="Clear"
              onClick={() => { setSearch(''); requestAnimationFrame(() => searchRef.current?.focus()) }}
            >
              <PickerClearIcon size={16} />
            </button>
          )}
        </div>
        {tab === 'emoji' && (
          <DiversitySelector tone={tone} onSelect={selectTone} flyoutOpen={toneFlyout === 'header'} onToggleFlyout={() => setToneFlyout((o) => (o === 'header' ? null : 'header'))} onContextAction={onContextAction} />
        )}
      </div>

      {tab === 'emoji' ? (
        <>
          {/* Emoji body: the 48px category rail on the left (spanning down
              past the inspector, Discord's grid column 1), the sections +
              inspector in column 2. Each category is a collapsible section
              header row; the bridge has no custom guild emoji yet, so the
              guild section (and its rail icon) stays hidden until it does. */}
          <div className="pickerEmojiLayout">
          <CategoryRail categories={railCategories} active={railCategories.some((c) => c.key === activeCategory) ? activeCategory : railCategories[0].key} onSelect={selectCategory} />
          <div className="pickerEmojiColumn">
          <div className="pickerBody pickerEmojiBody" ref={bodyRef} onScroll={onBodyScroll}>
            {search ? (
              <div className="pickerSection">
                <div className="pickerSectionHeader"><span className="pickerSectionLabel">Results</span></div>
                <div className="pickerGrid">
                  {filteredEmoji.map((entry) => {
                    const toned = applyTone(entry, tone)
                    return (
                      <button key={entry[0]} type="button" className="pickerItem" onMouseEnter={() => setHovered(toned)} onClick={(e) => onPickEmoji(toned[1], e.shiftKey)} onContextMenu={emojiContext(toned)} aria-label={`:${entry[0]}:`}>
                        <Emoji entry={toned} size={32} />
                      </button>
                    )
                  })}
                </div>
              </div>
            ) : (
              <>
                {/* Guild section first (Discord's layout): guild icon + guild
                    name holding the server's custom emoji. The bridge exposes no
                    custom guild emoji yet, so this stays empty and hidden -
                    when custom emoji land, render them here and the section
                    appears above "Frequently Used". */}
                {guildEmoji.length > 0 && (
                  <div className="pickerSection" data-category="guild">
                    <SectionHeader label={guildName} collapsed={collapsed.has(guildName)} onToggle={() => toggle(guildName)} icon={guildIcon} onContextMenu={sectionContext(guildName)} />
                    {!collapsed.has(guildName) && (
                      <div className="pickerGrid">
                        {guildEmoji.map((entry) => {
                          const toned = applyTone(entry, tone)
                          return (
                            <button key={entry[0]} type="button" className="pickerItem" onMouseEnter={() => setHovered(toned)} onClick={(e) => onPickEmoji(toned[1], e.shiftKey)} onContextMenu={emojiContext(toned)} aria-label={`:${entry[0]}:`}>
                              <Emoji entry={toned} size={32} />
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
                {frequent.length > 0 && <div className="pickerSection" data-category="recent">
                  <SectionHeader label="Frequently Used" collapsed={collapsed.has('Frequently Used')} onToggle={() => toggle('Frequently Used')} glyph={<PickerClockIcon size={16} />} onContextMenu={sectionContext('Frequently Used')} />
                  {!collapsed.has('Frequently Used') && (
                    <div className="pickerGrid">
                      {frequent.map((entry) => {
                        const toned = applyTone(entry, tone)
                        return (
                          <button key={entry[0]} type="button" className="pickerItem" onMouseEnter={() => setHovered(toned)} onClick={(e) => onPickEmoji(toned[1], e.shiftKey)} onContextMenu={emojiContext(toned)} aria-label={`:${entry[0]}:`}>
                            <Emoji entry={toned} size={32} />
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>}
                {pickerCategories.map((section) => (
                  <div key={section.key} className="pickerSection" data-category={section.key}>
                    <SectionHeader label={section.label} collapsed={collapsed.has(section.label)} onToggle={() => toggle(section.label)} onContextMenu={sectionContext(section.label)} />
                    {!collapsed.has(section.label) && (
                      <div className="pickerGrid">
                        {section.emojis.map((entry) => {
                          const toned = applyTone(entry, tone)
                          return (
                            <button key={entry[0]} type="button" className="pickerItem" onMouseEnter={() => setHovered(toned)} onClick={(e) => onPickEmoji(toned[1], e.shiftKey)} onContextMenu={emojiContext(toned)} aria-label={`:${entry[0]}:`}>
                              <Emoji entry={toned} size={32} />
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
          <div className="pickerInspector">
            {/* Discord pre-selects the first emoji of the visible grid; the
                inspector always shows a glyph + :name:, never a placeholder.
                (The skin-tone selector lives only in the header - web.js
                renders tY once, beside the search bar.) */}
            {(() => {
              const current = hovered || applyTone(frequent[0] || pickerCategories[0].emojis[0], tone)
              return current ? (
                <>
                  <Emoji entry={current} size={32} className="inspectorEmoji" />
                  <span className="inspectorName">:{current[0]}:</span>
                </>
              ) : null
            })()}
          </div>
          </div>
          </div>
        </>
      ) : (
        <>
          <div className="pickerBody">
            {!canSendEmbeds ? (
              <div className="pickerEmpty pickerLocked">
                <HolyRich as="p">{tab === 'gifs' ? 'GIFs' : 'Stickers'} require moderator permission.</HolyRich>
              </div>
            ) : !klipyKey ? (
              <div className="pickerEmpty pickerLocked">
                <HolyRich as="p">{tab === 'gifs' ? 'GIFs' : 'Stickers'} are not configured yet.</HolyRich>
              </div>
            ) : tab === 'gifs' ? (
              <GifGrid results={gifs} loading={loadingMedia} onPick={(o) => { const f = klipyFull(o); if (f) onPickGif(f, o) }} onItemContext={mediaContext('gif')} />
            ) : (
              <GifGrid results={stickers} loading={loadingMedia} onPick={(o) => { const f = klipyFull(o); if (f) onPickSticker(f, o) }} onItemContext={mediaContext('sticker')} />
            )}
          </div>
          <div className="pickerInspector pickerAttribution">
            <HolyText as="span" className="inspectorName" ellipsis text="Powered by KLIPY" />
          </div>
        </>
      )}
      </div>
    </div>
  )
  // Anchored: portal into the chat popout layer (escapes the message
  // column's clipping); unanchored keeps the legacy in-place CSS position.
  return anchor != null ? createPortal(picker, popoutLayer()) : picker
}
