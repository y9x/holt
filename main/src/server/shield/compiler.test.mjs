// shield compiler/runtime corpus (PLAN P2/P3, decision D6: node:test).
//
// Each supported case compiles a snippet, runs it through the VM, and asserts
// the result EQUALS native strict-mode eval. Cases outside the implemented
// subset are SKIPPED (not silently passed) and listed at the bottom.
//
// Run (this Node build does NOT auto-discover a bare directory arg):
//   node --test "src/server/shield/**/*.test.mjs"

import test from 'node:test'
import assert from 'node:assert/strict'
import { compile, ShieldUnsupported, ShieldCompileError } from './compiler.ts'
import { execute } from './runtime-template.js'
import { ARITY } from './opcodes.ts'

const SEED = 0xABCDEF

// Count opcode occurrences across every function of a compiled program (used by
// the superinstruction/fusion tests to prove a fused op is actually emitted).
function opCounts(code) {
  const r = compile(code, { seed: SEED })
  const nameOf = r.program.layout.nameOf
  const counts = {}
  for (const fn of r.program.functions) {
    const c = fn.code
    let pc = 0
    while (pc < c.length) {
      const name = nameOf[c[pc]]
      counts[name] = (counts[name] || 0) + 1
      pc += 1 + (ARITY[name] || 0)
    }
  }
  return counts
}

function vmRun(code) {
  const r = compile(code, { seed: SEED })
  return execute(r.encrypted, r.key)
}
function nativeRun(code) {
  // eslint-disable-next-line no-eval
  return (0, eval)('"use strict";\n' + code)
}

// A supported case: VM result must equal native result (or both must throw).
function eq(code) {
  let nv, ne, vv, ve
  try { nv = nativeRun(code) } catch (e) { ne = e }
  try { vv = vmRun(code) } catch (e) { ve = e }
  if (ne || ve) {
    assert.ok(ne && ve, `throw mismatch for ${code}\n native=${ne && ne.message}\n vm=${ve && ve.message}`)
    if (ne instanceof Error && ve instanceof Error) {
      assert.equal(ve.constructor.name, ne.constructor.name, `error type mismatch for ${code}`)
    }
    return
  }
  assert.deepStrictEqual(vv, nv, `value mismatch for ${code}`)
}

async function eqAsync(code) {
  const nv = await nativeRun(code)
  const vv = await vmRun(code)
  assert.deepStrictEqual(vv, nv, `async value mismatch for ${code}`)
}

// ---------------------------------------------------------------------------
// arithmetic / precedence
test('arithmetic and precedence', () => {
  ;['1+2*3', '(1+2)*3', '2**3**2', '(-2)**2', '-(2**2)', '7/2', '7%3', '10-3-2',
    '1+2*3-4/2', '(5+5)/(2+3)', '0.1+0.2', '3*-2', '+"5"+1', 'NaN !== NaN', 'Infinity>1',
    '1e3+1', '0xFF', '0b1010', '5&3', '5|2', '5^1', '1<<4', '256>>2', '-1>>>28', '~5']
    .forEach(eq)
})

// comparisons / equality
test('comparisons and equality', () => {
  ;['1<2', '2<=2', '3>2', '2>=3', '1==="1"', '1=="1"', 'null==undefined', 'null===undefined',
    'NaN==NaN', '"a"<"b"', '[1]==1', '0==false', '"" == false', 'typeof 1 === "number"']
    .forEach(eq)
})

// closures
test('closures', () => {
  eq('(()=>{ function mk(){ let c=0; return ()=>++c } const f=mk(); f(); f(); return f() })()')
  eq('(()=>{ const adder=a=>b=>a+b; return adder(3)(4) })()')
  eq('(()=>{ let fns=[]; for(let i=0;i<3;i++){ (function(x){ fns.push(()=>x) })(i) } return fns.map(f=>f()).join(",") })()')
  eq('(()=>{ const o={n:10, get(){ return ()=>this.n } }; return o.get()() })()')
})

