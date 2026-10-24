import { AUTO_TARGET_ID } from './lib/auto-model.js'

// AI plans (shared by server and client): Free, No Ads (export type AiPlanId/month) and King
// Proxy ($5/month). A signed-in user's plan comes from the entitlement columns
// (planForEntitlement: users.paid_until -> King Proxy, users.noads_until -> No
// Ads). Abstract AI (abstract-plans.ts) is separate, with its own catalogue and
// quota. Quotas are daily weighted tokens, reset at 00:00 UTC:
//   weighted = input_tokens + output_tokens * model token_multiplier
// A request is rejected once the plan's daily quota OR that model's daily
// quota is used up. Plan models are served by the `premium` provider
// (config.ai.premium -> api.navy). Admins have no limit (server/ai-quota.ts).

export type AiPlanId = 'free' | 'no_ads' | 'king_proxy'
export type ModelCategory = 'fast' | 'balanced' | 'reasoning' | 'flagship'

export interface PlanModelSettings {
  display_name: string
  provider: string
  category: ModelCategory
  token_multiplier: number
}

export interface AiPlan {
  label: string
  price_usd_month: number
  daily_token_quota: number
  ads_enabled: boolean
  instant_game_start: boolean
  discord_links_per_month: number
  priority_queue: boolean
  model_quotas: Record<string, number>
}

export const AI_MODEL_SETTINGS: Record<string, PlanModelSettings> = {
  'gpt-6-luna': { display_name: 'GPT-6 Luna', provider: 'openai', category: 'fast', token_multiplier: 2 },
  'gpt-6-sol': { display_name: 'GPT-6 Sol', provider: 'openai', category: 'balanced', token_multiplier: 9 },
  'gpt-6.1-sol': { display_name: 'GPT-6.1 Sol', provider: 'openai', category: 'balanced', token_multiplier: 9 },
  'gpt-6-astra': { display_name: 'GPT-6 Astra', provider: 'openai', category: 'flagship', token_multiplier: 25 },
  'gpt-5.6-luna': { display_name: 'GPT-5.6 Luna', provider: 'openai', category: 'fast', token_multiplier: 2 },
  'gpt-5.6-terra': { display_name: 'GPT-5.6 Terra', provider: 'openai', category: 'balanced', token_multiplier: 9 },
  'gpt-5.6-sol': { display_name: 'GPT-5.6 Sol', provider: 'openai', category: 'flagship', token_multiplier: 16 },
  'gpt-5.5': { display_name: 'GPT-5.5', provider: 'openai', category: 'flagship', token_multiplier: 22 },
  'gemini-3.1-flash-lite': { display_name: 'Gemini 3.1 Flash Lite', provider: 'google', category: 'fast', token_multiplier: 2 },
  'gemini-3.8-flash': { display_name: 'Gemini 3.8 Flash', provider: 'google', category: 'balanced', token_multiplier: 5.5 },
  'gemini-3.8-flash-thinking': { display_name: 'Gemini 3.8 Flash Thinking', provider: 'google', category: 'reasoning', token_multiplier: 5.5 },
  'gemini-3.1-pro-preview': { display_name: 'Gemini 3.1 Pro', provider: 'google', category: 'flagship', token_multiplier: 10 },
  'gemini-4-argon': { display_name: 'Gemini 4 Argon', provider: 'google', category: 'flagship', token_multiplier: 12 },
  'deepseek-v4.1-flash': { display_name: 'DeepSeek V4.1 Flash', provider: 'deepseek', category: 'fast', token_multiplier: 1 },
  'deepseek-v4-flash-0731': { display_name: 'DeepSeek V4 Flash 0731', provider: 'deepseek', category: 'fast', token_multiplier: 1 },
  'qwen3.8-27b': { display_name: 'Qwen3.8 27B', provider: 'qwen', category: 'balanced', token_multiplier: 1 },
  'mimo-v2.6-flash': { display_name: 'MiMo V2.6 Flash', provider: 'xiaomi', category: 'fast', token_multiplier: 1.2 },
  'minimax-m3': { display_name: 'MiniMax M3', provider: 'minimax', category: 'balanced', token_multiplier: 2 },
  'glm-5.3-flash': { display_name: 'GLM 5.3 Flash', provider: 'z-ai', category: 'fast', token_multiplier: 2 },
  'glm-5.3': { display_name: 'GLM 5.3', provider: 'z-ai', category: 'reasoning', token_multiplier: 4 },
  'glm-5.2': { display_name: 'GLM 5.2', provider: 'z-ai', category: 'reasoning', token_multiplier: 4 },
  'claude-sonnet-4.6': { display_name: 'Claude Sonnet 4.6', provider: 'anthropic', category: 'balanced', token_multiplier: 12 },
  'claude-sonnet-5': { display_name: 'Claude Sonnet 5', provider: 'anthropic', category: 'balanced', token_multiplier: 12 },
  'claude-sonnet-5.5': { display_name: 'Claude Sonnet 5.5', provider: 'anthropic', category: 'balanced', token_multiplier: 12 },
  'claude-opus-4.6': { display_name: 'Claude Opus 4.6', provider: 'anthropic', category: 'flagship', token_multiplier: 20 },
  'claude-opus-4.7': { display_name: 'Claude Opus 4.7', provider: 'anthropic', category: 'flagship', token_multiplier: 20 },
  'claude-opus-4.8': { display_name: 'Claude Opus 4.8', provider: 'anthropic', category: 'flagship', token_multiplier: 20 },
  'claude-opus-5': { display_name: 'Claude Opus 5', provider: 'anthropic', category: 'flagship', token_multiplier: 20 },
  'claude-opus-5.5': { display_name: 'Claude Opus 5.5', provider: 'anthropic', category: 'flagship', token_multiplier: 17 },
  'mistral-medium-3-5': { display_name: 'Mistral Medium 3.5', provider: 'mistral', category: 'balanced', token_multiplier: 8 },
}

