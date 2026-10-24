// shield Vite plugin (PLAN P4). Post-build step that compiles each emitted ESM
// chunk to encrypted bytecode, emits the whole-chunk loader + bootstrap + a
// mangled-name manifest, and rewrites the entry HTML to boot the loader.
//
// Two modes (option `mode`):
//   - 'manifest' (DEFAULT, safe): analyze every chunk + write
//     `shield-manifest.json`. Never rewrites chunks, so the build is unchanged.
//   - 'compile': additionally compile the SOUND VM frontier to bytecode, emit
//     register-artifacts (replacing those chunks, mangled), the loader
//     bootstrap, and rewrite index.html. Chunks that cannot compile fall back
//     to native (@no-vm) and are recorded in the manifest.
//
// SOUNDNESS (why not every chunk compiles): compiled (VM) chunks are linked by
// the shield loader, native fallback chunks by the browser's own ESM loader.
// Mixing is sound only when NO native chunk imports a VM chunk (a native
// `import` of a mangled register-artifact would get no ESM exports). The plugin
// computes a fixpoint: start from the chunks that compile, then demote any VM
// chunk that is imported (statically or dynamically) by a native chunk, until
// stable. VM chunks may freely import native chunks (the loader native-imports
// them). If the entry chunk is not in the final VM set, the plugin ships the
// original native build untouched (and says so) - it never ships broken output.

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as acorn from 'acorn'
import type { Plugin } from 'vite'
import { compile, encryptProgram, ShieldCompileError } from './compiler.ts'
import { hashSeed } from './opcodes.ts'
import { integrityHash } from './anti-tamper.js'

export type ShieldMode = 'manifest' | 'compile'

export interface ShieldPluginOptions {
  seed?: string | number
  mode?: ShieldMode
  include?: (fileName: string) => boolean
  exclude?: string[]
  // Ship chunks made ONLY of node_modules code natively (still obfuscated and
  // canary-checked by the post-build steps). Third-party libraries carry no
  // app secrets, and interpreting them costs far more than it protects: React,
  // its scheduler and the AES used for every HolyText reveal running as
  // bytecode kept the main thread ~50% busy at idle and delayed text reveal by
  // 30 s+. Chunks that contain any app module stay compiled.
  nativeVendorChunks?: boolean
  // Extra module-id patterns treated as third-party for nativeVendorChunks:
  // vendored library source kept inside src/ (e.g. React Bits backgrounds).
  thirdPartyPaths?: RegExp[]
  // A vendor chunk whose code this returns true for stays compiled even with
  // nativeVendorChunks (e.g. it contains a canary string the bytecode hides).
  keepCompiled?: (code: string) => boolean
  manifestFileName?: string
  // per-chunk VM step budget (default 20M in the runtime). Raise for heavy
  // routes; a miss throws a fatal "step budget exceeded" at runtime.
  budget?: number
  // Anti-tamper policy (PLAN P7 / 5.9). Passed through to the runtime; see
  // anti-tamper.js ANTI_TAMPER_DEFAULTS. Conservative defaults when omitted:
  // integrity + toStringGuard + envCheck ON (wipe only on the first two),
  // timing + mutationGuard OFF.
  antiTamper?: Record<string, unknown>
}

interface ChunkRecord {
  rawBytes: number
  isEntry: boolean
  decision: 'vm' | 'native'
  reason?: string
  functions?: number
  consts?: number
  encryptedBytes?: number
  id?: string
}

function toB64(bytes: Uint8Array): string {
  // Node + browser safe; the plugin runs under Node (tsx), so Buffer is fine.
  return Buffer.from(bytes).toString('base64')
}

// A guardrail violation. Unlike every other plugin error (which makes the build
// ship native untouched and is only recorded in the manifest), a guard failure
// is rethrown out of writeBundle so `vite build` exits non-zero. There is no
// opt-out: a compiled build that references a file the shield removed would
// ship 404s that live inside encrypted constant pools, where no post-build
// scanner (check-dist-refs) can see them.
export class ShieldGuardError extends Error {
  constructor(message: string) { super('[shield guard] ' + message); this.name = 'ShieldGuardError' }
}