// if / while / for / do-while
test('control flow', () => {
  eq('(()=>{ let x=5; if(x>3) return "big"; else return "small" })()')
  eq('(()=>{ let s=0,i=0; while(i<10){ s+=i; i++ } return s })()')
  eq('(()=>{ let s=0; do { s++ } while(s<5); return s })()')
  eq('(()=>{ let p=1; for(let i=1;i<=5;i++) p*=i; return p })()')
  eq('(()=>{ let r=""; for(let i=0;i<5;i++){ if(i===2) continue; if(i===4) break; r+=i } return r })()')
  eq('(()=>{ let r=0; outer: for(let i=0;i<3;i++){ for(let j=0;j<3;j++){ if(j===1) continue outer; if(i===2) break outer; r++ } } return r })()')
})

// functions: declarations, expressions, arrow, default, rest
test('functions', () => {
  eq('(()=>{ function f(a,b=10){ return a+b } return f(1)+","+f(1,2) })()')
  eq('(()=>{ const f=function(...xs){ return xs.length } ; return f(1,2,3) })()')
  eq('(()=>{ const sum=(...ns)=>ns.reduce((a,b)=>a+b,0); return sum(1,2,3,4) })()')
  eq('(()=>{ function fib(n){ return n<2?n:fib(n-1)+fib(n-2) } return fib(10) })()')
  eq('(()=>{ function outer(){ return inner(); function inner(){ return 42 } } return outer() })()') // hoisting
  eq('(function f(){ return typeof f })()') // named function expression binding -> global fallback; both strict
})

// objects / arrays
test('objects and arrays', () => {
  eq('(()=>{ const o={a:1,"b":2,3:"c"}; return [o.a,o.b,o[3]].join(",") })()')
  eq('(()=>{ const a=[1,2,3]; a.push(4); return a.join("-") })()')
  eq('(()=>{ const k="x"; const o={[k]:5, [k+"y"]:6}; return o.x+o.xy })()')
  eq('(()=>{ const o={v:1, inc(){ this.v++; return this.v }}; return o.inc()+o.inc() })()')
  eq('(()=>{ const o={ get d(){ return 2 }, set d(v){ this._d=v } }; o.d=9; return o.d+o._d })()')
  eq('(()=>{ const a=[10,20,30]; return a.map((x,i)=>x+i).join(",") })()')
  eq('JSON.stringify({a:[1,2],b:{c:3}})')
  eq('Object.keys({x:1,y:2}).join(",")')
  eq('Math.max(1,5,3) + Math.min(9,2,7)')
})

// destructuring
test('destructuring', () => {
  eq('(()=>{ const [a,b]=[1,2]; return a+b })()')
  eq('(()=>{ const [a,,c]=[1,2,3]; return a+c })()')
  eq('(()=>{ const [a,...rest]=[1,2,3,4]; return a+":"+rest.join(",") })()')
  eq('(()=>{ const [a=5,b=6]=[1]; return a+b })()')
  eq('(()=>{ const {x,y}=({x:1,y:2}); return x+y })()')
  eq('(()=>{ const {x:a,y:b=9}=({x:1}); return a+b })()')
  eq('(()=>{ const {a,...rest}=({a:1,b:2,c:3}); return a+":"+JSON.stringify(rest) })()')
  eq('(()=>{ const k="b"; const {[k]:v,...rest}=({a:1,b:2,c:3}); return v+":"+JSON.stringify(rest) })()')
  eq('(()=>{ const {["a"]:x, ...r}=({a:1,b:2}); return x+":"+JSON.stringify(r) })()')
  eq('(()=>{ const {p:{q}}=({p:{q:7}}); return q })()')
  eq('(()=>{ const [{a},[b]]=[{a:1},[2]]; return a+b })()')
  eq('(()=>{ let a=0,b=0; [a,b]=[9,8]; return a-b })()')
  eq('(()=>{ const o={}; ({x:o.k}=({x:5})); return o.k })()')
  eq('(()=>{ function f({a,b=2}){ return a+b } return f({a:1}) })()')
  eq('(()=>{ function f([a,b]){ return a*b } return f([3,4]) })()')
})

