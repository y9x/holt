// Discord's Select, shared by every dropdown in the chat UI.
//
// A port of the mana Select (web.js 691885 + its field 601973, listbox
// 649998, option content 44482, floating hook 641668 → 561392):
//
//   - Placement: floating-ui `placement: "bottom"`, `offset(4)`, flip()
//     (opens ABOVE only when it doesn't fit below), shift() into the
//     viewport, and size() → the dropdown's width = the field's width. Here
//     that is popout.tsx (position bottom, align left, spacing 4, autoInvert,
//     matchWidth) rendered into the window-level select layer (overlay.tsx
//     selectLayer()), so it stacks above modals and escapes their overflow.
//   - Field (selectField__0edde inside the input wrapper__72c38): input
//     background, 1px input border, radius-sm, 40px tall; open (isFocused)
//     or focus-within → 2px brand outline; the chevron (20px, refresh_sm)
//     flips with rotateX(180deg) while open.
//   - Dropdown (selectDropdown__0edde): surface-higher, 1px border-subtle,
//     radius-sm, `0 2px 8px 0 black/16` shadow; enter = opacity .5 + scaleY
//     .96 → 1 over 100ms. Listbox (listBox__2e223): 4px padding, rows of
//     --select-option-height (40px; 44 with a description), at most
//     `maxOptionsVisible` (5) rows tall, then it scrolls.
//   - Options (listBoxItem__2e223): radius-xs, text-strong, the active row
//     (hover / keyboard) gets background-mod-normal; the trailing
//     selectedIcon is a checkmark (single) or a checkbox (multiple).
//   - Keyboard (the select's onKeyDown): ArrowDown/ArrowUp/Enter/Space open;
//     while open ArrowUp/Down (PageUp/Down ±10) move the active row, Home/End
//     jump, Enter/Space choose, Alt+ArrowUp chooses + closes, Tab chooses the
//     active row (single) and closes, Escape closes; printable keys typeahead
//     (750ms buffer). Focus stays on the field (aria-activedescendant).
//   - Closes on outside press and on blur; single-select closes on choose.

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { usePopoutPosition } from './popout'
import { HolyText } from '../../components/common/HolyText'
import { selectLayer } from './overlay'
import './discord-select.css'

/** Discord's --select-option-height. */
export const SELECT_OPTION_HEIGHT = 40
/** Row height with a description line (OPTION_HEIGHT + 4). */
const SELECT_OPTION_HEIGHT_DESC = SELECT_OPTION_HEIGHT + 4
/** floating-ui offset() in Discord's select hook. */
export const SELECT_POPOUT_SPACING = 4

// --- Icons (Discord mana icon paths) -----------------------------------------

/** ChevronSmallDownIcon (715482), refresh_sm = 20px. */
export function SelectChevronIcon({ size = 20 }: { size?: number }) {
  return (
    <svg aria-hidden="true" role="img" width={size} height={size} fill="none" viewBox="0 0 24 24">
      <path fill="currentColor" d="M3.3 8.3a1 1 0 0 1 1.4 0l7.3 7.29 7.3-7.3a1 1 0 1 1 1.4 1.42l-8 8a1 1 0 0 1-1.4 0l-8-8a1 1 0 0 1 0-1.42Z" />
    </svg>
  )
}

/** CheckmarkSmallBoldIcon (820081) - the single-select selectedIcon. */
function SelectCheckIcon({ size = 20 }: { size?: number }) {
  return (
    <svg aria-hidden="true" role="img" width={size} height={size} fill="none" viewBox="0 0 24 24">
      <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d="M19.06 6.94a1.5 1.5 0 0 1 0 2.12l-8 8a1.5 1.5 0 0 1-2.12 0l-4-4a1.5 1.5 0 0 1 2.12-2.12L10 13.88l6.94-6.94a1.5 1.5 0 0 1 2.12 0Z" />
    </svg>
  )
}

// --- Anchored popout ---------------------------------------------------------

/** Was this event dispatched inside `el` (path-based, survives re-renders)? */
function eventWithin(e: Event, el: Element | null | undefined): boolean {
  if (!el) return false
  return e.composedPath().includes(el)
}

