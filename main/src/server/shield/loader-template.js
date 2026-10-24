// shield whole-chunk ESM loader (PLAN 5.3 / 5.7 / 5.10, decision D1).
//
// Plain JavaScript, no Node built-ins, so it runs unchanged in Node (tests) and
// in the browser (shipped bundle). It is a SystemJS-style module registry that
// links a graph of compiled (VM) chunks with live ES-module bindings, supports
// circular imports (two-phase instantiate/link then evaluate), dynamic
// import(), top-level await and import.meta — and interoperates with native
// fallback chunks (@no-vm) that the browser's own loader evaluates.
//
// Environment seams are injected so the same code serves both worlds:
//   - createRuntime(program)  -> a runtime handle whose .run([], {env, module})
//                                evaluates a module body (from runtime-template)
//   - decrypt(enc, key)       -> the decrypted program object
//   - resolveURL(file)        -> absolute URL for a chunk artifact, resolved
//                                RELATIVE to the loader so it works under both
//                                absolute (main/aws) and relative (jsdelivr/
//                                singlefile ./assets/) layouts
//   - fetchArtifact(url)      -> Promise that loads+executes a VM register
//                                artifact (which calls loader.define(...))
//   - importNative(url)       -> Promise<namespace> for a native fallback chunk
//   - globals                 -> the global object passed to each runtime
//
// Each module becomes a RECORD. A VM record owns a persistent module `env`
// (scope) so its exports resolve after evaluation; imports are installed as
// LIVE bindings (see runtime-template resolveImport) that read the exporter's
// env at access time — that is what makes a reassignment in the exporter
// visible to importers, and gives correct TDZ for circular graphs.

const MODULE_TAG = typeof Symbol !== 'undefined' && Symbol.toStringTag ? Symbol.toStringTag : '@@toStringTag'

