import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { BridgeGuild } from '../../lib/bridge'
import type { GuildFolder } from '../../lib/guild-folders'
import { useHolyAttr } from '../../lib/holy-attr'
import { ContextMenu, type MenuEntry } from './ContextMenu'
import { FolderSettingsModal } from './FolderSettingsModal'
import { FolderTooltip } from './GuildTooltip'
import { GuildIconBody } from './guildIcon'
import {
  defaultFolderName,
  effectiveLayout,
  folderColorCss,
  isNoopFolderDrop,
  isNoopGuildDrop,
  moveFolder,
  moveGuild,
  railEntries,
  updateFolder,
  type FolderDrop,
  type GuildDrop,
  type RailFolder,
} from './guildFolders'
import './guild-rail.css'

/* Discord's server rail: servers, folders, drag-to-reorder (guildFolders).
 *
 * Drag follows Discord's DnD rules (web bundle @5469257 / @9166659), driven by
 * pointer events instead of HTML5 DnD so it also works on touch:
 *   - every item has a drop overlay from 16px above to 4px below its icon;
 *     a root item's top half inserts before it, its bottom half combines
 *     (onto a server → new folder; onto a folder → append). Items inside an
 *     open folder only take insert-before; a 24px zone at the folder's end
 *     appends. A dragged folder only lands at root with insert-before.
 *   - the dragged slot stays as a dashed placeholder; neighbours hold still and
 *     the list reflows on drop. Green bar = insert, green dot = combine; a
 *     server held over another wobbles and shows the new-folder preview after
 *     70ms; a folder target wobbles with a green fill at once.
 *   - the dragged icon follows the pointer anywhere (held at the grab point);
 *     drop targets exist only over the rail, so releasing elsewhere does nothing.
 *   - Escape cancels; a no-op drop changes nothing and saves nothing.
 * A mouse drag starts after 5px; a touch drag after a 300ms hold (so the rail
 * still scrolls). A finished drag never clicks through. */

export type GuildBadge = { unread: boolean; mentions: number }

export type GuildRailProps = {
  guilds: BridgeGuild[]
  folders: GuildFolder[]
  activeGuildId: string | null
  badges: Record<string, GuildBadge>
  /** Signed-in accounts can rearrange the rail and edit folders. */
  editable: boolean
  onSelectGuild: (guildId: string) => void
  /** The whole new layout to save (Discord sends the full guildFolders). */
  onLayoutChange: (folders: GuildFolder[]) => void
  onGuildEnter: (guildId: string, e: ReactMouseEvent) => void
  onGuildLeave: () => void
  onGuildContext: (guildId: string, e: ReactMouseEvent) => void
  onMarkRead: (guildIds: string[]) => void
  onDragStart?: () => void
  fallback?: ReactNode
}

const DRAG_THRESHOLD_PX = 5
const TOUCH_HOLD_MS = 300
const TOUCH_SLOP_PX = 8
// Touch fires its click later than mouse, so the swallow window is generous.
const CLICK_SUPPRESS_MS = 300
// Discord's combine debounce before the wobble + new-folder preview (@5506076).
const COMBINE_DELAY_MS = 70
// FOLDER_ITEM_ANIMATION_DURATION.
const FOLDER_ANIMATION_MS = 150
const ICON_PX = 40
// Drop overlay: 16px above the icon to 4px below (all.css L1555).
const OVERLAY_ABOVE = 16
const OVERLAY_BELOW = 4
const OVERLAY_SPLIT = (ICON_PX + OVERLAY_ABOVE + OVERLAY_BELOW) / 2 - OVERLAY_ABOVE // top half ends 14px into the icon
const FOLDER_END_ZONE = 24
const AUTOSCROLL_EDGE_PX = 40
const AUTOSCROLL_STEP_PX = 8
const EXPANDED_KEY = 'abulxt:chat-expanded-folders'

type Source = { kind: 'guild'; guildId: string } | { kind: 'folder'; folderId: number }
type Drop = GuildDrop | FolderDrop

