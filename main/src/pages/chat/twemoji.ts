/* Twemoji rendering - the same library Discord uses (twemoji 16.0.1, jsDelivr
 * 72x72 PNGs), so every emoji glyph in the chat matches the real client.
 * We render <img> tags pointing at the Twemoji CDN rather than native glyphs,
 * which keeps cross-platform rendering identical (Discord's whole point). */

const TWEMOJI_BASE = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@16.0.1/assets/72x72'

/* The Twemoji CDN names ZWJ-sequence assets after the Unicode *fully-qualified*
 * form: U+FE0F is kept exactly after the components that need it - the
 * text-presentation-default symbols/arrows/gender signs (U+2194 ↔, U+2640 ♀, …)
 * and a handful of astral bases (U+1F3F3 🏳, U+1F636's fog, …) - but dropped
 * when a skin-tone modifier (U+1F3FB–U+1F3FF) intervenes, since the modifier
 * already forces emoji presentation (e.g. `1f3cb-fe0f-200d-2640-fe0f` but
 * `1f3cb-1f3fb-200d-2640-fe0f`).
 *
 * emoji-data.ts and raw user text both arrive under-qualified
 * (`1f642-200d-2194` 404s; the real file is `1f642-200d-2194-fe0f.png`), so
 * twemojiUrl() canonicalizes every codepoint through this set before building
 * a URL. The set below is exactly the components that carry FE0F across all
 * 3,846 twemoji@16.0.1 72x72 assets (validated as a fixpoint: normalizing any
 * real asset name returns it unchanged). U+1F441/U+1F5E8 are deliberately NOT
 * in the set: eye-in-speech-bubble ships only as `1f441-200d-1f5e8.png`. */
const FE0F_AFTER = new Set([
  0x1f32b, 0x1f3cb, 0x1f3cc, 0x1f3f3, 0x1f574, 0x1f575, 0x2194, 0x2195, 0x2620,
  0x2640, 0x2642, 0x2695, 0x2696, 0x26a7, 0x26d3, 0x26f9, 0x2708, 0x2744,
  0x2764, 0x27a1,
])
const SKIN_TONE = new Set([0x1f3fb, 0x1f3fc, 0x1f3fd, 0x1f3fe, 0x1f3ff])

/** Canonicalize a codepoint to the exact Twemoji asset filename (no extension). */
function normalizeCodepoint(codepoint: string): string {
  const cps: number[] = []
  for (const part of codepoint.toLowerCase().split('-')) {
    const cp = parseInt(part, 16)
    if (Number.isNaN(cp)) return codepoint
    cps.push(cp)
  }
  if (!cps.includes(0x200d)) {
    // No ZWJ: Twemoji strips every U+FE0F (single emoji, flags, keycaps, tag
    // flags are all stored unqualified). Pass anything else through untouched.
    return cps
      .filter((cp) => cp !== 0xfe0f)
      .map((cp) => cp.toString(16))
      .join('-')
  }
  // ZWJ sequence: rebuild the fully-qualified filename - FE0F after each
  // component in FE0F_AFTER, unless a skin-tone modifier follows it.
  const bare = cps.filter((cp) => cp !== 0xfe0f)
  const out: string[] = []
  for (let i = 0; i < bare.length; i++) {
    const cp = bare[i]
    out.push(cp.toString(16))
    const next = bare[i + 1]
    if (FE0F_AFTER.has(cp) && !(next !== undefined && SKIN_TONE.has(next))) {
      out.push('fe0f')
    }
  }
  return out.join('-')
}

/** CDN URL for a Twemoji codepoint (e.g. "1f600" or "1f1fa-1f1f8"). */
export function twemojiUrl(codepoint: string): string {
  return `${TWEMOJI_BASE}/${normalizeCodepoint(codepoint)}.png`
}

/** Build an <img class="emoji"> tag for a codepoint with alt text. If the CDN
 * 404s (asset we don't know about), swap to the native glyph so the message
 * still shows the emoji instead of a broken image. */
export function twemojiImg(codepoint: string, alt: string): string {
  const url = twemojiUrl(codepoint)
  const safeAlt = alt.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  // On a CDN 404, swap the broken <img> for a plain text node holding the
  // native glyph (a Text node can never re-parse as markup).
  return (
    `<img class="emoji" draggable="false" src="${url}" alt="${safeAlt}" ` +
    `onerror="this.replaceWith(document.createTextNode(this.alt))" />`
  )
}

