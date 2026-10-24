import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/* Discord's chat-bar emoji button, ported 1:1 from module 375499 of the live
 * client. It is NOT a static icon - it's a spring-animated crossfade between a
 * greyscale sprite (mask over --interactive-text-default) and the colored
 * sprite sheet, driven by react-spring physics (tension 800, friction 24).
 *
 * Verbatim behavior from the decompiled source:
 *   - cell = Math.floor(77 * Math.random()) on each mouseenter (not hover-held)
 *   - row = floor(cell / 20), col = cell % 20, size = 18px
 *   - two stacked .sprite layers: spriteColored (active when hovered) and
 *     spriteGreyscale (active when not), crossfaded via opacity
 *   - the whole spriteContainer scales 1 → 1.14 with the spring `to` value
 *
 * We reproduce the spring with rAF + the same tension/friction so the feel is
 * identical, not a linear CSS transition. */

const SHEET_COLS = 20
const RANDOM_CELLS = 77
// react-spring's default for this button (module 375499: {tension:800,friction:24}).
const SPRING_TENSION = 800
const SPRING_FRICTION = 24

export function EmojiSpriteButton({
  size = 18,
  onClick,
  disabled,
  label = 'Open emoji picker',
}: {
  size?: number
  onClick?: () => void
  disabled?: boolean
  label?: string
}) {
  const [hovered, setHovered] = useState(false)
  const [cell, setCell] = useState(() => Math.floor(RANDOM_CELLS * Math.random()))
  const containerRef = useRef<HTMLDivElement>(null)
  const springRef = useRef({ value: 0, velocity: 0, raf: 0, target: 0 })

  // Drive the react-spring physics: animate `value` toward `target` (0 rest, 1
  // hovered) with the exact tension/friction, mapping to scale(1→1.14).
  useEffect(() => {
    const spring = springRef.current
    spring.target = hovered ? 1 : 0
    cancelAnimationFrame(spring.raf)
    const step = () => {
      const displacement = spring.target - spring.value
      const accel = displacement * SPRING_TENSION - spring.velocity * SPRING_FRICTION
      // Semi-implicit Euler at ~60fps (dt in seconds).
      const dt = 1 / 60
      spring.velocity += accel * dt * 0.001
      spring.value += spring.velocity * dt
      const settled = Math.abs(displacement) < 0.001 && Math.abs(spring.velocity) < 0.001
      if (settled) {
        spring.value = spring.target
        spring.velocity = 0
      }
      const el = containerRef.current
      if (el) el.style.transform = `scale(${1 + spring.value * 0.14})`
      if (!settled) spring.raf = requestAnimationFrame(step)
    }
    spring.raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(spring.raf)
  }, [hovered])

  // On each mouseenter (not hover-held): pick a fresh random sprite cell.
  const onEnter = useCallback(() => {
    setCell(Math.floor(RANDOM_CELLS * Math.random()))
    setHovered(true)
  }, [])
  const onLeave = useCallback(() => setHovered(false), [])

  const style = useMemo(
    () =>
      ({
        '--custom-emoji-sprite-size': `${size}px`,
        '--custom-emoji-sprite-row': Math.floor(cell / SHEET_COLS),
        '--custom-emoji-sprite-col': cell % SHEET_COLS,
      }) as React.CSSProperties,
    [cell, size],
  )

  return (
    <button
      type="button"
      className="d-emojiButton chat-emojiButton"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div ref={containerRef} className="d-spriteContainer" style={style} aria-hidden="true">
        <div className={`d-sprite d-spriteColored ${hovered ? 'd-spriteActive' : 'd-spriteInactive'}`} />
        <div className={`d-sprite d-spriteGreyscale ${hovered ? 'd-spriteInactive' : 'd-spriteActive'}`} />
      </div>
    </button>
  )
}
