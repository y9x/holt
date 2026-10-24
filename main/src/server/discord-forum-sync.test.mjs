// node --test for forum bridging (docs/forum/contract.md): which channels are bridged (forums, media behind
// its flag, never obfuscated channels), the forum layout signature, and the post backfill plan (active +
// archived paging to the horizon, complete-pass tombstoning).
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CHANNEL_FLAG_OBFUSCATED,
  forumSignature,
  isBridgeable,
  layoutSignatures,
  resolveBridgedChannels,
} from './discord-bridge-categories.ts'
import {
  DEFAULT_FORUM_BACKFILL,
  planActivePosts,
  planArchivedPage,
  postsToTombstone,
  resolveForumBackfill,
} from './discord-forum-sync.ts'

const cats = new Set(['cat'])
const legacy = new Set(['legacy-forum'])

test('isBridgeable: forums yes, media only with the flag, threads never', () => {
  assert.equal(isBridgeable({ id: 'f', type: 15, parentId: 'cat' }, cats, legacy), true)
  assert.equal(isBridgeable({ id: 'legacy-forum', type: 15, parentId: null }, cats, legacy), true)
  assert.equal(isBridgeable({ id: 'm', type: 16, parentId: 'cat' }, cats, legacy), false, 'media is off by default')
  assert.equal(isBridgeable({ id: 'm', type: 16, parentId: 'cat' }, cats, legacy, { media: true }), true)
  for (const type of [10, 11, 12]) assert.equal(isBridgeable({ id: 't', type, parentId: 'cat' }, cats, legacy, { media: true }), false, `thread type ${type}`)
  assert.equal(isBridgeable({ id: 't', type: 0, parentId: 'cat' }, cats, legacy), true)
  assert.equal(isBridgeable({ id: 'v', type: 2, parentId: 'cat' }, cats, legacy), false)
  assert.equal(isBridgeable({ id: 'f', type: 15, parentId: 'other' }, cats, legacy), false)
})

test('isBridgeable: an obfuscated channel is never bridged, whatever its name', () => {
  assert.equal(CHANNEL_FLAG_OBFUSCATED, 1 << 17)
  assert.equal(isBridgeable({ id: 'f', type: 15, parentId: 'cat', flags: CHANNEL_FLAG_OBFUSCATED }, cats, legacy), false)
  assert.equal(isBridgeable({ id: 't', type: 0, parentId: 'cat', flags: CHANNEL_FLAG_OBFUSCATED | 16 }, cats, legacy), false)
  assert.equal(isBridgeable({ id: 'f', type: 15, parentId: 'cat', flags: 16 }, cats, legacy), true, 'REQUIRE_TAG is fine')
})

test('resolveBridgedChannels passes the media option through', () => {
  const list = [
    { id: 'a', type: 0, guildId: 'g', parentId: 'cat' },
    { id: 'b', type: 15, guildId: 'g', parentId: 'cat' },
    { id: 'c', type: 16, guildId: 'g', parentId: 'cat' },
  ]
  assert.deepEqual(resolveBridgedChannels(list, cats, legacy).map((c) => c.id), ['a', 'b'])
  assert.deepEqual(resolveBridgedChannels(list, cats, legacy, { media: true }).map((c) => c.id), ['a', 'b', 'c'])
})

test('forum settings are part of the layout signature', () => {
  const forum = {
    availableTags: [{ id: '1', name: 'Bug', moderated: false, emoji_id: null, emoji_name: '🐛' }],
    defaultReactionEmoji: null, defaultSortOrder: null, defaultForumLayout: 0, flags: 0,
  }
  const entry = (f) => ({ id: 'f', guildId: 'g', kind: 'channel', name: 'help', position: 0, type: 15, parentId: null, overwrites: '', forum: forumSignature(f) })
  const a = layoutSignatures([entry(forum)]).get('g')
  assert.equal(layoutSignatures([entry({ ...forum })]).get('g'), a)
  assert.notEqual(layoutSignatures([entry({ ...forum, flags: 16 })]).get('g'), a, 'REQUIRE_TAG')
  assert.notEqual(layoutSignatures([entry({ ...forum, availableTags: [{ ...forum.availableTags[0], name: 'Bugs' }] })]).get('g'), a, 'tag rename')
  assert.notEqual(layoutSignatures([entry({ ...forum, defaultSortOrder: 1 })]).get('g'), a)
})