export const AI_PLANS: Record<AiPlanId, AiPlan> = {
  free: {
    label: 'Free',
    price_usd_month: 0,
    daily_token_quota: 20000,
    ads_enabled: true,
    instant_game_start: false,
    discord_links_per_month: 2,
    priority_queue: false,
    model_quotas: {
      'gpt-6-luna': 5000,
      'gpt-5.6-luna': 3000,
      'gemini-3.1-flash-lite': 8000,
      'deepseek-v4.1-flash': 12000,
      'deepseek-v4-flash-0731': 12000,
      'qwen3.8-27b': 10000,
      'mimo-v2.6-flash': 10000,
      'minimax-m3': 4000,
      'glm-5.3-flash': 10000,
      'glm-5.2': 3000,
      'claude-sonnet-4.6': 1000,
      'claude-sonnet-5': 500,
    },
  },
  no_ads: {
    label: 'No Ads',
    price_usd_month: 1,
    daily_token_quota: 60000,
    ads_enabled: false,
    instant_game_start: true,
    discord_links_per_month: 4,
    priority_queue: false,
    model_quotas: {
      'gpt-6-luna': 15000,
      'gpt-6-sol': 8000,
      'gpt-6.1-sol': 5000,
      'gpt-5.6-luna': 10000,
      'gpt-5.6-terra': 5000,
      'gemini-3.1-flash-lite': 25000,
      'gemini-3.8-flash': 10000,
      'gemini-3.8-flash-thinking': 5000,
      'gemini-3.1-pro-preview': 1000,
      'deepseek-v4.1-flash': 40000,
      'deepseek-v4-flash-0731': 40000,
      'qwen3.8-27b': 30000,
      'mimo-v2.6-flash': 30000,
      'minimax-m3': 15000,
      'glm-5.3-flash': 30000,
      'glm-5.3': 8000,
      'glm-5.2': 10000,
      'claude-sonnet-4.6': 3000,
      'claude-sonnet-5': 2000,
      'mistral-medium-3-5': 3000,
    },
  },
  king_proxy: {
    label: 'King Proxy',
    price_usd_month: 5,
    daily_token_quota: 200000,
    ads_enabled: false,
    instant_game_start: true,
    discord_links_per_month: 8,
    priority_queue: true,
    model_quotas: {
      'gpt-6-luna': 50000,
      'gpt-6-sol': 25000,
      'gpt-6.1-sol': 25000,
      'gpt-6-astra': 5000,
      'gpt-5.6-luna': 50000,
      'gpt-5.6-terra': 25000,
      'gpt-5.6-sol': 5000,
      'gpt-5.5': 3000,
      'gemini-3.1-flash-lite': 100000,
      'gemini-3.8-flash': 50000,
      'gemini-3.8-flash-thinking': 20000,
      'gemini-3.1-pro-preview': 5000,
      'gemini-4-argon': 3000,
      'deepseek-v4.1-flash': 150000,
      'deepseek-v4-flash-0731': 150000,
      'qwen3.8-27b': 100000,
      'mimo-v2.6-flash': 100000,
      'minimax-m3': 50000,
      'glm-5.3-flash': 100000,
      'glm-5.3': 20000,
      'glm-5.2': 30000,
      'claude-sonnet-4.6': 10000,
      'claude-sonnet-5': 10000,
      'claude-sonnet-5.5': 8000,
      'claude-opus-4.6': 2000,
      'claude-opus-4.7': 2000,
      'claude-opus-4.8': 2000,
      'claude-opus-5': 1500,
      'claude-opus-5.5': 2000,
      'mistral-medium-3-5': 10000,
    },
  },
}

export const AI_PLAN_ORDER: AiPlanId[] = ['free', 'no_ads', 'king_proxy']

/** Model used when the caller picks "Auto". The same target the client resolves Auto to (lib/auto-model.ts). */
export const AUTO_MODEL = AUTO_TARGET_ID

export function isAiPlanId(value: unknown): value is AiPlanId {
  return value === 'free' || value === 'no_ads' || value === 'king_proxy'
}

/** The cheapest plan that includes `model`, or null when no plan does. */
export function minPlanForModel(model: string): AiPlanId | null {
  return AI_PLAN_ORDER.find((plan) => planAllowsModel(plan, model)) ?? null
}

/** A user's AI plan from the entitlement columns: paid_until = King Proxy, noads_until = No Ads. */
export function planForEntitlement(user: { paid_until?: Date | string | null; noads_until?: Date | string | null } | null | undefined, now = Date.now()): AiPlanId {
  const active = (value: Date | string | null | undefined) => value != null && new Date(value).getTime() > now
  if (active(user?.paid_until)) return 'king_proxy'
  if (active(user?.noads_until)) return 'no_ads'
  return 'free'
}

export function planAllowsModel(plan: AiPlanId, model: string): boolean {
  return model in AI_PLANS[plan].model_quotas
}

export function modelMultiplier(model: string): number {
  return AI_MODEL_SETTINGS[model]?.token_multiplier ?? 1
}

export function weightedTokens(model: string, inputTokens: number, outputTokens: number): number {
  const input = Math.max(0, Math.floor(inputTokens || 0))
  const output = Math.max(0, Math.floor(outputTokens || 0))
  return Math.ceil(input + output * modelMultiplier(model))
}
