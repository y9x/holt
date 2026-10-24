/* Discord's forum channel view (ForumChannel, webpack module 559296), rebuilt
 * to the structure, class layout, strings and states in holt
 * docs/forum/discord-ui.md. CSS is forum.css (Discord's own rules from
 * docs/forum/discord-forum.css, hashed classes renamed to stable dcf* names).
 *
 *   ForumView         the whole forum: header card (search / New Post
 *                     composer), Post Guidelines, Sort & View + tag filter
 *                     row, list or gallery of posts, "Older Posts" (archived)
 *                     section, paging, empty / no-access states, the
 *                     "N New Posts" pill.
 *   ForumPostTagsRow  tags shown above an open post's replies (starter area).
 *   postMenuEntries   the thread context menu for a post (cards + header).
 *   PostActionModal   rename / edit tags / delete confirmation.
 *
 * Data: GET posts (sealed, lib/bridge fetchForumPosts), POST post, POST
 * post-moderate; live bridge.post.* events (contract.md "Realtime"). Every
 * static user-visible string is wrapped (HolyText / HolyRich / useHolyAttr,
 * see components/common/HOLYTEXT.md); post titles, author names, tag names and
 * formatted times are data values and render plain. */

import { createElement, Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type Ref } from 'react'
import {
  createForumPost,
  fetchForumPosts,
  isPendingPostId,
  moderatePost,
  type BridgeChannel,
  type BridgePerms,
  type BridgeRequestError,
  type ForumPost,
  type ForumSort,
  type ForumTag,
  type ForumTagMatch,
  type PostModerateAction,
} from '../../lib/bridge'
import { subscribeBridge } from '../../lib/rt'
import { useHolyAttr, type HolyAttrValues } from '../../lib/holy-attr'
import { HolyText } from '../../components/common/HolyText'
import { HolyDynamic, HolyRich } from '../../components/common/HolyRich'
import { Composer } from './Composer'
import { ContextMenu, type MenuEntry } from './ContextMenu'
import { Popout } from './popout'
import { allEmoji } from './emoji-data'
import { Emoji } from './Emoji'
import { BOOK_CHECK_ICON_PATH, CHAT_ICON_PATH } from './channelIcons'
import { escapeHtml, mapOutsideCode, renderMarkdown } from './markdown'
import { twemojify } from './twemoji'
import { normalizeEmpty, pastePlainText, serializeComposer } from './composerRich'
import './forum.css'

/* ------------------------------------------------------------------ icons */

// Sort & View (112173.J), chevrons (847374.a / 900797.t), TagIcon (278416),
// pinned marker (366605.t), PencilIcon (22231), Close (789645.P), magnifier
// (7689), CircleWarning for the no-permission hint. All verbatim, 24x24.
const SORT_ICON = 'M16.3 21.7a1 1 0 0 0 1.4 0l4-4a1 1 0 0 0-1.4-1.4L18 18.58V3a1 1 0 1 0-2 0v15.59l-2.3-2.3a1 1 0 0 0-1.4 1.42l4 4ZM6.3 2.3a1 1 0 0 1 1.4 0l4 4a1 1 0 0 1-1.4 1.4L8 5.42V21a1 1 0 1 1-2 0V5.41l-2.3 2.3a1 1 0 0 1-1.4-1.42l4-4Z'
const CHEVRON_DOWN = 'M5.3 9.3a1 1 0 0 1 1.4 0l5.3 5.29 5.3-5.3a1 1 0 1 1 1.4 1.42l-6 6a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.42Z'
const CHEVRON_UP = 'M5.3 14.7a1 1 0 0 0 1.4 0L12 9.42l5.3 5.3a1 1 0 0 0 1.4-1.42l-6-6a1 1 0 0 0-1.4 0l-6 6a1 1 0 0 0 0 1.42Z'
const TAG_ICON = 'M12.24 2a3 3 0 0 0-2.12.88l-8.25 8.25a3 3 0 0 0 0 4.24l6.76 6.76a3 3 0 0 0 4.24 0l8.25-8.25a3 3 0 0 0 .88-2.12V4a2 2 0 0 0-2-2h-7.76ZM17 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z'
const PIN_ICON = 'M19.38 11.38a3 3 0 0 0 4.24 0l.03-.03a.5.5 0 0 0 0-.7L13.35.35a.5.5 0 0 0-.7 0l-.03.03a3 3 0 0 0 0 4.24L13 5l-2.92 2.92-3.65-.34a2 2 0 0 0-1.6.58l-.62.63a1 1 0 0 0 0 1.42l9.58 9.58a1 1 0 0 0 1.42 0l.63-.63a2 2 0 0 0 .58-1.6l-.34-3.64L19 11l.38.38ZM9.07 17.07a.5.5 0 0 1-.08.77l-5.15 3.43a.5.5 0 0 1-.63-.06l-.42-.42a.5.5 0 0 1-.06-.63L6.16 15a.5.5 0 0 1 .77-.08l2.14 2.14Z'
const PENCIL_ICON = 'm13.96 5.46 4.58 4.58a1 1 0 0 0 1.42 0l1.38-1.38a2 2 0 0 0 0-2.82l-3.18-3.18a2 2 0 0 0-2.82 0l-1.38 1.38a1 1 0 0 0 0 1.42ZM2.11 20.16l.73-4.22a3 3 0 0 1 .83-1.61l7.87-7.87a1 1 0 0 1 1.42 0l4.58 4.58a1 1 0 0 1 0 1.42l-7.87 7.87a3 3 0 0 1-1.6.83l-4.23.73a1.5 1.5 0 0 1-1.73-1.73Z'
const CLOSE_ICON = 'M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z'
const SEARCH_ICON = 'M15.62 17.03a9 9 0 1 1 1.41-1.41l4.68 4.67a1 1 0 0 1-1.42 1.42l-4.67-4.68ZM17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z'
const WARN_ICON = 'M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22Zm1.44-15.94L13.06 14a1.06 1.06 0 0 1-2.12 0l-.38-6.94a1 1 0 0 1 1-1.06h.88a1 1 0 0 1 1 1.06Zm-.19 10.69a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z'

function Glyph({ d, size = 24, className, evenodd }: { d: string; size?: number; className?: string; evenodd?: boolean }) {
  return (
    <svg className={className} aria-hidden="true" role="img" width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path fill="currentColor" d={d} {...(evenodd ? { fillRule: 'evenodd' as const, clipRule: 'evenodd' as const } : {})} />
    </svg>
  )
}

/* ------------------------------------------------- obfuscated attributes */

type HolyTag = 'button' | 'div' | 'li' | 'span' | 'textarea' | 'section' | 'ul'

/** An element whose static aria-label / title / placeholder go through
 *  useHolyAttr (HOLYTEXT.md §4). Always mounted together with its hook, so
 *  the reveal layout effect sees the node. */
function Holy<T extends HolyTag>({ as, holy, elRef, ...rest }: { as: T; holy: HolyAttrValues; elRef?: Ref<HTMLElement> } & ComponentPropsWithoutRef<T>) {
  const attr = useHolyAttr(holy)
  const ref = useCallback((node: HTMLElement | null) => {
    attr.ref(node)
    if (typeof elRef === 'function') elRef(node)
    else if (elRef) (elRef as { current: HTMLElement | null }).current = node
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attr.ref, elRef])
  return createElement(as, { ...rest, ...attr.placeholder, ref })
}

/* --------------------------------------------------------- persistence */

export interface ForumViewPrefs {
  sort: ForumSort
  layout: 'list' | 'gallery'
  match: ForumTagMatch
}

const PREFS_KEY = 'abulxt:chat-forum-view'
const SEEN_KEY = 'abulxt:chat-forum-seen'
const VISIT_KEY = 'abulxt:chat-forum-visit'

function readMap<T>(key: string): Record<string, T> {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '{}') as unknown
    return raw && typeof raw === 'object' ? (raw as Record<string, T>) : {}
  } catch { return {} }
}
function writeMap(key: string, value: Record<string, unknown>): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* private mode / quota */ }
}

/** The forum's own defaults (Discord's "Reset to default"). Media channels
 *  are always a grid. */
export function forumDefaults(forum: BridgeChannel): ForumViewPrefs {
  const f = forum.forum
  return {
    sort: f?.defaultSortOrder === 1 ? 'created' : 'activity',
    layout: f?.media || f?.defaultLayout === 2 ? 'gallery' : 'list',
    match: 'some',
  }
}

function loadPrefs(forum: BridgeChannel): ForumViewPrefs {
  const saved = readMap<Partial<ForumViewPrefs>>(PREFS_KEY)[forum.channelId] || {}
  const d = forumDefaults(forum)
  return {
    sort: saved.sort === 'created' || saved.sort === 'activity' ? saved.sort : d.sort,
    layout: forum.forum?.media ? 'gallery' : saved.layout === 'gallery' || saved.layout === 'list' ? saved.layout : d.layout,
    match: saved.match === 'all' || saved.match === 'some' ? saved.match : d.match,
  }
}

function savePrefs(forumId: string, prefs: ForumViewPrefs | null): void {
  const all = readMap<ForumViewPrefs>(PREFS_KEY)
  if (prefs) all[forumId] = prefs
  else delete all[forumId]
  writeMap(PREFS_KEY, all)
}

/** Replies seen per post (the "(N New)" count = messageCount - seen). Called
 *  by chat.tsx while a post is open. */
export function markPostSeen(postId: string, messageCount: number): void {
  const all = readMap<number>(SEEN_KEY)
  if (all[postId] === messageCount) return
  all[postId] = messageCount
  writeMap(SEEN_KEY, all)
}

