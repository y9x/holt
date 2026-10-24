// shield runtime (VM). Plain JavaScript, no Node built-ins, so it runs
// unchanged in Node and in the browser. Decryption uses @noble/ciphers, the
// same cipher the compiler uses (PLAN 5.7 / 5.8).
//
// This is the "runtime-template": per-build specialization is the handler-table
// slot layout, which is data (the OpcodeLayout embedded in the decrypted
// program), NOT textual renaming of variables. See README.md "what's a stub".
//
// Dispatch is a handler table indexed by the per-build opcode byte. Unused
// bytes are trap slots that wipe the bytecode + constant pool then throw
// (PLAN 5.7, decision D10). A step budget catches runaway loops. Exceptions
// use a per-frame handler stack; sync and async share one interpreter loop,
// with async suspending at AWAIT and resuming through a promise driver.

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { ARITY } from './opcodes.ts'
import { resolveAntiTamper, integrityHash, createToStringGuard } from './anti-tamper.js'

// Watchdog policy (see README "Step-budget → watchdog redesign").
//
// The old design had a single cumulative per-runtime step counter capped at
// 20M and reset ONLY at the top-level run(). Because every later call back into
// the VM (a React render, an event handler, an effect, a timer) keeps running
// the SAME runtime without resetting that counter, the cap was really a
// "total instructions this chunk may ever execute on the page" budget — so any
// long-lived or heavy route (e.g. /games) eventually tripped it even though it
// was doing legitimate work. That is a false positive, not a safety win.
//
// The safety goal (catch an infinite loop / a tampered runtime that spins
// forever, and still support the trap-wipe) only needs to catch a SINGLE
// synchronous burst that never returns to the host. So the watchdog is now
// scoped to one host->VM burst: the step counter resets every time control
// enters the interpreter from outside (depth 0 -> 1) and at every async resume.
// Within a burst we sample a wall clock every WATCHDOG_SAMPLE steps and trip
// only after WATCHDOG_MS of uninterrupted synchronous execution. Legitimate
// renders return to the event loop long before that; `while(true){}` does not.
//
// An explicit numeric `budget` option still enforces a hard per-burst step cap
// (used by the fast unit tests so they don't have to spin for whole seconds);
// production ships with no step cap and relies on the wall-clock watchdog.
const DEFAULT_WATCHDOG_MS = 10_000
const WATCHDOG_SAMPLE = 1 << 20 // sample the clock ~once per million steps

// Sentinel for a derived-class `this` before super() runs (TDZ).
const TDZ = { __shieldTDZ: true }

// Resolve the live value of an ES-module import binding. `b.src` is the source
// module RECORD (supplied by the loader), which exposes getExport()/namespace().
// Reading here (not at link time) is what makes bindings LIVE and gives correct
// TDZ behavior for circular imports.
function resolveImport(b) {
  if (b.ikind === 'ns') return b.src.namespace()
  if (b.ikind === 'default') return b.src.getExport('default')
  return b.src.getExport(b.iname)
}

export function decryptProgram(encrypted, key) {
  const nonce = encrypted.slice(0, 24)
  const ct = encrypted.slice(24)
  const bytes = xchacha20poly1305(key, nonce).decrypt(ct)
  return JSON.parse(new TextDecoder().decode(bytes))
}

function decodeConst(entry) {
  if (entry && typeof entry === 'object') {
    if (entry.$ === 'n') {
      if (entry.v === 'NaN') return NaN
      if (entry.v === 'Inf') return Infinity
      if (entry.v === '-Inf') return -Infinity
      if (entry.v === '-0') return -0
    }
    if (entry.$ === 're') return new RegExp(entry.s, entry.f)
    if (entry.$ === 'bi') return BigInt(entry.v)
  }
  return entry
}

function fatal(message) {
  const e = new Error('shield: ' + message)
  e.__shieldFatal = true
  return e
}

// break/continue that crosses one or more `finally` blocks. Pop the frame's
// handler stack down to `stop` (the handler depth at the target loop); for each
// `finally` crossed, restore its try-scope/stack and route a {kind:'jump'}
// completion through it (END_FINALLY re-enters doJump to reach the next finally
// or the target). When no finally remains before `stop`, land at `target` — the
// compiler places a trampoline there that exits the leftover scopes. Returns
// null (the frame keeps running at the new pc).
function doJump(frame, target, stop) {
  const handlers = frame.handlers
  while (handlers.length > stop) {
    const h = handlers.pop()
    if (h.type === 'finally') {
      frame.stack.length = h.sp
      frame.scope = h.scope
      frame.completions.push({ kind: 'jump', target: target, stop: stop })
      frame.pc = h.target
      return null
    }
    // a catch handler crossed on the way out: discard it
  }
  frame.pc = target
  return null
}

// ---- scope helpers ----
// Slot-based locals (PLAN 5.11 perf): every lexical binding is resolved to a
// (depth, index) pair at compile time, so the runtime does no string hashing —
// it walks `depth` parent scopes and indexes a plain array. A scope is
// { parent, slots: [] }; a slot holds a binding cell { v, kind, init, import? }.
// Cells (objects) are kept so closures share a mutable binding and imports stay
// live. kind: 0=var, 1=let, 2=const.
function scopeAt(scope, depth) {
  while (depth > 0) { scope = scope.parent; depth-- }
  return scope
}
const TDZ_READ = "Cannot access a lexical binding before initialization"

// Legacy name-keyed lookup (retained for any hand-built programs; the compiler
// now emits slot/global ops exclusively).
function lookup(scope, name) {
  let s = scope
  while (s) {
    if (s.vars) { const b = s.vars.get(name); if (b !== undefined) return b }
    s = s.parent
  }
  return undefined
}

