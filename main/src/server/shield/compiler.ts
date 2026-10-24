// shield compiler: acorn AST -> stack bytecode for a well-defined SUBSET of
// JavaScript, with strict-mode + TDZ semantics (PLAN 5.4 / 5.5 / 5.6).
//
// Erasable TypeScript only (no enum / parameter properties / namespace) so the
// `.mjs` node:test files can import it directly under Node's type stripping.
//
// Honesty notes live in README.md. In short: this compiles a real subset and
// is tested against native eval. Generators, classes, eval/new Function, with,
// tagged templates, and ES module import/export are NOT supported and raise a
// clear error (ShieldUnsupported) so callers can fall back to `@no-vm`.

import * as acorn from 'acorn'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { ARITY, buildLayout } from './opcodes.ts'
import type { OpName, OpcodeLayout } from './opcodes.ts'

export class ShieldCompileError extends Error {}
export class ShieldUnsupported extends ShieldCompileError {}

export interface FunctionDef {
  code: number[]
  name: string | null
  isAsync: boolean
  isArrow: boolean
  numParams: number
}

export interface ImportSpec {
  local: string
  source: string
  kind: 'default' | 'ns' | 'named'
  imported?: string
}

export interface ReexportSpec {
  source: string
  // named re-export
  imported?: string
  exported?: string
  // `export * from` (star) or `export * as ns from`
  star?: boolean
  as?: string
  // bare `import './x'` side-effect-only dependency
  sideEffect?: boolean
}

export interface ModuleDesc {
  imports: ImportSpec[]
  // exported name -> local binding name
  exports: Record<string, string>
  reexports: ReexportSpec[]
  // every distinct module specifier this module depends on (static)
  deps: string[]
  // literal specifiers used in dynamic import() (for loader route-chunk mapping)
  dynSources: string[]
  hasTLA: boolean
  // exported name -> slot index in the module (main) base scope. Lets the loader
  // read exports by slot (slot-based locals) instead of by name.
  exportSlots?: Record<string, number>
  // true if a dynamic import() had a non-static (computed) specifier.
  hasComputedDynImport?: boolean
  // baked by the Vite plugin: original specifier -> resolved module id.
  depMap?: Record<string, string>
  dynMap?: Record<string, string>
}

export interface ShieldProgram {
  version: number
  layout: OpcodeLayout
  consts: unknown[]
  functions: FunctionDef[]
  mainIndex: number
  module?: ModuleDesc
}

export interface CompileOptions {
  seed?: string | number
  // When true, a construct outside the subset throws ShieldUnsupported.
  // When false (default), it still throws - there is no silent fallback inside
  // the compiler; `@no-vm` fallback is a caller (plugin) concern.
  strictSubset?: boolean
}

export interface CompileResult {
  program: ShieldProgram
  layout: OpcodeLayout
  key: Uint8Array
  // nonce(24) || ciphertext(+16 tag) of JSON(program)
  encrypted: Uint8Array
}

interface Label { pos: number }
interface Fixup { slot: number; label: Label }

interface LoopCtx {
  kind: 'loop' | 'switch' | 'label'
  label: string | null
  brk: Label
  cont: Label | null
  // scope depth active where `continue` lands (and the default for `break`).
  scopeDepth: number
  // scope depth active where `break` lands. Differs from scopeDepth only for
  // for-of/for-in with a per-iteration let/const scope: `continue` lands inside
  // that scope (before it is exited) but `break` lands after it is exited.
  brkScopeDepth: number
  handlerLen: number
}

interface HandlerInfo { kind: 'catch' | 'finally'; scopeDepth: number }

interface FnState {
  code: number[]
  fixups: Fixup[]
  isAsync: boolean
  isArrow: boolean
  isMain: boolean
  scopeDepth: number
  handlers: HandlerInfo[]
  loops: LoopCtx[]
  pendingLabel: string | null
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  // Works in Node 24 and the browser. Typed structurally so this compiles
  // under either a DOM lib or a Node-only lib.
  const c = (globalThis as unknown as { crypto: { getRandomValues(a: Uint8Array): Uint8Array } }).crypto
  c.getRandomValues(out)
  return out
}

function encodeConst(v: unknown): unknown {
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { $: 'n', v: 'NaN' }
    if (v === Infinity) return { $: 'n', v: 'Inf' }
    if (v === -Infinity) return { $: 'n', v: '-Inf' }
    if (Object.is(v, -0)) return { $: 'n', v: '-0' }
    return v
  }
  return v
}

export class Compiler {
  private layout: OpcodeLayout
  private consts: unknown[] = []
  private constMap = new Map<string, number>()
  private functions: FunctionDef[] = []
  private fn!: FnState
  private hiddenN = 0
  private chainEnd: Label | null = null

  // Compile-time lexical scope stack (PLAN 5.11 perf: slot-based locals). Each
  // scope maps a declared name to a dense slot index. The stack spans function
  // boundaries so a closure's free variable resolves to a (depth, index) pair,
  // which mirrors the runtime scope chain exactly (a frame's base scope parents
  // to the defining scope; see runtime-template makeFrame/createClosure). Names
  // not found in any scope are free => globals. The module (main) base scope's
  // name map is captured for export resolution.
  private scopes: { names: Map<string, number>; count: number }[] = []
  private mainScopeNames: Map<string, number> | null = null

  constructor(seed: string | number) {
    this.layout = buildLayout(seed)
  }

  // ---- slot scope helpers ----
  private pushScope(): void { this.scopes.push({ names: new Map(), count: 0 }) }
  private popScope(): void { this.scopes.pop() }
  private declareSlot(name: string): number {
    const s = this.scopes[this.scopes.length - 1]
    let i = s.names.get(name)
    if (i === undefined) { i = s.count++; s.names.set(name, i) }
    return i
  }
  private resolveSlot(name: string): { depth: number; index: number } | null {
    for (let d = this.scopes.length - 1, depth = 0; d >= 0; d--, depth++) {
      const i = this.scopes[d].names.get(name)
      if (i !== undefined) return { depth, index: i }
    }
    return null
  }
  private packAddr(depth: number, index: number): number { return (depth << 16) | index }

  // name reference -> slot (local/upvalue) or global
  private emitLoadName(name: string): void {
    const r = this.resolveSlot(name)
    if (r) this.emit('LOAD_SLOT', this.packAddr(r.depth, r.index))
    else this.emit('LOAD_GLOBAL', this.addConst(name))
  }
  private emitStoreName(name: string): void {
    const r = this.resolveSlot(name)
    if (r) this.emit('STORE_SLOT', this.packAddr(r.depth, r.index))
    else this.emit('STORE_GLOBAL', this.addConst(name))
  }
  private emitTypeofName(name: string): void {
    const r = this.resolveSlot(name)
    if (r) this.emit('TYPEOF_SLOT', this.packAddr(r.depth, r.index))
    else this.emit('TYPEOF_GLOBAL', this.addConst(name))
  }
  // init a declared local (params, let/const, destructure leaves, temps). The
  // slot MUST already be declared in an enclosing scope.
  private emitInitName(name: string): void {
    const r = this.resolveSlot(name)
    if (!r) throw new ShieldCompileError('internal: INIT of undeclared slot ' + name)
    this.emit('INIT_SLOT', this.packAddr(r.depth, r.index))
  }
  // declare a lexical binding in the CURRENT scope. kind: 0=var,1=let,2=const.
  private emitDeclare(name: string, kind: 0 | 1 | 2): void {
    const idx = this.declareSlot(name)
    this.emit('DECLARE_SLOT', (idx << 2) | kind)
  }
  // Emit a set of same-scope lexical TDZ-cell declares, coalescing contiguous
  // same-kind index runs into DECLARE_SLOTS (one step for the whole run). Order
  // of declares within a scope is irrelevant (each writes an independent cell),
  // so sorting by index to find runs is sound.
  private emitDeclareRun(decls: { index: number; kind: 0 | 1 | 2 }[]): void {
    if (decls.length === 0) return
    if (decls.length === 1) { this.emit('DECLARE_SLOT', (decls[0].index << 2) | decls[0].kind); return }
    decls.sort((a, b) => a.index - b.index)
    let i = 0
    while (i < decls.length) {
      const start = decls[i].index; const kind = decls[i].kind
      let j = i + 1
      while (j < decls.length && decls[j].kind === kind && decls[j].index === decls[j - 1].index + 1) j++
      const count = j - i
      if (count >= 2) this.emit('DECLARE_SLOTS', this.addConst([start, count, kind]))
      else this.emit('DECLARE_SLOT', (start << 2) | kind)
      i = j
    }
  }

  // hoisted function declaration: var-like binding, initialized from TOS.
  private emitDefFunc(name: string): void {
    const idx = this.declareSlot(name)
    this.emit('DEF_FUNC_SLOT', idx)
  }
  // Superinstruction: emit a fused load of `ident.key` (non-computed, static
  // key). `dup` selects the method-receiver form (leaves [recv, recv.key]).
  // Returns true if it emitted a fused op, false if the caller should fall back.
  private emitFusedMemberLoad(objName: string, key: string, dup: boolean): boolean {
    const r = this.resolveSlot(objName)
    if (r) {
      const tuple = this.addConst([this.packAddr(r.depth, r.index), key])
      this.emit(dup ? 'LOAD_SLOT_DUP_PROP' : 'LOAD_SLOT_PROP', tuple)
    } else {
      const tuple = this.addConst([objName, key])
      this.emit(dup ? 'LOAD_GLOBAL_DUP_PROP' : 'LOAD_GLOBAL_PROP', tuple)
    }
    return true
  }

  // Allocate + declare a hidden compiler temp (var) in the CURRENT scope, emit
  // its DECLARE_SLOT, and return its packed (depth 0) address for INIT/LOAD/
  // STORE_SLOT. Temps are always declared and consumed within one scope, so the
  // depth is 0 - callers must not cross a scope boundary before using it.
  private declTemp(): number {
    const idx = this.declareSlot(this.hidden())
    this.emit('DECLARE_SLOT', (idx << 2) | 0)
    return (0 << 16) | idx
  }

