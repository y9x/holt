// shield anti-tamper (PLAN P7 / 5.9). Plain JavaScript, no Node built-ins, so
// it runs unchanged in Node (tests) and in the browser (shipped bundle).
//
// Each feature is INDIVIDUALLY FLAGGED with a conservative default. Only the
// HIGH-CONFIDENCE integrity checks (bytecode hash, VM toString snapshot) are
// wired to the D10 wipe; the environment and timing signals are TRIPWIRES that
// only FLAG — they are too false-positive-prone on slow devices, background
// tabs and browser extensions to justify bricking a real user's session.
//
// Every check has a documented bypass in README.md (§ Anti-tamper). None of
// these create secrecy; like the rest of shield they raise reversing cost.

// Default policy. Override per-field via createRuntime/createLoader options.
//   integrity   : bytecode hash verified at boot            -> WIPE on mismatch
//   toStringGuard: VM own-function toString snapshot         -> WIPE on mismatch
//   envCheck    : consolidated isLikelyBot signal            -> FLAG only
//   timing      : performance.now() deltas (HIGH FP risk)    -> FLAG only, OFF
//   mutationGuard: MutationObserver on shield shadow roots    -> FLAG only, OFF
export const ANTI_TAMPER_DEFAULTS = {
  integrity: true,
  toStringGuard: true,
  envCheck: true,
  timing: false,
  mutationGuard: false,
  // how often (ms) the toString guard re-verifies on host->VM entry
  toStringIntervalMs: 2000,
  // timing: trip only after this many consecutive suspicious samples (lenient)
  timingWindow: 8,
  // timing: a single VM step burst slower than this many ms/Mstep is "suspicious"
  timingMsPerMstep: 2000,
}

export function resolveAntiTamper(opts) {
  const o = opts || {}
  return {
    integrity: o.integrity !== undefined ? !!o.integrity : ANTI_TAMPER_DEFAULTS.integrity,
    toStringGuard: o.toStringGuard !== undefined ? !!o.toStringGuard : ANTI_TAMPER_DEFAULTS.toStringGuard,
    envCheck: o.envCheck !== undefined ? !!o.envCheck : ANTI_TAMPER_DEFAULTS.envCheck,
    timing: o.timing !== undefined ? !!o.timing : ANTI_TAMPER_DEFAULTS.timing,
    mutationGuard: o.mutationGuard !== undefined ? !!o.mutationGuard : ANTI_TAMPER_DEFAULTS.mutationGuard,
    // use !== undefined so an explicit 0 (check on every entry) is honoured
    toStringIntervalMs: o.toStringIntervalMs !== undefined ? o.toStringIntervalMs : ANTI_TAMPER_DEFAULTS.toStringIntervalMs,
    timingWindow: o.timingWindow !== undefined ? o.timingWindow : ANTI_TAMPER_DEFAULTS.timingWindow,
    timingMsPerMstep: o.timingMsPerMstep !== undefined ? o.timingMsPerMstep : ANTI_TAMPER_DEFAULTS.timingMsPerMstep,
  }
}

