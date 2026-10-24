// shield anti-tamper tests (PLAN P7 / 5.9). Each feature: a behavioural test,
// plus the policy guarantees (wipe only for the high-confidence integrity
// checks; env/timing/mutation FLAG but never wipe).

import test from 'node:test'
import assert from 'node:assert/strict'
import { compile } from './compiler.ts'
import { createRuntime } from './runtime-template.js'
import {
  integrityHash, createToStringGuard, createTimingMonitor,
  isLikelyBot, installMutationGuard, resolveAntiTamper, ANTI_TAMPER_DEFAULTS,
} from './anti-tamper.js'

const SEED = 0xBEEF
const prog = () => compile('(()=>{ let s=0; for(let i=0;i<20;i++) s+=i; return s })()', { seed: SEED }).program

// ---- defaults / policy ------------------------------------------------------
test('defaults: integrity+toStringGuard+envCheck ON, timing+mutationGuard OFF', () => {
  const at = resolveAntiTamper(undefined)
  assert.equal(at.integrity, true)
  assert.equal(at.toStringGuard, true)
  assert.equal(at.envCheck, true)
  assert.equal(at.timing, false)
  assert.equal(at.mutationGuard, false)
  assert.equal(ANTI_TAMPER_DEFAULTS.timing, false)
})

// ---- 1. bytecode integrity hash --------------------------------------------
test('integrityHash is deterministic and sensitive to a bytecode edit', () => {
  const p = prog()
  const h1 = integrityHash(p)
  assert.equal(h1, integrityHash(p))               // deterministic
  const p2 = prog(); p2.functions[0].code[0] ^= 0xff
  assert.notEqual(integrityHash(p2), h1)            // one flipped byte is seen
})

test('runtime integrity: matching hash runs; mismatch WIPES + fatal (D10)', () => {
  // The plugin hashes the exact program it ships, so match against that same
  // program instance (how the real pipeline embeds the digest).
  const p = prog()
  const good = integrityHash(p)
  assert.equal(createRuntime(p, { budget: 1e7, expectedHash: good }).run(), 190)
  // wrong hash -> the check runs at construction: WIPE + fatal before any run,
  // and the program's consts are zeroed.
  const bad = prog()
  let caught
  assert.throws(() => createRuntime(bad, { budget: 1e7, expectedHash: (good ^ 0x1234) >>> 0 }),
    (e) => { caught = e; return /integrity check failed \(bytecode hash/.test(e.message) && e.__shieldFatal === true })
  assert.ok(caught && caught.__shieldFatal)
  // wipe zeroes the bytecode in place (functions === program.functions)
  assert.ok(bad.functions[0].code.length > 0 && bad.functions[0].code.every((x) => x === 0))
})

test('integrity check can be disabled per policy', () => {
  const rt = createRuntime(prog(), { budget: 1e7, expectedHash: 123, antiTamper: { integrity: false } })
  assert.equal(rt.run(), 190) // wrong hash ignored when integrity OFF
})

// ---- 2. toString snapshot ---------------------------------------------------
test('toString guard flags a swapped target thunk', () => {
  let target = function alpha() { return 1 }
  const guard = createToStringGuard([() => target])
  assert.equal(guard.check(), false)
  target = function beta() { return 2 } // simulate a post-boot patch/wrapper
  assert.equal(guard.check(), true)
})

test('runtime toString guard: patching a guarded target WIPES on next entry', () => {
  // The guard snapshots at boot and re-checks (throttled) on host->VM entry.
  // Function.prototype.toString is a guarded target; replacing it post-boot is
  // exactly the hide-your-edits tamper this must catch. Force interval to 0.
  const rt = createRuntime(prog(), { budget: 1e7, antiTamper: { toStringIntervalMs: 0 } })
  assert.equal(rt.run(), 190) // boot snapshot clean; first entry check passes
  const orig = Function.prototype.toString
  try {
    // eslint-disable-next-line no-extend-native
    Function.prototype.toString = function () { return 'patched' } // post-boot swap
    assert.throws(() => rt.run(), (e) => e.__shieldFatal === true && /toString tampered/.test(e.message))
    assert.ok(rt._wiped)
  } finally {
    Function.prototype.toString = orig
  }
})

// ---- 3. timing monitor (FLAG only, lenient) --------------------------------
test('timing monitor needs a full suspicious streak and never throws', () => {
  const m = createTimingMonitor({ timingWindow: 3, timingMsPerMstep: 10 })
  assert.equal(m.sample(1, 50), false)              // too few steps to judge
  assert.equal(m.sample(1000, 1e6), false)          // 1 suspicious
  assert.equal(m.sample(1000, 1e6), false)          // 2 suspicious
  assert.equal(m.sample(1000, 1e6), true)           // 3rd -> trip (flag)
  assert.equal(m.sample(1, 1e6), false)             // a fast sample resets streak
})

// ---- 4. environment check (isLikelyBot) ------------------------------------
test('isLikelyBot flags each signal and clears a normal env', () => {
  const base = { navigator: { webdriver: false, languages: ['en-US'] }, outerWidth: 1280, outerHeight: 800 }
  assert.equal(isLikelyBot(base), false)
  assert.equal(isLikelyBot({ ...base, navigator: { webdriver: true, languages: ['en'] } }), true)
  assert.equal(isLikelyBot({ ...base, navigator: { webdriver: false, languages: [] } }), true)
  assert.equal(isLikelyBot({ ...base, outerWidth: 0, outerHeight: 0 }), true)
  assert.equal(isLikelyBot({ navigator: { webdriver: false, languages: ['en'] }, __nightmare: 1, outerWidth: 1, outerHeight: 1 }), true)
  assert.equal(isLikelyBot({}), false)              // no navigator -> not flagged (server/SSR)
})

// ---- 5. mutation guard (FLAG only) -----------------------------------------
test('installMutationGuard observes roots and flags via onDetect (no wipe)', () => {
  const observed = []
  let cb = null
  class FakeMO {
    constructor(fn) { cb = fn }
    observe(root, opts) { observed.push([root, opts]) }
    disconnect() {}
  }
  let flagged = 0
  const obs = installMutationGuard([{ id: 'shadow' }], () => { flagged++ }, FakeMO)
  assert.equal(observed.length, 1)
  cb([{ type: 'childList' }])                        // simulate a mutation
  assert.equal(flagged, 1)
  obs.disconnect()
  // no roots / no observer -> safe no-op
  assert.doesNotThrow(() => installMutationGuard([], () => {}, FakeMO).disconnect())
})
