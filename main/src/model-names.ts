/**
 * The name a model is shown by, everywhere a user sees one. Raw ids are for the
 * API docs and for typing a custom model, never for the picker.
 *
 *   claude-haiku-5-5         -> Haiku 5.5
 *   claude-opus-4-6-thinking -> Opus 4.6 Thinking
 *   kimi-k3                  -> Kimi K3
 *   kimi-k2.7-code           -> Kimi K2.7 Code
 *   evilcoder-gamma          -> Evilcoder Gamma
 *
 * The brand word "Claude" is dropped, because the family (Haiku, Opus) is what
 * people choose by. Every other word stays, so the family is always shown.
 * Consecutive numbers join as a version (5-5 -> 5.5), and dated stamps are dropped.
 */

const DROPPED_WORDS = new Set(['claude'])
const ACRONYMS: Record<string, string> = { glm: 'GLM', gpt: 'GPT', oss: 'OSS' }

export function modelDisplayName(id: string): string {
  const words: string[] = []
  for (const part of id.trim().toLowerCase().split('-')) {
    if (!part || DROPPED_WORDS.has(part) || /^\d{8}$/.test(part)) continue
    if (/^\d+$/.test(part)) {
      // A number after a version-like word extends it: "5" then "5" is "5.5".
      const last = words.length - 1
      if (last >= 0 && /^[\d.]+$/.test(words[last])) words[last] += `.${part}`
      else words.push(part)
      continue
    }
    // Model-size suffixes (120b, 8b) and "k"-prefixed names (k2, k3) are written in capitals.
    if (/^k\d/.test(part) || /^\d+b$/.test(part)) {
      words.push(part.toUpperCase())
      continue
    }
    words.push(ACRONYMS[part] ?? part.charAt(0).toUpperCase() + part.slice(1))
  }
  return words.length ? words.join(' ') : id
}