/** Move a pending post's seen count to its delivered thread id. */
export function rekeyPostSeen(pendingId: string, postId: string): void {
  const all = readMap<number>(SEEN_KEY)
  if (all[pendingId] === undefined) return
  all[postId] = all[pendingId]
  delete all[pendingId]
  writeMap(SEEN_KEY, all)
}

// Tag filter per forum for the session (Discord keeps it per channel while
// the app is open).
const tagFilters = new Map<string, string[]>()

/* ------------------------------------------------------------- helpers */

function relativeTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return `${s || 1}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.round(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.round(mo / 12)}y ago`
}

function fullTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** Inline markdown of a post's first message (one line on a list card, a
 *  block on a gallery card). renderMarkdown escapes every text node and
 *  attribute (the message pipeline); twemojify only rewrites text runs. */
function previewHtml(content: string, inline: boolean): string {
  const source = inline ? content.replace(/\s*\n+\s*/g, ' ') : content
  return mapOutsideCode(renderMarkdown(source), twemojify)
}

function TagEmoji({ emoji, small }: { emoji: ForumTag['emoji']; small?: boolean }) {
  if (!emoji) return null
  const cls = `dcfPill-emoji${small ? ' dcfPill-small' : ''}`
  if (emoji.id) {
    // Custom guild emoji: Discord's CDN, alt is the emoji name (data value).
    return <img className={cls} src={`https://cdn.discordapp.com/emojis/${encodeURIComponent(emoji.id)}.webp?size=32`} alt={emoji.name || ''} draggable={false} />
  }
  if (!emoji.name) return null
  const entry = allEmoji.find((e) => e[1] === emoji.name)
  if (entry) return <Emoji entry={entry} size={small ? 12 : 14} className={cls} />
  // Unknown unicode: twemoji over the escaped glyph.
  return <span className={cls} dangerouslySetInnerHTML={{ __html: twemojify(escapeHtml(emoji.name)) }} />
}

function ReactionGlyph({ emoji }: { emoji: string }) {
  const custom = /^<?a?:([^:>]+):(\d+)>?$/.exec(emoji)
  if (custom) return <img className="emoji" src={`https://cdn.discordapp.com/emojis/${custom[2]}.webp?size=32`} alt={custom[1]} width={16} height={16} draggable={false} />
  const entry = allEmoji.find((e) => e[1] === emoji) || allEmoji.find((e) => e[0] === emoji)
  if (entry) return <Emoji entry={entry} size={16} />
  return <span className="emoji-text">{emoji}</span>
}

/** Discord positions a tag row's overflow button in JS: right after the
 *  last pill that fits the (single, overflow-hidden) first row. */
function useOverflowButtonLeft(listRef: { current: HTMLElement | null }, deps: unknown[]): number | null {
  const [left, setLeft] = useState<number | null>(null)
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) { setLeft(null); return }
    const pills = Array.from(list.querySelectorAll<HTMLElement>('.dcfPill-pill'))
    if (!pills.length) { setLeft(null); return }
    const top = pills[0].offsetTop
    const firstRow = pills.filter((p) => p.offsetTop === top)
    const last = firstRow[firstRow.length - 1]
    setLeft(last.offsetLeft + last.offsetWidth)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return left
}

/* ------------------------------------------------------------ tag pill */

function TagPill({ tag, small, selected, disabled, filtered, className = '', onClick, holyLabel }: {
  tag: ForumTag
  small?: boolean
  selected?: boolean
  disabled?: boolean
  filtered?: boolean
  className?: string
  onClick?: () => void
  /** Static aria-label template (e.g. "Add tag, {tagName}"). */
  holyLabel?: string
}) {
  const cls = `dcfPill-pill${small ? ' dcfPill-small' : ''}${onClick ? ' dcfPill-clickable' : ''}${selected ? ' dcfPill-selected' : ''}${disabled ? ' dcfPill-disabled' : ''}${filtered ? ' dcfTags-tagFiltered' : ''} ${className}`
  const body = (
    <>
      <TagEmoji emoji={tag.emoji} small={small} />
      {/* Tag name: a data value. */}
      <span className={small ? 'dcfT-txs-medium' : 'dcfT-tsm-medium'}>{tag.name}</span>
    </>
  )
  if (!onClick) return <div className={cls}>{body}</div>
  return (
    <Holy
      as="div"
      holy={holyLabel ? { 'aria-label': holyLabel.replace('{tagName}', tag.name) } : {}}
      className={cls}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-pressed={Boolean(selected)}
      aria-disabled={disabled || undefined}
      onClick={() => { if (!disabled) onClick() }}
      onKeyDown={(e: KeyboardEvent) => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick() } }}
    >
      {body}
    </Holy>
  )
}

/** "NEW" text badge (Discord's TextBadge, brand). */
function NewBadge({ className = '' }: { className?: string }) {
  return <HolyText as="div" className={`dcfNewBadge ${className}`} text="NEW" />
}

/* ------------------------------------------------- tags row on a post */

function PinnedMarker() {
  return (
    <Holy as="div" holy={{ 'aria-label': 'Pinned', title: 'Pinned' }} className="dcfTags-pinIcon" role="img">
      <Glyph d={PIN_ICON} size={16} className="dcfPinGlyph" />
    </Holy>
  )
}

function PostTagsRow({ post, tags, isNew, filter, pillClass }: { post: ForumPost; tags: Map<string, ForumTag>; isNew: boolean; filter: string[]; pillClass?: string }) {
  const applied = post.appliedTags.map((id) => tags.get(id)).filter((t): t is ForumTag => Boolean(t))
  const shown = applied.slice(0, 3)
  const more = applied.slice(3)
  const moreAttr = useHolyAttr({ title: more.map((t) => t.name).join(', ') })
  if (!isNew && !post.pinned && !applied.length) return null
  return (
    <div className="dcfTags-tags">
      {isNew && <NewBadge className="dcfTags-newBadge" />}
      {post.pinned && <PinnedMarker />}
      {shown.map((tag) => <TagPill key={tag.id} tag={tag} small filtered={filter.includes(tag.id)} className={pillClass} />)}
      {more.length > 0 && (
        // "+N": the remaining tag names (data values) in the tooltip.
        <div ref={moreAttr.ref} {...moreAttr.placeholder} className={`dcfPill-pill dcfPill-small ${pillClass || ''}`}>
          <span className="dcfT-txs-medium">+{more.length}</span>
        </div>
      )}
    </div>
  )
}

/** The tags row under an open post's starter message (Discord's
 *  nonMessageContent → tagsRow, module 950490). */
export function ForumPostTagsRow({ post, forum }: { post: ForumPost; forum: BridgeChannel | null }) {
  const tags = useMemo(() => new Map((forum?.forum?.availableTags || []).map((t) => [t.id, t])), [forum])
  const applied = post.appliedTags.map((id) => tags.get(id)).filter((t): t is ForumTag => Boolean(t))
  return (
    <div className="dcfStarter-nonMessageContent">
      {(applied.length > 0 || post.pinned) && (
        <div className="dcfStarter-tagsRow">
          {post.pinned && <PinnedMarker />}
          {applied.map((tag) => <TagPill key={tag.id} tag={tag} />)}
        </div>
      )}
      <div className="dcfStarter-divider dcfStarter-dividerThin" />
    </div>
  )
}

/* -------------------------------------------------------- post menus */

export interface PostMenuContext {
  canManage: boolean
  isOwner: boolean
  developerMode: boolean
  onAction: (action: PostModerateAction) => void
  onEdit: (kind: 'rename' | 'tags' | 'delete') => void
  onCopyLink?: () => void
  onCopyId: () => void
  onMarkRead?: () => void
  onOpen?: () => void
}

/** Discord's thread context menu for a forum post (cards and the open post's
 *  header). Owner: Edit Post title / Edit Tags / Close / Delete; staff also
 *  Pin and Lock. Pending posts (not on Discord yet) get no actions. */
export function postMenuEntries(post: ForumPost, ctx: PostMenuContext): MenuEntry[] {
  const entries: MenuEntry[] = []
  if (ctx.onOpen) entries.push({ key: 'open', label: 'Open Post', onSelect: ctx.onOpen })
  if (ctx.onMarkRead) entries.push({ key: 'read', label: 'Mark As Read', onSelect: ctx.onMarkRead })
  const pending = isPendingPostId(post.id) || post.pending
  const own = ctx.canManage || ctx.isOwner
  if (!pending && own) {
    if (entries.length) entries.push('separator')
    entries.push({ key: 'rename', label: 'Edit Post', onSelect: () => ctx.onEdit('rename') })
    entries.push({ key: 'tags', label: 'Edit Tags', onSelect: () => ctx.onEdit('tags') })
    if (ctx.canManage) entries.push({ key: 'pin', label: post.pinned ? 'Unpin Post' : 'Pin Post', onSelect: () => ctx.onAction(post.pinned ? 'unpin' : 'pin') })
    entries.push({ key: 'archive', label: post.archived ? 'Open Post' : 'Close Post', onSelect: () => ctx.onAction(post.archived ? 'unarchive' : 'archive') })
    if (ctx.canManage) entries.push({ key: 'lock', label: post.locked ? 'Unlock Post' : 'Lock Post', onSelect: () => ctx.onAction(post.locked ? 'unlock' : 'lock') })
    entries.push({ key: 'delete', label: 'Delete Post', danger: true, onSelect: () => ctx.onEdit('delete') })
  }
  if (!pending && (ctx.onCopyLink || ctx.developerMode)) {
    entries.push('separator')
    if (ctx.onCopyLink) entries.push({ key: 'copy-link', label: 'Copy Link', onSelect: ctx.onCopyLink })
    if (ctx.developerMode) entries.push({ key: 'copy-id', label: 'Copy Thread ID', onSelect: ctx.onCopyId })
  }
  return entries
}

