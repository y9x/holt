import { type EmojiEntry } from './emoji-data'
import { twemojiUrl } from './twemoji'

/** Renders one emoji as a Twemoji <img>, matching Discord's in-chat glyph. */
export function Emoji({ entry, size = 22, className = '' }: { entry: EmojiEntry; size?: number; className?: string }) {
  const [name, surrogates, , codepoint] = entry
  return (
    <img
      className={`emoji ${className}`}
      src={twemojiUrl(codepoint)}
      alt={surrogates}
      title={`:${name}:`}
      draggable={false}
      width={size}
      height={size}
      style={{ width: size, height: size }}
    />
  )
}
