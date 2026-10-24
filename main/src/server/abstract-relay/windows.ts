// Abstract AI usage windows. Pure logic only; the reads and writes live in
// store.ts. Port of internal/store/usage.go (task-3-usage-metering).
//
// Two fixed windows per user. A window starts at its first recorded use and
// resets as a whole at window_start + length. Expiry is strict: a window
// exactly `length` old is still open. Times are epoch ms and come from the
// database clock (store.ts reads NOW()), never from the app server.

const HOUR_MS = 60 * 60 * 1000

export type WindowKind = 'five_hour' | 'weekly'
export type WindowName = '5h' | 'weekly'

export const WINDOW_KINDS: readonly WindowKind[] = ['five_hour', 'weekly']

export const WINDOW_LENGTH_MS: Record<WindowKind, number> = {
  five_hour: 5 * HOUR_MS,
  weekly: 7 * 24 * HOUR_MS,
}

// Wire name in 429 bodies (`window`) and the message label.
export const WINDOW_NAME: Record<WindowKind, WindowName> = {
  five_hour: '5h',
  weekly: 'weekly',
}

// Pre-flight guess for one request, before upstream reports real usage. The
// check is weighted: estimate x multiplier. Same constant as Go's
// estimatedTokensPerRequest.
export const ESTIMATED_TOKENS_PER_REQUEST = 1000

export type AbstractPlanId = 'starter' | 'plus' | 'pro' | 'max' | 'ultra'

// Caps in units, from PlanLimits (usage.go:37-43) and metering-relay.md section 3.
export const PLAN_CAPS: Record<AbstractPlanId, Record<WindowKind, number>> = {
  starter: { five_hour: 5_000, weekly: 50_000 },
  plus: { five_hour: 25_000, weekly: 250_000 },
  pro: { five_hour: 75_000, weekly: 750_000 },
  max: { five_hour: 200_000, weekly: 2_000_000 },
  ultra: { five_hour: 500_000, weekly: 5_000_000 },
}

export function isPlanId(value: unknown): value is AbstractPlanId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PLAN_CAPS, value)
}

/** A stored window row. `startMs` is window_start; `used` is used_units. */
export type WindowRow = { startMs: number; used: number }

/** True when the window has no row or its full length has passed (strict). */
export function isWindowExpired(kind: WindowKind, row: WindowRow | null, nowMs: number): boolean {
  return !row || nowMs - row.startMs > WINDOW_LENGTH_MS[kind]
}

/** Effective usage now. An expired window counts as empty and resets in full length. */
export function readWindow(kind: WindowKind, row: WindowRow | null, nowMs: number): { used: number; resetsInMs: number } {
  if (isWindowExpired(kind, row, nowMs) || !row) {
    return { used: 0, resetsInMs: WINDOW_LENGTH_MS[kind] }
  }
  return { used: row.used, resetsInMs: row.startMs + WINDOW_LENGTH_MS[kind] - nowMs }
}

/** Units for a request's pre-flight check. */
export function estimateUnits(multiplier: number): number {
  return ESTIMATED_TOKENS_PER_REQUEST * multiplier
}

/** Units for a finished request: (prompt + completion) x multiplier. */
export function unitsFor(inputTokens: number, outputTokens: number, multiplier: number): number {
  return Math.round((inputTokens + outputTokens) * multiplier * 1e6) / 1e6
}

export function formatResets(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export type UsageLimit = {
  window: WindowName
  used: number
  limit: number
  resetsInSec: number
  multiplier: number
}

export function usageLimitMessage(limit: UsageLimit): string {
  const label = limit.window === 'weekly' ? 'weekly window' : '5h window'
  return `Abstract AI usage limit reached. ${label}: ${Math.floor(limit.used)}/${limit.limit}. Resets in ${formatResets(limit.resetsInSec)}.`
}

export type PreflightInput = {
  plan: AbstractPlanId
  multiplier: number
  nowMs: number
  rows: Partial<Record<WindowKind, WindowRow | null>>
}

/**
 * Blocks when used + estimate x multiplier exceeds a window's cap. With
 * several blocking windows, the one with the highest projected/limit ratio is
 * reported. There is no reservation: concurrent requests can all pass.
 *
 * Starter (5,000 cap) is refused for 10x models even at zero usage, because
 * 1,000 x 10 = 10,000 > 5,000. This follows from the estimate, as in Go.
 */
export function checkPreflight(input: PreflightInput): { ok: true } | { ok: false; limit: UsageLimit } {
  const estimate = estimateUnits(input.multiplier)
  let blocked: { kind: WindowKind; used: number; limit: number; resetsInMs: number; ratio: number } | null = null
  for (const kind of WINDOW_KINDS) {
    const limit = PLAN_CAPS[input.plan][kind]
    const reading = readWindow(kind, input.rows[kind] ?? null, input.nowMs)
    const projected = reading.used + estimate
    if (projected <= limit) continue
    const ratio = projected / limit
    if (!blocked || ratio > blocked.ratio) {
      blocked = { kind, used: reading.used, limit, resetsInMs: reading.resetsInMs, ratio }
    }
  }
  if (!blocked) return { ok: true }
  return {
    ok: false,
    limit: {
      window: WINDOW_NAME[blocked.kind],
      used: blocked.used,
      limit: blocked.limit,
      resetsInSec: Math.floor(Math.max(0, blocked.resetsInMs) / 1000),
      multiplier: input.multiplier,
    },
  }
}
