import { holyDecrypt, isLikelyBot } from './holy-decrypt'
import { getObfuscatedCiphertext } from './obfuscated-strings'

// Shared, DOM-free primitives for the HolyText family (HolyText, HolyRich,
// HolyProse, useHolyAttr/HolyInput). Keeping the resolve/placeholder logic in
// one pure module means every variant treats the registry, decrypt failures and
// the bot tripwire identically, and the logic is unit-testable without a DOM.

/**
 * Build the dash placeholder shown before JS reveals the real text (and the
 * value a naive scraper of the shipped HTML / pre-hydration a11y tree sees).
 * Whitespace is preserved verbatim so the placeholder keeps the word shape and
 * wrapping of the real string; every other code point becomes a dash.
 */
export function makeDashPlaceholder(text: string): string {
  if (!text) return '---'
  return Array.from(text)
    .map((c) => (/\s/.test(c) ? c : '-'))
    .join('')
}

/**
 * Look up the ciphertext for a string: an explicit `encrypted` prop wins,
 * otherwise the build-time registry (window.__ABULXT_STRINGS__ / local). When a
 * string is not registered this returns undefined and callers fall back to
 * rendering the plaintext into the shadow/light DOM (same as today).
 */
export function cipherFor(content: string, encrypted?: string): string | undefined {
  return encrypted || getObfuscatedCiphertext(content)
}

export type HolyResolution =
  | { kind: 'reveal'; plaintext: string }
  | { kind: 'keep' }

export interface ResolveOptions {
  /**
   * Reveal even when the bot tripwire fires. Default false: likely bots keep
   * the dash placeholder, matching HolyText's long-standing behaviour.
   */
  revealForBots?: boolean
}

/**
 * Decide what a Holy* host should display. Mirrors HolyText's original gate so
 * every variant behaves the same:
 *   1. likely bot  -> keep the dash placeholder (never reveal).
 *   2. registered string whose decrypt fails (no key / error) -> keep dashes,
 *      rather than blanking to an empty reveal.
 *   3. otherwise reveal: the decrypted plaintext, or the raw content when the
 *      string was never registered (unobfuscated fallback).
 */
export function resolveHoly(
  content: string,
  cipher: string | undefined,
  opts?: ResolveOptions,
): HolyResolution {
  if (isLikelyBot() && !opts?.revealForBots) return { kind: 'keep' }
  const plaintext = cipher ? holyDecrypt(cipher) : content
  if (cipher && !plaintext) return { kind: 'keep' }
  return { kind: 'reveal', plaintext }
}

/**
 * CSS injected into a HolyText shadow root in `ellipsis` mode. `text-overflow`,
 * `white-space` and `overflow` are non-inherited, so they never cross the
 * shadow boundary from the host; this styles the shadow-internal container
 * directly so the revealed text truncates exactly as a plain label would.
 */
export const ELLIPSIS_SHADOW_CSS =
  '.holy-ellipsis{display:block;max-width:100%;overflow:hidden;' +
  'text-overflow:ellipsis;white-space:nowrap}'
