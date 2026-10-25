// holt-chat: the chat API, served by holt on loopback only, against holt's own database. `vite preview` with
// the API modules as Vite plugins:
//
//   npm run chat-api        127.0.0.1:8831, reached only through holt-service:
//     /api/discord/bridge/*   the chat API          (<platform>/_holt/api/discord/bridge/*)
//     /api/rt                 realtime (chat-rt.ts)  (WS <platform>/_holt/api/rt)
//     /api/holt-account/*     Set Status, rail folders (holt-account-api.ts)
//     /api/holt-platform/*    a platform's pushes, after holt-service checked its hook signature
//
// Every caller arrives as the principal holt-service signed (chat-caller.ts). The event relay (events.ts)
// runs here too, so caches and sockets hear what the bot emits.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { loadConfig } from './src/server/config.ts'
import { configureDatabase } from './src/server/db.ts'
import { startEventRelay } from './src/server/events.ts'
import { apiGuard } from './src/server/api-guard.ts'
import { discordBridgeApi } from './src/server/discord-bridge-api.ts'
import { chatRt } from './src/server/chat-rt.ts'
import { holtAccountApi } from './src/server/holt-account-api.ts'

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
  plugins: [chatRuntime(), apiGuard(), discordBridgeApi(), holtAccountApi(), chatRt()],
})
