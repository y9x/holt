// node --test for proxy embedding's identity check against a real local user-state endpoint.
// Run with: npm test

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { clearUserStateCache, forwardedCookies, principalFromPlatform, UserStateUnavailable } from './forward-auth.ts'
import { parsePlatforms } from './platforms.ts'

const USERS = {
  s_good: { id: 77, username: 'Night Owl', email_verified: true, avatar: 'https://cdn.example/a.webp' },
  s_linked: { id: 78, username: 'owl', chatName: 'The Owl', email_verified: true, admin: true, avatar: 'https://cdn.example/b.webp', discord: { id: '1310751771840217119' } },
}
let calls = 0
let mode = 'normal'
let lastCookie = ''

const server = http.createServer((request, response) => {
  calls++
  lastCookie = request.headers.cookie ?? ''
  if (mode === 'down') { response.statusCode = 502; return response.end('bad gateway') }
  if (mode === 'redirect') { response.statusCode = 302; response.setHeader('Location', '/login'); return response.end() }
  if (mode === 'garbage') return response.end('<html>not json</html>')
  if (mode === 'slow') return setTimeout(() => response.end('{}'), 6000)
  const sid = /(?:^|;\s*)sid=([^;]+)/.exec(lastCookie)?.[1]
  const user = sid ? USERS[sid] : undefined
  if (!user) { response.statusCode = 401; return response.end('{"error":"signed out"}') }
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify(user))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
test.after(() => server.close())

function platform(userState, extra = {}) {
  return parsePlatforms([{ id: 'partner', name: 'Partner', allowedOrigins: ['https://partner.example'], links: { account: 'https://partner.example/a', settings: 'https://partner.example/s' }, userState, ...extra }])[0]
}

test.beforeEach(() => { clearUserStateCache(); calls = 0; mode = 'normal' })

test('signed-in cookies become a namespaced principal; numeric ids are kept as strings', async () => {
  const p = platform({ url: `${base}/chat/api/me` })
  assert.deepEqual(await principalFromPlatform(p, 'sid=s_good; theme=dark'), { key: 'partner:77', platformId: 'partner', name: 'Night Owl', emailVerified: true, avatar: null, tier: null }, 'a partner\'s avatar is never used')
})

test('no cookies, unknown cookies, or a 401 mean signed out', async () => {
  const p = platform({ url: `${base}/me` })
  assert.equal(await principalFromPlatform(p, undefined), null)
  assert.equal(calls, 0, 'no cookie: the platform is not asked')
  assert.equal(await principalFromPlatform(p, 'sid=nobody'), null)
})

test('only allow-listed cookies are forwarded', async () => {
  const p = platform({ url: `${base}/me`, cookies: ['sid'] })
  await principalFromPlatform(p, 'tracking=abc; sid=s_good; other=1')
  assert.equal(lastCookie, 'sid=s_good')
  assert.equal(await principalFromPlatform(p, 'tracking=abc'), null)
  assert.equal(forwardedCookies('a=1; b=2', null), 'a=1; b=2')
})

test('answers are cached per cookie set', async () => {
  const p = platform({ url: `${base}/me` })
  await principalFromPlatform(p, 'sid=s_good')
  await principalFromPlatform(p, 'sid=s_good')
  await principalFromPlatform(p, 'sid=nobody')
  await principalFromPlatform(p, 'sid=nobody')
  assert.equal(calls, 2)
  // Past the signed-in TTL the platform is asked again.
  await principalFromPlatform(p, 'sid=s_good', Date.now() + 31_000)
  assert.equal(calls, 3)
})

test('a redirect (login page) is signed out and never followed', async () => {
  mode = 'redirect'
  assert.equal(await principalFromPlatform(platform({ url: `${base}/me` }), 'sid=s_good'), null)
  assert.equal(calls, 1)
})

test('a broken endpoint is "unavailable", never a silent sign-out', async () => {
  for (const broken of ['down', 'garbage']) {
    clearUserStateCache()
    mode = broken
    await assert.rejects(principalFromPlatform(platform({ url: `${base}/me` }), 'sid=s_good'), UserStateUnavailable)
  }
})

test('custom field names reach into nested answers', async () => {
  const nested = http.createServer((_request, response) => response.end(JSON.stringify({ user: { uid: 'u_9', handle: 'neo', verified: true } })))
  await new Promise((resolve) => nested.listen(0, '127.0.0.1', resolve))
  try {
    const p = platform({ url: `http://127.0.0.1:${nested.address().port}/me`, fields: { id: 'user.uid', name: 'user.handle', emailVerified: 'user.verified', avatar: null } })
    const principal = await principalFromPlatform(p, 'sid=x')
    assert.equal(principal.key, 'partner:u_9')
    assert.equal(principal.name, 'neo')
    assert.equal(principal.emailVerified, true)
  } finally {
    nested.close()
  }
})

test('config: proxy-only platforms need no secret; reserved ids and bad field names are refused', () => {
  const p = platform({ url: 'https://partner.example/chat/api/me' })
  assert.equal(p.secret, null)
  assert.deepEqual(p.userState.fields, { id: 'id', name: 'username', emailVerified: 'email_verified', avatar: 'avatar', discordId: null, admin: null, displayName: null })
  const bad = (overrides, re) => assert.throws(() => parsePlatforms([{ id: 'partner', name: 'P', allowedOrigins: ['https://partner.example'], links: { account: 'https://partner.example/a', settings: 'https://partner.example/s' }, ...overrides }]), re)
  bad({}, /needs userState/)
  bad({ userState: { url: 'https://partner.example/me', fields: { discordId: 'discord.id' } } }, /need trusted: true/)
  bad({ userState: { url: 'https://partner.example/me', fields: { admin: 'admin' } } }, /need trusted: true/)
  bad({ id: 'assets', userState: { url: 'https://p.example/me' } }, /reserved/)
  bad({ userState: { url: 'http://partner.example/me' } }, /userState.url must be https/)
  bad({ userState: { url: 'https://p.example/me', fields: { id: 'a b' } } }, /not a field name/)
  bad({ userState: { url: 'https://p.example/me', cookies: [] } }, /non-empty list/)
  bad({ issuer: 'https://p.example', userState: { url: 'https://p.example/me' } }, /issuer and secret go together/)
})

test('localStorage logins: a bearer token is forwarded only when the platform names tokenStorageKey', async () => {
  // abulxt's /api/auth/me shape: 401 when signed out, { user: { id, username, emailVerified } } when signed in.
  let seen = { authorization: null, cookie: null, count: 0 }
  const tokenSite = http.createServer((request, response) => {
    seen = { authorization: request.headers.authorization ?? null, cookie: request.headers.cookie ?? null, count: seen.count + 1 }
    if (request.headers.authorization !== 'Bearer tok_good_123456') { response.statusCode = 401; return response.end('{"error":"Sign in to continue."}') }
    response.end(JSON.stringify({ user: { id: 2921, username: 'midnight', emailVerified: true } }))
  })
  await new Promise((resolve) => tokenSite.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${tokenSite.address().port}/api/auth/me`
    const fields = { id: 'user.id', name: 'user.username', emailVerified: 'user.emailVerified', avatar: null }
    const withKey = platform({ url, fields, tokenStorageKey: 'abulxt:auth-token' })
    const principal = await principalFromPlatform(withKey, { authorization: 'Bearer tok_good_123456' })
    assert.equal(principal.key, 'partner:2921')
    assert.equal(principal.name, 'midnight')
    assert.equal(seen.authorization, 'Bearer tok_good_123456')
    assert.equal(seen.cookie, null, 'no cookie header is invented')

    // A wrong token is signed out, cached separately from the good one.
    assert.equal(await principalFromPlatform(withKey, { authorization: 'Bearer tok_wrong_123456' }), null)
    assert.equal((await principalFromPlatform(withKey, { authorization: 'Bearer tok_good_123456' })).key, 'partner:2921')

    // Header injection or non-bearer schemes never leave holt.
    clearUserStateCache()
    const before = seen.count
    for (const bad of ['Bearer tok_good_123456\r\nX-Evil: 1', 'Basic dXNlcjpwYXNz', 'Bearer short', 'Bearer a b c d e f g h']) {
      assert.equal(await principalFromPlatform(withKey, { authorization: bad }), null)
    }
    assert.equal(seen.count, before, 'malformed Authorization: the platform is not asked')

    // Without tokenStorageKey the header is dropped, even a valid one.
    const cookiesOnly = platform({ url, fields })
    assert.equal(cookiesOnly.userState.tokenStorageKey, null)
    assert.equal(await principalFromPlatform(cookiesOnly, { authorization: 'Bearer tok_good_123456' }), null)
    assert.equal(seen.count, before, 'cookie-only platform: no request without cookies')
  } finally {
    tokenSite.close()
  }
})

test('config: tokenStorageKey must be a plain storage key', () => {
  assert.throws(() => platform({ url: 'https://partner.example/me', tokenStorageKey: 'bad key"' }), /tokenStorageKey is not a storage key/)
  assert.equal(platform({ url: 'https://partner.example/me', tokenStorageKey: 'abulxt:auth-token' }).userState.tokenStorageKey, 'abulxt:auth-token')
})

test('nocturne-style platform: raw token in X-Noc-Session, {authenticated, user}, verified unless emailNotice', async () => {
  let seen = { header: null, auth: null, count: 0 }
  const noc = http.createServer((request, response) => {
    seen = { header: request.headers['x-noc-session'] ?? null, auth: request.headers.authorization ?? null, count: seen.count + 1 }
    response.setHeader('Content-Type', 'application/json')
    // nocturne answers 200 either way; signed out is {"authenticated":false}.
    if (request.headers['x-noc-session'] === 'noc_good_token_1') return response.end(JSON.stringify({ authenticated: true, user: { id: 501, name: 'Moon', emailNotice: null } }))
    if (request.headers['x-noc-session'] === 'noc_unverified_2') return response.end(JSON.stringify({ authenticated: true, user: { id: 502, username: 'Star', emailNotice: { kind: 'verify' } } }))
    response.end('{"authenticated":false}')
  })
  await new Promise((resolve) => noc.listen(0, '127.0.0.1', resolve))
  try {
    const p = platform({
      url: `http://127.0.0.1:${noc.address().port}/api/auth/me`,
      tokenStorageKey: 'noc-session',
      tokenHeader: 'X-Noc-Session',
      fields: { id: 'user.id', name: 'user.username|user.name|user.displayName', emailVerified: '!user.emailNotice', avatar: 'user.avatar|user.avatarUrl' },
    })
    assert.deepEqual(p.userState.tokenHeader, { name: 'x-noc-session', bearer: false })
    const moon = await principalFromPlatform(p, { authorization: 'Bearer noc_good_token_1' })
    assert.equal(seen.header, 'noc_good_token_1', 'the raw token goes in X-Noc-Session')
    assert.equal(seen.auth, null, 'no Authorization header is sent to the platform')
    assert.deepEqual([moon.key, moon.name, moon.emailVerified], ['partner:501', 'Moon', true], 'name from the fallback list; no notice = verified')
    const star = await principalFromPlatform(p, { authorization: 'Bearer noc_unverified_2' })
    assert.deepEqual([star.key, star.name, star.emailVerified], ['partner:502', 'Star', false], 'a verify-email notice = not verified')
    assert.equal(await principalFromPlatform(p, { authorization: 'Bearer noc_unknown_token' }), null, '{"authenticated":false} is signed out')
  } finally {
    noc.close()
  }
})

test('config: token headers that could redirect a visitor token are refused', () => {
  for (const bad of ['Cookie', 'host', 'X-Holt-License', 'X-Holt-Principal', 'bad header', 'content-length']) {
    assert.throws(() => platform({ url: 'https://partner.example/me', tokenStorageKey: 'k', tokenHeader: bad }), /tokenHeader/, bad)
  }
  assert.deepEqual(platform({ url: 'https://partner.example/me', tokenStorageKey: 'k' }).userState.tokenHeader, { name: 'authorization', bearer: true })
})

test('a trusted platform vouches for a linked Discord account, site admin, display name and avatar', async () => {
  const fields = { id: 'id', name: 'username', emailVerified: 'email_verified', avatar: 'avatar', discordId: 'discord.id', admin: 'admin', displayName: 'chatName' }
  const trusted = platform({ url: `${base}/chat/api/me`, fields }, { trusted: true })
  assert.deepEqual(await principalFromPlatform(trusted, 'sid=s_linked'), {
    key: 'partner:78', platformId: 'partner', name: 'The Owl', emailVerified: true, avatar: 'https://cdn.example/b.webp', tier: null,
    discordId: '1310751771840217119', admin: true,
  })
})
