// Anti-abuse ping limits for web-originated chatbox messages, modeled on
// Discord's own behavior:
//
// 1. Per-message cap (Discord AutoMod "Block Mention Spam", default action
//    Block Message): a message with more than `perMessage` UNIQUE user + role
//    mentions is rejected with Discord's AutoMod block (code 200000) - never a
//    429, which the client's request queue would silently retry forever.
//    Admin/owner webhooks are exempt (Discord exempts Administrator / Manage
//    Server from AutoMod). @everyone/@here and reply pings don't count, same
//    as AutoMod's mention_total_limit.
// 2. Per-identity sliding-window ping budget: each pinged user/role/reply
//    target costs 1 from `pingsPerWindow` (MENTION_EVERYONE holders get
//    `staffPingsPerWindow`); @everyone/@here has its own slower budget. Over
//    budget the message STILL sends - the excess mentions are made inert
//    (`inert: true`: chip stays, no allowed_mentions ping on Discord, no web
//    highlight), exactly how Discord renders a non-pinging mention.
// 3. Per-target protection: the same identity pinging the same target more
//    than `perTargetPerWindow` times per `targetWindowSeconds` → inert.
//
// State is in memory (one app-server process). With several app-server
// processes each would keep its own windows, multiplying the effective budget
// by the process count; move the windows to Redis/Postgres if that changes.

export interface MentionLimitConfig {
  /** Max unique user+role mentions per message (AutoMod mention_total_limit). 0 = off. */
  perMessage: number
  /** Sliding window for the general ping budget. */
  windowSeconds: number
  /** Pings (users/roles/reply targets) per window for ordinary webhooks. */
  pingsPerWindow: number
  /** Pings per window for MENTION_EVERYONE holders (staff): higher, still finite. */
  staffPingsPerWindow: number
  /** Window for @everyone/@here. */
  everyoneWindowSeconds: number
  /** @everyone/@here pings per window (only MENTION_EVERYONE holders can ping them at all). */
  everyonePerWindow: number
  /** @everyone/@here pings per window for admin/owner webhooks. */
  adminEveryonePerWindow: number
  /** Window for the per-target protection. */
  targetWindowSeconds: number
  /** Pings of ONE target by one identity per target window. */
  perTargetPerWindow: number
}

export const DEFAULT_MENTION_LIMITS: MentionLimitConfig = {
  perMessage: 10,
  windowSeconds: 60,
  pingsPerWindow: 20,
  staffPingsPerWindow: 60,
  everyoneWindowSeconds: 600,
  everyonePerWindow: 1,
  adminEveryonePerWindow: 3,
  targetWindowSeconds: 300,
  perTargetPerWindow: 5,
}

export function resolveMentionLimits(raw?: Partial<Record<keyof MentionLimitConfig, unknown>> | null): MentionLimitConfig {
  const out = { ...DEFAULT_MENTION_LIMITS }
  if (!raw || typeof raw !== 'object') return out
  for (const key of Object.keys(out) as Array<keyof MentionLimitConfig>) {
    const v = Number(raw[key])
    if (raw[key] !== undefined && Number.isFinite(v) && v >= 0) out[key] = Math.floor(v)
  }
  return out
}

/** member = no MENTION_EVERYONE; staff = holds MENTION_EVERYONE; admin = admin/owner tier. */
export type PingClass = 'member' | 'staff' | 'admin'

export function pingClassFor(tier: string, canMentionEveryone: boolean): PingClass {
  if (tier === 'admin' || tier === 'owner') return 'admin'
  return canMentionEveryone ? 'staff' : 'member'
}

export interface LimitableMention {
  type: string
  id?: string
  username?: string
  inert?: boolean
}

export type NeutralizeReason = 'budget' | 'target' | 'everyone' | 'edit'

// Unique user + role mention tokens in the stored content (AutoMod counts the
// mentions it parses out of the content; degraded no-permission role tokens
// were already rewritten to plain text by parseMentions).
export function uniqueMentionCount(content: string): number {
  const users = new Set<string>()
  const roles = new Set<string>()
  for (const m of content.matchAll(/<@(!?|&)(\d+)>/g)) {
    if (m[1] === '&') roles.add(m[2])
    else users.add(m[2])
  }
  return users.size + roles.size
}