// ---- 1. bytecode integrity hash --------------------------------------------
// A fast 32-bit FNV-1a rolling hash over every function's bytecode bytes (the
// polymorphic opcode stream) plus arity-shaped structure. Computed at BUILD
// time by the plugin and embedded per chunk; recomputed at boot and compared.
//
// Rationale: the AEAD (XChaCha20-Poly1305) already fails to DECRYPT a tampered
// ciphertext, but the key ships in the page, so an attacker can re-encrypt a
// MODIFIED program with that key and defeat the AEAD. A separate embedded
// digest raises that cost — tampering now also has to forge a matching hash.
// Bypass (documented): patch the hash function itself, or recompute+embed the
// matching digest after editing bytecode. Cost-raising, not secrecy.
export function integrityHash(program) {
  let h = 0x811c9dc5 >>> 0
  const fns = program.functions
  for (let i = 0; i < fns.length; i++) {
    const code = fns[i].code
    for (let j = 0; j < code.length; j++) {
      h ^= (code[j] & 0xff)
      h = Math.imul(h, 0x01000193) >>> 0
      // fold in the high bits of multi-byte operands so operand edits are seen
      const hi = (code[j] >>> 8) & 0xffff
      if (hi) { h ^= hi; h = Math.imul(h, 0x01000193) >>> 0 }
    }
    // length boundary between functions (defeats code-array splicing)
    h ^= code.length; h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

// ---- 2. VM toString snapshot ------------------------------------------------
// Snapshot Function.prototype.toString of the VM's OWN critical functions (and
// of Function.prototype.toString itself) at boot; compare later. Detects a
// runtime patch / wrapper (e.g. wrapping the dispatch loop to dump decrypted
// bytecode or step traces, reassigning a handler, or replacing toString to
// hide edits). FP risk is ~nil: nothing legitimately rewrites the VM's own
// functions. Targets are passed as THUNKS (`() => fn`) so each check RE-READS
// the live target — reassigning a guarded container property is caught, and
// the native `toStr` reference is captured once so a later toString swap is
// seen as a changed source. Bypass (documented): patch the function the
// dispatcher actually calls (the per-runtime closures, unreachable by name) or
// neuter this guard before it snapshots at boot.
export function createToStringGuard(thunks) {
  const toStr = Function.prototype.toString
  const snap = []
  const read = (thunk) => { try { return toStr.call(thunk()) } catch (_) { return '\u0000ERR' } }
  for (let i = 0; i < thunks.length; i++) snap.push(read(thunks[i]))
  return {
    check() {
      for (let i = 0; i < thunks.length; i++) if (read(thunks[i]) !== snap[i]) return true
      return false
    },
  }
}

// ---- 3. timing check (FLAG only, default OFF) -------------------------------
// Accumulates ms-per-Mstep samples; returns true only after `window`
// consecutive samples exceed the threshold. HIGH false-positive risk on slow
// machines, throttled background tabs and under a debugger — which is exactly
// why it is OFF by default and NEVER wired to the wipe. Bypass: run fast, or
// patch performance.now.
export function createTimingMonitor(cfg) {
  const window = (cfg && cfg.timingWindow) || ANTI_TAMPER_DEFAULTS.timingWindow
  const limit = (cfg && cfg.timingMsPerMstep) || ANTI_TAMPER_DEFAULTS.timingMsPerMstep
  let streak = 0
  return {
    sample(ms, steps) {
      if (steps < 100000) return false // too small to judge
      const msPerMstep = ms / (steps / 1e6)
      if (msPerMstep > limit) streak++; else streak = 0
      return streak >= window
    },
  }
}

// ---- 4. environment check (consolidated isLikelyBot; FLAG only) -------------
// Consolidates navigator.webdriver + known automation globals +
// navigator.languages.length===0 + zero outer window dimensions into ONE
// signal. This is the renamed A10 check.
//
// IMPORTANT: this is a TRIPWIRE, NOT a security control. It is heuristic and
// trivially spoofable (every signal can be faked), and real users trip it too
// (privacy extensions blank navigator.languages; some embeds report zero outer
// dimensions). It only FLAGS — it must never wipe, brick or block. Bypass:
// spoof navigator.webdriver/languages and the automation globals.
export function isLikelyBot(globals) {
  const g = globals || (typeof globalThis !== 'undefined' ? globalThis : {})
  const nav = g.navigator
  if (!nav) return false
  try {
    if (nav.webdriver) return true
    // headless/automation driver globals injected into the page
    if (g.__nightmare || g._phantom || g.callPhantom || g.__selenium_unwrapped ||
        g.__webdriver_evaluate || g.__driver_evaluate || g.domAutomation ||
        (g.document && (g.document.__selenium_unwrapped || g.document.$cdc_asdjflasutopfhvcZLmcfl_))) return true
    if (Array.isArray(nav.languages) && nav.languages.length === 0) return true
    if (typeof g.outerWidth === 'number' && typeof g.outerHeight === 'number' &&
        g.outerWidth === 0 && g.outerHeight === 0) return true
  } catch (_) { /* a thrown getter is itself mildly suspicious, but don't flag */ }
  return false
}

// ---- 5. mutation guard (FLAG only, default OFF) -----------------------------
// Observe the shield shadow root(s) for unexpected subtree mutation. The
// current build ships NO shield-owned shadow roots (the shadow DOM lives in
// HolyText / uncloak, outside shield), so this defaults OFF; it is implemented
// and tested so it is ready when a shield shadow root exists. onDetect is a
// FLAG callback — it must not wipe. Bypass: mutate via a path the observer does
// not cover, or disconnect the observer.
export function installMutationGuard(roots, onDetect, MO) {
  const Observer = MO || (typeof MutationObserver !== 'undefined' ? MutationObserver : null)
  if (!Observer || !roots || !roots.length) return { disconnect() {} }
  const obs = new Observer((records) => { if (records && records.length) { try { onDetect(records) } catch (_) {} } })
  for (const r of roots) { try { obs.observe(r, { childList: true, subtree: true, attributes: true, characterData: true }) } catch (_) {} }
  return obs
}
