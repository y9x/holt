import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { usePopoutPosition, type PopoutAnchor, type PopoutOptions } from './popout'
import { HolyText } from '../../components/common/HolyText'

/* Obfuscate a menu label/subtext when it is a plain string (the common case -
 * most call sites pass string literals). ReactNode labels (icons, <strong>,
 * interpolated spans) pass through untouched and in position. The raw string
 * value on MenuItem.label is unchanged, so the submenu-parent aria-label
 * (`typeof parent.label === 'string'`) still resolves. The host .contextMenu*
 * span keeps its ellipsis/flex styling; the string lands in a per-run closed
 * shadow root (same nested pattern wave 1 used inside ellipsis containers). */
function holyLabel(node: ReactNode): ReactNode {
  return typeof node === 'string' ? <HolyText text={node} /> : node
}

/* Discord's right-click context menu - a floating dark card of grouped items
 * separated by thin rules, some with right-side chevrons/checkboxes. Structure
 * and metrics ripped from the live "Server Actions" menu:
 *   container: bg surface, 8px radius, 1px border, 12/24 shadow, min-width 188
 *   item:      32px row, 4px/8px padding, 14px/500 label
 *
 * Behavior mirrors Discord's Menu components (web bundle, module 980707):
 *   - MenuItem: a click runs `action` and closes the whole menu, unless the
 *     item sets dontCloseOnAction (`keepOpen`) or dontCloseOnActionIfHolding-
 *     ShiftKey (`keepOpenOnShift`) and Shift is held. An item with no action
 *     does nothing on click (submenu parents just open their submenu).
 *   - MenuCheckboxItem / MenuRadioItem: a click toggles and the menu STAYS
 *     open (their handlers never call onClose) - `affordance: 'check'|'radio'`.
 *   - Submenus (MenuItem with children): a hover-triggered Popout with a
 *     100ms open delay (hoverDelay=100, close delay 0 behind a safe polygon),
 *     also opened by click / Enter / ArrowRight and closed by ArrowLeft.
 *   - Separators, group labels and disabled items are inert.
 * Icons: Discord's default menu renders an item's `icon` prop in a 20px
 * iconContainer at the RIGHT end of the row (label, shortcut, icon, caret).
 * `leadingAccessory` (left icons) only renders behind the unshipped
 * "2025-11-mana-context-menu" experiment (default off), so items that pass
 * ONLY a leadingAccessory (Add Reaction, Copy Image, Open Link, …) show no
 * icon. `icon` here is that right-side slot. */

export interface MenuSelectEvent {
  shiftKey: boolean
}

export interface MenuItem {
  /** Unique key. */
  key: string
  label: ReactNode
  /** Item icon - Discord's MenuItem `icon` prop, drawn in the 20px slot at
      the RIGHT end of the row. Omit where Discord passes none. */
  icon?: ReactNode
  /** Left icon - Discord's `iconLeft` (e.g. the settings-gear menu's section
      items). Most menu items use the right-side `icon` slot instead. */
  iconLeft?: ReactNode
  /** Non-interactive group heading (Discord MenuGroup `label`). */
  groupLabel?: boolean
  /** Muted second line under the label (Discord's subtext, text-xs). */
  subtext?: ReactNode
  /** Right-side shortcut text (Discord's shortcutContainer, e.g. "Ctrl+C"). */
  hint?: ReactNode
  /** Right-side affordance: chevron for submenus, checkbox / radio for toggles. */
  affordance?: 'chevron' | 'check' | 'radio' | null
  checked?: boolean
  /** Radio items sharing a group are mutually exclusive (local optimistic state). */
  group?: string
  disabled?: boolean
  danger?: boolean
  /** Discord's dontCloseOnAction. Defaults to true for check/radio items. */
  keepOpen?: boolean
  /** Discord's dontCloseOnActionIfHoldingShiftKey. */
  keepOpenOnShift?: boolean
  /** Nested submenu entries (Discord MenuItem `children`). */
  submenu?: MenuEntry[]
  onSelect?: (e: MenuSelectEvent) => void
}

export type MenuEntry = MenuItem | 'separator'