export function mentionSpamCheck(content: string, cls: PingClass, limits: MentionLimitConfig): { blocked: boolean; count: number; limit: number } {
  const count = uniqueMentionCount(content)
  const limit = limits.perMessage
  return { blocked: limit > 0 && cls !== 'admin' && count > limit, count, limit }
}

// Discord's AutoMod block strings (en-US intl zQ69pv / bU6o0z) and API error.
export const AUTOMOD_BLOCKED_CODE = 200000
export const AUTOMOD_BLOCKED_SEND = "This message can't be posted because it contains content blocked by this community. The message may also be viewed by the community owners."
export const AUTOMOD_BLOCKED_EDIT = "This message can't be edited because it contains content blocked by this community. The message may also be viewed by the community owners."

export function automodBlockedBody(edit: boolean, count: number, limit: number) {
  return {
    message: 'Message was blocked by automatic moderation',
    code: AUTOMOD_BLOCKED_CODE,
    error: edit ? AUTOMOD_BLOCKED_EDIT : AUTOMOD_BLOCKED_SEND,
    autoModeration: { rule: 'mention_spam', count, limit },
  }
}

// Stable per-target key. A reply to a web author (no snowflake) is keyed by
// the author name the client matches on.
export function mentionTargetKey(m: LimitableMention): string | null {
  if (m.type === 'everyone') return 'everyone'
  if ((m.type === 'user' || m.type === 'reply') && m.id) return `user:${m.id}`
  if (m.type === 'reply' && m.username) return `name:${m.username.toLowerCase()}`
  if (m.type === 'role' && m.id) return `role:${m.id}`
  return null
}

export interface ApplyOptions {
  cls: PingClass
  limits: MentionLimitConfig
  /** Edit path: targets that were LIVE in the previous version - stay live, no charge. */
  carriedLive?: Set<string>
  /** Edit path: targets that were already inert - an edit can't revive them. */
  carriedInert?: Set<string>
}

export interface ApplyResult<M extends LimitableMention> {
  mentions: M[]
  neutralized: Array<{ target: string; reason: NeutralizeReason }>
}

export interface MentionStats {
  neutralized: number
  blocked: number
  lastAt: string | null
}

const SWEEP_EVERY_MS = 60_000
const MAX_KEYS = 50_000
const LOG_THROTTLE_MS = 60_000

export class MentionLimiter {
  private pings = new Map<string, number[]>()
  private everyone = new Map<string, number[]>()
  private targets = new Map<string, number[]>()
  private stats = new Map<string, { neutralized: number; blocked: number; lastAt: number; lastLog: number; unlogged: number }>()
  private lastSweep = 0

  private now: () => number

  constructor(now: () => number = () => Date.now()) {
    this.now = now
  }

  private live(map: Map<string, number[]>, key: string, windowMs: number, now: number): number[] {
    const hits = (map.get(key) || []).filter((t) => t > now - windowMs)
    if (hits.length) map.set(key, hits)
    else map.delete(key)
    return hits
  }

  private push(map: Map<string, number[]>, key: string, now: number) {
    const hits = map.get(key) || []
    hits.push(now)
    map.set(key, hits)
  }

  private sweep(now: number, limits: MentionLimitConfig) {
    if (now - this.lastSweep < SWEEP_EVERY_MS) return
    this.lastSweep = now
    const prune = (map: Map<string, number[]>, windowMs: number) => {
      for (const key of [...map.keys()]) this.live(map, key, windowMs, now)
      if (map.size > MAX_KEYS) for (const key of [...map.keys()].slice(0, map.size - MAX_KEYS)) map.delete(key)
    }
    prune(this.pings, limits.windowSeconds * 1000)
    prune(this.everyone, limits.everyoneWindowSeconds * 1000)
    prune(this.targets, limits.targetWindowSeconds * 1000)
    if (this.stats.size > 10_000) for (const key of [...this.stats.keys()].slice(0, this.stats.size - 10_000)) this.stats.delete(key)
  }

