import React, { useCallback } from 'react'
import { useHolyAttr, type HolyAttrValues } from '../../lib/holy-attr'

// The `useHolyAttr` hook and its types live in src/lib/holy-attr.ts (import it
// from there). Only the types are re-exported here - type-only exports keep this
// component file compatible with the react-refresh "components only" rule.
export type {
  HolyAttrName,
  HolyAttrValues,
  UseHolyAttrOptions,
  UseHolyAttrResult,
} from '../../lib/holy-attr'

type HolyInputElement = HTMLInputElement | HTMLTextAreaElement

export interface HolyInputProps
  extends Omit<React.InputHTMLAttributes<HolyInputElement>, 'ref'> {
  /** Render an <input> (default) or a <textarea>. */
  as?: 'input' | 'textarea'
}

/**
 * Drop-in <input>/<textarea> that automatically obfuscates its `placeholder`,
 * `aria-label` and `title` via useHolyAttr. All other props pass through. Same
 * accessibility tradeoff as useHolyAttr applies (see HOLYTEXT.md).
 */
export const HolyInput = React.forwardRef<HolyInputElement, HolyInputProps>(
  function HolyInput(
    { as = 'input', placeholder, title, 'aria-label': ariaLabel, ...rest },
    forwardedRef,
  ) {
    const holy: HolyAttrValues = {}
    if (typeof placeholder === 'string') holy.placeholder = placeholder
    if (typeof title === 'string') holy.title = title
    if (typeof ariaLabel === 'string') holy['aria-label'] = ariaLabel

    const { ref: holyRef, placeholder: ph } = useHolyAttr(holy)

    const setRef = useCallback(
      (node: HolyInputElement | null) => {
        holyRef(node)
        if (typeof forwardedRef === 'function') forwardedRef(node)
        else if (forwardedRef) forwardedRef.current = node
      },
      [holyRef, forwardedRef],
    )

    const Component = as as React.ElementType
    return <Component ref={setRef} {...ph} {...rest} />
  },
)

export default HolyInput
