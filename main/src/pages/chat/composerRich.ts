/* Rich composer helpers - the contenteditable message input renders PICKED
 * emoji and mentions as inline, non-editable chips (Discord-style), while the
 * wire format stays the plain token string the bridge expects.
 *
 *   emoji  → <img class="emoji" contenteditable="false" data-surrogates="😂">
 *   mention→ <span class="mention" contenteditable="false"
 *                  data-token="<@123>">@Name</span>
 *
 * serializeComposer() walks the live DOM and folds every chip back to its
 * token form (<br>/block boundaries become '\n', matching what Discord sends
 * for shift+Enter), so submit() ships exactly the string plain-text typing
 * would have produced. Typed text stays plain - there is no typed-:name:
 * conversion (deferred: too fragile around the caret for this pass).
 */

import { twemojiUrl } from './twemoji'
import type { EmojiEntry } from './emoji-data'

/** True for a chip node the serializer folds back to a token. */
function isEmojiChip(node: Node): node is HTMLImageElement {
  return (
    node instanceof HTMLImageElement &&
    node.classList.contains('emoji') &&
    typeof node.dataset.surrogates === 'string'
  )
}

function isMentionChip(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && typeof node.dataset.token === 'string'
}

/** A block-level wrapper the browser creates for Enter inside the editable. */
function isBlockBoundary(node: Node): node is HTMLElement {
  return (
    node instanceof HTMLElement &&
    (node.tagName.toUpperCase() === 'DIV' || node.tagName.toUpperCase() === 'P')
  )
}

/**
 * Serialize the composer DOM to the plain string the bridge expects:
 * emoji chips → their unicode surrogates (what picked emoji inserted before
 * the rich input), mention chips → their literal token (<@id> / <@&id> /
 * <#id> / @everyone / @here), <br> and block boundaries → '\n', text → text.
 */
export function serializeComposer(root: HTMLElement): string {
  const walk = (node: Node): string => {
    // contenteditable turns spaces beside chips / at line ends into NBSP
    // (U+00A0) to keep them visible; Discord's slate sends plain spaces.
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent || '').replace(/\u00a0/g, ' ')
    if (isEmojiChip(node)) return node.dataset.surrogates || ''
    if (isMentionChip(node)) return node.dataset.token || ''
    if (node instanceof HTMLBRElement) return '\n'
    if (isBlockBoundary(node)) {
      const inner = Array.from(node.childNodes).map(walk).join('')
      // Chrome pads empty lines with <div><br></div>; the <br> walk already
      // yields the '\n', so don't double-count it. A non-empty block gets a
      // leading break to separate it from the previous line.
      return inner === '\n' ? inner : `\n${inner}`
    }
    return Array.from(node.childNodes).map(walk).join('')
  }
  // The leading '\n' belongs to line 2+, not the first block.
  return Array.from(root.childNodes).map(walk).join('').replace(/^\n/, '')
}

/** Serialized length - drives the send button + 2000-char counter. */
export function composerLength(root: HTMLElement): number {
  return serializeComposer(root).length
}

/**
 * The caret's offset into the SERIALIZED text (the same string
 * serializeComposer returns), or null when the selection is outside `root`.
 * Chips count as their token/surrogates length and are skipped atomically -
 * chip label text never leaks into the trigger/query detection the way it
 * would with raw textContent offsets (typing right after a mention chip could
 * otherwise re-open the autocomplete on the chip's label).
 */
export function serializedCaretOffset(root: HTMLElement): number | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!root.contains(range.startContainer)) return null
  const anchorNode = range.startContainer
  const anchorOffset = range.startOffset
  let found = false

  const walk = (node: Node, acc: number): number => {
    if (found) return acc
    if (node === anchorNode) {
      found = true
      // Anchor inside a text node: acc + clamped offset. Anchor on an element
      // (the root itself between chips): count the child nodes before
      // anchorOffset by walking them through the same model.
      if (node.nodeType === Node.TEXT_NODE) {
        return acc + Math.min(anchorOffset, (node.textContent || '').length)
      }
      let sum = acc
      const children = Array.from(node.childNodes).slice(0, anchorOffset)
      for (const child of children) sum = walk(child, sum)
      return sum
    }
    if (node.nodeType === Node.TEXT_NODE) return acc + (node.textContent || '').length
    if (isEmojiChip(node)) return acc + (node.dataset.surrogates || '').length
    if (isMentionChip(node)) return acc + (node.dataset.token || '').length
    if (node instanceof HTMLBRElement) return acc + 1
    if (isBlockBoundary(node)) {
      const inner = Array.from(node.childNodes).reduce((a, c) => walk(c, a), 0)
      return acc + (inner === 1 ? 1 : 1 + inner)
    }
    return Array.from(node.childNodes).reduce((a, c) => walk(c, a), acc)
  }

  const raw = Array.from(root.childNodes).reduce((a, c) => walk(c, a), 0)
  if (!found) return null
  // serializeComposer strips one leading '\n' when the first child is a
  // non-empty block; shift the caret into the same frame.
  const first = root.firstChild
  const leadingStrip = first && isBlockBoundary(first) && virtualLength(first) !== 1 ? 1 : 0
  return Math.max(0, raw - leadingStrip)
}