const nowMs = (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
  ? () => performance.now()
  : () => Date.now()

export function createRuntime(program, options) {
  const opts = options || {}
  const globals = opts.globals || globalThis
  // Optional hard per-burst step cap. undefined => no step cap (production).
  const stepCap = (typeof opts.budget === 'number' && isFinite(opts.budget) && opts.budget > 0) ? opts.budget : 0
  const watchdogMs = (typeof opts.watchdogMs === 'number' && isFinite(opts.watchdogMs) && opts.watchdogMs > 0) ? opts.watchdogMs : DEFAULT_WATCHDOG_MS
  const consts = program.consts.map(decodeConst)
  const functions = program.functions
  const layout = program.layout
  // Per-synchronous-burst watchdog state (reset on every host->VM entry).
  let depth = 0
  let burstSteps = 0
  let burstStart = 0
  let wiped = false

  // Anti-tamper policy (PLAN P7 / 5.9). High-confidence checks (bytecode hash,
  // VM toString snapshot) are wired to the D10 wipe; env/timing never wipe.
  const at = resolveAntiTamper(opts.antiTamper)

  function wipe() {
    if (wiped) return
    wiped = true
    try {
      for (let i = 0; i < consts.length; i++) consts[i] = 0
      for (const f of functions) { const c = f.code; for (let i = 0; i < c.length; i++) c[i] = 0 }
    } catch (_) { /* ignore */ }
  }

  // Build the byte -> handler dispatch table and byte -> arity table.
  const tableSize = layout.tableSize
  const arityByByte = new Array(tableSize).fill(0)
  const handlers = new Array(tableSize)
  const trap = function () { wipe(); throw fatal('illegal instruction (trap slot)') }
  for (let b = 0; b < tableSize; b++) handlers[b] = trap
  // layout.nameOf came back from JSON with string keys.
  const nameOf = layout.nameOf
  for (const byteStr of Object.keys(nameOf)) {
    const byte = Number(byteStr)
    const name = nameOf[byteStr]
    arityByByte[byte] = ARITY[name]
    handlers[byte] = HANDLERS[name]
  }

  // Anti-tamper 1 (integrity): if the build embedded an expected bytecode hash,
  // verify it. A mismatch means the bytecode was edited (and re-encrypted with
  // the in-page key) — high confidence, so WIPE + fatal (D10).
  if (at.integrity && typeof opts.expectedHash === 'number') {
    if (integrityHash(program) !== (opts.expectedHash >>> 0)) {
      wipe(); throw fatal('integrity check failed (bytecode hash mismatch)')
    }
  }

  // Anti-tamper 2 (toString snapshot): snapshot the VM's OWN critical functions
  // now; re-verify (throttled) on host->VM entry. A changed source means the
  // dispatch/decrypt path was patched or wrapped — high confidence, so WIPE.
  const tsGuard = at.toStringGuard ? createToStringGuard([
    () => runFrame, () => runSync, () => decryptProgram,
    () => HANDLERS.CALL, () => HANDLERS.LOAD_SLOT, () => Function.prototype.toString,
  ]) : null
  let lastGuard = 0
  function guardCheck() {
    if (!tsGuard || wiped) return
    const t = nowMs()
    if (t - lastGuard < at.toStringIntervalMs) return
    lastGuard = t
    if (tsGuard.check()) { wipe(); throw fatal('integrity check failed (runtime toString tampered)') }
  }

  function makeFrame(def, closureScope, thisVal, args, extra) {
    const e = extra || {}
    return {
      code: def.code, pc: 0, stack: [],
      scope: e.scope || { parent: closureScope, slots: [] },
      thisVal, args,
      newTarget: e.newTarget, home: e.home, privs: e.privs,
      ctor: e.ctor, module: e.module,
      handlers: [], completions: [], completion: undefined,
    }
  }

  // ctx: { scope, arrowThis, newTarget, home, ownHome, privs, module }
  // Arrows inherit this/newTarget/home from the defining context; plain
  // functions get their own (this/newTarget from the call site, home only when
  // they are class methods, carried via ownHome). privs are lexical (inherited
  // by every nested function so `obj.#x` works inside closures).
  function createClosure(def, ctx) {
    const fn = function (...callArgs) {
      const isArrow = def.isArrow
      const thisVal = isArrow ? ctx.arrowThis : this
      const frame = makeFrame(def, ctx.scope, thisVal, callArgs, {
        newTarget: isArrow ? ctx.newTarget : new.target,
        home: isArrow ? ctx.home : ctx.ownHome,
        privs: ctx.privs,
        module: ctx.module,
      })
      if (def.isAsync) return runAsync(frame)
      return runSync(frame)
    }
    try { Object.defineProperty(fn, 'length', { value: def.numParams, configurable: true }) } catch (_) {}
    if (def.name) { try { Object.defineProperty(fn, 'name', { value: def.name, configurable: true }) } catch (_) {} }
    return fn
  }

  const vm = { makeFrame, runSync, TDZ }

  function callValue(fn, thisArg, args) {
    if (typeof fn !== 'function') throw new TypeError(String(fn) + ' is not a function')
    return Reflect.apply(fn, thisArg, args)
  }

  // Unwind the handler stack to the nearest catch/finally. Returns true if a
  // handler took over (pc/stack/scope restored), false if the exception should
  // propagate out of this frame.
  function unwind(frame, err) {
    while (frame.handlers.length) {
      const h = frame.handlers.pop()
      frame.stack.length = h.sp
      frame.scope = h.scope
      if (h.type === 'catch') { frame.stack.push(err); frame.pc = h.target; return true }
      // finally
      frame.completions.push({ kind: 'throw', value: err })
      frame.pc = h.target
      return true
    }
    return false
  }

  // Perform a return, routing through any active finally handlers. Returns a
  // signal object (actual return) or null when diverted into a finally.
  function doReturn(frame, value) {
    while (frame.handlers.length) {
      const h = frame.handlers.pop()
      if (h.type === 'finally') {
        frame.stack.length = h.sp
        frame.scope = h.scope
        frame.completions.push({ kind: 'return', value })
        frame.pc = h.target
        return null
      }
      // discard catch handlers we are leaving
    }
    return { type: 'return', value }
  }

  // The one interpreter loop. Returns a signal:
  //   {type:'return'|'halt', value} | {type:'throw', value} | {type:'await', value}
  function runFrame(frame) {
    const code = frame.code
    // One try/catch spans the whole dispatch loop instead of wrapping every
    // instruction. V8 cannot optimize a function that sets up a try/catch on
    // every opcode; lifting it out is a large throughput win. A thrown error
    // exits the inner loop, we unwind the frame's handler stack, and (if a
    // catch/finally took over) re-enter the inner loop at the new pc.
    while (true) {
      try {
        while (true) {
          burstSteps++
          if (stepCap) {
            if (burstSteps > stepCap) { wipe(); throw fatal('step budget exceeded') }
          } else if ((burstSteps & (WATCHDOG_SAMPLE - 1)) === 0) {
            if (nowMs() - burstStart > watchdogMs) { wipe(); throw fatal('watchdog: runaway execution (>' + watchdogMs + 'ms with no yield)') }
          }
          const op = code[frame.pc]
          const arity = arityByByte[op]
          const arg = arity ? code[frame.pc + 1] : 0
          frame.pc += 1 + arity
          const sig = handlers[op](frame, arg, consts, functions, globals, createClosure, callValue, doReturn, vm)
          if (sig) return sig
        }
      } catch (err) {
        if (err && err.__shieldFatal) throw err
        if (!unwind(frame, err)) return { type: 'throw', value: err }
        // unwound into a catch/finally in this frame: resume at frame.pc
      }
    }
  }

  // Mark the start of a synchronous host->VM burst. The watchdog clock + step
  // counter reset only when we cross from "outside the interpreter" (depth 0)
  // into it, so nested VM->host->VM calls share one burst budget while each
  // fresh host callback / async resume starts its own.
  function enterBurst() { if (depth++ === 0) { burstStart = nowMs(); burstSteps = 0 } }
  function exitBurst() { depth-- }

  function runSync(frame) {
    if (depth === 0) guardCheck()
    enterBurst()
    let sig
    try { sig = runFrame(frame) } finally { exitBurst() }
    if (sig.type === 'return' || sig.type === 'halt') return sig.value
    if (sig.type === 'throw') throw sig.value
    throw fatal('await in a non-async function')
  }

  function runAsync(frame) {
    return new Promise((resolve, reject) => {
      function handle(sig) {
        if (sig.type === 'await') {
          Promise.resolve(sig.value).then(
            (v) => { frame.stack.push(v); step() },
            (e) => { if (!unwind(frame, e)) { reject(e); return } step() },
          )
          return
        }
        if (sig.type === 'return' || sig.type === 'halt') resolve(sig.value)
        else reject(sig.value)
      }
      function step() {
        let sig
        if (depth === 0) { try { guardCheck() } catch (e) { reject(e); return } }
        enterBurst()
        try { sig = runFrame(frame) } catch (e) { exitBurst(); reject(e); return }
        exitBurst()
        try { handle(sig) } catch (e) { reject(e) }
      }
      step()
    })
  }

  // run the program's main function. For a plain program this is a sync eval.
  // For an ES module, pass moduleCtx = { env, module }: `env` is the persistent
  // module scope (so exports resolve after evaluation) and `module` is the
  // loader-provided record (import resolution, import.meta, dynamic import).
  // Returns the completion value, or a Promise when the module uses top-level
  // await (main def.isAsync).
  function run(args, moduleCtx) {
    const def = functions[program.mainIndex]
    const mc = moduleCtx || {}
    const frame = makeFrame(def, null, undefined, args || [], { scope: mc.env, module: mc.module })
    if (def.isAsync) return runAsync(frame)
    return runSync(frame)
  }

  // `_steps` reflects the current burst's step counter. Read right after a
  // completed synchronous run() it is that run's total instruction count (it is
  // reset only on the next host->VM entry). Used by benches, not shipped logic.
  return { run, _wipe: wipe, _consts: consts, program, _antiTamper: at, _guardCheck: guardCheck, get _steps() { return burstSteps }, get _wiped() { return wiped } }
}

export function execute(encrypted, key, options) {
  return createRuntime(decryptProgram(encrypted, key), options).run()
}

// ---- opcode handlers ----
// Each handler receives (frame, arg, consts, functions, globals, createClosure,
// callValue, doReturn). Return a signal object to stop the frame, else nothing.
const HANDLERS = {
  HALT(frame) { return { type: 'halt', value: frame.completion } },
  NOP() {},
  POP(frame) { frame.stack.pop() },
  DUP(frame) { const s = frame.stack; s.push(s[s.length - 1]) },
  DUP2(frame) { const s = frame.stack; const a = s[s.length - 2]; const b = s[s.length - 1]; s.push(a, b) },
  SWAP(frame) { const s = frame.stack; const b = s.pop(); const a = s.pop(); s.push(b, a) },
  ROTL3(frame) { const s = frame.stack; const c = s.pop(); const b = s.pop(); const a = s.pop(); s.push(b, c, a) },

  PUSH_CONST(frame, arg, consts) { frame.stack.push(consts[arg]) },
  PUSH_UNDEF(frame) { frame.stack.push(undefined) },
  PUSH_NULL(frame) { frame.stack.push(null) },
  PUSH_TRUE(frame) { frame.stack.push(true) },
  PUSH_FALSE(frame) { frame.stack.push(false) },
  PUSH_THIS(frame) {
    if (frame.thisVal === TDZ) throw new ReferenceError("Must call super constructor in derived class before accessing 'this'")
    frame.stack.push(frame.thisVal)
  },
  LOAD_NEW_TARGET(frame) { frame.stack.push(frame.newTarget) },

  LOAD_VAR(frame, arg, consts, functions, globals) {
    const name = consts[arg]
    const b = lookup(frame.scope, name)
    if (b !== undefined) {
      if (b.import) { frame.stack.push(resolveImport(b)); return }
      if (!b.init) throw new ReferenceError("Cannot access '" + name + "' before initialization")
      frame.stack.push(b.v); return
    }
    if (name in globals) { frame.stack.push(globals[name]); return }
    throw new ReferenceError(name + ' is not defined')
  },
  TYPEOF_VAR(frame, arg, consts, functions, globals) {
    const name = consts[arg]
    const b = lookup(frame.scope, name)
    if (b !== undefined) {
      if (b.import) { frame.stack.push(typeof resolveImport(b)); return }
      if (!b.init) throw new ReferenceError("Cannot access '" + name + "' before initialization")
      frame.stack.push(typeof b.v); return
    }
    frame.stack.push(name in globals ? typeof globals[name] : 'undefined')
  },
  STORE_VAR(frame, arg, consts) {
    const name = consts[arg]
    const v = frame.stack.pop()
    const b = lookup(frame.scope, name)
    if (b === undefined) throw new ReferenceError(name + ' is not defined')
    if (b.import) throw new TypeError('Assignment to constant variable.')
    if (b.kind === 'const' && b.init) throw new TypeError('Assignment to constant variable.')
    if (!b.init) throw new ReferenceError("Cannot access '" + name + "' before initialization")
    b.v = v
    frame.stack.push(v)
  },
  INIT_VAR(frame, arg, consts) {
    const name = consts[arg]
    const v = frame.stack.pop()
    const b = lookup(frame.scope, name)
    if (b === undefined) throw fatal('internal: INIT_VAR missing binding ' + name)
    b.v = v; b.init = true
  },
  DECLARE_VAR(frame, arg, consts) {
    const name = consts[arg]
    if (!frame.scope.vars.has(name)) frame.scope.vars.set(name, { v: undefined, kind: 'var', init: true })
  },
  DECLARE_LET(frame, arg, consts) {
    frame.scope.vars.set(consts[arg], { v: undefined, kind: 'let', init: false })
  },
  DECLARE_CONST(frame, arg, consts) {
    frame.scope.vars.set(consts[arg], { v: undefined, kind: 'const', init: false })
  },
  DEF_FUNC(frame, arg, consts) {
    const fn = frame.stack.pop()
    frame.scope.vars.set(consts[arg], { v: fn, kind: 'var', init: true })
  },
  LOAD_ARG(frame, arg) { frame.stack.push(frame.args[arg]) },
  LOAD_ARGS_FROM(frame, arg) { frame.stack.push(frame.args.slice(arg)) },

  ENTER_SCOPE(frame) { frame.scope = { parent: frame.scope, slots: [] } },
  EXIT_SCOPE(frame) { frame.scope = frame.scope.parent },

  // ---- slot-based locals (arg packs depth<<16 | index) ----
  LOAD_SLOT(frame, arg) {
    const b = scopeAt(frame.scope, arg >>> 16).slots[arg & 0xffff]
    if (b.import) { frame.stack.push(resolveImport(b)); return }
    if (!b.init) throw new ReferenceError(TDZ_READ)
    frame.stack.push(b.v)
  },
  STORE_SLOT(frame, arg) {
    const v = frame.stack.pop()
    const b = scopeAt(frame.scope, arg >>> 16).slots[arg & 0xffff]
    if (b.import) throw new TypeError('Assignment to constant variable.')
    if (b.kind === 2 && b.init) throw new TypeError('Assignment to constant variable.')
    if (!b.init) throw new ReferenceError(TDZ_READ)
    b.v = v
    frame.stack.push(v)
  },
  INIT_SLOT(frame, arg) {
    const v = frame.stack.pop()
    const b = scopeAt(frame.scope, arg >>> 16).slots[arg & 0xffff]
    b.v = v; b.init = true
  },
  TYPEOF_SLOT(frame, arg) {
    const b = scopeAt(frame.scope, arg >>> 16).slots[arg & 0xffff]
    if (b.import) { frame.stack.push(typeof resolveImport(b)); return }
    if (!b.init) throw new ReferenceError(TDZ_READ)
    frame.stack.push(typeof b.v)
  },
  // arg packs index<<2 | kind (0=var,1=let,2=const)
  DECLARE_SLOT(frame, arg) {
    frame.scope.slots[arg >>> 2] = { v: undefined, kind: arg & 3, init: (arg & 3) === 0 }
  },
  DEF_FUNC_SLOT(frame, arg) {
    frame.scope.slots[arg] = { v: frame.stack.pop(), kind: 0, init: true }
  },
  // bulk TDZ declare of a contiguous same-kind run. const = [startIndex, count, kind]
  // Fuses a run of DECLARE_SLOT (the block-prologue cells) into one step.
  DECLARE_SLOTS(frame, arg, consts) {
    const c = consts[arg]
    const slots = frame.scope.slots
    const start = c[0], count = c[1], kind = c[2], init = kind === 0
    for (let i = 0; i < count; i++) slots[start + i] = { v: undefined, kind, init }
  },

  // ---- free variables / globals ----
  LOAD_GLOBAL(frame, arg, consts, functions, globals) {
    const name = consts[arg]
    if (name in globals) { frame.stack.push(globals[name]); return }
    throw new ReferenceError(name + ' is not defined')
  },
  STORE_GLOBAL(frame, arg, consts, functions, globals) {
    const name = consts[arg]
    const v = frame.stack.pop()
    if (name in globals) { globals[name] = v; frame.stack.push(v); return }
    throw new ReferenceError(name + ' is not defined')
  },
  TYPEOF_GLOBAL(frame, arg, consts, functions, globals) {
    const name = consts[arg]
    frame.stack.push(name in globals ? typeof globals[name] : 'undefined')
  },

  // ---- superinstructions (fused hot sequences; operand is a const tuple) ----
  // param prologue: slots[slot] = args[argIndex]   (arg packs slot<<8|argIndex)
  BIND_PARAM(frame, arg) {
    frame.scope.slots[arg >>> 8] = { v: frame.args[arg & 0xff], kind: 0, init: true }
  },
  // ident.key  — fuses LOAD_SLOT ; GET_PROP. const = [addr, key]
  LOAD_SLOT_PROP(frame, arg, consts) {
    const c = consts[arg]
    const b = scopeAt(frame.scope, c[0] >>> 16).slots[c[0] & 0xffff]
    let o
    if (b.import) o = resolveImport(b)
    else { if (!b.init) throw new ReferenceError(TDZ_READ); o = b.v }
    frame.stack.push(o[c[1]])
  },
  // GLOBAL.key — fuses LOAD_GLOBAL ; GET_PROP. const = [name, key]
  LOAD_GLOBAL_PROP(frame, arg, consts, functions, globals) {
    const c = consts[arg]
    if (!(c[0] in globals)) throw new ReferenceError(c[0] + ' is not defined')
    frame.stack.push(globals[c[0]][c[1]])
  },
  // ident.method() receiver — fuses LOAD_SLOT ; DUP ; GET_PROP. const = [addr, key]
  LOAD_SLOT_DUP_PROP(frame, arg, consts) {
    const c = consts[arg]
    const b = scopeAt(frame.scope, c[0] >>> 16).slots[c[0] & 0xffff]
    let o
    if (b.import) o = resolveImport(b)
    else { if (!b.init) throw new ReferenceError(TDZ_READ); o = b.v }
    const s = frame.stack; s.push(o); s.push(o[c[1]])
  },
  // GLOBAL.method() receiver — fuses LOAD_GLOBAL ; DUP ; GET_PROP. const = [name, key]
  LOAD_GLOBAL_DUP_PROP(frame, arg, consts, functions, globals) {
    const c = consts[arg]
    if (!(c[0] in globals)) throw new ReferenceError(c[0] + ' is not defined')
    const o = globals[c[0]]
    const s = frame.stack; s.push(o); s.push(o[c[1]])
  },

  ADD(frame) { const s = frame.stack; const b = s.pop(); const a = s.pop(); s.push(a + b) },
  SUB(frame) { const s = frame.stack; const b = s.pop(); const a = s.pop(); s.push(a - b) },
  MUL(frame) { const s = frame.stack; const b = s.pop(); const a = s.pop(); s.push(a * b) },
  DIV(frame) { const s = frame.stack; const b = s.pop(); const a = s.pop(); s.push(a / b) },
  MOD(frame) { const s = frame.stack; const b = s.pop(); const a = s.pop(); s.push(a % b) },
  EXP(frame) { const s = frame.stack; const b = s.pop(); const a = s.pop(); s.push(a ** b) },
  EQ(frame) { const s = frame.stack; const b = s.pop(); const a = s.pop(); s.push(a == b) },
  NEQ(frame) { const s = frame.stack; const b = s.pop(); const a = s.pop(); s.push(a != b) },
  SEQ(frame) { const s = frame.stack; const b = s.pop(); const a = s.pop(); s.push(a === b) },
  SNEQ(frame) { const s = frame.stack; const b = s.pop(); const a = s.pop(); s.push(a !== b) },
  LT(frame) { const s = frame.stack; const b = s.pop(); const a = s.pop(); s.push(a < b) },
  LTE(frame) { const s = frame.stack; const b = s.pop(); const a = s.pop(); s.push(a <= b) },
  GT(frame) { const s = frame.stack; const b = s.pop(); const a = s.pop(); s.push(a > b) },
  GTE(frame) { const s = frame.stack; const b = s.pop(); const a = s.pop(); s.push(a >= b) },
  BAND(frame) { const s = frame.stack; const b = s.pop(); const a = s.pop(); s.push(a & b) },
  BOR(frame) { const s = frame.stack; const b = s.pop(); const a = s.pop(); s.push(a | b) },
  BXOR(frame) { const s = frame.stack; const b = s.pop(); const a = s.pop(); s.push(a ^ b) },
  SHL(frame) { const s = frame.stack; const b = s.pop(); const a = s.pop(); s.push(a << b) },
  SHR(frame) { const s = frame.stack; const b = s.pop(); const a = s.pop(); s.push(a >> b) },
  USHR(frame) { const s = frame.stack; const b = s.pop(); const a = s.pop(); s.push(a >>> b) },
  NOT(frame) { const s = frame.stack; s.push(!s.pop()) },
  NEG(frame) { const s = frame.stack; s.push(-s.pop()) },
  POS(frame) { const s = frame.stack; s.push(+s.pop()) },
  BNOT(frame) { const s = frame.stack; s.push(~s.pop()) },
  TYPEOF(frame) { const s = frame.stack; s.push(typeof s.pop()) },
  INSTANCEOF(frame) { const s = frame.stack; const b = s.pop(); const a = s.pop(); s.push(a instanceof b) },
  IN(frame) { const s = frame.stack; const b = s.pop(); const a = s.pop(); s.push(a in b) },

  GET_PROP(frame, arg, consts) { const s = frame.stack; const o = s.pop(); s.push(o[consts[arg]]) },
  GET_PROP_DYN(frame) { const s = frame.stack; const k = s.pop(); const o = s.pop(); s.push(o[k]) },
  SET_PROP(frame, arg, consts) { const s = frame.stack; const v = s.pop(); const o = s.pop(); o[consts[arg]] = v; s.push(v) },
  SET_PROP_DYN(frame) { const s = frame.stack; const v = s.pop(); const k = s.pop(); const o = s.pop(); o[k] = v; s.push(v) },
  DELETE_PROP(frame, arg, consts) { const s = frame.stack; const o = s.pop(); s.push(delete o[consts[arg]]) },
  DELETE_PROP_DYN(frame) { const s = frame.stack; const k = s.pop(); const o = s.pop(); s.push(delete o[k]) },

  JMP(frame, arg) { frame.pc = arg },
  JMP_IF_FALSE(frame, arg) { if (!frame.stack.pop()) frame.pc = arg },
  JMP_IF_TRUE(frame, arg) { if (frame.stack.pop()) frame.pc = arg },
  JMP_IF_FALSY_KEEP(frame, arg) { const s = frame.stack; if (!s[s.length - 1]) frame.pc = arg; else s.pop() },
  JMP_IF_TRUTHY_KEEP(frame, arg) { const s = frame.stack; if (s[s.length - 1]) frame.pc = arg; else s.pop() },
  JMP_IF_NOT_NULLISH_KEEP(frame, arg) { const s = frame.stack; if (s[s.length - 1] != null) frame.pc = arg; else s.pop() },
  OPT_SHORT(frame, arg) { const s = frame.stack; if (s[s.length - 1] == null) { s.pop(); s.push(undefined); frame.pc = arg } },
  // obj.m?.(): stack is [recv, fn]; if fn is nullish drop BOTH, push undefined,
  // and short-circuit the chain; otherwise leave [recv, fn] for the call.
  OPT_SHORT_CALL(frame, arg) { const s = frame.stack; if (s[s.length - 1] == null) { s.pop(); s.pop(); s.push(undefined); frame.pc = arg } },

  CALL(frame, arg, consts, functions, globals, createClosure, callValue) {
    const s = frame.stack; const args = new Array(arg)
    for (let i = arg - 1; i >= 0; i--) args[i] = s.pop()
    const fn = s.pop(); s.push(callValue(fn, undefined, args))
  },
  CALL_METHOD(frame, arg, consts, functions, globals, createClosure, callValue) {
    const s = frame.stack; const args = new Array(arg)
    for (let i = arg - 1; i >= 0; i--) args[i] = s.pop()
    const fn = s.pop(); const recv = s.pop(); s.push(callValue(fn, recv, args))
  },
  CALL_APPLY(frame, arg, consts, functions, globals, createClosure, callValue) {
    const s = frame.stack; const args = s.pop(); const fn = s.pop(); s.push(callValue(fn, undefined, args))
  },
  CALL_METHOD_APPLY(frame, arg, consts, functions, globals, createClosure, callValue) {
    const s = frame.stack; const args = s.pop(); const fn = s.pop(); const recv = s.pop(); s.push(callValue(fn, recv, args))
  },
  NEW(frame, arg) {
    const s = frame.stack; const args = new Array(arg)
    for (let i = arg - 1; i >= 0; i--) args[i] = s.pop()
    const ctor = s.pop()
    if (typeof ctor !== 'function') throw new TypeError(String(ctor) + ' is not a constructor')
    s.push(Reflect.construct(ctor, args))
  },
  NEW_APPLY(frame) {
    const s = frame.stack; const args = s.pop(); const ctor = s.pop()
    if (typeof ctor !== 'function') throw new TypeError(String(ctor) + ' is not a constructor')
    s.push(Reflect.construct(ctor, args))
  },
  MAKE_FUNC(frame, arg, consts, functions, globals, createClosure) {
    const def = functions[arg]
    frame.stack.push(createClosure(def, {
      scope: frame.scope,
      arrowThis: frame.thisVal,
      newTarget: frame.newTarget,
      home: frame.home,
      ownHome: undefined,
      privs: frame.privs,
      module: frame.module,
    }))
  },
  RETURN(frame, arg, consts, functions, globals, createClosure, callValue, doReturn) {
    return doReturn(frame, frame.stack.pop())
  },
  RETURN_UNDEF(frame, arg, consts, functions, globals, createClosure, callValue, doReturn) {
    return doReturn(frame, undefined)
  },

  ARR_EMPTY(frame) { frame.stack.push([]) },
  ARR_APPEND(frame) { const s = frame.stack; const v = s.pop(); s[s.length - 1].push(v) },
  ARR_SPREAD(frame) { const s = frame.stack; const it = s.pop(); const arr = s[s.length - 1]; for (const x of it) arr.push(x) },
  OBJ_EMPTY(frame) { frame.stack.push({}) },
  OBJ_SET(frame, arg, consts) { const s = frame.stack; const v = s.pop(); s[s.length - 1][consts[arg]] = v },
  // {key: <literal>} — fuses PUSH_CONST ; OBJ_SET. const = [key, valueConstIdx];
  // the value is read from the (already-decoded) const pool so NaN/-0/BigInt/
  // RegExp literals stay correct. Object stays on the stack.
  OBJ_SET_CONST(frame, arg, consts) { const c = consts[arg]; const s = frame.stack; s[s.length - 1][c[0]] = consts[c[1]] },
  OBJ_SET_DYN(frame) { const s = frame.stack; const v = s.pop(); const k = s.pop(); s[s.length - 1][k] = v },
  OBJ_SPREAD(frame) { const s = frame.stack; const src = s.pop(); Object.assign(s[s.length - 1], src) },
  OBJ_DEFINE_GETTER(frame, arg, consts) {
    const s = frame.stack; const fn = s.pop()
    Object.defineProperty(s[s.length - 1], consts[arg], { get: fn, enumerable: true, configurable: true })
  },
  OBJ_DEFINE_SETTER(frame, arg, consts) {
    const s = frame.stack; const fn = s.pop()
    Object.defineProperty(s[s.length - 1], consts[arg], { set: fn, enumerable: true, configurable: true })
  },
  OBJ_REST(frame, arg, consts) {
    const s = frame.stack; const src = s.pop()
    const excluded = JSON.parse(consts[arg]); const rest = {}
    for (const k of Object.keys(src)) if (excluded.indexOf(k) < 0) rest[k] = src[k]
    s.push(rest)
  },
  // rest with a runtime-computed exclusion list (computed keys before `...rest`).
  // stack: [source, excludedArray]
  OBJ_REST_DYN(frame) {
    const s = frame.stack; const excluded = s.pop(); const src = s.pop()
    const ex = excluded.map((k) => (typeof k === 'symbol' ? k : String(k)))
    const rest = {}
    for (const k of Object.keys(src)) if (ex.indexOf(k) < 0) rest[k] = src[k]
    s.push(rest)
  },

  GET_ITERATOR(frame) {
    const s = frame.stack; const it = s.pop()
    if (it == null) throw new TypeError('is not iterable')
    const m = it[Symbol.iterator]
    if (typeof m !== 'function') throw new TypeError(typeof it + ' is not iterable')
    s.push(m.call(it))
  },
  FOR_ITER(frame, arg) {
    const s = frame.stack; const iter = s.pop(); const r = iter.next()
    if (r.done) frame.pc = arg; else s.push(r.value)
  },
  ITER_NEXT_PUSH(frame) { const s = frame.stack; const iter = s[s.length - 1]; const r = iter.next(); s.push(r.done ? undefined : r.value) },
  ITER_REST_PUSH(frame) {
    const s = frame.stack; const iter = s[s.length - 1]; const arr = []
    while (true) { const r = iter.next(); if (r.done) break; arr.push(r.value) }
    s.push(arr)
  },
  FOR_IN_KEYS(frame) {
    const s = frame.stack; const o = s.pop(); const keys = []
    if (o != null) { for (const k in o) keys.push(k) }
    s.push(keys)
  },

  THROW(frame) { throw frame.stack.pop() },
  RETHROW(frame) { throw frame.stack.pop() },
  PUSH_HANDLER(frame, arg) { frame.handlers.push({ type: 'catch', target: arg, sp: frame.stack.length, scope: frame.scope }) },
  PUSH_FINALLY(frame, arg) { frame.handlers.push({ type: 'finally', target: arg, sp: frame.stack.length, scope: frame.scope }) },
  POP_HANDLER(frame) { frame.handlers.pop() },
  PUSH_COMPLETION_NORMAL(frame) { frame.completions.push({ kind: 'normal' }) },
  END_FINALLY(frame, arg, consts, functions, globals, createClosure, callValue, doReturn) {
    const rec = frame.completions.pop()
    if (rec.kind === 'normal') { frame.pc = arg; return }
    if (rec.kind === 'throw') throw rec.value
    if (rec.kind === 'return') return doReturn(frame, rec.value)
    if (rec.kind === 'jump') return doJump(frame, rec.target, rec.stop)
  },
  ABRUPT_JUMP(frame, arg, consts) {
    const c = consts[arg] // { target, stop }
    return doJump(frame, c.target, c.stop)
  },

  AWAIT(frame) { return { type: 'await', value: frame.stack.pop() } },
  AWAIT_TOP(frame) { return { type: 'await', value: frame.stack.pop() } },

  // ---- classes ----
  BUILD_CLASS(frame, arg, consts, functions, globals, createClosure, callValue, doReturn, vm) {
    const s = frame.stack
    const computedKeys = s.pop()
    const superClass = s.pop()
    const desc = typeof consts[arg] === 'string' ? JSON.parse(consts[arg]) : consts[arg]
    s.push(buildClass(desc, superClass, computedKeys, frame, functions, createClosure, vm))
  },
  SUPER_GET(frame, arg, consts) {
    const proto = Object.getPrototypeOf(frame.home)
    frame.stack.push(Reflect.get(proto, consts[arg], frame.thisVal))
  },
  SUPER_GET_DYN(frame) {
    const s = frame.stack; const key = s.pop()
    const proto = Object.getPrototypeOf(frame.home)
    s.push(Reflect.get(proto, key, frame.thisVal))
  },
  SUPER_SET(frame, arg, consts) {
    const s = frame.stack; const v = s.pop()
    Reflect.set(Object.getPrototypeOf(frame.home), consts[arg], v, frame.thisVal)
    s.push(v)
  },
  SUPER_SET_DYN(frame) {
    const s = frame.stack; const v = s.pop(); const key = s.pop()
    Reflect.set(Object.getPrototypeOf(frame.home), key, v, frame.thisVal)
    s.push(v)
  },
  SUPER_CALL(frame, arg, consts, functions, globals, createClosure, callValue, doReturn, vm) {
    const s = frame.stack; const args = new Array(arg)
    for (let i = arg - 1; i >= 0; i--) args[i] = s.pop()
    superCall(frame, args, vm)
  },
  SUPER_CALL_APPLY(frame, arg, consts, functions, globals, createClosure, callValue, doReturn, vm) {
    const s = frame.stack; const args = s.pop()
    superCall(frame, Array.from(args), vm)
  },
  GET_PRIVATE(frame, arg, consts) {
    const s = frame.stack; const pn = consts[arg]; const obj = s.pop()
    const e = frame.privs && frame.privs[pn]
    if (!e || !e.map.has(obj)) throw new TypeError('Cannot read private member ' + pn + ' from an object whose class did not declare it')
    if (e.kind === 'accessor') {
      if (!e.get) throw new TypeError("'" + pn + "' was defined without a getter")
      s.push(e.get.call(obj)); return
    }
    s.push(e.map.get(obj))
  },
  SET_PRIVATE(frame, arg, consts) {
    const s = frame.stack; const pn = consts[arg]; const v = s.pop(); const obj = s.pop()
    const e = frame.privs && frame.privs[pn]
    if (!e || (e.kind !== 'accessor' && !e.map.has(obj))) throw new TypeError('Cannot write private member ' + pn + ' to an object whose class did not declare it')
    if (e.kind === 'accessor') {
      if (!e.set) throw new TypeError("'" + pn + "' was defined without a setter")
      e.set.call(obj, v); s.push(v); return
    }
    if (e.kind === 'method') throw new TypeError('Cannot write to private method ' + pn)
    e.map.set(obj, v); s.push(v)
  },
  HAS_PRIVATE(frame, arg, consts) {
    const s = frame.stack; const pn = consts[arg]; const obj = s.pop()
    const e = frame.privs && frame.privs[pn]
    s.push(!!e && (obj !== null && typeof obj === 'object' || typeof obj === 'function') && e.map.has(obj))
  },
  INIT_PRIVATE(frame, arg, consts) {
    // reserved: per-instance private field install is handled by buildClass.
    const s = frame.stack; const pn = consts[arg]; const v = s.pop(); const obj = s[s.length - 1]
    const e = frame.privs && frame.privs[pn]
    if (e) e.map.set(obj, v)
  },

  // ---- ES modules ----
  MODULE_INIT() { /* module env + record provided by the loader; no-op marker */ },
  IMPORT_BINDING(frame, arg, consts) {
    const d = typeof consts[arg] === 'string' ? JSON.parse(consts[arg]) : consts[arg]
    const src = frame.module.resolve(d.source)
    frame.scope.vars.set(d.local, { import: true, src, ikind: d.kind, iname: d.imported })
  },
  // slot-based import: install a live import cell at the module-scope slot.
  IMPORT_SLOT(frame, arg, consts) {
    const d = typeof consts[arg] === 'string' ? JSON.parse(consts[arg]) : consts[arg]
    const src = frame.module.resolve(d.source)
    frame.scope.slots[d.slot] = { import: true, v: undefined, kind: 2, init: true, src, ikind: d.kind, iname: d.imported }
  },
  EXPORT_BINDING(frame, arg, consts) {
    const name = consts[arg]
    const v = frame.stack.pop()
    const b = lookup(frame.scope, name)
    if (b === undefined) throw fatal('internal: EXPORT_BINDING missing binding ' + name)
    b.v = v; b.init = true
  },
  DYNAMIC_IMPORT(frame) {
    const s = frame.stack; const spec = s.pop()
    s.push(frame.module.dynamicImport(spec))
  },
  IMPORT_META(frame) { frame.stack.push(frame.module.meta) },

  SET_COMPLETION(frame) { frame.completion = frame.stack.pop() },
}

// super(...) inside a derived-class constructor: construct the superclass with
// the active new.target, brand + field-init the result, and bind it as `this`.
function superCall(frame, args, vm) {
  const c = frame.ctor
  if (!c) throw new SyntaxError("'super' keyword unexpected here")
  if (frame.thisVal !== vm.TDZ) throw new ReferenceError('Super constructor may only be called once per instance')
  const Sup = c.superClass === null || c.superClass === undefined ? Object : c.superClass
  const o = Reflect.construct(Sup, args, frame.newTarget)
  c.brandInstance(o)
  c.initFields(o)
  frame.thisVal = o
  frame.stack.push(o)
}

// Build a class object from a compiled descriptor. Uses native prototype wiring
// + Reflect.construct for super semantics; private names use per-class WeakMaps
// (brand check); getters/setters/static/fields handled per the descriptor.
function buildClass(desc, superClass, computedKeys, frame, functions, createClosure, vm) {
  if (superClass !== undefined && superClass !== null && typeof superClass !== 'function') {
    throw new TypeError('Class extends value ' + String(superClass) + ' is not a constructor or null')
  }
  const hasSuper = desc.hasSuper
  const proto = {}
  if (hasSuper) Object.setPrototypeOf(proto, superClass === null ? null : superClass.prototype)

  const privEnv = {}
  for (const pn of (desc.privNames || [])) privEnv[pn] = { map: new WeakMap(), kind: 'field' }

  // Snapshot the class's DEFINING scope. buildClass runs during BUILD_CLASS,
  // when frame.scope is the scope the class body was compiled against (for a
  // named class expression, the name-wrapper scope that EXIT_SCOPE pops right
  // after BUILD_CLASS). The constructor and field initializers are invoked
  // LATER, at `new` time, so they must capture this snapshot — reading the live
  // frame.scope then would see whatever ENTER/EXIT_SCOPE left behind (the
  // wrapper already popped), making the ctor's compiled slot depths overflow
  // the scope chain (LOAD_SLOT on a null scope). Methods already captured it
  // eagerly below; this makes the ctor/fields consistent with them.
  const defScope = frame.scope
  const defModule = frame.module
  const keyOf = (m) => (m.computed ? computedKeys[m.computedIndex] : m.key)
  const ctxFor = (ownHome) => ({
    scope: defScope, arrowThis: undefined, newTarget: undefined,
    home: undefined, ownHome, privs: privEnv, module: defModule,
  })

  const ctorDef = desc.ctor != null ? functions[desc.ctor] : null
  const instanceFields = []
  const instancePrivBrands = []
  const staticFields = []

  let Ctor

  function brandInstance(obj) {
    for (const b of instancePrivBrands) {
      if (b.kind === 'method') privEnv[b.priv].map.set(obj, b.fn)
      else privEnv[b.priv].map.set(obj, true)
    }
  }
  function initFields(obj) {
    for (const f of instanceFields) {
      const val = f.fn != null ? createClosure(functions[f.fn], ctxFor(proto)).call(obj) : undefined
      if (f.private) privEnv[f.priv].map.set(obj, val)
      else obj[keyOf(f)] = val
    }
  }

  Ctor = function (...args) {
    const nt = new.target
    if (nt === undefined) throw new TypeError("Class constructor " + (desc.name || '') + " cannot be invoked without 'new'")
    if (!hasSuper) {
      const obj = Object.create(nt.prototype || proto)
      brandInstance(obj)
      initFields(obj)
      if (ctorDef) {
        const f = vm.makeFrame(ctorDef, defScope, obj, args, { newTarget: nt, home: proto, privs: privEnv, module: defModule })
        const r = vm.runSync(f)
        if (r !== null && r !== undefined && (typeof r === 'object' || typeof r === 'function')) return r
      }
      return obj
    }
    if (!ctorDef) {
      const obj = Reflect.construct(superClass === null ? Object : superClass, args, nt)
      brandInstance(obj)
      initFields(obj)
      return obj
    }
    const f = vm.makeFrame(ctorDef, defScope, vm.TDZ, args, {
      newTarget: nt, home: proto, privs: privEnv, module: defModule,
      ctor: { superClass, brandInstance, initFields },
    })
    const r = vm.runSync(f)
    if (r !== null && r !== undefined && (typeof r === 'object' || typeof r === 'function')) return r
    if (f.thisVal === vm.TDZ) throw new ReferenceError("Must call super constructor in derived class before returning")
    return f.thisVal
  }

  try { Ctor.prototype = proto } catch (_) {}
  try { Object.defineProperty(proto, 'constructor', { value: Ctor, enumerable: false, writable: true, configurable: true }) } catch (_) {}
  if (hasSuper) Object.setPrototypeOf(Ctor, superClass === null ? Function.prototype : superClass)
  if (desc.name) { try { Object.defineProperty(Ctor, 'name', { value: desc.name, configurable: true }) } catch (_) {} }
  if (ctorDef) { try { Object.defineProperty(Ctor, 'length', { value: ctorDef.numParams, configurable: true }) } catch (_) {} }

  // accumulate public get/set pairs so both land on one property descriptor
  const accessors = new Map()

  for (const m of desc.members) {
    if (m.kind === 'field') {
      if (m.static) staticFields.push(m); else instanceFields.push(m)
      continue
    }
    // method / get / set
    const target = m.static ? Ctor : proto
    const fn = createClosure(functions[m.fn], ctxFor(target))
    if (m.private) {
      const e = privEnv[m.priv]
      if (m.kind === 'method') {
        e.kind = 'method'
        if (m.static) e.map.set(Ctor, fn)
        else instancePrivBrands.push({ priv: m.priv, kind: 'method', fn })
      } else {
        e.kind = 'accessor'
        if (m.kind === 'get') e.get = fn; else e.set = fn
        if (m.static) e.map.set(Ctor, true)
        else if (instancePrivBrands.findIndex((b) => b.priv === m.priv) < 0) instancePrivBrands.push({ priv: m.priv, kind: 'accessor' })
      }
    } else if (m.kind === 'get' || m.kind === 'set') {
      const key = keyOf(m)
      const mk = (m.static ? 's:' : 'i:') + String(key)
      let acc = accessors.get(mk)
      if (!acc) { acc = { target, key }; accessors.set(mk, acc) }
      acc[m.kind] = fn
    } else {
      Object.defineProperty(target, keyOf(m), { value: fn, writable: true, configurable: true, enumerable: false })
    }
  }
  for (const acc of accessors.values()) {
    const d = { configurable: true, enumerable: false }
    if (acc.get) d.get = acc.get
    if (acc.set) d.set = acc.set
    Object.defineProperty(acc.target, acc.key, d)
  }

  for (const m of staticFields) {
    const val = m.fn != null ? createClosure(functions[m.fn], ctxFor(Ctor)).call(Ctor) : undefined
    if (m.private) privEnv[m.priv].map.set(Ctor, val)
    else Ctor[keyOf(m)] = val
  }

  return Ctor
}