// spread / rest
test('spread and rest', () => {
  eq('(()=>{ const a=[1,2]; const b=[0,...a,3]; return b.join(",") })()')
  eq('(()=>{ const a={x:1}; const b={...a,y:2}; return JSON.stringify(b) })()')
  eq('(()=>{ function f(a,b,c){ return a+b+c } const xs=[1,2,3]; return f(...xs) })()')
  eq('Math.max(...[4,8,2])')
  eq('(()=>{ const s="ab"; return [...s].join("-") })()')
  eq('(()=>{ const m=new Map([["a",1]]); return [...m].length })()')
})

// template literals
test('template literals', () => {
  eq('`a${1+2}b`')
  eq('(()=>{ const n="world"; return `hello ${n}! ${1<2 ? "yes":"no"}` })()')
  eq('`line1\nline2`')
  eq('(()=>{ const a=[1,2,3]; return `len=${a.length} sum=${a.reduce((x,y)=>x+y,0)}` })()')
})

// optional chaining
test('optional chaining', () => {
  eq('(()=>{ const a=null; return a?.b })()')
  eq('(()=>{ const a={b:{c:1}}; return a?.b?.c })()')
  eq('(()=>{ const a={b:null}; return a?.b?.c })()')
  eq('(()=>{ const a={b:[1,2,3]}; return a?.b?.[1] })()')
  eq('(()=>{ const o={f(){return 42}}; return o?.f() })()')
  eq('(()=>{ const o=null; return o?.f() })()')
  eq('(()=>{ const o={a:{b:{c:9}}}; return o?.a?.b?.c ?? -1 })()')
})

// nullish
test('nullish coalescing', () => {
  eq('null ?? "d"')
  eq('undefined ?? "d"')
  eq('0 ?? "d"')
  eq('"" ?? "d"')
  eq('false ?? "d"')
  eq('(()=>{ let x; x ??= 5; return x })()')
  eq('(()=>{ let x=1; x ??= 5; return x })()')
  eq('(()=>{ let x=0; x ||= 7; return x })()')
  eq('(()=>{ let x=1; x &&= 7; return x })()')
  // logical assignment on member expressions (common in minified bundles)
  eq('(()=>{ const o={a:null,b:2}; o.a ??= 5; o.b ??= 9; return o.a+":"+o.b })()')
  eq('(()=>{ const o={a:0}; o.a ||= 7; return o.a })()')
  eq('(()=>{ const o={a:1}; o.a &&= 7; return o.a })()')
  eq('(()=>{ const o={}; const k="x"; o[k] ??= 3; o[k] ??= 9; return o.x })()')
  eq('(()=>{ let n=0; const o={}; const next=()=>o["k"+(n++)]; o.v ??= 1; return n })()')
})

// optional call on a method (obj.m?.())
test('optional method call', () => {
  eq('(()=>{ const o={ f(){ return 42 } }; return o.f?.() })()')
  eq('(()=>{ const o={}; return o.f?.() })()')
  eq('(()=>{ const o={ g:null }; return o.g?.(1,2) ?? "nil" })()')
  eq('(()=>{ const o={ a:{ b(){ return 9 } } }; return o.a?.b?.() })()')
  eq('(()=>{ const o=null; return o?.m?.() })()')
})

