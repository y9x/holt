import { useCallback, useEffect, useMemo, useState } from 'react'

/* Client-side notification settings - Discord's per-guild / per-channel
 * (and per-category) mute + notification overrides. The bridge has no
 * notification backend, so this is a localStorage-persisted preference store
 * that drives the sidebar/rail unread + mute rendering and mention badges.
 *
 * Model (mirrors Discord's UserGuildSettings):
 *   - mutes: guild / channel / category → { until } where `until` is an epoch
 *     ms end time, or null for "Until I turn it back on". Timed mutes expire
 *     on their own (a timer purges them at the end time).
 *   - levels: channel / category overrides and the guild default
 *     (All Messages / Only @mentions / Nothing); absent = inherit.
 *   - guild suppress flags: Suppress @everyone and @here, Suppress All Role
 *     @mentions - they stop those pings from counting as unread mentions. */

export type NotifLevel = 'all' | 'mentions' | 'nothing'
export interface MuteConfig {
  /** Epoch ms when the mute ends; null = until turned back on. */
  until: number | null
  /** The picked duration in seconds (-1 = always) - Discord's selected_time_window. */
  window?: number
}

interface NotifStore {
  guildMutes: Record<string, MuteConfig>
  channelMutes: Record<string, MuteConfig>
  guildLevels: Record<string, NotifLevel>
  channelLevels: Record<string, NotifLevel>
  suppressEveryone: Record<string, boolean>
  suppressRoles: Record<string, boolean>
}

const STORE_KEY = 'abulxt:chat-notif-settings'
const EMPTY: NotifStore = { guildMutes: {}, channelMutes: {}, guildLevels: {}, channelLevels: {}, suppressEveryone: {}, suppressRoles: {} }

/** Discord's mute durations (MuteTimeWindow seconds; -1 = always), in menu order. */
export const MUTE_DURATIONS: Array<{ seconds: number; label: string }> = [
  { seconds: 900, label: 'For 15 Minutes' },
  { seconds: 3600, label: 'For 1 Hour' },
  { seconds: 10800, label: 'For 3 Hours' },
  { seconds: 28800, label: 'For 8 Hours' },
  { seconds: 86400, label: 'For 24 Hours' },
  { seconds: -1, label: 'Until I turn it back on' },
]

/** Discord's "Muted until {endTime}" subtext (null for an indefinite mute). */
export function mutedUntilText(config: MuteConfig | undefined): string | null {
  if (!config || config.until == null) return null
  const end = new Date(config.until).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return `Muted until ${end}`
}

function load(): NotifStore {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) return { ...EMPTY, ...JSON.parse(raw) }
  } catch { /* fall through to migration */ }
  // One-time migration from the older per-feature keys.
  const store: NotifStore = { ...EMPTY, guildMutes: {}, channelMutes: {}, channelLevels: {} }
  try {
    const levels = JSON.parse(localStorage.getItem('abulxt:chat-notif-levels') || '{}') as Record<string, string>
    for (const [id, level] of Object.entries(levels)) {
      if (level === 'muted') store.channelMutes[id] = { until: null }
      else if (level === 'mentions' || level === 'nothing') store.channelLevels[id] = level
    }
    const guilds = JSON.parse(localStorage.getItem('abulxt:chat-muted-guilds') || '{}') as Record<string, boolean>
    for (const [id, muted] of Object.entries(guilds)) if (muted) store.guildMutes[id] = { until: null }
  } catch { /* ignore */ }
  return store
}

function save(store: NotifStore) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)) } catch { /* ignore */ }
}

const active = (m: MuteConfig | undefined, now: number) => Boolean(m && (m.until == null || m.until > now))

