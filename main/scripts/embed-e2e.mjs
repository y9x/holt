// End-to-end check of the COMPILED embed (main/dist, from `make build`) in a real Chrome, framed
// cross-site by a fake partner page whose backend mints identity tokens. This is the "load the route
// in a compiled build" gate: text must reveal (no stuck dash placeholders), with no console, CSP or
// shield errors, and every account action must send the TOP page to the platform's own URL.
//
//   make e2e                                   (builds first)
//   cd main && npm run e2e                     (uses the existing dist)
//   CHROME_PATH=/path/to/chrome npm run e2e    (default /usr/bin/google-chrome)
//
// Starts its own holt (temp config, free ports) and two partner origins: one allowed, one not.
//
// Chrome runs with the automation flag hidden. With it, navigator.webdriver is true and HolyText's
// bot gate (holy-render.ts resolveHoly) keeps the dashes on purpose, which is not what a user sees.
// Out-of-process iframes are disabled so one CDP session can read the frame's accessibility tree:
// HolyText reveals into closed shadow roots, which DOM queries cannot read but the AX tree can.

import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { signJwt } from '../src/server/jwt.ts'
import { mintLicense } from '../src/server/license.ts'

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome'
const SECRET = 'e2e-platform-secret-0123456789abcdef0123456789'

if (!existsSync(path.join(APP, 'dist', 'index.html'))) {
  console.error('embed-e2e: main/dist is missing; run `make build` first')
  process.exit(2)
}

function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

const holtPort = await freePort()
const partnerPort = await freePort()
const strangerPort = await freePort()
const holtOrigin = `http://127.0.0.1:${holtPort}`
const partnerOrigin = `http://localhost:${partnerPort}`

// Licensing is on, as in production: every embed needs a license minted with this secret.
const LICENSE_SECRET = 'e2e-license-secret-0123456789abcdef0123456789abcdef'
const license = (platform, options = {}) => mintLicense(LICENSE_SECRET, { platform, ...options })
const LICENSES = { partner: license('partner').token, proxied: license('proxied').token, tokened: license('tokened').token }
const REVOKED = license('proxied')
const EXPIRED = mintLicense(LICENSE_SECRET, { platform: 'proxied', days: 1 }, Date.now() - 2 * 86_400_000)

const tempDir = mkdtempSync(path.join(tmpdir(), 'holt-e2e-'))
const configFile = path.join(tempDir, 'config.js')
writeFileSync(configFile, `export default ${JSON.stringify({
  port: holtPort,
  publicOrigin: holtOrigin,
  sessionSecret: 'e2e-session-secret-0123456789abcdef0123456789abcdef',
  admins: [],
  licensing: { secret: LICENSE_SECRET, revoked: [REVOKED.license.lid] },
  platforms: [{
    id: 'partner',
    name: 'Partner',
    issuer: partnerOrigin,
    secret: SECRET,
    allowedOrigins: [partnerOrigin],
    links: {
      account: `${partnerOrigin}/account`,
      settings: `${partnerOrigin}/settings`,
      verifyEmail: `${partnerOrigin}/verify`,
      signIn: `${partnerOrigin}/login`,
    },
  }, {
    // Proxy embedding: the same partner site serves holt under its own /chat/ (see partnerServer).
    id: 'proxied',
    name: 'Partner',
    allowedOrigins: [partnerOrigin],
    links: {
      account: `${partnerOrigin}/account`,
      settings: `${partnerOrigin}/settings`,
      verifyEmail: `${partnerOrigin}/verify`,
      signIn: `${partnerOrigin}/login`,
    },
    userState: { url: `${partnerOrigin}/chat/api/me`, cookies: ['sid'] },
  }, {
    // Proxy embedding for a site that keeps its login in localStorage (like abulxt): mounted at /tchat/.
    id: 'tokened',
    name: 'Partner',
    allowedOrigins: [partnerOrigin],
    links: { account: `${partnerOrigin}/account`, settings: `${partnerOrigin}/settings` },
    userState: {
      url: `${partnerOrigin}/tchat/api/me`,
      fields: { id: 'user.id', name: 'user.username', emailVerified: 'user.emailVerified', avatar: null },
      tokenStorageKey: 'partner:auth-token',
    },
  }],
})}\n`)

function partnerPage(guest) {
  const getToken = guest ? 'Promise.resolve(null)' : "fetch('/token').then((r) => r.text())"
  return `<!doctype html><html><head><title>Partner</title></head><body>
<h1>Partner page</h1><div id="chat"></div>
<script src="${holtOrigin}/holt-embed.js"></script>
<script>
  Holt.mount({ origin: '${holtOrigin}', platform: 'partner', license: '${LICENSES.partner}', container: document.getElementById('chat'), height: '220px', getToken: () => ${getToken} })
</script></body></html>`
}

