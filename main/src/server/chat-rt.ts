// holt-chat's realtime socket (/api/rt), for every platform's users: the chatbox's live bridge events
// (messages, edits, reactions, typing, moderation, perms and onboarding changes) and presence. Reached only as
// holt-service's WS /<platform>/_holt/api/rt, which passes the caller as a signed X-Holt-Principal
// (chat-caller.ts); without a valid one the socket is a guest's.
//
// Every event goes through allowBridgeEvent for this socket's visibility (socketVisibility, recomputed on
// perms/onboarding/channel changes, never fail-open), replays are filtered the same way, and frames take one
// seal path (rtSend; sealed when config.rtCrypto is on and the client holds the `wcs` seed). Accounts are
// the platform's, so the account stream is answered empty.

import type { IncomingMessage } from 'node:http'
import type { Plugin, ViteDevServer } from 'vite'
import { WebSocketServer, WebSocket } from 'ws'
import { dbConfigured, ensureSchema } from './db.js'
import { loadConfig } from './config.js'
import { clientIp } from './identity.js'
import { rateLimit } from './rate-limit.ts'
import { parseRequestUrl } from './request-url.ts'
import { subscribe, eventsAfter, latestSeq, DISCORD_BRIDGE_OWNER_KEY, type RtEvent } from './events.js'
import {
  allowBridgeEvent,
  eventTargetsIdentity,
  invalidateForChannelsChanged,
  invalidateIdentityVisibility,
  invalidateVisibilityForEvent,
  isGlobalPermsEvent,
  socketVisibility,
  VISIBILITY_TTL_MS,
  type SocketVisibility,
} from './discord-channel-access.js'
import { subjectOfUser, webhookKeys } from './discord-chat-perms.js'
import { deriveRtKeys, deriveRtSubprotocol, openToString, sealString, seedFromCookieHeader, type RtKeys } from '../lib/rt-crypto-codec.ts'
import { resolveChatIdentity, type ChatIdentity } from './chat-caller.ts'
import { presenceAttach, presenceDetach, presenceSelfPayload, presenceTouch } from './presence.js'

async function rtCryptoConfig(): Promise<{ enabled: boolean; padding: number | undefined; sessionSecret: string | null }> {
  const config = await loadConfig().catch(() => null) as { rtCrypto?: { enabled?: boolean; padding?: number }; sessionSecret?: unknown } | null
  const padding = config?.rtCrypto?.padding
  return {
    enabled: config?.rtCrypto?.enabled === true,
    padding: padding && padding > 0 ? padding : undefined,
    sessionSecret: typeof config?.sessionSecret === 'string' && config.sessionSecret.length >= 32 ? config.sessionSecret : null,
  }
}