type Visual = {
  /** Insert bar (nav coordinates) or combine dot. */
  bar: number | null
  dot: number | null
  /** Root server being combined onto (wobble + preview after the delay). */
  combineGuild: string | null
  /** Folder receiving the server (closed: green fill; open: green column). */
  folderTarget: number | null
  /** Open folder whose end zone is hovered (its spacer opens). */
  folderEnd: number | null
}
const NO_VISUAL: Visual = { bar: null, dot: null, combineGuild: null, folderTarget: null, folderEnd: null }
const sameVisual = (a: Visual, b: Visual) =>
  a.bar === b.bar && a.dot === b.dot && a.combineGuild === b.combineGuild && a.folderTarget === b.folderTarget && a.folderEnd === b.folderEnd

type Drag = {
  source: Source
  pointerId: number
  pointerType: string
  startX: number
  startY: number
  x: number
  y: number
  // Where the pointer grabbed the icon, so the ghost keeps that offset (the
  // native drag image Discord uses does the same).
  grabX: number
  grabY: number
  active: boolean
  drop: Drop | null
  holdTimer?: ReturnType<typeof setTimeout>
}

type Listeners = {
  move: (e: PointerEvent) => void
  up: (e: PointerEvent) => void
  cancel: (e: PointerEvent) => void
  key: (e: KeyboardEvent) => void
  touch: (e: TouchEvent) => void
  finish: (commit: boolean) => void
}

function readExpanded(): number[] {
  try {
    const raw = JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((id): id is number => typeof id === 'number') : []
  } catch {
    return []
  }
}

function writeExpanded(ids: number[]) {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(ids))
  } catch {
    // Storage blocked: expansion just won't survive a reload.
  }
}

// The mention badge's accessible name ("3 unread mentions") is set through
// useHolyAttr; the count itself is a data value.
function MentionBadge({ count }: { count: number }) {
  const label = useHolyAttr({ 'aria-label': `${count} unread ${count === 1 ? 'mention' : 'mentions'}` })
  return (
    <span className="guild-mention-badge" role="img" ref={label.ref} {...label.placeholder}>
      {count > 99 ? '99+' : count}
    </span>
  )
}

// An open folder's server list: height 0 → content and each server scaling
// 0 → 1 over 150ms (react-spring in Discord), reversed before unmounting.
function FolderItems({ open, id, label, children }: { open: boolean; id: string; label: string; children: ReactNode }) {
  const [mounted, setMounted] = useState(open)
  const ref = useRef<HTMLDivElement>(null)
  const first = useRef(true)

  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (open) setMounted(true)
  }, [open])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || first.current) return
    let timer: ReturnType<typeof setTimeout>
    if (open) {
      el.style.height = '0px'
      el.dataset.state = 'enter'
      void el.offsetHeight
      el.style.height = `${el.scrollHeight}px`
      el.dataset.state = 'open'
      timer = setTimeout(() => { el.style.height = '' }, FOLDER_ANIMATION_MS)
    } else {
      el.style.height = `${el.scrollHeight}px`
      void el.offsetHeight
      el.style.height = '0px'
      el.dataset.state = 'exit'
      timer = setTimeout(() => setMounted(false), FOLDER_ANIMATION_MS)
    }
    return () => clearTimeout(timer)
  }, [open, mounted])

  if (!mounted) return null
  // The folder label is the folder's name or its servers' names: data values.
  return (
    <div className="guild-folder-items" ref={ref} data-state="open">
      <ul className="guild-folder-list" role="group" id={id} aria-label={label}>{children}</ul>
    </div>
  )
}

