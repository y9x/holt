// holt lab: a test partner site with its own account system, used to prove holt's embedding, licensing
// and federation the way a real partner would use them. It copies nocturne.lol's scheme on purpose
// (observed 2026-10-24): login returns a `sessionToken`, the page keeps it in localStorage under
// `lab-session` and sends it as `X-Lab-Session`; `GET /api/auth/me` answers 200 with
// `{"authenticated":false}` or `{"authenticated":true,"user":{id,username,emailNotice}}`.
//
// No dependencies. Users and sessions live in $LAB_DATA/state.json. Not a product: test accounts only.
//
//   GET  /                      sign in / sign up, who am I, link to /chat/
//   GET  /account               the lab's own account page (holt's account links point here)
//   POST /api/auth/signup       { username, password } -> { sessionToken, user }
//   POST /api/auth/login        { username, password } -> { sessionToken, user }
//   POST /api/auth/logout       X-Lab-Session -> { ok }
//   GET  /api/auth/me           X-Lab-Session -> { authenticated, user? }
//   /chat/*                     proxied to holt by the lab's web server (OpenResty), never by this process

import http from 'node:http'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const PORT = Number(process.env.LAB_PORT || 8840)
const DATA = process.env.LAB_DATA || path.resolve('lab-data')
const STATE_FILE = path.join(DATA, 'state.json')
const USERNAME = /^[A-Za-z0-9_-]{3,24}$/
const MAX_BODY = 4096