// try / catch / finally
test('try/catch/finally', () => {
  eq('(()=>{ try { return 1 } catch(e){ return 2 } })()')
  eq('(()=>{ try { throw new TypeError("boom") } catch(e){ return e.constructor.name } })()')
  eq('(()=>{ try { JSON.parse("{") } catch(e){ return "caught" } })()')
  eq('(()=>{ let r=""; try{ r+="a"; throw 0 } catch { r+="b" } finally { r+="c" } return r })()')
  eq('(()=>{ let log=[]; function f(){ try{ return "try" } finally { log.push("fin") } } const v=f(); return v+":"+log.join(",") })()')
  eq('(()=>{ try { try { throw new Error("x") } finally { } } catch(e){ return e.message } })()')
  eq('(()=>{ function f(){ try { throw "E" } catch(e){ return "c:"+e } finally { } } return f() })()')
  eq('(()=>{ let order=[]; try { try { order.push(1); throw 1 } catch { order.push(2); throw 2 } finally { order.push(3) } } catch(e){ order.push("got"+e) } return order.join(",") })()')
  eq('(()=>{ const {a}=({}); try { a.b } catch(e){ return e.constructor.name } })()') // TypeError
})

// break / continue across a finally (completion-record routing + scope trampoline)
test('break/continue across finally', () => {
  // break out of a loop from inside try: finally must run, then loop exits
  eq('(()=>{ let log=[]; for(let i=0;i<5;i++){ try{ if(i===2) break; log.push("t"+i) } finally { log.push("f"+i) } } return log.join(",") })()')
  // continue across finally
  eq('(()=>{ let log=[]; for(let i=0;i<4;i++){ try{ if(i%2===0) continue; log.push("t"+i) } finally { log.push("f"+i) } } return log.join(",") })()')
  // break with a return value carried out of the loop
  eq('(()=>{ let s=0; for(let i=0;i<10;i++){ try{ s+=i; if(s>6) break } finally { s+=100 } } return s })()')
  // labeled break across finally from an inner loop
  eq('(()=>{ let log=[]; outer: for(let i=0;i<3;i++){ for(let j=0;j<3;j++){ try{ if(i===1&&j===1) break outer; log.push(i+""+j) } finally { log.push("f") } } } return log.join(",") })()')
  // labeled continue across finally
  eq('(()=>{ let log=[]; outer: for(let i=0;i<3;i++){ for(let j=0;j<3;j++){ try{ if(j===1) continue outer; log.push(i+""+j) } finally { log.push("f"+i+j) } } } return log.join(",") })()')
  // nested try/finally both crossed by one break (both finallys run, inner first)
  eq('(()=>{ let log=[]; while(true){ try{ try{ log.push("a"); break } finally { log.push("inner") } } finally { log.push("outer") } } return log.join(",") })()')
  // a let-scoped block between the loop and the try (scope trampoline)
  eq('(()=>{ let log=[]; for(let i=0;i<3;i++){ { let k=i*2; try{ if(i===1) break; log.push("t"+k) } finally { log.push("f"+k) } } } return log.join(",") })()')
  // break across finally in for-of with a let binding
  eq('(()=>{ let out=[]; for(const x of [1,2,3,4]){ try{ if(x===3) break; out.push(x) } finally { out.push(-x) } } return out.join(",") })()')
  // finally itself performs the break (overrides a normal completion)
  eq('(()=>{ let log=[]; for(let i=0;i<5;i++){ try{ log.push("t"+i) } finally { if(i===2) break; log.push("f"+i) } } return log.join(",") })()')
  // try/finally with no catch, break skips remaining try body
  eq('(()=>{ let n=0; for(let i=0;i<3;i++){ try{ n++; break; n+=100 } finally { n+=10 } } return n })()')
  // catch + finally both crossed by break
  eq('(()=>{ let log=[]; for(let i=0;i<3;i++){ try{ throw i } catch(e){ log.push("c"+e); if(e===1) break } finally { log.push("f"+i) } } return log.join(",") })()')
})