export function createLoader(opts) {
  const o = opts || {}
  const createRuntime = o.createRuntime
  const decrypt = o.decrypt
  const globals = o.globals || (typeof globalThis !== 'undefined' ? globalThis : {})
  const resolveURL = o.resolveURL || ((f) => f)
  const fetchArtifact = o.fetchArtifact || null
  const importNative = o.importNative || ((url) => Promise.resolve(import(/* @vite-ignore */ url)))
  // manifest.modules: id -> { file, kind:'vm'|'native', deps: {specifier: id}, dyn: {specifier: id} }
  const manifest = o.manifest || { modules: {} }

  const registry = new Map()
  // In-flight per-module FETCH promises (resolve when a module is DEFINED, i.e.
  // its artifact ran define() / its native ns loaded — NOT when its whole
  // closure is registered). Deduplicates concurrent fetches of a shared module
  // so two routes that import it never double-fetch and always await the same
  // define. Closure-completeness is tracked separately by rec.registered.
  const inflightFetch = new Map()

  function nativeRecord(id, ns) {
    return {
      id, kind: 'native', status: 'evaluated', fetched: true, ns,
      depMap: {},
      getExport(name) {
        if (!(name in ns)) throw new SyntaxError("The requested module does not provide an export named '" + name + "'")
        return ns[name]
      },
      hasExport(name) { return name in ns },
      exportNames() { return Object.keys(ns).filter((k) => k !== MODULE_TAG) },
      namespace() { return ns },
    }
  }

  // Register a compiled (VM) module. Called by a register-artifact in the
  // browser, or directly by test harnesses. `data`:
  //   { program? , enc?, key?, depMap, dynMap?, exportsMap, reexports, metaUrl, hasTLA }
  function b64ToBytes(s) {
    if (s instanceof Uint8Array) return s
    const bin = (typeof atob === 'function') ? atob(s) : Buffer.from(s, 'base64').toString('binary')
    const u = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
    return u
  }

  function define(id, data) {
    if (registry.has(id) && registry.get(id).defined) return registry.get(id)
    let program = data.program
    if (!program && decrypt) program = decrypt(b64ToBytes(data.enc), b64ToBytes(data.key))
    if (!program) throw new Error('shield loader: cannot obtain program for ' + id)
    const mod = program.module || { exports: {}, reexports: [], imports: [], deps: [] }
    const exportsMap = data.exportsMap || mod.exports || {}
    const reexports = data.reexports || mod.reexports || []
    const depMap = data.depMap || mod.depMap || {}
    const dynMap = data.dynMap || mod.dynMap || {}
    const rt = createRuntime(program, { globals, budget: o.budget, watchdogMs: o.watchdogMs, antiTamper: o.antiTamper, expectedHash: data.hash })
    const env = { parent: null, slots: [] }
    const exportSlots = (program.module && program.module.exportSlots) || {}

    const rec = {
      id, kind: 'vm', defined: true, fetched: true, status: 'unlinked',
      program, rt, env, exportsMap, exportSlots, reexports, depMap, dynMap,
      ns: null, evalResult: undefined,
      meta: { url: data.metaUrl || (manifest.modules[id] ? resolveURL(manifest.modules[id].file) : id) },
      hasTLA: !!(data.hasTLA || (program.functions[program.mainIndex] && program.functions[program.mainIndex].isAsync)),
    }

    rec.resolve = function (spec) {
      const tid = rec.depMap[spec] !== undefined ? rec.depMap[spec] : rec.dynMap[spec]
      if (tid === undefined) throw new Error("shield loader: unresolved import '" + spec + "' in " + id)
      const r = registry.get(tid)
      if (!r) throw new Error('shield loader: module ' + tid + ' not registered (import of ' + spec + ')')
      return r
    }
    rec.getExport = function (name) {
      if (Object.prototype.hasOwnProperty.call(rec.exportsMap, name)) {
        const slot = rec.exportSlots[name]
        const b = slot === undefined ? undefined : rec.env.slots[slot]
        if (b === undefined) throw new ReferenceError("Cannot access '" + name + "' before initialization")
        if (b.import) {
          // re-exported value that is itself an imported binding
          return resolveLive(b)
        }
        if (!b.init) throw new ReferenceError("Cannot access '" + name + "' before initialization")
        return b.v
      }
      for (const re of rec.reexports) {
        if (re.exported === name) return rec.resolve(re.source).getExport(re.imported)
        if (re.star && re.as === name) return rec.resolve(re.source).namespace()
      }
      for (const re of rec.reexports) {
        if (re.star && !re.as && name !== 'default') {
          const src = rec.resolve(re.source)
          if (src.hasExport(name)) return src.getExport(name)
        }
      }
      throw new SyntaxError("The requested module '" + id + "' does not provide an export named '" + name + "'")
    }
    rec.hasExport = function (name) {
      if (Object.prototype.hasOwnProperty.call(rec.exportsMap, name)) return true
      for (const re of rec.reexports) {
        if (re.exported === name) return true
        if (re.star && re.as === name) return true
        if (re.star && !re.as && name !== 'default') { const src = rec.resolve(re.source); if (src.hasExport(name)) return true }
      }
      return false
    }
    rec.exportNames = function () {
      const names = new Set(Object.keys(rec.exportsMap))
      for (const re of rec.reexports) {
        if (re.exported) names.add(re.exported)
        else if (re.star && re.as) names.add(re.as)
        else if (re.star) for (const n of rec.resolve(re.source).exportNames()) if (n !== 'default') names.add(n)
      }
      return Array.from(names)
    }
    rec.namespace = function () {
      if (rec.ns) return rec.ns
      const ns = {}
      for (const n of rec.exportNames()) {
        Object.defineProperty(ns, n, { enumerable: true, configurable: false, get() { return rec.getExport(n) } })
      }
      try { Object.defineProperty(ns, MODULE_TAG, { value: 'Module' }) } catch (_) {}
      rec.ns = ns
      return ns
    }
    rec.moduleCtx = {
      meta: rec.meta,
      resolve(spec) { return rec.resolve(spec) },
      dynamicImport(spec) { return dynamicImport(spec, rec) },
    }

    registry.set(id, rec)
    return rec
  }

  function resolveLive(b) {
    if (b.ikind === 'ns') return b.src.namespace()
    if (b.ikind === 'default') return b.src.getExport('default')
    return b.src.getExport(b.iname)
  }

  // Fetch + DEFINE a single module (no dep walk). Deduplicated across concurrent
  // callers via inflightFetch, so a shared chunk imported by two routes at once
  // is fetched + defined exactly once and both callers await the same promise.
  function fetchModule(id) {
    const existing = registry.get(id)
    if (existing) return Promise.resolve(existing)
    const cached = inflightFetch.get(id)
    if (cached) return cached
    const p = (async () => {
      const info = manifest.modules[id]
      if (!info) throw new Error('shield loader: unknown module ' + id)
      if (info.kind === 'native') {
        const ns = await importNative(resolveURL(info.file))
        const rec = nativeRecord(id, ns)
        rec.linkedDeps = true
        rec.registered = true // native deps are the browser loader's job
        registry.set(id, rec)
        return rec
      }
      if (!fetchArtifact) throw new Error('shield loader: no fetchArtifact for ' + id)
      await fetchArtifact(resolveURL(info.file)) // runs define(id, ...)
      const rec = registry.get(id)
      if (!rec) throw new Error('shield loader: module ' + id + ' did not register')
      rec.fetched = true
      return rec
    })()
    inflightFetch.set(id, p)
    // Free the slot once settled: successful modules are then served from the
    // registry short-circuit above; a failed fetch can be retried.
    p.then(() => inflightFetch.delete(id), () => inflightFetch.delete(id))
    return p
  }

  // Phase 1: fetch + register (DEFINE) the WHOLE static import closure of `id`.
  // When this resolves, every transitive static dependency of `id` is in the
  // registry, so phase-2 evaluate() can never reach an unregistered dep.
  //
  // Each call walks its own closure with a private `seen` set and only shares
  // the per-module fetch (fetchModule). Completeness is keyed on rec.registered
  // (closure fully walked), NOT on an in-progress flag — so a concurrent caller
  // that finds a shared module mid-registration re-walks its deps independently
  // (awaiting the shared, deduplicated fetches) instead of returning early and
  // evaluating against a half-registered closure. That early return was the
  // root of "evaluate missing <id>": `linkedDeps` was set before the dep walk
  // finished yet also served as the done-guard, so a second importer of a route
  // that shared a transitive chunk (e.g. ai/music → lib/avatar) could evaluate
  // before that chunk was fetched. Cycles are handled by `seen` (a module
  // already on this walk is returned as-is; it is DEFINED by then, since
  // fetchModule awaits before we recurse) — no deadlock, no double work.
  async function ensureRegistered(id, seen) {
    const done = registry.get(id)
    if (done && done.registered) return done
    seen = seen || new Set()
    if (seen.has(id)) return registry.get(id)
    seen.add(id)
    const rec = await fetchModule(id)
    if (rec.kind === 'native') return rec // registered in fetchModule
    const deps = rec.depMap ? Object.values(rec.depMap) : []
    await Promise.all(deps.map((depId) => ensureRegistered(depId, seen)))
    rec.linkedDeps = true
    rec.registered = true
    return rec
  }

  // Phase 2: evaluate in dependency order. Cycle-safe (a module already
  // 'evaluating' is skipped; its live bindings carry current values) and
  // TLA-aware (awaits async module bodies and async deps).
  async function evaluate(id) {
    let rec = registry.get(id)
    if (!rec) {
      // Should not happen now that ensureRegistered guarantees the full closure
      // is registered before evaluate runs. Recover (lazily fetch+register)
      // rather than crash the whole page, then re-read the record.
      await ensureRegistered(id)
      rec = registry.get(id)
    }
    if (!rec) throw new Error('shield loader: evaluate missing ' + id)
    if (rec.status === 'evaluated') { if (rec.evalError) throw rec.evalError; return rec }
    if (rec.status === 'evaluating') return rec
    if (rec.kind === 'native') { rec.status = 'evaluated'; return rec }
    rec.status = 'evaluating'
    try {
      for (const depId of Object.values(rec.depMap)) await evaluate(depId)
      const result = rec.rt.run([], { env: rec.env, module: rec.moduleCtx })
      if (result && typeof result.then === 'function') await result
      rec.status = 'evaluated'
    } catch (e) {
      rec.status = 'evaluated'
      rec.evalError = e
      throw e
    }
    return rec
  }

  async function dynamicImport(spec, importerRec) {
    let id
    if (importerRec) id = importerRec.depMap[spec] !== undefined ? importerRec.depMap[spec] : importerRec.dynMap[spec]
    if (id === undefined && manifest.specToId) id = manifest.specToId[spec]
    if (id === undefined) {
      // A chunk-relative specifier that the manifest does not know can only be
      // a build bug (the plugin guard maps every literal specifier of a VM
      // chunk; VM chunks are renamed, so fetching the raw path would 404).
      // Fail loudly instead of fetching the raw file name.
      if (typeof spec === 'string' && (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('assets/'))) {
        return Promise.reject(new Error("shield loader: unmapped dynamic import '" + spec + "'" + (importerRec ? ' in ' + importerRec.id : '')))
      }
      // Anything else (absolute URL) is not a bundle chunk: native import.
      return importNative(resolveURL(spec))
    }
    await ensureRegistered(id)
    await evaluate(id)
    const rec = registry.get(id)
    return rec.kind === 'native' ? rec.ns : rec.namespace()
  }

  // Load + evaluate a module and return its namespace. The bootstrap calls this
  // with the entry id.
  async function load(id) {
    await ensureRegistered(id)
    await evaluate(id)
    const rec = registry.get(id)
    return rec.kind === 'native' ? rec.ns : rec.namespace()
  }

  return { define, defineNative: (id, ns) => { registry.set(id, nativeRecord(id, ns)); return registry.get(id) }, load, import: dynamicImport, ensureRegistered, evaluate, registry, resolveLive }
}

export default createLoader