  // Decide, per pingable mention, live (charged) or inert. Non-pingable
  // entries (channels) pass through. Duplicate targets in one message (a
  // <@id> plus a reply ping to the same person) share one decision and one
  // charge - Discord pings a person once per message.
  apply<M extends LimitableMention>(identity: string, mentions: M[], opts: ApplyOptions): ApplyResult<M> {
    const now = this.now()
    this.sweep(now, opts.limits)
    const decided = new Map<string, NeutralizeReason | null>()
    const neutralized: ApplyResult<M>['neutralized'] = []
    const out = mentions.map((m) => {
      const key = mentionTargetKey(m)
      if (!key || m.inert) return m
      let reason: NeutralizeReason | null
      if (decided.has(key)) {
        reason = decided.get(key)!
      } else {
        reason = this.decide(identity, key, now, opts)
        decided.set(key, reason)
        if (reason) neutralized.push({ target: key, reason })
      }
      return reason ? { ...m, inert: true } : m
    })
    // Carried-over inert mentions on an edit aren't new limit hits.
    const fresh = neutralized.filter((n) => n.reason !== 'edit').length
    if (fresh) this.note(identity, 'neutralized', fresh, now)
    return { mentions: out, neutralized }
  }

  private decide(identity: string, key: string, now: number, opts: ApplyOptions): NeutralizeReason | null {
    const { limits, cls } = opts
    if (opts.carriedLive?.has(key)) return null
    if (opts.carriedInert?.has(key)) return 'edit'
    if (key === 'everyone') {
      const cap = cls === 'admin' ? limits.adminEveryonePerWindow : limits.everyonePerWindow
      const hits = this.live(this.everyone, identity, limits.everyoneWindowSeconds * 1000, now)
      if (hits.length >= cap) return 'everyone'
      this.push(this.everyone, identity, now)
      return null
    }
    const targetKey = `${identity}|${key}`
    const perTarget = this.live(this.targets, targetKey, limits.targetWindowSeconds * 1000, now)
    if (perTarget.length >= limits.perTargetPerWindow) return 'target'
    const cap = cls === 'member' ? limits.pingsPerWindow : limits.staffPingsPerWindow
    const budget = this.live(this.pings, identity, limits.windowSeconds * 1000, now)
    if (budget.length >= cap) return 'budget'
    this.push(this.targets, targetKey, now)
    this.push(this.pings, identity, now)
    return null
  }

  private note(identity: string, kind: 'neutralized' | 'blocked', n: number, now: number) {
    const s = this.stats.get(identity) || { neutralized: 0, blocked: 0, lastAt: 0, lastLog: 0, unlogged: 0 }
    s[kind] += n
    s.lastAt = now
    this.stats.set(identity, s)
  }

  noteBlocked(identity: string) {
    this.note(identity, 'blocked', 1, this.now())
  }

  // Audit-log throttle: at most one moderation_event per identity per minute;
  // returns how many limit events were folded into this one (0 = skip log).
  takeLogSlot(identity: string): number {
    const now = this.now()
    const s = this.stats.get(identity)
    if (!s) return 0
    s.unlogged += 1
    if (now - s.lastLog < LOG_THROTTLE_MS) return 0
    const folded = s.unlogged
    s.lastLog = now
    s.unlogged = 0
    return folded
  }

  statsFor(keys: string[]): MentionStats {
    let neutralized = 0
    let blocked = 0
    let lastAt = 0
    for (const key of keys) {
      const s = this.stats.get(key)
      if (!s) continue
      neutralized += s.neutralized
      blocked += s.blocked
      lastAt = Math.max(lastAt, s.lastAt)
    }
    return { neutralized, blocked, lastAt: lastAt ? new Date(lastAt).toISOString() : null }
  }
}

// The app server's single limiter (see the multi-process note above).
export const mentionLimiter = new MentionLimiter()