export interface ContextMenuProps {
  x: number
  y: number
  entries: MenuEntry[]
  onClose: () => void
  ariaLabel?: string
  /** Extra class on the positioned layer (e.g. 'msgContextMenu' for the
      message action menu's entrance animation; the guild menu omits it). */
  layerClassName?: string
  /** Button-triggered menus: anchor to the trigger element instead of the
      x/y point (Discord Popout placement, flips + follows the trigger). */
  anchor?: PopoutAnchor | (() => PopoutAnchor)
  anchorOptions?: PopoutOptions
}

/** Discord's submenu hover delay (Popout hoverDelay default = 100ms). */
const SUBMENU_HOVER_DELAY = 100

/** True when the event's dispatch path passed through `el`. Uses the path
    captured at dispatch time, so a target that React unmounted while the
    event was in flight (a toggled button, a tab swap) still counts as
    "inside" - `el.contains(e.target)` would wrongly report it as outside. */
export function eventWithin(e: Event, el: Element | null | undefined): boolean {
  if (!el) return false
  const path = typeof e.composedPath === 'function' ? e.composedPath() : []
  if (path.length) return path.includes(el)
  return e.target instanceof Node && el.contains(e.target)
}

/** True when the event's dispatch path includes an element matching `selector`. */
export function eventWithinSelector(e: Event, selector: string): boolean {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : []
  if (path.length) return path.some((n) => n instanceof Element && n.matches(selector))
  return e.target instanceof Element && Boolean(e.target.closest(selector))
}

export function ContextMenu({ x, y, entries, onClose, ariaLabel = 'Actions', layerClassName, anchor, anchorOptions }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  // Last user scroll input (wheel/touch/scroll key) - survives the listener
  // effect re-subscribing when onClose changes identity.
  const lastScrollIntentRef = useRef(0)
  const [pos, setPos] = useState({ left: x, top: y })
  // Element that had focus when the menu opened (usually the trigger); focus
  // is returned to it when the menu closes, matching Discord's behavior.
  const restoreRef = useRef<HTMLElement | null>(null)

  // Anchored (button-triggered) menus track their trigger; cursor menus
  // clamp their x/y point inside the chat page below.
  const anchored = anchor != null
  const anchorRef = useRef(anchor)
  anchorRef.current = anchor
  usePopoutPosition(ref, anchor, { ...(anchorOptions ?? { position: 'bottom' }), enabled: anchored })

  // Clamp inside the chat page.
  useLayoutEffect(() => {
    if (anchored) return
    const el = ref.current
    const page = document.querySelector('.chat-page')
    if (!el || !page) return
    const pageRect = page.getBoundingClientRect()
    const w = el.offsetWidth
    const h = el.offsetHeight
    setPos({
      left: Math.max(8, Math.min(x, pageRect.width - w - 8)),
      top: Math.max(8, Math.min(y, pageRect.height - h - 8)),
    })
  }, [x, y, anchored])

  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => { restoreRef.current?.focus?.() }
  }, [])

  useEffect(() => {
    // Outside press closes the menu. Presses anywhere inside the layer -
    // including open submenus, which render inside it - never do.
    const onDoc = (e: MouseEvent) => {
      if (!eventWithin(e, ref.current)) onClose()
    }
    // Escape closes ONLY the menu: listen on window in the capture phase and
    // stop the event, so document-level Escape handlers underneath (settings
    // modal, header popovers) don't also close the surface the menu came from.
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    // Any scroll OUTSIDE the menu (message list, sidebar, page) closes it -
    // the layer is absolutely positioned inside .chat-page, so a scrolled
    // anchor would leave the menu floating over stale content.
    // An anchored (button-triggered) menu follows its trigger, so only a
    // scroll of a container holding the trigger (it scrolled away) closes it;
    // unrelated scrolls (e.g. the message list re-settling on a window
    // resize) leave it open.
    // Only a scroll the USER caused closes the menu. Layout-driven scrolls
    // (a sidebar re-render after a checkbox toggle shrinking the list and
    // clamping its scrollTop, the message list re-pinning) also fire scroll
    // events; Discord keeps checkbox menus open through those. A user scroll
    // is one preceded by scroll input (wheel / touch / scroll keys) outside
    // the menu within the last second (covers smooth-scroll tails).
    const SCROLL_INTENT_MS = 1000
    const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])
    const onScrollIntent = (e: Event) => {
      if (eventWithin(e, ref.current)) return
      if (e instanceof globalThis.KeyboardEvent && !SCROLL_KEYS.has(e.key)) return
      lastScrollIntentRef.current = performance.now()
    }
    const onScroll = (e: Event) => {
      if (eventWithin(e, ref.current)) return
      if (performance.now() - lastScrollIntentRef.current > SCROLL_INTENT_MS) return
      const a = anchorRef.current
      const el = typeof a === 'function' ? a() : a
      if (el instanceof Element && e.target instanceof Node && !e.target.contains(el)) return
      onClose()
    }
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('scroll', onScroll, true)
    const intentOpts = { capture: true, passive: true } as const
    document.addEventListener('wheel', onScrollIntent, intentOpts)
    document.addEventListener('touchmove', onScrollIntent, intentOpts)
    document.addEventListener('keydown', onScrollIntent, true)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('wheel', onScrollIntent, intentOpts)
      document.removeEventListener('touchmove', onScrollIntent, intentOpts)
      document.removeEventListener('keydown', onScrollIntent, true)
    }
  }, [onClose])

  // Nothing applicable (e.g. a read-only field with no selection): no menu.
  if (normalizeEntries(entries).length === 0) return null

  return (
    <div className={`contextMenuLayer${layerClassName ? ` ${layerClassName}` : ''}`} style={anchored ? undefined : pos} ref={ref} role="menu" aria-label={ariaLabel} onContextMenu={(e) => e.preventDefault()}>
      <MenuPanel entries={entries} closeAll={onClose} autoFocus />
    </div>
  )
}

