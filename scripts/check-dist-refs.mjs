#!/usr/bin/env node
// Dist reference verifier. Hard-fails (exit 2) when a shipped build:
//   1. references a file that is not on disk (HTML src/href, CSS url(),
//      JS string refs to assets, JSON refs such as the shield manifest's
//      `file` fields, sj*.html script srcs, runtime.wasm / scramjet paths);
//   2. emits a top-level assets/ file whose name is not a content hash;
//   3. contains a module-name token in a file name, in a file-name-shaped
//      reference (`<token>[-hash].js|css|...`), or as a bounded string in the
//      shield manifest.
//
// Usage: node scripts/check-dist-refs.mjs <dist-dir>
// There is no opt-out flag. Module-name tokens come from an explicit list of
// known leaks plus every source file stem under main/src (generic stems are
// skipped so vendored code cannot trip the check).

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const distArg = process.argv[2]
if (!distArg) {
  console.error('usage: node scripts/check-dist-refs.mjs <dist-dir>')
  process.exit(2)
}
const DIST = resolve(distArg)
if (!existsSync(DIST) || !statSync(DIST).isDirectory()) {
  console.error(`[check-dist-refs] dist directory not found: ${DIST}`)
  process.exit(2)
}

// --- module-name tokens ----------------------------------------------------
// Explicit list only. Source-derived stems were tried and rejected: generic
// words such as "search" also name shipped vendor files (vendor/discord/*.svg).
// Top-level emitted assets are instead held to the stricter content-hash rule.
const EXPLICIT_TOKENS = [
  'vendor-react', 'vendor-icons', 'vendor-markdown', 'rolldown-runtime',
  'scramjet', 'HolyText', 'AuthGate', 'avatar', 'browser',
  'codec', 'music', 'account', 'settings', 'tos', 'pricing', 'premium-success',
  'verify-email', 'main', 'sj-host', 'HolyProse', 'HolyDynamic', 'HolyRich',
]
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const TOKENS = [...new Set(EXPLICIT_TOKENS)]
const TOKEN_ALT = TOKENS.map(escapeRe).sort((a, b) => b.length - a.length).join('|')
// <token>[-anything].<ext> with no identifier character before the token.
const TOKEN_FILE_RE = new RegExp(`(?<![A-Za-z0-9_])(?:${TOKEN_ALT})(?:-[A-Za-z0-9_-]+)?\\.(?:js|mjs|cjs|css|html|json|wasm|map)(?![A-Za-z0-9_])`)
// Token as a whole word, optionally followed by a hash suffix (used for the
// manifest's JSON strings and keys, which may hold a bare name or a file name).
const TOKEN_BOUNDED_RE = new RegExp(`(?<![A-Za-z0-9_])(?:${TOKEN_ALT})(?:-[A-Za-z0-9_-]+)?(?![A-Za-z0-9_])`)

// --- inventory --------------------------------------------------------------
const allFiles = walk(DIST).map((full) => relative(DIST, full).split(sep).join(posix.sep))
const existing = new Set(allFiles)

const failures = []
const fail = (where, message) => failures.push(`${where}: ${message}`)

