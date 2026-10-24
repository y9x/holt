# shield — client-protection VM (PLAN P2–P4)

A per-build polymorphic stack-bytecode VM for JavaScript, a **whole-chunk ES
module loader**, and a Vite post-build plugin that compiles the real app bundle
to encrypted bytecode. This covers PLAN **P2** (compiler), **P3** (runtime),
and **P4** (whole-chunk loader + plugin). The earlier pass stopped at a JS
subset with no module loader; this pass adds full ES modules, classes, and the
loader, and PROVES the real app boots as bytecode.

**Honesty is the deliverable.** This README states exactly what works, what
falls back to native (`@no-vm`), and the integration-proof result. See the
*What runs / what falls back* matrix and *Integration proof* below.

## Files

| File | What it is | Status |
|---|---|---|
| `opcodes.ts` | Opcode names, arities, per-build polymorphic layout (`buildLayout`); slot ops + superinstructions | Done |
| `compiler.ts` | acorn AST → stack bytecode + constant pool; full ES modules + classes + `arguments` + break/continue-across-finally; compile-time slot-based locals + superinstruction fusion + block-scope elision; XChaCha20-Poly1305 encrypt | Done |
| `runtime-template.js` | The VM: handler-table dispatch, sync/async, classes/super/private, module ops, traps, **wall-clock watchdog**, boot integrity + toString anti-tamper, decrypt | Done |
| `anti-tamper.js` | PLAN P7 anti-tamper: bytecode integrity hash, VM toString snapshot guard, timing monitor, consolidated `isLikelyBot`, mutation guard — individually flagged, conservative defaults | Done |
| `anti-tamper.test.mjs` | Per-feature tests + the wipe/flag policy guarantees | Done |
| `loader-template.js` | Whole-chunk ESM loader: module records, live bindings, circular, dynamic import, TLA, import.meta | Done |
| `vite-plugin.ts` | Post-build plugin: compiles the sound VM frontier, emits register-artifacts + loader bootstrap + manifest, rewrites index.html | Done |
| `compiler.test.mjs` | Corpus: VM result vs native `eval` (incl. classes) | Done |
| `module.test.mjs` | Module corpus: live bindings, circular, dynamic import, TLA, import.meta, re-exports vs native ESM | Done |
| `runtime.test.mjs` | Trap/wipe, step budget, polymorphism, decrypt integrity | Done |

## Module semantics now supported (the crux)

The compiler parses `sourceType:'module'` and lowers import/export into a module
descriptor + module ops; the loader links a graph of compiled chunks.

- **Static `import`** — default, named, namespace (`import * as ns`), and
  side-effect (`import './x'`).
- **`export`** — named (`export const/let/function/class`, `export {a as b}`),
  default (`export default <expr|function|class>`), re-export (`export {x} from`),
  `export * from`, and `export * as ns from`.
- **LIVE bindings** — an import reads the exporter's binding at access time
  (`resolveImport`), so a reassignment in the exporter is visible to importers.
  Assigning to an import throws `TypeError` (read-only).
- **Circular imports** — two-phase: the loader registers + links the whole
  static closure first, then evaluates in dependency order with a cycle guard;
  bindings accessed before the owner evaluates throw TDZ `ReferenceError`.
