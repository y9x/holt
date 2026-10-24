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

const tempDir = mkdtempSync(path.join(tmpdir(), 'holt-e2e-'))
const configFile = path.join(tempDir, 'config.js')
writeFileSync(configFile, `export default ${JSON.stringify({
  port: holtPort,
  publicOrigin: holtOrigin,
  sessionSecret: 'e2e-session-secret-0123456789abcdef0123456789abcdef',
  admins: [],
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
  }],
})}\n`)

function partnerPage(guest) {
  const getToken = guest ? 'Promise.resolve(null)' : "fetch('/token').then((r) => r.text())"
  return `<!doctype html><html><head><title>Partner</title></head><body>
<h1>Partner page</h1><div id="chat"></div>
<script src="${holtOrigin}/holt-embed.js"></script>
<script>
  Holt.mount({ origin: '${holtOrigin}', platform: 'partner', container: document.getElementById('chat'), height: '220px', getToken: () => ${getToken} })
</script></body></html>`
}

function partnerServer(port) {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://partner.local')
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

  // Visited directly, not framed.
  {
    const page = await browser.newPage()
    const problems = watch(page)
    await page.goto(`${holtOrigin}/embed?platform=partner`)
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