// --- reference resolution ---------------------------------------------------
const ASSET_EXT = /\.(?:js|mjs|cjs|css|wasm|woff2?|ttf|otf|png|jpe?g|gif|webp|svg|json|html|ico|map)$/i
function looksLikeAssetRef(value) {
  if (value.length === 0 || value.length > 300) return false
  if (/[\s*]|\$\{|:\/\/|^data:|^blob:/.test(value)) return false
  if (!ASSET_EXT.test(value)) return false
  return /^(\.{1,2}\/|\/|assets\/)/.test(value)
}

// Returns the dist-relative path a reference points at, or null when the
// reference is not local (external URL, data:, fragment).
function resolveRef(value, fromFile, mode) {
  const clean = value.split(/[?#]/)[0]
  if (clean === '' || /^(https?:|\/\/|data:|blob:|mailto:|javascript:|#)/i.test(clean)) return null
  if (clean.startsWith('/')) return posix.normalize(clean.slice(1))
  if (clean.startsWith('./') || clean.startsWith('../')) {
    return posix.normalize(posix.join(posix.dirname(fromFile), clean))
  }
  // Bare relative paths: JSON and JS string refs resolve from the dist root
  // (the shield loader resolves `file` against the dist root); HTML/CSS
  // bare refs resolve from the containing file.
  if (mode === 'root') return posix.normalize(clean)
  return posix.normalize(posix.join(posix.dirname(fromFile), clean))
}

function checkTarget(fromFile, value, mode, what) {
  const target = resolveRef(value, fromFile, mode)
  if (target === null) return
  if (target.startsWith('..')) { fail(fromFile, `${what} "${value}" escapes dist`); return }
  if (!existing.has(target)) fail(fromFile, `${what} "${value}" -> ${target} is missing from dist`)
}

function checkHtml(file, text) {
  for (const m of text.matchAll(/<[a-zA-Z][^>]*>/g)) {
    for (const attr of m[0].matchAll(/\s(src|href|poster|data-src)\s*=\s*["']([^"']+)["']/gi)) {
      const value = attr[2]
      if (/^(https?:|\/\/|data:|blob:|mailto:|javascript:|#)/i.test(value)) continue
      checkTarget(file, value, 'html', attr[1])
    }
  }
  for (const m of text.matchAll(/url\(\s*["']?([^"')]+?)["']?\s*\)/g)) checkTarget(file, m[1], 'html', 'url()')
}

function checkCss(file, text) {
  for (const m of text.matchAll(/url\(\s*["']?([^"')]+?)["']?\s*\)/g)) checkTarget(file, m[1], 'css', 'url()')
}

function checkJs(file, text) {
  // Quoted string literals (no interpolation). Each one that is shaped like an
  // asset path must exist: import("./x.js"), new URL("assets/..wasm", ...), etc.
  // Absolute paths outside /assets/ are not checked: the service worker's
  // virtual playground routes ("/style.css") and scramjet's fixture strings are
  // served from memory, not from dist.
  const re = /(["'`])((?:\\.|(?!\1)[^\\\n]){1,300}?)\1/g
  for (const m of text.matchAll(re)) {
    const value = m[2]
    if (!looksLikeAssetRef(value)) continue
    if (value.startsWith('/') && !value.startsWith('/assets/')) continue
    if (value.startsWith('assets/')) { checkTarget(file, value, 'root', 'js string'); continue }
    checkTarget(file, value, 'html', 'js string')
  }
}

function checkJson(file, text) {
  let data
  try { data = JSON.parse(text) } catch (error) {
    fail(file, `invalid JSON: ${error.message}`)
    return
  }
  const isManifest = file === 'shield-manifest.json'
  const visit = (node, keyPath) => {
    if (typeof node === 'string') {
      if (looksLikeAssetRef(node)) checkTarget(file, node, 'root', `json ${keyPath}`)
      if (TOKEN_FILE_RE.test(node)) fail(file, `module-name token in JSON file name at ${keyPath}`)
      if (isManifest && TOKEN_BOUNDED_RE.test(node)) fail(file, `module-name token in manifest string at ${keyPath}`)
      return
    }
    if (Array.isArray(node)) { node.forEach((v, i) => visit(v, `${keyPath}[${i}]`)); return }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (TOKEN_FILE_RE.test(key)) fail(file, `module-name token in JSON key "${key}"`)
        if (isManifest && TOKEN_BOUNDED_RE.test(key)) fail(file, `module-name token in manifest key "${key}"`)
        visit(value, `${keyPath}.${key}`)
      }
    }
  }
  visit(data, '$')
}

// --- run ----------------------------------------------------------------------
for (const rel of allFiles) {
  const full = join(DIST, ...rel.split(posix.sep))
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  if (TOKEN_FILE_RE.test(rel)) fail(rel, 'module-name token in emitted file name')
  if (TOKENS.some((t) => base === t || base.startsWith(t + '-') || base.startsWith(t + '.'))) {
    fail(rel, 'module-name token in emitted file name')
  }
  if (rel.startsWith('assets/') && rel.split('/').length === 2) {
    // Top-level emitted assets must be content-hash names (optionally s_<id>).
    if (!/^(?:s_)?[A-Za-z0-9_-]{6,12}\.[a-z0-9]+$/.test(base)) {
      fail(rel, 'emitted asset name is not a content hash')
    }
  }
  if (/\.html$/i.test(rel)) checkHtml(rel, readFileSync(full, 'utf8'))
  else if (/\.css$/i.test(rel)) checkCss(rel, readFileSync(full, 'utf8'))
  else if (/\.(?:m?js|cjs)$/i.test(rel)) {
    const text = readFileSync(full, 'utf8')
    checkJs(rel, text)
    if (TOKEN_FILE_RE.test(text)) {
      const hit = text.match(TOKEN_FILE_RE)
      fail(rel, `module-name token in shipped JS: ${JSON.stringify(hit[0])}`)
    }
  } else if (/\.json$/i.test(rel)) checkJson(rel, readFileSync(full, 'utf8'))
}

if (failures.length) {
  console.error(`[check-dist-refs] FAILED: ${failures.length} problem(s) in ${DIST}`)
  for (const line of failures) console.error('  - ' + line)
  process.exit(2)
}
console.log(`[check-dist-refs] OK: ${allFiles.length} files, every reference resolves, no module-name tokens (${TOKENS.length} tokens checked)`)
