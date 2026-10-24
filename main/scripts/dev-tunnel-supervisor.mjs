// Dev tunnel supervisor. Runs detached from Vite, so the tunnel outlives a dev server restart, the same way
// the wispurr worker does. Vite (src/server/dev-tunnel.ts) adopts it on the next start instead of opening a new one.
//
// It owns two things:
//   - cloudflared, a quick tunnel to the local proxy below (restarted if it exits);
//   - a proxy on PORT that forwards ONLY /api/mcp/ddg to the dev server port it was last told about.
//
// Control (loopback only):
//   GET  /health         -> { ok, url, target }
//   POST /target {port}  -> points the proxy at a dev server port (0 = none, MCP answers 503)
//
// State is written to STATE_FILE so a later start can see the URL and PID.

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const PORT = Number(process.env.ABULXT_TUNNEL_PORT || 6192)
const MCP_PREFIX = '/api/mcp/ddg'
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i
const [cloudflaredBin, stateFile] = process.argv.slice(2)

if (!cloudflaredBin || !stateFile) {
  console.error('usage: dev-tunnel-supervisor.mjs <cloudflared> <state-file>')
  process.exit(2)
}

let target = 0
let publicUrl = null
let tunnel = null
let restartDelay = 2000

function save() {
  mkdirSync(path.dirname(stateFile), { recursive: true })
  writeFileSync(stateFile, JSON.stringify({ supervisorPid: process.pid, port: PORT, url: publicUrl, startedAt: startedAt }, null, 2))
}
const startedAt = new Date().toISOString()

function startTunnel() {
  tunnel = spawn(cloudflaredBin, ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'], { stdio: ['ignore', 'ignore', 'pipe'] })
  tunnel.stderr.on('data', (chunk) => {
    const match = URL_PATTERN.exec(chunk.toString())
    if (match && publicUrl !== match[0]) {
      publicUrl = match[0]
      restartDelay = 2000
      save()
    }
  })
  tunnel.once('exit', () => {
    tunnel = null
    publicUrl = null
    save()
    // A quick tunnel gets a new address when it restarts, so the state file follows it.
    setTimeout(startTunnel, restartDelay)
    restartDelay = Math.min(restartDelay * 2, 60_000)
  })
}

const server = http.createServer((request, response) => {
  const pathOnly = (request.url ?? '').split('?')[0]

  if (request.method === 'GET' && pathOnly === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, url: publicUrl, target }))
    return
  }

  if (request.method === 'POST' && pathOnly === '/target') {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      let port = NaN
      try { port = Number(JSON.parse(body || '{}').port) } catch { port = NaN }
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'port must be an integer 0-65535' }))
        return
      }
      target = port
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, target }))
    })
    return
  }

  if (pathOnly !== MCP_PREFIX && !pathOnly.startsWith(`${MCP_PREFIX}/`)) {
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('not found')
    return
  }
  // A session id starts with the port of the dev server that opened it ("5173-<id>"). Send the call there, so two
  // dev servers can share this tunnel. Without a port, the attached default target is used.
  const segment = pathOnly.slice(MCP_PREFIX.length + 1).split('/')[0]
  const match = /^(\d+)-/.exec(segment)
  const port = match ? Number(match[1]) : target
  if (!port) {
    response.writeHead(503, { 'content-type': 'text/plain' })
    response.end('no dev server is attached to this tunnel')
    return
  }

  const upstream = http.request(
    { host: '127.0.0.1', port, path: request.url, method: request.method, headers: { ...request.headers, host: `127.0.0.1:${port}` } },
    (res) => {
      response.writeHead(res.statusCode ?? 502, res.headers)
      res.pipe(response)
    },
  )
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' })
    response.end('dev server unavailable')
  })
  request.pipe(upstream)
})

server.listen(PORT, '127.0.0.1', () => {
  save()
  startTunnel()
})

function shutdown() {
  if (tunnel) tunnel.kill()
  server.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
