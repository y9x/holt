// Dev-only public tunnel for the AI workspace tools.
//
// The free chat route (Cloudflare playground) calls our MCP endpoint from Cloudflare's side, so the MCP
// route must be reachable from the internet. In production that is abulxt.loan. On a dev machine this file
// makes sure a tunnel is running and points the MCP URL at it.
//
// The tunnel is owned by a detached supervisor (scripts/dev-tunnel-supervisor.mjs), so it outlives a dev server
// restart the same way the wispurr worker does. The first Vite start launches it and waits for its address.
// Every later start adopts the running supervisor and is ready at once.
//
// Only the MCP route is published (the supervisor forwards /api/mcp/ddg and answers everything else 404), so
// accounts, data and admin routes are never on the public internet.
//
// Runs only under `vite` (the dev server). `vite preview` and production builds never start it.
// Set ABULXT_DEV_TUNNEL=0 to skip it.

import { spawn, execFile } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, chmodSync, readFileSync, rmSync, renameSync, statSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Plugin } from 'vite'

const MCP_PREFIX = '/api/mcp/ddg'
const SUPERVISOR_PORT = Number(process.env.ABULXT_TUNNEL_PORT || 6192)
const SUPERVISOR_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/dev-tunnel-supervisor.mjs')
// The download follows the latest cloudflared release, so a copy older than MAX_AGE_MS is fetched again.
// If that fetch fails, the existing copy is still used.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

// Vite loads this file twice (once for vite.config.ts, once for the server code), so the state lives on globalThis.
interface DevTunnelState { publicMcpUrl: string | null; servedPort: number }
const tunnelGlobal = globalThis as { __abulxtDevTunnel?: DevTunnelState }
const tunnelState: DevTunnelState = tunnelGlobal.__abulxtDevTunnel ??= { publicMcpUrl: null, servedPort: 0 }

/** The port this dev server serves on, or 0 outside `vite` dev. Turn sessions carry it so the tunnel routes back here. */
export function devServerPort(): number {
  return tunnelState.servedPort
}

/** The MCP base URL the free route should use while the dev tunnel is up, or null. */
export function devMcpPublicUrl(): string | null {
  return tunnelState.publicMcpUrl
}

/** The per-user cache directory for this platform: outside the repo, shared by every checkout, kept across reboots. */
export function cacheDir(platform = process.platform, env = process.env, home = os.homedir()): string {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'abulxt', 'cache', 'cloudflared')
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'abulxt', 'cloudflared')
  return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'abulxt', 'cloudflared')
}

const CACHE_DIR = cacheDir()
const STATE_FILE = path.join(CACHE_DIR, 'tunnel-state.json')

/** The cloudflared asset for this machine, or an error for platforms it does not ship on. */
export function cloudflaredAsset(platform = process.platform, arch = process.arch): { name: string; archive: boolean } {
  const cpu = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : null
  if (!cpu) throw new Error(`cloudflared has no build for CPU architecture ${arch}.`)
  if (platform === 'linux') return { name: `cloudflared-linux-${cpu}`, archive: false }
  if (platform === 'win32') return { name: `cloudflared-windows-${cpu}.exe`, archive: false }
  if (platform === 'darwin') return { name: `cloudflared-darwin-${cpu}.tgz`, archive: true }
  throw new Error(`cloudflared has no build for platform ${platform}.`)
}

function binaryName(): string {
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
}

function runsOk(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 15_000 }, (error) => resolve(!error))
  })
}

async function download(url: string, dest: string): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status} for ${url}`)
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(dest))
}

/** Finds cloudflared on PATH or in the cache, or downloads it into the cache. */
export async function findOrInstallCloudflared(log: (message: string) => void): Promise<string> {
  const onPath = binaryName()
  if (await runsOk(onPath)) return onPath
  mkdirSync(CACHE_DIR, { recursive: true })
  const cached = path.join(CACHE_DIR, binaryName())
  const haveCopy = existsSync(cached) && (await runsOk(cached))
  if (haveCopy && Date.now() - statSync(cached).mtimeMs < MAX_AGE_MS) return cached

  const asset = cloudflaredAsset()
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset.name}`
  log(`downloading cloudflared (${asset.name}) into ${CACHE_DIR}`)
  try {
    if (!asset.archive) {
      const tmp = `${cached}.part`
      await download(url, tmp)
      renameSync(tmp, cached)
    } else {
      const archive = path.join(CACHE_DIR, asset.name)
      await download(url, archive)
      await new Promise<void>((resolve, reject) => {
        execFile('tar', ['-xzf', archive, '-C', CACHE_DIR], (error) => (error ? reject(error) : resolve()))
      })
      rmSync(archive, { force: true })
    }
    if (process.platform !== 'win32') chmodSync(cached, 0o755)
    if (!(await runsOk(cached))) throw new Error(`downloaded cloudflared did not run: ${cached}`)
    return cached
  } catch (error) {
    if (haveCopy) {
      log(`could not refresh cloudflared (${error instanceof Error ? error.message : String(error)}); using the existing copy`)
      return cached
    }
    throw error
  }
}