/** Rename / Edit Tags / Delete confirmation, on the chatbox's modal shell
 *  (deleteConfirm* in chat.css). Resolves through post-moderate. */
export function PostActionModal({ kind, post, forum, onClose, onDone }: {
  kind: 'rename' | 'tags' | 'delete'
  post: ForumPost
  forum: BridgeChannel | null
  onClose: () => void
  onDone?: (result: { post?: ForumPost; deleted?: boolean }) => void
}) {
  const [name, setName] = useState(post.name)
  const [applied, setApplied] = useState<string[]>(post.appliedTags)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const available = forum?.forum?.availableTags || []
  const dialogLabel = kind === 'rename' ? 'Edit Post' : kind === 'tags' ? 'Edit Tags' : 'Delete Post'
  const submit = async () => {
    if (busy) return
    const trimmed = name.trim()
    if (kind === 'rename' && !trimmed) { setError('A title is required'); return }
    if (kind === 'tags' && forum?.forum?.requireTag && applied.length === 0) { setError('A tag is required to create a post in this channel'); return }
    setBusy(true)
    setError(null)
    try {
      const result = kind === 'rename'
        ? await moderatePost(post.id, 'rename', { name: trimmed })
        : kind === 'tags'
          ? await moderatePost(post.id, 'tags', { appliedTags: applied })
          : await moderatePost(post.id, 'delete')
      onDone?.(result)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
      setBusy(false)
    }
  }
  return (
    <div className="deleteConfirmBackdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <Holy
        as="div"
        holy={{ 'aria-label': dialogLabel }}
        className="deleteConfirm dcfPostModal"
        role="dialog"
        aria-modal="true"
        onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose() } }}
      >
        <div className="deleteConfirmHeader">
          <HolyText as="h2" className="deleteConfirmTitle" text={dialogLabel} />
          {kind === 'delete' && (
            <HolyRich as="div" className="deleteConfirmSub">
              Are you sure you want to delete <strong>{post.name}</strong>? This cannot be undone.
            </HolyRich>
          )}
        </div>
        {kind === 'rename' && (
          <div className="dcfPostModalBody">
            <label className="modFieldLabel" htmlFor="dcf-rename"><HolyText text="Post Title" /></label>
            <input id="dcf-rename" className="dcfPostModalInput" value={name} maxLength={100} disabled={busy} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit() }} />
          </div>
        )}
        {kind === 'tags' && (
          <div className="dcfPostModalBody">
            <div className="dcfTagPop-tagContainer">
              {available.map((tag) => {
                const selected = applied.includes(tag.id)
                return (
                  <TagPill
                    key={tag.id}
                    tag={tag}
                    selected={selected}
                    disabled={!selected && applied.length >= 5}
                    holyLabel="Add tag, {tagName}"
                    onClick={() => setApplied((cur) => (cur.includes(tag.id) ? cur.filter((id) => id !== tag.id) : [...cur, tag.id].slice(0, 5)))}
                  />
                )
              })}
            </div>
          </div>
        )}
        {error && <HolyText as="div" className="modModalError dcfPostModalError" role="alert" text={error} />}
        <div className="deleteConfirmFooter">
          <button type="button" className="deleteConfirmCancel" disabled={busy} onClick={onClose}><HolyText text="Cancel" /></button>
          <button type="button" className={kind === 'delete' ? 'deleteConfirmDelete' : 'deleteConfirmDelete dcfPostModalSave'} disabled={busy} onClick={() => void submit()}>
            <HolyText text={kind === 'delete' ? 'Delete' : 'Save'} />
          </button>
        </div>
      </Holy>
    </div>
  )
}

/* -------------------------------------------------------- post cards */

interface CardState {
  isNew: boolean
  unread: boolean
  newCount: number
  typing: string[]
}

function CardFooterReaction({ post, defaultEmoji }: { post: ForumPost; defaultEmoji: ForumTag['emoji'] }) {
  const top = [...post.starter.reactions].sort((a, b) => b.count - a.count)[0]
  if (top) {
    return (
      <div className="reaction reactionInner dcfCard-updateReactionButton dcfCardReaction">
        <ReactionGlyph emoji={top.emoji} />
        <span className="reactionCount">{top.count}</span>
      </div>
    )
  }
  if (!defaultEmoji) return null
  // The forum's default reaction, count hidden (read-only here: reacting
  // happens on the open post's starter message).
  return (
    <div className="reaction reactionInner dcfCard-updateReactionButton dcfCardReaction">
      {defaultEmoji.id
        ? <img className="emoji" src={`https://cdn.discordapp.com/emojis/${encodeURIComponent(defaultEmoji.id)}.webp?size=32`} alt={defaultEmoji.name || ''} width={16} height={16} draggable={false} />
        : <ReactionGlyph emoji={defaultEmoji.name || ''} />}
    </div>
  )
}

function MessageCount({ post, state, grid }: { post: ForumPost; state: CardState; grid?: boolean }) {
  return (
    <div className={`${grid ? 'dcfGrid-messageCountContainer ' : ''}dcfCard-messageCountBox${state.unread ? '' : ' dcfCard-hasRead'}`}>
      <div className="dcfCard-messageCountIcon"><Glyph d={CHAT_ICON_PATH} size={14} /></div>
      <div className="dcfCard-messageCountText">
        {/* Counts are data values. */}
        <span>{post.messageCount}</span>
        {state.newCount > 0 && (
          <HolyRich as="span" className="dcfCard-newMessageCount dcfC-brand">(<HolyDynamic>{String(state.newCount)}</HolyDynamic> New)</HolyRich>
        )}
      </div>
    </div>
  )
}

function TypingOrTime({ post, state, sort, grid }: { post: ForumPost; state: CardState; sort: ForumSort; grid?: boolean }) {
  const iso = sort === 'created' ? post.createdAt : post.lastActivityAt
  const tip = useHolyAttr({ title: `Posted ${fullTimestamp(post.createdAt)}` })
  if (state.typing.length) {
    return (
      <div className={grid ? 'dcfGrid-typing' : 'dcfCard-typing'}>
        <div className={grid ? 'dcfGrid-dots' : 'dcfCard-dots'} aria-hidden="true">
          <span className="chat-typingDot" /><span className="chat-typingDot" /><span className="chat-typingDot" />
        </div>
        {/* Typing names are data values. */}
        <span className={`${grid ? 'dcfGrid-typingUsers' : 'dcfCard-typingUsers'} dcfT-tsm-normal dcfC-muted`}>{state.typing.slice(0, 3).join(', ')}</span>
      </div>
    )
  }
  // Relative time: a formatted data value.
  return <span ref={tip.ref} {...tip.placeholder} className="dcfT-tsm-normal dcfC-muted">{relativeTime(iso)}</span>
}

/** A post title with forum-search hits wrapped (Discord's <span
 *  class="highlight">). React text nodes only - no HTML. */
function HighlightedTitle({ title, query }: { title: string; query: string }) {
  const q = query.trim().toLowerCase()
  if (!q) return <>{title}</>
  const parts: Array<{ text: string; hit: boolean }> = []
  const lower = title.toLowerCase()
  let at = 0
  for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, at)) {
    if (i > at) parts.push({ text: title.slice(at, i), hit: false })
    parts.push({ text: title.slice(i, i + q.length), hit: true })
    at = i + q.length
  }
  if (at < title.length) parts.push({ text: title.slice(at), hit: false })
  return <>{parts.map((p, i) => (p.hit ? <span key={i} className="highlight dcfHighlight">{p.text}</span> : <Fragment key={i}>{p.text}</Fragment>))}</>
}

function cardLabel(post: ForumPost): string {
  return `Post ${post.name}, ${post.messageCount} message${post.messageCount === 1 ? '' : 's'}`
}

