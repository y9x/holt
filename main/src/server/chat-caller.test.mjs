// node --test for the principal holt-service hands holt-chat (chat-caller.ts). Run with: npm test

import test from 'node:test'
import assert from 'node:assert/strict'

import { extUserOf, readPrincipal, signPrincipal } from './chat-caller.ts'

const SECRET = 'x'.repeat(48)
const alice = { key: 'lab:1', platformId: 'lab', name: 'lab-alice', emailVerified: true, avatar: null, tier: null }

test('a signed principal reads back; anything else is nobody', () => {
  const now = Date.now()
  const header = signPrincipal(alice, SECRET, now)
  assert.deepEqual(readPrincipal(header, SECRET, now), { ...alice, discordId: null, admin: false })
  assert.equal(readPrincipal(header, 'y'.repeat(48), now), null, 'another key')
  assert.equal(readPrincipal(header, SECRET, now + 61_000), null, 'expired after a minute')
  const [body, mac] = header.split('.')
  const forged = Buffer.from(JSON.stringify({ ...alice, key: 'lab:2', exp: now + 60_000 })).toString('base64url')
  assert.equal(readPrincipal(`${forged}.${mac}`, SECRET, now), null, 'body swapped under a valid mac')
  assert.equal(readPrincipal(body, SECRET, now), null, 'no mac')
  assert.equal(readPrincipal('', SECRET, now), null)
})

test('a principal becomes its platform\'s user, never a Discord user or a guest', () => {
  const user = extUserOf(alice)
  assert.equal(user.ext_key, 'lab:1')
  assert.equal(user.admin, false)
  assert.equal(user.discord_id, null)
  assert.equal(extUserOf({ ...alice, key: 'abulxt:42' }).ext_key, 'abulxt:42', 'abulxt is a platform like any other')
  for (const key of ['user:42', 'discord:1548417587291881574', 'guest:1.2.3.4', 'holt:x']) {
    assert.equal(extUserOf({ ...alice, key }), null, key)
  }
  assert.equal(extUserOf({ ...alice, name: 'x'.repeat(80) }).username.length, 32)
  assert.equal(extUserOf({ ...alice, avatar: 'http://evil/a.png' }).avatar, null, 'https avatars only')
})

test('a trusted principal\'s Discord link and admin flag survive the hand-off', () => {
  const now = Date.now()
  const linked = { ...alice, key: 'abulxt:42', platformId: 'abulxt', discordId: '1310751771840217119', admin: true }
  const back = readPrincipal(signPrincipal(linked, SECRET, now), SECRET, now)
  assert.equal(back.discordId, '1310751771840217119')
  assert.equal(back.admin, true)
  const user = extUserOf(back)
  assert.equal(user.discord_id, '1310751771840217119')
  assert.equal(user.admin, true)
})