/* Emoji matcher. The previous pattern used a broad `[ -㌀]` range that
 * swallowed the entire General Punctuation block (U+2000–U+206F) - em-dash -,
 * curly quotes “ ”, ellipsis …, arrows →, ™ - so ordinary prose punctuation was
 * rewritten into broken twemoji <img> tags (confirmed in the live capture: an
 * em-dash rendered as an image).
 *
 * The replacement follows the upstream jdecked/twemoji parser's approach: match
 * candidate emoji, then let shouldImageMatch() decide. It is built from three
 * branches:
 *   1. Astral (surrogate-pair) emoji - U+1F000–U+1FAFF etc. Always emoji.
 *      Includes optional trailing VS16 and ZWJ-chained sequences.
 *   2. Regional-indicator flags - two RI codepoints.
 *   3. Keycap sequences - #, *, 0-9 + optional VS16 + U+20E3.
 *   4. Legacy BMP candidates (U+203C–U+3299, ©, ®) with an OPTIONAL VS16.
 *      These are gated by shouldImageMatch(): a bare single BMP codepoint is
 *      only imaged when it is Emoji_Presentation-default; the whole General
 *      Punctuation block, ©, ®, ™, and the arrows are text-presentation-default
 *      and are passed through untouched unless an explicit U+FE0F follows.
 * Everything is written with explicit \u escapes (VS16 = U+FE0F, ZWJ = U+200D,
 * keycap = U+20E3) so there are no literal invisible characters in the source.
 */
const VS16 = '\\uFE0F'
const ZWJ = '\\u200D'
// The legacy BMP emoji candidate set, shared by the leading unit and each ZWJ
// continuation. Includes © (U+00A9) and ® (U+00AE) so their VS16 forms image;
// bare they are text (shouldImageMatch leaves a lone non-emoji-default BMP
// codepoint untouched). General Punctuation (U+2000–U+206F) is NOT present.
const BMP_UNIT =
  '[\\u00A9\\u00AE\\u203C-\\u2049\\u2122\\u2139\\u2194-\\u21AA\\u231A-\\u231B\\u2328\\u23CF\\u23E9-\\u23F3\\u23F8-\\u23FA\\u24C2\\u25AA-\\u25AB\\u25B6\\u25C0\\u25FB-\\u25FE\\u2600-\\u27BF\\u2934-\\u2935\\u2B05-\\u2B07\\u2B1B-\\u2B1C\\u2B50\\u2B55\\u3030\\u303D\\u3297\\u3299]'
const ASTRAL_UNIT =
  '(?:\\uD83C[\\uDC00-\\uDFFF]|\\uD83D[\\uDC00-\\uDFFF]|\\uD83E[\\uDC00-\\uDFFF])'
const EMOJI_RE = new RegExp(
  // 1. Regional-indicator flag FIRST (two RI codepoints U+1F1E6–U+1F1FF). It must
  //    precede the general branch so a flag reads as one codepoint pair, not two
  //    independent RI units (regex alternation is ordered).
  '\\uD83C[\\uDDE6-\\uDDFF]\\uD83C[\\uDDE6-\\uDDFF]' +
  '|' +
  // 2. Keycap sequence: # * 0-9, optional VS16, then U+20E3.
  '[#0-9*]' + VS16 + '?\\u20E3' +
  '|' +
  // 3. Astral emoji or legacy BMP unit, optionally VS16-terminated, optionally
  //    chained into ZWJ sequences. Each ZWJ segment can itself be astral or BMP.
  '(?:' +
    '(?:' + ASTRAL_UNIT + '|' + BMP_UNIT + ')' +
    VS16 + '?' +
    '(?:' + ZWJ + '(?:' + ASTRAL_UNIT + '|' + BMP_UNIT + ')' + VS16 + '?)*' +
  ')',
  'g',
)

/* Codepoints in the BMP range that default to EMOJI presentation (safe to image
 * bare, without a variation selector). Anything else in the BMP (including the
 * whole General Punctuation block, ©, ®, ™, ↔, …) is text-presentation-default
 * and must carry an explicit U+FE0F to be rendered as an image. This mirrors
 * Unicode's Emoji_Presentation property for the legacy BMP set. */
