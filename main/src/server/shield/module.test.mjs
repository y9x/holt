// shield module/loader corpus (PLAN P2/P3/P4, decision D6: node:test).
//
// Each case compiles a small ES-module graph, links + evaluates it through the
// shield loader, and asserts the resulting namespace EQUALS native ESM
// execution (the same sources written to disk and imported by Node). This is
// the whole-chunk loader proof: live cross-chunk bindings, circular imports,
// dynamic import(), top-level await, import.meta, re-exports, classes.
//
//   node --test "src/server/shield/**/*.test.mjs"

import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from './compiler.ts'
import { createRuntime } from './runtime-template.js'
import { createLoader } from './loader-template.js'

const SEED = 7

function buildLoader(mods) {
  const loader = createLoader({ createRuntime, globals: globalThis })
  for (const m of mods) {
    const r = compile(m.src, { seed: SEED })
    loader.define(m.id, { program: r.program, depMap: m.deps || {}, dynMap: m.dyn || {}, metaUrl: 'file:///' + m.id })
  }
  return loader
}

async function nativeNS(mods, entry) {
  const dir = mkdtempSync(join(tmpdir(), 'shieldmod-'))
  for (const m of mods) writeFileSync(join(dir, m.id), m.src)
  return import(pathToFileURL(join(dir, entry)).href)
}

// Compare VM namespace vs native namespace via a picker. The picker may return
// a promise (for exports that are themselves promises).
async function eqNS(mods, entry, pick) {
  const vmns = await buildLoader(mods).load(entry)
  const nat = await nativeNS(mods, entry)
  const vmv = await pick(vmns)
  const natv = await pick(nat)
  assert.deepStrictEqual(vmv, natv)
}

test('named + default imports', async () => {
  await eqNS([
    { id: 'a.js', src: 'export const x=10; export default function(){ return 99 }' },
    { id: 'main.js', src: 'import d, {x} from "./a.js"; export const r = x + d()', deps: { './a.js': 'a.js' } },
  ], 'main.js', (ns) => ns.r)
})

test('LIVE cross-chunk binding (exporter mutates after import)', async () => {
  await eqNS([
    { id: 'c.js', src: 'export let n=1; export function bump(){ n++ }' },
    { id: 'main.js', src: 'import {n,bump} from "./c.js"; bump(); bump(); export const r = n', deps: { './c.js': 'c.js' } },
  ], 'main.js', (ns) => ns.r)
})

test('namespace import', async () => {
  await eqNS([
    { id: 'ns.js', src: 'export const a=1; export const b=2' },
    { id: 'main.js', src: 'import * as NS from "./ns.js"; export const r = NS.a+NS.b; export const keys = Object.keys(NS).sort().join(",")', deps: { './ns.js': 'ns.js' } },
  ], 'main.js', (ns) => ns.r + '|' + ns.keys)
})

test('re-exports (named + star)', async () => {
  await eqNS([
    { id: 'base.js', src: 'export const p=3; export const q=4' },
    { id: 'mid.js', src: 'export { p } from "./base.js"; export * from "./base.js"; export const own=5', deps: { './base.js': 'base.js' } },
    { id: 'main.js', src: 'import {p,q,own} from "./mid.js"; export const r=p+q+own', deps: { './mid.js': 'mid.js' } },
  ], 'main.js', (ns) => ns.r)
})

test('circular imports (two-phase link, mutual recursion)', async () => {
  await eqNS([
    { id: 'e.js', src: 'import {oddish} from "./o.js"; export function evenish(n){ return n===0?true:oddish(n-1) }', deps: { './o.js': 'o.js' } },
    { id: 'o.js', src: 'import {evenish} from "./e.js"; export function oddish(n){ return n===0?false:evenish(n-1) }', deps: { './e.js': 'e.js' } },
    { id: 'main.js', src: 'import {evenish} from "./e.js"; export const r=[evenish(10),evenish(7)].join(",")', deps: { './e.js': 'e.js' } },
  ], 'main.js', (ns) => ns.r)
})

test('top-level await', async () => {
  await eqNS([
    { id: 'a.js', src: 'export const v = await Promise.resolve(41)' },
    { id: 'main.js', src: 'import {v} from "./a.js"; export const r = v + 1', deps: { './a.js': 'a.js' } },
  ], 'main.js', (ns) => ns.r)
})

test('dynamic import()', async () => {
  await eqNS([
    { id: 'lazy.js', src: 'export const hi = "lazy"; export default 7' },
    { id: 'main.js', src: 'export const r = (async()=>{ const m = await import("./lazy.js"); return m.hi+":"+m.default })()', deps: {}, dyn: { './lazy.js': 'lazy.js' } },
  ], 'main.js', (ns) => ns.r)
})

