import { AI_MODEL_SETTINGS, planAllowsModel, type ModelCategory } from './ai-plans.js'

export interface AiModel {
  id: string
  display_name?: string
  tier: 'free' | 'paid'
  thinking?: string
  provider?: 'free' | 'premium' | 'vertex' | 'cloudflare'
  upstreamId?: string
  category?: ModelCategory
  hidden?: boolean
}

// Every user-facing model comes from the plan catalog (ai-plans.ts) and is
// served by the `premium` provider. `tier` is 'free' when the free plan includes
// the model; anything else is not offered to plan holders (admins still can use it).
const PLAN_MODELS: AiModel[] = Object.entries(AI_MODEL_SETTINGS).map(([id, settings]) => ({
  id,
  display_name: settings.display_name,
  tier: planAllowsModel('free', id) ? 'free' : 'paid',
  provider: 'premium',
  category: settings.category,
}))

// Server-internal models, never offered to users (avatar moderation uses it).
const INTERNAL_MODELS: AiModel[] = [
  { id: 'gemini-3.8-flash-high', display_name: 'Gemini 3.8 Flash', tier: 'paid', thinking: 'high', provider: 'free', hidden: true },
]

export const AI_MODELS: AiModel[] = [
  { id: 'auto', display_name: 'Auto', tier: 'free' },
  ...PLAN_MODELS,
  ...INTERNAL_MODELS,
]

/** Models a user may pick (excludes server-internal ones). */
export const USER_AI_MODELS: AiModel[] = AI_MODELS.filter((m) => !m.hidden)

export const THINKING_BY_ID: Record<string, string> = Object.fromEntries(
  AI_MODELS.filter((m) => m.thinking).map((m) => [m.id, m.thinking as string]),
)

export function resolveModel(model: string | undefined): { id: string | undefined; thinking?: string } {
  const raw = (model || '').trim().toLowerCase()
  if (!raw || raw === 'auto') return { id: undefined }
  const catalogModel = AI_MODELS.find((entry) => entry.id === raw)
  if (catalogModel?.upstreamId) return { id: catalogModel.upstreamId, thinking: catalogModel.thinking }
  const thinking = THINKING_BY_ID[raw]
  if (thinking) {
    return { id: raw.replace(/-(max|high)$/, ''), thinking }
  }
  const match = raw.match(/-(max|high|medium|low)$/)
  if (match) {
    return { id: raw.slice(0, -match[0].length), thinking: match[1] }
  }
  return { id: raw }
}

export function providerForModelId(model: string | undefined): 'free' | 'premium' | 'vertex' | 'cloudflare' {
  const raw = (model || '').trim().toLowerCase()
  if (!raw || raw === 'auto') return 'free'
  // Accept bare Cloudflare upstream slugs / aliases that aren't in the static catalog yet.
  if (raw.startsWith('@cf/') || raw.startsWith('cloudflare/')) return 'cloudflare'
  return AI_MODELS.find((entry) => entry.id === raw)?.provider ?? 'premium'
}

export function isFreeTierModel(id: string): boolean {
  return AI_MODELS.some((m) => m.tier === 'free' && m.id === id)
}
