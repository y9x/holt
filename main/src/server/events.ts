import { query } from './db.js'

export interface RtEvent {
  seq: number
  type: string
  payload: Record<string, unknown>
}

type Listener = (event: RtEvent) => void

const sockets = new Map<string, Set<Listener>>()

// Shared event bus for the Discord community bridge. Bridge events are not
// owned by any single user, so they are logged under this well-known owner
// key and every /api/rt socket subscribes to it in addition to its own key.
export const DISCORD_BRIDGE_OWNER_KEY = 'discord:bridge'

export function subscribe(ownerKey: string, listener: Listener): () => void {
  let set = sockets.get(ownerKey)
  if (!set) {
    set = new Set()
    sockets.set(ownerKey, set)
  }
  set.add(listener)
  return () => {
    set!.delete(listener)
    if (!set!.size) sockets.delete(ownerKey)
  }
}

function broadcastLocal(event: RtEvent, ownerKey: string) {
  const set = sockets.get(ownerKey)
  if (set) {
    for (const listener of set) {
      try {
        listener(event)
      } catch {

      }
    }
  }
}

// Cross-process fan-out: bridge events are typically written by the standalone
// abulxt-discord service, while websocket clients are connected to the app
// server. `emit` therefore also fires a Postgres NOTIFY; any process that has
// called `startEventRelay` re-broadcasts matching rows to its own sockets.
const RELAY_CHANNEL = 'abulxt_rt_event'
const RELAY_OWNER_PREFIX = 'discord:'
// Lives on globalThis for the same reason as the pool in db.ts: a module reload must not start a second LISTEN client.
const relayHolder = globalThis as typeof globalThis & { __abulxtRelayStarted?: boolean }
// Postgres delivers a NOTIFY to every listener, including this process's own
// relay connection. `emit` already broadcast the event locally, so a relay
// that re-broadcast its own notifications would hand every socket each bridge
// event TWICE (same seq) - doubling unread-mention badges, "N new messages"
// counters, etc. Tag notifications with a per-process origin and skip our own.
const RELAY_ORIGIN = `${process.pid}:${Math.random().toString(36).slice(2)}`
const RELAY_MAX_BYTES = 7900

function payloadSeq(payload: Record<string, unknown>): number {
  const seq = Number(payload.__seq)
  return Number.isFinite(seq) ? seq : 0
}

export async function startEventRelay(): Promise<void> {
  if (relayHolder.__abulxtRelayStarted) return
  relayHolder.__abulxtRelayStarted = true
  try {
    const { getPool } = await import('./db.js')
    const client = await getPool().connect()
    client.on('notification', (message) => {
      if (message.channel !== RELAY_CHANNEL || !message.payload) return
      try {
        const parsed = JSON.parse(message.payload) as { origin?: string; ownerKey?: string; type?: string; seqRef?: number; payload?: Record<string, unknown> }
        if (parsed.origin === RELAY_ORIGIN) return // already broadcast locally by emit()
        if (typeof parsed.ownerKey !== 'string' || typeof parsed.type !== 'string') return
        // Oversized event: the notification only carries its seq - load the
        // full payload from event_log (see RELAY_MAX_BYTES in emit()).
        if (typeof parsed.seqRef === 'number') {
          const ownerKey = parsed.ownerKey
          void query<{ seq: string; type: string; payload: Record<string, unknown> }>(
            `SELECT seq, type, payload FROM event_log WHERE seq = $1 AND owner_key = $2`,
            [parsed.seqRef, ownerKey],
          ).then(({ rows }) => {
            if (rows[0]) broadcastLocal({ seq: Number(rows[0].seq), type: rows[0].type, payload: rows[0].payload }, ownerKey)
          }).catch(() => {})
          return
        }
        const eventPayload = parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {}
        const event: RtEvent = { seq: payloadSeq(eventPayload), type: parsed.type, payload: eventPayload }
        broadcastLocal(event, parsed.ownerKey)
      } catch {

      }
    })
    client.on('error', () => { relayHolder.__abulxtRelayStarted = false })
    await client.query(`LISTEN ${RELAY_CHANNEL}`)
  } catch {
    relayHolder.__abulxtRelayStarted = false
  }
}

// Live-only fan-out (no event_log row, seq 0): used for presence, which
// changes with socket activity and must not be persisted or replayed.
export function broadcastEphemeral(ownerKey: string, type: string, payload: Record<string, unknown>): void {
  broadcastLocal({ seq: 0, type, payload }, ownerKey)
}

// Multi-guild bridge: every `bridge.*` event about a channel carries the
// channel's `guildId` (discord_bridge_channel.guild_id), and
// bridge.perms.changed / bridge.onboarding.updated carry `guildId` too (null =
// every guild). Stamped here, once, so no emit site can forget it. A channel
// never changes guild, so the lookup is cached for the process lifetime.
//
// Forum posts (migration 038): an event whose channelId is a POST (a thread
// id, or 'post:<pk>' while a web post is pending) gets the post's guild and
// its `forumId` stamped too. Realtime visibility is the forum's
// (discord-channel-access.ts allowBridgeEvent reads forumId first).
interface ChannelScopeInfo { guildId: string; forumId: string | null }
const channelGuildCache = new Map<string, ChannelScopeInfo>()

