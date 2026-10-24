import React, { useEffect, useRef } from 'react'
import { cipherFor, makeDashPlaceholder, resolveHoly } from '../../lib/holy-render'

export type HolyProseMode = 'light' | 'shadow'

export interface HolyProseProps extends React.HTMLAttributes<HTMLElement> {
  text?: string
  children?: string
  encrypted?: string
  as?: React.ElementType
  /**
   * 'light' (default): reconstruct the text in the LIGHT DOM. Fully selectable
   * and copyable. Hidden from scrapers that read the shipped/static HTML only.
   * 'shadow': reveal into an OPEN shadow root. `host.textContent` /
   * `host.outerHTML` stay empty of the text even after hydration; still
   * user-selectable in-browser, but copy reliability across the shadow boundary
   * varies by browser. See HOLYTEXT.md for the exact protection and its limits.
   */
  mode?: HolyProseMode
}

/**
 * Obfuscate legal prose (ToS / Privacy) from naive scrapers while keeping it
 * user-selectable and copyable.
 *
 * CRITICAL: this is NOT a closed shadow root. Closed shadow roots block text
 * selection from crossing the boundary, which is unacceptable for prose a user
 * must be able to read, select and copy. Both modes below keep selection
 * working.
 *
 * Protection (honest): the real text is absent from the shipped static HTML
 * (dashes) and, because the JS bundle is shield-encrypted, absent from the
 * shipped JS too. It is reconstructed only at runtime in the live DOM. This
 * defeats naive HTML scrapers and copy-paste-of-source, NOT a real browser, a
 * user, the accessibility tree, or automation that reads the live DOM after JS
 * runs. 'shadow' mode additionally hides the text from a post-hydration
 * `host.textContent` read on the host element.
 */
export const HolyProse: React.FC<HolyProseProps> = ({
  text,
  children,
  encrypted,
  as: Component = 'span',
  className = '',
  mode = 'light',
  ...props
}) => {
  const content = text ?? (typeof children === 'string' ? children : '')
  const hostRef = useRef<HTMLElement>(null)
  const shadowRef = useRef<ShadowRoot | null>(null)
  const cipher = cipherFor(content, encrypted)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const res = resolveHoly(content, cipher)
    if (res.kind === 'keep') return

    try {
      if (mode === 'shadow') {
        if (!shadowRef.current) {
          host.textContent = ''
          // OPEN (not closed) so in-browser selection works; the host element's
          // own textContent/outerHTML still does not expose the shadow text.
          shadowRef.current = host.attachShadow({ mode: 'open' })
        }
        shadowRef.current.replaceChildren(res.plaintext)
      } else {
        // Light DOM: a normal text node -> natively selectable and copyable.
        host.textContent = res.plaintext
      }
    } catch {
      host.textContent = content
    }
  }, [content, cipher, mode])

  const placeholder = makeDashPlaceholder(content)
  const combinedClass = `holy-prose ${className}`.trim()

  return (
    <Component ref={hostRef} className={combinedClass} data-ectext={cipher} {...props}>
      {placeholder}
    </Component>
  )
}

export default HolyProse