mkdirSync(DATA, { recursive: true, mode: 0o700 })
let state = { nextId: 1, users: {}, sessions: {} }
try { state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { /* first start */ }
function save() {
  const tmp = `${STATE_FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
  renameSync(tmp, STATE_FILE)
}

const hash = (password, salt) => scryptSync(password, salt, 32).toString('base64url')
const publicUser = (u) => ({ id: u.id, username: u.username, emailNotice: null })

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(body))
}

async function body(request) {
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY) return null
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return null }
}

function sessionUser(request) {
  const token = request.headers['x-lab-session']
  if (typeof token !== 'string' || !state.sessions[token]) return null
  return state.users[state.sessions[token]] ?? null
}

function newSession(user) {
  const token = randomBytes(24).toString('base64url')
  state.sessions[token] = user.id
  save()
  return token
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>holt lab</title><style>
:root{color-scheme:light dark;--bg:#0f1115;--fg:#e8e8ea;--muted:#9aa0a6;--line:#2a2e36;--accent:#7aa2f7}
@media (prefers-color-scheme:light){:root{--bg:#fff;--fg:#16181d;--muted:#5f6368;--line:#dde1e6;--accent:#2f5bd3}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}main{max-width:520px;margin:0 auto;padding:32px 16px}
h1{font-size:22px;margin:0 0 4px}p{color:var(--muted);margin:0 0 20px}form{display:grid;gap:8px;margin:16px 0}
input,button{font:inherit;padding:8px 10px;border-radius:6px;border:1px solid var(--line);background:transparent;color:inherit}
button{background:var(--accent);color:#fff;border:0;cursor:pointer}.row{display:flex;gap:8px}.row button{flex:1}a{color:var(--accent)}
#who{padding:10px 12px;border:1px solid var(--line);border-radius:8px}</style></head><body><main>
<h1>holt lab</h1><p>A test partner site with its own accounts, for checking holt's embedding, licensing and federation.</p>
<div id="who">Checking who is signed in…</div>
<form id="auth"><input id="username" placeholder="username" autocomplete="username" required minlength="3" maxlength="24">
<input id="password" type="password" placeholder="password" autocomplete="current-password" required minlength="8">
<div class="row"><button type="submit" data-act="login">Sign in</button><button type="submit" data-act="signup">Sign up</button></div></form>
<p><a href="/chat/">Open the chat</a> · <a href="/account">Account</a> · <a href="#" id="logout">Sign out</a></p>
<script>
const KEY = 'lab-session'
const api = (path, init = {}) => fetch(path, { ...init, credentials: 'omit', headers: { 'Content-Type': 'application/json', ...(localStorage.getItem(KEY) ? { 'X-Lab-Session': localStorage.getItem(KEY) } : {}) } }).then((r) => r.json())
async function who() { const me = await api('/api/auth/me'); document.getElementById('who').textContent = me.authenticated ? 'Signed in as ' + me.user.username + ' (lab:' + me.user.id + ')' : 'Not signed in.' }
let act = 'login'
document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => { act = b.dataset.act }))
document.getElementById('auth').addEventListener('submit', async (e) => {
  e.preventDefault()
  const r = await api('/api/auth/' + act, { method: 'POST', body: JSON.stringify({ username: username.value, password: password.value }) })
  if (r.sessionToken) localStorage.setItem(KEY, r.sessionToken); else alert(r.error || 'failed')
  who()
})
document.getElementById('logout').addEventListener('click', async (e) => { e.preventDefault(); await api('/api/auth/logout', { method: 'POST' }); localStorage.removeItem(KEY); who() })
who()
</script></main></body></html>`

const ACCOUNT = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>holt lab account</title></head>
<body style="font:15px system-ui;max-width:520px;margin:32px auto;padding:0 16px"><h1>holt lab account</h1><p id="me">…</p><p><a href="/">Back</a></p>
<script>fetch('/api/auth/me',{headers:localStorage.getItem('lab-session')?{'X-Lab-Session':localStorage.getItem('lab-session')}:{}}).then(r=>r.json()).then(m=>{document.getElementById('me').textContent=m.authenticated?'You are '+m.user.username+' (lab:'+m.user.id+').':'Not signed in.'})</script></body></html>`

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://lab.local')
  try {
    if (url.pathname === '/healthz') return json(response, 200, { ok: true })
    if (request.method === 'GET' && url.pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return response.end(PAGE) }
    if (request.method === 'GET' && url.pathname === '/account') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return response.end(ACCOUNT) }
    if (url.pathname === '/api/auth/me' && request.method === 'GET') {
      const user = sessionUser(request)
      return json(response, 200, user ? { authenticated: true, user: publicUser(user) } : { authenticated: false })
    }
    if ((url.pathname === '/api/auth/signup' || url.pathname === '/api/auth/login') && request.method === 'POST') {
      const b = await body(request)
      if (!b || typeof b.username !== 'string' || typeof b.password !== 'string') return json(response, 400, { error: 'username and password are required' })
      const username = b.username.trim()
      const existing = Object.values(state.users).find((u) => u.username.toLowerCase() === username.toLowerCase())
      if (url.pathname.endsWith('signup')) {
        if (!USERNAME.test(username)) return json(response, 400, { error: 'username: 3-24 letters, digits, _ or -' })
        if (b.password.length < 8) return json(response, 400, { error: 'password: at least 8 characters' })
        if (existing) return json(response, 409, { error: 'that username is taken' })
        const salt = randomBytes(16).toString('base64url')
        const user = { id: String(state.nextId++), username, salt, hash: hash(b.password, salt) }
        state.users[user.id] = user
        return json(response, 201, { sessionToken: newSession(user), user: publicUser(user) })
      }
      if (!existing) return json(response, 401, { error: 'wrong username or password' })
      const ok = timingSafeEqual(Buffer.from(hash(b.password, existing.salt)), Buffer.from(existing.hash))
      if (!ok) return json(response, 401, { error: 'wrong username or password' })
      return json(response, 200, { sessionToken: newSession(existing), user: publicUser(existing) })
    }
    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      const token = request.headers['x-lab-session']
      if (typeof token === 'string' && state.sessions[token]) { delete state.sessions[token]; save() }
      return json(response, 200, { ok: true })
    }
    json(response, 404, { error: 'not found' })
  } catch (error) {
    console.error('[holt-lab]', error instanceof Error ? error.message : error)
    if (!response.headersSent) json(response, 500, { error: 'internal error' })
  }
})
server.listen(PORT, '127.0.0.1', () => console.log(`[holt-lab] listening on 127.0.0.1:${PORT}, data in ${DATA}`))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)))
