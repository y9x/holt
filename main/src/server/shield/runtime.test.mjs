// shield runtime tests (PLAN P3): trap-slot wipe, step budget, polymorphic
// layout, encrypted-integrity, and running compiled programs through the VM.
//
// Browser (Chromium) execution is NOT exercised here — see README "Loader
// status / what's a stub". The runtime is authored as plain JS with no Node
// built-ins so it is browser-safe, but an automated browser run was not done.

import test from 'node:test'
import assert from 'node:assert/strict'
import { compile } from './compiler.ts'
import { execute, decryptProgram, createRuntime } from './runtime-template.js'
import { buildLayout, ARITY } from './opcodes.ts'

test('decrypt round-trips the compiled program', () => {
  const r = compile('1 + 2 * 3', { seed: 'roundtrip' })
  const p = decryptProgram(r.encrypted, r.key)
  assert.deepStrictEqual(p, r.program)
  assert.equal(execute(r.encrypted, r.key), 7)
})

test('encrypted payload is authenticated (tamper fails decryption)', () => {
  const r = compile('40 + 2', { seed: 's' })
  const bad = r.encrypted.slice()
  bad[bad.length - 1] ^= 0xff // flip a ciphertext/tag byte
  assert.throws(() => decryptProgram(bad, r.key))
})

test('polymorphic layout: different seeds, different bytes, same result', () => {
  const a = compile('(()=>{ let s=0; for(let i=0;i<10;i++) s+=i; return s })()', { seed: 1 })
  const b = compile('(()=>{ let s=0; for(let i=0;i<10;i++) s+=i; return s })()', { seed: 2 })
  assert.equal(execute(a.encrypted, a.key), 45)
  assert.equal(execute(b.encrypted, b.key), 45)
  // at least one opcode maps to a different byte between builds
  const diff = Object.keys(a.layout.byteOf).some((k) => a.layout.byteOf[k] !== b.layout.byteOf[k])
  assert.ok(diff, 'layouts should differ across seeds')
  // encrypted bytes differ too
  assert.notEqual(Buffer.from(a.encrypted).toString('hex'), Buffer.from(b.encrypted).toString('hex'))
})

test('step budget stops runaway loops', () => {
  const r = compile('(()=>{ while(true){} })()', { seed: 'budget' })
  const rt = createRuntime(r.program, { budget: 5000 })
  assert.throws(() => rt.run(), (e) => /step budget exceeded/.test(e.message) && e.__shieldFatal === true)
})

test('trap slot wipes bytecode + constant pool then throws', () => {
  // Hand-build a program whose single instruction is an UNUSED (trap) byte.
  const layout = buildLayout('trap-seed')
  const used = new Set(Object.values(layout.byteOf))
  let trapByte = -1
  for (let b = 0; b < layout.tableSize; b++) { if (!used.has(b)) { trapByte = b; break } }
  assert.ok(trapByte >= 0, 'expected at least one trap slot')
  const program = {
    version: 1,
    layout,
    consts: ['secret-string', 123],
    functions: [{ code: [trapByte], name: null, isAsync: false, isArrow: false, numParams: 0 }],
    mainIndex: 0,
  }
  const rt = createRuntime(program)
  assert.throws(() => rt.run(), (e) => /trap slot/.test(e.message) && e.__shieldFatal === true)
  // constant pool was zeroed by the wipe
  assert.deepStrictEqual(rt._consts, [0, 0])
})

test('ARITY table covers every opcode referenced by a build layout', () => {
  const layout = buildLayout('arity')
  for (const name of Object.values(layout.nameOf)) {
    assert.equal(typeof ARITY[name], 'number', `missing arity for ${name}`)
  }
})

test('async programs run through the VM and resolve', async () => {
  const r = compile('(async()=>{ const x = await Promise.resolve(21); return x * 2 })()', { seed: 'async' })
  const v = await execute(r.encrypted, r.key)
  assert.equal(v, 42)
})
