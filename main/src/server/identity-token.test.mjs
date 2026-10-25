// node --test for identity tokens and holt sessions. Run with: npm test

import test from 'node:test'
import assert from 'node:assert/strict'

import { signJwt, verifyJwt } from './jwt.ts'
import { MAX_TTL_SECONDS, verifyIdentityToken } from './identity-token.ts'
import { issueSession, readSession } from './session.ts'
import { parsePlatforms } from './platforms.ts'

const SECRET = 's'.repeat(40)
const [PLATFORM] = parsePlatforms([{
  id: 'nocturne',
  name: 'Nocturne',
  issuer: 'https://nocturne.lol',
  secret: SECRET,
  allowedOrigins: ['https://nocturne.lol'],
  links: { account: 'https://nocturne.lol/account', settings: 'https://nocturne.lol/account' },
}])
const NOW = 1_800_000_000_000

function claims(overrides = {}) {
  const iat = Math.floor(NOW / 1000)
  return { iss: 'https://nocturne.lol', aud: 'holt', sub: 'u_42', iat, exp: iat + 120, name: 'Reed', email_verified: true, ...overrides }
}

test('jwt: round trip, tamper, wrong secret, alg none', () => {
  const token = signJwt({ a: 1 }, SECRET)
  assert.deepEqual(verifyJwt(token, SECRET), { a: 1 })
  assert.throws(() => verifyJwt(token, 'x'.repeat(40)), /bad signature/)
  const [h, p, s] = token.split('.')
  assert.throws(() => verifyJwt(`${h}.${Buffer.from('{"a":2}').toString('base64url')}.${s}`, SECRET), /bad signature/)
  const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${p}.`
  assert.throws(() => verifyJwt(none, SECRET), /unsupported algorithm/)
})

test('a valid identity token becomes a namespaced principal', () => {
  const principal = verifyIdentityToken(signJwt(claims({ avatar: 'https://cdn.nocturne.lol/a.webp', tier: 'plus' }), SECRET), PLATFORM, NOW)
  assert.deepEqual(principal, { key: 'nocturne:u_42', platformId: 'nocturne', name: 'Reed', emailVerified: true, avatar: 'https://cdn.nocturne.lol/a.webp', tier: 'plus' })
})

test('issuer, audience, lifetime and expiry are enforced', () => {
  const check = (c, re) => assert.throws(() => verifyIdentityToken(signJwt(claims(c), SECRET), PLATFORM, NOW), re)
  check({ iss: 'https://evil.example' }, /wrong issuer/)
  check({ aud: 'other' }, /wrong audience/)
  check({ exp: Math.floor(NOW / 1000) - 1 }, /expired/)
  check({ exp: Math.floor(NOW / 1000) + MAX_TTL_SECONDS + 1 }, /lifetime too long/)
  check({ iat: Math.floor(NOW / 1000) + 600, exp: Math.floor(NOW / 1000) + 700 }, /from the future/)
  check({ sub: undefined }, /sub is required/)
  check({ sub: 'has space' }, /sub is malformed/)
  check({ name: '' }, /name is required/)
  check({ avatar: 'http://cdn.nocturne.lol/a.webp' }, /must be https/)
  check({ tier: 'King Proxy' }, /tier is malformed/)
  assert.throws(() => verifyIdentityToken(signJwt(claims(), 'z'.repeat(40)), PLATFORM, NOW), /bad signature/)
})

test('email_verified defaults to false and an admin claim is ignored', () => {
  const principal = verifyIdentityToken(signJwt(claims({ email_verified: undefined, admin: true }), SECRET), PLATFORM, NOW)
  assert.equal(principal.emailVerified, false)
  assert.equal('admin' in principal, false)
})

test('a token with a jti is accepted once', () => {
  const token = signJwt(claims({ jti: 'once-1' }), SECRET)
  verifyIdentityToken(token, PLATFORM, NOW)
  assert.throws(() => verifyIdentityToken(token, PLATFORM, NOW), /already used/)
})

test('a session round-trips its principal and dies at expiry', () => {
  const principal = verifyIdentityToken(signJwt(claims(), SECRET), PLATFORM, NOW)
  const session = issueSession(principal, SECRET, NOW)
  assert.deepEqual(readSession(session, SECRET, NOW), { ...principal, discordId: null, admin: false })
  assert.equal(readSession(session, SECRET, NOW + 13 * 3600 * 1000), null)
  assert.equal(readSession(session, 'other'.repeat(8), NOW), null)
  // An identity token is not a session, even under the right secret.
  assert.equal(readSession(signJwt(claims(), SECRET), SECRET, NOW), null)
})
