#!/usr/bin/env node
/*
 * check-plaintext-leaks.mjs — canary guardrail (PLAN.md phase P5, defects A1 / A7 / B1)
 *
 * WHAT
 *   Scans built client output directories for a small list of "canary" plaintext
 *   strings that the client-side protection is supposed to hide. A verbatim match
 *   in a shipped bundle means the obfuscation leaked that string.
 *
 *   The canary list lives in scripts/canary-list.json (NOT in the bundle — PLAN A9).
 *
 * USAGE
 *   node scripts/check-plaintext-leaks.mjs [dir ...]
 *   node scripts/check-plaintext-leaks.mjs --self-test
 *
 *   With no dirs, it scans the default outputs that exist (ALL hard-fail):
 *     main/dist          (hard-fail)
 *     aws/dist/site      (hard-fail)
 *     singlefile/app     (hard-fail)
 *     svg/jsdelivr       (hard-fail)
 *   Missing dirs are skipped silently.
 *
 *   It walks .html / .js / .mjs / .css / .svg files under each dir. (.svg cloak
 *   shells embed the same inline string map as the HTML shells and are hard-fail
 *   like everything else; scripts/obfuscate-build.mjs obfuscates them in place.)
 *
 * EXIT-CODE POLICY (explicit)
 *   0  no leaks in any scanned dir.
 *   2  one or more canaries found in any scanned dir. Enforcement is ON by
 *      default — every build variant must ship clean, with no exceptions and no
 *      flag to disable it. The post-build obfuscator (scripts/obfuscate-build.mjs)
 *      is what makes the output clean.
 *   1  usage / IO error, or --self-test found the scanner itself is broken.
 *
 *   Every dir — default or explicitly passed, including singlefile/ and svg/ —
 *   is HARD-FAIL. (The earlier "informational" class for A7 deploy artifacts has
 *   been removed by user decision: no variant is exempt.)
 *
 * SELF-TEST (--self-test)
 *   Proves the scanner works, without touching any real build:
 *     1. writes a clean file (no canary) to a temp HARD dir -> expects 0 matches;
 *     2. writes a file containing a planted canary -> expects the scanner to flag
 *        it (a real scan of such a dir would exit 2).
 *   Exits 0 when the scanner behaves correctly on both, 1 if it is broken.
 *   Temp files are created under TMPDIR and removed afterwards.
 */

import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

const SCAN_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.wasm'])

// Default output dirs, relative to repo root (see PLAN.md section 3).
// All are hard-fail; no variant is exempt.
const DEFAULT_DIRS = ['main/dist', 'aws/dist/site', 'singlefile/app', 'svg/jsdelivr']

function loadCanaries() {
  const listPath = join(__dirname, 'canary-list.json')
  const parsed = JSON.parse(readFileSync(listPath, 'utf8'))
  const canaries = (parsed.canaries || []).map((c) => c.value).filter((v) => typeof v === 'string' && v.length > 0)
  if (canaries.length === 0) throw new Error(`no canaries loaded from ${listPath}`)
  return canaries
}

function* walkFiles(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      yield* walkFiles(full)
    } else if (st.isFile()) {
      const dot = name.lastIndexOf('.')
      const ext = dot >= 0 ? name.slice(dot) : ''
      if (SCAN_EXTENSIONS.has(ext)) yield full
    }
  }
}

// Scan one dir. Returns array of { file, canary } matches.
function scanDir(absDir, canaries) {
  const hits = []
  for (const file of walkFiles(absDir)) {
    let content
    try {
      // Binary wasm is compared as latin1 so ASCII names in its data/export strings match.
      content = file.endsWith('.wasm') ? readFileSync(file).toString('latin1') : readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const canary of canaries) {
      if (content.includes(canary)) hits.push({ file, canary })
    }
  }
  return hits
}

function runScan(dirArgs) {
  const canaries = loadCanaries()

  const dirs = (dirArgs.length > 0 ? dirArgs : DEFAULT_DIRS).map((d) => resolve(REPO_ROOT, d))

  let hardFailures = 0
  let scanned = 0

  for (const absDir of dirs) {
    if (!existsSync(absDir)) {
      if (dirArgs.length > 0) console.log(`skip (missing): ${relative(REPO_ROOT, absDir) || absDir}`)
      continue
    }
    scanned++
    const hits = scanDir(absDir, canaries)
    const rel = relative(REPO_ROOT, absDir) || absDir
    if (hits.length === 0) {
      console.log(`ok   [HARD-FAIL] ${rel} — no canaries`)
      continue
    }
    for (const { file, canary } of hits) {
      console.log(`LEAK [HARD-FAIL] ${relative(REPO_ROOT, file)} :: ${JSON.stringify(canary)}`)
    }
    hardFailures += hits.length
  }

  if (scanned === 0) {
    console.log('no output dirs present to scan — nothing to check')
    return 0
  }

  console.log('')
  console.log(`summary: ${hardFailures} leak(s) across ${scanned} dir(s)`)

  if (hardFailures > 0) {
    console.error('FAIL: plaintext canaries leaked into a shipped bundle.')
    return 2
  }
  console.log('PASS: no canaries in any scanned bundle.')
  return 0
}

function selfTest() {
  const canaries = loadCanaries()
  const canary = canaries[0]
  const tmp = mkdtempSync(join(tmpdir(), 'canary-selftest-'))
  let ok = true
  try {
    // 1. Clean file: expect no matches.
    writeFileSync(join(tmp, 'clean.js'), `export const x = ${JSON.stringify('nothing sensitive here')}\n`)
    const cleanHits = scanDir(tmp, canaries)
    if (cleanHits.length !== 0) {
      console.error(`self-test FAIL: scanner reported ${cleanHits.length} false match(es) on clean content`)
      ok = false
    } else {
      console.log('self-test: clean content -> 0 matches (correct)')
    }

    // 2. Planted canary: expect the scanner to catch it.
    writeFileSync(join(tmp, 'leaky.html'), `<!doctype html><title>oops ${canary} embedded</title>`)
    const hits = scanDir(tmp, canaries)
    const caught = hits.some((h) => h.canary === canary)
    if (caught) {
      console.log(`self-test: planted canary ${JSON.stringify(canary)} -> caught (a real scan of this dir would exit 2)`)
    } else {
      console.error('self-test FAIL: scanner did NOT catch the planted canary')
      ok = false
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  if (ok) {
    console.log('self-test PASS: scanner detects planted canaries and ignores clean content.')
    return 0
  }
  console.error('self-test FAIL: scanner is broken.')
  return 1
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) {
    process.exit(selfTest())
  }
  const dirArgs = args.filter((a) => !a.startsWith('--'))
  process.exit(runScan(dirArgs))
}

main()