interface SupervisorHealth {
  ok: boolean
  url: string | null
}

function supervisorHealth(): Promise<SupervisorHealth | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: SUPERVISOR_PORT, path: '/health', timeout: 500 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try { resolve(res.statusCode === 200 ? (JSON.parse(body) as SupervisorHealth) : null) } catch { resolve(null) }
      })
    })
    req.once('timeout', () => { req.destroy(); resolve(null) })
    req.once('error', () => resolve(null))
  })
}

/** Points the supervisor's proxy at a dev server port (0 detaches it). */
function setSupervisorTarget(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ port })
    const req = http.request(
      { host: '127.0.0.1', port: SUPERVISOR_PORT, path: '/target', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: 2000 },
      (res) => { res.resume(); resolve(res.statusCode === 200) },
    )
    req.once('timeout', () => { req.destroy(); resolve(false) })
    req.once('error', () => resolve(false))
    req.end(body)
  })
}

/** Waits until the public address reaches the proxy (a tunnel error page is 502/503/530). */
async function waitForEdge(origin: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}${MCP_PREFIX}/ping`, { signal: AbortSignal.timeout(4_000) })
      if (![502, 503, 530].includes(res.status)) return
    } catch {
      // not reachable yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(`the tunnel address ${origin} did not become reachable in time`)
}

/** Starts the detached supervisor and returns once it has an address. */
async function launchSupervisor(log: (message: string) => void): Promise<string> {
  const bin = await findOrInstallCloudflared(log)
  log('starting the tunnel (detached, so it survives dev server restarts)')
  const child = spawn(process.execPath, [SUPERVISOR_SCRIPT, bin, STATE_FILE], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ABULXT_TUNNEL_PORT: String(SUPERVISOR_PORT) },
  })
  child.unref()
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const health = await supervisorHealth()
    if (health?.url) return health.url
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('the tunnel supervisor did not print a public address')
}

export function devPublicTunnel(): Plugin {
  return {
    name: 'abulxt-dev-tunnel',
    apply: 'serve',
    configureServer(server) {
      if (process.env.ABULXT_DEV_TUNNEL === '0') return
      const started = Date.now()
      const log = (message: string) => server.config.logger.info(`[dev-tunnel] ${message} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
      server.httpServer?.once('listening', () => {
        const address = server.httpServer?.address()
        const devPort = typeof address === 'object' && address ? address.port : 0
        if (!devPort) return
        tunnelState.servedPort = devPort
        void (async () => {
          try {
            const running = await supervisorHealth()
            let origin: string
            if (running?.url) {
              origin = running.url
              log('reusing the tunnel that is already running')
            } else {
              origin = await launchSupervisor(log)
              // The proxy answers 503 until a dev server is attached, so attach first; then the address can be checked.
              if (!(await setSupervisorTarget(devPort))) throw new Error('the tunnel supervisor did not accept this dev server')
              log('waiting for the public address to reach the proxy')
              await waitForEdge(origin, 90_000)
            }
            if (!(await setSupervisorTarget(devPort))) throw new Error('the tunnel supervisor did not accept this dev server')
            tunnelState.publicMcpUrl = `${origin}${MCP_PREFIX}`
            log(`ready: ${tunnelState.publicMcpUrl} (only the MCP route is public)`)
          } catch (error) {
            log(`not started: ${error instanceof Error ? error.message : String(error)}`)
          }
        })()
      })
      // The tunnel stays up for the next start. This dev server just stops routing to itself.
      server.httpServer?.once('close', () => {
        tunnelState.publicMcpUrl = null
        tunnelState.servedPort = 0
        void setSupervisorTarget(0)
      })
    },
  }
}

/** Reads the saved tunnel state, for diagnostics. Null when none has been written. */
export function readTunnelState(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}
