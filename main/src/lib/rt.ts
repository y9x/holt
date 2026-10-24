import { getAuthToken } from './auth-api'
import { apiBase, ensureApiBase, reportApiFailure } from './api-base'
import { deriveRtKeys, sealString, openToString, seedFromDocumentCookie, type RtKeys } from './rt-crypto-codec'

export interface RtEvent {
  seq: number
  type: string
  payload: Record<string, unknown>
}

type Handler = (event: RtEvent) => void

let socket: WebSocket | null = null
// Transport frame-cloak, negotiated per connection (same technique as the Wisp
// cloak): keys are derived ONCE from the `wcs` seed cookie when the socket is
// created; `cloaked` is confirmed at open against the subprotocol the server
// echoed. No seed / server didn't echo → plaintext (current behavior). Padding
// stays OFF on /api/rt for realtime latency (must match the server default).
let rtKeys: RtKeys | null = null
let cloaked = false
function wsSend(ws: WebSocket, payload: string): void {
  // sealString returns Uint8Array<ArrayBufferLike>; noble's cipher output is
  // always plain-ArrayBuffer-backed (never SharedArrayBuffer), so this cast is
  // safe and avoids a per-frame copy. (TS 5.7 buffer-generic strictness.)
  if (cloaked && rtKeys) ws.send(sealString(rtKeys.keyC2S, payload) as Uint8Array<ArrayBuffer>)
  else ws.send(payload)
}
let subscribers = 0
let lastSeq = 0
let lastBridgeSeq = 0
let reconnectTimer: number | null = null
const handlers = new Set<Handler>()
const bridgeHandlers = new Set<Handler>()
let opened = false

function url(): string {
  const base = apiBase()
  const token = getAuthToken()
  const resolvedHost = base
    ? base.replace(/^https?:\/\//, '')
    : (typeof window !== 'undefined' ? window.location.host : '')
  const proto = base.startsWith('http://')
    ? 'ws:'
    : (typeof window !== 'undefined' && window.location.protocol === 'http:' ? 'ws:' : 'wss:')
  return `${proto}//${resolvedHost}/api/rt${token ? `?token=${encodeURIComponent(token)}` : ''}`
}

let resolvingBase = false

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  if (resolvingBase) return
  // Open on a verified backend domain (instant once one has passed a probe).
  resolvingBase = true
  void ensureApiBase().finally(() => {
    resolvingBase = false
    openSocket()
  })
}

function openSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  // Derive this connection's cloak keys from the `wcs` seed cookie (if present)
  // and offer the opaque subprotocol so a cloak-aware server can negotiate.
  rtKeys = null
  cloaked = false
  try { const seed = seedFromDocumentCookie(); if (seed) rtKeys = deriveRtKeys(seed) } catch { rtKeys = null }
  const socketBase = apiBase()
  const ws = rtKeys ? new WebSocket(url(), [rtKeys.subprotocol]) : new WebSocket(url())
  try { ws.binaryType = 'arraybuffer' } catch { /* ignore */ }
  socket = ws

  ws.onopen = () => {
    // Confirm the cloak: the server marks a cloaked connection by echoing our
    // derived subprotocol. Anything else (stock server, cloak disabled) → stay
    // plaintext. Runs before any message, so inbound decoding sees the right mode.
    cloaked = !!rtKeys && ws.protocol === rtKeys.subprotocol
  }

  ws.onmessage = (msg) => {
    let text: string
    if (cloaked && rtKeys && typeof msg.data !== 'string') {
      const opened = openToString(rtKeys.keyS2C, msg.data as ArrayBuffer)
      if (opened == null) return // auth failure - drop the frame
      text = opened
    } else {
      text = String(msg.data)
    }
    let data: { type?: string; event?: RtEvent; events?: RtEvent[]; seq?: number; id?: string; ok?: boolean } & Record<string, unknown>
    try {
      data = JSON.parse(text)
    } catch {
      return
    }
    if (data.type === 'sync' && typeof data.seq === 'number') {
      lastSeq = Math.max(lastSeq, data.seq)
      opened = true

      if (lastSeq > 0) wsSend(ws, JSON.stringify({ type: 'resync', afterSeq: lastSeq }))

      for (const [, pending] of pendingOps) wsSend(ws, pending.payload)
      return
    }

    if (data.type === 'bridge.sync' && typeof data.seq === 'number') {
      if (lastBridgeSeq > 0 && data.seq > lastBridgeSeq) {
        wsSend(ws, JSON.stringify({ type: 'bridge.resync', afterSeq: lastBridgeSeq }))
      } else {
        lastBridgeSeq = Math.max(lastBridgeSeq, data.seq)
      }
      return
    }

    if (data.type === 'bridge.replay' && Array.isArray(data.events)) {
      for (const event of data.events as RtEvent[]) {
        lastBridgeSeq = Math.max(lastBridgeSeq, event.seq)
        for (const handler of bridgeHandlers) handler(event)
      }
      return
    }

    if (data.type === 'op.result' && typeof data.id === 'string') {
      const pending = pendingOps.get(data.id)
      if (pending) {
        pendingOps.delete(data.id)
        if (data.ok) pending.resolve(data)
        else {
          const err = new Error(typeof data.error === 'string' ? data.error : 'Operation failed') as Error & { requireAccount?: boolean; retryable?: boolean }
          if (data.requireAccount) err.requireAccount = true
          if (data.retryable) err.retryable = true
          pending.reject(err)
        }
      }
      return
    }
    if (data.type === 'event' && data.event) {
      if (typeof data.event.type === 'string' && data.event.type.startsWith('bridge.')) {
        lastBridgeSeq = Math.max(lastBridgeSeq, data.event.seq)
        for (const handler of bridgeHandlers) handler(data.event)
        return
      }
      lastSeq = Math.max(lastSeq, data.event.seq)
      for (const handler of handlers) handler(data.event)
      return
    }
    if (data.type === 'replay' && Array.isArray(data.events)) {
      for (const event of data.events) {
        lastSeq = Math.max(lastSeq, event.seq)
        for (const handler of handlers) handler(event)
      }
    }
  }

  ws.onclose = () => {
    const neverSynced = !opened
    socket = null
    opened = false
    rtKeys = null
    cloaked = false

    const scheduleReconnect = () => {
      if (subscribers > 0 && reconnectTimer === null) {
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null
          connect()
        }, 1500)
      }
    }
    // A socket that never synced may mean this backend domain is blocked:
    // re-probe it and move to a healthy one before reconnecting.
    if (neverSynced) void reportApiFailure(socketBase).finally(scheduleReconnect)
    else scheduleReconnect()
  }
  ws.onerror = () => {
    ws.close()
  }
}