test('import.meta.url is a string', async () => {
  await eqNS([
    { id: 'main.js', src: 'export const r = typeof import.meta.url === "string"' },
  ], 'main.js', (ns) => ns.r)
})

test('classes across modules (default export + extends/super)', async () => {
  await eqNS([
    { id: 'shape.js', src: 'export default class Shape{ constructor(n){ this.n=n } area(){ return 0 } }' },
    { id: 'main.js', src: 'import Shape from "./shape.js"; class Sq extends Shape{ constructor(s){ super("sq"); this.s=s } area(){ return this.s*this.s } } const q=new Sq(4); export const r=q.n+":"+q.area()', deps: { './shape.js': 'shape.js' } },
  ], 'main.js', (ns) => ns.r)
})

test('concurrent dynamic imports sharing a transitive dep register fully (evaluate-missing regression)', async () => {
  // Two routes imported concurrently share a transitive dep (S -> D) whose fetch
  // is slow. Before the fix, ensureRegistered marked a module "done" (linkedDeps)
  // before its dep walk finished, so the second importer returned early and ran
  // evaluate() against a half-registered closure -> "evaluate missing <id>"
  // (the avatar chunk on the ai/music routes). Now registration is keyed on full
  // closure completion, so both routes evaluate cleanly every time.
  const srcs = {
    D: 'export const d = 7',
    S: 'import { d } from "./d.js"; export const s = d * 2',
    R1: 'import { s } from "./s.js"; export const r = s + 1',
    R2: 'import { s } from "./s.js"; export const r = s + 2',
  }
  const file = { D: 'D.js', S: 'S.js', R1: 'R1.js', R2: 'R2.js' }
  const dep = { D: {}, S: { './d.js': 'D' }, R1: { './s.js': 'S' }, R2: { './s.js': 'S' } }
  const delay = { D: 25, S: 0, R1: 0, R2: 10 } // D slow, R2 arrives after S is defined
  const manifest = { modules: Object.fromEntries(Object.keys(srcs).map((id) => [id, { file: file[id], kind: 'vm' }])) }
  const progs = Object.fromEntries(Object.keys(srcs).map((id) => [id, compile(srcs[id], { seed: SEED }).program]))
  let loader
  loader = createLoader({
    createRuntime, globals: globalThis, manifest, resolveURL: (f) => f,
    fetchArtifact: (f) => new Promise((res) => {
      const id = f.replace('.js', '')
      setTimeout(() => { loader.define(id, { program: progs[id], depMap: dep[id], metaUrl: 'file:///' + f }); res() }, delay[id])
    }),
  })
  const [n1, n2] = await Promise.all([loader.load('R1'), loader.load('R2')])
  assert.equal(n1.r, 15)
  assert.equal(n2.r, 16)
})

test('named class expression ctor/fields capture defining scope (lazy-scope regression)', async () => {
  // A named class EXPRESSION pushes a name-wrapper scope that EXIT_SCOPEs right
  // after BUILD_CLASS. The constructor and field initializers run later (at
  // `new`), so they must capture the DEFINING scope, not the live (popped)
  // frame scope — otherwise the ctor's compiled slot depths overflow the scope
  // chain (LOAD_SLOT on a null scope). Regression for vendor-markdown breaking
  // the ai route. Methods were already fine; ctor/fields/super were not.
  await eqNS([
    { id: 'base.js', src: 'export class Base { constructor(){ this.b = 1 } }' },
    { id: 'main.js', src: 'import { Base } from "./base.js"; const scale = 5; function helper(){ return 7 }\n' +
      'const C = class Named extends Base { tag = scale; constructor(){ super(); this.v = this.b + scale + helper() } run(){ return scale } };\n' +
      'const c = new C(); export const r = [c.v, c.tag, c.run()].join(",")', deps: { './base.js': 'base.js' } },
  ], 'main.js', (ns) => ns.r)
})

test('diamond dependency evaluates shared module once', async () => {
  await eqNS([
    { id: 'base.js', src: 'export let count=0; count++; export const c = count' },
    { id: 'l.js', src: 'import {c} from "./base.js"; export const l = c', deps: { './base.js': 'base.js' } },
    { id: 'r.js', src: 'import {c} from "./base.js"; export const rr = c', deps: { './base.js': 'base.js' } },
    { id: 'main.js', src: 'import {l} from "./l.js"; import {rr} from "./r.js"; export const r = l+":"+rr', deps: { './l.js': 'l.js', './r.js': 'r.js' } },
  ], 'main.js', (ns) => ns.r)
})