// arguments object (non-arrow functions; arrows inherit)
test('arguments', () => {
  eq('(function(){ return arguments.length })(1,2,3)')
  eq('(function(){ let s=0; for(let i=0;i<arguments.length;i++) s+=arguments[i]; return s })(4,5,6)')
  eq('(function(){ return Array.prototype.slice.call(arguments).join(",") })("a","b")')
  eq('(()=>{ function f(){ const g=()=>arguments[0]+":"+arguments.length; return g() } return f(7,8,9) })()')
  eq('(()=>{ function outer(){ return (function inner(){ return inner.length }) } return outer().length })()')
  eq('(function(a,b){ return a+b+arguments.length })(1,2,3,4)')
})

// switch
test('switch', () => {
  eq('(()=>{ function f(n){ switch(n){ case 1: return "one"; case 2: case 3: return "two-three"; default: return "other" } } return [f(1),f(2),f(3),f(9)].join(",") })()')
  eq('(()=>{ let r=""; switch(2){ case 1: r+="a"; case 2: r+="b"; case 3: r+="c"; break; case 4: r+="d" } return r })()') // fall-through
})

// update / compound assignment (identifier + member)
test('update and compound assignment', () => {
  eq('(()=>{ let x=5; return (x++)+":"+x })()')
  eq('(()=>{ let x=5; return (++x)+":"+x })()')
  eq('(()=>{ let x=5; return (x--)+":"+x })()')
  eq('(()=>{ const o={n:1}; o.n+=4; return o.n })()')
  eq('(()=>{ const o={n:1}; return (o.n++)+":"+o.n })()')
  eq('(()=>{ const a=[1]; a[0]*=10; return a[0] })()')
  eq('(()=>{ const a=[5]; return (++a[0])+":"+a[0] })()')
  eq('(()=>{ let s="a"; s+="b"; s+="c"; return s })()')
})

// typeof / instanceof / in / delete / void
test('typeof / instanceof / in / delete / void', () => {
  eq('typeof 1 + typeof "s" + typeof true + typeof undefined + typeof null + typeof {}')
  eq('typeof notDefinedAnywhere')
  eq('[] instanceof Array')
  eq('(()=>{ const e=new Error(); return e instanceof Error })()')
  eq('"a" in {a:1}')
  eq('0 in [9]')
  eq('(()=>{ const o={a:1}; delete o.a; return "a" in o })()')
  eq('void 0')
  eq('void "anything"')
})

// BigInt literals
test('BigInt', () => {
  eq('10n + 20n')
  eq('(2n ** 64n).toString()')
  eq('typeof 5n')
  eq('(()=>{ let x=1n; for(let i=0;i<5;i++) x*=2n; return x.toString() })()')
  eq('123n === 123n')
})

// regex
test('regex', () => {
  eq('/ab+c/.test("abbbc")')
  eq('"a1b2c3".replace(/[0-9]/g,"#")')
  eq('(()=>{ const m="2024-01".match(/(\\d+)-(\\d+)/); return m[1]+"/"+m[2] })()')
})

// async / await
test('async/await', async () => {
  await eqAsync('(async()=>{ const x=await Promise.resolve(41); return x+1 })()')
  await eqAsync('(async()=>{ let s=0; for(const v of [1,2,3]){ s+=await Promise.resolve(v) } return s })()')
  await eqAsync('(async()=>{ try { await Promise.reject(new Error("no")); return "ok" } catch(e){ return "caught:"+e.message } })()')
  await eqAsync('(async()=>{ const a=await Promise.resolve(2); const b=await Promise.resolve(3); return a*b })()')
  await eqAsync('(async()=>{ async function inner(){ return await Promise.resolve(10) } return (await inner())+5 })()')
  await eqAsync('Promise.all([Promise.resolve(1),Promise.resolve(2)]).then(a=>a[0]+a[1])')
})

// higher-order / interop stress
test('interop and higher-order', () => {
  eq('[3,1,2].sort((a,b)=>a-b).join(",")')
  eq('[1,2,3,4].filter(x=>x%2===0).map(x=>x*x).join(",")')
  eq('"hello world".split(" ").map(w=>w[0].toUpperCase()+w.slice(1)).join(" ")')
  eq('Array.from({length:5},(_,i)=>i*i).join(",")')
  eq('(()=>{ const set=new Set([1,1,2,3]); return set.size })()')
  eq('(()=>{ let total=0; [1,2,3].forEach(x=>{ total+=x }); return total })()')
})