// What a partner's nginx does for proxy embedding, in a few lines:
//   location /chat/api/ { <its own backend> }          -> the user-state answer below (cookie sid)
//   location /chat/     { proxy_pass <holt>/proxied/; } -> forwarded to holt, cookies and all
function proxyToHolt(request, response, rest, platformId = 'proxied') {
  const upstream = http.request({
    host: '127.0.0.1',
    port: holtPort,
    method: request.method,
    path: `/${platformId}/${rest}`,
    // What the partner's proxy adds: its license (proxy_set_header X-Holt-License …). Overrides any the browser sent.
    headers: { ...request.headers, host: `127.0.0.1:${holtPort}`, 'x-holt-license': LICENSES[platformId] },
  }, (answer) => {
    response.writeHead(answer.statusCode ?? 502, answer.headers)
    answer.pipe(response)
  })
  upstream.on('error', () => { response.statusCode = 502; response.end() })
  request.pipe(upstream)
}

function partnerServer(port) {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://partner.local')
      if (url.pathname === '/chat/api/me') {
        const signedIn = /(?:^|;\s*)sid=s_good(?:;|$)/.test(request.headers.cookie ?? '')
        response.setHeader('Content-Type', 'application/json')
        if (!signedIn) { response.statusCode = 401; return response.end('{"error":"signed out"}') }
        return response.end(JSON.stringify({ id: 77, username: 'Night Owl', email_verified: false }))
      }
      if (url.pathname.startsWith('/chat/')) return proxyToHolt(request, response, request.url.slice('/chat/'.length))
      // The localStorage-login partner: abulxt's /api/auth/me shape, keyed by a bearer token, no cookies.
      if (url.pathname === '/tchat/api/me') {
        response.setHeader('Content-Type', 'application/json')
        if (request.headers.authorization !== 'Bearer tok_good_123456') { response.statusCode = 401; return response.end('{"error":"Sign in to continue."}') }
        return response.end(JSON.stringify({ user: { id: 2921, username: 'midnight', emailVerified: true } }))
      }
      if (url.pathname.startsWith('/tchat/')) return proxyToHolt(request, response, request.url.slice('/tchat/'.length), 'tokened')
      if (url.pathname === '/token') {
        const iat = Math.floor(Date.now() / 1000)
        response.end(signJwt({ iss: partnerOrigin, aud: 'holt', sub: 'u_77', iat, exp: iat + 120, jti: `e2e-${Math.random()}`, name: 'Night Owl', email_verified: false }, SECRET))
        return
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      if (url.pathname === '/' || url.pathname === '/guest') return response.end(partnerPage(url.pathname === '/guest'))
      response.end(`<!doctype html><title>${url.pathname}</title><p>landed</p>`)
    })
    server.listen(port, 'localhost', () => resolve(server))
  })
}

