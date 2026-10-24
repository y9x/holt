// node --test for the principal holt-service hands holt-chat (chat-caller.ts). Run with: npm test

import test from 'node:test'
import assert from 'node:assert/strict'

import { absolutizeSiteAvatars, extUserOf, readPrincipal, signPrincipal, siteOriginOf } from './chat-caller.ts'

const SECRET = 'x'.repeat(48)
const alice = { key: 'lab:1', platformId: 'lab', name: 'lab-alice', emailVerified: true, avatar: null, tier: null }

test('a signed principal reads back; anything else is nobody', () => {
  const now = Date.now()
  const header = signPrincipal(alice, SECRET, now)
  assert.deepEqual(readPrincipal(header, SECRET, now), alice)
  assert.equal(readPrincipal(header, 'y'.repeat(48), now), null, 'another key')
  assert.equal(readPrincipal(header, SECRET, now + 61_000), null, 'expired after a minute')
  const [body, mac] = header.split('.')
  const forged = Buffer.from(JSON.stringify({ ...alice, key: 'lab:2', exp: now + 60_000 })).toString('base64url')
  assert.equal(readPrincipal(`${forged}.${mac}`, SECRET, now), null, 'body swapped under a valid mac')
  assert.equal(readPrincipal(body, SECRET, now), null, 'no mac')
  assert.equal(readPrincipal('', SECRET, now), null)
})

test('a principal can only become another platform\'s user', () => {
  const user = extUserOf(alice)
  assert.equal(user.id, null)
  assert.equal(user.ext_key, 'lab:1')
  assert.equal(user.admin, false)
  for (const key of ['abulxt:42', 'user:42', 'discord:1548417587291881574', 'guest:1.2.3.4', 'holt:x']) {
    assert.equal(extUserOf({ ...alice, key }), null, key)
  }
  assert.equal(extUserOf({ ...alice, name: 'x'.repeat(80) }).username.length, 32)
  assert.equal(extUserOf({ ...alice, avatar: 'http://evil/a.png' }).avatar, null, 'https avatars only')
})

test('abulxt avatar paths go absolute for pages on other origins', () => {
  const origin = siteOriginOf({ avatars: { publicOrigin: '' }, mail: { publicOrigin: 'https://abstracteducation.loan/' } })
  assert.equal(origin, 'https://abstracteducation.loan')
  assert.equal(absolutizeSiteAvatars('{"authorAvatar":"/api/avatars/ab.webp"}', origin), '{"authorAvatar":"https://abstracteducation.loan/api/avatars/ab.webp"}')
  assert.equal(absolutizeSiteAvatars('{"a":"/api/avatars/x"}', null), '{"a":"/api/avatars/x"}')
  assert.equal(siteOriginOf({ mail: { publicOrigin: 'javascript:alert(1)' } }), null)
})