// strict-mode / TDZ semantics (both VM and native must throw the same way)
test('strict-mode and TDZ', () => {
  eq('(()=>{ "use strict"; try { undeclaredAssign = 5; return "no throw" } catch(e){ return e.constructor.name } })()')
  eq('(()=>{ try { return x; let x=1 } catch(e){ return e.constructor.name } })()') // TDZ ReferenceError
  eq('(()=>{ const c=1; try { c=2; return "no" } catch(e){ return e.constructor.name } })()') // const reassign TypeError
  eq('(()=>{ function f(){ return this } return f()===undefined })()') // strict: this undefined in plain call
})

// ---------------------------------------------------------------------------
// classes: declarations, expressions, methods, getters/setters, static, private
// fields/methods, extends/super, computed keys. Asserted == native strict eval.
test('classes', () => {
  eq('(()=>{ class A{ constructor(x){ this.x=x } get v(){ return this.x*2 } } return new A(5).v })()')
  eq('(()=>{ class A{ static n=10; static get(){ return A.n } } return A.get() })()')
  eq('(()=>{ class A{ #c=0; inc(){ return ++this.#c } } const a=new A(); a.inc(); return a.inc() })()')
  eq('(()=>{ class A{ constructor(){ this.a=1 } m(){ return "A" } } class B extends A{ constructor(){ super(); this.b=2 } m(){ return super.m()+"B" } } const b=new B(); return b.a+b.b+":"+b.m() })()')
  eq('(()=>{ class A{ #x=3; has(o){ return #x in o } } const a=new A(); return [a.has(a), a.has({})].join(",") })()')
  eq('(()=>{ class P{ #v; constructor(v){ this.#v=v } get v(){ return this.#v } set v(n){ this.#v=n } } const p=new P(1); p.v=9; return p.v })()')
  eq('(()=>{ class A{}; class B extends A{}; return new B() instanceof A })()')
  eq('(()=>{ let log=[]; class A{ constructor(){ log.push("A") } } class B extends A{ constructor(){ super(); log.push("B") } } new B(); return log.join(",") })()')
  eq('(()=>{ class C{ static #count=0; static inc(){ return ++C.#count } } C.inc(); return C.inc() })()')
  eq('(()=>{ const k="dyn"; class A{ [k](){ return 42 } } return new A().dyn() })()')
  eq('(()=>{ const C = class Named { who(){ return Named.name } }; return new C().who() })()')
  eq('(()=>{ class A{ #m(){ return 7 } call(){ return this.#m() } } return new A().call() })()')
  eq('(()=>{ class Base{ constructor(a){ this.a=a } } class D extends Base{ x=this.a+1 } const d=new D(5); return d.a+":"+d.x })()')
  eq('(()=>{ class A{ toString(){ return "A!" } } return `${new A()}` })()')
})

// ---------------------------------------------------------------------------
// Unsupported constructs: assert they raise a clear error (the subset boundary).
test('unsupported constructs throw ShieldUnsupported/ShieldCompileError', () => {
  // generators, with, tagged templates remain out of the subset.
  for (const code of ['(function*(){ yield 1 })', 'function f(){ with({}){} }', 'tag`hi`', 'async function* g(){}']) {
    assert.throws(() => compile(code, { seed: SEED }), (e) => e instanceof ShieldCompileError, `expected compile failure: ${code}`)
  }
})

// Now-supported constructs must COMPILE (no throw).
test('classes / modules / meta now compile', () => {
  for (const code of ['class A{}', 'import.meta.url', '(function(){ return new.target })', 'export const x=1', 'import x from "y"', 'await 1']) {
    assert.doesNotThrow(() => compile(code, { seed: SEED }), `expected compile success: ${code}`)
  }
})

