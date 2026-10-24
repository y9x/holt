// holt-chat: the chat API (/api/discord/bridge/*) served by holt, on loopback only. It runs abulxt's own
// bridge API code (vendored, VENDOR.md) the same way abulxt's app server does: `vite preview` with the
// plugins as Vite plugins, against the same database, so behaviour is identical by construction.
//
//   npm run chat-api        127.0.0.1:8831, reached only through holt-service's licensed proxy
//                           (/<platform>/_holt/api/discord/bridge/* -> /api/discord/bridge/*).
//
// Realtime: abulxt accounts keep abulxt's own /api/rt (it also carries their account and AI events); chat
// events emitted here reach those sockets through the Postgres NOTIFY relay (events.ts), the same way the
// bot's do. Other platforms' users get this process's /api/rt (chat-rt.ts), reached as holt-service's
// WS /<platform>/_holt/api/rt. The relay runs here either way, so caches and sockets hear every change.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { loadConfig } from './src/server/config.ts'
import { configureDatabase } from './src/server/db.ts'
import { startEventRelay } from './src/server/events.ts'
import { apiGuard } from './src/server/api-guard.ts'
import { discordBridgeApi } from './src/server/discord-bridge-api.ts'
import { chatRt } from './src/server/chat-rt.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Database + event relay, the parts of abulxt's app server the bridge API leans on. */
function chatRuntime(): Plugin {
  return {
    name: 'holt-chat-runtime',
    async configResolved() {
      const config = await loadConfig()
      configureDatabase(config.db?.url)
    },
    configurePreviewServer() {
      void startEventRelay()
    },
  }
}

export default defineConfig({
  // Nothing is served from disk: every request is an API route handled by the plugins below.
  build: { outDir: path.resolve(HERE, 'chat-api-root') },
  preview: {
    host: '127.0.0.1',
    port: 8831,
    strictPort: true,
    cors: false,
    allowedHosts: true,
  },
  plugins: [chatRuntime(), apiGuard(), discordBridgeApi(), chatRt()],
})
