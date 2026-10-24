import React, { useEffect, useRef } from 'react'
import {
  cipherFor,
  ELLIPSIS_SHADOW_CSS,
  makeDashPlaceholder,
  resolveHoly,
} from '../../lib/holy-render'

export interface HolyTextProps extends React.HTMLAttributes<HTMLElement> {
  text?: string
  children?: React.ReactNode
  encrypted?: string
  as?: React.ElementType
  /**
   * Keep `text-overflow: ellipsis` working on a single-line label. The real
   * text lives in a closed shadow root, and truncation styles are
   * non-inherited (they do not cross the shadow boundary), so they are injected
   * into the shadow AND applied to the host box. Opt-in; default off so no
   * existing caller's layout changes. See HOLYTEXT.md.
   */
  ellipsis?: boolean
}

export const HolyText: React.FC<HolyTextProps> = ({
  text,
  children,
  encrypted,
  as: Component = 'span',
  className = '',
  ellipsis = false,
  style,
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
    // Likely bot, or a registered string whose decrypt failed: keep the dash
    // placeholder rather than blanking the shadow root (A2).
    if (res.kind === 'keep') return

    try {
      // Keep a single shadow root and update its contents when `text` changes,
      // instead of guarding on a dataset flag that never re-ran (A3).
      if (!shadowRef.current) {
        host.textContent = ''
        shadowRef.current = host.attachShadow({ mode: 'closed' })
      }
      if (ellipsis) {
        // Truncation styles are non-inherited; inject them into the shadow and
        // wrap the text so the shadow-internal box truncates.
        const styleEl = document.createElement('style')
        styleEl.textContent = ELLIPSIS_SHADOW_CSS
        const span = document.createElement('span')
        span.className = 'holy-ellipsis'
        span.textContent = res.plaintext
        shadowRef.current.replaceChildren(styleEl, span)
      } else {
        shadowRef.current.replaceChildren(res.plaintext)
      }
    } catch {
      host.textContent = content
    }
  }, [content, cipher, ellipsis])

  const placeholder = makeDashPlaceholder(content)

  const combinedClass = `obfuscated-text ${className}`.trim()

  // In ellipsis mode the host is the block box that clips the (shadow) inline
  // content, so the non-inherited truncation props must live on the host too.
  const hostStyle: React.CSSProperties | undefined = ellipsis
    ? {
        display: 'inline-block',
        maxWidth: '100%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        ...style,
      }
    : style

  return (
    <Component
      ref={hostRef}
      className={combinedClass}
      data-ectext={cipher}
      style={hostStyle}
      {...props}
    >
      {placeholder}
    </Component>
  )
}

export default HolyText
