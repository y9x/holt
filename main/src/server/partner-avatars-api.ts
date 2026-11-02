// holt-chat's partner-avatar route (partner-avatars.ts): GET /api/holt-avatars/<sha256>.webp, approved images only.
// holt-service serves it publicly at /avatars/<sha256>.webp. Mounted before apiGuard: it is a cheap,
// content-addressed image read that Discord's media proxy and every chat page fetch without a session.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { dbConfigured, ensureSchema } from './db.js'
import { serveAvatar } from './partner-avatars.ts'

export function partnerAvatarsApi(): Plugin {
  return {
    name: 'holt-partner-avatars',
    configurePreviewServer(server) {
      server.middlewares.use('/api/holt-avatars/', (request: IncomingMessage, response: ServerResponse, next: () => void) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') return next()
        const match = /^\/([0-9a-f]{64})\.webp$/.exec((request.url || '/').split('?')[0]!)
        void (async () => {
          if (!match || !dbConfigured()) {
            response.statusCode = 404
            return response.end()
          }
          await ensureSchema()
          await serveAvatar(match[1]!, response)
        })().catch((error) => {
          console.warn('[avatars] serve failed', error instanceof Error ? error.message : error)
          if (!response.headersSent) response.statusCode = 500
          response.end()
        })
      })
    },
  }
}
