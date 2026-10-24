import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { RefCallback } from 'react'
import { cipherFor, makeDashPlaceholder, resolveHoly } from './holy-render'

/**
 * Attributes whose text cannot live in a shadow root (a shadow root holds
 * nodes, not attribute strings). These are obfuscated by shipping a dash
 * placeholder attribute, then setting the real value on mount.
 */
export type HolyAttrName =
  | 'aria-label'
  | 'aria-description'
  | 'title'
  | 'placeholder'
  | 'alt'

export type HolyAttrValues = Partial<Record<HolyAttrName, string>>

export interface UseHolyAttrOptions {
  /**
   * Reveal the real attribute even when the bot tripwire fires. Default false
   * (bots keep dashes), matching HolyText.
   */
  revealForBots?: boolean
}

export interface UseHolyAttrResult {
  /** Attach to the element; the real values are set on mount. */
  ref: RefCallback<HTMLElement>
  /** Dash placeholders to spread onto the element as its initial attributes. */
  placeholder: Record<string, string>
}

/**
 * Obfuscate text that lives in HTML attributes (aria-label / title /
 * placeholder / alt / aria-description).
 *
 * Mechanism: the element renders with DASH placeholder attributes (spread
 * `placeholder`), so the real text is never in the shipped/static HTML. On
 * mount the hook decrypts each value (same registry + decrypt path as
 * HolyText) and sets the real attribute via `setAttribute`, as early as a
 * layout effect allows.
 *
 * ACCESSIBILITY TRADEOFF (document prominently where used): during the pre-JS /
 * pre-hydration window a screen reader sees the dash placeholder, not the real
 * label. Reveal happens in a layout effect (synchronously after mount, before
 * paint) to keep that window as short as possible. For purely decorative text
 * this is fine; for a control whose only accessible name is an obfuscated
 * attribute, weigh the cost - an unobfuscated label may be the better choice.
 *
 * FAILURE BEHAVIOUR: likely bots and registered strings whose decrypt fails
 * KEEP the dash placeholder (never reveal), identical to HolyText. A failed
 * reveal therefore degrades to dashes, not to a blank attribute.
 */
export function useHolyAttr(
  values: HolyAttrValues,
  opts?: UseHolyAttrOptions,
): UseHolyAttrResult {
  // Stable dependency key: the hook's work is a pure function of the values.
  const serialized = JSON.stringify(values)
  const revealForBots = opts?.revealForBots ?? false

  const placeholder = useMemo(() => {
    const out: Record<string, string> = {}
    for (const [name, value] of Object.entries(values)) {
      if (typeof value === 'string') out[name] = makeDashPlaceholder(value)
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized])

  const nodeRef = useRef<HTMLElement | null>(null)

  const apply = useCallback(
    (node: HTMLElement) => {
      for (const [name, value] of Object.entries(values)) {
        if (typeof value !== 'string') continue
        const res = resolveHoly(value, cipherFor(value), { revealForBots })
        // keep -> leave the dash placeholder already present on the element.
        if (res.kind === 'reveal') node.setAttribute(name, res.plaintext)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serialized, revealForBots],
  )

  const ref = useCallback<RefCallback<HTMLElement>>((node) => {
    nodeRef.current = node
  }, [])

  // Layout effect: set real attributes synchronously after mount, before paint,
  // to keep the dashes-visible-to-a11y window as short as possible.
  useLayoutEffect(() => {
    if (nodeRef.current) apply(nodeRef.current)
  }, [apply])

  return { ref, placeholder }
}