export function GuildRail({
  guilds,
  folders,
  activeGuildId,
  badges,
  editable,
  onSelectGuild,
  onLayoutChange,
  onGuildEnter,
  onGuildLeave,
  onGuildContext,
  onMarkRead,
  onDragStart,
  fallback,
}: GuildRailProps) {
  const entries = useMemo(() => railEntries(guilds, folders), [guilds, folders])
  const layout = useMemo(() => effectiveLayout(guilds, folders), [guilds, folders])
  const guildById = useMemo(() => new Map(guilds.map((guild) => [guild.id, guild])), [guilds])
  const folderById = useMemo(() => {
    const map = new Map<number, RailFolder>()
    for (const entry of entries) if (entry.kind === 'folder') map.set(entry.folder.id, entry.folder)
    return map
  }, [entries])

  const [expanded, setExpanded] = useState<number[]>(readExpanded)
  const [dragging, setDragging] = useState<Source | null>(null)
  const [visual, setVisual] = useState<Visual>(NO_VISUAL)
  const [combineReady, setCombineReady] = useState(false)
  const [folderTip, setFolderTip] = useState<{ folderId: number; anchorY: number } | null>(null)
  const [folderMenu, setFolderMenu] = useState<{ folderId: number; x: number; y: number } | null>(null)
  const [settingsFor, setSettingsFor] = useState<number | null>(null)
  const [page, setPage] = useState<Element | null>(null)

  const navRef = useRef<HTMLElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const suppressClickRef = useRef(false)
  const visualRef = useRef<Visual>(NO_VISUAL)
  const combineTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Latest props/derived values for the window listeners (read at move/drop time).
  const latest = useRef({ layout, onLayoutChange, onDragStart, expanded })
  latest.current = { layout, onLayoutChange, onDragStart, expanded }

  useLayoutEffect(() => {
    setPage(navRef.current?.closest('.chat-page') ?? null)
  }, [])

  // Discord's ExpandedGuildFolderStore drops ids of folders that no longer
  // exist whenever the layout updates (only once a layout is loaded, so the
  // pre-load empty layout doesn't wipe the stored state).
  useEffect(() => {
    if (!folders.length) return
    const live = new Set(folders.filter((entry) => entry.id != null).map((entry) => entry.id as number))
    setExpanded((current) => {
      const next = current.filter((id) => live.has(id))
      return next.length === current.length ? current : next
    })
  }, [folders])

  useEffect(() => writeExpanded(expanded), [expanded])

  const toggleFolder = (folderId: number, open?: boolean) => {
    setExpanded((current) => {
      const isOpen = current.includes(folderId)
      const want = open ?? !isOpen
      if (want === isOpen) return current
      return want ? [...current, folderId] : current.filter((id) => id !== folderId)
    })
  }

  // ---- drag ---------------------------------------------------------------

  // The window listeners are attached once per drag, so they keep one identity
  // (for removeEventListener) and forward to `live`, rewritten every render.
  const live = useRef<Listeners | null>(null)
  const listeners = useRef<Listeners>({
    move: (e) => live.current?.move(e),
    up: (e) => live.current?.up(e),
    cancel: (e) => live.current?.cancel(e),
    key: (e) => live.current?.key(e),
    touch: (e) => live.current?.touch(e),
    finish: (commit) => live.current?.finish(commit),
  }).current

  const applyVisual = (next: Visual) => {
    if (sameVisual(visualRef.current, next)) return
    const combineChanged = visualRef.current.combineGuild !== next.combineGuild
    visualRef.current = next
    setVisual(next)
    if (combineChanged) {
      clearTimeout(combineTimer.current)
      setCombineReady(false)
      if (next.combineGuild) combineTimer.current = setTimeout(() => setCombineReady(true), COMBINE_DELAY_MS)
    }
  }

  // Resolve the pointer to a drop target. Overlays overlap; like Discord's
  // stacked drop targets, a later item wins.
  const resolveDrop = (clientY: number, source: Source): { drop: Drop | null; visual: Visual } => {
    const nav = navRef.current
    if (!nav) return { drop: null, visual: NO_VISUAL }
    const navTop = nav.getBoundingClientRect().top - nav.scrollTop
    const toNav = (y: number) => Math.round(y - navTop)
    const nodes = Array.from(nav.querySelectorAll<HTMLElement>('[data-rail-kind]'))
    type Hit = { node: HTMLElement; rect: DOMRect; end?: number }
    let hit: Hit | null = null
    // Bottom of the last root item; an open folder ends below its servers.
    let lastRootBottom: number | null = null
    for (const node of nodes) {
      const rect = node.getBoundingClientRect()
      if (!rect.height) continue
      const kind = node.dataset.railKind
      const rootBox = kind === 'guild' ? rect : node.closest('.guild-folder')?.getBoundingClientRect() ?? rect
      lastRootBottom = Math.max(lastRootBottom ?? rootBox.bottom, rootBox.bottom)
      if (clientY >= rect.top - OVERLAY_ABOVE && clientY <= rect.bottom + OVERLAY_BELOW) hit = { node, rect }
      // A folder's end zone sits after its last server.
      if (kind === 'child' && node.dataset.lastChild === '1') {
        const folderId = Number(node.dataset.folderId)
        const spacer = visualRef.current.folderEnd === folderId ? FOLDER_END_ZONE : 0
        if (clientY >= rect.bottom - (FOLDER_END_ZONE - OVERLAY_BELOW) && clientY <= rect.bottom + OVERLAY_BELOW + spacer) {
          hit = { node, rect, end: folderId }
        }
      }
    }
    if (!hit) {
      if (lastRootBottom !== null && clientY > lastRootBottom + OVERLAY_BELOW) {
        return { drop: { type: 'root-end' }, visual: { ...NO_VISUAL, bar: toNav(lastRootBottom) + 2 } }
      }
      return { drop: null, visual: NO_VISUAL }
    }
    const { node, rect } = hit
    const kind = node.dataset.railKind
    const topHalf = clientY < rect.top + OVERLAY_SPLIT
    const barAbove = toNav(rect.top) - 6
    const dotAt = toNav(rect.top) + 12

    if (source.kind === 'folder') {
      // Folders: insert-before on root items only.
      if (kind === 'guild' && topHalf) return { drop: { type: 'before-guild', guildId: node.dataset.guildId! }, visual: { ...NO_VISUAL, bar: barAbove } }
      if (kind === 'folder' && topHalf) return { drop: { type: 'before-folder', folderId: Number(node.dataset.folderId) }, visual: { ...NO_VISUAL, bar: barAbove } }
      return { drop: null, visual: NO_VISUAL }
    }

    if (hit.end !== undefined) {
      return {
        drop: { type: 'into-folder', folderId: hit.end },
        visual: { ...NO_VISUAL, bar: toNav(rect.bottom) + OVERLAY_BELOW + FOLDER_END_ZONE - 6, folderTarget: hit.end, folderEnd: hit.end },
      }
    }
    if (kind === 'child') return { drop: { type: 'before-guild', guildId: node.dataset.guildId! }, visual: { ...NO_VISUAL, bar: barAbove } }
    if (kind === 'guild') {
      const guildId = node.dataset.guildId!
      if (topHalf) return { drop: { type: 'before-guild', guildId }, visual: { ...NO_VISUAL, bar: barAbove } }
      return { drop: { type: 'combine-guild', guildId }, visual: { ...NO_VISUAL, dot: dotAt, combineGuild: guildId } }
    }
    const folderId = Number(node.dataset.folderId)
    if (topHalf) return { drop: { type: 'before-folder', folderId }, visual: { ...NO_VISUAL, bar: barAbove } }
    return { drop: { type: 'into-folder', folderId }, visual: { ...NO_VISUAL, dot: dotAt, folderTarget: folderId } }
  }

  const isNoop = (source: Source, drop: Drop) => {
    const current = latest.current.layout
    return source.kind === 'guild'
      ? isNoopGuildDrop(current, source.guildId, drop as GuildDrop)
      : isNoopFolderDrop(current, source.folderId, drop as FolderDrop)
  }

  // Discord's drop targets cover the rail only: anywhere else the drag is
  // live (the icon still follows the pointer) but releasing does nothing.
  const overRail = (clientX: number, clientY: number) => {
    const rect = navRef.current?.getBoundingClientRect()
    return Boolean(rect && clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom)
  }

  const updateDrop = (clientX: number, clientY: number) => {
    const drag = dragRef.current
    if (!drag) return
    if (!overRail(clientX, clientY)) {
      drag.drop = null
      applyVisual(NO_VISUAL)
      return
    }
    const resolved = resolveDrop(clientY, drag.source)
    if (resolved.drop && isNoop(drag.source, resolved.drop)) {
      drag.drop = null
      applyVisual(NO_VISUAL)
      return
    }
    drag.drop = resolved.drop
    applyVisual(resolved.visual)
  }

  // The ghost follows the pointer anywhere on the page, held where it was grabbed.
  const moveGhost = (drag: Drag) => {
    const ghost = ghostRef.current
    if (!ghost) return
    ghost.style.transform = `translate(${drag.x - drag.grabX}px, ${drag.y - drag.grabY}px)`
  }

  // Scroll the rail while the pointer sits over it near its top or bottom edge.
  const autoScroll = (clientX: number, clientY: number) => {
    const nav = navRef.current
    if (!nav) return
    const rect = nav.getBoundingClientRect()
    if (clientX < rect.left || clientX > rect.right) return
    if (clientY < rect.top + AUTOSCROLL_EDGE_PX) nav.scrollTop -= AUTOSCROLL_STEP_PX
    else if (clientY > rect.bottom - AUTOSCROLL_EDGE_PX) nav.scrollTop += AUTOSCROLL_STEP_PX
  }

  const sourceSelector = (source: Source) =>
    source.kind === 'guild'
      ? `[data-guild-id="${CSS.escape(source.guildId)}"] .guild-icon`
      : `[data-folder-id="${source.folderId}"][data-rail-kind="folder"] .guild-folder-preview`

  const startDrag = (drag: Drag) => {
    const nav = navRef.current
    const visualNode = nav?.querySelector<HTMLElement>(sourceSelector(drag.source))
    if (!nav || !visualNode) return
    drag.active = true
    const ghost = ghostRef.current
    if (ghost) {
      ghost.replaceChildren(visualNode.cloneNode(true))
      ghost.classList.toggle('guild-ghost-folder', drag.source.kind === 'folder')
      const color = drag.source.kind === 'folder' ? folderColorCss(folderById.get(drag.source.folderId)?.color) : null
      if (color) ghost.style.setProperty('--custom-folder-color', color)
      else ghost.style.removeProperty('--custom-folder-color')
      ghost.classList.toggle('colored', Boolean(color))
      ghost.hidden = false
    }
    if (drag.pointerType === 'touch') window.addEventListener('touchmove', listeners.touch, { passive: false })
    setFolderTip(null)
    setDragging(drag.source)
    latest.current.onDragStart?.()
    moveGhost(drag)
    updateDrop(drag.x, drag.y)
  }

  const finish = (commit: boolean) => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    if (drag.holdTimer !== undefined) clearTimeout(drag.holdTimer)
    window.removeEventListener('pointermove', listeners.move)
    window.removeEventListener('pointerup', listeners.up)
    window.removeEventListener('pointercancel', listeners.cancel)
    window.removeEventListener('keydown', listeners.key, true)
    window.removeEventListener('touchmove', listeners.touch)
    if (!drag.active) return
    suppressClickRef.current = true
    setTimeout(() => { suppressClickRef.current = false }, CLICK_SUPPRESS_MS)
    if (ghostRef.current) ghostRef.current.hidden = true
    clearTimeout(combineTimer.current)
    setCombineReady(false)
    applyVisual(NO_VISUAL)
    setDragging(null)
    if (!commit || !drag.drop) return
    const current = latest.current.layout
    const next = drag.source.kind === 'guild'
      ? moveGuild(current, drag.source.guildId, drag.drop as GuildDrop)
      : moveFolder(current, drag.source.folderId, drag.drop as FolderDrop)
    if (JSON.stringify(next) !== JSON.stringify(current)) latest.current.onLayoutChange(next)
  }

  const onMove = (e: PointerEvent) => {
    const drag = dragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    drag.x = e.clientX
    drag.y = e.clientY
    if (!drag.active) {
      const distance = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY)
      if (drag.pointerType === 'touch') {
        // Moving before the hold means the user is scrolling the rail: let it.
        if (distance > TOUCH_SLOP_PX) finish(false)
        return
      }
      if (distance < DRAG_THRESHOLD_PX) return
      startDrag(drag)
      if (!drag.active) return
    }
    moveGhost(drag)
    autoScroll(e.clientX, e.clientY)
    updateDrop(e.clientX, e.clientY)
  }

  const onUp = (e: PointerEvent) => {
    if (dragRef.current && e.pointerId === dragRef.current.pointerId) finish(true)
  }
  const onCancel = (e: PointerEvent) => {
    if (dragRef.current && e.pointerId === dragRef.current.pointerId) finish(false)
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !dragRef.current) return
    // Cancel the drag, and keep Escape from also closing chat panels.
    if (dragRef.current.active) {
      e.preventDefault()
      e.stopPropagation()
    }
    finish(false)
  }
  const onTouchMove = (e: TouchEvent) => {
    if (e.cancelable) e.preventDefault()
  }

  live.current = { move: onMove, up: onUp, cancel: onCancel, key: onKey, touch: onTouchMove, finish }

  useEffect(() => () => {
    listeners.finish(false)
    clearTimeout(combineTimer.current)
  }, [listeners])

  const beginPointer = (source: Source) => (e: ReactPointerEvent<HTMLElement>) => {
    if (!editable || dragRef.current) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const grabbed = e.currentTarget.getBoundingClientRect()
    const drag: Drag = {
      source,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      grabX: Math.min(Math.max(e.clientX - grabbed.left, 0), ICON_PX),
      grabY: Math.min(Math.max(e.clientY - grabbed.top, 0), ICON_PX),
      active: false,
      drop: null,
    }
    dragRef.current = drag
    suppressClickRef.current = false
    window.addEventListener('pointermove', listeners.move)
    window.addEventListener('pointerup', listeners.up)
    window.addEventListener('pointercancel', listeners.cancel)
    window.addEventListener('keydown', listeners.key, true)
    if (e.pointerType === 'touch') {
      drag.holdTimer = setTimeout(() => {
        if (dragRef.current === drag && !drag.active) startDrag(drag)
      }, TOUCH_HOLD_MS)
    }
  }

  const onRailClickCapture = (e: ReactMouseEvent<HTMLElement>) => {
    if (!suppressClickRef.current) return
    suppressClickRef.current = false
    e.preventDefault()
    e.stopPropagation()
  }

  // ---- keyboard (Discord's guild tree) ---------------------------------------

  const focusables = () => Array.from(navRef.current?.querySelectorAll<HTMLElement>('[data-rail-kind]') ?? [])
  const onItemKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    const node = e.currentTarget
    const kind = node.dataset.railKind
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = focusables()
      const next = items[items.indexOf(node) + (e.key === 'ArrowDown' ? 1 : -1)]
      if (next) {
        e.preventDefault()
        next.focus()
      }
      return
    }
    if (kind === 'folder' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault()
      toggleFolder(Number(node.dataset.folderId), e.key === 'ArrowRight')
      return
    }
    if (kind === 'child' && e.key === 'ArrowLeft') {
      e.preventDefault()
      navRef.current?.querySelector<HTMLElement>(`[data-rail-kind="folder"][data-folder-id="${node.dataset.folderId}"]`)?.focus()
    }
  }

  // ---- folder hover / menu ---------------------------------------------------

  const anchorYOf = (el: Element) => {
    const rect = el.getBoundingClientRect()
    const pageTop = page?.getBoundingClientRect().top ?? 0
    return rect.top + rect.height / 2 - pageTop
  }

  const folderLabel = (folder: RailFolder) => folder.name || defaultFolderName(folder.guilds.map((guild) => guild.name)) || null

  const folderMenuEntries = (folder: RailFolder): MenuEntry[] => {
    const unread = folder.guilds.some((guild) => badges[guild.id]?.unread || (badges[guild.id]?.mentions ?? 0) > 0)
    const entries: MenuEntry[] = [
      { key: 'read', label: 'Mark Folder As Read', disabled: !unread, onSelect: () => onMarkRead(folder.guilds.map((guild) => guild.id)) },
      'separator',
    ]
    if (editable) entries.push({ key: 'settings', label: 'Folder Settings', onSelect: () => setSettingsFor(folder.id) })
    entries.push({ key: 'close-all', label: 'Close All Folders', disabled: !expanded.length, onSelect: () => setExpanded([]) })
    return entries
  }

  // ---- render ----------------------------------------------------------------

  const draggingGuild = dragging?.kind === 'guild' ? dragging.guildId : null
  const draggingFolder = dragging?.kind === 'folder' ? dragging.folderId : null

  const renderGuild = (guild: BridgeGuild, position: { level: 1 | 2; folderId?: number; last?: boolean; index: number; size: number }) => {
    const active = guild.id === activeGuildId
    const badge = badges[guild.id]
    const combining = visual.combineGuild === guild.id
    const source = draggingGuild === guild.id
    const className = [
      'guild',
      active ? 'active' : '',
      badge?.unread ? 'unread' : '',
      source ? 'dragging' : '',
      combining ? 'combine-target' : '',
      combining && combineReady ? 'combine-ready' : '',
    ].filter(Boolean).join(' ')
    const dragged = draggingGuild ? guildById.get(draggingGuild) : null
    // The guild name is the item's only accessible name and a data value.
    return (
      <button
        type="button"
        className={className}
        data-rail-kind={position.level === 1 ? 'guild' : 'child'}
        data-guild-id={guild.id}
        data-folder-id={position.folderId}
        data-last-child={position.last ? '1' : undefined}
        role="treeitem"
        aria-level={position.level}
        aria-setsize={position.size}
        aria-posinset={position.index + 1}
        aria-selected={active}
        aria-label={guild.name}
        aria-current={active ? 'page' : undefined}
        onClick={() => onSelectGuild(guild.id)}
        onPointerDown={beginPointer({ kind: 'guild', guildId: guild.id })}
        onKeyDown={onItemKeyDown}
        onMouseEnter={(e) => { if (!dragRef.current?.active) onGuildEnter(guild.id, e) }}
        onMouseLeave={onGuildLeave}
        onContextMenu={(e) => onGuildContext(guild.id, e)}
      >
        <span className="guild-pill" aria-hidden="true" />
        <GuildIconBody guild={guild} />
        {combining && combineReady && dragged && (
          // Discord's new-folder preview: the target and the dragged server as
          // a folder grid, shrinking in from 3x (translate 10px, 100ms).
          <span className="guild-folder-preview guild-combine-preview" aria-hidden="true">
            <GuildIconBody guild={guild} className="guild-folder-mini" mini />
            <GuildIconBody guild={dragged} className="guild-folder-mini" mini />
          </span>
        )}
        {(badge?.mentions ?? 0) > 0 && !source && <MentionBadge count={badge!.mentions} />}
      </button>
    )
  }

  const renderFolder = (folder: RailFolder, index: number, size: number) => {
    const open = expanded.includes(folder.id) && draggingFolder !== folder.id
    const label = folderLabel(folder)
    const childBadges = folder.guilds.map((guild) => badges[guild.id])
    const unread = childBadges.some((badge) => badge?.unread)
    const mentions = childBadges.reduce((sum, badge) => sum + (badge?.mentions ?? 0), 0)
    const selected = folder.guilds.some((guild) => guild.id === activeGuildId)
    const color = folderColorCss(folder.color)
    const isTarget = visual.folderTarget === folder.id
    const listId = `folder-items-${folder.id}`
    const wrapperClass = [
      'guild-folder',
      color ? 'colored' : '',
      open ? 'expanded' : '',
      draggingFolder === folder.id ? 'dragging' : '',
      isTarget ? 'drop-target' : '',
      visual.folderEnd === folder.id ? 'end-target' : '',
    ].filter(Boolean).join(' ')
    const buttonClass = [
      'guild',
      'guild-folder-button',
      !open && unread ? 'unread' : '',
      !open && selected ? 'folder-selected' : '',
      draggingFolder === folder.id ? 'dragging' : '',
    ].filter(Boolean).join(' ')
    return (
      <div className={wrapperClass} key={`f:${folder.id}`} style={color ? { ['--custom-folder-color' as string]: color } : undefined}>
        {open && <span className="guild-folder-bg" aria-hidden="true" />}
        <button
          type="button"
          className={buttonClass}
          data-rail-kind="folder"
          data-folder-id={folder.id}
          role="treeitem"
          aria-level={1}
          aria-setsize={size}
          aria-posinset={index + 1}
          aria-expanded={open}
          aria-owns={open ? listId : undefined}
          // The folder's name / server names are its sole accessible name (data).
          aria-label={label ?? undefined}
          onClick={() => toggleFolder(folder.id)}
          onPointerDown={beginPointer({ kind: 'folder', folderId: folder.id })}
          onKeyDown={onItemKeyDown}
          onMouseEnter={(e) => { if (!dragRef.current?.active) setFolderTip({ folderId: folder.id, anchorY: anchorYOf(e.currentTarget) }) }}
          onMouseLeave={() => setFolderTip(null)}
          onContextMenu={(e) => {
            e.preventDefault()
            setFolderTip(null)
            const pageRect = page?.getBoundingClientRect()
            setFolderMenu({ folderId: folder.id, x: e.clientX - (pageRect?.left ?? 0), y: e.clientY - (pageRect?.top ?? 0) })
          }}
        >
          <span className="guild-pill" aria-hidden="true" />
          <span className="guild-folder-inner" aria-hidden="true">
            <span className="guild-folder-strip">
              <span className="guild-folder-glyph">
                <svg width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M2 5a3 3 0 0 1 3-3h3.93a2 2 0 0 1 1.66.9L12 5h7a3 3 0 0 1 3 3v11a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V5Z" /></svg>
              </span>
              <span className="guild-folder-preview">
                {folder.guilds.slice(0, 4).map((guild) => <GuildIconBody key={guild.id} guild={guild} className="guild-folder-mini" mini />)}
              </span>
            </span>
          </span>
          {!open && mentions > 0 && <MentionBadge count={mentions} />}
        </button>
        <FolderItems open={open} id={listId} label={label ?? ''}>
          {folder.guilds.map((guild, childIndex) => (
            <li key={guild.id} className="guild-folder-item">
              {renderGuild(guild, { level: 2, folderId: folder.id, last: childIndex === folder.guilds.length - 1, index: childIndex, size: folder.guilds.length })}
            </li>
          ))}
          <li className="guild-folder-end" aria-hidden="true" />
        </FolderItems>
      </div>
    )
  }

  const navClass = ['guilds', editable ? 'reorderable' : '', dragging ? 'reordering' : ''].filter(Boolean).join(' ')
  const tipFolder = folderTip ? folderById.get(folderTip.folderId) : null
  const menuFolder = folderMenu ? folderById.get(folderMenu.folderId) : null
  const settingsFolder = settingsFor !== null ? folderById.get(settingsFor) : null

  return (
    <nav ref={navRef} className={navClass} aria-label="Servers" role="tree" onClickCapture={onRailClickCapture}>
      {entries.map((entry, index) =>
        entry.kind === 'guild'
          ? <div className="guild-item" key={`g:${entry.guild.id}`}>{renderGuild(entry.guild, { level: 1, index, size: entries.length })}</div>
          : renderFolder(entry.folder, index, entries.length),
      )}
      {!entries.length && fallback}
      {visual.bar !== null && <span className="guild-drop-indicator" aria-hidden="true" style={{ top: visual.bar }} />}
      {visual.dot !== null && <span className="guild-drop-dot" aria-hidden="true" style={{ top: visual.dot }} />}
      <div ref={ghostRef} className="guild guild-ghost" aria-hidden="true" hidden />
      {page && tipFolder && createPortal(<FolderTooltip label={folderLabel(tipFolder)} anchorY={folderTip!.anchorY} />, page)}
      {page && menuFolder && createPortal(
        <ContextMenu x={folderMenu!.x} y={folderMenu!.y} entries={folderMenuEntries(menuFolder)} onClose={() => setFolderMenu(null)} ariaLabel="Folder Actions" />,
        page,
      )}
      {page && settingsFolder && createPortal(
        <FolderSettingsModal
          name={settingsFolder.name}
          color={settingsFolder.color}
          placeholder={defaultFolderName(settingsFolder.guilds.map((guild) => guild.name))}
          onSave={(patch) => onLayoutChange(updateFolder(layout, settingsFolder.id, patch))}
          onClose={() => setSettingsFor(null)}
        />,
        page,
      )}
    </nav>
  )
}