interface MenuPanelProps {
  entries: MenuEntry[]
  closeAll: () => void
  /** Focus the first enabled item when mounted / when this flips to true. */
  autoFocus: boolean
  ariaLabel?: string
  /** Submenu only: close this submenu and give focus back to its parent row. */
  onBack?: () => void
  /** Submenu only: the parent row the panel is anchored to. */
  anchor?: HTMLElement | null
  onPointerInside?: () => void
}

/** Discord renders a separator only BETWEEN non-empty groups: drop leading,
    trailing and doubled separators left behind by conditional items. */
function normalizeEntries(raw: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = []
  for (const entry of raw) {
    if (entry === 'separator' && (out.length === 0 || out[out.length - 1] === 'separator')) continue
    out.push(entry)
  }
  while (out.length && out[out.length - 1] === 'separator') out.pop()
  return out
}

function MenuPanel({ entries: rawEntries, closeAll, autoFocus, ariaLabel, onBack, anchor, onPointerInside }: MenuPanelProps) {
  const entries = normalizeEntries(rawEntries)
  const panelRef = useRef<HTMLDivElement>(null)
  // Roving focus index into the ENABLED menu items (separators and disabled
  // items are skipped). -1 = no roving target yet.
  const [focusIdx, setFocusIdx] = useState(-1)
  // Open submenu: the parent row's key + whether keyboard focus moves into it.
  const [openSub, setOpenSub] = useState<{ key: string; focus: boolean } | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Optimistic toggle state for check/radio rows: entries are often a
  // snapshot taken at open time, so the row must flip locally while the menu
  // stays open. An override applies only while the prop still holds the value
  // it was flipped FROM (a fresh prop wins once the parent re-renders).
  const [checkOverrides, setCheckOverrides] = useState<Record<string, { from: boolean; to: boolean }>>({})
  const [radioOverrides, setRadioOverrides] = useState<Record<string, { from: string | null; to: string }>>({})
  const [subPos, setSubPos] = useState<{ left: number; top: number } | null>(null)

  const enabledIdxs = entries
    .map((entry, i) => (entry !== 'separator' && !entry.disabled && !entry.groupLabel ? i : -1))
    .filter((i) => i >= 0)

  // Ordinal of each entry among the rendered row buttons (separators are not
  // buttons, so DOM order differs from `entries` order once one exists).
  const buttonOrdinals: number[] = []
  {
    let b = 0
    for (const entry of entries) buttonOrdinals.push(entry === 'separator' || entry.groupLabel ? -1 : b++)
  }

  const rowButton = useCallback((entryIdx: number) => {
    const ordinal = buttonOrdinals[entryIdx]
    if (ordinal == null || ordinal < 0) return null
    return panelRef.current?.querySelectorAll<HTMLButtonElement>(':scope > .contextMenuItem')[ordinal] ?? null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries])

  // Keyboard focus into the panel (root on open; submenu when opened by
  // keyboard / click). Focus the first enabled row directly so it lands even
  // when the roving index is already 0.
  // Root menu: Discord focuses the menu CONTAINER (focus path empty), so no
  // row is highlighted until the pointer or an arrow key picks one. A
  // submenu entered by keyboard (ArrowRight / Enter) focuses its first row.
  useEffect(() => {
    if (!autoFocus) return
    if (!anchor) {
      panelRef.current?.focus({ preventScroll: true })
      return
    }
    setFocusIdx(0)
    const first = enabledIdxs[0]
    if (first != null) rowButton(first)?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus])

  // Keep DOM focus in sync with the roving index.
  useEffect(() => {
    if (focusIdx < 0) return
    const entryIdx = enabledIdxs[focusIdx]
    if (entryIdx == null) return
    rowButton(entryIdx)?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusIdx])

  useEffect(() => () => clearTimeout(hoverTimer.current), [])

  // Submenu panels: position beside the anchor row (Discord: placement
  // right-start, 12px gap, first row aligned with the anchor row), flipping to
  // the left / shifting up when the chat page would clip it.
  useLayoutEffect(() => {
    if (!anchor) return
    const el = panelRef.current
    const parentPanel = anchor.parentElement
    const page = document.querySelector('.chat-page')
    if (!el || !parentPanel) return
    const parentRect = parentPanel.getBoundingClientRect()
    const anchorRect = anchor.getBoundingClientRect()
    // Bounds = the chat page clipped to the viewport, so a submenu flips at
    // the window edge even when the page extends past it.
    const pr = page?.getBoundingClientRect()
    const vw = document.documentElement.clientWidth || window.innerWidth
    const pageRect = {
      left: Math.max(0, pr?.left ?? 0),
      top: Math.max(0, pr?.top ?? 0),
      right: Math.min(vw, pr?.right ?? vw),
      bottom: Math.min(window.innerHeight, pr?.bottom ?? window.innerHeight),
    }
    const w = el.offsetWidth
    const h = el.offsetHeight
    // Discord: Popout spacing 4px + submenuPaddingContainer's 8px inline
    // padding → a 12px visual gap between the menu and its submenu.
    const gap = 12
    // Offsets are relative to the parent panel's padding box (it is the
    // containing block: position:relative, 1px border, 8px padding).
    const border = parentPanel.clientLeft || 0
    let left = parentRect.width - border + gap
    // autoInvert (Discord): flip to the left side when the right doesn't fit
    // and the left fits better.
    const fitRight = pageRect.right - 8 - (parentRect.right + gap + w)
    const fitLeft = parentRect.left - gap - w - (pageRect.left + 8)
    if (fitRight < 0 && fitLeft > fitRight) left = -w - gap - border
    // Align the submenu's first row with the anchor row (border + 8px padding).
    let top = anchorRect.top - parentRect.top - border - 9
    const absTop = parentRect.top + border + top
    if (absTop + h > pageRect.bottom - 8) top -= absTop + h - (pageRect.bottom - 8)
    if (parentRect.top + border + top < pageRect.top + 8) top = pageRect.top + 8 - parentRect.top - border
    setSubPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }))
  })

  const isChecked = (item: MenuItem): boolean => {
    if (item.affordance === 'radio' && item.group) {
      const ov = radioOverrides[item.group]
      if (ov) {
        const propSel = entries.find((en): en is MenuItem => en !== 'separator' && en.group === item.group && Boolean(en.checked))?.key ?? null
        if (propSel === ov.from) return item.key === ov.to
      }
      return Boolean(item.checked)
    }
    const ov = checkOverrides[item.key]
    if (ov && Boolean(item.checked) === ov.from) return ov.to
    return Boolean(item.checked)
  }

  const openSubmenu = (key: string, focus: boolean) => {
    clearTimeout(hoverTimer.current)
    setOpenSub((cur) => (cur && cur.key === key && cur.focus === focus ? cur : { key, focus }))
  }

  const closeSubmenu = (refocusKey?: string) => {
    clearTimeout(hoverTimer.current)
    setOpenSub(null)
    if (refocusKey) {
      const idx = entries.findIndex((en) => en !== 'separator' && en.key === refocusKey)
      if (idx >= 0) rowButton(idx)?.focus({ preventScroll: true })
    }
  }

  const activate = (item: MenuItem, e: ReactMouseEvent<HTMLButtonElement>) => {
    if (item.disabled) return
    if (item.submenu && !item.onSelect) {
      // Submenu parent without an action: open it (keyboard-activated clicks
      // have detail 0 → move focus in). Never closes the menu.
      openSubmenu(item.key, e.detail === 0)
      return
    }
    if (!item.onSelect) return
    const toggle = item.affordance === 'check' || item.affordance === 'radio'
    const stay = (item.keepOpen ?? toggle) || (e.shiftKey && Boolean(item.keepOpenOnShift))
    if (stay && item.affordance === 'check') {
      const current = isChecked(item)
      setCheckOverrides((o) => ({ ...o, [item.key]: { from: Boolean(item.checked), to: !current } }))
    } else if (stay && item.affordance === 'radio' && item.group) {
      const group = item.group
      const propSel = entries.find((en): en is MenuItem => en !== 'separator' && en.group === group && Boolean(en.checked))?.key ?? null
      setRadioOverrides((o) => ({ ...o, [group]: { from: propSel, to: item.key } }))
    }
    // Discord closes first, then runs the action (so an action that opens a
    // new surface - another menu, a modal - isn't torn down by the close).
    if (!stay) closeAll()
    item.onSelect({ shiftKey: e.shiftKey })
  }

  // Arrow-key navigation between enabled items (roving, wraps around);
  // Home/End jump to first/last; ArrowRight opens a submenu, ArrowLeft backs
  // out of one. Enter/Space activate the focused <button> natively.
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const n = enabledIdxs.length
    if (n === 0) return
    let next: number | null = null
    if (e.key === 'ArrowDown') next = focusIdx < 0 ? 0 : (focusIdx + 1) % n
    else if (e.key === 'ArrowUp') next = focusIdx < 0 ? n - 1 : (focusIdx - 1 + n) % n
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = n - 1
    else if (e.key === 'ArrowRight') {
      const entry = entries[enabledIdxs[focusIdx]]
      if (entry && entry !== 'separator' && entry.submenu) openSubmenu(entry.key, true)
      e.preventDefault()
      e.stopPropagation()
      return
    } else if (e.key === 'ArrowLeft') {
      if (onBack) onBack()
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (next !== null) {
      e.preventDefault()
      e.stopPropagation()
      if (openSub) closeSubmenu()
      setFocusIdx(next)
    }
  }

  return (
    <div
      ref={panelRef}
      className={`contextMenu${anchor ? ' contextSubmenu' : ''}`}
      role={anchor ? 'menu' : undefined}
      aria-label={anchor ? ariaLabel : undefined}
      style={anchor ? { position: 'absolute', visibility: subPos ? undefined : 'hidden', ...(subPos ?? { left: 0, top: 0 }) } : { position: 'relative' }}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onMouseEnter={onPointerInside}
      // Discord clears the focus path when the pointer leaves the menu (no
      // row stays highlighted); an open submenu keeps its parent row lit.
      onMouseLeave={() => {
        if (openSub) return
        setFocusIdx(-1)
        if (panelRef.current?.contains(document.activeElement)) panelRef.current.focus({ preventScroll: true })
      }}
    >
      {entries.map((entry, i) => {
        if (entry === 'separator') return <div key={`sep-${i}`} className="contextMenuSeparator" role="separator" />
        if (entry.groupLabel) return <div key={entry.key} className="contextMenuGroupLabel" role="presentation">{holyLabel(entry.label)}</div>
        const item = entry
        const isRovingTarget = !item.disabled && enabledIdxs[focusIdx] === i
        const subOpen = openSub?.key === item.key && Boolean(item.submenu)
        const checked = isChecked(item)
        const role = item.affordance === 'check' ? 'menuitemcheckbox' : item.affordance === 'radio' ? 'menuitemradio' : 'menuitem'
        return (
          <button
            key={item.key}
            type="button"
            role={role}
            aria-checked={item.affordance === 'check' || item.affordance === 'radio' ? checked : undefined}
            aria-haspopup={item.submenu ? 'menu' : undefined}
            aria-expanded={item.submenu ? subOpen : undefined}
            className={`contextMenuItem ${item.danger ? 'danger' : ''}${isRovingTarget || subOpen ? ' focused' : ''}`}
            disabled={item.disabled}
            tabIndex={isRovingTarget ? 0 : -1}
            onClick={(e) => activate(item, e)}
            onMouseEnter={() => {
              if (item.disabled) return
              // Mouse hover takes over the roving target so the hover skin and
              // any subsequent arrow-key press start from this item.
              const idx = enabledIdxs.indexOf(i)
              if (idx >= 0 && idx !== focusIdx) setFocusIdx(idx)
              clearTimeout(hoverTimer.current)
              if (item.submenu) {
                if (openSub?.key !== item.key) hoverTimer.current = setTimeout(() => setOpenSub({ key: item.key, focus: false }), SUBMENU_HOVER_DELAY)
              } else if (openSub) {
                hoverTimer.current = setTimeout(() => closeSubmenu(), SUBMENU_HOVER_DELAY)
              }
            }}
          >
            {item.iconLeft != null && <span className="contextMenuItemIconLeft" aria-hidden="true">{item.iconLeft}</span>}
            {item.subtext != null
              ? <span className="contextMenuLabelStack"><span className="contextMenuLabel">{holyLabel(item.label)}</span><span className="contextMenuSubtext">{holyLabel(item.subtext)}</span></span>
              : <span className="contextMenuLabel">{holyLabel(item.label)}</span>}
            {item.hint != null && <span className="contextMenuHint">{item.hint}</span>}
            {item.icon != null && <span className="contextMenuItemIcon" aria-hidden="true">{item.icon}</span>}
            {(item.affordance === 'chevron' || (item.submenu && item.affordance == null)) && (
              <svg className="contextMenuAffordance" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9.3 5.3a1 1 0 0 0 0 1.4l5.29 5.3-5.3 5.3a1 1 0 1 0 1.42 1.4l6-6a1 1 0 0 0 0-1.4l-6-6a1 1 0 0 0-1.42 0Z"/></svg>
            )}
            {item.affordance === 'check' && (
              <span className={`contextMenuCheckbox${checked ? ' checked' : ''}`} aria-hidden="true">
                {checked && <svg width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M18.7 7.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4l3.3 3.29 7.3-7.3a1 1 0 0 1 1.4 0Z"/></svg>}
              </span>
            )}
            {item.affordance === 'radio' && (
              <svg className={`contextMenuRadio${checked ? ' checked' : ''}`} width="20" height="20" viewBox="0 0 40 40" aria-hidden="true">
                <circle className="contextMenuRadioRing" cx="20" cy="20" r="19" />
                {checked && <circle className="contextMenuRadioDot" cx="20" cy="20" r="8" />}
              </svg>
            )}
          </button>
        )
      })}
      {openSub && (() => {
        const idx = entries.findIndex((en) => en !== 'separator' && en.key === openSub.key)
        const parent = idx >= 0 ? entries[idx] : null
        if (!parent || parent === 'separator' || !parent.submenu) return null
        const parentKey = parent.key
        return (
          <MenuPanel
            key={parentKey}
            entries={parent.submenu}
            closeAll={closeAll}
            autoFocus={openSub.focus}
            ariaLabel={typeof parent.label === 'string' ? parent.label : undefined}
            anchor={rowButton(idx)}
            onBack={() => closeSubmenu(parentKey)}
            onPointerInside={() => clearTimeout(hoverTimer.current)}
          />
        )
      })()}
    </div>
  )
}

