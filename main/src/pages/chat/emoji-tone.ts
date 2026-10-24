import { useSyncExternalStore } from 'react'
import { emojiCategories, allEmoji, type EmojiCategory, type EmojiEntry } from './emoji-data'

/* Skin-tone (diversity) handling, shared by the expression picker, the hover
 * bar quick reactions, the Add Reaction submenu and frecency.
 *
 * emoji-data.ts keeps the base emoji in emojiCategories and every
 * Fitzpatrick variant (wave_tone1 … wave_tone5, handshake_tone1_tone2, …) in
 * diversityEmoji. Discord never shows the variants in the grid: each
 * diversity-capable emoji appears once, rendered in the user's chosen tone
 * (getDefaultDiversitySurrogate), and usage is
 * tracked against the base emoji (convertSurrogateToBase). Variants are
 * identified by codepoint (skin-tone modifiers 1f3fb–1f3ff), not by name -
 * several bases are named differently from their variants (kiss_mm →
 * kiss_man_man_tone5, person_curly_hair → person_tone1_curly_hair). */

const MODIFIERS: Record<string, number> = { '1f3fb': 1, '1f3fc': 2, '1f3fd': 3, '1f3fe': 4, '1f3ff': 5 }
export const TONE_COUNT = 5
const TONE_STORAGE_KEY = 'abulxt:chat-emoji-tone'

const stripFe0f = (cp: string) => cp.split('-').filter((p) => p !== 'fe0f').join('-')

function toneInfo(entry: EmojiEntry): { base: string; tones: number[] } | null {
  const parts = entry[3].split('-')
  const tones = parts.filter((p) => p in MODIFIERS).map((p) => MODIFIERS[p])
  if (!tones.length) return null
  return { base: stripFe0f(parts.filter((p) => !(p in MODIFIERS)).join('-')), tones }
}

/** True for a skin-tone variant entry (never shown as its own grid cell). */
const variantNames = new Set<string>()
/** base emoji name → its uniform-tone variants (index tone-1). */
const toneVariants = new Map<string, (EmojiEntry | undefined)[]>()
/** variant name → base entry. */
const baseByVariant = new Map<string, EmojiEntry>()

;(() => {
  const baseByCp = new Map<string, EmojiEntry>()
  for (const e of allEmoji) if (!toneInfo(e)) baseByCp.set(stripFe0f(e[3]), e)
  for (const e of allEmoji) {
    const info = toneInfo(e)
    if (!info) continue
    variantNames.add(e[0])
    const base = baseByCp.get(info.base)
    if (!base) continue
    baseByVariant.set(e[0], base)
    // Only uniform tones map to the selector (Discord's picker offers one
    // tone; mixed-tone pairs like handshake_tone1_tone2 are never shown).
    if (new Set(info.tones).size !== 1) continue
    const list = toneVariants.get(base[0]) || new Array<EmojiEntry | undefined>(TONE_COUNT).fill(undefined)
    list[info.tones[0] - 1] = e
    toneVariants.set(base[0], list)
  }
})()

export function isToneVariant(entry: EmojiEntry): boolean {
  return variantNames.has(entry[0])
}

/** The base (untoned) entry for an emoji; the entry itself when untoned. */
export function baseEmoji(entry: EmojiEntry): EmojiEntry {
  return baseByVariant.get(entry[0]) || entry
}

/** Swap a base entry for its toned twin when a non-default tone is active
 *  (falls back to the base when that tone isn't in the dataset). */
export function applyTone(entry: EmojiEntry, tone: number): EmojiEntry {
  if (tone <= 0) return entry
  return toneVariants.get(baseEmoji(entry)[0])?.[tone - 1] || entry
}

/** Picker categories with the tone variants removed (one cell per emoji). */
export const pickerCategories: EmojiCategory[] = emojiCategories.map((c) => ({ ...c, emojis: c.emojis.filter((e) => !variantNames.has(e[0])) }))
/** Every base emoji, for search (results dedupe to the chosen tone). */
export const pickerEmoji: EmojiEntry[] = pickerCategories.flatMap((c) => c.emojis)

/** The 👏 swatch Discord uses for the diversity button (tB = 1f44f), per tone (0..5). */
export const toneSwatch: EmojiEntry[] = (() => {
  const clap = allEmoji.find((e) => e[0] === 'clap')!
  return [clap, ...(toneVariants.get('clap') as EmojiEntry[])]
})()

// --- the user's tone (persisted, Discord-like: one global diversity choice) ---

let currentTone: number | null = null
const listeners = new Set<() => void>()

export function getEmojiTone(): number {
  if (currentTone !== null) return currentTone
  try {
    const t = parseInt(localStorage.getItem(TONE_STORAGE_KEY) || '0', 10)
    currentTone = t >= 0 && t <= TONE_COUNT ? t : 0
  } catch {
    currentTone = 0
  }
  return currentTone
}

export function setEmojiTone(tone: number): void {
  const t = tone >= 0 && tone <= TONE_COUNT ? tone : 0
  currentTone = t
  try { localStorage.setItem(TONE_STORAGE_KEY, String(t)) } catch { /* ignore */ }
  for (const fn of listeners) fn()
}

/** Subscribe to tone changes (returns an unsubscribe). */
export function onEmojiTone(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** React hook: the current tone, re-rendering on change. */
export function useEmojiTone(): number {
  return useSyncExternalStore(onEmojiTone, getEmojiTone, () => 0)
}