function ListCard({ post, state, tags, filter, sort, defaultEmoji, isOpen, query, onOpen, onContextMenu }: {
  post: ForumPost
  query: string
  state: CardState
  tags: Map<string, ForumTag>
  filter: string[]
  sort: ForumSort
  defaultEmoji: ForumTag['emoji']
  isOpen: boolean
  onOpen: () => void
  onContextMenu: (e: ReactMouseEvent) => void
}) {
  const preview = useMemo(() => (post.starter.content ? previewHtml(post.starter.content, true) : ''), [post.starter.content])
  const deleted = post.starter.messageId === null && !post.starter.content && !post.pending
  return (
    <Holy
      as="div"
      holy={{ 'aria-label': cardLabel(post) }}
      className={`dcfCard-container dcfPage-mainCard${isOpen ? ' dcfCard-isOpen' : ''}`}
      data-item-id={post.id}
      role="listitem"
      tabIndex={0}
      onClick={onOpen}
      onContextMenu={onContextMenu}
      onKeyDown={(e: KeyboardEvent) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); onOpen() } }}
    >
      <div className="dcfCard-left">
        <div className="dcfCard-body">
          <PostTagsRow post={post} tags={tags} isNew={false} filter={filter} />
          <div className="dcfCard-header">
            <div className="dcfCard-headerText">
              <h3 className={`dcfCard-postTitleText dcfT-hlg-semibold ${state.unread || state.isNew ? 'dcfC-strong' : 'dcfC-muted'}`}>
                {/* Post title: a data value. */}
                <HighlightedTitle title={post.name} query={query} />
                {state.isNew && <span className="dcfCard-newBadgeWrapper"><NewBadge className="dcfCard-newBadge" /></span>}
              </h3>
            </div>
          </div>
          <div className="dcfCard-message">
            <span className={`dcfAuthor-author${state.unread ? ' dcfAuthor-hasUnreads' : ''}`}>
              {/* Author name: a data value. */}
              <a className="dcfT-tsm-semibold">{post.ownerName}</a>
              <span className="dcfT-tsm-semibold dcfC-muted">:</span>
            </span>
            {deleted
              ? <HolyText as="span" className="dcfCard-messageContent dcfCard-blockedMessage dcfC-muted" text="Original message was deleted" />
              : <span className={`dcfCard-messageContent ${state.unread ? 'dcfC-default' : 'dcfC-muted'}`} dangerouslySetInnerHTML={{ __html: preview }} />}
          </div>
        </div>
        <div className="dcfCard-footer">
          <CardFooterReaction post={post} defaultEmoji={defaultEmoji} />
          <MessageCount post={post} state={state} />
          <span className="dcfCard-bullet">•</span>
          <TypingOrTime post={post} state={state} sort={sort} />
        </div>
      </div>
      {post.starter.image && (
        <div className="dcfCard-bodyMedia">
          <div className="dcfCard-thumbnailContainer">
            <img className="dcfCard-thumbnailOverride" src={post.starter.image} alt="" loading="lazy" draggable={false} />
          </div>
        </div>
      )}
    </Holy>
  )
}

function GalleryCard({ post, state, tags, filter, defaultEmoji, isOpen, media, query, onOpen, onContextMenu }: {
  post: ForumPost
  query: string
  state: CardState
  tags: Map<string, ForumTag>
  filter: string[]
  defaultEmoji: ForumTag['emoji']
  isOpen: boolean
  media: boolean
  onOpen: () => void
  onContextMenu: (e: ReactMouseEvent) => void
}) {
  const preview = useMemo(() => (post.starter.content ? previewHtml(post.starter.content, false) : ''), [post.starter.content])
  const hasTags = post.appliedTags.length > 0 || post.pinned
  return (
    <Holy
      as="li"
      holy={{ 'aria-label': cardLabel(post) }}
      className={`dcfGrid-container dcfPage-card dcfPage-mainCard${isOpen ? ' dcfGrid-isOpen' : ''}`}
      data-item-id={post.id}
      tabIndex={0}
      onClick={onOpen}
      onContextMenu={onContextMenu}
      onKeyDown={(e: KeyboardEvent) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); onOpen() } }}
    >
      <div className="dcfGrid-header">
        <div className="dcfGrid-authorRow">
          <div className="dcfGrid-rowGroup">
            {/* Author name and creation time: data values. */}
            <span className="dcfT-tsm-medium dcfC-default dcfGridAuthor">{post.ownerName}</span>
            <span className="dcfGrid-postCreationTimestamp dcfT-txs-normal dcfC-muted">{relativeTime(post.createdAt)}</span>
          </div>
          {state.isNew && <NewBadge className="dcfGrid-newBadge" />}
        </div>
        <h3 className={`dcfGrid-title dcfT-hmd-extrabold ${state.unread || state.isNew ? 'dcfC-strong' : 'dcfC-muted'}`}><HighlightedTitle title={post.name} query={query} /></h3>
      </div>
      <div className="dcfGrid-postBody">
        {post.starter.image ? (
          <div className={`dcfGrid-bodyMedia${media ? ' dcfGridMedia169' : ''}`}>
            <div className="dcfGrid-bodyMediaFrame dcfGridFrameFill">
              <img className="dcfGrid-imageCover dcfGridImg" src={post.starter.image} alt="" loading="lazy" draggable={false} />
            </div>
            {hasTags && (
              <div className="dcfGrid-tagsRow">
                <PostTagsRow post={post} tags={tags} isNew={false} filter={filter} pillClass="dcfGrid-tagPill" />
              </div>
            )}
          </div>
        ) : (
          <div className="dcfGrid-contentPreview dcfGridTextBody">
            <div
              className={`dcfGrid-content dcfT-tsm-normal ${state.unread ? 'dcfGrid-textContentUnread' : 'dcfGrid-textContentRead'}`}
              dangerouslySetInnerHTML={{ __html: preview }}
            />
            <div className={`dcfGrid-textContentFooter${hasTags ? '' : ' dcfGrid-noTags'}`}>
              {hasTags && <PostTagsRow post={post} tags={tags} isNew={false} filter={filter} />}
            </div>
          </div>
        )}
      </div>
      <div className="dcfGrid-footer">
        <div className="dcfGrid-forumPostControls">
          <div className="dcfGrid-controlsGroup">
            <MessageCount post={post} state={state} grid />
            {state.typing.length > 0 && <TypingOrTime post={post} state={state} sort="activity" grid />}
          </div>
          <div className="dcfGrid-controlsGroup">
            <CardFooterReaction post={post} defaultEmoji={defaultEmoji} />
          </div>
        </div>
      </div>
    </Holy>
  )
}

/* ------------------------------------------------------- the forum view */

export interface ForumViewProps {
  forum: BridgeChannel
  perms: BridgePerms | null
  signedIn: boolean
  /** Every webhook key the caller appears under (own posts never count as new). */
  selfKeys: string[]
  /** Read marker per channel/post id (chat.tsx lastRead). */
  lastRead: Record<string, number>
  developerMode: boolean
  openPostId: string | null
  onRequireSignIn: () => void
  onOpenPost: (post: ForumPost) => void
  onError: (message: string) => void
  onCopy: (text: string) => void
  postLink?: (post: ForumPost) => string
  onMarkPostRead?: (post: ForumPost) => void
}

const PAGE_SIZE = 25
const TITLE_MAX = 100
const BODY_MAX = 4000
const TAG_LIMIT = 5

function sortPosts(posts: ForumPost[], sort: ForumSort): ForumPost[] {
  const key = (p: ForumPost) => new Date(sort === 'created' ? p.createdAt : p.lastActivityAt).getTime() || 0
  return [...posts].sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || key(b) - key(a))
}

function matchesFilter(post: ForumPost, tags: string[], match: ForumTagMatch): boolean {
  if (!tags.length) return true
  return match === 'all' ? tags.every((t) => post.appliedTags.includes(t)) : tags.some((t) => post.appliedTags.includes(t))
}

/** Gallery columns: Discord's minWidth 320 / maxWidth 450 / gap 16 rule. */
function galleryColumns(width: number): number {
  if (width <= 320) return 1
  return Math.max(Math.floor(width / 450 + (width / 320 - width / 450) / 2), 1)
}