/** True when the composer holds no text and no chips (placeholder shows). */
export function composerIsEmpty(root: HTMLElement): boolean {
  return serializeComposer(root).trim() === ''
}

/** Park the caret right after `node`, inside `root`, and refocus. */
function placeCaretAfter(node: Node): void {
  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  range.setStartAfter(node)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
}

/**
 * Insert nodes at the saved/current caret. Falls back to appending at the end
 * when the selection is outside the editable (e.g. the expression picker took
 * focus). Returns the last inserted node so the caller can park the caret.
 */
function insertAtCaret(root: HTMLElement, nodes: Node[]): Node {
  const sel = window.getSelection()
  let range: Range | null = null
  if (sel && sel.rangeCount > 0) {
    const candidate = sel.getRangeAt(0)
    if (root.contains(candidate.commonAncestorContainer)) range = candidate
  }
  if (!range) {
    range = document.createRange()
    range.selectNodeContents(root)
    range.collapse(false)
  }
  range.deleteContents()
  let last: Node = nodes[nodes.length - 1]
  for (const node of nodes) {
    range.insertNode(node)
    range.setStartAfter(node)
    range.collapse(true)
    last = node
  }
  return last
}

/**
 * Insert a picked emoji as an inline Twemoji chip + trailing space at the
 * caret, then park the caret after the space so typing continues naturally.
 * `entry` carries the surrogates (wire form) and the Twemoji codepoint.
 */
export function insertEmojiChip(root: HTMLElement, entry: EmojiEntry): void {
  const img = emojiChip(entry)
  const space = document.createTextNode(' ')
  insertAtCaret(root, [img, space])
  placeCaretAfter(space)
  root.focus()
  normalizeEmpty(root)
}

export interface MentionChipSpec {
  /** The exact wire token: '<@id>' / '<@&id>' / '<#id>' / '@everyone' / '@here'. */
  token: string
  /** The chip label, e.g. '@Display Name' / '#channel' / '@everyone'. */
  label: string
}

/**
 * Replace the live mention query (the '@…'/'#…' text the user typed, located
 * by text offsets from the trigger tracker) with a non-editable mention chip
 * + trailing space, then park the caret after the space.
 *
 * Offsets are into the SERIALIZED text - the same frame updateMentionTrigger
 * measures in via serializeComposer/serializedCaretOffset. Chips are skipped
 * atomically while mapping (a chip counts as its token length, never its
 * label), so a trigger span always lands in plain typed text and chip label
 * text can't leak into the query.
 */
export function insertMentionChip(
  root: HTMLElement,
  start: number,
  end: number,
  spec: MentionChipSpec,
): void {
  const range = rangeFromSerializedOffsets(root, start, end)
  const chip = document.createElement('span')
  chip.className = 'mention'
  chip.contentEditable = 'false'
  chip.dataset.token = spec.token
  chip.textContent = spec.label
  const space = document.createTextNode(' ')
  if (range) {
    range.deleteContents()
    range.insertNode(chip)
    // Insert the trailing space AFTER the chip (range start still precedes it).
    range.setStartAfter(chip)
    range.collapse(true)
    range.insertNode(space)
  } else {
    // Fallback: offsets went stale (shouldn't happen) - append at the end.
    root.append(chip, space)
  }
  placeCaretAfter(space)
  root.focus()
  normalizeEmpty(root)
}

/**
 * Replace a serialized [start, end) span (an emoji autocomplete query such as
 * ':smi', or a completed ':smile:') with an emoji chip, then park the caret
 * after it. `trailingSpace` mirrors Discord: picking from the autocomplete
 * appends a space; the in-place shortcode conversion does not.
 */
export function replaceWithEmojiChip(
  root: HTMLElement,
  start: number,
  end: number,
  entry: EmojiEntry,
  trailingSpace = true,
): void {
  const range = rangeFromSerializedOffsets(root, start, end)
  const img = emojiChip(entry)
  const tail: Node = trailingSpace ? document.createTextNode(' ') : img
  if (range) {
    range.deleteContents()
    range.insertNode(img)
    if (trailingSpace) {
      range.setStartAfter(img)
      range.collapse(true)
      range.insertNode(tail)
    }
  } else {
    root.append(img)
    if (trailingSpace) root.append(tail)
  }
  placeCaretAfter(tail)
  root.focus()
}