export interface SelectPopoutProps {
  /** The field the popout hangs off. */
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onRequestClose: () => void
  /** Width = the field's width (Discord's size() middleware). */
  matchWidth?: boolean
  className?: string
  children: ReactNode
  id?: string
  role?: string
}

/**
 * A field-anchored popout in the select layer: below the field (spacing 4,
 * left-aligned), flipped above only when it doesn't fit, nudged into the
 * viewport, following the field every frame. Outside presses (anywhere but
 * the field and the popout) and Escape close it; Escape is consumed at the
 * window so the surrounding modal stays open (Discord stops propagation).
 */
export function SelectPopout({ anchor, open, onRequestClose, matchWidth = true, className = '', children, id, role }: SelectPopoutProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  usePopoutPosition(ref, () => anchor.current, {
    position: 'bottom',
    align: 'left',
    spacing: SELECT_POPOUT_SPACING,
    autoInvert: true,
    matchWidth,
    enabled: open,
  })
  const closeRef = useRef(onRequestClose)
  useLayoutEffect(() => { closeRef.current = onRequestClose })
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (eventWithin(e, ref.current) || eventWithin(e, anchor.current)) return
      closeRef.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      closeRef.current()
    }
    document.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, anchor])
  if (!open) return null
  return createPortal(
    <div
      ref={ref}
      id={id}
      role={role}
      className={`dcSelectDropdown ${className}`.trim()}
      // Presses inside keep focus on the field (Discord's virtual focus).
      onMouseDown={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    selectLayer(),
  )
}

// --- Listbox -----------------------------------------------------------------

export interface SelectOption<V> {
  value: V
  label: ReactNode
  /** Plain text for typeahead / the default value rendering. */
  textValue?: string
  key?: string
  leading?: ReactNode
  trailing?: ReactNode
  description?: ReactNode
  disabled?: boolean
}

function optionKey<V>(o: SelectOption<V>): string {
  return o.key ?? String(o.value)
}

const textOf = <V,>(o: SelectOption<V>) => (o.textValue ?? (typeof o.label === 'string' ? o.label : String(o.value))).toLowerCase()

