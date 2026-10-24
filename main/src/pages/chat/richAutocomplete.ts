/* Shared autocomplete logic for Discord's rich text areas - the channel
 * composer and the inline message editor run the exact same trigger
 * detection, emoji matching and chip insertion, so the two can never drift.
 *
 *   '@query'   members (+ @everyone/@here, roles)    - fetched from /members
 *   '@&query'  roles only                            - fetched from /members
 *   '#query'   channels                              - fetched from /members
 *   ':query'   unicode emoji (2+ chars, local)       - Discord's emoji tab
 *
 * Offsets are in the SERIALIZED frame (composerRich.serializeComposer), so
 * chips count as their token and a chip label can never leak into a query.
 */

import { pickerEmoji, applyTone, getEmojiTone } from './emoji-tone'
import { emojiFrecencyScore } from './emoji-frecency'
import type { EmojiEntry } from './emoji-data'
import { replaceWithEmojiChip, serializeComposer, serializedCaretOffset } from './composerRich'

export type AutocompleteTriggerChar = '@' | '@&' | '#' | ':'

export interface AutocompleteTrigger {
  trigger: AutocompleteTriggerChar
  /** Serialized offset of the trigger character. */
  start: number
  /** Text typed after the trigger (without '&' for the role form). */
  query: string
}

/** Discord opens the emoji autocomplete after ':' plus two characters. */
export const EMOJI_AUTOCOMPLETE_MIN_CHARS = 2
/** Rows Discord lists in the emoji autocomplete. */
export const EMOJI_AUTOCOMPLETE_LIMIT = 10

/**
 * The active trigger at the caret, or null. The tail of the text before the
 * caret must be a trigger char preceded by start-of-text or whitespace (so
 * 'email@host' / 'a:b' never open the popup) and followed by no whitespace.
 */
export function detectTrigger(text: string, caret: number): AutocompleteTrigger | null {
  const before = text.slice(0, caret)
  const mention = /(^|\s)([@#])([@\w-]*)$/.exec(before)
  if (mention) {
    const query = mention[3]
    const start = before.length - mention[2].length - query.length
    const isRoleForm = mention[2] === '@' && query.startsWith('&')
    return { trigger: isRoleForm ? '@&' : (mention[2] as '@' | '#'), start, query: isRoleForm ? query.slice(1) : query }
  }
  const emoji = /(^|\s):([\w+-]+)$/.exec(before)
  if (emoji && emoji[2].length >= EMOJI_AUTOCOMPLETE_MIN_CHARS) {
    return { trigger: ':', start: before.length - emoji[2].length - 1, query: emoji[2] }
  }
  return null
}

/**
 * Emoji matching a ':query' - Discord ranks exact name, then prefix, then a
 * word-prefix (after '_'), then substring; one row per base emoji, rendered in
 * the user's chosen skin tone.
 */
export function emojiSuggestions(query: string, limit = EMOJI_AUTOCOMPLETE_LIMIT): EmojiEntry[] {
  const q = query.toLowerCase()
  if (!q) return []
  const scored: Array<{ entry: EmojiEntry; score: number; order: number }> = []
  pickerEmoji.forEach((entry, order) => {
    const name = entry[0].toLowerCase()
    let score = -1
    if (name === q) score = 0
    else if (name.startsWith(q)) score = 1
    else if (name.split('_').some((part) => part.startsWith(q))) score = 2
    else if (name.includes(q)) score = 3
    if (score >= 0) scored.push({ entry, score, order })
  })
  // Same match tier → the user's frecent emoji first (emoji-frecency.ts).
  const frec = new Map(scored.map((s) => [s.entry[0], emojiFrecencyScore(s.entry[0])]))
  scored.sort((a, b) => a.score - b.score || (frec.get(b.entry[0]) || 0) - (frec.get(a.entry[0]) || 0) || a.order - b.order)
  const tone = getEmojiTone()
  return scored.slice(0, limit).map((s) => applyTone(s.entry, tone))
}

/** Exact ':name:' lookup (Discord converts a completed shortcode in place). */
export function emojiByShortcode(name: string): EmojiEntry | null {
  const q = name.toLowerCase()
  const hit = pickerEmoji.find((e) => e[0].toLowerCase() === q)
  return hit ? applyTone(hit, getEmojiTone()) : null
}

/**
 * Discord turns a typed ':name:' into the emoji as soon as the closing colon
 * lands. Runs on input: when the text just before the caret is a complete,
 * known shortcode, swap it for an emoji chip. Returns true when it converted.
 */
export function convertTypedShortcode(root: HTMLElement): boolean {
  const text = serializeComposer(root)
  const caret = serializedCaretOffset(root)
  if (caret === null) return false
  const before = text.slice(0, caret)
  const m = /(^|\s):([\w+-]{2,}):$/.exec(before)
  if (!m) return false
  const entry = emojiByShortcode(m[2])
  if (!entry) return false
  const start = before.length - m[2].length - 2
  replaceWithEmojiChip(root, start, before.length, entry, false)
  return true
}

/** The wire token + chip label for a picked mention/channel suggestion -
 *  exactly the forms Discord clients send. */
export function mentionChipFor(item: { kind: string; id: string; label: string }): { token: string; label: string } {
  const token = item.kind === 'member' ? `<@${item.id}>`
    : item.kind === 'role' ? `<@&${item.id}>`
      : item.kind === 'channel' ? `<#${item.id}>`
        : `@${item.kind}` // everyone / here
  const label = item.kind === 'channel' ? `#${item.label}` : `@${item.label}`
  return { token, label }
}

/** Emoji autocomplete rows for a ':' trigger (MentionSuggestionItem shape). */
export function emojiSuggestionItems(query: string): Array<{ kind: 'emoji'; id: string; label: string; emoji: EmojiEntry }> {
  return emojiSuggestions(query).map((entry) => ({ kind: 'emoji' as const, id: entry[0], label: `:${entry[0]}:`, emoji: entry }))
}