export function ForumView(props: ForumViewProps) {
  const { forum, perms, signedIn, selfKeys, lastRead, developerMode, openPostId, onRequireSignIn, onOpenPost, onError, onCopy, postLink, onMarkPostRead } = props
  const forumId = forum.channelId
  const settings = forum.forum
  const availableTags = settings?.availableTags || []
  const tagMap = useMemo(() => new Map(availableTags.map((t) => [t.id, t])), [availableTags])
  const media = Boolean(settings?.media)
  const guidelines = (settings?.guidelines || forum.topic || '').trim()

  // --- Sort & View (persisted per forum) + tag filter (session) ---
  const [prefs, setPrefsState] = useState<ForumViewPrefs>(() => loadPrefs(forum))
  const [tagFilter, setTagFilterState] = useState<string[]>(() => tagFilters.get(forumId) || [])
  useEffect(() => {
    setPrefsState(loadPrefs(forum))
    setTagFilterState(tagFilters.get(forumId) || [])
    // Re-read only when the forum changes (not on every channel-list refresh).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forumId])
  const setPrefs = useCallback((next: ForumViewPrefs | null) => {
    const value = next || forumDefaults(forum)
    setPrefsState(value)
    savePrefs(forumId, next)
  }, [forum, forumId])
  const setTagFilter = useCallback((next: string[]) => {
    tagFilters.set(forumId, next)
    setTagFilterState(next)
  }, [forumId])

  // --- NEW badges: posts created since the previous visit to this forum ---
  const visitSince = useRef<{ forumId: string; since: number | null }>({ forumId: '', since: null })
  if (visitSince.current.forumId !== forumId) {
    const visits = readMap<number>(VISIT_KEY)
    visitSince.current = { forumId, since: typeof visits[forumId] === 'number' ? visits[forumId] : null }
    visits[forumId] = Date.now()
    writeMap(VISIT_KEY, visits)
  }
  const [seen, setSeen] = useState<Record<string, number>>(() => readMap<number>(SEEN_KEY))
  useEffect(() => { setSeen(readMap<number>(SEEN_KEY)) }, [forumId, openPostId])

  // --- Search (header title field) ---
  const [title, setTitle] = useState('')
  const [search, setSearch] = useState('')
  const [titleFocused, setTitleFocused] = useState(false)

  // --- Posts ---
  const [posts, setPosts] = useState<ForumPost[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [denied, setDenied] = useState(false)
  const [arrivals, setArrivals] = useState<ForumPost[]>([])
  const queryKey = `${forumId}|${prefs.sort}|${prefs.match}|${tagFilter.join(',')}|${search}`
  const queryKeyRef = useRef(queryKey)
  queryKeyRef.current = queryKey
  useEffect(() => {
    const key = queryKey
    setLoading(true)
    setDenied(false)
    setArrivals([])
    fetchForumPosts(forumId, { sort: prefs.sort, tags: tagFilter, match: prefs.match, q: search, limit: PAGE_SIZE })
      .then((page) => {
        if (queryKeyRef.current !== key) return
        setPosts(page.posts)
        setCursor(page.nextCursor)
        setTotal(page.total)
      })
      .catch((err: BridgeRequestError) => {
        if (queryKeyRef.current !== key) return
        setPosts([])
        setCursor(null)
        setTotal(0)
        if (err.status === 403 || err.code === 50001 || err.code === 50013) setDenied(true)
        else onError(err.message || 'Failed to load posts')
      })
      .finally(() => { if (queryKeyRef.current === key) setLoading(false) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey])

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore || loading) return
    const key = queryKeyRef.current
    setLoadingMore(true)
    fetchForumPosts(forumId, { sort: prefs.sort, tags: tagFilter, match: prefs.match, q: search, before: cursor, limit: PAGE_SIZE })
      .then((page) => {
        if (queryKeyRef.current !== key) return
        setPosts((cur) => {
          const ids = new Set(cur.map((p) => p.id))
          return [...cur, ...page.posts.filter((p) => !ids.has(p.id))]
        })
        setCursor(page.nextCursor)
        setTotal(page.total)
      })
      .catch((err: Error) => { if (queryKeyRef.current === key) onError(err.message || 'Failed to load posts') })
      .finally(() => { if (queryKeyRef.current === key) setLoadingMore(false) })
  }, [cursor, loadingMore, loading, forumId, prefs.sort, prefs.match, tagFilter, search, onError])

  // --- Live updates (contract.md Realtime) ---
  const [typing, setTyping] = useState<Record<string, Array<{ key: string; name: string; expires: number }>>>({})
  const liveRef = useRef({ forumId, tagFilter, match: prefs.match, search, selfKeys })
  liveRef.current = { forumId, tagFilter, match: prefs.match, search, selfKeys }
  useEffect(() => subscribeBridge((event) => {
    const p = event.payload as Record<string, unknown>
    const live = liveRef.current
    if (event.type.startsWith('bridge.post.')) {
      if (String(p.channelId || '') !== live.forumId) return
      const post = p.post as ForumPost | undefined
      if (event.type === 'bridge.post.created' && post) {
        if (!matchesFilter(post, live.tagFilter, live.match) || live.search) return
        // Own posts land at once; others wait behind the "N New Posts" pill.
        if (live.selfKeys.includes(post.ownerKey)) {
          setPosts((cur) => (cur.some((x) => x.id === post.id) ? cur : [post, ...cur]))
          setTotal((t) => t + 1)
        } else {
          setArrivals((cur) => (cur.some((x) => x.id === post.id) ? cur : [...cur, post]))
        }
      } else if (event.type === 'bridge.post.updated' && post) {
        setPosts((cur) => cur.map((x) => (x.id === post.id ? post : x)))
        setArrivals((cur) => cur.map((x) => (x.id === post.id ? post : x)))
      } else if (event.type === 'bridge.post.deleted') {
        const id = String(p.postId || '')
        setPosts((cur) => cur.filter((x) => x.id !== id))
        setArrivals((cur) => cur.filter((x) => x.id !== id))
      } else if (event.type === 'bridge.post.delivered' && post) {
        const pendingId = String(p.pendingId || '')
        rekeyPostSeen(pendingId, post.id)
        setPosts((cur) => cur.map((x) => (x.id === pendingId ? post : x)))
        setArrivals((cur) => cur.map((x) => (x.id === pendingId ? post : x)))
      }
      return
    }
    if (event.type === 'bridge.typing' && String(p.forumId || '') === live.forumId) {
      const postId = String(p.channelId || '')
      const key = String(p.authorKey || '')
      if (!postId || !key || live.selfKeys.includes(key)) return
      const name = String(p.authorName || '')
      setTyping((cur) => ({ ...cur, [postId]: [...(cur[postId] || []).filter((t) => t.key !== key), { key, name, expires: Date.now() + 9000 }] }))
      return
    }
    if (event.type === 'bridge.message' && String(p.forumId || '') === live.forumId) {
      const message = p.message as { channelId?: string; authorKey?: string } | undefined
      if (!message?.channelId) return
      setTyping((cur) => (cur[message.channelId!] ? { ...cur, [message.channelId!]: cur[message.channelId!].filter((t) => t.key !== message.authorKey) } : cur))
    }
  }), [])
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      setTyping((cur) => {
        let changed = false
        const next: typeof cur = {}
        for (const [k, list] of Object.entries(cur)) {
          const kept = list.filter((t) => t.expires > now)
          if (kept.length !== list.length) changed = true
          if (kept.length) next[k] = kept
        }
        return changed ? next : cur
      })
    }, 2000)
    return () => clearInterval(timer)
  }, [])

  const showArrivals = useCallback(() => {
    setPosts((cur) => {
      const ids = new Set(cur.map((p) => p.id))
      return sortPosts([...arrivals.filter((p) => !ids.has(p.id)), ...cur], prefs.sort)
    })
    setTotal((t) => t + arrivals.length)
    setArrivals([])
    scrollerRef.current?.scrollTo({ top: 0 })
  }, [arrivals, prefs.sort])

  // --- Card state ---
  const cardState = useCallback((post: ForumPost): CardState => {
    const seenCount = seen[post.id]
    const own = selfKeys.includes(post.ownerKey)
    const since = visitSince.current.since
    const created = new Date(post.createdAt).getTime()
    const isNew = seenCount === undefined && !own && since !== null && created > since
    const read = lastRead[post.id] || 0
    const unread = isNew || (seenCount !== undefined && (post.lastMessageId || 0) > read)
    const newCount = seenCount !== undefined && unread ? Math.max(0, post.messageCount - seenCount) : 0
    const typingNames = (typing[post.id] || []).map((t) => t.name)
    return { isNew, unread, newCount, typing: typingNames }
  }, [seen, selfKeys, lastRead, typing])

  // --- Post context menu + actions ---
  const [menu, setMenu] = useState<{ post: ForumPost; x: number; y: number } | null>(null)
  const [modal, setModal] = useState<{ kind: 'rename' | 'tags' | 'delete'; post: ForumPost } | null>(null)
  const runAction = useCallback((post: ForumPost, action: PostModerateAction) => {
    moderatePost(post.id, action)
      .then((res) => { if (res.post) setPosts((cur) => cur.map((x) => (x.id === res.post!.id ? res.post! : x))) })
      .catch((err: Error) => onError(err.message || 'Something went wrong.'))
  }, [onError])
  const menuEntries = menu ? postMenuEntries(menu.post, {
    canManage: Boolean(perms?.canManagePosts),
    isOwner: selfKeys.includes(menu.post.ownerKey),
    developerMode,
    onOpen: () => onOpenPost(menu.post),
    onMarkRead: onMarkPostRead ? () => { onMarkPostRead(menu.post); markPostSeen(menu.post.id, menu.post.messageCount); setSeen(readMap<number>(SEEN_KEY)) } : undefined,
    onAction: (action) => runAction(menu.post, action),
    onEdit: (kind) => setModal({ kind, post: menu.post }),
    onCopyLink: postLink ? () => onCopy(postLink(menu.post)) : undefined,
    onCopyId: () => onCopy(menu.post.id),
  }) : []

  // --- New Post composer ---
  const canCreatePost = signedIn ? Boolean(perms?.canCreatePost) : true
  const [formOpen, setFormOpen] = useState(false)
  const [draftTags, setDraftTags] = useState<string[]>([])
  const [bodyLength, setBodyLength] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [submitTried, setSubmitTried] = useState(false)
  const [formError, setFormError] = useState<{ field: 'title' | 'body' | 'form'; text: string } | null>(null)
  const [guidelinesOpen, setGuidelinesOpen] = useState(false)
  const [guidelinesExpanded, setGuidelinesExpanded] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    setFormOpen(false); setTitle(''); setSearch(''); setDraftTags([]); setBodyLength(0); setFormError(null); setSubmitTried(false)
    setGuidelinesOpen(false); setGuidelinesExpanded(false)
  }, [forumId])
  const tagMissing = Boolean(settings?.requireTag) && draftTags.length === 0
  const titleOk = title.trim().length > 0
  const bodyOk = bodyLength > 0
  const showTagError = formOpen && tagMissing && ((titleOk && bodyOk) || submitTried)
  const draftValid = titleOk && bodyOk && !tagMissing

  const openForm = useCallback(() => {
    if (!signedIn) { onRequireSignIn(); return }
    if (!canCreatePost) return
    setFormOpen(true)
    setSearch('')
    if (guidelines) setGuidelinesOpen(true)
    requestAnimationFrame(() => {
      if (title.trim()) bodyRef.current?.focus()
      else titleRef.current?.focus()
    })
  }, [signedIn, canCreatePost, onRequireSignIn, guidelines, title])

  const closeForm = useCallback(() => {
    setFormOpen(false); setTitle(''); setDraftTags([]); setBodyLength(0); setFormError(null); setSubmitTried(false)
    if (bodyRef.current) bodyRef.current.innerHTML = ''
  }, [])

  const submitPost = useCallback(async () => {
    if (submitting) return
    setSubmitTried(true)
    const name = title.trim()
    const content = bodyRef.current ? serializeComposer(bodyRef.current).trim() : ''
    if (!name) { setFormError({ field: 'title', text: 'A title is required' }); return }
    if (!content) { setFormError({ field: 'body', text: 'A message is required' }); return }
    if (tagMissing) return
    setFormError(null)
    setSubmitting(true)
    const clientId = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    try {
      const { post } = await createForumPost(forumId, name.slice(0, TITLE_MAX), content.slice(0, BODY_MAX), draftTags.slice(0, TAG_LIMIT), clientId)
      markPostSeen(post.id, post.messageCount)
      setPosts((cur) => (cur.some((x) => x.id === post.id) ? cur : [post, ...cur]))
      closeForm()
      onOpenPost(post)
    } catch (err) {
      const e = err as BridgeRequestError
      if (e.code === 40067) setSubmitTried(true)
      else if (e.code === 50035) setFormError({ field: 'title', text: e.message || 'A title is required' })
      else setFormError({ field: 'form', text: e.message || 'Something went wrong.' })
    } finally {
      setSubmitting(false)
    }
  }, [submitting, title, tagMissing, forumId, draftTags, closeForm, onOpenPost])

  const onTitleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter') { if (e.key === 'Escape' && formOpen && !title && !bodyLength) closeForm(); return }
    e.preventDefault()
    if (formOpen) { if (title.trim()) bodyRef.current?.focus(); return }
    if (e.shiftKey && canCreatePost) { openForm(); return }
    setSearch(title.trim())
  }

  // --- Layout: scroller, gallery columns, infinite paging ---
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const onScroll = () => {
    const el = scrollerRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 600) loadMore()
  }
  useEffect(() => { onScroll() })

  const gallery = prefs.layout === 'gallery'
  const ordered = useMemo(() => {
    const pinnedFirst = [...posts].sort((a, b) => Number(b.pinned) - Number(a.pinned))
    return { active: pinnedFirst.filter((p) => !p.archived), archived: pinnedFirst.filter((p) => p.archived) }
  }, [posts])
  const columns = galleryColumns(Math.max(0, width - 48))

  // --- Popouts ---
  const [sortOpen, setSortOpen] = useState(false)
  const [tagsOpen, setTagsOpen] = useState(false)
  const [draftTagsOpen, setDraftTagsOpen] = useState(false)
  const sortBtnRef = useRef<HTMLElement | null>(null)
  const tagsBtnRef = useRef<HTMLElement | null>(null)
  const draftTagsBtnRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!tagsOpen && !draftTagsOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null
      if (t?.closest('.dcfTagPop-container') || t?.closest('.dcfPage-tagsButton') || t?.closest('.dcfComposer-tagsButton')) return
      setTagsOpen(false); setDraftTagsOpen(false)
    }
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { setTagsOpen(false); setDraftTagsOpen(false) } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [tagsOpen, draftTagsOpen])

  const sortEntries: MenuEntry[] = [
    { key: 'sort-label', label: 'Sort by', groupLabel: true },
    { key: 'sort-by-recent-activity', label: 'Recently Active', affordance: 'radio', group: 'sort', checked: prefs.sort === 'activity', keepOpen: false, onSelect: () => setPrefs({ ...prefs, sort: 'activity' }) },
    { key: 'sort-by-date-posted', label: 'Date Posted', affordance: 'radio', group: 'sort', checked: prefs.sort === 'created', keepOpen: false, onSelect: () => setPrefs({ ...prefs, sort: 'created' }) },
    ...(!media ? [
      'separator' as const,
      { key: 'view-label', label: 'View as', groupLabel: true },
      { key: 'view-as-list', label: 'List', affordance: 'radio' as const, group: 'view', checked: prefs.layout === 'list', keepOpen: false, onSelect: () => setPrefs({ ...prefs, layout: 'list' }) },
      { key: 'view-as-grid', label: 'Gallery', affordance: 'radio' as const, group: 'view', checked: prefs.layout === 'gallery', keepOpen: false, onSelect: () => setPrefs({ ...prefs, layout: 'gallery' }) },
    ] : []),
    ...(availableTags.length ? [
      'separator' as const,
      { key: 'match-label', label: 'Tag Matching', groupLabel: true },
      { key: 'match-some', label: 'Match Some', affordance: 'radio' as const, group: 'match', checked: prefs.match === 'some', keepOpen: false, onSelect: () => setPrefs({ ...prefs, match: 'some' }) },
      { key: 'match-all', label: 'Match All', affordance: 'radio' as const, group: 'match', checked: prefs.match === 'all', keepOpen: false, onSelect: () => setPrefs({ ...prefs, match: 'all' }) },
    ] : []),
    'separator',
    { key: 'reset-all', label: 'Reset to default', onSelect: () => setPrefs(null) },
  ]

  const toggleFilterTag = (id: string) => setTagFilter(tagFilter.includes(id) ? tagFilter.filter((t) => t !== id) : [...tagFilter, id])
  const toggleDraftTag = (id: string) => setDraftTags((cur) => (cur.includes(id) ? cur.filter((t) => t !== id) : cur.length >= TAG_LIMIT ? cur : [...cur, id]))

  // Overflow buttons ("All" in the filter row, "See more tags" in the New
  // Post tag picker): pinned right after the last pill of the first row.
  const tagListRef = useRef<HTMLDivElement>(null)
  const tagsButtonLeft = useOverflowButtonLeft(tagListRef, [availableTags, tagFilter, width, guidelinesOpen])
  const draftTagListRef = useRef<HTMLDivElement>(null)
  const draftTagsButtonLeft = useOverflowButtonLeft(draftTagListRef, [availableTags, draftTags, width, formOpen])

  const openPost = (post: ForumPost) => {
    markPostSeen(post.id, post.messageCount)
    setSeen(readMap<number>(SEEN_KEY))
    onOpenPost(post)
  }
  const renderCard = (post: ForumPost) => {
    const state = cardState(post)
    const onContextMenu = (e: ReactMouseEvent) => { e.preventDefault(); setMenu({ post, x: e.clientX, y: e.clientY }) }
    if (gallery) {
      return <GalleryCard key={post.id} post={post} state={state} tags={tagMap} filter={tagFilter} defaultEmoji={settings?.defaultReactionEmoji || null} isOpen={post.id === openPostId} media={media} query={search} onOpen={() => openPost(post)} onContextMenu={onContextMenu} />
    }
    return (
      <div key={post.id} className="dcfPage-card">
        <ListCard post={post} state={state} tags={tagMap} filter={tagFilter} sort={prefs.sort} defaultEmoji={settings?.defaultReactionEmoji || null} isOpen={post.id === openPostId} query={search} onOpen={() => openPost(post)} onContextMenu={onContextMenu} />
      </div>
    )
  }
  const section = (list: ForumPost[]) => (gallery
    ? <ul className="dcfGridCols" role="grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>{list.map(renderCard)}</ul>
    : <div role="list">{list.map(renderCard)}</div>)

  const empty = !loading && !denied && posts.length === 0
  const filterActive = tagFilter.length > 0
  const sortLabel = media ? 'Sort' : 'Sort & View'
  const titlePlaceholder = formOpen ? 'Title' : canCreatePost ? 'Search or create a post...' : 'Search'
  const searching = search.length > 0
  const showMatchingRow = !formOpen && (searching || (titleFocused && !title))

  return (
    <div className={`dcfPage-container dcfForumRoot${gallery ? ' dcfForumGallery' : ''}`}>
      <div className="dcfForumScroller" ref={scrollerRef} onScroll={onScroll}>
        <div className={gallery ? 'dcfPage-grid' : 'dcfPage-list'}>
          <div>
            {/* Section 0: the header card. */}
            <div className="dcfPage-card dcfPage-headerRow dcfPage-columnsSpan">
              <div className="dcfPage-headerContainer">
                <div className="dcfPage-mainCardContainer">
                  <div className={`dcfPage-mainCard dcfPage-header${showMatchingRow ? ' dcfPage-headerWithMatchingPosts' : ''}`}>
                    <Holy
                      as="div"
                      holy={{ 'aria-label': formOpen ? 'Create Post' : 'Search' }}
                      className={`dcfComposer-container${formOpen ? '' : ' dcfComposer-collapsed'}`}
                    >
                      <div className="dcfComposer-formContainer">
                        <div className="dcfComposer-prefixElement">
                          {formOpen
                            ? <Glyph d={PENCIL_ICON} size={20} className="dcfComposer-pencilIcon" />
                            : searching || title
                              ? (
                                <Holy as="button" type="button" holy={{ 'aria-label': 'Clear' }} className="dcfIconButton dcfComposer-searchIcon" onClick={() => { setTitle(''); setSearch('') }}>
                                  <Glyph d={CLOSE_ICON} size={20} />
                                </Holy>
                              )
                              : <Glyph d={SEARCH_ICON} size={20} className="dcfComposer-searchIcon dcfPage-searchIcon" />}
                        </div>
                        <div className="dcfComposer-form">
                          <div className="dcfComposer-titleContainer">
                            <Holy
                              as="textarea"
                              holy={{ placeholder: titlePlaceholder, 'aria-label': formOpen ? 'Title' : 'Search forum posts' }}
                              elRef={titleRef as Ref<HTMLElement>}
                              className={`dcfComposer-title ${formOpen && title ? 'dcfT-hmd-semibold' : 'dcfT-tmd-normal dcfComposerTitleCollapsed'}`}
                              rows={1}
                              maxLength={TITLE_MAX}
                              value={title}
                              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => { setTitle(e.target.value.replace(/\n/g, '')); if (formError?.field === 'title') setFormError(null) }}
                              onKeyDown={onTitleKeyDown}
                              onFocus={() => setTitleFocused(true)}
                              // Hide the hint row only after the press that blurred
                              // the field lands (the row's height would otherwise
                              // move the target out from under the pointer).
                              onBlur={() => { window.setTimeout(() => setTitleFocused(false), 200) }}
                            />
                            {!formOpen && (
                              <div className="dcfComposerTitleActions">
                                {guidelines && (
                                  <Holy as="button" type="button" holy={{ 'aria-label': 'Post Guidelines', title: 'Post Guidelines' }} className="dcfBtn dcfBtnSecondary dcfBtnSm dcfBtnIcon" onClick={() => setGuidelinesOpen((o) => !o)}>
                                    <Glyph d={BOOK_CHECK_ICON_PATH} size={16} evenodd />
                                  </Holy>
                                )}
                                <button type="button" className="dcfBtn dcfBtnPrimary dcfBtnSm" disabled={signedIn && !canCreatePost} onClick={openForm}>
                                  <Glyph d={CHAT_ICON_PATH} size={16} />
                                  <HolyText text="New Post" />
                                </button>
                              </div>
                            )}
                            {formOpen && (
                              <Holy as="button" type="button" holy={{ 'aria-label': 'Close', title: 'Close' }} className="dcfIconButton dcfComposer-closeIcon" onClick={closeForm}>
                                <Glyph d={CLOSE_ICON} size={20} />
                              </Holy>
                            )}
                          </div>
                          {formOpen && formError?.field === 'title' && <HolyText as="div" className="dcfFieldError dcfT-txs-normal" text={formError.text} />}
                          {formOpen && (
                            <div className="dcfComposer-bodyContainer">
                              <div className="dcfComposer-contentContainer dcfComposerBody">
                                {/* The channel composer, reused for the post's first
                                    message. Its placeholder rides data-placeholder
                                    (CSS ::before), which useHolyAttr can't carry -
                                    same as the channel composer. */}
                                <Composer
                                  ref={bodyRef}
                                  placeholder="Enter a message..."
                                  disabled={submitting}
                                  sending={submitting}
                                  canGifs={false}
                                  canStickers={false}
                                  locked={false}
                                  hasContent={false}
                                  charCount={bodyLength}
                                  maxLength={BODY_MAX}
                                  counterThreshold={200}
                                  onSubmit={(e) => { e?.preventDefault(); void submitPost() }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submitPost() }
                                  }}
                                  onInput={(el) => { setBodyLength(serializeComposer(el).length); normalizeEmpty(el); if (formError?.field === 'body') setFormError(null) }}
                                  onPaste={(el, e) => { pastePlainText(e.nativeEvent, el); setBodyLength(serializeComposer(el).length) }}
                                  onOpenEmoji={() => {}}
                                  onOpenGifs={() => {}}
                                  onOpenStickers={() => {}}
                                />
                              </div>
                            </div>
                          )}
                          {formOpen && formError?.field === 'body' && <HolyText as="div" className="dcfFieldError dcfT-txs-normal" text={formError.text} />}
                        </div>
                      </div>
                      {formOpen && (
                        <div className="dcfComposer-form">
                          <div className="dcfComposer-horizontalPadding">
                            {availableTags.length > 0 && (
                              <>
                                <div className="dcfComposer-tagsContainer">
                                  <Glyph d={TAG_ICON} size={20} className="dcfComposer-tagsIcon" />
                                  <div className="dcfComposer-tagList" ref={draftTagListRef}>
                                    <div className="dcfComposer-tagListInner">
                                      {availableTags.map((tag) => {
                                        const selected = draftTags.includes(tag.id)
                                        const staffOnly = tag.moderated && !perms?.canManagePosts
                                        return (
                                          <TagPill
                                            key={tag.id}
                                            tag={tag}
                                            small
                                            selected={selected}
                                            disabled={staffOnly || (!selected && draftTags.length >= TAG_LIMIT)}
                                            holyLabel="Add tag, {tagName}"
                                            onClick={() => toggleDraftTag(tag.id)}
                                          />
                                        )
                                      })}
                                    </div>
                                  </div>
                                  <Holy
                                    as="button"
                                    type="button"
                                    holy={{ 'aria-label': 'See more tags' }}
                                    elRef={draftTagsBtnRef}
                                    className="dcfComposer-tagsButton dcfLinkButton dcfT-tsm-medium"
                                    style={draftTagsButtonLeft !== null ? { left: draftTagsButtonLeft } : { visibility: 'hidden' }}
                                    onClick={() => setDraftTagsOpen((o) => !o)}
                                  >
                                    <HolyText text="See more tags" />
                                  </Holy>
                                  {/* Invisible twin that reserves the button's width. */}
                                  <div className="dcfComposer-tagsButton dcfComposer-tagsButtonPlaceholder dcfLinkButton dcfT-tsm-medium" aria-hidden="true">
                                    <HolyText text="See more tags" />
                                  </div>
                                </div>
                                <div className="dcfComposer-tagsDivider" />
                              </>
                            )}
                            <div className="dcfComposer-controlsContainer">
                              <div className="dcfComposer-controls">
                                <div className="dcfComposer-wrappedControls">
                                  {formError?.field === 'form' && <HolyText className="dcfT-tsm-normal dcfC-critical" text={formError.text} />}
                                  {guidelines && (
                                    <Holy as="button" type="button" holy={{ 'aria-label': 'Post Guidelines', title: 'Post Guidelines' }} className="dcfBtn dcfBtnSecondary dcfBtnSm dcfBtnIcon" onClick={() => setGuidelinesOpen((o) => !o)}>
                                      <Glyph d={BOOK_CHECK_ICON_PATH} size={16} evenodd />
                                    </Holy>
                                  )}
                                  <button type="button" className="dcfBtn dcfBtnPrimary dcfBtnSm dcfPostSubmit" disabled={!canCreatePost || submitting || !draftValid} onClick={() => void submitPost()}>
                                    <Glyph d={CHAT_ICON_PATH} size={16} />
                                    <HolyText text="Post" />
                                  </button>
                                </div>
                              </div>
                            </div>
                            {showTagError && (
                              <HolyText as="div" className="dcfComposer-requiredError dcfT-txs-normal dcfC-critical" text="A tag is required to create a post in this channel" />
                            )}
                          </div>
                        </div>
                      )}
                    </Holy>
                  </div>
                  {showMatchingRow && (
                    <div className="dcfPage-matchingPostsRow dcfT-txs-normal">
                      {searching ? (
                        <div className="dcfPage-matchingPosts">
                          {loading
                            ? <HolyText className="dcfC-muted" text="Searching..." />
                            : total === 0
                              ? <HolyText className="dcfC-muted" text="No matching posts" />
                              : (
                                <HolyRich className="dcfC-muted">
                                  <HolyDynamic>{String(total)}</HolyDynamic> {total === 1 ? 'post' : 'posts'} with &quot;<HolyDynamic>{search}</HolyDynamic>&quot;
                                </HolyRich>
                              )}
                          <span role="button" tabIndex={0} className="dcfPage-clear dcfC-brand" onMouseDown={(e) => e.preventDefault()} onClick={() => { setTitle(''); setSearch('') }} onKeyDown={(e) => { if (e.key === 'Enter') { setTitle(''); setSearch('') } }}>
                            <HolyText text="Clear" />
                          </span>
                        </div>
                      ) : null}
                      <div className="dcfPage-tagsSpacer" />
                      {!searching && (
                        canCreatePost ? (
                          <div className="dcfPage-startPostHelp dcfC-muted">
                            <HolyText className="dcfPage-keyboardShortcut dcfPage-key dcfKbd" text="SHIFT" />
                            <span>+</span>
                            <HolyText className="dcfPage-keyboardShortcut dcfPage-key dcfKbd" text="ENTER" />
                            <HolyText text="to create a new post" />
                          </div>
                        ) : (
                          <div className="dcfPage-startPostHelp dcfC-muted">
                            <Glyph d={WARN_ICON} size={14} className="dcfPage-warnIcon" evenodd />
                            <HolyText text="You do not have permission to post in this channel." />
                          </div>
                        )
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Post Guidelines (the forum topic). */}
              {guidelines && guidelinesOpen && (
                <div className="dcfGuide-container">
                  <div className="dcfGuide-headerContainer">
                    <div className="dcfGuide-guidelinesHeader dcfT-hlg-semibold dcfC-strong">
                      <Glyph d={BOOK_CHECK_ICON_PATH} size={20} evenodd />
                      <HolyText text="Post Guidelines" />
                    </div>
                    <Holy as="span" holy={{ 'aria-label': 'Close' }} role="button" tabIndex={0} className="dcfGuide-clickable" onClick={() => setGuidelinesOpen(false)} onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter') setGuidelinesOpen(false) }}>
                      <Glyph d={CLOSE_ICON} size={20} />
                    </Holy>
                  </div>
                  <div className="dcfGuide-descriptionContainer" style={guidelinesExpanded ? undefined : { maxHeight: 220 }}>
                    {/* The forum topic through the message markdown pipeline
                        (renderMarkdown escapes every text node). */}
                    <div className="dcfGuide-guidelines dcfC-default markup" dangerouslySetInnerHTML={{ __html: previewHtml(guidelines, false) }} />
                    {!guidelinesExpanded && guidelines.length > 280 && (
                      <div className="dcfGuide-showMore">
                        <div className="dcfGuide-gradient" />
                        <div className="dcfGuide-linkContainer">
                          <span role="button" tabIndex={0} className="dcfGuide-showMoreLink" onClick={() => setGuidelinesExpanded(true)} onKeyDown={(e) => { if (e.key === 'Enter') setGuidelinesExpanded(true) }}>
                            <span className="dcfGuide-showMoreText dcfT-tsm-semibold dcfC-link">
                              <HolyText text="View All" />
                              <Glyph d={CHEVRON_DOWN} size={16} className="dcfGuide-showMoreIcon" />
                            </span>
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Sort & View + tag filter row. */}
              <div className="dcfPage-tagsContainer">
                <Holy
                  as="button"
                  type="button"
                  holy={{ 'aria-label': media ? 'Change the sort for Media Posts' : 'Set sort or view' }}
                  elRef={sortBtnRef}
                  className="dcfPage-sortDropdown"
                  aria-haspopup="menu"
                  aria-expanded={sortOpen}
                  onMouseDown={(e: ReactMouseEvent) => { if (sortOpen) e.stopPropagation() }}
                  onClick={() => setSortOpen((o) => !o)}
                >
                  <div className="dcfPage-sortDropdownInner">
                    <Glyph d={SORT_ICON} size={16} />
                    <HolyText className="dcfPage-sortDropdownText dcfT-tsm-medium" text={sortLabel} />
                    <Glyph d={sortOpen ? CHEVRON_UP : CHEVRON_DOWN} size={20} />
                  </div>
                </Holy>
                {availableTags.length > 0 && (
                  <>
                    <div className="dcfPage-divider" />
                    <div className="dcfPage-tagList" ref={tagListRef}>
                      <div className="dcfPage-tagListInner">
                        {availableTags.map((tag) => (
                          <TagPill key={tag.id} tag={tag} selected={tagFilter.includes(tag.id)} onClick={() => toggleFilterTag(tag.id)} />
                        ))}
                      </div>
                    </div>
                    <Holy
                      as="button"
                      type="button"
                      holy={{ 'aria-label': filterActive ? 'see all tags' : 'see more tags' }}
                      elRef={tagsBtnRef}
                      className={`dcfPage-tagsButton${filterActive ? ' dcfPage-tagsButtonWithCount' : ''}`}
                      style={tagsButtonLeft !== null ? { left: tagsButtonLeft } : { visibility: 'hidden' }}
                      onClick={() => setTagsOpen((o) => !o)}
                    >
                      <div className="dcfPage-tagsButtonInner">
                        {filterActive
                          ? <div className="dcfPage-countContainer"><span className="dcfPage-countText dcfT-txs-medium">{tagFilter.length}</span></div>
                          : <HolyText className="dcfT-tsm-medium" text="All" />}
                        <Glyph d={tagsOpen ? CHEVRON_UP : CHEVRON_DOWN} size={20} />
                      </div>
                    </Holy>
                    {/* Invisible twin that reserves the button's width. */}
                    <div className={`dcfPage-tagsButton dcfPage-tagsButtonPlaceholder${filterActive ? ' dcfPage-tagsButtonWithCount' : ''}`} aria-hidden="true">
                      <div className="dcfPage-tagsButtonInner">
                        {filterActive ? <div className="dcfPage-countContainer"><span className="dcfPage-countText dcfT-txs-medium">{tagFilter.length}</span></div> : <HolyText className="dcfT-tsm-medium" text="All" />}
                        <Glyph d={CHEVRON_DOWN} size={20} />
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Body: posts, empty state or no-access row. */}
            {denied && (
              <div className="dcfPage-missingReadHistoryPermission dcfPage-columnsSpan">
                <HolyRich as="span" className="dcfT-tsm-normal dcfC-muted">
                  You do not have permission to view the post history of <strong><HolyDynamic>#{forum.name}</HolyDynamic></strong>.
                </HolyRich>
              </div>
            )}
            {loading && !denied && (
              <div className={gallery ? 'dcfGridLoading' : undefined}>
                {[0, 1, 2].map((i) => <div key={i} className={`dcfPage-loadingCard dcfPage-loadingCard-${i}`} />)}
              </div>
            )}
            {empty && !searching && (
              <div className="dcfPage-card dcfPage-columnsSpan">
                <div className="dcfEmpty-container">
                  {filterActive ? (
                    <>
                      <HolyText as="h3" className="dcfEmpty-header dcfT-hmd-semibold dcfC-strong" text={tagFilter.length === 1 ? 'There are no posts with this tag yet!' : 'There are no posts with these tags yet!'} />
                      <HolyText as="div" className="dcfT-tsm-normal dcfC-default" text={tagFilter.length === 1 ? 'Be the first to start a conversation with this tag' : 'Be the first to start a conversation with these tags'} />
                    </>
                  ) : (
                    <>
                      <HolyText as="h3" className="dcfEmpty-header dcfT-hmd-semibold dcfC-strong" text="Be the first to start the conversation!" />
                      <HolyRich as="div" className="dcfT-tsm-normal dcfC-default">
                        What do you want to post about in <HolyDynamic>#{forum.name}</HolyDynamic>?
                      </HolyRich>
                    </>
                  )}
                  {canCreatePost && (
                    <button type="button" className="dcfBtn dcfBtnSecondary dcfBtnSm dcfEmptyButton" onClick={openForm}>
                      <HolyText text="Create a post" />
                    </button>
                  )}
                </div>
              </div>
            )}
            {!loading && !denied && ordered.active.length > 0 && section(ordered.active)}
            {!loading && !denied && ordered.archived.length > 0 && (
              <>
                {ordered.active.length > 0 && (
                  <div className="dcfPage-card dcfPage-archivedDividerRow dcfPage-columnsSpan">
                    <div className="dcfPage-emptyMainCard">
                      <HolyText as="h2" className="dcfPage-archivedDivider dcfT-eyebrow" text="Older Posts" />
                    </div>
                  </div>
                )}
                {section(ordered.archived)}
              </>
            )}
            {loadingMore && (
              <div className={gallery ? 'dcfGridLoading' : undefined}>
                {[0, 1, 2].map((i) => <div key={i} className={`dcfPage-loadingCard dcfPage-loadingCard-${i}`} />)}
              </div>
            )}
            <div className="dcfForumBottomPad" />
          </div>
        </div>
      </div>

      {arrivals.length > 0 && (
        <button type="button" className="dcfPage-newPostsButton dcfT-tsm-semibold dcfC-strong" onClick={showArrivals}>
          <HolyRich>
            <HolyDynamic>{String(arrivals.length)}</HolyDynamic> {arrivals.length === 1 ? 'New Post' : 'New Posts'}
          </HolyRich>
        </button>
      )}

      {sortOpen && (
        <ContextMenu
          x={0}
          y={0}
          anchor={() => sortBtnRef.current}
          anchorOptions={{ position: 'bottom', align: 'left', spacing: 8 }}
          entries={sortEntries}
          onClose={() => setSortOpen(false)}
          ariaLabel={media ? 'Change the sort for Media Posts' : 'Set sort or view'}
          layerClassName="dcfSortMenu"
        />
      )}

      {(tagsOpen || draftTagsOpen) && (
        <Popout anchor={() => (tagsOpen ? tagsBtnRef.current : draftTagsBtnRef.current)} position={tagsOpen ? 'bottom' : 'top'} align="right" spacing={8}>{(ref) => (
          <div ref={ref} className="dcfTagPop-container" role="dialog">
            <div className="dcfTagPop-header">
              <div className="dcfTagPop-headerLeft">
                <HolyText as="h2" className="dcfTagPop-headerText dcfT-hmd-semibold dcfC-strong" text="Select Tags" />
                {(tagsOpen ? tagFilter : draftTags).length > 0 && (
                  <div className="dcfTagPop-countContainer"><span className="dcfTagPop-countText dcfT-txs-medium">{(tagsOpen ? tagFilter : draftTags).length}</span></div>
                )}
              </div>
            </div>
            <div className="dcfTagPop-tagContainer">
              {availableTags.map((tag) => {
                const list = tagsOpen ? tagFilter : draftTags
                const selected = list.includes(tag.id)
                const disabled = !tagsOpen && ((tag.moderated && !perms?.canManagePosts) || (!selected && draftTags.length >= TAG_LIMIT))
                return (
                  <TagPill
                    key={tag.id}
                    tag={tag}
                    selected={selected}
                    disabled={disabled}
                    className="dcfTagPop-tag"
                    holyLabel={tagsOpen ? undefined : 'Add tag, {tagName}'}
                    onClick={() => (tagsOpen ? toggleFilterTag(tag.id) : toggleDraftTag(tag.id))}
                  />
                )
              })}
            </div>
            <div className="dcfTagPop-separator" />
            <button type="button" className="dcfLinkButton dcfT-tsm-medium dcfTagPopClear" onClick={() => (tagsOpen ? setTagFilter([]) : setDraftTags([]))}>
              <HolyText text="Clear all" />
            </button>
          </div>
        )}</Popout>
      )}

      {menu && menuEntries.length > 0 && (
        <ContextMenu x={menu.x} y={menu.y} entries={menuEntries} onClose={() => setMenu(null)} ariaLabel="Post Actions" />
      )}
      {modal && (
        <PostActionModal
          kind={modal.kind}
          post={modal.post}
          forum={forum}
          onClose={() => setModal(null)}
          onDone={(res) => {
            if (res.deleted) setPosts((cur) => cur.filter((x) => x.id !== modal.post.id))
            else if (res.post) setPosts((cur) => cur.map((x) => (x.id === res.post!.id ? res.post! : x)))
          }}
        />
      )}
    </div>
  )
}

/* Small re-export so chat.tsx can render the "(forum) › post" breadcrumb
 * glyph without importing the icon paths itself. */
export function PostGlyph({ size = 20, className }: { size?: number; className?: string }) {
  return <Glyph d={CHAT_ICON_PATH} size={size} className={className} />
}