  // ---- low-level emit helpers ----
  private emit(name: OpName, ...operands: number[]): void {
    this.fn.code.push(this.layout.byteOf[name])
    if (operands.length !== ARITY[name]) {
      throw new ShieldCompileError(`internal: ${name} expects ${ARITY[name]} operands, got ${operands.length}`)
    }
    for (const o of operands) this.fn.code.push(o)
  }

  private emitJump(name: OpName, label: Label): void {
    this.fn.code.push(this.layout.byteOf[name])
    this.fn.fixups.push({ slot: this.fn.code.length, label })
    this.fn.code.push(0)
  }

  private newLabel(): Label { return { pos: -1 } }
  private place(l: Label): void { l.pos = this.fn.code.length }

  private enterScope(): void { this.emit('ENTER_SCOPE'); this.fn.scopeDepth++; this.pushScope() }
  private exitScope(): void { this.emit('EXIT_SCOPE'); this.fn.scopeDepth--; this.popScope() }

  private hidden(): string { return '@' + (this.hiddenN++) }

  private addConst(value: unknown): number {
    const encoded = encodeConst(value)
    const key = (typeof value === 'string' ? 's:' : 'j:') + JSON.stringify(encoded)
    const found = this.constMap.get(key)
    if (found !== undefined) return found
    const idx = this.consts.length
    this.consts.push(encoded)
    this.constMap.set(key, idx)
    return idx
  }

  private addRegex(source: string, flags: string): number {
    const idx = this.consts.length
    this.consts.push({ $: 're', s: source, f: flags })
    return idx
  }

  private addBigInt(digits: string): number {
    const idx = this.consts.length
    this.consts.push({ $: 'bi', v: digits })
    return idx
  }

  private moduleDesc: ModuleDesc | null = null
  private importEmit: ImportSpec[] = []

  // ---- entry ----
  compile(source: string): CompileResult {
    let ast: acorn.Program
    try {
      ast = acorn.parse(source, { ecmaVersion: 2022, sourceType: 'module', allowAwaitOutsideFunction: true }) as acorn.Program
    } catch (e) {
      throw new ShieldCompileError('parse error: ' + (e instanceof Error ? e.message : String(e)))
    }
    const lowered = this.extractModule(ast.body)
    const mainIndex = this.compileFunctionLike({
      params: [],
      body: lowered,
      isBlockBody: true,
      isAsync: !!this.moduleDesc && this.moduleDesc.hasTLA,
      isArrow: false,
      isMain: true,
      name: null,
    })
    // Resolve each export's local name to its module-scope slot for the loader.
    if (this.moduleDesc && this.mainScopeNames) {
      const exportSlots: Record<string, number> = {}
      for (const [exported, local] of Object.entries(this.moduleDesc.exports)) {
        const slot = this.mainScopeNames.get(local)
        if (slot !== undefined) exportSlots[exported] = slot
      }
      this.moduleDesc.exportSlots = exportSlots
    }
    const program: ShieldProgram = {
      version: 1,
      layout: this.layout,
      consts: this.consts,
      functions: this.functions,
      mainIndex,
      module: this.moduleDesc || undefined,
    }
    const { key, encrypted } = encryptProgram(program)
    return { program, layout: this.layout, key, encrypted }
  }

  // ---- ES module extraction (whole-chunk loader, PLAN 5.3/5.5) ----
  // Pulls import/export declarations out of the top-level body into a module
  // descriptor and returns a "lowered" statement list the generic compiler can
  // handle (imports removed, exports replaced by their inner declarations).
  private extractModule(body: any[]): any[] {
    const desc: ModuleDesc = { imports: [], exports: {}, reexports: [], deps: [], dynSources: [], hasTLA: false }
    const depSet = new Set<string>()
    const lowered: any[] = []
    let hasDefault = false

    const declaredNames = (decl: any): string[] => {
      if (decl.type === 'VariableDeclaration') {
        const out: string[] = []
        for (const d of decl.declarations) this.collectPatternNames(d.id, out)
        return out
      }
      if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') return decl.id ? [decl.id.name] : []
      return []
    }

    for (const s of body) {
      switch (s.type) {
        case 'ImportDeclaration': {
          const source = String(s.source.value)
          depSet.add(source)
          if (s.specifiers.length === 0) desc.reexports.push({ source, sideEffect: true })
          for (const spec of s.specifiers) {
            if (spec.type === 'ImportDefaultSpecifier') desc.imports.push({ local: spec.local.name, source, kind: 'default' })
            else if (spec.type === 'ImportNamespaceSpecifier') desc.imports.push({ local: spec.local.name, source, kind: 'ns' })
            else desc.imports.push({ local: spec.local.name, source, kind: 'named', imported: spec.imported.name ?? String(spec.imported.value) })
          }
          break
        }
        case 'ExportNamedDeclaration': {
          if (s.declaration) {
            lowered.push(s.declaration)
            for (const n of declaredNames(s.declaration)) desc.exports[n] = n
          } else if (s.source) {
            const source = String(s.source.value)
            depSet.add(source)
            for (const spec of s.specifiers) {
              const imported = spec.local.name ?? String(spec.local.value)
              const exported = spec.exported.name ?? String(spec.exported.value)
              desc.reexports.push({ source, imported, exported })
            }
          } else {
            for (const spec of s.specifiers) {
              const local = spec.local.name ?? String(spec.local.value)
              const exported = spec.exported.name ?? String(spec.exported.value)
              desc.exports[exported] = local
            }
          }
          break
        }
        case 'ExportDefaultDeclaration': {
          hasDefault = true
          const d = s.declaration
          if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) {
            lowered.push(d)
            desc.exports['default'] = d.id.name
          } else if (d.type === 'FunctionDeclaration') {
            lowered.push({ type: 'ShieldExportDefault', argument: { ...d, type: 'FunctionExpression' } })
            desc.exports['default'] = '*default*'
          } else if (d.type === 'ClassDeclaration') {
            lowered.push({ type: 'ShieldExportDefault', argument: { ...d, type: 'ClassExpression' } })
            desc.exports['default'] = '*default*'
          } else {
            lowered.push({ type: 'ShieldExportDefault', argument: d })
            desc.exports['default'] = '*default*'
          }
          break
        }
        case 'ExportAllDeclaration': {
          const source = String(s.source.value)
          depSet.add(source)
          if (s.exported) desc.reexports.push({ source, star: true, as: s.exported.name ?? String(s.exported.value) })
          else desc.reexports.push({ source, star: true })
          break
        }
        default:
          lowered.push(s)
      }
    }

