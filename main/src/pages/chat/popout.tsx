// Shared anchored-popout positioning - a port of Discord's Popout /
// ReferencePositionLayer placement (web.js module 623646 + the Popout class):
//
//   - `position` picks the side of the target the popout sits on; `align` the
//     cross-axis edge it lines up with. Popout defaults: position "right",
//     align derived from the position (top/bottom → "left", left/right →
//     "top"), spacing 8, autoInvert true, nudgeAlignIntoViewport true.
//   - calculatePositionStyle: bottom → top = target.bottom + spacing; top →
//     bottom edge = target.top - spacing; right → left = target.right +
//     spacing; left → right edge = target.left - spacing.
//   - autoInvert: when the popout doesn't fit on its side (fit < 0), the
//     opposite side is tried and whichever fits better wins; if a top/bottom
//     popout still overflows by less than its height it is pulled back in.
//   - nudge*Alignment: the cross axis is clamped into the layer with a 12px
//     viewport padding.
//   - The layer re-measures on window resize, on its own ResizeObserver, and
//     whenever the target rect changes (componentDidUpdate compares rects).
//     Here a rAF loop compares the target rect every frame while the popout
//     is open, so it follows the trigger through scrolls, sidebar drags and
//     any other layout shift.
//
// Popouts are portaled into the chat page's popout layer (overlay.tsx
// popoutLayer()) so an ancestor's overflow clip, inline-size container or
// backdrop-filter (all of which trap position:fixed / clip absolute boxes)
// can't misplace them.

import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { popoutLayer } from './overlay'

export type PopoutPosition = 'top' | 'bottom' | 'left' | 'right'
export type PopoutAlign = 'left' | 'right' | 'top' | 'bottom' | 'center'

/** Discord's nudge*Alignment viewport padding. */
export const POPOUT_VIEWPORT_PADDING = 12

export type RectLike = { top: number; left: number; right: number; bottom: number }

/** Anything a popout can hang off: an element, or a fixed rect (cursor /
 *  snapshot). An element that has left the DOM falls back to its last rect. */
export type PopoutAnchor = Element | RectLike | null | undefined

export interface PopoutOptions {
  position: PopoutPosition
  align?: PopoutAlign
  /** Gap between target and popout (Discord Popout default 8). */
  spacing?: number
  /** Cross-axis offset (Discord `offset`), e.g. -8 to overhang the target. */
  offset?: number
  /** Flip to the opposite side when it doesn't fit (Popout default true). */
  autoInvert?: boolean
  /** Make the popout's width match the target's (minus 2 * inset). */
  matchWidth?: boolean | { inset: number }
}

/** Discord Popout: align defaults from the position. */
export function defaultAlign(position: PopoutPosition): PopoutAlign {
  return position === 'top' || position === 'bottom' ? 'left' : 'top'
}

const OPPOSITE: Record<PopoutPosition, PopoutPosition> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

export interface PopoutPlacement { left: number; top: number; position: PopoutPosition }

/** Place a `w`x`h` popout against `t` inside a `W`x`H` viewport (all in
 *  viewport coordinates). Pure - shared by the hook and by callers that need
 *  a one-shot placement. */
export function computePopoutPlacement(
  t: RectLike,
  w: number,
  h: number,
  W: number,
  H: number,
  opts: PopoutOptions,
): PopoutPlacement {
  const spacing = opts.spacing ?? 8
  const offset = opts.offset ?? 0
  const align = opts.align ?? defaultAlign(opts.position)
  const P = POPOUT_VIEWPORT_PADDING
  const tw = t.right - t.left
  const th = t.bottom - t.top
  const clampX = (x: number) => Math.max(P, Math.min(x, W - P - w))
  const clampY = (y: number) => Math.max(P, Math.min(y, H - P - h))

  const place = (pos: PopoutPosition): PopoutPlacement & { fit: number } => {
    let left: number
    let top: number
    let fit: number
    if (pos === 'top' || pos === 'bottom') {
      top = pos === 'bottom' ? t.bottom + spacing : t.top - spacing - h
      fit = pos === 'bottom' ? H - (top + h) : top
      left = align === 'right' ? t.right - offset - w
        : align === 'center' ? t.left + (tw - w) / 2 + offset
          : t.left + offset
      left = clampX(left)
    } else {
      left = pos === 'right' ? t.right + spacing : t.left - spacing - w
      fit = pos === 'right' ? W - (left + w) : left
      top = align === 'bottom' ? t.bottom - offset - h
        : align === 'center' ? t.top + (th - h) / 2 + offset
          : t.top + offset
      top = clampY(top)
    }
    return { left, top, position: pos, fit }
  }

  let best = place(opts.position)
  if ((opts.autoInvert ?? true) && best.fit < 0) {
    const alt = place(OPPOSITE[opts.position])
    if (alt.fit > best.fit) best = alt
  }
  // Still overflowing: pull the popout back inside the viewport along its
  // main axis (Discord shifts top/bottom popouts by the overflow).
  let { left, top } = best
  if (best.fit < 0) {
    if (best.position === 'top' || best.position === 'bottom') top = Math.max(0, Math.min(top, H - h))
    else left = Math.max(0, Math.min(left, W - w))
  }
  return { left: Math.round(left), top: Math.round(top), position: best.position }
}