function bridgePayloadChannelId(payload: Record<string, unknown>): string | null {
  if (typeof payload.channelId === 'string' && payload.channelId) return payload.channelId
  const message = payload.message as { channelId?: unknown } | undefined
  return message && typeof message.channelId === 'string' && message.channelId ? message.channelId : null
}

async function channelScopeInfo(channelId: string): Promise<ChannelScopeInfo | null> {
  const hit = channelGuildCache.get(channelId)
  if (hit) return hit
  const pending = /^post:(\d{1,15})$/.exec(channelId)
  const { rows } = pending
    ? await query<{ guild_id: string; forum_id: string | null }>(
      `SELECT guild_id, channel_id AS forum_id FROM discord_bridge_post WHERE id = $1`,
      [Number(pending[1])],
    ).catch(() => ({ rows: [] as Array<{ guild_id: string; forum_id: string | null }> }))
    : await query<{ guild_id: string; forum_id: string | null }>(
      `SELECT guild_id, NULL::text AS forum_id FROM discord_bridge_channel WHERE channel_id = $1
       UNION ALL
       SELECT guild_id, channel_id AS forum_id FROM discord_bridge_post WHERE thread_id = $1
       LIMIT 1`,
      [channelId],
    ).catch(() => ({ rows: [] as Array<{ guild_id: string; forum_id: string | null }> }))
  const info = rows[0]?.guild_id ? { guildId: rows[0].guild_id, forumId: rows[0].forum_id || null } : null
  // A pending id is re-keyed on delivery, but its guild and forum never change.
  if (info) {
    channelGuildCache.set(channelId, info)
    if (channelGuildCache.size > 5000) channelGuildCache.delete(channelGuildCache.keys().next().value as string)
  }
  return info
}

export async function withBridgeGuild(type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!type.startsWith('bridge.')) return payload
  const channelId = bridgePayloadChannelId(payload)
  if (channelId) {
    const needGuild = !('guildId' in payload)
    const needForum = !('forumId' in payload)
    if (!needGuild && !needForum) return payload
    const info = await channelScopeInfo(channelId)
    if (!info) return payload
    const out = { ...payload }
    if (needGuild) out.guildId = info.guildId
    if (needForum && info.forumId) out.forumId = info.forumId
    return out
  }
  if ('guildId' in payload) return payload
  if (type === 'bridge.perms.changed' || type === 'bridge.onboarding.updated') return { ...payload, guildId: null }
  return payload
}

export async function emit(ownerKey: string, type: string, rawPayload: Record<string, unknown>): Promise<number> {
  const payload = ownerKey === DISCORD_BRIDGE_OWNER_KEY ? await withBridgeGuild(type, rawPayload) : rawPayload
  const { rows } = await query<{ seq: string }>(
    `INSERT INTO event_log (owner_key, type, payload) VALUES ($1, $2, $3) RETURNING seq`,
    [ownerKey, type, JSON.stringify(payload)],
  )
  const seq = Number(rows[0].seq)
  const event: RtEvent = { seq, type, payload }
  broadcastLocal(event, ownerKey)
  if (ownerKey.startsWith(RELAY_OWNER_PREFIX)) {
    let notifyPayload = JSON.stringify({ origin: RELAY_ORIGIN, ownerKey, type, payload: { ...payload, __seq: seq } })
    // Postgres caps NOTIFY payloads at 8000 bytes and pg_notify() throws past
    // that - a long message with embeds would otherwise never reach the other
    // process's sockets. Send a seq reference instead; the relay loads the row.
    if (Buffer.byteLength(notifyPayload, 'utf8') > RELAY_MAX_BYTES) {
      notifyPayload = JSON.stringify({ origin: RELAY_ORIGIN, ownerKey, type, seqRef: seq })
    }
    await query(`SELECT pg_notify($1, $2)`, [RELAY_CHANNEL, notifyPayload]).catch(() => {})
  }
  return seq
}

export async function eventsAfter(ownerKey: string, afterSeq: number): Promise<RtEvent[]> {
  const { rows } = await query<{ seq: string; type: string; payload: Record<string, unknown> }>(
    `SELECT seq, type, payload FROM event_log WHERE owner_key = $1 AND seq > $2 ORDER BY seq ASC LIMIT 500`,
    [ownerKey, afterSeq],
  )
  return rows.map((r) => ({ seq: Number(r.seq), type: r.type, payload: r.payload }))
}

export async function latestSeq(ownerKey: string): Promise<number> {
  const { rows } = await query<{ seq: string | null }>(
    `SELECT max(seq) AS seq FROM event_log WHERE owner_key = $1`,
    [ownerKey],
  )
  return rows[0]?.seq ? Number(rows[0].seq) : 0
}
