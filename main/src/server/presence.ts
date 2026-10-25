// Web identity presence (web webhooks, any platform), keyed by chat identity key. The stored choice
// (chat_presence.status: online | idle | dnd | invisible) is persisted; the live state (online / idle /
// offline) is derived from this process's realtime sockets and their last
// activity. Nothing live is stored, so presence is per app-server process, like
// the rate limits.
//
// Fan-out is scoped and ephemeral (no event_log rows):
//   - `bridge.presence.self` (keys: [key]) goes to that identity's own sockets
//     with the shown state, including `invisible`.
//   - `bridge.presence` (keys: [key], status) goes only to sockets that can see
//     some channel (shared guild context), never to the owner, and never reveals
//     invisibility: an invisible user is `offline` to everyone else.
import { query } from './db.js'
import { broadcastEphemeral, DISCORD_BRIDGE_OWNER_KEY } from './events.js'

export const PRESENCE_CHOICES = ['online', 'idle', 'dnd', 'invisible'] as const
export type PresenceChoice = (typeof PRESENCE_CHOICES)[number]
export type PublicPresence = 'online' | 'idle' | 'dnd' | 'offline'
export type ShownPresence = PublicPresence | 'invisible'

/** Discord marks an account idle after 5 minutes without input. */
export const PRESENCE_IDLE_MS = 5 * 60_000
const SWEEP_MS = 30_000

export function isPresenceChoice(value: unknown): value is PresenceChoice {
  return typeof value === 'string' && (PRESENCE_CHOICES as readonly string[]).includes(value)
}

export interface PresenceInput {
  choice: PresenceChoice
  /** Open realtime sockets for the account. */
  sockets: number
  /** Most recent activity across the account's sockets (ms epoch), null if none. */
  lastActiveAt: number | null
  now: number
}

export interface PresenceView {
  /** What the owner sees (their own sockets). */
  shown: ShownPresence
  /** What everyone else sees. */
  public: PublicPresence
}

// Pure derivation: stored choice x live sockets x idle threshold -> displayed state.
//   no sockets                     -> offline (both views)
//   choice invisible               -> owner: invisible, others: offline
//   choice dnd / idle              -> dnd / idle (forced, regardless of activity)
//   choice online                  -> online while any socket was active within
//                                     PRESENCE_IDLE_MS, otherwise idle
export function derivePresence(input: PresenceInput): PresenceView {
  if (input.sockets <= 0) return { shown: 'offline', public: 'offline' }
  switch (input.choice) {
    case 'invisible':
      return { shown: 'invisible', public: 'offline' }
    case 'dnd':
      return { shown: 'dnd', public: 'dnd' }
    case 'idle':
      return { shown: 'idle', public: 'idle' }
    default: {
      const stale = input.lastActiveAt === null || input.now - input.lastActiveAt >= PRESENCE_IDLE_MS
      const status: PublicPresence = stale ? 'idle' : 'online'
      return { shown: status, public: status }
    }
  }
}

// --- Process-local registry -------------------------------------------------

interface Connected {
  /** socket -> last activity (ms epoch). Connecting counts as activity. */
  sockets: Map<object, number>
}

const connected = new Map<string, Connected>()
// Stored choices are cached only while the account has a socket here.
const choices = new Map<string, PresenceChoice>()
const loading = new Map<string, Promise<PresenceChoice>>()
// Last published signature per account, so unchanged state is not re-sent.
const published = new Map<string, string>()
let sweepTimer: ReturnType<typeof setInterval> | null = null

function viewFor(key: string, now = Date.now()): PresenceView | null {
  const entry = connected.get(key)
  if (!entry || entry.sockets.size === 0) return { shown: 'offline', public: 'offline' }
  const choice = choices.get(key)
  // Fail closed: until the stored choice is loaded nothing is published.
  if (!choice) return null
  let lastActiveAt: number | null = null
  for (const at of entry.sockets.values()) if (lastActiveAt === null || at > lastActiveAt) lastActiveAt = at
  return derivePresence({ choice, sockets: entry.sockets.size, lastActiveAt, now })
}

function loadChoice(key: string): Promise<PresenceChoice> {
  const cached = choices.get(key)
  if (cached) return Promise.resolve(cached)
  const pending = loading.get(key)
  if (pending) return pending
  const promise = query<{ status: string | null }>('SELECT status FROM chat_presence WHERE key = $1', [key])
    .then(({ rows }) => {
      const choice: PresenceChoice = isPresenceChoice(rows[0]?.status) ? rows[0].status as PresenceChoice : 'online'
      if (connected.has(key)) choices.set(key, choice)
      return choice
    })
    .finally(() => { loading.delete(key) })
  loading.set(key, promise)
  return promise
}

function publish(key: string): void {
  const view = viewFor(key)
  if (!view) return
  const choice = choices.get(key) ?? null
  const signature = `${view.shown}|${view.public}|${choice ?? ''}`
  if (published.get(key) === signature) return
  published.set(key, signature)
  const keys = [key]
  broadcastEphemeral(DISCORD_BRIDGE_OWNER_KEY, 'bridge.presence', { keys, status: view.public })
  broadcastEphemeral(DISCORD_BRIDGE_OWNER_KEY, 'bridge.presence.self', { keys, shown: view.shown, choice })
}

function startSweep(): void {
  if (sweepTimer) return
  // Idle transitions happen with time, not with socket events: re-derive every
  // connected account periodically and publish only what changed.
  sweepTimer = setInterval(() => {
    for (const key of [...connected.keys()]) publish(key)
  }, SWEEP_MS)
  sweepTimer.unref?.()
}

/** A realtime socket for a signed-in account opened. Resolves once published. */
export async function presenceAttach(key: string, socket: object): Promise<void> {
  let entry = connected.get(key)
  if (!entry) {
    entry = { sockets: new Map() }
    connected.set(key, entry)
  }
  entry.sockets.set(socket, Date.now())
  startSweep()
  await loadChoice(key)
  publish(key)
}

/** Input from the socket (client `activity` message), throttled client-side. */
export function presenceTouch(key: string, socket: object): void {
  const entry = connected.get(key)
  if (!entry || !entry.sockets.has(socket)) return
  entry.sockets.set(socket, Date.now())
  publish(key)
}

export function presenceDetach(key: string, socket: object): void {
  const entry = connected.get(key)
  if (!entry || !entry.sockets.delete(socket)) return
  if (entry.sockets.size === 0) {
    connected.delete(key)
    choices.delete(key)
    publish(key)
    published.delete(key)
    return
  }
  publish(key)
}

/** Payload for a socket that just attached: its own shown state (sent directly). */
export function presenceSelfPayload(key: string): Record<string, unknown> | null {
  const view = viewFor(key)
  if (!view) return null
  return { keys: [key], shown: view.shown, choice: choices.get(key) ?? null }
}

/** Public status for another account (HTTP lookups). Unknown -> offline. */
export function presencePublicFor(key: string): PublicPresence {
  return viewFor(key)?.public ?? 'offline'
}

/** Persist the owner's choice and re-publish. */
export async function setPresenceChoice(key: string, choice: PresenceChoice): Promise<PresenceView> {
  await query(
    `INSERT INTO chat_presence (key, status) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET status = EXCLUDED.status, updated = NOW()`,
    [key, choice],
  )
  if (connected.has(key)) {
    choices.set(key, choice)
    publish(key)
  }
  return viewFor(key) ?? derivePresence({ choice, sockets: 0, lastActiveAt: null, now: Date.now() })
}