/** A non-editable Twemoji chip for `entry` (the composer's emoji node). */
function emojiChip(entry: EmojiEntry): HTMLImageElement {
  const [name, surrogates, , codepoint] = entry
  const img = document.createElement('img')
  img.className = 'emoji'
  img.src = twemojiUrl(codepoint)
  img.alt = surrogates
  img.title = `:${name}:`
  img.draggable = false
  img.contentEditable = 'false'
  img.dataset.surrogates = surrogates
  img.dataset.name = name
  return img
}

export interface HydrateLookup {
  /** The message's resolved mentions (user/role/channel names). */
  mentions?: Array<{ type: string; id: string; username?: string; name?: string }>
  /** Channel name for a '<#id>' token not covered by `mentions`. */
  channelName?: (id: string) => string | undefined
  /** Unicode emoji catalog used to turn glyphs back into chips. */
  emoji?: readonly EmojiEntry[]
}

let emojiBySurrogates: Map<string, EmojiEntry> | null = null
let emojiCatalogRef: readonly EmojiEntry[] | null = null
function emojiLookup(catalog: readonly EmojiEntry[]): Map<string, EmojiEntry> {
  if (emojiBySurrogates && emojiCatalogRef === catalog) return emojiBySurrogates
  const map = new Map<string, EmojiEntry>()
  for (const entry of catalog) {
    if (!map.has(entry[1])) map.set(entry[1], entry)
    const bare = entry[1].replace(/️/g, '')
    if (!map.has(bare)) map.set(bare, entry)
  }
  emojiBySurrogates = map
  emojiCatalogRef = catalog
  return map
}

/**
 * Fill a rich editor with an existing message's raw content (Discord's edit
 * mode opens the slate with the message already "rich"): mention tokens
 * become mention chips labelled from the message's resolved mentions, unicode
 * emoji become Twemoji chips, '\n' becomes <br>, everything else stays text.
 * serializeComposer(root) round-trips back to the original string.
 */
export function hydrateComposer(root: HTMLElement, content: string, lookup: HydrateLookup = {}): void {
  root.textContent = ''
  const mentions = lookup.mentions || []
  const emojiMap = lookup.emoji ? emojiLookup(lookup.emoji) : null
  const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null
  const appendText = (text: string) => {
    if (!text) return
    if (!emojiMap || !segmenter) { root.append(document.createTextNode(text)); return }
    let run = ''
    for (const { segment } of segmenter.segment(text)) {
      const entry = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment)
        ? emojiMap.get(segment) || emojiMap.get(segment.replace(/️/g, ''))
        : undefined
      // Keep the exact source glyph as the wire form so an untouched edit
      // round-trips byte-for-byte (FE0F presence included).
      if (entry) {
        if (run) { root.append(document.createTextNode(run)); run = '' }
        root.append(emojiChip([entry[0], segment, entry[2], entry[3]]))
      } else {
        run += segment
      }
    }
    if (run) root.append(document.createTextNode(run))
  }
  const chip = (token: string, label: string) => {
    const span = document.createElement('span')
    span.className = 'mention'
    span.contentEditable = 'false'
    span.dataset.token = token
    span.textContent = label
    root.append(span)
  }
  const re = /<@!?(\d+)>|<@&(\d+)>|<#(\d+)>|\n/g
  let last = 0
  for (let m = re.exec(content); m; m = re.exec(content)) {
    appendText(content.slice(last, m.index))
    last = m.index + m[0].length
    if (m[0] === '\n') { root.append(document.createElement('br')); continue }
    if (m[1]) {
      const hit = mentions.find((x) => x.type === 'user' && x.id === m![1])
      if (hit) chip(m[0], `@${hit.username || hit.name || m[1]}`)
      else appendText(m[0])
    } else if (m[2]) {
      const hit = mentions.find((x) => x.type === 'role' && x.id === m![2])
      if (hit) chip(m[0], `@${hit.name || hit.username || m[2]}`)
      else appendText(m[0])
    } else if (m[3]) {
      const hit = mentions.find((x) => x.type === 'channel' && x.id === m![3])
      const name = hit?.name || lookup.channelName?.(m[3])
      if (name) chip(m[0], `#${name}`)
      else appendText(m[0])
    }
  }
  appendText(content.slice(last))
}

/** The serialized length one node contributes (mirror of serializeComposer). */
function virtualLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent || '').length
  if (isEmojiChip(node)) return (node.dataset.surrogates || '').length
  if (isMentionChip(node)) return (node.dataset.token || '').length
  if (node instanceof HTMLBRElement) return 1
  if (isBlockBoundary(node)) {
    const inner = Array.from(node.childNodes).reduce((n, c) => n + virtualLength(c), 0)
    return inner === 1 ? 1 : 1 + inner
  }
  return Array.from(node.childNodes).reduce((n, c) => n + virtualLength(c), 0)
}