export function chatRt(): Plugin {
  let wss: WebSocketServer | null = null
  let sealingEnabled = false

  function attach(httpServer: ViteDevServer['httpServer']) {
    if (!httpServer || wss) return
    wss = new WebSocketServer({
      noServer: true,
      // Echo the derived rt subprotocol when sealing is on and the client offers it with the same `wcs`
      // seed (confirms sealing to the client); otherwise no subprotocol, which every client accepts.
      handleProtocols: (protocols: Set<string>, request: IncomingMessage) => {
        if (!sealingEnabled) return false
        const seed = seedFromCookieHeader(request.headers.cookie)
        if (!seed) return false
        try {
          const token = deriveRtSubprotocol(seed)
          return protocols.has(token) ? token : false
        } catch {
          return false
        }
      },
    })

    httpServer.on('upgrade', async (request: IncomingMessage, socket, head) => {
      const url = parseRequestUrl(request.url)
      if (url.pathname !== '/api/rt') return
      const ip = clientIp(request)
      const limit = rateLimit(`rt:upgrade:${ip}`, { limit: 30, windowMs: 60_000, error: 'Too many realtime connections' })
      if (!limit.ok) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\nRetry-After: ' + limit.retryAfterSec + '\r\n\r\n')
        socket.destroy()
        return
      }
      if (!dbConfigured()) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
        socket.destroy()
        return
      }
      await ensureSchema()
      const crypto = await rtCryptoConfig()
      sealingEnabled = crypto.enabled
      const identity = await resolveChatIdentity(request, crypto.sessionSecret)

      // Seal negotiation, as abulxt's rt-api: the client offers the subprotocol derived from its `wcs` seed.
      const seed = seedFromCookieHeader(request.headers.cookie)
      let sealToken: string | null = null
      if (seed) { try { sealToken = deriveRtSubprotocol(seed) } catch { sealToken = null } }
      const offered = String(request.headers['sec-websocket-protocol'] || '').split(',').map((p) => p.trim()).filter(Boolean)
      const sealed = crypto.enabled && !!sealToken && offered.includes(sealToken)
      const rtKeys: RtKeys | null = sealed && seed ? (() => { try { return deriveRtKeys(seed) } catch { return null } })() : null

      wss!.handleUpgrade(request, socket, head, (ws) => {
        connection(ws, identity, rtKeys, crypto.padding)
      })
    })
  }

  function connection(ws: WebSocket, identity: ChatIdentity, rtKeys: RtKeys | null, padding: number | undefined) {
    const ownerKey = identity.ownerKey
    const deviceId = Math.random().toString(36).slice(2)
    const sealOn = !!rtKeys && ws.protocol === rtKeys.subprotocol
    // The single outbound path: sealed with keyS2C when negotiated, else plaintext.
    const rtSend = (payload: string): void => {
      if (ws.readyState !== WebSocket.OPEN) return
      if (sealOn && rtKeys) ws.send(sealString(rtKeys.keyS2C, payload, { padding }))
      else ws.send(payload)
    }

    const subject = subjectOfUser(identity.user)
    const selfKeys = webhookKeys(subject)
    const state: { vis: SocketVisibility | null; queue: RtEvent[]; ready: Promise<void> } = { vis: null, queue: [], ready: Promise.resolve() }
    const sendBridge = (event: RtEvent) => {
      if (state.vis && allowBridgeEvent(event, state.vis)) rtSend(JSON.stringify({ type: 'event', event }))
    }
    const refresh = () => {
      state.ready = socketVisibility(ownerKey, identity.user)
        .then((vis) => { state.vis = vis })
        .catch(() => {
          // Never fail open: withhold everything until the next refresh.
          if (!state.vis) state.vis = { channels: new Set(), discordId: subject.discordId, keys: selfKeys, moderatorChannels: new Set(), siteAdmin: false }
        })
        .then(() => { for (const event of state.queue.splice(0)) sendBridge(event) })
      return state.ready
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, VISIBILITY_TTL_MS)
    timer.unref?.()

    const unsubscribe = subscribe(DISCORD_BRIDGE_OWNER_KEY, (event: RtEvent) => {
      const payload = event.payload || {}
      if (event.type === 'bridge.perms.changed') {
        invalidateVisibilityForEvent(event.seq, payload)
        if (isGlobalPermsEvent(payload) || eventTargetsIdentity(payload, { keys: selfKeys, discordId: subject.discordId })) void refresh()
      }
      if (event.type === 'bridge.channels.changed') {
        invalidateForChannelsChanged(event.seq, payload)
        void refresh()
      }
      if (event.type === 'bridge.onboarding.updated' && eventTargetsIdentity(payload, { keys: selfKeys, discordId: subject.discordId })) {
        invalidateIdentityVisibility(ownerKey)
        void refresh()
      }
      if (!state.vis) {
        if (state.queue.length < 500) state.queue.push(event)
        return
      }
      sendBridge(event)
    })

    // No account stream (accounts are the platform's): sync at 0, replays empty.
    rtSend(JSON.stringify({ type: 'sync', seq: 0, deviceId }))
    rtSend(JSON.stringify({ type: 'presence', online: 1 }))
    // Signed-in identities: presence sockets (Set Status + online/idle, presence.ts).
    const presenceKey = identity.user?.ext_key ?? null
    if (presenceKey !== null) {
      void presenceAttach(presenceKey, ws).then(() => {
        const self = presenceSelfPayload(presenceKey)
        if (self) rtSend(JSON.stringify({ type: 'event', event: { seq: 0, type: 'bridge.presence.self', payload: self } }))
      }).catch(() => {})
    }
    latestSeq(DISCORD_BRIDGE_OWNER_KEY).then((seq) => { if (seq > 0) rtSend(JSON.stringify({ type: 'bridge.sync', seq })) }).catch(() => {})

    ws.on('message', async (raw) => {
      // Sealed: inbound frames are opened with keyC2S; one that fails authentication is dropped silently.
      let text: string
      if (sealOn && rtKeys) {
        const bytes = raw instanceof Buffer ? new Uint8Array(raw) : Array.isArray(raw) ? new Uint8Array(Buffer.concat(raw)) : new Uint8Array(raw as ArrayBuffer)
        const plain = openToString(rtKeys.keyC2S, bytes, { padding })
        if (plain == null) return
        text = plain
      } else {
        text = String(raw)
      }
      let msg: { type?: string; afterSeq?: number }
      try {
        msg = JSON.parse(text)
      } catch {
        return
      }
      // Client input heartbeat (throttled client-side): keeps this socket "active" for presence.
      if (msg.type === 'activity') {
        if (presenceKey !== null) presenceTouch(presenceKey, ws)
        return
      }
      if (msg.type === 'resync') {
        rtSend(JSON.stringify({ type: 'replay', events: [] }))
        return
      }
      if (msg.type === 'bridge.resync' && typeof msg.afterSeq === 'number') {
        try {
          if (msg.afterSeq <= 0) {
            rtSend(JSON.stringify({ type: 'bridge.sync', seq: await latestSeq(DISCORD_BRIDGE_OWNER_KEY) }))
            return
          }
          const missed = await eventsAfter(DISCORD_BRIDGE_OWNER_KEY, msg.afterSeq)
          await state.ready
          const vis = state.vis
          if (vis) rtSend(JSON.stringify({ type: 'bridge.replay', events: missed.filter((event) => allowBridgeEvent(event, vis)) }))
        } catch {
          /* ignore */
        }
      }
    })
    const close = () => {
      clearInterval(timer)
      unsubscribe()
      if (presenceKey !== null) presenceDetach(presenceKey, ws)
    }
    ws.on('close', close)
    ws.on('error', close)
  }

  return {
    name: 'holt-chat-rt',
    configurePreviewServer(server) {
      attach(server.httpServer)
    },
  }
}
