// Presence store for the chat surface. Two sources, both realtime:
//   - Other web identities: `bridge.presence` (public status, invisible already
//     mapped to offline) plus a batched `/presence` lookup when a row or popout
//     first shows an author. Entries expire after 60s so a missed event heals.
//   - The signed-in account: `bridge.presence.self` (shown state from the owner's
//     own sockets, incl. invisible) and the stored choice, seeded from the
//     account and updated optimistically by the Set Status picker.
import { useEffect, useSyncExternalStore } from 'react'
import { subscribeBridge, type RtEvent } from '../../lib/rt'
import { bridgePresence, type PublicPresenceStatus } from '../../lib/bridge'

export type ShownPresence = 'online' | 'idle' | 'dnd' | 'invisible' | 'offline'

/** Discord's wording (en-US intl) for each presence. */
export const PRESENCE_TEXT: Record<ShownPresence, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do Not Disturb',
  invisible: 'Invisible',
  offline: 'Offline',
}

/** Status glyph class: offline and invisible share Discord's hollow grey ring. */
export function presenceGlyph(status: ShownPresence): 'online' | 'idle' | 'dnd' | 'invisible' {
  return status === 'offline' ? 'invisible' : status
}

const PUBLIC_STATUSES: readonly string[] = ['online', 'idle', 'dnd', 'offline']
const CHOICES: readonly string[] = ['online', 'idle', 'dnd', 'invisible']
const TTL_MS = 60_000

type Listener = () => void
const listeners = new Set<Listener>()
const publicByKey = new Map<string, { status: PublicPresenceStatus; at: number }>()
let self: { choice: string | null; shown: ShownPresence | null } = { choice: null, shown: null }
let listening = false
let pendingByChannel = new Map<string, Set<string>>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

function emit() {
  for (const listener of listeners) listener()
}

function subscribeStore(listener: Listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function setPublic(key: string, status: PublicPresenceStatus) {
  publicByKey.set(key, { status, at: Date.now() })
  emit()
}

function ensureListening() {
  if (listening) return
  listening = true
  subscribeBridge((event: RtEvent) => {
    const payload = (event.payload || {}) as { keys?: unknown; status?: unknown; shown?: unknown; choice?: unknown }
    const key = Array.isArray(payload.keys) && typeof payload.keys[0] === 'string' ? payload.keys[0] : null
    if (event.type === 'bridge.presence' && key && typeof payload.status === 'string' && PUBLIC_STATUSES.includes(payload.status)) {
      setPublic(key, payload.status as PublicPresenceStatus)
    } else if (event.type === 'bridge.presence.self') {
      self = {
        choice: typeof payload.choice === 'string' && CHOICES.includes(payload.choice) ? payload.choice : self.choice,
        shown: typeof payload.shown === 'string' ? payload.shown as ShownPresence : self.shown,
      }
      emit()
    }
  })
}

function flush() {
  flushTimer = null
  const batches = pendingByChannel
  pendingByChannel = new Map()
  for (const [channelId, keys] of batches) {
    const list = [...keys]
    bridgePresence(channelId, list)
      .then((map) => {
        const at = Date.now()
        for (const key of list) publicByKey.set(key, { status: map[key] ?? 'offline', at })
        emit()
      })
      .catch(() => {})
  }
}

function requestPublic(channelId: string, key: string) {
  const hit = publicByKey.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return
  let set = pendingByChannel.get(channelId)
  if (!set) pendingByChannel.set(channelId, (set = new Set()))
  set.add(key)
  if (flushTimer === null) flushTimer = setTimeout(flush, 15)
}

// A site account's chat key: `abulxt:<n>` since migration 037, `user:<n>` before.
const WEB_KEY = /^(?:abulxt|user):\d+$/

/** Public presence of a web identity ('user:<siteId>'), or null until known. */
export function usePublicPresence(channelId: string | null | undefined, authorKey: string | null | undefined): PublicPresenceStatus | null {
  const key = authorKey && WEB_KEY.test(authorKey) ? authorKey : null
  useEffect(() => {
    ensureListening()
    if (channelId && key) requestPublic(channelId, key)
  }, [channelId, key])
  return useSyncExternalStore(subscribeStore, () => (key ? publicByKey.get(key)?.status ?? null : null))
}

/** The signed-in account's stored choice and its live shown state. */
export function useSelfPresence(): { choice: string | null; shown: ShownPresence | null } {
  useEffect(() => { ensureListening() }, [])
  return useSyncExternalStore(subscribeStore, () => self)
}

/** Seed the stored choice from the account record (server is the source). */
export function seedSelfChoice(choice: string | null | undefined) {
  if (!choice || !CHOICES.includes(choice)) return
  self = { ...self, choice }
  emit()
}

/** Optimistic local update made by the Set Status picker. */
export function setSelfChoice(choice: string) {
  if (!CHOICES.includes(choice)) return
  self = { ...self, choice }
  emit()
}
