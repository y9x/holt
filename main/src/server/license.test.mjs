// node --test for embed licenses. Run with: npm test

import test from 'node:test'
import assert from 'node:assert/strict'

import { signJwt } from './jwt.ts'
import { checkLicense, mintLicense, parseLicensing, readLicense } from './license.ts'

const SECRET = 'l'.repeat(48)
const NOW = 1_800_000_000_000
const config = (revoked = []) => ({ secret: SECRET, revoked: new Set(revoked) })

test('a minted license licenses its platform, with or without an expiry', () => {
  const perpetual = mintLicense(SECRET, { platform: 'abulxt', note: 'first party' }, NOW)
  assert.equal(perpetual.license.expiresAt, null)
  assert.deepEqual(checkLicense(config(), 'abulxt', perpetual.token, NOW + 10 * 365 * 86_400_000), { ok: true, license: perpetual.license })
  const yearly = mintLicense(SECRET, { platform: 'nocturne', days: 365 }, NOW)
  assert.equal(yearly.license.expiresAt, NOW / 1000 + 365 * 86_400)
  assert.equal(checkLicense(config(), 'nocturne', yearly.token, NOW).ok, true)
})

test('refusals: missing, another platform, expired, revoked, forged, tampered, wrong secret', () => {
  const { token, license } = mintLicense(SECRET, { platform: 'nocturne', days: 30 }, NOW)
  const reason = (platform, value, now = NOW, revoked = []) => {
    const result = checkLicense(config(revoked), platform, value, now)
    return result.ok ? 'ok' : result.reason
  }
  assert.equal(reason('nocturne', undefined), 'missing')
  assert.equal(reason('nocturne', ''), 'missing')
  assert.equal(reason('abulxt', token), 'wrong-platform')
  assert.equal(reason('nocturne', token, NOW + 31 * 86_400_000), 'expired')
  assert.equal(reason('nocturne', token, NOW, [license.lid]), 'revoked')
  assert.equal(reason('nocturne', mintLicense('x'.repeat(48), { platform: 'nocturne' }, NOW).token), 'invalid')
  const [h, , s] = token.split('.')
  const forgedPayload = Buffer.from(JSON.stringify({ typ: 'holt-license', lid: license.lid, platform: 'nocturne', iat: NOW / 1000 })).toString('base64url')
  assert.equal(reason('nocturne', `${h}.${forgedPayload}.${s}`), 'invalid')
  assert.equal(reason('nocturne', 'not-a-token'), 'invalid')
  assert.equal(reason('nocturne', 'x'.repeat(5000)), 'invalid')
})

test('an identity token or a session signed with the same secret is not a license', () => {
  assert.equal(readLicense(SECRET, signJwt({ typ: 'holt-session', lid: 'abcdefgh', platform: 'nocturne', iat: 1 }, SECRET)), null)
  assert.equal(readLicense(SECRET, signJwt({ iss: 'x', aud: 'holt', sub: 'u', platform: 'nocturne', iat: 1 }, SECRET)), null)
})

test('minting refuses bad input', () => {
  assert.throws(() => mintLicense(SECRET, { platform: 'Not A Slug' }), /platform id/)
  assert.throws(() => mintLicense(SECRET, { platform: 'abulxt', days: 0 }), /positive/)
  assert.throws(() => mintLicense(SECRET, { platform: 'abulxt', days: 1.5 }), /positive/)
})

test('config: licensing is off without a block; a block needs a real secret and lid list', () => {
  assert.equal(parseLicensing(undefined, 'c'), null)
  assert.deepEqual([...parseLicensing({ secret: SECRET, revoked: ['abcdefgh12'] }, 'c').revoked], ['abcdefgh12'])
  assert.throws(() => parseLicensing({ secret: 'short' }, 'c'), /at least 32/)
  assert.throws(() => parseLicensing({ secret: 'CHANGE_ME' }, 'c'), /at least 32/)
  assert.throws(() => parseLicensing({ secret: SECRET, revoked: ['bad id!'] }, 'c'), /license ids/)
})
