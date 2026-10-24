import React from 'react'
import { HolyText } from './HolyText'

export interface HolyRichProps extends React.HTMLAttributes<HTMLElement> {
  as?: React.ElementType
  children?: React.ReactNode
}

/**
 * Obfuscate the STATIC STRING runs of mixed inline content while leaving inline
 * elements (`<a>`, `<strong>`, icons) and dynamic values in place and correctly
 * positioned.
 *
 * Contract (see HOLYTEXT.md): a bare string/text child in JSX is a static run
 * and is moved into a per-run closed shadow root (one `<HolyText>` span each).
 * Anything wrapped in an element is passed through untouched - that is how
 * icons, links and `{dynamic}` values stay in the light DOM. Because React
 * cannot distinguish a literal `"Hi"` from `{value}` that happens to be `"Hi"`
 * at runtime, a dynamic value you want to keep visible/queryable must be
 * wrapped (e.g. `<span>{value}</span>` or `<HolyDynamic>{value}</HolyDynamic>`).
 *
 * Whitespace-only string children (the spaces JSX inserts between elements) are
 * rendered as plain text nodes so inline/flex spacing is preserved exactly.
 */
export const HolyRich: React.FC<HolyRichProps> = ({
  as: Component = 'span',
  className = '',
  children,
  ...props
}) => {
  const walked = React.Children.map(children, (child) => {
    if (typeof child === 'string') {
      // Preserve inter-element whitespace verbatim (no shadow span for it).
      if (child.trim() === '') return child
      return <HolyText as="span" text={child} />
    }
    // Numbers are dynamic values; elements/fragments are inline content or
    // caller-wrapped dynamics. Both pass through in position, untouched.
    return child
  })

  const combinedClass = `holy-rich ${className}`.trim()

  return (
    <Component className={combinedClass} {...props}>
      {walked}
    </Component>
  )
}

/**
 * Explicit passthrough marker for a dynamic value inside <HolyRich>. Renders its
 * children in a light-DOM inline span so HolyRich leaves them visible and
 * queryable instead of obfuscating them. Equivalent to wrapping in a plain
 * `<span>`, but self-documenting at the call site.
 */
export const HolyDynamic: React.FC<React.HTMLAttributes<HTMLSpanElement>> = ({
  className = '',
  children,
  ...props
}) => (
  <span className={`holy-dynamic ${className}`.trim()} {...props}>
    {children}
  </span>
)

export default HolyRich