const results = []
function check(name, ok, detail = '') {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`)
}

async function axText(page) {
  const cdp = await page.context().newCDPSession(page)
  const { frameTree } = await cdp.send('Page.getFrameTree')
  const frameIds = [frameTree.frame.id, ...(frameTree.childFrames ?? []).map((child) => child.frame.id)]
  const names = []
  for (const frameId of frameIds) {
    const { nodes } = await cdp.send('Accessibility.getFullAXTree', { frameId })
    for (const node of nodes) if (node.name?.value) names.push(node.name.value)
  }
  return names.join(' | ')
}

function watch(page) {
  const problems = []
  page.on('console', (message) => {
    if (message.type() === 'error' || /Refused|shield|tamper/i.test(message.text())) problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  return problems
}

async function waitForHolt() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      if ((await fetch(`${holtOrigin}/healthz`)).ok) return
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('holt did not start')
}

const holt = spawn(process.execPath, ['--import', 'tsx', 'src/server/holt-service.ts'], {
  cwd: APP,
  env: { ...process.env, HOLT_CONFIG: configFile },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let holtLog = ''
holt.stdout.on('data', (chunk) => { holtLog += chunk })
holt.stderr.on('data', (chunk) => { holtLog += chunk })
const partners = await Promise.all([partnerServer(partnerPort), partnerServer(strangerPort)])
let browser

try {
  await waitForHolt()
  browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--disable-features=IsolateOrigins,site-per-process', '--disable-site-isolation-trials', '--disable-blink-features=AutomationControlled'],
  })

  // Signed in, email unverified.
  {
    const page = await browser.newPage()
    const problems = watch(page)
    await page.goto(`${partnerOrigin}/`)
    const actions = page.frameLocator('iframe').locator('button.holt-action')
    await actions.first().waitFor({ timeout: 15000 })
    await page.waitForTimeout(400)
    const ax = await axText(page)
    check('signed in: name and copy reveal', ax.includes('Signed in as') && ax.includes('Night Owl') && ax.includes('Verify your email to chat.'), ax.slice(0, 240))
    check('signed in: Account, Settings, Verify email offered', ['Account', 'Settings', 'Verify email'].every((label) => ax.includes(label)), ax.slice(0, 240))
    check('signed in: no stuck dash placeholders', !/-{4,}/.test(ax), ax.slice(0, 240))
    check('signed in: no console, CSP or shield errors', problems.length === 0, problems.join(' || ').slice(0, 300))
    await actions.first().click()
    await page.waitForURL(`${partnerOrigin}/account`, { timeout: 5000 }).catch(() => {})
    check('signed in: Account sends the top page to the platform account URL', page.url() === `${partnerOrigin}/account`, page.url())
    await page.close()
  }

  // Guest.
  {
    const page = await browser.newPage()
    const problems = watch(page)
    await page.goto(`${partnerOrigin}/guest`)
    const actions = page.frameLocator('iframe').locator('button.holt-action')
    await actions.first().waitFor({ timeout: 15000 })
    await page.waitForTimeout(400)
    const ax = await axText(page)
    check('guest: guest copy and Sign in reveal', ax.includes('Browsing as a guest.') && ax.includes('Sign in to chat.'), ax.slice(0, 240))
    check('guest: no errors', problems.length === 0, problems.join(' || ').slice(0, 300))
    await actions.first().click()
    await page.waitForURL(`${partnerOrigin}/login`, { timeout: 5000 }).catch(() => {})
    check('guest: Sign in sends the top page to the platform sign-in URL', page.url() === `${partnerOrigin}/login`, page.url())
    await page.close()
  }

  // An origin outside the platform's allowedOrigins may not frame holt.
  {
    const page = await browser.newPage()
    const problems = watch(page)
    await page.goto(`http://localhost:${strangerPort}/`)
    await page.waitForTimeout(2500)
    check('stranger origin: framing refused by CSP frame-ancestors', problems.some((problem) => /frame-ancestors|Refused to frame/i.test(problem)), problems.join(' || ').slice(0, 300))
    await page.close()
  }

  // Proxy embedding, signed in: the partner's own /chat/ serves holt; holt asks the partner who sid=s_good is.
  {
    const context = await browser.newContext()
    await context.addCookies([{ name: 'sid', value: 's_good', url: partnerOrigin }])
    const page = await context.newPage()
    const problems = watch(page)
    await page.goto(`${partnerOrigin}/chat/`)
    const actions = page.locator('button.holt-action')
    await actions.first().waitFor({ timeout: 15000 })
    await page.waitForTimeout(400)
    const ax = await axText(page)
    check('proxy, signed in: name and copy reveal on the partner origin', ax.includes('Signed in as') && ax.includes('Night Owl') && ax.includes('Verify your email to chat.'), ax.slice(0, 240))
    check('proxy, signed in: no stuck dash placeholders', !/-{4,}/.test(ax), ax.slice(0, 240))
    check('proxy, signed in: no console, CSP or shield errors', problems.length === 0, problems.join(' || ').slice(0, 300))
    await actions.first().click()
    await page.waitForURL(`${partnerOrigin}/account`, { timeout: 5000 }).catch(() => {})
    check('proxy, signed in: Account goes to the platform account URL', page.url() === `${partnerOrigin}/account`, page.url())
    await context.close()
  }

  // Proxy embedding, signed out.
  {
    const context = await browser.newContext()
    const page = await context.newPage()
    const problems = watch(page)
    await page.goto(`${partnerOrigin}/chat/`)
    const actions = page.locator('button.holt-action')
    await actions.first().waitFor({ timeout: 15000 })
    await page.waitForTimeout(400)
    const ax = await axText(page)
    check('proxy, signed out: guest copy and Sign in reveal', ax.includes('Browsing as a guest.') && ax.includes('Sign in to chat.'), ax.slice(0, 240))
    check('proxy, signed out: no errors', problems.length === 0, problems.join(' || ').slice(0, 300))
    await actions.first().click()
    await page.waitForURL(`${partnerOrigin}/login`, { timeout: 5000 }).catch(() => {})
    check('proxy, signed out: Sign in goes to the platform sign-in URL', page.url() === `${partnerOrigin}/login`, page.url())
    await context.close()
  }

  // Proxy embedding, localStorage login: the page reads the partner's token on the partner's own origin.
  {
    const context = await browser.newContext()
    const page = await context.newPage()
    const problems = watch(page)
    await page.goto(`${partnerOrigin}/landing`)
    await page.evaluate(() => localStorage.setItem('partner:auth-token', 'tok_good_123456'))
    await page.goto(`${partnerOrigin}/tchat/`)
    const actions = page.locator('button.holt-action')
    await actions.first().waitFor({ timeout: 15000 })
    await page.waitForTimeout(400)
    const ax = await axText(page)
    check('proxy, localStorage login: the partner token signs the user in', ax.includes('Signed in as') && ax.includes('midnight'), ax.slice(0, 240))
    check('proxy, localStorage login: no stuck dashes or errors', !/-{4,}/.test(ax) && problems.length === 0, problems.join(' || ').slice(0, 300))
    await page.evaluate(() => localStorage.removeItem('partner:auth-token'))
    await page.reload()
    // This platform lists no signIn link, so a guest gets no action buttons: wait for the identity text.
    await page.locator('.holt-identity p').first().waitFor({ timeout: 15000 })
    await page.waitForTimeout(800)
    check('proxy, localStorage login: no token is a guest', (await axText(page)).includes('Browsing as a guest.'))
    await context.close()
  }

  // Licensing: no license, a revoked one, an expired one, or another platform's license is refused everywhere.
  {
    const page = (headers = {}) => fetch(`${holtOrigin}/proxied/`, { headers }).then((r) => r.status)
    check('license: a proxy page without a license is refused', await page() === 403)
    check('license: a revoked license is refused', await page({ 'x-holt-license': REVOKED.token }) === 403)
    check('license: an expired license is refused', await page({ 'x-holt-license': EXPIRED.token }) === 403)
    check('license: another platform\'s license is refused', await page({ 'x-holt-license': LICENSES.tokened }) === 403)
    check('license: the platform\'s own license is accepted', await page({ 'x-holt-license': LICENSES.proxied }) === 200)
    const me = await fetch(`${holtOrigin}/proxied/_holt/me`, { headers: { 'x-holt': '1' } }).then(async (r) => ({ status: r.status, body: await r.json() }))
    check('license: the identity endpoint is refused without one', me.status === 403 && me.body.code === 'unlicensed', JSON.stringify(me))
    const embedNoLicense = await fetch(`${holtOrigin}/embed?platform=partner`).then((r) => r.status)
    check('license: an iframe embed without a license is refused', embedNoLicense === 403, String(embedNoLicense))
    const session = await fetch(`${holtOrigin}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: partnerOrigin }, body: JSON.stringify({ platform: 'partner', token: 'x' }) }).then(async (r) => ({ status: r.status, body: await r.json() }))
    check('license: the identity exchange is refused without one', session.status === 403 && session.body.code === 'unlicensed', JSON.stringify(session))
  }

  // Proxy embedding, straight at holt: identity still comes only from the partner.
  {
    // Licensed (as the partner's proxy would send), so these test the identity rules, not licensing.
    const me = (headers) => fetch(`${holtOrigin}/proxied/_holt/me`, { headers: { 'x-holt-license': LICENSES.proxied, ...headers } }).then(async (r) => ({ status: r.status, body: await r.json() }))
    const noHeader = await me({ cookie: 'sid=s_good' })
    check('proxy API: refused without the X-Holt header', noHeader.status === 403, JSON.stringify(noHeader))
    const forged = await me({ 'x-holt': '1', cookie: 'sid=forged' })
    check('proxy API: a cookie the partner does not know is a guest', forged.status === 200 && forged.body.principal === null, JSON.stringify(forged))
    const coep = await fetch(`${holtOrigin}/proxied/`, { headers: { 'x-holt-license': LICENSES.proxied } }).then((r) => r.headers.get('cross-origin-embedder-policy'))
    check('proxy page: sends COEP so a cross-origin-isolated platform page can frame it', coep === 'credentialless', String(coep))
    const iframeOnly = await fetch(`${holtOrigin}/partner/`).then((r) => r.status)
    check('proxy API: an iframe-only platform has no proxy page', iframeOnly === 404, String(iframeOnly))
  }

  // Visited directly, not framed.
  {
    const page = await browser.newPage()
    const problems = watch(page)
    await page.goto(`${holtOrigin}/embed?platform=partner&license=${encodeURIComponent(LICENSES.partner)}`)
    await page.waitForTimeout(1500)
    const ax = await axText(page)
    check('standalone: says it must be embedded', ax.includes('This chat is meant to be embedded in another site.'), ax.slice(0, 200))
    check('standalone: no errors', problems.length === 0, problems.join(' || ').slice(0, 300))
    await page.close()
  }
} catch (error) {
  check('run completed', false, error instanceof Error ? error.message : String(error))
  if (holtLog) console.error(holtLog)
} finally {
  await browser?.close()
  for (const server of partners) server.close()
  holt.kill('SIGTERM')
  rmSync(tempDir, { recursive: true, force: true })
}

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
