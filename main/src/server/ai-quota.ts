// Weighted-token AI quotas (plans in ../ai-plans.ts). Usage lives in
// ai_model_usage_ledger, bucketed by UTC day. Every charge is written to ALL of
// a person's identity keys and reads take the MAX across keys, so a person
// can't reset usage by switching accounts (same model as ai-usage-ledger.ts).
import { query } from './db.js'
import { ledgerKeysFor } from './ai-usage-ledger.js'
import { AI_PLANS, AUTO_MODEL, minPlanForModel, planAllowsModel, planForEntitlement, weightedTokens, type AiPlanId } from '../ai-plans.js'
import type { Identity } from './identity.js'

/** Site admins (users.admin) are exempt from every AI usage limit. */
export function isAdmin(identity: Identity): boolean {
  return Boolean(identity.user?.admin)
}

const UTC_DAY = `(NOW() AT TIME ZONE 'UTC')::date`

// Plan from the entitlement columns: paid_until = King Proxy, noads_until = No Ads.
export function planForUser(user?: { paid_until?: Date | string | null; noads_until?: Date | string | null } | null): AiPlanId {
  return planForEntitlement(user)
}

export function planForIdentity(identity: Identity): AiPlanId {
  return identity.isGuest ? 'free' : planForEntitlement(identity.user)
}

/** The concrete plan model for a requested id ('' / 'auto' -> AUTO_MODEL). */
export function planModelId(model: string | undefined): string {
  const raw = (model || '').trim().toLowerCase()
  return !raw || raw === 'auto' ? AUTO_MODEL : raw
}

/** Why `plan` can't use `model`, or null when it can. */
export function planAccessDenial(plan: AiPlanId, model: string): string | null {
  if (planAllowsModel(plan, model)) return null
  const needed = minPlanForModel(model)
  if (!needed) return 'That model is not available.'
  return `That model requires ${AI_PLANS[needed].label}. Upgrade to use it.`
}

export async function quotaKeysFor(identity: Identity, persist = false): Promise<string[]> {
  if (identity.isGuest) return [`guest:${identity.ip}`]
  return ledgerKeysFor(identity.user!, persist)
}

export interface ModelUsage { used: number; limit: number; remaining: number }
export interface QuotaSnapshot {
  plan: AiPlanId
  unit: 'weighted_tokens'
  used: number
  limit: number
  remaining: number
  models: Record<string, ModelUsage>
  resetsAt: string
  /** Site admins: no daily limit; limit/remaining are informational only. */
  unlimited?: boolean
}

function nextUtcMidnight(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString()
}

async function usageByModel(keys: string[]): Promise<{ total: number; models: Map<string, number> }> {
  const { rows } = await query<{ identity_key: string; model: string; weighted_tokens: string | number }>(
    `SELECT identity_key, model, weighted_tokens FROM ai_model_usage_ledger
     WHERE identity_key = ANY($1::text[]) AND bucket_day = ${UTC_DAY}`,
    [keys],
  )
  const perKeyTotal = new Map<string, number>()
  const models = new Map<string, number>()
  for (const row of rows) {
    const w = Number(row.weighted_tokens) || 0
    perKeyTotal.set(row.identity_key, (perKeyTotal.get(row.identity_key) || 0) + w)
    models.set(row.model, Math.max(models.get(row.model) || 0, w))
  }
  return { total: Math.max(0, ...perKeyTotal.values()), models }
}

export async function quotaSnapshot(identity: Identity): Promise<QuotaSnapshot> {
  const plan = planForIdentity(identity)
  const { total, models } = await usageByModel(await quotaKeysFor(identity))
  const def = AI_PLANS[plan]
  const perModel: Record<string, ModelUsage> = {}
  for (const [model, limit] of Object.entries(def.model_quotas)) {
    const used = models.get(model) || 0
    perModel[model] = { used, limit, remaining: Math.max(0, limit - used) }
  }
  return {
    plan,
    unit: 'weighted_tokens',
    used: total,
    limit: def.daily_token_quota,
    remaining: Math.max(0, def.daily_token_quota - total),
    models: perModel,
    resetsAt: nextUtcMidnight(),
    ...(isAdmin(identity) ? { unlimited: true } : {}),
  }
}

/** Throws a message when the plan or model quota is already used up today. */
export async function quotaDenial(identity: Identity, model: string): Promise<string | null> {
  // Admins have no daily limit. Their usage is still charged for statistics.
  if (isAdmin(identity)) return null
  const snap = await quotaSnapshot(identity)
  if (snap.remaining <= 0) return `Daily AI limit reached (${snap.limit.toLocaleString('en-US')} tokens). It resets at 00:00 UTC.`
  const m = snap.models[model]
  if (m && m.remaining <= 0) return `Daily limit for this model reached (${m.limit.toLocaleString('en-US')} tokens). Pick another model or wait for 00:00 UTC.`
  return null
}

/** Charges one request to the daily quota. A multiplier (chat-only models) weighs it the Abstract AI way: (input + output) x multiplier. */
export async function chargeQuota(identity: Identity, model: string, inputTokens: number, outputTokens: number, multiplier?: number): Promise<number> {
  const weighted = multiplier === undefined
    ? weightedTokens(model, inputTokens, outputTokens)
    : Math.ceil((Math.max(0, inputTokens) + Math.max(0, outputTokens)) * multiplier)
  const keys = await quotaKeysFor(identity, true)
  await query(
    `INSERT INTO ai_model_usage_ledger (identity_key, bucket_day, model, weighted_tokens, input_tokens, output_tokens, requests, updated_at)
     SELECT k, ${UTC_DAY}, $2, $3::bigint, $4::bigint, $5::bigint, 1, NOW() FROM unnest($1::text[]) AS k
     ON CONFLICT (identity_key, bucket_day, model) DO UPDATE
       SET weighted_tokens = ai_model_usage_ledger.weighted_tokens + EXCLUDED.weighted_tokens,
           input_tokens = ai_model_usage_ledger.input_tokens + EXCLUDED.input_tokens,
           output_tokens = ai_model_usage_ledger.output_tokens + EXCLUDED.output_tokens,
           requests = ai_model_usage_ledger.requests + 1,
           updated_at = NOW()`,
    [keys, model, weighted, Math.max(0, Math.floor(inputTokens)), Math.max(0, Math.floor(outputTokens))],
  )
  return weighted
}