// Every string-valued literal in a chunk: string Literals and interpolation-free
// template literals (rolldown emits both), located with the same parser the
// compiler uses, so quoting/escaping can never desynchronise a scan. Used to
// find and rewrite file-name references that are NOT import specifiers - Vite's
// `__vite__mapDeps` preload list is the known case: `m.f=["assets/<hash>.js",
// ...]`, which `__vitePreload` turns into `<link rel="modulepreload"
// href="/assets/<hash>.js">`. The shield renames VM chunks to assets/s_<id>.js,
// so an un-rewritten entry preloads a file that no longer exists (a 404 with no
// script initiator, invisible to any post-build scanner once compiled).
// `specifier` marks the string as the source of an import/export declaration or
// of a dynamic import() - the positions the loader maps by module id. Every
// other position is a plain data string the code would use verbatim.
interface StringNode { start: number; end: number; value: string; specifier: boolean }
const SPECIFIER_PARENTS = new Set(['ImportExpression', 'ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'])
function stringNodes(code: string): StringNode[] {
  const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'module', allowAwaitOutsideFunction: true })
  const out: StringNode[] = []
  const visit = (node: any, parent: any, key: string) => {
    if (!node || typeof node.type !== 'string') return
    const specifier = key === 'source' && !!parent && SPECIFIER_PARENTS.has(parent.type)
    if (node.type === 'Literal' && typeof node.value === 'string') {
      out.push({ start: node.start, end: node.end, value: node.value, specifier })
      return
    }
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1 && typeof node.quasis[0].value.cooked === 'string') {
      out.push({ start: node.start, end: node.end, value: node.quasis[0].value.cooked, specifier })
      return
    }
    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue
      const child = node[k]
      if (Array.isArray(child)) { for (const c of child) if (c && typeof c === 'object') visit(c, node, k) }
      else if (child && typeof child === 'object') visit(child, node, k)
    }
  }
  visit(ast, null, '')
  return out
}

// The replacement for one non-specifier string in `importer` that names a
// renamed chunk, or null when it names none. Two shapes occur, depending on
// Vite's `base`: the bundle file name ("assets/<hash>.js", absolute base -
// resolved against the page) and a chunk-relative path ("./<hash>.js",
// relative base - resolved against the chunk's import.meta.url, which for a VM
// chunk is its own mangled artifact in the same directory). Each is rewritten
// in its own shape so the resolution rule that consumes it still works.
function renamedRef(importer: string, value: string, renamed: Map<string, string>): string | null {
  const direct = renamed.get(value)
  if (direct !== undefined) return direct
  if (!value.startsWith('./') && !value.startsWith('../')) return null
  const target = resolveSpec(importer, value)
  const mangled = target === null ? undefined : renamed.get(target)
  if (mangled === undefined) return null
  const rel = posix.relative(posixDirname(importer) || '.', mangled)
  return rel.startsWith('../') ? rel : './' + rel
}

function rewriteFileRefs(importer: string, code: string, renamed: Map<string, string>): string {
  if (renamed.size === 0) return code
  const hits: Array<StringNode & { to: string }> = []
  for (const n of stringNodes(code)) {
    if (n.specifier) continue
    const to = renamedRef(importer, n.value, renamed)
    if (to !== null) hits.push({ ...n, to })
  }
  if (hits.length === 0) return code
  let out = ''
  let at = 0
  for (const n of hits) { // ascending source order (acorn walk is in order)
    out += code.slice(at, n.start) + JSON.stringify(n.to)
    at = n.end
  }
  return out + code.slice(at)
}


function posixDirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}
function posixJoin(dir: string, rel: string): string {
  const parts = (dir ? dir.split('/') : []).concat(rel.split('/'))
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}
// Resolve an import specifier (as written in chunk code) to a bundle fileName,
// or null if it is not an internal relative chunk.
function resolveSpec(importerFileName: string, spec: string): string | null {
  if (spec.startsWith('./') || spec.startsWith('../')) return posixJoin(posixDirname(importerFileName), spec)
  return null
}