/** The listbox body (listBox__2e223 + listBoxItem rows). */
export function SelectListBox<V>({ id, options, isSelected, activeIndex, multiple, maxVisibleItems = 5, optionClassName = '', onHover, onPick, ariaLabel }: {
  id: string
  options: SelectOption<V>[]
  isSelected: (v: V) => boolean
  activeIndex: number | null
  multiple?: boolean
  maxVisibleItems?: number
  optionClassName?: string
  onHover: (index: number) => void
  onPick: (index: number) => void
  ariaLabel?: string
}) {
  const listRef = useRef<HTMLDivElement>(null)
  // Keep the active row in view (keyboard navigation / initial selection).
  useLayoutEffect(() => {
    if (activeIndex == null) return
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
    const list = listRef.current
    if (!row || !list) return
    const top = row.offsetTop - 4
    const bottom = row.offsetTop + row.offsetHeight + 4
    if (top < list.scrollTop) list.scrollTop = top
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
  }, [activeIndex])
  const visible = options.slice(0, maxVisibleItems)
  const height = visible.reduce((h, o) => h + (o.description ? SELECT_OPTION_HEIGHT_DESC : SELECT_OPTION_HEIGHT), 0)
  const scrollable = options.length > maxVisibleItems
  return (
    <div
      ref={listRef}
      id={id}
      role="listbox"
      tabIndex={-1}
      aria-label={ariaLabel}
      aria-multiselectable={multiple || undefined}
      className={`dcListBox${scrollable ? ' scrollable' : ''}`}
      // listBox padding (4 + 4) + the visible rows.
      style={{ maxHeight: height + 8 }}
    >
      {options.length === 0 && <div className="dcListBoxEmpty"><HolyText text="No results found" /></div>}
      {options.map((o, i) => {
        const selected = isSelected(o.value)
        return (
          <div
            key={optionKey(o)}
            id={`${id}-option-${i}`}
            data-index={i}
            role="option"
            aria-selected={selected}
            aria-disabled={o.disabled || undefined}
            data-active={i === activeIndex || undefined}
            className={`dcListBoxItem${optionClassName ? ` ${optionClassName}` : ''}`}
            onMouseMove={() => { if (i !== activeIndex) onHover(i) }}
            onClick={() => { if (!o.disabled) onPick(i) }}
          >
            <div className="dcListBoxItemContent" data-has-description={o.description ? true : undefined}>
              {o.leading != null && <span className="dcListBoxItemLeading">{o.leading}</span>}
              <span className="dcListBoxItemText">
                <span className="dcListBoxItemLabel">{o.label}</span>
                {o.description && <span className="dcListBoxItemDescription">{o.description}</span>}
              </span>
              {o.trailing != null && <span className="dcListBoxItemTrailing">{o.trailing}</span>}
            </div>
            <div className="dcListBoxSelectedIcon" aria-hidden="true">
              {multiple
                ? <span className={`dcListBoxCheckbox${selected ? ' checked' : ''}`}>{selected && <SelectCheckIcon size={16} />}</span>
                : selected ? <SelectCheckIcon /> : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Shared keyboard model for a listbox driven from a focused field. */
export function useListNavigation<V>(options: SelectOption<V>[], open: boolean) {
  const [activeIndex, setActive] = useState<number | null>(null)
  const typeahead = useRef({ text: '', timer: 0 })
  // No active row while closed; openers set it when they open.
  const active = open ? activeIndex : null
  const clamp = useCallback((i: number) => Math.max(0, Math.min(i, options.length - 1)), [options.length])
  const move = useCallback((delta: number) => {
    setActive((a) => (options.length === 0 ? null : a == null ? 0 : clamp(a + delta)))
  }, [options.length, clamp])
  const typeKey = useCallback((key: string): number | null => {
    const t = typeahead.current
    window.clearTimeout(t.timer)
    t.text += key.toLowerCase()
    t.timer = window.setTimeout(() => { t.text = '' }, 750)
    const i = options.findIndex((o) => !o.disabled && textOf(o).startsWith(t.text))
    if (i >= 0) setActive(i)
    return i >= 0 ? i : null
  }, [options])
  return { active, setActive, move, typeKey }
}

// --- Select ------------------------------------------------------------------

export interface DiscordSelectProps<V> {
  options: SelectOption<V>[]
  /** Currently selected values. */
  selected: V[]
  /** Choose / toggle an option: `next` is its new selected state. */
  onSelect: (value: V, next: boolean) => void
  multiple?: boolean
  /** Default: single → true, multiple → false. */
  closeOnSelect?: boolean
  placeholder?: ReactNode
  /** Field content for the selected options (default: leading + labels). */
  renderValue?: (selected: SelectOption<V>[]) => ReactNode
  maxVisibleItems?: number
  disabled?: boolean
  id?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  /** Extra classes: wrapper, field, value area, each option, dropdown. */
  className?: string
  fieldClassName?: string
  valueClassName?: string
  optionClassName?: string
  popoutClassName?: string
}

export function DiscordSelect<V>({
  options,
  selected,
  onSelect,
  multiple = false,
  closeOnSelect,
  placeholder = 'Select…',
  renderValue,
  maxVisibleItems = 5,
  disabled = false,
  id,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  className = '',
  fieldClassName = '',
  valueClassName = '',
  optionClassName = '',
  popoutClassName = '',
}: DiscordSelectProps<V>) {
  const [openState, setOpen] = useState(false)
  // A disabled select is always closed (Discord closes it on disable).
  const open = openState && !disabled
  const fieldRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const isSelected = useCallback((v: V) => selected.some((s) => Object.is(s, v)), [selected])
  const { active, setActive, move, typeKey } = useListNavigation(options, open)
  const shutOnPick = closeOnSelect ?? !multiple

  const openList = useCallback((at?: number) => {
    if (disabled) return
    setOpen(true)
    if (at != null) { setActive(at); return }
    // Discord: start on the last selected option, else the first.
    let last = -1
    options.forEach((o, i) => { if (isSelected(o.value)) last = i })
    setActive(options.length ? Math.max(last, 0) : null)
  }, [disabled, options, isSelected, setActive])

  const close = useCallback((refocus = false) => {
    setOpen(false)
    if (refocus) fieldRef.current?.focus()
  }, [])

  const pick = useCallback((i: number) => {
    const o = options[i]
    if (!o || o.disabled || disabled) return
    onSelect(o.value, multiple ? !isSelected(o.value) : true)
    if (shutOnPick) close(true)
  }, [options, disabled, onSelect, multiple, isSelected, shutOnPick, close])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    const n = options.length
    switch (e.key) {
      case 'ArrowDown':
      case 'PageDown':
        e.preventDefault()
        if (!open || e.altKey) { if (!open) openList(); return }
        move(e.key === 'PageDown' ? 10 : 1)
        return
      case 'ArrowUp':
      case 'PageUp':
        e.preventDefault()
        if (!open) { openList(); return }
        if (e.altKey) { if (active != null) pick(active); close(true); return }
        move(e.key === 'PageUp' ? -10 : -1)
        return
      case 'Home':
      case 'End':
        e.preventDefault()
        if (!n) return
        if (!open) openList(e.key === 'Home' ? 0 : n - 1)
        else setActive(e.key === 'Home' ? 0 : n - 1)
        return
      case 'Enter':
      case ' ':
        e.preventDefault()
        e.stopPropagation()
        if (!open) { openList(); return }
        if (active != null) pick(active)
        return
      case 'Tab':
        if (open) {
          if (!multiple && active != null && !isSelected(options[active]?.value as V)) pick(active)
          setOpen(false)
        }
        return
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const i = typeKey(e.key)
          if (i != null && !open) openList(i)
        }
    }
  }

  const chosen = options.filter((o) => isSelected(o.value))
  const activeId = open && active != null ? `${listId}-option-${active}` : undefined
  return (
    <div className={`dcSelect${open ? ' isOpen' : ''}${className ? ` ${className}` : ''}`}>
      <div
        ref={fieldRef}
        id={id}
        role="combobox"
        tabIndex={disabled ? -1 : 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={activeId}
        aria-disabled={disabled || undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        data-mana-component="select"
        className={`dcSelectField${open ? ' isOpen' : ''}${disabled ? ' isDisabled' : ''}${fieldClassName ? ` ${fieldClassName}` : ''}`}
        onClick={() => { if (disabled) return; if (open) close(); else openList() }}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          // Discord closes on blur unless focus moved into the dropdown.
          const to = e.relatedTarget as Node | null
          if (open && !(to && document.getElementById(listId)?.contains(to))) setOpen(false)
        }}
      >
        <div className={`dcSelectValue${valueClassName ? ` ${valueClassName}` : ''}`}>
          {chosen.length === 0
            ? <span className="dcSelectPlaceholder">{placeholder}</span>
            : renderValue
              ? renderValue(chosen)
              : (
                <span className="dcSelectSingleValue">
                  {chosen.length === 1 && chosen[0].leading != null && <span className="dcListBoxItemLeading">{chosen[0].leading}</span>}
                  <span className="dcSelectValueText">{chosen.map((o, i) => <span key={optionKey(o)}>{i > 0 ? ', ' : ''}{o.label}</span>)}</span>
                </span>
              )}
        </div>
        <span className="dcSelectChevron" aria-hidden="true">
          <span className={`dcSelectChevronIcon${open ? ' isOpen' : ''}`}><SelectChevronIcon /></span>
        </span>
      </div>
      <SelectPopout anchor={fieldRef} open={open} onRequestClose={() => close()} className={popoutClassName}>
        <SelectListBox
          id={listId}
          options={options}
          isSelected={isSelected}
          activeIndex={active}
          multiple={multiple}
          maxVisibleItems={maxVisibleItems}
          optionClassName={optionClassName}
          onHover={setActive}
          onPick={pick}
          ariaLabel={ariaLabel}
        />
      </SelectPopout>
    </div>
  )
}
