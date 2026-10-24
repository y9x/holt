// Code-block syntax highlighting, Discord style.
//
// Discord's markup codeBlock rule (web.js module 247186) renders a block
// plain first and swaps in highlight.js output once its lazily-loaded
// highlighter chunk arrives: `t.hasLanguage(lang) ? t.highlight(lang, code,
// true) : plain`, with `<code class="scrollbarGhostHairline hljs {language}">`.
// This module mirrors that: the grammar bundle (hljs-languages.ts) is a
// dynamic import, `highlightCode()` returns null until it has loaded, and
// `useHighlighterReady()` re-renders the caller when it lands.
//
// ```ansi blocks go through Discord's own "ansi" grammar instead (it is not a
// highlight.js core language): SGR escape sequences become hidden
// .hljs-ansi-control-sequence spans and the text they style is wrapped in
// .hljs-ansi-{style,foreground,background}-* classes (Discord's CSS, ported in
// codeblock.css). That path is synchronous and needs no grammar bundle.

import { useEffect, useSyncExternalStore } from 'react'
import type { HLJSApi } from 'highlight.js'

let hljs: HLJSApi | null = null
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

function load(): void {
  if (hljs || loading) return
  loading = import('./hljs-languages')
    .then((mod) => {
      hljs = mod.default
      for (const fn of listeners) fn()
    })
    .catch(() => {
      // Chunk failed (offline / stale deploy): code blocks stay plain, like
      // Discord's renderFallback. Allow a later retry.
      loading = null
    })
}

export function highlighterReady(): boolean {
  return hljs !== null
}

// Kick off the grammar download (idempotent). Called by the renderer the
// first time it meets a fenced block with a language tag.
export function ensureHighlighter(): void {
  load()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

// Re-render hook: returns true once the grammars are available. `wanted`
// gates both the download and the re-render, so only messages that contain a
// code block pay for it.
export function useHighlighterReady(wanted: boolean): boolean {
  const ready = useSyncExternalStore(subscribe, () => wanted && hljs !== null)
  useEffect(() => {
    if (wanted) load()
  }, [wanted])
  return ready
}

// Highlight `code` as `lang`. Returns { html, language } (html is escaped
// highlight.js markup) or null when the language is unknown or the grammar
// bundle hasn't loaded yet - the caller then renders the block plain.
export function highlightCode(lang: string, code: string): { html: string; language: string } | null {
  if (!lang) return null
  if (lang.toLowerCase() === 'ansi') return { html: ansiToHtml(code), language: 'ansi' }
  if (!hljs) {
    load()
    return null
  }
  if (!hljs.getLanguage(lang)) return null
  try {
    const result = hljs.highlight(code, { language: lang, ignoreIllegals: true })
    return { html: result.value, language: result.language || lang }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// ANSI (Discord's "ansi" grammar)
// ---------------------------------------------------------------------------

const ANSI_COLORS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
// ESC [ params m - Discord colors only SGR ("m") sequences; anything else is
// left as literal text.
const SGR_RE = new RegExp(`${String.fromCharCode(27)}\\[([0-9;]*)m`, 'g')

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
}

export function ansiToHtml(code: string): string {
  let bold = false
  let underline = false
  let fg: string | null = null
  let bg: string | null = null
  let out = ''
  let last = 0
  const emitText = (text: string) => {
    if (!text) return
    const classes: string[] = []
    if (bold) classes.push('hljs-ansi-style-bold')
    if (underline) classes.push('hljs-ansi-style-underline')
    if (fg) classes.push(`hljs-ansi-foreground-${fg}`)
    if (bg) classes.push(`hljs-ansi-background-${bg}`)
    out += classes.length ? `<span class="${classes.join(' ')}">${escapeHtml(text)}</span>` : escapeHtml(text)
  }
  SGR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SGR_RE.exec(code)) !== null) {
    emitText(code.slice(last, m.index))
    last = m.index + m[0].length
    out += `<span class="hljs-ansi-control-sequence">${escapeHtml(m[0])}</span>`
    const params = m[1] === '' ? [0] : m[1].split(';').map((p) => (p === '' ? 0 : Number(p)))
    for (const p of params) {
      if (p === 0) { bold = false; underline = false; fg = null; bg = null }
      else if (p === 1) bold = true
      else if (p === 4) underline = true
      else if (p === 22) bold = false
      else if (p === 24) underline = false
      else if (p >= 30 && p <= 37) fg = ANSI_COLORS[p - 30]
      else if (p === 39) fg = null
      else if (p >= 40 && p <= 47) bg = ANSI_COLORS[p - 40]
      else if (p === 49) bg = null
    }
  }
  emitText(code.slice(last))
  return out
}
