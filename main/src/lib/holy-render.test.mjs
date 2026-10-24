// Pure-logic tests for the shared HolyText primitives. Run with tsx's Node test
// runner (see the npm script / README). Written as .mjs so `tsc --noEmit`
// (which only type-checks .ts/.tsx under src) does not pull in node:test types.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  makeDashPlaceholder,
  cipherFor,
  resolveHoly,
  ELLIPSIS_SHADOW_CSS,
} from './holy-render.ts'
import {
  registerObfuscatedString,
} from './obfuscated-strings.ts'

test('makeDashPlaceholder dashes non-space chars, preserves whitespace + length', () => {
  assert.equal(makeDashPlaceholder('Hi there'), '-- -----')
  assert.equal(makeDashPlaceholder('abc'), '---')
  // whitespace of every kind is preserved verbatim
  assert.equal(makeDashPlaceholder('a\tb\nc'), '-\t-\n-')
  // empty -> stable fallback
  assert.equal(makeDashPlaceholder(''), '---')
  // same visible length as the source (word shape preserved)
  const s = 'Terms of Service'
  assert.equal(makeDashPlaceholder(s).length, s.length)
})

test('cipherFor: explicit encrypted wins, else registry, else undefined', () => {
  assert.equal(cipherFor('anything', 'EXPLICIT=='), 'EXPLICIT==')
  assert.equal(cipherFor('not-registered-xyz'), undefined)
  registerObfuscatedString('registered-str', 'CIPHER==')
  assert.equal(cipherFor('registered-str'), 'CIPHER==')
  // explicit still wins over a registry hit
  assert.equal(cipherFor('registered-str', 'OVERRIDE=='), 'OVERRIDE==')
})

test('resolveHoly reveals unregistered content as plaintext (no cipher)', () => {
  const res = resolveHoly('plain text', undefined)
  assert.deepEqual(res, { kind: 'reveal', plaintext: 'plain text' })
})

test('resolveHoly keeps placeholder when a cipher cannot be decrypted (no key)', () => {
  // In the node test env there is no decryption key, so holyDecrypt returns '';
  // a registered string that fails to decrypt must keep its dash placeholder
  // rather than reveal an empty string.
  const res = resolveHoly('secret', 'bogus-ciphertext')
  assert.deepEqual(res, { kind: 'keep' })
})

test('ELLIPSIS_SHADOW_CSS carries the non-inherited truncation props', () => {
  for (const prop of ['overflow', 'text-overflow:ellipsis', 'white-space:nowrap']) {
    assert.ok(ELLIPSIS_SHADOW_CSS.includes(prop), `missing ${prop}`)
  }
})
