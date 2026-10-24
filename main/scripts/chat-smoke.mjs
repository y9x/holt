// Signed-in smoke test of the chat API's write paths with the dedicated holt-test account (owner-approved
// 2026-10-24; it may post in #off-topic only, and deletes what it posts). Used to verify phase 1 changes
// before and after: perms, send, edit, react, unreact, delete, and that history shows the right author.
//
//   CHAT_API=https://abstracteducation.loan/api/discord/bridge \
//   HOLT_TEST_TOKEN_FILE=~/.holt-test-token node main/scripts/chat-smoke.mjs
//
// Straight at holt on amph: CHAT_API=http://127.0.0.1:8830/abulxt/_holt/api/discord/bridge
//   HOLT_TEST_TOKEN_FILE=/root/holt-test/token HOLT_LICENSE_FILE=/root/holt-licenses/abulxt.license
//
// Prints no token. Exits non-zero on the first failed check, after deleting the test message if it got
// that far.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const API = (process.env.CHAT_API || 'https://abstracteducation.loan/api/discord/bridge').replace(/\/+$/, '')
const tokenFile = (process.env.HOLT_TEST_TOKEN_FILE || '~/.holt-test-token').replace(/^~/, homedir())
const TOKEN = readFileSync(tokenFile, 'utf8').trim()
// Straight at holt (bypassing a platform's proxy): send the platform's license like its proxy would.
const LICENSE = process.env.HOLT_LICENSE_FILE ? readFileSync(process.env.HOLT_LICENSE_FILE.replace(/^~/, homedir()), 'utf8').trim() : null
const CHANNEL_NAME = 'off-topic'

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${String(detail).slice(0, 220)}`}`)
  return ok
}

async function call(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(LICENSE ? { 'X-Holt-License': LICENSE } : {}), ...(init.headers || {}) },
  })
  let body = null
  try { body = await response.json() } catch { /* not JSON */ }
  return { status: response.status, body }
}

const guilds = await call('/guilds')
const guildId = (guilds.body?.guilds || [])[0]?.id
const channels = await call(`/channels?guild=${guildId}`)
const channel = (channels.body?.channels || []).find((c) => c.name === CHANNEL_NAME)
if (!check(`found #${CHANNEL_NAME}`, Boolean(channel), JSON.stringify(channels.body).slice(0, 200))) process.exit(1)
const channelId = channel.channelId

const perms = await call(`/perms?channel=${channelId}`)
check('perms: signed in, can send', perms.status === 200 && perms.body?.canSend === true, JSON.stringify(perms.body))
const ownerKey = perms.body?.ownerKey
check('perms: own chat key is abulxt:<id>', /^abulxt:\d+$/.test(ownerKey || ''), ownerKey)
check('perms: selfKeys carry both key forms', Array.isArray(perms.body?.embedSuppress?.selfKeys) && perms.body.embedSuppress.selfKeys.some((k) => /^abulxt:/.test(k)) && perms.body.embedSuppress.selfKeys.some((k) => /^user:/.test(k)), JSON.stringify(perms.body?.embedSuppress?.selfKeys))

const stamp = new Date().toISOString()
let messageId = null
try {
  const sent = await call('/send', { method: 'POST', body: JSON.stringify({ channelId, content: `holt-test check ${stamp} (deleted automatically)`, clientId: `holt-test-${Date.now()}` }) })
  messageId = sent.body?.message?.id ?? null
  check('send: accepted', (sent.status === 200 || sent.status === 201) && messageId !== null, JSON.stringify(sent.body))
  check('send: stored under the chat key', sent.body?.message?.authorKey === ownerKey, sent.body?.message?.authorKey)

  if (messageId !== null) {
    const edited = await call('/edit', { method: 'POST', body: JSON.stringify({ messageId, content: `holt-test check ${stamp} (edited, deleted automatically)` }) })
    check('edit: own message', edited.status === 200 && /edited/.test(edited.body?.message?.content || ''), JSON.stringify(edited.body))

    const reacted = await call('/react', { method: 'POST', body: JSON.stringify({ messageId, emoji: '👍' }) })
    const mine = (reacted.body?.reactions || []).find((r) => r.emoji === '👍')
    check('react: added, counted as mine', reacted.status === 200 && Boolean(mine) && (mine.me === true || (Array.isArray(mine.reactors) && mine.reactors.includes(ownerKey)) || mine.count >= 1), JSON.stringify(reacted.body))
    const unreacted = await call('/react', { method: 'POST', body: JSON.stringify({ messageId, emoji: '👍' }) })
    check('react again: removed', unreacted.status === 200 && !(unreacted.body?.reactions || []).some((r) => r.emoji === '👍' && r.count > 0), JSON.stringify(unreacted.body))

    const history = await call(`/history?channel=${channelId}&limit=20`)
    const row = (history.body?.messages || []).find((m) => m.id === messageId)
    check('history: shows it with the chat key and the account name', Boolean(row) && row.authorKey === ownerKey && /holt-test/.test(row.authorName || ''), JSON.stringify(row))
  }
} finally {
  if (messageId !== null) {
    const deleted = await call('/delete', { method: 'POST', body: JSON.stringify({ messageId }) })
    check('delete: own message', deleted.status === 200, JSON.stringify(deleted.body))
  }
}

console.log(`\n${failed === 0 ? 'all checks passed' : `${failed} check(s) failed`}`)
process.exit(failed ? 1 : 0)
