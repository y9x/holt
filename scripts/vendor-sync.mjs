// Vendor sync for the client-protection pipeline borrowed from abulxt.
//
// The files in scripts/vendor-manifest.json live at the SAME path in both repos and must stay
// byte-identical, the way roles/edge_firewall is shared between abulxt and KrunkNative. Edit the
// abulxt copy, then pull it here; never patch a vendored file in holt alone.
//
//   node scripts/vendor-sync.mjs --check   exit 1 when any copy differs or is missing (CI gate)
//   node scripts/vendor-sync.mjs --pull    copy every listed file from ABULXT_DIR into holt
//
// ABULXT_DIR defaults to ../abulxt next to this repo. The abulxt commit the copies came from is
// recorded in VENDOR.md by --pull.

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ABULXT_DIR = resolve(process.env.ABULXT_DIR || resolve(REPO_ROOT, '..', 'abulxt'))
const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'scripts/vendor-manifest.json'), 'utf8'))
const mode = process.argv[2]

if (mode !== '--check' && mode !== '--pull') {
  console.error('usage: node scripts/vendor-sync.mjs --check | --pull')
  process.exit(2)
}
if (!existsSync(ABULXT_DIR)) {
  console.error(`vendor-sync: abulxt checkout not found at ${ABULXT_DIR} (set ABULXT_DIR)`)
  process.exit(2)
}

let differ = 0
for (const file of [...manifest.files, ...(manifest.botShared ?? [])]) {
  const from = resolve(ABULXT_DIR, file)
  const to = resolve(REPO_ROOT, file)
  if (!existsSync(from)) {
    console.error(`missing in abulxt: ${file}`)
    differ++
    continue
  }
  if (mode === '--pull') {
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
    continue
  }
  if (!existsSync(to)) {
    console.error(`missing in holt:   ${file}`)
    differ++
  } else if (!readFileSync(from).equals(readFileSync(to))) {
    console.error(`differs:           ${file}`)
    differ++
  }
}

if (mode === '--pull') {
  let commit = 'unknown'
  try {
    commit = execFileSync('git', ['-C', ABULXT_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch { /* no git in the abulxt checkout; keep unknown */ }
  const path = resolve(REPO_ROOT, 'VENDOR.md')
  const text = readFileSync(path, 'utf8').replace(/^Vendored from abulxt commit `[^`]*`/m, `Vendored from abulxt commit \`${commit}\``)
  writeFileSync(path, text)
  console.log(`vendor-sync: pulled ${manifest.files.length + (manifest.botShared ?? []).length} files from ${ABULXT_DIR} @ ${commit.slice(0, 8)}`)
  process.exit(differ ? 1 : 0)
}

if (differ) {
  console.error(`vendor-sync: ${differ} file(s) out of sync with ${ABULXT_DIR}`)
  process.exit(1)
}
console.log(`vendor-sync: ${manifest.files.length + (manifest.botShared ?? []).length} vendored files match abulxt`)