export function useNotificationSettings() {
  const [store, setStore] = useState<NotifStore>(load)
  const [now, setNow] = useState(() => Date.now())

  const update = useCallback((fn: (s: NotifStore) => NotifStore) => {
    setStore((cur) => {
      const next = fn(cur)
      save(next)
      return next
    })
  }, [])

  // Timed mutes: wake at the earliest end time, purge expired entries (the
  // channel/server unmutes on its own) and re-render.
  useEffect(() => {
    const ends = [...Object.values(store.guildMutes), ...Object.values(store.channelMutes)]
      .map((m) => m.until).filter((t): t is number => t != null)
    const t = Date.now()
    const expired = ends.some((e) => e <= t)
    if (expired) {
      const purge = (r: Record<string, MuteConfig>) => Object.fromEntries(Object.entries(r).filter(([, m]) => m.until == null || m.until > t))
      update((s) => ({ ...s, guildMutes: purge(s.guildMutes), channelMutes: purge(s.channelMutes) }))
      setNow(t)
      return
    }
    const nextEnd = Math.min(...ends)
    if (!Number.isFinite(nextEnd)) return
    const id = setTimeout(() => setNow(Date.now()), Math.min(2 ** 31 - 1, nextEnd - t + 50))
    return () => clearTimeout(id)
  }, [store, now, update])

  const muteFor = (seconds: number): MuteConfig => ({ until: seconds > 0 ? Date.now() + seconds * 1000 : null, window: seconds })

  const api = useMemo(() => ({
    store,
    isGuildMuted: (guildId: string) => active(store.guildMutes[guildId], now),
    isChannelMuted: (id: string) => active(store.channelMutes[id], now),
    guildMute: (guildId: string) => (active(store.guildMutes[guildId], now) ? store.guildMutes[guildId] : undefined),
    channelMute: (id: string) => (active(store.channelMutes[id], now) ? store.channelMutes[id] : undefined),
    muteGuild: (guildId: string, seconds: number) => update((s) => ({ ...s, guildMutes: { ...s.guildMutes, [guildId]: muteFor(seconds) } })),
    unmuteGuild: (guildId: string) => update((s) => { const { [guildId]: _drop, ...rest } = s.guildMutes; void _drop; return { ...s, guildMutes: rest } }),
    muteChannel: (id: string, seconds: number) => update((s) => ({ ...s, channelMutes: { ...s.channelMutes, [id]: muteFor(seconds) } })),
    unmuteChannel: (id: string) => update((s) => { const { [id]: _drop, ...rest } = s.channelMutes; void _drop; return { ...s, channelMutes: rest } }),
    channelLevel: (id: string): NotifLevel | undefined => store.channelLevels[id],
    /** Ids (channels or categories) carrying any override: a level or an active mute. */
    overrideIds: (): string[] => [...new Set([...Object.keys(store.channelLevels), ...Object.keys(store.channelMutes).filter((id) => active(store.channelMutes[id], now))])],
    /** Remove a channel/category override entirely (level + mute). */
    clearOverride: (id: string) => update((s) => {
      const channelLevels = { ...s.channelLevels }
      const channelMutes = { ...s.channelMutes }
      delete channelLevels[id]
      delete channelMutes[id]
      return { ...s, channelLevels, channelMutes }
    }),
    setChannelLevel: (id: string, level: NotifLevel | null) => update((s) => {
      const channelLevels = { ...s.channelLevels }
      if (level) channelLevels[id] = level
      else delete channelLevels[id]
      return { ...s, channelLevels }
    }),
    guildLevel: (guildId: string): NotifLevel => store.guildLevels[guildId] || 'all',
    setGuildLevel: (guildId: string, level: NotifLevel) => update((s) => ({ ...s, guildLevels: { ...s.guildLevels, [guildId]: level } })),
    suppressEveryone: (guildId: string) => Boolean(store.suppressEveryone[guildId]),
    suppressRoles: (guildId: string) => Boolean(store.suppressRoles[guildId]),
    toggleSuppressEveryone: (guildId: string) => update((s) => ({ ...s, suppressEveryone: { ...s.suppressEveryone, [guildId]: !s.suppressEveryone[guildId] } })),
    toggleSuppressRoles: (guildId: string) => update((s) => ({ ...s, suppressRoles: { ...s.suppressRoles, [guildId]: !s.suppressRoles[guildId] } })),
    /** Resolved level: channel override → category override → guild default. */
    effectiveLevel: (channelId: string, parentId: string | null | undefined, guildId: string): NotifLevel =>
      store.channelLevels[channelId] || (parentId ? store.channelLevels[parentId] : undefined) || store.guildLevels[guildId] || 'all',
  }), [store, now, update])

  return api
}

export const NOTIF_LEVEL_LABELS: Record<NotifLevel, string> = {
  all: 'All Messages',
  mentions: 'Only @mentions',
  nothing: 'Nothing',
}

/** Non-hook read for the desktop-notification path (realtime events): a muted
 * guild, channel or parent category returns 'muted'; otherwise the resolved
 * channel → category → guild level. `guildId` is the message's real guild (a
 * muted server must silence its own channels, not a placeholder key). */
export function channelAlertLevel(channelId: string, parentId: string | null | undefined, guildId: string): NotifLevel | 'muted' {
  const store = load()
  const now = Date.now()
  if (active(store.guildMutes[guildId], now) || active(store.channelMutes[channelId], now)) return 'muted'
  if (parentId && active(store.channelMutes[parentId], now)) return 'muted'
  return store.channelLevels[channelId] || (parentId ? store.channelLevels[parentId] : undefined) || store.guildLevels[guildId] || 'all'
}