/* === Menu glyphs not used elsewhere in the chat ===
 * Ripped from Discord's web bundle (filled, viewBox 0 0 24 24, 18px in the
 * menu's icon slot). Shared glyphs (copy/link/ID/trash/pin…) live in chat.tsx. */

/** Add Reaction submenu "View More" icon - the plain smiley face (module
    460905; the hover toolbar's smiley-PLUS is a different glyph). */
export function MenuReactionIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d="M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22ZM6.5 13a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm11 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm-9.8 1.17a1 1 0 0 1 1.39.27 3.5 3.5 0 0 0 5.82 0 1 1 0 0 1 1.66 1.12 5.5 5.5 0 0 1-9.14 0 1 1 0 0 1 .27-1.4Z" />
    </svg>
  )
}





/** Labels for Discord's native link items (copy-native-link / open-native-link,
    module 777933): Discord-CDN images read "Image Link", other media URLs
    "Media Link", everything else plain "Link". */
export function nativeLinkLabels(url: string): { copy: string; open: string } {
  try {
    const u = new URL(url, window.location.href)
    if (u.hostname === 'cdn.discordapp.com' && /\.(png|jpe?g|webp|avif|bmp|svg)(\?|$)/i.test(u.pathname)) return { copy: 'Copy Image Link', open: 'Open Image Link' }
    if (/\.(png|jpe?g|webp|avif|bmp|svg|gif|mp4|webm|mov)(\?|$)/i.test(u.pathname)) return { copy: 'Copy Media Link', open: 'Open Media Link' }
  } catch { /* not a URL - plain labels */ }
  return { copy: 'Copy Link', open: 'Open Link' }
}

