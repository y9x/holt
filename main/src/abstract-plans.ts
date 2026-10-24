// Abstract AI plans. Shared by the browser (pricing page, chat host summary) and
// the server (checkout, webhook, relay entitlement). Keep this file free of Node
// imports.
//
// Prices and window caps come from the Abstract AI site spec (sections 3.7 and
// 6.3). Annual billing is charged once a year at ANNUAL_MONTHS_CHARGED times the
// monthly price, and the card shows the monthly equivalent.

/**
 * Sales gate. While false, checkout refuses with 410 and the pricing page shows
 * "Plans open soon" on every buy button. The owner flips it, not the code.
 */
export const ABSTRACT_SALES_OPEN = false

/**
 * Whether this user may buy an Abstract plan right now. Sandbox accounts (users.sandbox)
 * can buy while the gate is closed for everyone else. Their checkout uses Stripe sandbox.
 */
export function abstractSalesOpenFor(user: { sandbox?: boolean | null } | null | undefined): boolean {
  return ABSTRACT_SALES_OPEN || user?.sandbox === true
}

export const ABSTRACT_PLAN_IDS = ['starter', 'plus', 'pro', 'max', 'ultra'] as const
export type AbstractPlanId = (typeof ABSTRACT_PLAN_IDS)[number]

export const ABSTRACT_INTERVALS = ['monthly', 'annual'] as const
export type AbstractInterval = (typeof ABSTRACT_INTERVALS)[number]

/** Annual billing: one charge a year at this many monthly prices. */
export const ANNUAL_MONTHS_CHARGED = 10

export interface AbstractPlan {
  id: AbstractPlanId
  name: string
  audience: string
  monthlyCents: number
  fiveHourUnits: number
  weeklyUnits: number
  recommended: boolean
}

export const ABSTRACT_PLANS: readonly AbstractPlan[] = [
  { id: 'starter', name: 'Starter', audience: 'To try it properly', monthlyCents: 800, fiveHourUnits: 5_000, weeklyUnits: 50_000, recommended: false },
  { id: 'plus', name: 'Plus', audience: 'For regular use', monthlyCents: 2400, fiveHourUnits: 25_000, weeklyUnits: 250_000, recommended: true },
  { id: 'pro', name: 'Pro', audience: 'For daily work', monthlyCents: 4400, fiveHourUnits: 75_000, weeklyUnits: 750_000, recommended: false },
  { id: 'max', name: 'Max', audience: 'For heavy use', monthlyCents: 10900, fiveHourUnits: 200_000, weeklyUnits: 2_000_000, recommended: false },
  { id: 'ultra', name: 'Ultra', audience: 'For the heaviest use', monthlyCents: 21900, fiveHourUnits: 500_000, weeklyUnits: 5_000_000, recommended: false },
]

export function isAbstractPlanId(value: unknown): value is AbstractPlanId {
  return typeof value === 'string' && (ABSTRACT_PLAN_IDS as readonly string[]).includes(value)
}

export function isAbstractInterval(value: unknown): value is AbstractInterval {
  return typeof value === 'string' && (ABSTRACT_INTERVALS as readonly string[]).includes(value)
}

export function abstractPlan(id: AbstractPlanId): AbstractPlan {
  const plan = ABSTRACT_PLANS.find((p) => p.id === id)
  if (!plan) throw new Error(`Unknown Abstract plan: ${id}`)
  return plan
}

/**
 * What a plan costs on one billing interval. chargeCents is what Stripe bills
 * each time. perMonthCents is the figure the card shows.
 */
export function abstractPriceFor(
  plan: AbstractPlan,
  interval: AbstractInterval,
): { chargeCents: number; perMonthCents: number } {
  if (interval === 'monthly') return { chargeCents: plan.monthlyCents, perMonthCents: plan.monthlyCents }
  const chargeCents = plan.monthlyCents * ANNUAL_MONTHS_CHARGED
  return { chargeCents, perMonthCents: Math.round(chargeCents / 12) }
}

/** "$8", "$6.67", "$2,190". Whole dollars drop the cents. */
export function formatUsd(cents: number): string {
  const whole = cents % 100 === 0
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100)
}

/** "₪5,000". Usage is whole shekels, so no decimals. */
export function formatShekels(shekels: number): string {
  return `₪${shekels.toLocaleString('en-US')}`
}

/**
 * The Abstract plan a user is entitled to right now, or null. Reads only the
 * Abstract columns (plan, plan_until). The retired tier
 * columns are never read.
 */
export function activeAbstractPlan(
  user: { plan: string | null; plan_until: Date | string | null },
  now: Date = new Date(),
): string | null {
  if (!isAbstractPlanId(user.plan) || !user.plan_until) return null
  const until = user.plan_until instanceof Date ? user.plan_until : new Date(user.plan_until)
  return until.getTime() > now.getTime() ? user.plan : null
}

/** The tier string the billing routes take, e.g. abstract_plus_year. */
export function abstractTier(plan: AbstractPlanId, interval: AbstractInterval): string {
  return `abstract_${plan}_${interval === 'annual' ? 'year' : 'month'}`
}

/**
 * How a change of plan moves the subscriber. A higher plan is an upgrade and a lower plan a downgrade,
 * whatever the period. On the same plan, monthly to annual is an upgrade (charged now) and annual to
 * monthly is a downgrade (at period end).
 */
export type AbstractChange = 'same' | 'upgrade' | 'downgrade'

export function compareChange(
  current: { plan: AbstractPlanId; interval: AbstractInterval },
  target: { plan: AbstractPlanId; interval: AbstractInterval },
): AbstractChange {
  const from = ABSTRACT_PLAN_IDS.indexOf(current.plan)
  const to = ABSTRACT_PLAN_IDS.indexOf(target.plan)
  if (from !== to) return to > from ? 'upgrade' : 'downgrade'
  if (current.interval === target.interval) return 'same'
  return target.interval === 'annual' ? 'upgrade' : 'downgrade'
}
