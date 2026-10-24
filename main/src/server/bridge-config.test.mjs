// node --test for the `bridge` config key. Run with: npm test

import test from 'node:test'
import assert from 'node:assert/strict'

import { bridgeTargets, inExpectedGuild, parseBridge, registeredLicenses } from './bridge-config.ts'

const G1 = '1548417587291881574', G2 = '1600000000000000001'
const C1 = '1556875688538284044', C2 = '1556875691121840210', CAT = '1600000000000000099'

test('a guild per platform, with its license and what is bridged from it', () => {
  const entries = parseBridge({
    abulxt: { license: 'tok-a', guild: G1, channels: [C1, C2, C1] },
    lab: { license: 'tok-l', guild: G2, categories: [CAT] },
    nocturne: { license: 'tok-n' },
  })
  assert.deepEqual(entries.find((e) => e.platform === 'abulxt'), { platform: 'abulxt', license: 'tok-a', guild: G1, channels: [C1, C2], categories: [] })
  const targets = bridgeTargets({ bridge: { abulxt: { guild: G1, channels: [C1] }, lab: { guild: G2, categories: [CAT] } } })
  assert.deepEqual(targets.channelIds, [C1])
  assert.deepEqual(targets.categoryIds, [CAT])
  assert.equal(targets.guildPlatform.get(G2), 'lab')
  assert.equal(inExpectedGuild(targets, CAT, G2), true)
  assert.equal(inExpectedGuild(targets, CAT, G1), false, 'a category found in the wrong guild is not bridged')
  assert.deepEqual(registeredLicenses(entries, 'lab'), ['tok-l'])
  assert.deepEqual(registeredLicenses(entries, 'ghost'), [], 'a platform not in bridge has no license')
})

test('legacy discord.bridgeChannels / bridgeCategories still work when bridge is absent', () => {
  assert.equal(parseBridge(undefined), null)
  const targets = bridgeTargets({ discord: { bridgeChannels: [C1, ' ', C1], bridgeCategories: [CAT] } })
  assert.deepEqual([targets.channelIds, targets.categoryIds], [[C1], [CAT]])
  assert.equal(inExpectedGuild(targets, C1, 'any-guild'), true)
  assert.equal(registeredLicenses(null, 'abulxt'), null, 'no bridge key: licensing is not registry-based')
})

test('mistakes fail at startup, not at a user\'s first message', () => {
  const bad = (raw, re) => assert.throws(() => parseBridge(raw), re)
  bad([], /keyed by platform/)
  bad({ 'Not A Slug': {} }, /platform id/)
  bad({ abulxt: { channels: [C1] } }, /need the guild/)
  bad({ abulxt: { guild: 'abc' } }, /guild id/)
  bad({ abulxt: { guild: G1, channels: ['nope'] } }, /not a Discord id/)
  bad({ a: { guild: G1 }, b: { guild: G1 } }, /already belongs to a/)
  bad({ a: { guild: G1, channels: [C1] }, b: { guild: G2, channels: [C1] } }, /already bridged by a/)
  bad({ abulxt: { license: '' , guild: G1 } }, /license token/)
})