export function shieldPlugin(options: ShieldPluginOptions = {}): Plugin {
  const seed = options.seed ?? Math.floor(Math.random() * 0xffffffff)
  const mode: ShieldMode = options.mode ?? 'manifest'
  const include = options.include ?? ((f: string) => f.endsWith('.js'))
  // Service workers and web workers run outside the shield loader's context, and
  // polyfills may load before it, so they stay native. The rolldown runtime glue
  // (CJS/ESM interop helpers) runs as a normal module and compiles fine, so it is
  // NOT excluded - it rides the fixpoint like any other chunk.
  const exclude = options.exclude ?? ['polyfill', 'sw-', 'worker']
  const manifestFileName = options.manifestFileName ?? 'shield-manifest.json'
  const layoutFingerprint = hashSeed('layout:' + seed).toString(16)

  const mangle = (fileName: string): string => 's_' + (hashSeed('id:' + seed + ':' + fileName) >>> 0).toString(36)

  // Exclusion is decided from the chunk's own metadata (rollup name and entry
  // module path), never from its emitted file name: emitted names are content
  // hashes now, so a name pattern would silently match nothing and let a worker
  // chunk compile to bytecode.
  const isVendorOnlyChunk = (item: any): boolean => {
    const ids: string[] = Array.isArray(item?.moduleIds) ? item.moduleIds : Object.keys(item?.modules ?? {})
    // Virtual helper modules (\0-prefixed, e.g. the bundler's interop glue)
    // ride along with whatever chunk they land in and don't decide it.
    const real = ids.filter((id) => typeof id === 'string' && !id.startsWith('\0'))
    const thirdParty = [/[\\/]node_modules[\\/]/, ...(options.thirdPartyPaths ?? [])]
    return real.length > 0 && real.every((id) => thirdParty.some((re) => re.test(id)))
  }

  const isExcludedChunk = (item: any): boolean => {
    if (options.nativeVendorChunks && isVendorOnlyChunk(item)) return true
    const facade = typeof item?.facadeModuleId === 'string' ? item.facadeModuleId.split('?')[0] : ''
    const facadeBase = facade.slice(facade.lastIndexOf('/') + 1)
    const probes = [String(item?.name ?? ''), facadeBase]
    return exclude.some((pattern) => probes.some((probe) => probe.includes(pattern)))
  }

  return {
    name: 'abulxt-shield',
    enforce: 'post',
    // Runs AFTER all generateBundle hooks and after files are on disk, so the
    // code we compile is final (e.g. Vite's __VITE_PRELOAD__ placeholder is
    // already resolved). We operate on the output directory directly.
    async writeBundle(this: any, outputOptions: any, bundle: Record<string, any>) {
      const outDir: string = outputOptions && outputOptions.dir ? outputOptions.dir : 'dist'
      const codeOf = (fileName: string): string => {
        try { return readFileSync(join(outDir, fileName), 'utf8') } catch { return (bundle[fileName] && bundle[fileName].code) || '' }
      }
      const writeAsset = (fileName: string, source: string | Uint8Array) => {
        writeFileSync(join(outDir, fileName), source as any)
      }
      const safeEmitManifest = (manifest: unknown) => {
        writeAsset(manifestFileName, JSON.stringify(manifest, null, 2))
      }

      try {
        // 1. Gather ALL JS chunks + their import edges (rollup resolved). Every
        //    chunk gets a module id and a manifest entry so VM chunks can import
        //    even the ones we never compile (forced-native runtime glue).
        const chunkNames: string[] = []
        const forcedNative = new Set<string>()
        for (const fileName of Object.keys(bundle)) {
          const item = bundle[fileName]
          if (!item || item.type !== 'chunk') continue
          if (!fileName.endsWith('.js')) continue
          chunkNames.push(fileName)
          if (!include(fileName) || isExcludedChunk(item)) {
            const vendorOnly = options.nativeVendorChunks && isVendorOnlyChunk(item)
            if (vendorOnly && options.keepCompiled?.(codeOf(fileName))) continue
            forcedNative.add(fileName)
          }
        }

        // 2. Try to compile each non-forced candidate; record which succeed.
        const compiled = new Map<string, any>() // fileName -> CompileResult
        const reason = new Map<string, string>()
        for (const fileName of chunkNames) {
          if (forcedNative.has(fileName)) { reason.set(fileName, options.nativeVendorChunks && isVendorOnlyChunk(bundle[fileName]) ? 'third-party only (nativeVendorChunks)' : 'excluded by plugin options (worker / polyfill / runtime glue)'); continue }
          const code: string = codeOf(fileName)
          try {
            compiled.set(fileName, compile(code, { seed }))
          } catch (e) {
            reason.set(fileName, e instanceof ShieldCompileError ? e.message : 'compile error: ' + String(e))
          }
        }

        // 3. Fixpoint: the VM set starts as everything that compiled, then any
        // VM chunk imported (static OR dynamic) by a native chunk is demoted,
        // plus any VM chunk with an unresolved (external/bare) static import.
        const vm = new Set<string>(compiled.keys())
        const edgesOf = (fileName: string): string[] => {
          const c = bundle[fileName]
          const outs = ([] as string[]).concat(c.imports || [], c.dynamicImports || [])
          return outs.filter((f) => typeof f === 'string')
        }
        // demote VM chunks whose descriptor has a static import we cannot map
        for (const fileName of Array.from(vm)) {
          const prog = compiled.get(fileName).program
          const md = prog.module
          if (!md) continue
          let bad = ''
          if (md.hasComputedDynImport) bad = 'computed dynamic import() cannot be statically mapped (@no-vm)'
          const statics = (md.imports || []).map((i: any) => i.source).concat((md.reexports || []).map((r: any) => r.source))
          for (const spec of statics) {
            if (bad) break
            const target = resolveSpec(fileName, spec)
            if (target === null || !bundle[target]) { bad = 'unresolved/external import'; break }
          }
          if (bad) { vm.delete(fileName); reason.set(fileName, bad) }
        }
        let changed = true
        while (changed) {
          changed = false
          for (const fileName of chunkNames) {
            if (vm.has(fileName)) continue // native chunks only
            for (const dep of edgesOf(fileName)) {
              if (vm.has(dep)) { vm.delete(dep); reason.set(dep, 'imported by a native chunk (@no-vm frontier)'); changed = true }
            }
          }
        }

        // 4. Entry decision. index.html boots through the loader only if the
        //    entry chunk is in the VM set.
        const entryChunks = chunkNames.filter((f) => bundle[f].isEntry)
        const htmlEntry = entryChunks.find((f) => vm.has(f)) || entryChunks[0]

        // 4b. Every HTML page's module scripts must resolve to a chunk we emitted.
        //     Resolved here, BEFORE any chunk is compiled or unlinked, so an
        //     unresolvable reference makes the build ship native instead of
        //     leaving a page pointing at a deleted file.
        const resolveHtmlScript = (src: string): { key: string; prefix: string } | null => {
          const cleaned = src.split(/[?#]/)[0]
          for (const key of chunkNames) {
            if (cleaned === key || cleaned.endsWith('/' + key)) return { key, prefix: cleaned.slice(0, cleaned.length - key.length) }
          }
          return null
        }
        const pages: Array<{ fileName: string; html: string; scripts: Array<{ match: string; prefix: string; key: string }> }> = []
        let pagesResolve = true
        for (const fileName of Object.keys(bundle)) {
          const item = bundle[fileName]
          if (!item || item.type !== 'asset' || !fileName.endsWith('.html')) continue
          const html = codeOf(fileName)
          const scripts: Array<{ match: string; prefix: string; key: string }> = []
          for (const tag of html.match(/<script\b[^>]*>\s*<\/script>/g) || []) {
            if (!/\btype=["']module["']/.test(tag)) continue
            const src = /\bsrc=["']([^"']+)["']/.exec(tag)
            if (!src) continue // inline module: references no chunk
            const hit = resolveHtmlScript(src[1])
            if (!hit) { pagesResolve = false; break }
            scripts.push({ match: tag, prefix: hit.prefix, key: hit.key })
          }
          pages.push({ fileName, html, scripts })
        }
        const bootViaLoader = mode === 'compile' && !!htmlEntry && vm.has(htmlEntry) && pagesResolve

        // 5. Build the module id/file manifest for EVERY chunk (vm + native).
        const idOf = new Map<string, string>()
        for (const fileName of chunkNames) idOf.set(fileName, mangle(fileName))
        const modules: Record<string, { file: string; kind: 'vm' | 'native' }> = {}

        const records: ChunkRecord[] = []
        for (const fileName of chunkNames) {
          const id = idOf.get(fileName)!
          const isVm = vm.has(fileName)
          const rawBytes = Buffer.byteLength(codeOf(fileName), 'utf8')
          const rec: ChunkRecord = {
            rawBytes, isEntry: !!bundle[fileName].isEntry,
            decision: isVm ? 'vm' : 'native', reason: isVm ? undefined : reason.get(fileName), id,
          }
          if (isVm) {
            const r = compiled.get(fileName)
            rec.functions = r.program.functions.length
            rec.consts = r.program.consts.length
          }
          records.push(rec)
        }

        const manifest = {
          shieldVersion: 1,
          generatedAt: new Date().toISOString(),
          mode,
          seed,
          layoutFingerprint,
          loaderStatus: bootViaLoader
            ? 'compile: loader active; entry + VM frontier run as bytecode'
            : (mode === 'compile'
              ? 'compile: entry not in VM frontier - shipped native untouched (no chunk runs as bytecode)'
              : 'manifest: analysis only (no chunks rewritten)'),
          bootViaLoader,
          entry: htmlEntry ? idOf.get(htmlEntry) : null,
          counts: { total: chunkNames.length, vm: vm.size, native: chunkNames.length - vm.size },
          modules,
          chunks: records,
        }

        if (mode !== 'compile' || !bootViaLoader) {
          // Safe: never rewrite chunks. Build keeps working natively.
          for (const fileName of chunkNames) modules[idOf.get(fileName)!] = { file: fileName, kind: vm.has(fileName) && mode === 'compile' ? 'vm' : 'native' }
          safeEmitManifest(manifest)
          return
        }

        // 6a. Rename map (VM chunks only; native chunks keep their file name)
        //     and the file-reference rewrite. A chunk's code can name another
        //     chunk's FILE outside of an import specifier - Vite's
        //     `__vite__mapDeps` preload list does, as "assets/<hash>.js" under
        //     an absolute base or "./<hash>.js" under base './' - and such
        //     strings are compiled verbatim into the encrypted constant
        //     pool. Each one that names a renamed chunk is rewritten to the
        //     mangled file BEFORE compilation, keyed on the bundle file name
        //     (rollup's chunk identity), never on a name pattern. Rewritten
        //     chunks are recompiled; the earlier compile only decided the VM set.
        const mangledFileOf = (id: string) => 'assets/' + id + '.js'
        const renamed = new Map<string, string>()
        for (const fileName of chunkNames) if (vm.has(fileName)) renamed.set(fileName, mangledFileOf(idOf.get(fileName)!))
        const finalCode = new Map<string, string>()
        for (const fileName of chunkNames) {
          const code = codeOf(fileName)
          if (!vm.has(fileName)) { finalCode.set(fileName, code); continue }
          const rewritten = rewriteFileRefs(fileName, code, renamed)
          finalCode.set(fileName, rewritten)
          if (rewritten === code) continue
          try {
            compiled.set(fileName, compile(rewritten, { seed }))
          } catch (e) {
            throw new ShieldGuardError('chunk ' + fileName + ' failed to recompile after file-reference rewrite: ' + (e instanceof Error ? e.message : String(e)))
          }
        }

        // 6b. GUARD (hard-fails the build, no opt-out): after the rewrite, no
        //     chunk - VM or native - may still name a file the shield is about
        //     to remove in any string that is not an import/export specifier
        //     (specifiers are mapped by module id, and 6c proves every one of
        //     them maps). Both shapes are checked: the bundle file name
        //     ("assets/<hash>.js", the preload-list shape) and a chunk-relative
        //     path ("./<hash>.js", e.g. new URL(..., import.meta.url)). A native
        //     chunk's specifiers are checked too: one that names a VM chunk is a
        //     frontier bug (the browser would fetch the removed file).
        const guardFailures: string[] = []
        for (const fileName of chunkNames) {
          const nodes = vm.has(fileName) ? stringNodes(finalCode.get(fileName)!).filter((n) => !n.specifier) : stringNodes(finalCode.get(fileName)!)
          for (const { value, specifier } of nodes) {
            if (renamed.has(value)) { guardFailures.push(fileName + ' references removed file "' + value + '"'); continue }
            if (!value.startsWith('./') && !value.startsWith('../')) continue
            const target = resolveSpec(fileName, value)
            if (target && renamed.has(target)) guardFailures.push(fileName + ' references removed file "' + value + '"' + (specifier ? ' (native chunk importing a VM chunk)' : ' outside an import specifier'))
          }
        }
        if (guardFailures.length) {
          throw new ShieldGuardError(guardFailures.length + ' reference(s) to removed chunk files survive in the output:\n  ' + Array.from(new Set(guardFailures)).join('\n  '))
        }

        // 6c. GUARD (hard-fails the build, no opt-out): every static import /
        //     re-export source and every literal dynamic import() specifier of a
        //     VM chunk MUST map to a known module id. An unmapped specifier would
        //     reach the loader as a raw string and be fetched verbatim (the
        //     original file name, which no longer exists). Resolved for ALL VM
        //     chunks before any file is written or removed.
        for (const fileName of chunkNames) {
          if (!vm.has(fileName)) continue
          const r = compiled.get(fileName)
          const md = r.program.module || { imports: [], reexports: [], dynSources: [] }
          const depMap: Record<string, string> = {}
          const dynMap: Record<string, string> = {}
          const addDep = (spec: string, map: Record<string, string>, what: string) => {
            const target = resolveSpec(fileName, spec)
            const tid = target === null ? undefined : idOf.get(target)
            if (tid === undefined) guardFailures.push(fileName + ': ' + what + ' "' + spec + '" does not resolve to a bundled chunk')
            else map[spec] = tid
          }
          for (const i of (md.imports || [])) addDep(i.source, depMap, 'static import')
          for (const re of (md.reexports || [])) addDep(re.source, depMap, 're-export source')
          for (const spec of (md.dynSources || [])) addDep(spec, dynMap, 'dynamic import()')
          if (md.hasComputedDynImport) guardFailures.push(fileName + ': computed dynamic import() in a VM chunk')
          md.depMap = depMap
          md.dynMap = dynMap
          r.program.module = md
        }
        if (guardFailures.length) {
          throw new ShieldGuardError('unmapped import specifier(s) in VM chunk(s):\n  ' + guardFailures.join('\n  '))
        }

        // 6d. compile + boot. For each VM chunk, encrypt the program (dep-maps
        //    baked in above) and emit a mangled register-artifact; remove the
        //    original. Native chunks keep their original fileName.
        for (const fileName of chunkNames) {
          const id = idOf.get(fileName)!
          if (!vm.has(fileName)) { modules[id] = { file: fileName, kind: 'native' }; continue }
          const r = compiled.get(fileName)
          const { key, encrypted } = encryptProgram(r.program)
          // Anti-tamper: embed the bytecode integrity hash the runtime verifies
          // at boot (wipe on mismatch). Computed over the SAME program object
          // that was just encrypted.
          const hash = integrityHash(r.program)

          const mangledFile = mangledFileOf(id)
          const artifact =
            'window.__shield.define(' + JSON.stringify(id) + ',{enc:' + JSON.stringify(toB64(encrypted)) +
            ',key:' + JSON.stringify(toB64(key)) + ',hash:' + (hash >>> 0) + ',metaUrl:import.meta.url});\n'
          // replace the readable ESM chunk on disk with the mangled artifact
          writeAsset(mangledFile, artifact)
          try { unlinkSync(join(outDir, fileName)) } catch { /* ignore */ }
          const rec = records.find((x) => x.id === id)
          if (rec) rec.encryptedBytes = encrypted.length
          modules[id] = { file: mangledFile, kind: 'vm' }
        }

        // 7. Bootstrap: bundle runtime + loader + cipher into one browser script
        //    with the manifest inlined, then boot the entry id through it.
        // 8. Each page that loads a VM chunk gets a bootstrap (one per distinct
        //    script list, id-named) that boots that page's module scripts in
        //    document order, and its module-script tags are replaced by it. This
        //    covers index.html AND sj.html / sj-c6.html; the old code only rewrote
        //    the main entry, leaving those pages pointing at compiled-away chunks.
        //    modulepreload links are dropped everywhere (their targets moved).
        const bootstraps = new Map<string, string[]>()
        for (const page of pages) {
          let html = page.html
          if (page.scripts.some((h) => vm.has(h.key))) {
            const ids = page.scripts.map((h) => idOf.get(h.key)!)
            const file = 'assets/' + mangle('@@bootstrap:' + ids.join(',')) + '.js'
            bootstraps.set(file, ids)
            page.scripts.forEach((h, index) => {
              html = html.replace(h.match, index === 0 ? '<script type="module" crossorigin src="' + h.prefix + file + '"></script>' : '')
            })
          }
          html = html.replace(/<link[^>]*rel=["']modulepreload["'][^>]*>\s*/g, '')
          writeAsset(page.fileName, html)
        }
        for (const [bootstrapFile, ids] of bootstraps) {
          writeAsset(bootstrapFile, await bundleBootstrap({ ...manifest, modules }, ids, options.budget, options.antiTamper))
        }

        manifest.modules = modules
        safeEmitManifest(manifest)
      } catch (err) {
        // Guardrail violations are fatal for the whole build (non-zero exit).
        if (err instanceof ShieldGuardError) throw err
        // Never corrupt the build: on any other plugin error, leave the bundle
        // as-is and record the failure in the manifest.
        safeEmitManifest({
          shieldVersion: 1, generatedAt: new Date().toISOString(), mode, seed,
          loaderStatus: 'compile aborted (plugin error); shipped native untouched',
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
}

// Bundle the browser bootstrap: createLoader + createRuntime + decryptProgram +
// @noble cipher, with the manifest inlined, into one ESM file. Uses esbuild
// (already a Vite dependency). Resolution happens from the shield dir so
// `@noble/ciphers` resolves against main/node_modules.
async function bundleBootstrap(manifest: unknown, entryIds: string[], budget?: number, antiTamper?: Record<string, unknown>): Promise<string> {
  const esbuild = await import('esbuild')
  // fileURLToPath, not URL.pathname: on Windows .pathname is "/C:/...", which
  // esbuild cannot resolve imports against.
  const shieldDir = fileURLToPath(new URL('.', import.meta.url))
  const entry = `
import { createRuntime, decryptProgram } from './runtime-template.js'
import { createLoader } from './loader-template.js'
import { resolveAntiTamper, isLikelyBot } from './anti-tamper.js'
const MANIFEST = ${JSON.stringify(manifest)}
const ENTRIES = ${JSON.stringify(entryIds)}
const __BUDGET__ = ${budget && Number.isFinite(budget) ? String(Math.floor(budget)) : 'undefined'}
const __AT__ = resolveAntiTamper(${JSON.stringify(antiTamper || {})})
const root = new URL('../', import.meta.url)
function resolveURL(file){ return new URL(file, root).href }
const g = typeof window !== 'undefined' ? window : globalThis
// Environment tripwire (renamed A10 isLikelyBot): FLAG ONLY - never wipes or
// blocks. Published on g.__shieldFlags for optional telemetry/UX, nothing else.
g.__shieldFlags = g.__shieldFlags || {}
if (__AT__.envCheck) { try { g.__shieldFlags.likelyBot = isLikelyBot(g) } catch (_) {} }
const loader = createLoader({
  createRuntime, decrypt: decryptProgram, globals: g, manifest: MANIFEST, resolveURL, budget: __BUDGET__, antiTamper: __AT__,
  fetchArtifact: (url) => import(/* @vite-ignore */ url),
  importNative: (url) => import(/* @vite-ignore */ url),
})
g.__shield = loader
;(async () => { for (const id of ENTRIES) await loader.load(id) })().catch((err) => { (g.console || console).error('[shield] boot failed', err); throw err })
`
  const res = await esbuild.build({
    stdin: { contents: entry, resolveDir: shieldDir, loader: 'js', sourcefile: 'shield-bootstrap.js' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    legalComments: 'none',
    minify: true,
  })
  return res.outputFiles[0].text
}

export default shieldPlugin