/** Child index of `node` within its parent (for element-boundary positions). */
function childIndex(node: Node): number {
  return Array.prototype.indexOf.call(node.parentNode!.childNodes, node)
}

/**
 * Map a [start, end) span in the serialized text to a DOM Range. Text nodes
 * map directly; chips count as their token/surrogates length and are skipped
 * atomically (an endpoint falling inside a chip clamps to its boundary - the
 * trigger regex never produces such a span, so this is purely defensive).
 * <br>/block boundaries count as one '\n', mirroring serializeComposer, whose
 * leading-'\n' strip shifts the whole frame back by one when it applies.
 */
function rangeFromSerializedOffsets(root: HTMLElement, start: number, end: number): Range | null {
  const leadingStrip = (() => {
    const first = root.firstChild
    if (!first || !isBlockBoundary(first)) return 0
    const inner = Array.from(first.childNodes).reduce((n, c) => n + virtualLength(c), 0)
    return inner === 1 ? 0 : 1
  })()
  const from = start + leadingStrip
  const to = end + leadingStrip

  // Held in a mutable object rather than two bare `let`s: the positions are only
  // ever assigned inside the `visit` closure, so TypeScript's control-flow
  // analysis would narrow the outer `let`s to `never` after the root loop.
  // Property reads on an object sidestep that narrowing.
  const pos: { start: { node: Node; offset: number } | null; end: { node: Node; offset: number } | null } = {
    start: null,
    end: null,
  }
  let acc = 0

  const visit = (node: Node): boolean => {
    if (pos.end) return true
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node.textContent || '').length
      if (!pos.start && from <= acc + len) pos.start = { node, offset: from - acc }
      if (pos.start && to <= acc + len) { pos.end = { node, offset: to - acc }; return true }
      acc += len
      return false
    }
    if (isEmojiChip(node) || isMentionChip(node) || node instanceof HTMLBRElement) {
      const len = virtualLength(node)
      if (!pos.start && from < acc + len) {
        pos.start = { node: node.parentNode as Node, offset: childIndex(node) }
      }
      if (pos.start && to <= acc + len) {
        pos.end = { node: node.parentNode as Node, offset: childIndex(node) + 1 }
        return true
      }
      acc += len
      return false
    }
    if (isBlockBoundary(node)) {
      const inner = Array.from(node.childNodes).reduce((n, c) => n + virtualLength(c), 0)
      if (inner === 1) {
        if (!pos.start && from < acc + 1) {
          pos.start = { node: node.parentNode as Node, offset: childIndex(node) }
        }
        if (pos.start && to <= acc + 1) {
          pos.end = { node: node.parentNode as Node, offset: childIndex(node) + 1 }
          return true
        }
        acc += 1
        return false
      }
      acc += 1 // the block's leading '\n'
      if (!pos.start && from <= acc) pos.start = { node, offset: 0 }
      for (const child of Array.from(node.childNodes)) {
        if (visit(child)) return true
      }
      if (pos.start && !pos.end && to <= acc) { pos.end = { node, offset: node.childNodes.length }; return true }
      return false
    }
    for (const child of Array.from(node.childNodes)) {
      if (visit(child)) return true
    }
    return false
  }

  for (const child of Array.from(root.childNodes)) {
    if (visit(child)) break
  }
  if (!pos.start || !pos.end) return null
  const range = document.createRange()
  range.setStart(pos.start.node, pos.start.offset)
  range.setEnd(pos.end.node, pos.end.offset)
  return range
}

/**
 * Restore the truly-empty state: a composer holding only whitespace / a stray
 * <br> (what's left after the last chip is deleted) is cleared outright so the
 * :empty CSS placeholder reappears. Chips and real text are untouched.
 */
export function normalizeEmpty(root: HTMLElement): void {
  if (composerIsEmpty(root)) {
    root.textContent = ''
  }
}

/**
 * Paste as plain text: strip the clipboard's HTML flavor and insert only the
 * text at the caret, so rich pastes can't inject markup into the editable.
 */
export function pastePlainText(e: ClipboardEvent, root: HTMLElement): void {
  e.preventDefault()
  const text = e.clipboardData?.getData('text/plain') || ''
  if (!text) return
  const nodes: Node[] = []
  // Preserve pasted newlines as <br> so multi-line pastes keep their shape
  // (the serializer folds <br> back to '\n' on send).
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    if (i > 0) nodes.push(document.createElement('br'))
    if (line) nodes.push(document.createTextNode(line))
  })
  const last = insertAtCaret(root, nodes)
  placeCaretAfter(last)
  root.focus()
  // Programmatic insertion fires no input event - nudge React manually.
  root.dispatchEvent(new Event('input', { bubbles: true }))
}