function isEmojiPresentationDefault(cp: number): boolean {
  return (
    (cp >= 0x203c && cp <= 0x203c) || // double exclamation ‼
    (cp >= 0x2049 && cp <= 0x2049) || // exclamation question ⁉
    (cp >= 0x231a && cp <= 0x231b) || // watch, hourglass
    (cp >= 0x23e9 && cp <= 0x23ec) || // media controls
    (cp === 0x23f0) ||                 // alarm clock
    (cp >= 0x23f1 && cp <= 0x23f2) || // stopwatch, timer
    (cp >= 0x25fd && cp <= 0x25fe) || // white/black medium-small squares
    (cp >= 0x2614 && cp <= 0x2615) || // umbrella with rain, hot beverage
    (cp >= 0x2648 && cp <= 0x2653) || // zodiac
    (cp === 0x267f) ||                 // wheelchair
    (cp === 0x2693) ||                 // anchor
    (cp === 0x26a1) ||                 // high voltage
    (cp >= 0x26aa && cp <= 0x26ab) || // white/black circle
    (cp >= 0x26bd && cp <= 0x26be) || // soccer, baseball
    (cp >= 0x26c4 && cp <= 0x26c5) || // snowman, sun behind cloud
    (cp === 0x26ce) ||                 // ophiuchus
    (cp === 0x26d4) ||                 // no entry
    (cp === 0x26ea) ||                 // church
    (cp >= 0x26f2 && cp <= 0x26f3) || // fountain, golf
    (cp === 0x26f5) ||                 // sailboat
    (cp === 0x26fa) ||                 // tent
    (cp === 0x26fd) ||                 // fuel pump
    (cp === 0x2702) ||                 // scissors
    (cp === 0x2705) ||                 // check mark
    (cp >= 0x2708 && cp <= 0x270d) || // airplane..writing hand
    (cp === 0x270f) ||                 // pencil
    (cp === 0x2712) ||                 // black nib
    (cp === 0x2714) ||                 // heavy check
    (cp === 0x2716) ||                 // heavy multiplication x
    (cp === 0x271d) ||                 // latin cross
    (cp === 0x2721) ||                 // star of David
    (cp === 0x2728) ||                 // sparkles
    (cp >= 0x2733 && cp <= 0x2734) || // eight-spoked/pointed asterisk
    (cp === 0x2744) ||                 // snowflake
    (cp === 0x2747) ||                 // sparkle
    (cp === 0x274c) ||                 // cross mark
    (cp === 0x274e) ||                 // negative squared cross mark
    (cp >= 0x2753 && cp <= 0x2755) || // question/exclamation
    (cp === 0x2757) ||                 // heavy exclamation
    (cp >= 0x2763 && cp <= 0x2764) || // heart exclamation, heavy heart
    (cp >= 0x2795 && cp <= 0x2797) || // heavy plus/minus/division
    (cp === 0x27a1) ||                 // right arrow
    (cp === 0x27b0) ||                 // curly loop
    (cp === 0x27bf) ||                 // double curly loop
    (cp >= 0x2934 && cp <= 0x2935) || // arrows
    (cp >= 0x2b05 && cp <= 0x2b07) || // left/up/down arrows
    (cp >= 0x2b1b && cp <= 0x2b1c) || // black/white large square
    (cp === 0x2b50) ||                 // star
    (cp === 0x2b55) ||                 // heavy large circle
    (cp === 0x3030) ||                 // wavy dash
    (cp === 0x303d) ||                 // part alternation mark
    (cp === 0x3297) ||                 // circled ideograph congratulation
    (cp === 0x3299)                    // circled ideograph secret
  )
}

/** Convert a unicode emoji string to its Twemoji codepoint filename. Follows
 * the upstream jdecked/twemoji convention: when the sequence contains a ZWJ
 * (U+200D) the variation selectors are left in place (the asset filename is
 * the fully-qualified form); without a ZWJ every U+FE0F is stripped. The
 * FE0F-placement canonicalization itself lives in twemojiUrl(), which every
 * caller routes through, so both picker entries and parsed text resolve to
 * real asset names. */
export function toCodepoint(sur: string): string {
  const cps: number[] = []
  for (let i = 0; i < sur.length; i++) {
    const c = sur.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < sur.length) {
      cps.push(0x10000 + ((c - 0xd800) << 10) + (sur.charCodeAt(i + 1) - 0xdc00))
      i++
    } else {
      cps.push(c)
    }
  }
  const hasZwj = cps.includes(0x200d)
  const kept = hasZwj ? cps : cps.filter((cp) => cp !== 0xfe0f)
  return kept.map((cp) => cp.toString(16)).join('-')
}

/* Decide whether a regex match should be imaged. Astral (surrogate-pair)
 * matches, ZWJ/keycap/flag/VS16 sequences, and bare BMP codepoints that are
 * Emoji_Presentation-default are imaged. A bare single BMP codepoint that is
 * text-presentation-default (©, ®, ™, ↔, the General Punctuation block, …) is
 * left as native text unless the match actually carries a VS16. */
function shouldImageMatch(match: string): boolean {
  const first = match.charCodeAt(0)
  // Astral (surrogate pair) => always a real emoji (flags and ZWJ chains start astral).
  if (first >= 0xd800 && first <= 0xdbff) return true
  // Keycap sequence or anything carrying a VS16/ZWJ/combining mark => emoji.
  if (match.length > 1) return true
  // Bare single BMP codepoint: image only if Emoji_Presentation-default.
  return isEmojiPresentationDefault(first)
}

/**
 * Replace native emoji characters in already-sanitized HTML text with Twemoji
 * <img> tags, matching how Discord swaps every unicode glyph for a Twemoji
 * image inside message content. Runs AFTER sanatize()/process() so we only
 * touch text, not tag markup - but we must not replace inside existing tags,
 * so we split on tag boundaries.
 */
export function twemojify(html: string): string {
  return html
    .split(/(<[^>]+>)/g)
    .map((part) =>
      part.startsWith('<')
        ? part
        : part.replace(EMOJI_RE, (ch) =>
            shouldImageMatch(ch) ? twemojiImg(toCodepoint(ch), ch) : ch,
          ),
    )
    .join('')
}