- **Dynamic `import()`** — the loader fetches + instantiates the target chunk at
  runtime and returns its namespace. Both string-literal and
  no-substitution-template specifiers (Vite's form, `` import(`./route.js`) ``)
  are statically mapped to module ids; a genuinely computed specifier keeps the
  containing chunk `@no-vm` (see fallbacks).
- **Top-level await** — a module body with top-level `await` runs as an async
  frame; the loader awaits it (and async deps) before dependents evaluate.
- **`import.meta`** — per-module `{ url }`.

Module ops (PLAN 5.5): `MODULE_INIT`, `IMPORT_BINDING`, `EXPORT_BINDING`,
`DYNAMIC_IMPORT`, `IMPORT_META`, `AWAIT_TOP`.

## Classes now supported

Declarations + expressions (incl. named class expressions), instance/static
methods, getters/setters, instance/static fields, **private** fields/methods/
accessors (`#x`, with `#x in obj` brand checks), `extends`/`super()`/
`super.method()`/`super.prop`, `new.target`, and computed keys. Private state
uses per-class `WeakMap`s; super uses native prototype wiring +
`Reflect.construct` for derived-class `this`. Tested == native (`compiler.test.mjs`
“classes”).

Class ops: `BUILD_CLASS`, `LOAD_NEW_TARGET`, `SUPER_GET/_DYN`, `SUPER_SET/_DYN`,
`SUPER_CALL/_APPLY`, `GET_PRIVATE`, `SET_PRIVATE`, `HAS_PRIVATE`.

## Loader status (P4)

| Capability | Status |
|---|---|
| Module records + live cross-chunk bindings | **Done, browser-proven** |
| Circular imports (two-phase link/evaluate) | **Done, tested** |
| Dynamic `import()` (static + template specifiers) | **Done, browser-proven** |
| Top-level await | **Done, tested** |
| `import.meta` | **Done, tested** |
| VM ↔ native (`@no-vm`) interop | **Done** — VM chunks may import native chunks (loader native-imports them); a sound fixpoint prevents native→VM edges |
| Key delivery into the page | **Done** — per-chunk key is base64 in the register artifact (cost-raising only, per PLAN 1/5.8) |
| `vite dev` transform | **Not done** — compile mode is a build-time (post-bundle) step; dev serves unbundled ESM unchanged |

## Bootstrap choice

A **first-script bootstrap** (not inline): the plugin bundles
`runtime-template` + `loader-template` + `@noble/ciphers` (via esbuild) into one
mangled `assets/*.js`, inlines the manifest, and rewrites `index.html` so the
entry `<script type="module">` points at it (modulepreload links are dropped).
Chosen over inlining because it needs no CSP `'unsafe-inline'` and keeps the
runtime out of the HTML. URLs resolve relative to the bootstrap's own
`import.meta.url`, so it works under absolute (`main`/`aws`) AND relative
(`jsdelivr`/`singlefile` `./assets/`) layouts. The `/8f3c1a.js` cloak path is
not yet wired (tracked).

## Build integration

All four build variants invoke the SAME `main/vite.config.ts` via `npx vite
build` with different `--base`/`--outDir` (`aws/build.sh`,
`svg/scripts/rebuild_jsdelivr.sh`, `singlefile/scripts/build.sh`), so this
plugin covers all of them automatically. The loader resolves chunk URLs
relative to its own location, so it is correct for both absolute and relative
(`./assets/`) layouts.

### File-name references and the emit-time guard

Output names are content hashes (`assets/[hash].js`) and every VM chunk is
renamed to `assets/s_<id>.js`, so a chunk's code may hold the ORIGINAL name of a
sibling in places that are not import specifiers. Vite's modulepreload helper is
the known case: `__vite__mapDeps` is an array of dep file names — `"assets/<hash>.js"`
under an absolute `base`, `"./<hash>.js"` under `base: './'` — that
`__vitePreload` turns into `<link rel="modulepreload">` tags. Such strings compile
into the encrypted constant pool verbatim, so once renamed they would preload
files that no longer exist (404s with no script initiator, invisible to every
post-build scanner). The plugin therefore, after the VM frontier is fixed and
before compiling:

1. rewrites every non-specifier string (string literal or interpolation-free
   template, located with acorn) that RESOLVES to a renamed chunk — keyed on the
   bundle file name, never on a name pattern — to the mangled file in the same
   shape (`assets/s_<id>.js` or `./s_<id>.js`), and recompiles the chunk;
2. **guards** (hard build failure via `ShieldGuardError`, rethrown past the
   "ship native" catch, no opt-out) that no chunk, VM or native, still names a
   removed file in any string, and that every static import, re-export source
   and literal dynamic `import()` specifier of every VM chunk maps to a known
   module id. The loader likewise refuses a chunk-relative `import()` specifier
   that is not in its dep maps instead of fetching the raw path.

`vite.config.ts` wires `shieldPlugin({ mode: process.env.SHIELD_MODE ===
'manifest' ? 'manifest' : 'compile' })`. **Compile mode is now the DEFAULT
(ungated).** It compiles the sound VM frontier to bytecode, emits the loader
bootstrap and rewrites `index.html`. `SHIELD_MODE=manifest` is a debug opt-out
(analysis only, never rewrites chunks). The per-chunk `@no-vm` fallback and the
entry-not-in-frontier → ship-native-untouched rule remain the safety net, so an
unforeseen uncompilable construct degrades gracefully instead of breaking.

## Step-budget → watchdog redesign (the `/games` fix)

The old runtime had a single cumulative step counter capped at 20M, reset only
at the top-level `run()`. Because every later call back into a chunk's runtime
(a React render, an event handler, an effect, a timer) kept incrementing the
SAME counter without resetting it, the "budget" was really a *total
instructions this chunk may ever execute on the page* cap — so any long-lived
or heavy route (notably `/games`) tripped `step budget exceeded` doing
legitimate work. That was a false positive, not a safety win.

The cap is now a **per-synchronous-burst wall-clock watchdog**
(`runtime-template.js`): the step counter and a `performance.now()` start time
reset on every host→VM entry (re-entrancy depth 0→1) and at every async resume.
Within a burst the clock is sampled every ~1M steps and the runtime trips
(wipe + fatal throw) only after `watchdogMs` (default **10s**) of *uninterrupted
synchronous* execution. Legitimate renders return to the event loop long before
that; `while(true){}` does not — so infinite loops and a tampered runtime that
spins are still caught, and the trap-wipe still fires. An explicit numeric
`budget` option keeps a hard per-burst step cap (the fast unit tests use it so
they don't spin for whole seconds); production ships with no step cap and relies
on the watchdog. This is what lets `/games` (and every other route) run to
completion.

## How compile mode stays sound (and never ships broken)

VM chunks are linked by the shield loader; native fallback chunks by the
browser's ESM loader. Mixing is sound only if **no native chunk imports a VM
chunk** (a native `import` of a mangled register-artifact would get no exports).
The plugin computes a fixpoint: start from the chunks that compile, then demote
any VM chunk imported (statically or dynamically) by a native chunk, plus any
chunk with an unresolved/external import or a computed dynamic import. If the
entry chunk is not in the final VM set, the plugin ships the original native
build untouched and says so in the manifest. Every decision + reason is written
to `shield-manifest.json`.

## Integration proof (real `main` app, headless Chrome)

A scratch `SHIELD_MODE=compile` build of the real app + a headless-Chrome boot
(via CDP over the `ws` dep + `/usr/bin/google-chrome`) was run. Result:

- **All 25 of 25 JS chunks compile to encrypted bytecode** (`bootViaLoader:
  true`, `counts {vm:25, native:0}`). Zero `@no-vm` fallbacks: the former two
  native chunks — `vendor-react` (`break`/`continue` across `finally`) and the
  rolldown runtime glue — now compile (see below).
- **Four routes boot and render the real UI through the VM with zero shield
  errors**, measured time-to-first-render / time-to-stable (headless, noisy ±,
  the stub backend returns empty JSON so the only console noise is 404/websocket
  from missing APIs — not shield):

  | Route | first render | stable | DOM | shield errors |
  |---|---|---|---|---|
  | home | ~510ms* | ~1.25s | 16.5 KB | none |
  | games | ~230ms | ~2.0s | 138 KB | none |
  | account | ~255ms | ~1.23s | 13 KB | none |
  | chat | ~220ms | ~1.27s | 21.6 KB | none |

  *home's number is dominated by the initial document-load wait, not VM work.
  Against the untouched native build (`SHIELD_MODE=manifest`) the VM adds roughly
  +150–250 ms to first render; stable times are near-native (games is within
  noise). Honest judgment: **usable** — the VM boot cost is a sub-quarter-second
  first-render overhead, and `/games` completes fully.

`/games` previously threw `step budget exceeded`; the watchdog redesign (above)
fixed it — it now renders a 138 KB DOM with no shield errors.

## What runs / what falls back

| Construct | VM | Note |
|---|---|---|
| All P2 subset (expr/stmt, closures, async/await, try/catch/finally, destructuring, spread/rest, optional chaining, template literals, BigInt) | ✅ | tested == native |
| Classes (methods, get/set, static, private, extends/super, new.target) | ✅ | tested == native |
| ES modules (static import/export, live bindings, namespace, re-export, default) | ✅ | tested == native |
| Dynamic `import()` (literal / template specifier) | ✅ | loader maps to chunk id |
| Top-level await, circular imports, `import.meta` | ✅ | tested == native |
| Logical assignment on members (`obj.x ??=/||=/&&= y`), optional method call (`o.m?.()`), computed key before object rest | ✅ | these were the dominant real-bundle blockers |
| `break`/`continue` across a `finally` (incl. labeled, nested finallys, per-iteration scopes, catch+finally) | ✅ | completion-record routing + scope trampoline; tested == native |
| `arguments` (non-arrow functions; arrows inherit) | ✅ | bound lazily only when referenced; tested == native |
| Generators / `yield`, `for await…of` | ❌ `@no-vm` | |
| `eval` / `new Function` / `with` / tagged templates | ❌ `@no-vm` | dynamic code / unsupported |
| Computed (non-static) dynamic `import()` | ❌ `@no-vm` | can't map to a chunk id |
| Heavy / long-lived routes | ✅ | watchdog is wall-clock, not a cumulative step cap — no false trips |

For the **real `main` bundle, the residual `@no-vm` set is empty** (25/25
compile). The remaining ❌ rows are language features the bundle does not use;
if a future dependency introduces one, that chunk degrades to `@no-vm` (its
string literals are still encrypted by `scripts/obfuscate-build.mjs` at the
Makefile level) and the manifest records why.

## Performance (PLAN 5.11)

Measured on a representative CPU-bound workload (object building, property
access, method calls, loops — the hot ops per the AST histogram) via a Node
microbench of the interpreter, median of repeated runs:

| Change | ms/run | vs baseline |
|---|---|---|
| Baseline (handler table, Map scopes, 20M cumulative cap) | 38.1 | 1.00× |
| + per-frame try/catch (lifted out of the per-op loop) | 38.8 | ~1.00× (enabler; no solo win here) |
| + **compile-time slot-based locals** (array-indexed scopes, no Map/hashing) | 33.4 | **1.14×** |
| + **superinstructions** (fused hot bigrams/trigrams) | 31.2 | **1.22×** |

- **Slot-based locals** were the single biggest low-risk win. A CPU profile of
  the baseline showed `FindOrderedHashMapEntry` (the scope-chain `Map` lookups)
  at ~17% of interpreter time; resolving every lexical binding to a
  `(depth, index)` slot at compile time (TDZ/const/`import` cells preserved)
  eliminated it. Free variables resolve to `*_GLOBAL` ops; module exports
  resolve by slot via `program.module.exportSlots`.
- **Superinstructions** fuse the top sequences from a static analysis of real
  shield-compiled app bytecode, cutting BOTH dispatch overhead and *step count*
  (the lever that matters for heavy routes): `BIND_PARAM` (the
  DECLARE;LOAD_ARG;INIT param-prologue triple), `LOAD_SLOT_PROP` /
  `LOAD_GLOBAL_PROP` (`ident.key`), and `LOAD_SLOT_DUP_PROP` /
  `LOAD_GLOBAL_DUP_PROP` (the `ident.method()` receiver pattern). Multi-operand
  fused ops carry their operands as a constant-pool tuple, so the single-operand
  dispatch loop is unchanged.

### Deeper step-count reduction (second pass)

Three structural/emit-time changes, each measured on the four bench workloads
(production compiler+runtime, `_steps` counter) **and** as the static opcode
total over the real app source (188 compiled files; a build-free proxy for route
step density). Only changes that helped were kept.

| Change | what it fuses | where it wins |
|---|---|---|
| **Block-scope elision** | a nested `{…}` with no `let`/`const`/`class`/`function` decl runs in the enclosing scope — no `ENTER_SCOPE`/`EXIT_SCOPE` (−2 steps per block execution) | hot loop/branch bodies |
| **`OBJ_SET_CONST`** | `PUSH_CONST ; OBJ_SET` → one op for `{ key: <literal> }` (value kept in the const pool by index, so NaN/-0/BigInt/RegExp stay correct) | object literals (the #1 real-bundle bigram) |
| **`DECLARE_SLOTS`** | a contiguous same-kind run of `DECLARE_SLOT` (block-prologue TDZ cells) → one op (`DECLARE_CONST;DECLARE_CONST…` real-bundle run) | blocks/modules with many `const`/`let` |

Measured step count (and median ms), before → after this pass:

| Workload | steps before | steps after | Δ steps | ms before → after |
|---|---|---|---|---|
| arith | 60,000,016 | 56,000,016 | **−6.7%** | 662 → 601 |
| propcall | 48,000,027 | 46,000,025 | **−4.2%** | 612 → 598 |
| closure | 26,400,018 | 26,400,018 | 0% (loop body declares a `const`, keeps its scope) | 555 → 566 (noise) |
| fib | 33,656,716 | 33,656,716 | 0% (no elidable block / object literal in the hot path) | 492 → 502 (noise) |

- **Real-app static opcode total: 232,518 → 218,808 (−5.9%)** across 188 compiled
  source files. The object-literal and bulk-declare fusions land mostly here
  (React builds many literal-valued objects), not in the synthetic loops:
  `OBJ_SET_CONST` is emitted **7,286×** (vs 9,497 remaining `OBJ_SET`),
  `DECLARE_SLOTS` **1,351×**. Const-pool grows ~15% (31,501 → 36,355 entries)
  for the fused-op tuples — a size cost accepted for the step cut.
- **Honest:** `closure`/`fib` gained nothing (reported, not hidden). An
  object-building micro-loop (6 literal props × 500k iters) is 16.5M steps with
  the fusion vs ~19.5M without (−15%). Block elision alone removes exactly the
  2×N `ENTER_SCOPE`/`EXIT_SCOPE` from a simple loop body (the −4M on `arith`).
- **Not done, by measurement:** a closure/continuation dispatch core was
  evaluated and rejected — a profiling spike measured only +11% beyond slot
  locals while requiring a from-scratch re-implementation of trap-wipe,
  async/await suspension, try/catch/finally unwinding, TDZ and the watchdog.
  Per-step throughput also tops out ~50–140 Msteps/s regardless (no `eval`/`new
  Function` under the CSP), so the strategic lever for heavy routes is *fewer
  steps* (superinstructions), which is why they were prioritised.

Per-build polymorphism (the opcode→byte layout differs per build), encrypted
bytecode + constant pool, and the trap-wipe are all intact through these
changes.

## Anti-tamper (PLAN P7 / 5.9)

`anti-tamper.js` implements the 5.9 candidates. Each is **individually flagged**
with a conservative default, threaded from the plugin (`shieldPlugin({
antiTamper })`) through the loader to each runtime. **Only the two
high-confidence integrity checks are wired to the D10 wipe**; the environment,
timing and mutation signals are **tripwires that only FLAG** — they are too
false-positive-prone to brick a real user. The key ships in the page, so none of
these create secrecy; like the rest of shield they raise reversing cost.

| Feature | Default | On detect | Measured cost | False-positive risk | Documented bypass |
|---|---|---|---|---|---|
| **Bytecode integrity hash** (`integrityHash`, verified at boot) | **ON** | **WIPE + fatal** | ~**0.002 ms/chunk** at boot (0.44 ms to hash all 189 real-app programs) | ~none (digest is exact) | patch the hash fn, or recompute+embed a matching digest after editing bytecode |
| **Trap opcodes** (unused byte → wipe+throw) | always | **WIPE + fatal** | 0 (only fires on an illegal byte) | ~none | avoid emitting an unmapped byte (i.e. don't tamper) |
| **VM `toString` snapshot** (`createToStringGuard` over runFrame/runSync/decrypt/handlers/`Function.prototype.toString`) | **ON** | **WIPE + fatal** | 6 `toString` calls once per runtime + 1 throttled check per host→VM entry (≤1/2 s) | ~none (nothing legitimately rewrites the VM's own fns) | patch the per-runtime closures the dispatcher actually calls (unreachable by name), or neuter the guard before boot snapshot |
| **Timing check** (`createTimingMonitor`, `performance.now()` deltas) | **OFF** | FLAG only | 0 when off; a divide when on | **HIGH** — slow devices, throttled background tabs, debuggers all trip it; lenient (needs N consecutive) and **never wipes** | run fast, or patch `performance.now` |
| **Environment / `isLikelyBot`** (renamed A10: `navigator.webdriver` + automation globals + `navigator.languages.length===0` + zero outer dims) | **ON** | **FLAG only** (`window.__shieldFlags.likelyBot`) | one-time at boot, a few property reads | medium — privacy extensions blank `languages`, some embeds report zero outer dims; **it is a tripwire, NOT a security control, and never wipes/blocks** | spoof `navigator.webdriver`/`languages` + the automation globals |
| **Mutation guard** (`installMutationGuard` on shield shadow roots) | **OFF** | FLAG only | 0 (no shield-owned shadow roots in this build; shadow DOM lives in HolyText/uncloak, outside shield) | low when scoped | mutate via an uncovered path, or disconnect the observer |

**The A10 rename.** The old `isHeadlessScraper` (`navigator.webdriver` only) in
`main/src/lib/holy-decrypt.ts` — outside shield, gating `HolyText` DOM reveal —
was minimally renamed to `isLikelyBot` (body unchanged; its one caller in
`HolyText.tsx` updated). The **consolidated** multi-signal `isLikelyBot` lives in
`shield/anti-tamper.js`; both are documented as tripwires that must not block.

**Combined perf cost (headless Chrome, scratch `SHIELD_MODE=compile` build, all
25/25 chunks VM, anti-tamper at defaults).** Time-to-first-render vs the native
`SHIELD_MODE=manifest` build on the same stub backend (single noisy samples):

| Route | native | VM (fusions + anti-tamper) | VM delta | shield errors |
|---|---|---|---|---|
| home | 212 ms | 346 ms | **+134 ms** | none |
| games | 54 ms | 211 ms | **+157 ms** | none |

Both deltas stay inside the documented **+150–250 ms** first-render budget — the
P7 anti-tamper additions did **not** blow it (integrity+toString are a sub-ms
one-time snapshot; env is one-time; timing+mutation are off). `/games` boots and
renders with zero shield errors and no integrity/toString/watchdog false trip;
the env tripwire flagged nothing (`likelyBot:false`).

## Known deviations (within the VM)

- `for (let i…)` C-style loop closures capture a **shared** binding (var-like);
  `for-of`/`for-in` get a fresh per-iteration scope.
- Array holes become `undefined`; object rest copies own enumerable string keys.
- `for-of` does not call `iterator.return()` on early `break`.
- Error messages may differ from V8; error **types** match (the corpus compares
  values + error constructor names).
- Private accessors are supported; a private compound/update on a member is
  supported, but exotic private-in-chain forms may fall back.

## Cipher (decision D7 — provisional)

Program (bytecode + constant pool + module descriptor) is JSON-serialized and
encrypted per chunk with **XChaCha20-Poly1305** (`@noble/ciphers`), layout
`nonce(24) || ciphertext+tag`. Authenticated (tamper fails to decrypt). The key
ships in the page, so this raises reversing cost; it does not create secrecy
(PLAN 1 / 5.8).

## Running the tests

```
cd main && node --test "src/server/shield/**/*.test.mjs"
```

(This Node build does not auto-discover a bare directory arg; use the glob.)
Last run: **60 tests, 55 pass, 0 fail, 5 skipped** (skips are the documented
out-of-subset cases: for(let) closure deviation, generators, eval/new Function,
tagged templates, for-await-of). The passing tests include ~200 VM-vs-native
assertions across the compiler, class, and module corpora — covering
`arguments` and break/continue across `finally` (labeled, nested finallys,
per-iteration scopes, catch+finally, finally-performs-break) — plus the
step-count fusion tests (`OBJ_SET_CONST`, `DECLARE_SLOTS`, block elision assert
the fused op is emitted AND the value matches native) and the anti-tamper suite
(integrity wipe, toString-guard wipe, timing leniency, `isLikelyBot` signals,
mutation guard — and the policy that env/timing never wipe).

## Trying compile mode

Compile mode is the default, so a normal build already produces the VM bundle.
To iterate against a scratch dir (never `main/dist` while others build):

```
cd main && npx vite build --outDir /tmp/vm-dist --emptyOutDir   # compile (default)
# analysis-only (no chunk rewrites):  SHIELD_MODE=manifest npx vite build …
# then serve + open:  npx vite preview --outDir /tmp/vm-dist --port 5000
# inspect decisions:  /tmp/vm-dist/shield-manifest.json
```
