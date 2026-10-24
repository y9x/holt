import { useSyncExternalStore } from 'react'
import { allEmoji, type EmojiEntry } from './emoji-data'
import { baseEmoji } from './emoji-tone'

/* Emoji usage tracking - a port of Discord's frecency store (web.js module
 * 283047, the class behind emojiFrecency / emojiReactionFrecency):
 *
 *   track(key): totalUses += 1; recentUses.push(now), keeping the newest
 *               maxSamples (10) timestamps.
 *   compute():  score = Σ over recentUses of computeBonus(key)/100 (=1 for
 *               emoji: computeBonus → 100) × computeWeight(daysAgo), where
 *               computeWeight = ≤3 days 100, ≤15 70, ≤30 50, ≤45 30, ≤80 10,
 *               else 1 (moment `diff(..., "days")`, i.e. whole days);
 *               frecency = ceil(totalUses × score / recentUses.length);
 *               frequently = keys sorted by -frecency (stable), first
 *               numFrequentlyItems (42 for emoji).
 *
 * Keys are BASE emoji names (Discord tracks convertSurrogateToBase), so a
 * toned use counts for the base and renders in the user's current tone.
 * Discord keeps separate stores for messages and reactions; the bridge keeps
 * one store for both. Persisted in localStorage, top 100 entries (Discord
 * syncs the top 100 to user settings). */

const STORAGE_KEY = 'abulxt:chat-emoji-frecency'
const MAX_SAMPLES = 10
const NUM_FREQUENTLY_ITEMS = 42
const MAX_PERSISTED = 100
const DAY = 86_400_000

interface UsageEntry { totalUses: number; recentUses: number[] }
type Usage = Record<string, UsageEntry>

let usage: Usage | null = null
let version = 0
const listeners = new Set<() => void>()

function load(): Usage {
  if (usage) return usage
  const out: Usage = {}
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Record<string, unknown>
    if (raw && typeof raw === 'object') {
      for (const [key, value] of Object.entries(raw)) {
        const v = value as Partial<UsageEntry> & { count?: number; last?: number }
        if (Array.isArray(v?.recentUses) && typeof v.totalUses === 'number') {
          out[key] = { totalUses: v.totalUses, recentUses: v.recentUses.filter((t) => typeof t === 'number').slice(-MAX_SAMPLES) }
        } else if (typeof v?.count === 'number' && typeof v.last === 'number') {
          // Earlier {count,last} format: keep the count, one sample.
          out[key] = { totalUses: v.count, recentUses: [v.last] }
        }
      }
    }
  } catch { /* ignore */ }
  usage = out
  return usage
}

function computeWeight(days: number): number {
  if (days <= 3) return 100
  if (days <= 15) return 70
  if (days <= 30) return 50
  if (days <= 45) return 30
  if (days <= 80) return 10
  return 1
}

function frecency(entry: UsageEntry, now: number): number {
  const samples = entry.recentUses.slice(-MAX_SAMPLES)
  if (!samples.length) return 0
  let score = 0
  for (const t of samples) score += computeWeight(Math.floor((now - t) / DAY))
  return Math.ceil(entry.totalUses * (score / samples.length))
}

/** Keys best-first (stable on ties, like lodash sortBy). */
function ranked(u: Usage, now: number): string[] {
  return Object.keys(u)
    .map((key) => [key, frecency(u[key], now)] as const)
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => key)
}

const byName = new Map<string, EmojiEntry>()
const bySurrogate = new Map<string, EmojiEntry>()
function ensureIndex() {
  if (byName.size) return
  for (const e of allEmoji) {
    if (!byName.has(e[0])) byName.set(e[0], e)
    if (!bySurrogate.has(e[1])) bySurrogate.set(e[1], e)
  }
}
function entryFor(name: string): EmojiEntry | undefined {
  ensureIndex()
  return byName.get(name)
}

function persist(u: Usage) {
  const now = Date.now()
  const keys = ranked(u, now)
  if (keys.length > MAX_PERSISTED) for (const k of keys.slice(MAX_PERSISTED)) delete u[k]
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(u)) } catch { /* ignore */ }
  version++
  for (const fn of listeners) fn()
}

function track(u: Usage, name: string, now: number) {
  const entry = entryFor(name)
  const key = entry ? baseEmoji(entry)[0] : name
  const prev = u[key]
  if (!prev) u[key] = { totalUses: 1, recentUses: [now] }
  else {
    prev.totalUses += 1
    prev.recentUses.push(now)
    while (prev.recentUses.length > MAX_SAMPLES) prev.recentUses.shift()
  }
}

/** Record one use of an emoji (by name, e.g. "heart" or "wave_tone3"). */
export function recordEmojiUse(name: string): void {
  if (!name) return
  const u = load()
  track(u, name, Date.now())
  persist(u)
}

let surrogateRe: RegExp | null = null
/** Record every distinct unicode emoji in a sent message (Discord tracks the
 *  emoji a message uses when it is sent). */
export function recordEmojiUsesInText(text: string): void {
  if (!text) return
  ensureIndex()
  if (!surrogateRe) {
    const alts = [...bySurrogate.keys()].sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    surrogateRe = new RegExp(alts.join('|'), 'gu')
  }
  const names = new Set<string>()
  for (const m of text.matchAll(surrogateRe)) {
    const e = bySurrogate.get(m[0])
    if (e) names.add(e[0])
  }
  if (!names.size) return
  const u = load()
  const now = Date.now()
  for (const n of names) track(u, n, now)
  persist(u)
}

/** The user's frecent emoji (base entries), best first - Discord's
 *  `frequently` (up to 42). Empty until something is used. */
export function frecentEmoji(limit = NUM_FREQUENTLY_ITEMS): EmojiEntry[] {
  const u = load()
  return ranked(u, Date.now())
    .map(entryFor)
    .filter((e): e is EmojiEntry => Boolean(e))
    .slice(0, Math.min(limit, NUM_FREQUENTLY_ITEMS))
}

/** An emoji's current frecency (0 when never used) - for ranking
 *  autocomplete matches the way Discord boosts frecent emoji. Accepts toned
 *  names (counted against the base). */
export function emojiFrecencyScore(name: string): number {
  const u = load()
  const entry = entryFor(name)
  const key = entry ? baseEmoji(entry)[0] : name
  return u[key] ? frecency(u[key], Date.now()) : 0
}

const HOVER_BAR_DEFAULTS = ['100', 'laughing', 'sparkling_heart']

/** The hover bar's 3 quick reactions (Discord: frecent reactions, padded
 *  with its defaults 💯 😆 💖 - getByName("100"), "laughing",
 *  "sparkling_heart"). Base entries: callers apply the user's tone. */
export function quickReactionEmoji(): EmojiEntry[] {
  const frecent = frecentEmoji(3)
  if (frecent.length >= 3) return frecent
  const out = [...frecent]
  for (const name of HOVER_BAR_DEFAULTS) {
    const e = entryFor(name)
    if (e && !out.some((x) => x[0] === e[0])) out.push(e)
  }
  return out.slice(0, 3)
}

/** Subscribe to usage changes (returns an unsubscribe). */
export function onEmojiUsage(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** React hook: a counter that bumps on every recorded use (memo key). */
export function useEmojiUsageVersion(): number {
  return useSyncExternalStore(onEmojiUsage, () => version, () => 0)
}