test('backfill horizon: defaults 200 posts / 90 days, bounded', () => {
  assert.deepEqual(resolveForumBackfill(undefined), DEFAULT_FORUM_BACKFILL)
  assert.deepEqual(DEFAULT_FORUM_BACKFILL, { posts: 200, days: 90 })
  assert.deepEqual(resolveForumBackfill({ posts: 50 }), { posts: 50, days: 90 })
  assert.deepEqual(resolveForumBackfill({ posts: 0, days: -1 }), DEFAULT_FORUM_BACKFILL)
  assert.deepEqual(resolveForumBackfill({ posts: 1e9, days: 1e9 }), { posts: 1000, days: 3650 })
  assert.deepEqual(resolveForumBackfill({ posts: '5', days: 2.7 }), { posts: 200, days: 2 })
})

test('active posts: newest first by snowflake, capped', () => {
  const active = [{ id: '900' }, { id: '1000' }, { id: '999' }, { id: '12' }]
  assert.deepEqual(planActivePosts(active, { posts: 3, days: 90 }), ['1000', '999', '900'])
})

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 24)

test('archived paging: next page from the oldest archive time (a Date)', () => {
  const page = [{ id: 'a', archiveTimestamp: NOW - DAY }, { id: 'b', archiveTimestamp: NOW - 2 * DAY }]
  const plan = planArchivedPage({ taken: 10, page, hasMore: true, horizon: { posts: 200, days: 90 }, nowMs: NOW })
  assert.deepEqual(plan.take, ['a', 'b'])
  assert.ok(plan.next instanceof Date)
  assert.equal(plan.next.getTime(), NOW - 2 * DAY)
  assert.equal(plan.complete, false)
})

test('archived paging: the listing ran out inside the horizon = complete', () => {
  const plan = planArchivedPage({ taken: 0, page: [{ id: 'a', archiveTimestamp: NOW - DAY }], hasMore: false, horizon: DEFAULT_FORUM_BACKFILL, nowMs: NOW })
  assert.deepEqual(plan, { take: ['a'], next: null, complete: true })
  assert.deepEqual(planArchivedPage({ taken: 0, page: [], hasMore: false, horizon: DEFAULT_FORUM_BACKFILL, nowMs: NOW }), { take: [], next: null, complete: true })
})

test('archived paging: stops at the day horizon (not complete)', () => {
  const page = [{ id: 'a', archiveTimestamp: NOW - 10 * DAY }, { id: 'old', archiveTimestamp: NOW - 91 * DAY }, { id: 'older', archiveTimestamp: NOW - 100 * DAY }]
  assert.deepEqual(planArchivedPage({ taken: 0, page, hasMore: true, horizon: DEFAULT_FORUM_BACKFILL, nowMs: NOW }), { take: ['a'], next: null, complete: false })
})

test('archived paging: stops at the post cap, whichever comes first', () => {
  const page = [{ id: 'a', archiveTimestamp: NOW - DAY }, { id: 'b', archiveTimestamp: NOW - DAY }, { id: 'c', archiveTimestamp: NOW - DAY }]
  assert.deepEqual(planArchivedPage({ taken: 198, page, hasMore: true, horizon: DEFAULT_FORUM_BACKFILL, nowMs: NOW }), { take: ['a', 'b'], next: null, complete: false })
  // Exactly filled by the last post of a page that had more: stop, not complete.
  assert.deepEqual(planArchivedPage({ taken: 197, page, hasMore: true, horizon: DEFAULT_FORUM_BACKFILL, nowMs: NOW }), { take: ['a', 'b', 'c'], next: null, complete: false })
  // ... but complete when that was the last page.
  assert.deepEqual(planArchivedPage({ taken: 197, page, hasMore: false, horizon: DEFAULT_FORUM_BACKFILL, nowMs: NOW }), { take: ['a', 'b', 'c'], next: null, complete: true })
})

test('archived paging: no archive time on the last post = no cursor to page from', () => {
  const plan = planArchivedPage({ taken: 0, page: [{ id: 'a', archiveTimestamp: null }], hasMore: true, horizon: DEFAULT_FORUM_BACKFILL, nowMs: NOW })
  assert.deepEqual(plan, { take: ['a'], next: null, complete: false })
})

test('tombstones only after a complete pass', () => {
  assert.deepEqual(postsToTombstone(['1', '2', '3'], new Set(['1', '3']), true), ['2'])
  assert.deepEqual(postsToTombstone(['1', '2', '3'], new Set(['1']), false), [])
})
