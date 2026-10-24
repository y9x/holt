#!/usr/bin/env node
// shield P1 baseline: per-chunk sizes + an AST-node-kind histogram of the real
// built bundle. No deploy, no network. Reads main/dist (does NOT build).
//
// Usage:
//   node scripts/shield-baseline.mjs [distDir]
//
// Default distDir = main/dist. After `npm run build` in main/, re-run to
// capture fresh numbers. The output JSON records whether the dist was fresh.
//
// acorn is resolved from main/node_modules (it is a transitive dep of
// vite/rollup and a direct parser we reuse for the compiler).

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import zlib from 'node:zlib'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const mainDir = path.join(repoRoot, 'main')
const require = createRequire(path.join(mainDir, 'package.json'))
const acorn = require('acorn')

const distDir = path.resolve(process.argv[2] || path.join(mainDir, 'dist'))
const assetsDir = path.join(distDir, 'assets')

function listJs(dir) {
  const out = []
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name)
      const st = fs.statSync(full)
      if (st.isDirectory()) walk(full)
      else if (name.endsWith('.js')) out.push(full)
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return out
}

function gzipSize(buf) {
  return zlib.gzipSync(buf, { level: 9 }).length
}

// Manual AST walker: count every node `.type`. Avoids an acorn-walk dependency.
function countNodeTypes(ast, counts) {
  const stack = [ast]
  while (stack.length) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') continue
    if (Array.isArray(node)) { for (const c of node) stack.push(c); continue }
    if (typeof node.type === 'string') counts[node.type] = (counts[node.type] || 0) + 1
    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue
      const v = node[k]
      if (v && typeof v === 'object') stack.push(v)
    }
  }
}

function parse(src) {
  for (const sourceType of ['module', 'script']) {
    try { return acorn.parse(src, { ecmaVersion: 'latest', sourceType, allowReturnOutsideFunction: true }) }
    catch (_) { /* try next */ }
  }
  return null
}

const files = listJs(distDir).sort()
if (files.length === 0) {
  console.error(`No .js found under ${distDir}. Run \`npm run build\` in main/ first, or pass a dist dir.`)
  process.exit(1)
}

const distMtime = fs.statSync(distDir).mtime.toISOString()
const chunks = []
const histogram = {}
let totalRaw = 0, totalGzip = 0, parseFailures = 0, totalNodes = 0

for (const file of files) {
  const buf = fs.readFileSync(file)
  const raw = buf.length
  const gz = gzipSize(buf)
  totalRaw += raw; totalGzip += gz
  const ast = parse(buf.toString('utf8'))
  let nodes = 0
  if (ast) {
    const before = { ...histogram }
    countNodeTypes(ast, histogram)
    // compute per-chunk node total
    nodes = Object.keys(histogram).reduce((s, k) => s + (histogram[k] - (before[k] || 0)), 0)
    totalNodes += nodes
  } else {
    parseFailures++
  }
  chunks.push({
    file: path.relative(distDir, file),
    rawBytes: raw,
    gzipBytes: gz,
    parsed: !!ast,
    astNodes: nodes,
  })
}

const topNodes = Object.entries(histogram).sort((a, b) => b[1] - a[1])

const result = {
  tool: 'shield-baseline',
  generatedAt: new Date().toISOString(),
  distDir,
  distMtime,
  freshBuildThisRun: false,
  note: 'Ran against the dist already on disk; this was NOT a fresh `npm run build` in this run. Build time and browser LCP/TTI require separate measurement.',
  chunkCount: chunks.length,
  parseFailures,
  totals: { rawBytes: totalRaw, gzipBytes: totalGzip, astNodes: totalNodes },
  chunks: chunks.sort((a, b) => b.rawBytes - a.rawBytes),
  astNodeHistogram: Object.fromEntries(topNodes),
  topNodeKinds: topNodes.slice(0, 20),
}

const outJson = path.join(here, 'shield-baseline.json')
fs.writeFileSync(outJson, JSON.stringify(result, null, 2))

// ---- human summary ----
const kb = (n) => (n / 1024).toFixed(1) + ' KB'
console.log(`shield baseline — ${distDir}`)
console.log(`dist mtime: ${distMtime} (NOT a fresh build this run)`)
console.log(`chunks: ${chunks.length}   parse failures: ${parseFailures}`)
console.log(`total raw: ${kb(totalRaw)}   total gzip(-9): ${kb(totalGzip)}   AST nodes: ${totalNodes}`)
console.log('')
console.log('per-chunk (raw / gzip / ast nodes):')
for (const c of result.chunks) {
  console.log(`  ${c.file.padEnd(44)} ${kb(c.rawBytes).padStart(10)} ${kb(c.gzipBytes).padStart(10)} ${String(c.astNodes).padStart(9)}${c.parsed ? '' : '  [PARSE FAIL]'}`)
}
console.log('')
console.log('top 20 AST node kinds:')
for (const [k, v] of result.topNodeKinds) console.log(`  ${String(v).padStart(8)}  ${k}`)
console.log('')
console.log(`JSON written to ${path.relative(repoRoot, outJson)}`)
