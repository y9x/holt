import { useMemo } from 'react'
import type { EmojiEntry } from './emoji-data'
import { twemojiUrl } from './twemoji'

/* Discord renders emoji as sprite-sheet <div> cells (emoji__040f0), not <img>,
 * in the message-hover toolbar and elsewhere. The sprite sheet maps each emoji
 * to a background-position. We render the same shape: a div with a background
 * image + background-position/size, matching Discord's emoji__040f0 output.
 * Where a glyph isn't on the shared sheet we fall back to the Twemoji PNG as
 * the div's background image (same div form, inline URL). */

const SHEET_COLS = 20
const SHEET_ROWS = 4
const CELL = 40 // the picker/hover sprite cell size Discord renders

export function EmojiSprite({ entry, size = CELL }: { entry: EmojiEntry; size?: number }) {
  const [name, surrogates, spriteIndex, codepoint] = entry
  const style = useMemo(() => {
    if (spriteIndex >= 0) {
      // On the shared 20x4 sheet (indices 0..79). background-size scales the
      // whole sheet so each 48px source cell lands in `size` px.
      const col = spriteIndex % SHEET_COLS
      const row = Math.floor(spriteIndex / SHEET_COLS)
      return {
        backgroundImage: 'url(/vendor/discord/emoji-sprite.png)',
        backgroundPosition: `-${col * size}px -${row * size}px`,
        backgroundSize: `${SHEET_COLS * size}px ${SHEET_ROWS * size}px`,
        backgroundRepeat: 'no-repeat',
        backgroundColor: 'transparent',
        width: size,
        height: size,
      } as React.CSSProperties
    }
    // Off-sheet glyph → Twemoji PNG as the div background (same div form).
    return {
      backgroundImage: `url(${twemojiUrl(codepoint)})`,
      backgroundPosition: 'center',
      backgroundSize: 'contain',
      backgroundRepeat: 'no-repeat',
      width: size,
      height: size,
    } as React.CSSProperties
  }, [spriteIndex, codepoint, size])

  return (
    <div
      className="emoji chat-emojiSprite"
      role="img"
      aria-label={`:${name}:`}
      data-name={name}
      data-surrogates={surrogates}
      style={style}
    />
  )
}