interface PendingOp {
  payload: string
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
}
const pendingOps = new Map<string, PendingOp>()

export function rtOp(op: 'send' | 'edit' | 'retry' | 'delete' | 'cancel', args: { threadId: string; text?: string; messageId?: string; clientId?: string; model?: string; tools?: string[]; attachments?: unknown }):Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const payload = JSON.stringify({ type: 'op', id, op, ...args })
    pendingOps.set(id, { payload, resolve, reject })
    if (socket && socket.readyState === WebSocket.OPEN) {
      wsSend(socket, payload)
    } else {

      connect()
    }
  })
}

export function subscribeRt(handler: Handler): () => void {
  handlers.add(handler)
  subscribers += 1
  connect()
  return () => {
    handlers.delete(handler)
    subscribers = Math.max(0, subscribers - 1)
    if (subscribers === 0) {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer)
        reconnectTimer = null
      }

      for (const [, pending] of pendingOps) pending.reject(new Error('Connection closed'))
      pendingOps.clear()
      socket?.close()
      socket = null
      opened = false
    }
  }
}

// Input heartbeat for presence (idle after 5 min without input server-side).
// Throttled to one message per minute; only sent over an open socket.
let lastActivitySent = 0
function sendActivity() {
  const now = Date.now()
  if (now - lastActivitySent < 60_000) return
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  lastActivitySent = now
  wsSend(socket, JSON.stringify({ type: 'activity' }))
}
if (typeof window !== 'undefined') {
  for (const name of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
    window.addEventListener(name, sendActivity, { passive: true, capture: true })
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sendActivity() })
}

// Subscribe to the shared Discord community bridge bus. Events have types like
// bridge.message / bridge.message.edited / bridge.message.deleted / bridge.typing.
export function subscribeBridge(handler: Handler): () => void {
  bridgeHandlers.add(handler)
  const unsubscribe = subscribeRt(() => {})
  if (socket && socket.readyState === WebSocket.OPEN && lastBridgeSeq === 0) {
    wsSend(socket, JSON.stringify({ type: 'bridge.resync', afterSeq: 0 }))
  }
  return () => {
    bridgeHandlers.delete(handler)
    unsubscribe()
  }
}

export function rtConnected(): boolean {
  return opened && socket?.readyState === WebSocket.OPEN
}

export function reconnectRt(): void {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (socket) {
    socket.onclose = null
    socket.close()
    socket = null
  }
  opened = false
  if (subscribers > 0) {
    connect()
  }
}