    desc.hasTLA = this.scanTopLevelAwait(lowered)
    desc.deps = Array.from(depSet)
    void hasDefault
    this.moduleDesc = desc
    this.importEmit = desc.imports
    return lowered
  }

  // Detect top-level `await` (not inside a nested function). for-await is
  // rejected elsewhere; this only drives whether the module body runs async.
  private scanTopLevelAwait(nodes: any[]): boolean {
    let found = false
    const walk = (node: any): void => {
      if (found || !node || typeof node.type !== 'string') return
      if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' ||
          node.type === 'ArrowFunctionExpression' || node.type === 'ClassBody') return
      if (node.type === 'AwaitExpression') { found = true; return }
      if (node.type === 'ForOfStatement' && node.await) { found = true; return }
      for (const k of Object.keys(node)) {
        if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue
        const v = node[k]
        if (Array.isArray(v)) { for (const c of v) walk(c) }
        else if (v && typeof v.type === 'string') walk(v)
      }
    }
    for (const n of nodes) walk(n)
    return found
  }

  // ---- function compilation ----
  private compileFunctionLike(opts: {
    params: any[]
    body: any    // array of statements (block body) OR an expression (arrow expr body)
    isBlockBody: boolean
    isAsync: boolean
    isArrow: boolean
    isMain: boolean
    name: string | null
  }): number {
    const prev = this.fn
    const prevChain = this.chainEnd
    this.chainEnd = null
    this.fn = {
      code: [], fixups: [], isAsync: opts.isAsync, isArrow: opts.isArrow, isMain: opts.isMain,
      scopeDepth: 0, handlers: [], loops: [], pendingLabel: null,
    }
    // The function's base scope is created at runtime by makeFrame (not an
    // ENTER_SCOPE op), so push the matching compile scope here without emitting.
    this.pushScope()

    // Module prologue: install live import bindings before any top-level code.
    // Imports occupy slots in the module base scope (declared here), so they
    // must be declared BEFORE params/vars to keep slot assignment stable.
    if (opts.isMain && this.moduleDesc) {
      this.emit('MODULE_INIT', this.addConst(JSON.stringify({ exports: this.moduleDesc.exports })))
      for (const imp of this.importEmit) {
        const slot = this.declareSlot(imp.local)
        this.emit('IMPORT_SLOT', this.addConst(JSON.stringify({ ...imp, slot })))
      }
    }

    // Prologue: bind parameters.
    this.compileParams(opts.params)

    // Bind a local `arguments` (array-like of the call args) when a non-arrow
    // function references it. Arrows inherit it through the scope chain, so they
    // never bind their own. Done lazily (only when used) to keep calls cheap.
    if (opts.isBlockBody && !opts.isArrow && this.usesArguments(opts.body)) {
      const slot = this.declareSlot('arguments')
      this.emit('DECLARE_SLOT', (slot << 2) | 0)
      this.emit('LOAD_ARGS_FROM', 0) // frame.args.slice(0)
      this.emit('INIT_SLOT', (0 << 16) | slot)
    }

    // Hoist `var` names to the function scope.
    if (opts.isBlockBody) {
      const varNames = new Set<string>()
      for (const s of opts.body) this.collectVars(s, varNames)
      for (const n of varNames) this.emitDeclare(n, 0)
    }

    if (opts.isBlockBody) {
      this.compileBlockBody(opts.body, opts.isMain)
      this.emit(opts.isMain ? 'HALT' : 'RETURN_UNDEF')
    } else {
      // arrow expression body
      this.compileExpr(opts.body)
      this.emit('RETURN')
    }

    // Resolve jump fixups.
    for (const f of this.fn.fixups) {
      if (f.label.pos < 0) throw new ShieldCompileError('internal: unresolved label')
      this.fn.code[f.slot] = f.label.pos
    }

    // Capture the module base scope name->slot map (for export resolution)
    // before popping it.
    if (opts.isMain) this.mainScopeNames = this.scopes[this.scopes.length - 1].names
    this.popScope()

    const def: FunctionDef = {
      code: this.fn.code,
      name: opts.name,
      isAsync: opts.isAsync,
      isArrow: opts.isArrow,
      numParams: opts.params.length,
    }
    const idx = this.functions.length
    this.functions.push(def)
    this.fn = prev
    this.chainEnd = prevChain
    return idx
  }

  private compileParams(params: any[]): void {
    for (let i = 0; i < params.length; i++) {
      const p = params[i]
      if (p.type === 'RestElement') {
        this.declareNames(p.argument, 'param')
        this.emit('LOAD_ARGS_FROM', i)
        this.bindTarget(p.argument, (t) => this.emitInitName(t.name))
        break
      }
      // Fast path: a plain identifier param with no default binds in one op.
      if (p.type === 'Identifier') {
        const slot = this.declareSlot(p.name)
        if (slot < 256 && i < 256) { this.emit('BIND_PARAM', (slot << 8) | i); continue }
        this.emit('DECLARE_SLOT', (slot << 2) | 0)
        this.emit('LOAD_ARG', i); this.emit('INIT_SLOT', (0 << 16) | slot)
        continue
      }
      let target = p
      let def: any = null
      if (p.type === 'AssignmentPattern') { target = p.left; def = p.right }
      this.declareNames(target, 'param')
      this.emit('LOAD_ARG', i)
      if (def) this.applyDefault(def)
      this.bindTarget(target, (t) => this.emitInitName(t.name))
    }
  }

  // Declare (without initializing where TDZ applies) every name bound by a
  // pattern. kind controls which DECLARE op is used.
  private declareNames(pattern: any, kind: 'var' | 'let' | 'const' | 'param'): void {
    const k: 0 | 1 | 2 = kind === 'let' ? 1 : kind === 'const' ? 2 : 0
    const names: string[] = []
    this.collectPatternNames(pattern, names)
    for (const n of names) this.emitDeclare(n, k)
  }

  private collectPatternNames(pattern: any, out: string[]): void {
    switch (pattern.type) {
      case 'Identifier': out.push(pattern.name); return
      case 'AssignmentPattern': this.collectPatternNames(pattern.left, out); return
      case 'RestElement': this.collectPatternNames(pattern.argument, out); return
      case 'ArrayPattern':
        for (const el of pattern.elements) if (el) this.collectPatternNames(el, out)
        return
      case 'ObjectPattern':
        for (const pr of pattern.properties) {
          if (pr.type === 'RestElement') this.collectPatternNames(pr.argument, out)
          else this.collectPatternNames(pr.value, out)
        }
        return
      default:
        throw new ShieldUnsupported(`pattern ${pattern.type} not supported`)
    }
  }

  // Does this (non-arrow) function body reference `arguments`? Descends into
  // nested ARROWS (which share the enclosing `arguments`) but not into nested
  // non-arrow functions (which get their own). Used to decide whether to bind a
  // local `arguments` at function entry.
  private usesArguments(body: any[]): boolean {
    let found = false
    const walk = (node: any): void => {
      if (found || !node || typeof node.type !== 'string') return
      if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ClassBody') return
      if (node.type === 'Identifier') { if (node.name === 'arguments') found = true; return }
      if (node.type === 'MemberExpression' && !node.computed) { walk(node.object); return } // skip `.arguments` property
      for (const k of Object.keys(node)) {
        if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue
        const v = node[k]
        if (Array.isArray(v)) { for (const c of v) walk(c) }
        else if (v && typeof v.type === 'string') walk(v)
      }
    }
    for (const n of body) walk(n)
    return found
  }

  // Collect `var` names in a statement, not crossing function/class boundaries.
  private collectVars(node: any, out: Set<string>): void {
    if (!node || typeof node.type !== 'string') return
    switch (node.type) {
      case 'VariableDeclaration':
        if (node.kind === 'var') {
          for (const d of node.declarations) {
            const names: string[] = []
            this.collectPatternNames(d.id, names)
            for (const n of names) out.add(n)
          }
        }
        return
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
      case 'ClassDeclaration':
      case 'ClassExpression':
        return // do not descend into nested function/class scopes
      default: {
        for (const k of Object.keys(node)) {
          if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue
          const v = (node as any)[k]
          if (Array.isArray(v)) { for (const c of v) this.collectVars(c, out) }
          else if (v && typeof v.type === 'string') this.collectVars(v, out)
        }
      }
    }
  }

  // Compile a list of statements that share one scope. Hoists function
  // declarations and lexical (let/const) bindings of THIS list first.
  //
  // Slot-based locals need every block-scoped NAME to have an assigned slot
  // index BEFORE any nested function body is compiled, because a body may
  // forward-reference a sibling (mutual recursion, `return inner(); function
  // inner(){}`). So pass 0 pre-assigns slots, pass 1 emits TDZ cells for
  // lexicals (before closures so a captured sibling binding's cell exists),
  // pass 2 builds the hoisted function closures, pass 3 runs the statements.
  private compileBlockBody(stmts: any[], topLevel: boolean): void {
    // 0. pre-assign slots for all block-scoped names (compile-time only).
    for (const s of stmts) {
      if (s.type === 'FunctionDeclaration' && s.id) this.declareSlot(s.id.name)
      else if (s.type === 'VariableDeclaration' && (s.kind === 'let' || s.kind === 'const')) {
        const names: string[] = []
        for (const d of s.declarations) this.collectPatternNames(d.id, names)
        for (const n of names) this.declareSlot(n)
      } else if (s.type === 'ClassDeclaration' && s.id) this.declareSlot(s.id.name)
      else if (s.type === 'ShieldExportDefault') this.declareSlot('*default*')
    }
    // 1. lexical TDZ cells (let=1, const=2, class=let, default=const). Slots
    //    were pre-assigned in pass 0, so collect (index,kind) and coalesce
    //    contiguous same-kind runs into DECLARE_SLOTS (one step per run instead
    //    of per binding - the DECLARE_CONST;DECLARE_CONST... real-bundle run).
    const lexDecls: { index: number; kind: 0 | 1 | 2 }[] = []
    const addLex = (name: string, kind: 0 | 1 | 2) => {
      const r = this.resolveSlot(name)
      if (r && r.depth === 0) lexDecls.push({ index: r.index, kind })
    }
    for (const s of stmts) {
      if (s.type === 'VariableDeclaration' && (s.kind === 'let' || s.kind === 'const')) {
        const k: 1 | 2 = s.kind === 'let' ? 1 : 2
        const names: string[] = []
        for (const d of s.declarations) this.collectPatternNames(d.id, names)
        for (const n of names) addLex(n, k)
      } else if (s.type === 'ClassDeclaration' && s.id) addLex(s.id.name, 1)
      else if (s.type === 'ShieldExportDefault') addLex('*default*', 2)
    }
    this.emitDeclareRun(lexDecls)
    // 2. function declarations (hoisted, initialized closures)
    for (const s of stmts) {
      if (s.type === 'FunctionDeclaration') {
        if (s.generator) throw new ShieldUnsupported('generators not supported')
        const idx = this.compileFunctionLike({
          params: s.params, body: s.body.body, isBlockBody: true,
          isAsync: !!s.async, isArrow: false, isMain: false, name: s.id ? s.id.name : null,
        })
        this.emit('MAKE_FUNC', idx)
        this.emitDefFunc(s.id.name)
      }
    }
    // 3. statements in order
    for (const s of stmts) {
      if (s.type === 'FunctionDeclaration') continue
      this.compileStatement(s, topLevel)
    }
  }

  // Does this statement list hoist any block-scoped binding? If not, the block
  // needs no runtime scope (see BlockStatement in compileStatement).
  private blockHasLexical(stmts: any[]): boolean {
    for (const s of stmts) {
      if (s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration' || s.type === 'ShieldExportDefault') return true
      if (s.type === 'VariableDeclaration' && (s.kind === 'let' || s.kind === 'const')) return true
    }
    return false
  }

  // ---- statements ----
  private compileStatement(node: any, topLevel: boolean): void {
    switch (node.type) {
      case 'ExpressionStatement':
        this.compileExpr(node.expression)
        if (topLevel && this.fn.isMain) this.emit('SET_COMPLETION')
        else this.emit('POP')
        return
      case 'EmptyStatement':
        return
      case 'BlockStatement': {
        // Per-iteration / per-branch overhead reduction: a block that hoists no
        // block-scoped binding (no let/const/class/function decl) needs no fresh
        // runtime scope, so skip ENTER_SCOPE/EXIT_SCOPE (and the matching
        // compile-time scope) and run its statements in the enclosing scope.
        // `var` hoists to the function scope and needs no block scope; compiler
        // temps are declared+consumed within this statement, so depth 0 in the
        // enclosing scope is correct. Saves 2 steps per block execution.
        if (this.blockHasLexical(node.body)) {
          this.enterScope()
          this.compileBlockBody(node.body, false)
          this.exitScope()
        } else {
          this.compileBlockBody(node.body, false)
        }
        return
      }
      case 'VariableDeclaration':
        this.compileVarDecl(node)
        return
      case 'FunctionDeclaration':
        return // handled by hoist
      case 'ReturnStatement':
        if (this.fn.isMain) throw new ShieldCompileError('return outside function')
        if (node.argument) { this.compileExpr(node.argument); this.emitReturn() }
        else this.emitReturnUndef()
        return
      case 'IfStatement': {
        const lElse = this.newLabel(); const lEnd = this.newLabel()
        this.compileExpr(node.test)
        this.emitJump('JMP_IF_FALSE', lElse)
        this.compileStatement(node.consequent, false)
        if (node.alternate) {
          this.emitJump('JMP', lEnd); this.place(lElse)
          this.compileStatement(node.alternate, false)
          this.place(lEnd)
        } else {
          this.place(lElse)
        }
        return
      }
      case 'WhileStatement': return this.compileWhile(node)
      case 'DoWhileStatement': return this.compileDoWhile(node)
      case 'ForStatement': return this.compileFor(node)
      case 'ForOfStatement': return this.compileForOf(node)
      case 'ForInStatement': return this.compileForIn(node)
      case 'BreakStatement': return this.compileBreak(node)
      case 'ContinueStatement': return this.compileContinue(node)
      case 'LabeledStatement': return this.compileLabeled(node)
      case 'SwitchStatement': return this.compileSwitch(node)
      case 'ThrowStatement': this.compileExpr(node.argument); this.emit('THROW'); return
      case 'TryStatement': return this.compileTry(node)
      case 'ClassDeclaration': {
        this.compileClass(node)
        this.emitInitName(node.id.name)
        return
      }
      case 'ShieldExportDefault': {
        this.compileExpr(node.argument)
        this.emitInitName('*default*')
        return
      }
      default:
        throw new ShieldUnsupported(`statement ${node.type} not supported`)
    }
  }

  private emitReturn(): void {
    if (this.fn.handlers.some((h) => h.kind === 'finally')) {
      // runtime RETURN handler routes through active finally handlers
    }
    this.emit('RETURN')
  }
  private emitReturnUndef(): void { this.emit('RETURN_UNDEF') }

  private compileVarDecl(node: any): void {
    const kind = node.kind
    for (const d of node.declarations) {
      if (d.init) {
        this.compileExpr(d.init)
        if (d.id.type === 'Identifier') this.emitInitName(d.id.name)
        else this.destructure(d.id, (t) => this.emitInitName(t.name))
      } else {
        // `let x;` -> initialize the TDZ binding to undefined. `var x;` already
        // initialized undefined by the prologue DECLARE_SLOT.
        if (kind === 'let') { this.emit('PUSH_UNDEF'); this.emitInitName(d.id.name) }
        // const requires an init (parser enforces); var: nothing to do.
      }
    }
  }

  // ---- loops ----
  private takeLabel(): string | null { const l = this.fn.pendingLabel; this.fn.pendingLabel = null; return l }

  private compileWhile(node: any): void {
    const label = this.takeLabel()
    const lTop = this.newLabel(); const lEnd = this.newLabel()
    const ctx: LoopCtx = { kind: 'loop', label, brk: lEnd, cont: lTop, scopeDepth: this.fn.scopeDepth, brkScopeDepth: this.fn.scopeDepth, handlerLen: this.fn.handlers.length }
    this.place(lTop)
    this.compileExpr(node.test)
    this.emitJump('JMP_IF_FALSE', lEnd)
    this.fn.loops.push(ctx)
    this.compileStatement(node.body, false)
    this.fn.loops.pop()
    this.emitJump('JMP', lTop)
    this.place(lEnd)
  }

  private compileDoWhile(node: any): void {
    const label = this.takeLabel()
    const lTop = this.newLabel(); const lCont = this.newLabel(); const lEnd = this.newLabel()
    const ctx: LoopCtx = { kind: 'loop', label, brk: lEnd, cont: lCont, scopeDepth: this.fn.scopeDepth, brkScopeDepth: this.fn.scopeDepth, handlerLen: this.fn.handlers.length }
    this.place(lTop)
    this.fn.loops.push(ctx)
    this.compileStatement(node.body, false)
    this.fn.loops.pop()
    this.place(lCont)
    this.compileExpr(node.test)
    this.emitJump('JMP_IF_TRUE', lTop)
    this.place(lEnd)
  }

  private compileFor(node: any): void {
    const label = this.takeLabel()
    this.enterScope()
    if (node.init) {
      if (node.init.type === 'VariableDeclaration') {
        if (node.init.kind === 'let' || node.init.kind === 'const') {
          for (const d of node.init.declarations) this.declareNames(d.id, node.init.kind)
        }
        this.compileVarDecl(node.init)
      } else { this.compileExpr(node.init); this.emit('POP') }
    }
    const lTest = this.newLabel(); const lCont = this.newLabel(); const lEnd = this.newLabel()
    this.place(lTest)
    if (node.test) { this.compileExpr(node.test); this.emitJump('JMP_IF_FALSE', lEnd) }
    const ctx: LoopCtx = { kind: 'loop', label, brk: lEnd, cont: lCont, scopeDepth: this.fn.scopeDepth, brkScopeDepth: this.fn.scopeDepth, handlerLen: this.fn.handlers.length }
    this.fn.loops.push(ctx)
    this.compileStatement(node.body, false)
    this.fn.loops.pop()
    this.place(lCont)
    if (node.update) { this.compileExpr(node.update); this.emit('POP') }
    this.emitJump('JMP', lTest)
    this.place(lEnd)
    this.exitScope()
  }

  private compileForOf(node: any): void {
    if (node.await) throw new ShieldUnsupported('for await...of not supported')
    const label = this.takeLabel()
    this.enterScope()
    const iterAddr = this.declTemp()
    this.compileExpr(node.right)
    this.emit('GET_ITERATOR')
    this.emit('INIT_SLOT', iterAddr)
    this.compileForLoopCore(node, iterAddr, label)
    this.exitScope()
  }

  private compileForIn(node: any): void {
    const label = this.takeLabel()
    this.enterScope()
    const iterAddr = this.declTemp()
    this.compileExpr(node.right)
    this.emit('FOR_IN_KEYS')      // obj -> keys array
    this.emit('GET_ITERATOR')
    this.emit('INIT_SLOT', iterAddr)
    this.compileForLoopCore(node, iterAddr, label)
    this.exitScope()
  }

  private compileForLoopCore(node: any, iterAddr: number, label: string | null): void {
    const lTop = this.newLabel(); const lCont = this.newLabel(); const lEnd = this.newLabel()
    this.place(lTop)
    this.emit('LOAD_SLOT', iterAddr)
    this.emitJump('FOR_ITER', lEnd)   // iterator -> value (or jump when done)
    // bind loop variable (value is on stack)
    const left = node.left
    let perIterScope = false
    if (left.type === 'VariableDeclaration') {
      const kind = left.kind
      const d = left.declarations[0]
      if (kind === 'let' || kind === 'const') {
        this.enterScope(); perIterScope = true
        this.declareNames(d.id, kind)
        if (d.id.type === 'Identifier') this.emitInitName(d.id.name)
        else this.destructure(d.id, (t) => this.emitInitName(t.name))
      } else {
        // var
        if (d.id.type === 'Identifier') this.emitInitName(d.id.name)
        else this.destructure(d.id, (t) => this.emitInitName(t.name))
      }
    } else {
      // assignment to an existing target / pattern
      if (left.type === 'Identifier' || left.type === 'MemberExpression') this.storeToTarget(left)
      else this.destructure(left, (t) => this.storeToTarget(t))
    }
    // `continue` (lCont) lands with the per-iteration scope still active;
    // `break` (lEnd) lands after it is exited, one scope shallower.
    const ctx: LoopCtx = {
      kind: 'loop', label, brk: lEnd, cont: lCont,
      scopeDepth: this.fn.scopeDepth,
      brkScopeDepth: perIterScope ? this.fn.scopeDepth - 1 : this.fn.scopeDepth,
      handlerLen: this.fn.handlers.length,
    }
    this.fn.loops.push(ctx)
    this.compileStatement(node.body, false)
    this.fn.loops.pop()
    this.place(lCont)
    if (perIterScope) this.exitScope()
    this.emitJump('JMP', lTop)
    this.place(lEnd)
  }

  private findLoop(label: string | null, needCont: boolean): LoopCtx {
    const loops = this.fn.loops
    for (let i = loops.length - 1; i >= 0; i--) {
      const c = loops[i]
      if (label) { if (c.label === label && (!needCont || c.cont)) return c }
      else if (needCont) { if (c.cont) return c }
      else return c
    }
    throw new ShieldCompileError(`no ${needCont ? 'continue' : 'break'} target${label ? ' for label ' + label : ''}`)
  }

  // Emit an abrupt transfer (break/continue) to `targetLabel`, unwinding every
  // handler and scope between here and the target loop (ctx).
  private emitAbrupt(ctx: LoopCtx, targetLabel: Label, targetScopeDepth: number): void {
    const crossed = this.fn.handlers.slice(ctx.handlerLen)
    const outerFinally = crossed.find((h) => h.kind === 'finally')
    if (!outerFinally) {
      // simple case: no finally in the way. Pop catch handlers, exit scopes,
      // then jump straight to the target.
      for (let i = 0; i < crossed.length; i++) this.emit('POP_HANDLER')
      let d = this.fn.scopeDepth
      while (d > targetScopeDepth) { this.emit('EXIT_SCOPE'); d-- }
      this.emitJump('JMP', targetLabel)
      return
    }
    // A finally is crossed: route the jump through the finally chain at runtime
    // (each finally runs at its own try-scope), landing at a trampoline that
    // exits the scopes left over between the OUTERMOST crossed finally's
    // try-scope and the target loop's scope, then jumps to the target. `stop`
    // is the handler depth the runtime unwinds down to.
    const tuple = { target: -1, stop: ctx.handlerLen }
    const cidx = this.consts.length
    this.consts.push(tuple)
    this.emit('ABRUPT_JUMP', cidx)
    const lTramp = this.newLabel()
    this.place(lTramp)
    tuple.target = lTramp.pos
    for (let d = outerFinally.scopeDepth; d > targetScopeDepth; d--) this.emit('EXIT_SCOPE')
    this.emitJump('JMP', targetLabel)
  }

  private compileBreak(node: any): void {
    const ctx = this.findLoop(node.label ? node.label.name : null, false)
    this.emitAbrupt(ctx, ctx.brk, ctx.brkScopeDepth)
  }

  private compileContinue(node: any): void {
    const ctx = this.findLoop(node.label ? node.label.name : null, true)
    this.emitAbrupt(ctx, ctx.cont!, ctx.scopeDepth)
  }

  private compileLabeled(node: any): void {
    const b = node.body
    if (b.type === 'WhileStatement' || b.type === 'DoWhileStatement' || b.type === 'ForStatement' ||
        b.type === 'ForOfStatement' || b.type === 'ForInStatement') {
      this.fn.pendingLabel = node.label.name
      this.compileStatement(b, false)
      return
    }
    // labeled non-loop: break <label> jumps past it.
    const lEnd = this.newLabel()
    const ctx: LoopCtx = { kind: 'label', label: node.label.name, brk: lEnd, cont: null, scopeDepth: this.fn.scopeDepth, brkScopeDepth: this.fn.scopeDepth, handlerLen: this.fn.handlers.length }
    this.fn.loops.push(ctx)
    this.compileStatement(b, false)
    this.fn.loops.pop()
    this.place(lEnd)
  }

  private compileSwitch(node: any): void {
    this.enterScope()
    const discAddr = this.declTemp()
    this.compileExpr(node.discriminant)
    this.emit('INIT_SLOT', discAddr)
    const lEnd = this.newLabel()
    const caseLabels = node.cases.map(() => this.newLabel())
    let defaultIdx = -1
    // dispatch
    node.cases.forEach((c: any, i: number) => {
      if (c.test) {
        this.emit('LOAD_SLOT', discAddr)
        this.compileExpr(c.test)
        this.emit('SEQ')
        this.emitJump('JMP_IF_TRUE', caseLabels[i])
      } else {
        defaultIdx = i
      }
    })
    if (defaultIdx >= 0) this.emitJump('JMP', caseLabels[defaultIdx])
    else this.emitJump('JMP', lEnd)
    // bodies
    const ctx: LoopCtx = { kind: 'switch', label: null, brk: lEnd, cont: null, scopeDepth: this.fn.scopeDepth, brkScopeDepth: this.fn.scopeDepth, handlerLen: this.fn.handlers.length }
    this.fn.loops.push(ctx)
    node.cases.forEach((c: any, i: number) => {
      this.place(caseLabels[i])
      this.compileBlockBody(c.consequent, false)
    })
    this.fn.loops.pop()
    this.place(lEnd)
    this.exitScope()
  }

  private compileTry(node: any): void {
    if (node.finalizer) {
      const lFin = this.newLabel(); const lAfter = this.newLabel()
      this.emitJump('PUSH_FINALLY', lFin); this.fn.handlers.push({ kind: 'finally', scopeDepth: this.fn.scopeDepth })
      if (node.handler) this.compileTryCatch(node.block, node.handler)
      else this.compileScopedBlock(node.block)
      this.emit('POP_HANDLER'); this.fn.handlers.pop()
      this.emit('PUSH_COMPLETION_NORMAL')
      this.emitJump('JMP', lFin)
      this.place(lFin)
      this.compileScopedBlock(node.finalizer)
      this.emitJump('END_FINALLY', lAfter)
      this.place(lAfter)
    } else {
      if (!node.handler) throw new ShieldCompileError('try without catch or finally')
      this.compileTryCatch(node.block, node.handler)
    }
  }

  private compileScopedBlock(block: any): void {
    this.enterScope()
    this.compileBlockBody(block.body, false)
    this.exitScope()
  }

  private compileTryCatch(block: any, handler: any): void {
    const lCatch = this.newLabel(); const lEnd = this.newLabel()
    this.emitJump('PUSH_HANDLER', lCatch); this.fn.handlers.push({ kind: 'catch', scopeDepth: this.fn.scopeDepth })
    this.compileScopedBlock(block)
    this.emit('POP_HANDLER'); this.fn.handlers.pop()
    this.emitJump('JMP', lEnd)
    this.place(lCatch)
    // exception value is on the stack (pushed by the runtime unwinder)
    this.enterScope(); this.fn.scopeDepth // scopeDepth already ++ by enterScope
    if (handler.param) {
      this.declareNames(handler.param, 'let')
      if (handler.param.type === 'Identifier') this.emitInitName(handler.param.name)
      else this.destructure(handler.param, (t) => this.emitInitName(t.name))
    } else {
      this.emit('POP')
    }
    this.compileBlockBody(handler.body.body, false)
    this.exitScope()
    this.place(lEnd)
  }

  // ---- expressions ----
  private compileExpr(node: any): void {
    switch (node.type) {
      case 'Literal': return this.compileLiteral(node)
      case 'Identifier': this.emitLoadName(node.name); return
      case 'ThisExpression': this.emit('PUSH_THIS'); return
      case 'TemplateLiteral': return this.compileTemplate(node)
      case 'TaggedTemplateExpression': throw new ShieldUnsupported('tagged templates not supported')
      case 'ArrayExpression': return this.compileArray(node)
      case 'ObjectExpression': return this.compileObject(node)
      case 'FunctionExpression': {
        if (node.generator) throw new ShieldUnsupported('generators not supported')
        if (node.id) {
          // Named function expression: the name is bound to the function
          // itself inside a wrapper scope the closure captures.
          this.enterScope()
          this.emitDeclare(node.id.name, 2)
          const idx = this.compileFunctionLike({ params: node.params, body: node.body.body, isBlockBody: true, isAsync: !!node.async, isArrow: false, isMain: false, name: node.id.name })
          this.emit('MAKE_FUNC', idx)
          this.emit('DUP'); this.emitInitName(node.id.name)
          this.exitScope()
          return
        }
        const idx = this.compileFunctionLike({ params: node.params, body: node.body.body, isBlockBody: true, isAsync: !!node.async, isArrow: false, isMain: false, name: null })
        this.emit('MAKE_FUNC', idx); return
      }
      case 'ArrowFunctionExpression': {
        const isBlock = node.body.type === 'BlockStatement'
        const idx = this.compileFunctionLike({ params: node.params, body: isBlock ? node.body.body : node.body, isBlockBody: isBlock, isAsync: !!node.async, isArrow: true, isMain: false, name: null })
        this.emit('MAKE_FUNC', idx); return
      }
      case 'UnaryExpression': return this.compileUnary(node)
      case 'UpdateExpression': return this.compileUpdate(node)
      case 'BinaryExpression': return this.compileBinary(node)
      case 'LogicalExpression': return this.compileLogical(node)
      case 'AssignmentExpression': return this.compileAssign(node)
      case 'ConditionalExpression': {
        const lElse = this.newLabel(); const lEnd = this.newLabel()
        this.compileExpr(node.test); this.emitJump('JMP_IF_FALSE', lElse)
        this.compileExpr(node.consequent); this.emitJump('JMP', lEnd)
        this.place(lElse); this.compileExpr(node.alternate); this.place(lEnd)
        return
      }
      case 'SequenceExpression': {
        for (let i = 0; i < node.expressions.length; i++) {
          this.compileExpr(node.expressions[i])
          if (i < node.expressions.length - 1) this.emit('POP')
        }
        return
      }
      case 'CallExpression': return this.compileCall(node)
      case 'NewExpression': return this.compileNew(node)
      case 'MemberExpression': return this.compileMember(node)
      case 'ChainExpression': {
        const end = this.newLabel(); const prev = this.chainEnd; this.chainEnd = end
        this.compileExpr(node.expression)
        this.chainEnd = prev; this.place(end); return
      }
      case 'AwaitExpression': {
        this.compileExpr(node.argument)
        if (this.fn.isAsync) this.emit('AWAIT')
        else if (this.fn.isMain) this.emit('AWAIT_TOP')   // top-level await (module)
        else throw new ShieldCompileError('await outside async function')
        return
      }
      case 'MetaProperty': {
        if (node.meta && node.meta.name === 'new' && node.property && node.property.name === 'target') {
          this.emit('LOAD_NEW_TARGET'); return
        }
        if (node.meta && node.meta.name === 'import' && node.property && node.property.name === 'meta') {
          this.emit('IMPORT_META'); return
        }
        throw new ShieldUnsupported('unsupported meta property')
      }
      case 'ImportExpression': {
        // dynamic import(specifier) -> Promise<namespace>. Specifier resolved by
        // the loader relative to this module. When the arg is a literal the
        // plugin can pre-map it to a module id; otherwise the string flows to
        // the loader's runtime resolver.
        let specVal: string | null = null
        if (node.source && node.source.type === 'Literal' && typeof node.source.value === 'string') specVal = node.source.value
        else if (node.source && node.source.type === 'TemplateLiteral' && node.source.expressions.length === 0) specVal = node.source.quasis[0].value.cooked
        if (specVal != null && this.moduleDesc) {
          if (this.moduleDesc.dynSources.indexOf(specVal) < 0) this.moduleDesc.dynSources.push(specVal)
        } else if (this.moduleDesc) {
          // computed/non-static dynamic import: the target can't be statically
          // mapped to a module id. Flag so the plugin can keep this chunk native
          // (a computed import of a mangled/removed VM artifact would 404).
          this.moduleDesc.hasComputedDynImport = true
        }
        this.compileExpr(node.source)
        this.emit('DYNAMIC_IMPORT'); return
      }
      case 'YieldExpression': throw new ShieldUnsupported('generators not supported')
      case 'ClassExpression': return this.compileClass(node)
      case 'ParenthesizedExpression': return this.compileExpr(node.expression)
      default:
        throw new ShieldUnsupported(`expression ${node.type} not supported`)
    }
  }

  // The const-pool index for a Literal node's value (mirrors compileLiteral's
  // encoding, but returns the index instead of emitting PUSH_CONST). Used by
  // fused ops that carry a literal value as a const-pool reference.
  private literalConstIndex(node: any): number {
    if (node.regex) return this.addRegex(node.regex.pattern, node.regex.flags)
    if (typeof node.value === 'bigint' || node.bigint) return this.addBigInt(node.bigint ?? String(node.value))
    return this.addConst(node.value)
  }

  private compileLiteral(node: any): void {
    if (node.regex) { this.emit('PUSH_CONST', this.addRegex(node.regex.pattern, node.regex.flags)); return }
    if (typeof node.value === 'bigint' || node.bigint) {
      this.emit('PUSH_CONST', this.addBigInt(node.bigint ?? String(node.value)))
      return
    }
    const v = node.value
    if (v === null) { this.emit('PUSH_NULL'); return }
    if (v === true) { this.emit('PUSH_TRUE'); return }
    if (v === false) { this.emit('PUSH_FALSE'); return }
    this.emit('PUSH_CONST', this.addConst(v))
  }

  private compileTemplate(node: any): void {
    const quasis = node.quasis; const exprs = node.expressions
    this.emit('PUSH_CONST', this.addConst(quasis[0].value.cooked))
    for (let i = 0; i < exprs.length; i++) {
      this.compileExpr(exprs[i]); this.emit('ADD')
      this.emit('PUSH_CONST', this.addConst(quasis[i + 1].value.cooked)); this.emit('ADD')
    }
  }

  private compileArray(node: any): void {
    this.emit('ARR_EMPTY')
    for (const el of node.elements) {
      if (el === null) { this.emit('PUSH_UNDEF'); this.emit('ARR_APPEND') } // hole -> undefined (documented)
      else if (el.type === 'SpreadElement') { this.compileExpr(el.argument); this.emit('ARR_SPREAD') }
      else { this.compileExpr(el); this.emit('ARR_APPEND') }
    }
  }

  private staticKey(node: any): string {
    if (node.type === 'Identifier') return node.name
    if (node.type === 'Literal') return String(node.value)
    throw new ShieldUnsupported('unsupported property key')
  }

  private compileObject(node: any): void {
    this.emit('OBJ_EMPTY')
    for (const pr of node.properties) {
      if (pr.type === 'SpreadElement') { this.compileExpr(pr.argument); this.emit('OBJ_SPREAD'); continue }
      if (pr.kind === 'get' || pr.kind === 'set') {
        if (pr.computed) throw new ShieldUnsupported('computed getter/setter keys not supported')
        const idx = this.compileFunctionLike({ params: pr.value.params, body: pr.value.body.body, isBlockBody: true, isAsync: !!pr.value.async, isArrow: false, isMain: false, name: null })
        this.emit('MAKE_FUNC', idx)
        this.emit(pr.kind === 'get' ? 'OBJ_DEFINE_GETTER' : 'OBJ_DEFINE_SETTER', this.addConst(this.staticKey(pr.key)))
        continue
      }
      // init / method / shorthand
      if (pr.computed) {
        this.compileExpr(pr.key)
        this.compileValueOfProp(pr)
        this.emit('OBJ_SET_DYN')
      } else {
        const key = this.staticKey(pr.key)
        // Superinstruction: `{ key: <literal> }` fuses PUSH_CONST ; OBJ_SET into
        // one op (the dominant real-bundle bigram). The value is kept in the
        // const pool by index so NaN/-0/BigInt/RegExp literals stay correct.
        if (!pr.method && pr.value && pr.value.type === 'Literal') {
          this.emit('OBJ_SET_CONST', this.addConst([key, this.literalConstIndex(pr.value)]))
        } else {
          this.compileValueOfProp(pr)
          this.emit('OBJ_SET', this.addConst(key))
        }
      }
    }
  }

  private compileValueOfProp(pr: any): void {
    if (pr.method) {
      const idx = this.compileFunctionLike({ params: pr.value.params, body: pr.value.body.body, isBlockBody: true, isAsync: !!pr.value.async, isArrow: false, isMain: false, name: null })
      this.emit('MAKE_FUNC', idx)
    } else {
      this.compileExpr(pr.value)
    }
  }

  private compileUnary(node: any): void {
    switch (node.operator) {
      case '-': this.compileExpr(node.argument); this.emit('NEG'); return
      case '+': this.compileExpr(node.argument); this.emit('POS'); return
      case '!': this.compileExpr(node.argument); this.emit('NOT'); return
      case '~': this.compileExpr(node.argument); this.emit('BNOT'); return
      case 'void': this.compileExpr(node.argument); this.emit('POP'); this.emit('PUSH_UNDEF'); return
      case 'typeof':
        if (node.argument.type === 'Identifier') { this.emitTypeofName(node.argument.name); return }
        this.compileExpr(node.argument); this.emit('TYPEOF'); return
      case 'delete': {
        const a = node.argument
        if (a.type === 'MemberExpression') {
          this.compileExpr(a.object)
          if (a.computed) { this.compileExpr(a.property); this.emit('DELETE_PROP_DYN') }
          else this.emit('DELETE_PROP', this.addConst(this.staticKey(a.property)))
          return
        }
        this.compileExpr(a); this.emit('POP'); this.emit('PUSH_TRUE'); return
      }
      default: throw new ShieldUnsupported(`unary ${node.operator} not supported`)
    }
  }

  private static BIN: Record<string, OpName> = {
    '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV', '%': 'MOD', '**': 'EXP',
    '==': 'EQ', '!=': 'NEQ', '===': 'SEQ', '!==': 'SNEQ',
    '<': 'LT', '<=': 'LTE', '>': 'GT', '>=': 'GTE',
    '&': 'BAND', '|': 'BOR', '^': 'BXOR', '<<': 'SHL', '>>': 'SHR', '>>>': 'USHR',
    'instanceof': 'INSTANCEOF', 'in': 'IN',
  }

  private compileBinary(node: any): void {
    if (node.operator === 'in' && node.left.type === 'PrivateIdentifier') {
      // #x in obj -> brand check
      this.compileExpr(node.right)
      this.emit('HAS_PRIVATE', this.addConst('#' + node.left.name))
      return
    }
    const op = Compiler.BIN[node.operator]
    if (!op) throw new ShieldUnsupported(`binary ${node.operator} not supported`)
    this.compileExpr(node.left)
    this.compileExpr(node.right)
    this.emit(op)
  }

  private compileLogical(node: any): void {
    const lEnd = this.newLabel()
    this.compileExpr(node.left)
    if (node.operator === '&&') this.emitJump('JMP_IF_FALSY_KEEP', lEnd)
    else if (node.operator === '||') this.emitJump('JMP_IF_TRUTHY_KEEP', lEnd)
    else this.emitJump('JMP_IF_NOT_NULLISH_KEEP', lEnd)
    this.compileExpr(node.right)
    this.place(lEnd)
  }

  private compileUpdate(node: any): void {
    const prefix = node.prefix
    const delta = node.operator === '++' ? 1 : -1
    const arg = node.argument
    if (arg.type === 'Identifier') {
      this.emitLoadName(arg.name); this.emit('POS')
      if (prefix) {
        this.emit('PUSH_CONST', this.addConst(delta)); this.emit('ADD')
        this.emitStoreName(arg.name)   // leaves new value
      } else {
        // postfix: result is old
        this.emit('DUP')
        this.emit('PUSH_CONST', this.addConst(delta)); this.emit('ADD')
        this.emitStoreName(arg.name); this.emit('POP')   // store new, discard it; old remains
      }
      return
    }
    if (arg.type === 'MemberExpression' && arg.property && arg.property.type === 'PrivateIdentifier') {
      const pn = this.addConst('#' + arg.property.name)
      const tmpO = this.declTemp()
      this.compileExpr(arg.object); this.emit('INIT_SLOT', tmpO)
      this.emit('LOAD_SLOT', tmpO); this.emit('GET_PRIVATE', pn); this.emit('POS')
      const tmpOld = this.declTemp()
      this.emit('DUP'); this.emit('INIT_SLOT', tmpOld)
      this.emit('PUSH_CONST', this.addConst(delta)); this.emit('ADD')
      this.emit('LOAD_SLOT', tmpO); this.emit('SWAP'); this.emit('SET_PRIVATE', pn); this.emit('POP')
      if (prefix) { this.emit('LOAD_SLOT', tmpOld); this.emit('PUSH_CONST', this.addConst(delta)); this.emit('ADD') }
      else this.emit('LOAD_SLOT', tmpOld)
      return
    }
    if (arg.type === 'MemberExpression') {
      // stash object (and key) in temps, read old, write new.
      const tmpO = this.declTemp()
      this.compileExpr(arg.object); this.emit('INIT_SLOT', tmpO)
      let tmpK = -1
      if (arg.computed) { tmpK = this.declTemp(); this.compileExpr(arg.property); this.emit('INIT_SLOT', tmpK) }
      // read old
      this.emit('LOAD_SLOT', tmpO)
      if (arg.computed) { this.emit('LOAD_SLOT', tmpK); this.emit('GET_PROP_DYN') }
      else this.emit('GET_PROP', this.addConst(this.staticKey(arg.property)))
      this.emit('POS')
      const tmpOld = this.declTemp()
      this.emit('DUP'); this.emit('INIT_SLOT', tmpOld)
      this.emit('PUSH_CONST', this.addConst(delta)); this.emit('ADD')  // new value on stack
      // write: set obj[key] = new
      this.emit('LOAD_SLOT', tmpO)
      if (arg.computed) { this.emit('LOAD_SLOT', tmpK); this.emit('ROTL3'); this.emit('SET_PROP_DYN') }
      else { this.emit('SWAP'); this.emit('SET_PROP', this.addConst(this.staticKey(arg.property))) }
      this.emit('POP') // discard new value left by SET_PROP
      if (prefix) { this.emit('LOAD_SLOT', tmpOld); this.emit('PUSH_CONST', this.addConst(delta)); this.emit('ADD') }
      else this.emit('LOAD_SLOT', tmpOld)
      return
    }
    throw new ShieldUnsupported('update on this target not supported')
  }

  private applyDefault(defaultExpr: any): void {
    // value on stack: if === undefined, replace with default
    const lHave = this.newLabel()
    this.emit('DUP'); this.emit('PUSH_UNDEF'); this.emit('SEQ')
    this.emitJump('JMP_IF_FALSE', lHave)   // not undefined -> keep value
    this.emit('POP'); this.compileExpr(defaultExpr)
    this.place(lHave)
  }

  private compileAssign(node: any): void {
    const op = node.operator
    const left = node.left
    if (op === '=') {
      if (left.type === 'Identifier') { this.compileExpr(node.right); this.emitStoreName(left.name); return }
      if (left.type === 'MemberExpression') {
        if (left.object.type === 'Super') {
          if (left.computed) { this.compileExpr(left.property); this.compileExpr(node.right); this.emit('SUPER_SET_DYN') }
          else { this.compileExpr(node.right); this.emit('SUPER_SET', this.addConst(this.staticKey(left.property))) }
          return
        }
        this.compileExpr(left.object)
        if (left.property && left.property.type === 'PrivateIdentifier') {
          this.compileExpr(node.right); this.emit('SET_PRIVATE', this.addConst('#' + left.property.name)); return
        }
        if (left.computed) { this.compileExpr(left.property); this.compileExpr(node.right); this.emit('SET_PROP_DYN') }
        else { this.compileExpr(node.right); this.emit('SET_PROP', this.addConst(this.staticKey(left.property))) }
        return
      }
      if (left.type === 'ArrayPattern' || left.type === 'ObjectPattern') {
        this.compileExpr(node.right)
        this.emit('DUP')   // keep the rhs value as the expression result
        this.destructure(left, (t) => this.storeToTarget(t))
        return
      }
      throw new ShieldUnsupported('assignment target not supported')
    }
    // logical assignment
    if (op === '&&=' || op === '||=' || op === '??=') {
      const shortJump: OpName = op === '&&=' ? 'JMP_IF_FALSY_KEEP' : op === '||=' ? 'JMP_IF_TRUTHY_KEEP' : 'JMP_IF_NOT_NULLISH_KEEP'
      if (left.type === 'Identifier') {
        const lEnd = this.newLabel()
        this.emitLoadName(left.name)
        this.emitJump(shortJump, lEnd)
        this.emit('POP'); this.compileExpr(node.right); this.emitStoreName(left.name)
        this.place(lEnd)
        return
      }
      if (left.type === 'MemberExpression' && !(left.property && left.property.type === 'PrivateIdentifier')) {
        // obj.x ??=/||=/&&= y  - evaluate obj (and key) once, read current, and
        // only assign when the short-circuit condition is not met.
        const tmpO = this.declTemp()
        this.compileExpr(left.object); this.emit('INIT_SLOT', tmpO)
        let tmpK = -1
        if (left.computed) { tmpK = this.declTemp(); this.compileExpr(left.property); this.emit('INIT_SLOT', tmpK) }
        this.emit('LOAD_SLOT', tmpO)
        if (left.computed) { this.emit('LOAD_SLOT', tmpK); this.emit('GET_PROP_DYN') }
        else this.emit('GET_PROP', this.addConst(this.staticKey(left.property)))
        const lEnd = this.newLabel()
        this.emitJump(shortJump, lEnd)   // keeps current value + jumps when assignment is skipped
        this.emit('POP'); this.compileExpr(node.right)   // [rhs]
        this.emit('LOAD_SLOT', tmpO)
        if (left.computed) { this.emit('LOAD_SLOT', tmpK); this.emit('ROTL3'); this.emit('SET_PROP_DYN') }
        else { this.emit('SWAP'); this.emit('SET_PROP', this.addConst(this.staticKey(left.property))) }
        this.place(lEnd)
        return
      }
      throw new ShieldUnsupported('logical assignment on this target not supported')
    }
    // compound assignment (+=, -=, ...)
    const binOp = Compiler.BIN[op.slice(0, -1)]
    if (!binOp) throw new ShieldUnsupported(`compound assignment ${op} not supported`)
    if (left.type === 'Identifier') {
      this.emitLoadName(left.name); this.compileExpr(node.right); this.emit(binOp); this.emitStoreName(left.name)
      return
    }
    if (left.type === 'MemberExpression' && left.property && left.property.type === 'PrivateIdentifier') {
      const pn = this.addConst('#' + left.property.name)
      const tmpO = this.declTemp()
      this.compileExpr(left.object); this.emit('INIT_SLOT', tmpO)
      this.emit('LOAD_SLOT', tmpO); this.emit('GET_PRIVATE', pn)
      this.compileExpr(node.right); this.emit(binOp)   // new value on stack
      this.emit('LOAD_SLOT', tmpO); this.emit('SWAP'); this.emit('SET_PRIVATE', pn)
      return
    }
    if (left.type === 'MemberExpression') {
      const tmpO = this.declTemp()
      this.compileExpr(left.object); this.emit('INIT_SLOT', tmpO)
      let tmpK = -1
      if (left.computed) { tmpK = this.declTemp(); this.compileExpr(left.property); this.emit('INIT_SLOT', tmpK) }
      this.emit('LOAD_SLOT', tmpO)
      if (left.computed) { this.emit('LOAD_SLOT', tmpK); this.emit('GET_PROP_DYN') }
      else this.emit('GET_PROP', this.addConst(this.staticKey(left.property)))
      this.compileExpr(node.right); this.emit(binOp)   // new value on stack
      this.emit('LOAD_SLOT', tmpO)
      if (left.computed) { this.emit('LOAD_SLOT', tmpK); this.emit('ROTL3'); this.emit('SET_PROP_DYN') }
      else { this.emit('SWAP'); this.emit('SET_PROP', this.addConst(this.staticKey(left.property))) }
      return
    }
    throw new ShieldUnsupported('compound assignment target not supported')
  }

  // Store the value on TOS to a target, consuming it (leaves nothing).
  private storeToTarget(target: any): void {
    if (target.type === 'AssignmentPattern') {
      this.applyDefault(target.right)
      this.storeToTarget(target.left)
      return
    }
    if (target.type === 'Identifier') { this.emitStoreName(target.name); this.emit('POP'); return }
    if (target.type === 'MemberExpression') {
      const tmp = this.declTemp()
      this.emit('INIT_SLOT', tmp)  // stash value
      this.compileExpr(target.object)
      if (target.computed) { this.compileExpr(target.property); this.emit('LOAD_SLOT', tmp); this.emit('SET_PROP_DYN') }
      else { this.emit('LOAD_SLOT', tmp); this.emit('SET_PROP', this.addConst(this.staticKey(target.property))) }
      this.emit('POP')
      return
    }
    if (target.type === 'ArrayPattern' || target.type === 'ObjectPattern') {
      this.destructure(target, (t) => this.storeToTarget(t))
      return
    }
    throw new ShieldUnsupported('destructuring target not supported')
  }

  // value on stack; if a pattern, recurse; else call onLeaf(target) which
  // consumes the value.
  private bindTarget(target: any, onLeaf: (t: any) => void): void {
    if (target.type === 'ArrayPattern' || target.type === 'ObjectPattern') this.destructure(target, onLeaf)
    else onLeaf(target)
  }

  // value on stack -> destructure into the pattern, consuming the value.
  private destructure(pattern: any, onLeaf: (t: any) => void): void {
    if (pattern.type === 'ArrayPattern') {
      this.emit('GET_ITERATOR')
      for (const el of pattern.elements) {
        if (el === null) { this.emit('ITER_NEXT_PUSH'); this.emit('POP'); continue }
        if (el.type === 'RestElement') { this.emit('ITER_REST_PUSH'); this.bindTarget(el.argument, onLeaf); continue }
        this.emit('ITER_NEXT_PUSH')
        let target = el
        if (el.type === 'AssignmentPattern') { this.applyDefault(el.right); target = el.left }
        this.bindTarget(target, onLeaf)
      }
      this.emit('POP') // iterator
      return
    }
    if (pattern.type === 'ObjectPattern') {
      const props = pattern.properties
      const hasRest = props.length > 0 && props[props.length - 1].type === 'RestElement'
      const hasComputed = props.some((pr: any) => pr.type !== 'RestElement' && pr.computed)
      if (hasRest && hasComputed) { this.destructureObjectWithRestDynamic(props, onLeaf); return }
      const excluded: string[] = []
      for (let i = 0; i < props.length; i++) {
        const pr = props[i]
        if (pr.type === 'RestElement') {
          this.emit('OBJ_REST', this.addConst(JSON.stringify(excluded)))  // consumes source
          this.bindTarget(pr.argument, onLeaf)
          return
        }
        this.emit('DUP') // source
        if (pr.computed) {
          this.compileExpr(pr.key); this.emit('GET_PROP_DYN')
        } else {
          const key = this.staticKey(pr.key)
          excluded.push(key)
          this.emit('GET_PROP', this.addConst(key))
        }
        let target = pr.value
        if (target.type === 'AssignmentPattern') { this.applyDefault(target.right); target = target.left }
        this.bindTarget(target, onLeaf)
      }
      this.emit('POP') // source (no rest)
      return
    }
    throw new ShieldUnsupported(`destructure ${pattern.type} not supported`)
  }

  // Object destructuring with a computed key before `...rest`: the excluded-key
  // set must be built at runtime (static keys + evaluated computed keys).
  private destructureObjectWithRestDynamic(props: any[], onLeaf: (t: any) => void): void {
    // stack: [source]
    const exc = this.declTemp()
    this.emit('ARR_EMPTY'); this.emit('INIT_SLOT', exc)
    for (const pr of props) {
      if (pr.type === 'RestElement') {
        this.emit('LOAD_SLOT', exc)
        this.emit('OBJ_REST_DYN')   // pops [source, excluded] -> rest
        this.bindTarget(pr.argument, onLeaf)
        return
      }
      const keyTmp = this.declTemp()
      if (pr.computed) this.compileExpr(pr.key)
      else this.emit('PUSH_CONST', this.addConst(this.staticKey(pr.key)))
      this.emit('INIT_SLOT', keyTmp)
      this.emit('LOAD_SLOT', exc); this.emit('LOAD_SLOT', keyTmp); this.emit('ARR_APPEND'); this.emit('POP')
      this.emit('DUP'); this.emit('LOAD_SLOT', keyTmp); this.emit('GET_PROP_DYN')
      let target = pr.value
      if (target.type === 'AssignmentPattern') { this.applyDefault(target.right); target = target.left }
      this.bindTarget(target, onLeaf)
    }
    this.emit('POP')
  }

  private hasSpread(args: any[]): boolean { return args.some((a) => a.type === 'SpreadElement') }

  private buildArgsArray(args: any[]): void {
    this.emit('ARR_EMPTY')
    for (const a of args) {
      if (a.type === 'SpreadElement') { this.compileExpr(a.argument); this.emit('ARR_SPREAD') }
      else { this.compileExpr(a); this.emit('ARR_APPEND') }
    }
  }

  private compileCall(node: any): void {
    const callee = node.callee
    if (callee.type === 'Super') {
      // super(...) inside a derived constructor
      if (this.hasSpread(node.arguments)) { this.buildArgsArray(node.arguments); this.emit('SUPER_CALL_APPLY') }
      else { for (const a of node.arguments) this.compileExpr(a); this.emit('SUPER_CALL', node.arguments.length) }
      return
    }
    if (callee.type === 'MemberExpression') {
      if (callee.object.type === 'Super') {
        // super.m(args): receiver is `this`, function from super prototype
        this.emit('PUSH_THIS')
        if (callee.computed) { this.compileExpr(callee.property); this.emit('SUPER_GET_DYN') }
        else this.emit('SUPER_GET', this.addConst(this.staticKey(callee.property)))
        if (this.hasSpread(node.arguments)) { this.buildArgsArray(node.arguments); this.emit('CALL_METHOD_APPLY') }
        else { for (const a of node.arguments) this.compileExpr(a); this.emit('CALL_METHOD', node.arguments.length) }
        return
      }
      // Superinstruction: `ident.method(...)` receiver fuses LOAD;DUP;GET_PROP.
      if (!callee.optional && !callee.computed && callee.object.type === 'Identifier' &&
          callee.property && callee.property.type !== 'PrivateIdentifier') {
        this.emitFusedMemberLoad(callee.object.name, this.staticKey(callee.property), true)
      } else {
        this.compileExpr(callee.object)
        if (callee.optional) {
          if (!this.chainEnd) throw new ShieldCompileError('internal: optional outside chain')
          this.emitJump('OPT_SHORT', this.chainEnd)
        }
        this.emit('DUP')
        if (callee.property && callee.property.type === 'PrivateIdentifier') {
          this.emit('GET_PRIVATE', this.addConst('#' + callee.property.name))
        } else if (callee.computed) { this.compileExpr(callee.property); this.emit('GET_PROP_DYN') }
        else this.emit('GET_PROP', this.addConst(this.staticKey(callee.property)))
      }
      if (node.optional) {
        // obj.m?.(args): if the method is nullish, short-circuit the chain.
        if (!this.chainEnd) throw new ShieldCompileError('internal: optional call outside chain')
        this.emitJump('OPT_SHORT_CALL', this.chainEnd)
      }
      if (this.hasSpread(node.arguments)) { this.buildArgsArray(node.arguments); this.emit('CALL_METHOD_APPLY') }
      else { for (const a of node.arguments) this.compileExpr(a); this.emit('CALL_METHOD', node.arguments.length) }
      return
    }
    this.compileExpr(callee)
    if (node.optional) {
      if (!this.chainEnd) throw new ShieldCompileError('internal: optional outside chain')
      this.emitJump('OPT_SHORT', this.chainEnd)
    }
    if (this.hasSpread(node.arguments)) { this.buildArgsArray(node.arguments); this.emit('CALL_APPLY') }
    else { for (const a of node.arguments) this.compileExpr(a); this.emit('CALL', node.arguments.length) }
  }

  private compileNew(node: any): void {
    this.compileExpr(node.callee)
    if (this.hasSpread(node.arguments)) { this.buildArgsArray(node.arguments); this.emit('NEW_APPLY') }
    else { for (const a of node.arguments) this.compileExpr(a); this.emit('NEW', node.arguments.length) }
  }

  private compileMember(node: any): void {
    if (node.object.type === 'Super') {
      // super.x / super[e] -> Reflect.get(proto-of-home, key, this)
      if (node.computed) { this.compileExpr(node.property); this.emit('SUPER_GET_DYN') }
      else this.emit('SUPER_GET', this.addConst(this.staticKey(node.property)))
      return
    }
    // Superinstruction: `ident.key` (plain identifier base, static key, no
    // optional short-circuit) fuses the load + property into one op.
    if (!node.optional && !node.computed && node.object.type === 'Identifier' &&
        node.property && node.property.type !== 'PrivateIdentifier') {
      this.emitFusedMemberLoad(node.object.name, this.staticKey(node.property), false)
      return
    }
    this.compileExpr(node.object)
    if (node.optional) {
      if (!this.chainEnd) throw new ShieldCompileError('internal: optional outside chain')
      this.emitJump('OPT_SHORT', this.chainEnd)
    }
    if (node.property && node.property.type === 'PrivateIdentifier') {
      this.emit('GET_PRIVATE', this.addConst('#' + node.property.name)); return
    }
    if (node.computed) { this.compileExpr(node.property); this.emit('GET_PROP_DYN') }
    else this.emit('GET_PROP', this.addConst(this.staticKey(node.property)))
  }

  // ---- classes ----
  private compileFieldInit(valueExpr: any): number {
    // zero-param function whose return value is the field's initial value, run
    // with `this` bound to the instance (or the class, for static fields).
    return this.compileFunctionLike({
      params: [], body: valueExpr, isBlockBody: false,
      isAsync: false, isArrow: false, isMain: false, name: null,
    })
  }

  private compileMethodFn(fnNode: any): number {
    if (fnNode.generator) throw new ShieldUnsupported('generator methods not supported')
    return this.compileFunctionLike({
      params: fnNode.params, body: fnNode.body.body, isBlockBody: true,
      isAsync: !!fnNode.async, isArrow: false, isMain: false, name: null,
    })
  }

  private compileClass(node: any): void {
    const body = node.body.body
    const members: any[] = []
    const computedKeyExprs: any[] = []
    const privNames: string[] = []
    let ctorIndex: number | null = null

    // Named class expression: the name is const-bound inside a wrapper scope so
    // the class body (methods) can reference it. The wrapper compile scope must
    // be active WHILE compiling the methods, and its runtime ENTER_SCOPE must
    // run before BUILD_CLASS; the compile push happens here, the op below.
    const named = node.type === 'ClassExpression' && !!node.id
    let nameSlot = -1
    if (named) { this.pushScope(); nameSlot = this.declareSlot(node.id.name) }

    for (const m of body) {
      if (m.type === 'StaticBlock') throw new ShieldUnsupported('class static blocks not supported')
      if (m.key && m.key.type === 'PrivateIdentifier') {
        const pn = '#' + m.key.name
        if (privNames.indexOf(pn) < 0) privNames.push(pn)
      }
      const isField = m.type === 'PropertyDefinition'
      const isCtor = !isField && m.kind === 'constructor'
      let key: string | null = null
      let priv: string | null = null
      let computed = false
      let computedIndex = -1
      if (m.key && m.key.type === 'PrivateIdentifier') priv = '#' + m.key.name
      else if (m.computed) { computed = true; computedIndex = computedKeyExprs.length; computedKeyExprs.push(m.key) }
      else key = this.staticKey(m.key)

      if (isCtor) { ctorIndex = this.compileMethodFn(m.value); continue }
      if (isField) {
        const fn = m.value != null ? this.compileFieldInit(m.value) : null
        members.push({ kind: 'field', static: !!m.static, private: !!priv, key, priv, computed, computedIndex, fn })
      } else {
        const kind = m.kind === 'get' ? 'get' : m.kind === 'set' ? 'set' : 'method'
        const fn = this.compileMethodFn(m.value)
        members.push({ kind, static: !!m.static, private: !!priv, key, priv, computed, computedIndex, fn })
      }
    }

    const desc = {
      name: node.id ? node.id.name : null,
      hasSuper: !!node.superClass,
      ctor: ctorIndex,
      members,
      privNames,
    }
    if (named) {
      // runtime wrapper scope (compile scope already pushed above); create the
      // TDZ const cell for the class name at the already-assigned slot.
      this.emit('ENTER_SCOPE'); this.fn.scopeDepth++
      this.emit('DECLARE_SLOT', (nameSlot << 2) | 2)
    }
    if (node.superClass) this.compileExpr(node.superClass); else this.emit('PUSH_UNDEF')
    this.emit('ARR_EMPTY')
    for (const ke of computedKeyExprs) { this.compileExpr(ke); this.emit('ARR_APPEND') }
    this.emit('BUILD_CLASS', this.addConst(JSON.stringify(desc)))
    if (named) {
      this.emit('DUP'); this.emit('INIT_SLOT', (0 << 16) | nameSlot)
      this.emit('EXIT_SCOPE'); this.fn.scopeDepth--; this.popScope()
    }
  }
}

export function compile(source: string, options: CompileOptions = {}): CompileResult {
  const seed = options.seed ?? Math.floor(Math.random() * 0xffffffff)
  return new Compiler(seed).compile(source)
}

// Serialize + authenticated-encrypt a program with a fresh per-chunk key
// (XChaCha20-Poly1305, nonce(24) || ciphertext+tag). Exposed so the Vite plugin
// can bake resolved dep-maps into program.module before encrypting.
export function encryptProgram(program: ShieldProgram): { key: Uint8Array; encrypted: Uint8Array } {
  const json = JSON.stringify(program)
  const bytes = new TextEncoder().encode(json)
  const key = randomBytes(32)
  const nonce = randomBytes(24)
  const ct = xchacha20poly1305(key, nonce).encrypt(bytes)
  const encrypted = new Uint8Array(nonce.length + ct.length)
  encrypted.set(nonce, 0)
  encrypted.set(ct, nonce.length)
  return { key, encrypted }
}