function anchorRect(anchor: PopoutAnchor, last: RectLike | null): RectLike | null {
  if (!anchor) return last
  if (anchor instanceof Element) {
    if (!anchor.isConnected) return last
    const r = anchor.getBoundingClientRect()
    // A target hidden mid-flight (display:none) keeps the last good rect.
    if (r.width === 0 && r.height === 0 && last) return last
    return { top: r.top, left: r.left, right: r.right, bottom: r.bottom }
  }
  return anchor
}

/**
 * Keep `ref`'s element anchored to `anchor` while `enabled`. Writes
 * left/top (layer coordinates) straight onto the element every frame the
 * target or viewport changes; the element is forced to position:absolute
 * and pointer-events:auto (the popout layer itself is click-through).
 * `data-popout-position` reflects the side actually used after inversion.
 */
export function usePopoutPosition(
  ref: RefObject<HTMLElement | null>,
  anchor: PopoutAnchor | (() => PopoutAnchor),
  opts: PopoutOptions & { enabled?: boolean },
): void {
  const anchorRef = useRef(anchor)
  const optsRef = useRef(opts)
  anchorRef.current = anchor
  optsRef.current = opts
  const enabled = opts.enabled ?? true

  useLayoutEffect(() => {
    if (!enabled) return
    let raf = 0
    let lastRect: RectLike | null = null
    let lastKey = ''
    const update = () => {
      const el = ref.current
      if (!el) return
      const a = anchorRef.current
      const rect = anchorRect(typeof a === 'function' ? a() : a, lastRect)
      if (!rect) return
      lastRect = rect
      const o = optsRef.current
      if (o.matchWidth) {
        const inset = typeof o.matchWidth === 'object' ? o.matchWidth.inset : 0
        const width = `${Math.max(0, Math.round(rect.right - rect.left - inset * 2))}px`
        if (el.style.width !== width) el.style.width = width
      }
      const W = document.documentElement.clientWidth || window.innerWidth
      const H = window.innerHeight
      const p = computePopoutPlacement(rect, el.offsetWidth, el.offsetHeight, W, H, o)
      // Viewport → containing-block coordinates (the popout layer, or the
      // element's offsetParent when it isn't portaled).
      const parent = el.offsetParent as HTMLElement | null
      let ox = 0
      let oy = 0
      if (parent) {
        const pr = parent.getBoundingClientRect()
        ox = pr.left + parent.clientLeft - parent.scrollLeft
        oy = pr.top + parent.clientTop - parent.scrollTop
      }
      const left = p.left - ox
      const top = p.top - oy
      const key = `${left},${top},${p.position}`
      if (key === lastKey) return
      lastKey = key
      el.style.left = `${left}px`
      el.style.top = `${top}px`
      el.dataset.popoutPosition = p.position
    }
    const prime = () => {
      const el = ref.current
      if (!el) return
      el.style.position = 'absolute'
      el.style.right = 'auto'
      el.style.bottom = 'auto'
      el.style.pointerEvents = 'auto'
    }
    prime()
    update()
    const loop = () => {
      prime()
      update()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    window.addEventListener('resize', update)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', update)
    }
  }, [enabled, ref])
}

/**
 * Portaled, anchored popout. `children` receives the ref to put on the
 * popout's root element (keep the element's own class for its styling and
 * for the dismissal handlers that test `.closest()` / the event path).
 */
export function Popout({ anchor, children, ...opts }: PopoutOptions & {
  anchor: PopoutAnchor | (() => PopoutAnchor)
  children: (ref: RefObject<HTMLDivElement | null>) => ReactNode
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  usePopoutPosition(ref, anchor, opts)
  return createPortal(children(ref), popoutLayer())
}

/** Anchor resolved by selector each frame (for triggers without a ref). */
export const anchorSelector = (selector: string) => (): Element | null => document.querySelector(selector)