/** Discord's text-menu shortcut hints (textarea-context / copy items):
    "⌘X/⌘C/⌘V" on macOS, "Ctrl+X/C/V" elsewhere. */
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
export const CUT_SHORTCUT = IS_MAC ? '⌘X' : 'Ctrl+X'
export const COPY_SHORTCUT = IS_MAC ? '⌘C' : 'Ctrl+C'
export const PASTE_SHORTCUT = IS_MAC ? '⌘V' : 'Ctrl+V'

/** Modal backdrop dismissal (Discord's modal layer): close only when the
    press BOTH started and ended on the backdrop itself. A plain onClick also
    fires when a drag starts inside the dialog (selecting text in an input,
    dragging a scrollbar) and is released over the backdrop - the click then
    targets their common ancestor, the backdrop - which closed the modal on a
    press that began inside it. */
export function backdropDismissProps(close: () => void) {
  return {
    onMouseDown: (e: ReactMouseEvent<HTMLElement>) => {
      e.currentTarget.dataset.pressStart = e.target === e.currentTarget ? '1' : ''
    },
    onClick: (e: ReactMouseEvent<HTMLElement>) => {
      const started = e.currentTarget.dataset.pressStart === '1'
      e.currentTarget.dataset.pressStart = ''
      if (started && e.target === e.currentTarget) close()
    },
  }
}

/** Settings-gear menu: "Account" iconLeft - Discord's UserIcon (module 950305). */
export function MenuUserIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM11.53 11A9.53 9.53 0 0 0 2 20.53c0 .81.66 1.47 1.47 1.47h.22c.24 0 .44-.17.5-.4.29-1.12.84-2.17 1.32-2.91.14-.21.43-.1.4.15l-.26 2.61c-.02.3.2.55.5.55h11.7a.5.5 0 0 0 .5-.55l-.27-2.6c-.02-.26.27-.37.41-.16.48.74 1.03 1.8 1.32 2.9.06.24.26.41.5.41h.22c.81 0 1.47-.66 1.47-1.47A9.53 9.53 0 0 0 12.47 11h-.94Z" />
    </svg>
  )
}

/** Settings-gear menu: "Appearance" iconLeft - Discord's PaintPaletteIcon (module 650809). */
export function MenuPaintPaletteIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d="M19 16h-5a2 2 0 0 0-2 2v2c0 1.66-1.37 3.04-2.96 2.6A11 11 0 1 1 23 12c0 2.2-2 4-4 4ZM13.5 4.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM17.25 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm-9-1.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm-3.75 7a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
    </svg>
  )
}
