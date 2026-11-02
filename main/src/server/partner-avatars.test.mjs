import test from 'node:test'
import assert from 'node:assert/strict'
import { isPublicAddress, acceptableSourceUrl } from './partner-avatars.ts'
import { parseModerationVerdict, readModerationProvider } from './avatar-moderation.ts'
import { issueSession, readSession } from './session.ts'
import { signPrincipal, readPrincipal } from './chat-caller.ts'

test('only globally routable addresses are fetched', () => {
  for (const a of ['1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(a), true, a)
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.5.64', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:a00:1::', 'not-an-ip']) {
    assert.equal(isPublicAddress(a), false, a)
  }
})

test('source URLs: https on the default port, no credentials, no internal names or addresses', () => {
  assert.ok(acceptableSourceUrl('https://cdn.nocturne.lol/a/b.png?v=2'))
  assert.ok(acceptableSourceUrl('https://8.8.8.8/a.png'))
  for (const u of ['http://cdn.nocturne.lol/a.png', 'https://cdn.nocturne.lol:8443/a.png', 'https://u:p@cdn.nocturne.lol/a.png',
    'https://localhost/a.png', 'https://intranet/a.png', 'https://box.internal/a.png', 'https://127.0.0.1/a.png', 'https://[::1]/a.png',
    'https://169.254.169.254/latest', 'data:image/png;base64,AA', `https://cdn.nocturne.lol/${'a'.repeat(3000)}`, 'nonsense']) {
    assert.equal(acceptableSourceUrl(u), null, u)
  }
})

test('the verdict parser fails closed', () => {
  const ok = parseModerationVerdict('{"nonce":"n1","allowed":true,"categories":[],"reason":"Fine."}', 'n1', 'm')
  assert.equal(ok.decision, 'approved')
  assert.equal(parseModerationVerdict('{"nonce":"WRONG","allowed":true,"categories":[],"reason":"Fine."}', 'n1', 'm').decision, 'pending')
  assert.equal(parseModerationVerdict('sure! {"allowed":true}', 'n1', 'm').decision, 'pending')
  assert.equal(parseModerationVerdict('{"nonce":"n1","allowed":true,"categories":[],"reason":"x","approved":true}', 'n1', 'm').decision, 'pending')
  const bad = parseModerationVerdict('{"allowed":false,"categories":["gore"],"reason":"Blood."}', 'other', 'm')
  assert.equal(bad.decision, 'rejected')
  assert.deepEqual(bad.categories, ['gore'])
})

test('moderation provider config', () => {
  assert.equal(readModerationProvider(undefined), null)
  assert.equal(readModerationProvider({ baseUrl: 'nope' }), null)
  assert.deepEqual(readModerationProvider({ baseUrl: 'http://10.0.0.5:8317/v1/', apiKey: 'k' }),
    { baseUrl: 'http://10.0.0.5:8317/v1', apiKey: 'k', model: 'kimi-k3.1-pro-highspeed', timeoutMs: 60_000 })
})

test('a partner avatar source survives the session and the signed principal', () => {
  const secret = 'x'.repeat(40)
  const principal = { key: 'nocturne:1', platformId: 'nocturne', name: 'n', emailVerified: true, avatar: null, avatarSource: 'https://cdn.nocturne.lol/a.png', tier: null }
  const back = readSession(issueSession(principal, secret), secret)
  assert.equal(back.avatar, null)
  assert.equal(back.avatarSource, 'https://cdn.nocturne.lol/a.png')
  assert.equal(readPrincipal(signPrincipal(back, secret), secret).avatarSource, 'https://cdn.nocturne.lol/a.png')
  const none = readSession(issueSession({ ...principal, avatarSource: undefined }, secret), secret)
  assert.equal('avatarSource' in none, false)
})

test('a relative avatar path resolves against the platform\'s user-state URL', async () => {
  const { principalFromUserState } = await import('./forward-auth.ts')
  const platform = { id: 'nocturne', identityNamespace: 'nocturne', trusted: false }
  const config = { url: 'https://nocturne.lol/api/auth/me', fields: { id: 'user.id', name: 'user.username', emailVerified: 'user.ok', avatar: 'user.avatar' } }
  const p = principalFromUserState(platform, config, { user: { id: 5, username: 'n', ok: true, avatar: '/uploads/5.png' } })
  assert.equal(p.avatar, null)
  assert.equal(p.avatarSource, 'https://nocturne.lol/uploads/5.png')
})