// ---------------------------------------------------------------------------
// Superinstructions / step-count fusions (PLAN 5.11). Each asserts BOTH that
// the VM result equals native AND that the fused opcode is actually emitted.

test('OBJ_SET_CONST: {key:<literal>} values match native (all literal kinds)', () => {
  // every literal kind, incl. the const-pool-decode edge cases
  eq('(()=>{ const o={a:1,b:"x",c:true,d:false,e:null,f:1.5}; return JSON.stringify(o) })()')
  eq('(()=>{ const o={n:NaN, i:Infinity, j:-Infinity, z:-0}; return [o.n, o.i, o.j, Object.is(o.z,-0)].join(",") })()')
  eq('(()=>{ const o={big:10n}; return typeof o.big+":"+o.big })()')
  eq('(()=>{ const o={re:/ab+c/gi}; return o.re.source+":"+o.re.flags+":"+o.re.test("abbc") })()')
  // non-literal values (method/computed/identifier) must still work (fall back)
  eq('(()=>{ let v=9; const o={m(){return 1}, [("k"+1)]:2, id:v, lit:3}; return o.m()+o.k1+o.id+o.lit })()')
  const c = opCounts('(()=>{ const o={a:1,b:2,c:"x",d:true,e:null}; return o })()')
  assert.ok((c.OBJ_SET_CONST || 0) >= 5, 'expected OBJ_SET_CONST for literal-valued properties')
})

test('DECLARE_SLOTS: bulk declare of a contiguous run matches native', () => {
  eq('(()=>{ const a=1,b=2,c=3,d=4,e=5; return a+b+c+d+e })()')
  eq('(()=>{ let x=1; let y=2; let z=3; x=9; return x+y+z })()')
  // TDZ preserved across a bulk declare (const read before init throws)
  eq('(()=>{ try { return (()=>{ return q; const p=1,q=2; })() } catch(e){ return e.constructor.name } })()')
  const c = opCounts('(()=>{ const a=1,b=2,c=3,d=4; return a+b+c+d })()')
  assert.ok((c.DECLARE_SLOTS || 0) >= 1, 'expected a DECLARE_SLOTS run')
})

test('block scope elision: no fresh scope for a lexical-free block (result matches)', () => {
  // body block declares nothing block-scoped -> no ENTER_SCOPE emitted
  eq('(()=>{ let s=0; for(let i=0;i<5;i++){ s=s+i } return s })()')
  // a block that DOES declare a let keeps its scope (per-iteration binding)
  eq('(()=>{ let fns=[]; for(const i of [0,1,2]){ let x=i*2; fns.push(()=>x) } return fns.map(f=>f()).join(",") })()')
  // nested blocks, var hoists through, correctness preserved
  eq('(()=>{ let t=0; { t=1; { t=t+2; var v=3 } } return t+v })()')
  const noScope = opCounts('(()=>{ let s=0; for(let i=0;i<3;i++){ s=s+i } return s })()')
  const withScope = opCounts('(()=>{ let s=0; for(let i=0;i<3;i++){ let k=i; s=s+k } return s })()')
  assert.ok((withScope.ENTER_SCOPE || 0) > (noScope.ENTER_SCOPE || 0), 'lexical-free loop body should elide ENTER_SCOPE')
})

// ---------------------------------------------------------------------------
// Explicitly SKIPPED cases (known limitations, see README "Known deviations").
test('SKIP: per-iteration let binding in C-style for (closures capture shared binding)', { skip: 'known deviation: for(let) closures capture final value (var-like)' }, () => {})
test('SKIP: generators / yield', { skip: 'generators not in subset (marked @no-vm by the plugin)' }, () => {})
test('SKIP: eval / new Function', { skip: 'dynamic code eval not in subset' }, () => {})
test('SKIP: tagged template literals', { skip: 'tagged templates not in subset' }, () => {})
test('SKIP: for-await-of', { skip: 'async iteration not in subset' }, () => {})
