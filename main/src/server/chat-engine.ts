import { query } from './db.js'
import { loadConfig } from './config.js'
import { findEnabledModel } from './abstract-relay/models.ts'
import { getThinking, thinkingFor } from './model-catalog.ts'
import { loadCandidates, servesModel } from './abstract-relay/upstream.ts'
import { readWindowSnapshot, recordUsage } from './abstract-relay/store.ts'
import { checkPreflight, isPlanId, unitsFor, usageLimitMessage } from './abstract-relay/windows.ts'
import { activeAbstractPlan } from '../abstract-plans.ts'
import { resolveModel as resolveRelayModel, applyPersonaToMessages, type Persona } from './abstract-relay/personas.ts'
import { findChatOnlyModel, type ChatOnlyFound } from './chat-models.ts'

/** A platform Abstract AI model's meter: whose windows it counts against, at what multiplier. */
interface AbstractMeter {
  userId: number
  model: string
  multiplier: number
}

/** The thinking choices a user may make. Anything else is dropped, not guessed at. Off is sent only where the model can be switched off. */
const THINKING_CHOICES: ReadonlySet<string> = new Set(['off', 'low', 'medium', 'high', 'max'])

/**
 * Where an Abstract AI send goes. The picked name may be a house name (a persona such
 * as evilcoder-gamma): it resolves to its base model, and the persona's system prompt
 * is applied to the conversation, as it is on the API.
 */
interface AbstractRoute {
  provider: ProviderConfig
  /** Null for a chat-only model: it is not an Abstract AI model, so no plan units are counted. */
  meter: AbstractMeter | null
  /** The upstream model id, as the catalogue names it (or, for a chat-only model, as its upstream lists it). */
  upstreamModel: string
  persona: Persona | null
  /** The thinking the user chose for this model. Undefined sends no reasoning field. */
  thinking: string | undefined
  /** A chat-only model's config multiplier, charged to the platform's daily quota. Absent for every other route. */
  chatOnlyMultiplier?: number
}

/** The prefix the client puts before a chat-only model id, for example "chat:claude-haiku-5-5". */
const CHAT_ONLY_PREFIX = 'chat:'

/**
 * A send to a chat-only model (config chatOnly upstreams). The id must be in the current chat-only list, so an
 * id the upstream does not list is never forwarded. Free for everyone, guests included: no plan gate and no plan
 * units. The daily caps still apply (guest requests, or the platform's weighted-token cap), weighed by the model's
 * config multiplier (see generate).
 */
async function chatOnlyRoute(model: string | undefined): Promise<AbstractRoute> {
  const raw = (model || '').trim()
  const found = await findChatOnlyModel(raw.slice(CHAT_ONLY_PREFIX.length))
  if (!found) throw new ops.OpError(503, 'That model is not available right now.')
  return chatOnlyRouteFor(found, null)
}

/** The route for a chat-only model that was found, with the house persona on top when a persona names it. */
async function chatOnlyRouteFor(found: ChatOnlyFound, persona: Persona | null): Promise<AbstractRoute> {
  const multiplier = await chatOnlyMultiplier(found.model.id)
  // The provider appends /chat/completions, so the base URL must end in /v1.
  const baseUrl = `${found.upstream.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`
  return {
    provider: { baseUrl, apiKey: found.upstream.apiKey, model: found.model.id, endpoint: 'chat-completions', auth: 'api-key' },
    meter: null,
    upstreamModel: found.model.id,
    persona,
    // The upstream's chat-only models carry no verified thinking levels, so no reasoning field is sent.
    thinking: undefined,
    chatOnlyMultiplier: multiplier,
  }
}

/** The upstream a send goes to: a chat-only model, an Abstract AI model, or null for the platform (and custom) path. */
function routeFor(identity: Identity, model: string | undefined, thinking: string | undefined, providers: ProviderSet): Promise<AbstractRoute | null> {
  return (model || '').trim().startsWith(CHAT_ONLY_PREFIX)
    ? chatOnlyRoute(model)
    : abstractRoute(identity, model, thinking, providers)
}

/**
 * A send to an Abstract AI model. No key: the signed-in user's plan decides access,
 * and their 5-hour and weekly windows decide whether this request may run. Null for
 * any other model. A persona with a web route (personas/*.json) runs on the Cloudflare
 * playground; the plan checks and meter are the same as for its API model.
 */
async function abstractRoute(identity: Identity, model: string | undefined, thinking: string | undefined, providers: ProviderSet): Promise<AbstractRoute | null> {
  const requested = (model || '').trim().toLowerCase()
  if (!requested) return null
  const named = resolveRelayModel(requested)
  const catalogued = await findEnabledModel(named.upstream)
  if (!catalogued) {
    // A house name whose base model is off in the plan catalogue is served free as a chat-only model when one lists it
    // (Abstract Free). The persona goes on top of that route, and it is free to everyone, as chat-only models are.
    if (named.persona) {
      const free = await findChatOnlyModel(named.upstream)
      if (free) return chatOnlyRouteFor(free, named.persona)
      throw new ops.OpError(503, 'That model is not available right now.')
    }
    // A platform model whose base is off is not a platform model.
    return null
  }
  if (identity.isGuest || !identity.user) throw new ops.OpError(401, 'Sign in to use this model.')
  const userId = identity.user.id
  const { rows } = await query<{ plan: string | null; plan_until: Date | string | null; admin: boolean }>(
    'SELECT plan, plan_until, admin FROM users WHERE id = $1',
    [userId],
  )
  const row = rows[0]
  // Admins use every model at the largest plan's allowance.
  const plan: string | null = row?.admin ? 'max' : activeAbstractPlan({ plan: row?.plan ?? null, plan_until: row?.plan_until ?? null })
  if (!plan || !isPlanId(plan)) throw new ops.OpError(402, 'An Abstract AI plan is needed to use this model.')
  const snapshot = await readWindowSnapshot(userId)
  // Admins have no usage limit; their usage is still recorded.
  const check = row?.admin ? { ok: true as const } : checkPreflight({ plan, multiplier: catalogued.multiplier, nowMs: snapshot.nowMs, rows: snapshot.rows })
  if (!check.ok) throw new ops.OpError(429, usageLimitMessage(check.limit))
  if (named.persona?.cloudflareModel) {
    // Fails closed: when the playground is off, the send is refused rather than sent to an API upstream.
    if (!providers.cloudflare) throw new ops.OpError(503, 'That model is not available right now.')
    return {
      provider: { ...providers.cloudflare, model: named.persona.cloudflareModel },
      meter: { userId, model: requested, multiplier: catalogued.multiplier },
      upstreamModel: named.persona.cloudflareModel,
      persona: named.persona,
      // The playground takes no reasoning level, so none is sent.
      thinking: undefined,
    }
  }
  const config = await loadConfig()
  // Abstract AI models are resold: only a paid OpenAI-protocol upstream serves them, and one that the config pins
  // to other models (config models) does not take this one.
  const relay = loadCandidates(config.ai?.upstreams)
  const candidate = relay.find((c) => c.paid && c.protocol === 'openai' && servesModel(relay, c, catalogued.id))
  if (!candidate) throw new ops.OpError(503, 'Abstract AI is not configured.')
  // The provider appends /chat/completions, so the base URL must end in /v1.
  const baseUrl = `${candidate.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`
  return {
    provider: { baseUrl, apiKey: candidate.apiKey, model: catalogued.id, endpoint: 'chat-completions', auth: 'api-key' },
    meter: { userId, model: requested, multiplier: catalogued.multiplier },
    upstreamModel: catalogued.id,
    persona: named.persona,
    // Checked against what the model verified: a level it accepts, or Off where it has a switch. Anything else sends no reasoning field.
    thinking: thinkingFor(thinking && THINKING_CHOICES.has(thinking) ? thinking : undefined, await getThinking(catalogued.id)),
  }
}
import { callProvider, callProviderWithTools, type ChatInputMessage, type ProviderConfig, type ProviderSet, type ToolEvent, type ToolSpec } from './ai-providers.js'
import { SYSTEM_CONTEXT } from './ai-prompt.js'
import type { WebSearchTools } from './web-search.js'
import { buildWebToolSpecs, runWebTool } from './web-tool-specs.js'
import { CLIENT_TOOL_IDS, SERVER_BUILTIN_IDS, builtinToolSpecs, toolSpecEnabled } from '../lib/chat-tools.ts'
import { cancelClientToolsFor, requestClientTool } from './client-tools.js'
import { resolveAutoModel } from '../lib/auto-model.ts'
import { emit } from './events.js'
import * as ops from './thread-ops.js'
import type { Identity } from './identity.js'
import { providerForModelId, resolveModel } from '../ai-models.js'
import { ledgerAdjust, ledgerKeysFor } from './ai-usage-ledger.js'
import { chatOnlyMultiplier } from './abstract-relay/models.js'
import { chargeQuota, planAccessDenial, planForIdentity, planModelId, quotaDenial, quotaSnapshot } from './ai-quota.js'
import { logTraffic } from './traffic-log.js'
import { customRouteFor, scrubSecrets, type CustomHeaders, type CustomRoute } from './ai-settings/send-route.js'

export interface Limits { requestsPerDay: number; perMinute: number; contextTokens: number }
export type AiLimits = {
  perMinute?: number
  guestRequestsTotal?: number
  freeRequestsPerDay?: number
  freeContextTokens?: number
}

export function limitsFor(tier: 'guest' | 'free', limits: AiLimits): Limits {
  const perMinute = limits.perMinute ?? 30
  if (tier === 'free') {
    return { perMinute, requestsPerDay: limits.freeRequestsPerDay ?? 40, contextTokens: limits.freeContextTokens ?? 8000 }
  }
  return { perMinute, requestsPerDay: limits.guestRequestsTotal ?? 4, contextTokens: limits.freeContextTokens ?? 8000 }
}

export function tierOf(identity: Identity): 'guest' | 'free' {
  return identity.isGuest ? 'guest' : 'free'
}

function contentTextLen(content: ChatInputMessage['content']): number {
  if (typeof content === 'string') return content.length
  return content.filter((p) => p.type === 'text').reduce((sum, p) => sum + (p.type === 'text' ? p.text.length : 0), 0)
}

function imageCountOf(content: ChatInputMessage['content']): number {
  return Array.isArray(content) ? content.filter((p) => p.type === 'image_url').length : 0
}

function messageCost(content: ChatInputMessage['content']): number {
  return Math.ceil(contentTextLen(content) / 4) + imageCountOf(content) * 800
}

function pruneMessages(messages: ChatInputMessage[], cap: number): ChatInputMessage[] {
  const system = messages.filter((m) => m.role === 'system')
  const turns = messages.filter((m) => m.role !== 'system')
  const systemTokens = system.reduce((sum, m) => sum + messageCost(m.content), 0)
  let budget = Math.max(256, cap - systemTokens)
  const kept: ChatInputMessage[] = []
  for (let i = turns.length - 1; i >= 0; i--) {
    const msg = turns[i]
    const cost = messageCost(msg.content)
    if (kept.length > 0 && cost > budget) break
    budget -= cost
    kept.unshift(msg)
  }
  return [...system, ...kept]
}

const minuteBuckets = new Map<string, { minute: number; count: number }>()
export function checkMinute(ownerKey: string, perMinute: number): boolean {
  const minute = Math.floor(Date.now() / 60000)
  const entry = minuteBuckets.get(ownerKey)
  if (!entry || entry.minute !== minute) {
    minuteBuckets.set(ownerKey, { minute, count: 1 })
    return true
  }
  if (entry.count >= perMinute) return false
  entry.count += 1
  return true
}

export interface EngineDeps {
  limits: AiLimits
  providers: ProviderSet

  webTools?: WebSearchTools
}

// Plan access (ai-plans.ts): the caller's plan must include the model. Every
// plan model is served by the provider ai-models.ts maps it to (premium).
// Cloudflare slugs ('@cf/...') are the free tier for everyone, guests included:
// they are not in any plan's catalogue, so they skip the plan check. The daily
// request and weighted-token limits still apply to them (quotaDenial / charge).
function providerForModel(deps: EngineDeps, identity: Identity, modelId: string): ProviderConfig {
  const providerKey = providerForModelId(modelId)
  // Admins are not held to a plan: they can use every model.
  if (providerKey !== 'cloudflare' && !identity.user?.admin) {
    const denial = planAccessDenial(planForIdentity(identity), modelId)
    if (denial) throw new ops.OpError(403, denial)
  }
  const provider = deps.providers[providerKey]
  if (!provider) {
    const label = providerKey === 'vertex'
      ? 'Vertex AI'
      : providerKey === 'cloudflare'
        ? 'Abstract Free'
        : 'AI'
    throw new ops.OpError(503, `${label} provider is not configured.`)
  }
  return provider
}

async function emitUsage(identity: Identity, lim: Limits): Promise<void> {
  try {
    const snapshot = await quotaSnapshot(identity)
    if (identity.isGuest) {
      const { rows } = await query<{ requests: number }>('SELECT requests FROM guest_ai_usage WHERE ip = $1', [identity.ip])
      await emit(identity.ownerKey, 'usage.updated', { ...snapshot, guest: true, guestRequests: rows[0]?.requests ?? 0, guestRequestLimit: lim.requestsPerDay })
      return
    }
    await emit(identity.ownerKey, 'usage.updated', { ...snapshot })
  } catch (error) {
    console.warn('[ai] usage snapshot failed:', error instanceof Error ? error.message : error)
  }
}

const TITLE_SYSTEM_PROMPT = `You are an expert in crafting ultra-compact titles for chatbot conversations. You are presented with a chat request, and you reply with only a brief title that captures the main topic of that request.
Write the title in sentence case, not title case. Preserve product names, abbreviations, code symbols, and proper nouns.
Aim for 3-6 words. Prefer the shortest accurate title.
Drop articles like "a", "an", and "the" unless needed for clarity.
Drop filler and generic framing like "help with", "question about", "request for", or "issue with".
Prefer short, concrete synonyms and omit unnecessary words.
Do not wrap the title in quotes or add trailing punctuation.
Here are some examples of good titles:
- Git rebase question
- Install Python packages
- LinkedList implementation location
- Add VS Code tree view
- React useState usage`

async function autoTitle(deps: EngineDeps, identity: Identity, threadId: string, requestText: string, custom: CustomRoute | null): Promise<void> {
  try {

    if ((await ops.getTitle(threadId, identity.ownerKey)) !== 'New chat') return

    // A custom endpoint titles its own chats, so the platform never sees them.
    const provider = custom ? custom.provider : (deps.providers.free ?? deps.providers.premium)
    if (!provider) return
    const result = await callProvider(provider, [
      { role: 'system', content: TITLE_SYSTEM_PROMPT } as ChatInputMessage,
      { role: 'user', content: `Please write a brief title for the following request:\n\n${requestText.slice(0, 1000)}` } as ChatInputMessage,
    ])
    let title = (result.reply ?? '').trim()
    if (/^".*"$/.test(title)) title = title.slice(1, -1)
    title = title.split('\n')[0].trim().slice(0, 80)
    if (!title || title.includes("can't assist with that")) return

    if ((await ops.getTitle(threadId, identity.ownerKey)) !== 'New chat') return
    await ops.setThreadTitle(threadId, identity.ownerKey, title)
  } catch {
    // Title generation is best-effort - never fail the chat op for it.
  }
}

async function charge(identity: Identity, lim: Limits, tokens: number, extraMeta: Record<string, unknown> = {}): Promise<void> {
  if (identity.isGuest) {

    const { rows } = await query<{ requests: number }>(
      `INSERT INTO guest_ai_usage (ip, requests, tokens) VALUES ($1, 1, $2)
       ON CONFLICT (ip) DO UPDATE SET requests = guest_ai_usage.requests + 1, tokens = guest_ai_usage.tokens + $2
       RETURNING requests`,
      [identity.ip, Math.max(0, Math.floor(tokens))],
    )
    const used = rows[0]?.requests ?? 1
    if (used > lim.requestsPerDay) {

      await query(`UPDATE guest_ai_usage SET requests = requests - 1 WHERE ip = $1`, [identity.ip])
      throw new ops.OpError(429, 'guest_limit')
    }
    void logTraffic({
      kind: 'ai',
      ip: identity.ip,
      country: identity.country,
      city: identity.city,
      region: identity.region,
      path: '/api/ai',
      meta: { guest: true, tokens: Math.max(0, Math.floor(tokens)) },
    })
    return
  }
  // Signed-in limits are weighted-token quotas (ai-quota.ts); request counts
  // stay in the person-level ledger for statistics.
  const userId = identity.user!.id
  const keys = await ledgerKeysFor(identity.user!, true)
  await ledgerAdjust(keys, 1, tokens)
  // Per-account counter, kept for admin statistics only (no enforcement).
  await query(
    `INSERT INTO ai_usage (user_id, day, requests, tokens) VALUES ($1, CURRENT_DATE, 1, $2)
     ON CONFLICT (user_id, day) DO UPDATE SET requests = ai_usage.requests + 1, tokens = ai_usage.tokens + $2`,
    [userId, Math.max(0, Math.floor(tokens))],
  )
  void logTraffic({
    kind: 'ai',
    ip: identity.ip,
    country: identity.country,
    city: identity.city,
    region: identity.region,
    userId,
    path: '/api/ai',
    meta: { tokens: Math.max(0, Math.floor(tokens)), ...extraMeta },
  })
}

async function chargeTokens(identity: Identity, tokens: number): Promise<void> {
  if (!Number.isFinite(tokens) || tokens <= 0) return
  const t = Math.floor(tokens)
  if (identity.isGuest) {
    await query(`UPDATE guest_ai_usage SET tokens = tokens + $2 WHERE ip = $1`, [identity.ip, t])
    return
  }
  await ledgerAdjust(await ledgerKeysFor(identity.user!, false), 0, t)
  await query(
    `INSERT INTO ai_usage (user_id, day, requests, tokens) VALUES ($1, CURRENT_DATE, 0, $2)
     ON CONFLICT (user_id, day) DO UPDATE SET tokens = ai_usage.tokens + $2`,
    [identity.user!.id, t],
  )
}

async function refund(identity: Identity, lim: Limits): Promise<void> {
  if (identity.isGuest) {
    await query(`UPDATE guest_ai_usage SET requests = GREATEST(0, requests - 1) WHERE ip = $1`, [identity.ip])
  } else {
    await ledgerAdjust(await ledgerKeysFor(identity.user!, false), -1, 0)
    await query(
      `UPDATE ai_usage SET requests = GREATEST(0, requests - 1) WHERE user_id = $1 AND day = CURRENT_DATE`,
      [identity.user!.id],
    )
  }
  await emitUsage(identity, lim)
}

interface GenerationEntry {
  cancelled: boolean
  reject: (error: Error) => void
  done: Promise<void>
}
const SUBAGENT_SYSTEM = 'You are a subagent working for another agent. Complete the task you are given with the tools available. Reply with a short final answer: what you did and the results the caller needs. Do not ask questions; make reasonable choices and say what you assumed.'

const generations = new Map<string, GenerationEntry>()

function generationRace<T>(threadId: string, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const entry = generations.get(threadId)
    if (!entry) {
      work.then(resolve, reject)
      return
    }
    entry.reject = reject
    work.then(resolve, reject)
  })
}

async function stopGeneration(threadId: string): Promise<void> {
  const entry = generations.get(threadId)
  if (!entry) return
  entry.cancelled = true
  entry.reject(new ops.OpError(499, 'Generation cancelled'))
  await entry.done.catch(() => {})
}

/** `shown` is the model the request asked for, as the menu names it (Auto stays "auto"). The reply records that, never the upstream id Auto resolves to. */
async function generate(deps: EngineDeps, identity: Identity, threadId: string, model: string | undefined, custom: CustomRoute | null, thinking: string | undefined, toolIds: string[] | undefined, shown: string | undefined): Promise<ops.ThreadMessage | null> {
  const lim = limitsFor(tierOf(identity), deps.limits)
  // A custom endpoint (ai-settings/) is not the platform plan: no plan access,
  // no weighted quota, and its own provider.
  const route = custom ? null : await routeFor(identity, model, thinking, deps.providers)
  const modelId = custom ? custom.model : route ? route.upstreamModel : planModelId(model)
  const provider = custom ? custom.provider : route ? route.provider : providerForModel(deps, identity, modelId)
  // Platform models and chat-only models count against the platform's daily cap. An Abstract AI model has
  // its own plan windows instead (route.meter), so it skips this check.
  if (!custom && !route?.meter) {
    const denied = await quotaDenial(identity, modelId)
    if (denied) throw new ops.OpError(429, denied)
  }

  await charge(identity, lim, 0, custom ? { provider: 'custom', model: custom.model } : {})

  await ops.setGenerating(threadId, identity.ownerKey, true)
  const entry: GenerationEntry = { cancelled: false, reject: () => {}, done: Promise.resolve() }
  generations.set(threadId, entry)
  const run = runGeneration(deps, identity, threadId, modelId, lim, provider, entry, custom, route, toolIds, shown)

  entry.done = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function runGeneration(deps: EngineDeps, identity: Identity, threadId: string, modelId: string, lim: Limits, provider: ProviderConfig, entry: GenerationEntry, custom: CustomRoute | null, route: AbstractRoute | null, toolIds: string[] | undefined, shown: string | undefined): Promise<ops.ThreadMessage | null> {
  const abstractMeter = route?.meter ?? null
  const started = Date.now()
  try {
    const context = await ops.contextMessages(threadId)

    const TEXTUAL = /^(text\/|application\/(json|javascript|xml|x-yaml|yaml|toml|x-sh|x-httpd-php)|image\/svg\+xml)/
    const decodeText = (url: string): string | null => {
      const comma = url.indexOf(',')
      if (comma < 0) return null
      const meta = url.slice(0, comma)
      const data = url.slice(comma + 1)
      try {
        if (meta.includes(';base64')) return Buffer.from(data, 'base64').toString('utf8')
        return decodeURIComponent(data)
      } catch {
        return null
      }
    }
    const providerMessages: ChatInputMessage[] = context.map((m) => {
      const attachments = m.attachments || []
      const images = attachments.filter((a) => a.mime.startsWith('image/') && !a.mime.includes('svg') && a.url.startsWith('data:image/'))

      const fileNotes: string[] = []
      for (const a of attachments) {
        if (a.mime.startsWith('image/') && !a.mime.includes('svg')) continue
        const isText = TEXTUAL.test(a.mime) || /\.(txt|md|markdown|json|js|jsx|ts|tsx|css|html|xml|csv|ya?ml|toml|sh|py|java|c|h|cpp|rs|go|rb|php|sql|svg|log|ini|env)$/i.test(a.name)
        if (!isText) {
          fileNotes.push(`[Attached file: ${a.name} (${a.mime || 'unknown type'}) - binary content not shown]`)
          continue
        }
        const text = decodeText(a.url)
        if (text === null) {
          fileNotes.push(`[Attached file: ${a.name} (${a.mime || 'unknown type'}) - content not shown]`)
          continue
        }
        const clipped = text.length > 12000 ? `${text.slice(0, 12000)}\n… (truncated)` : text
        fileNotes.push(`[Attached file: ${a.name}]\n\`\`\`\n${clipped}\n\`\`\``)
      }
      const textContent = [m.content, ...fileNotes].filter(Boolean).join('\n\n')
      if (m.role === 'user' && images.length) {
        const parts: ChatInputMessage['content'] = [
          { type: 'text', text: textContent },
          ...images.map((a) => ({ type: 'image_url' as const, image_url: { url: a.url } })),
        ]
        return { role: m.role, content: parts } as ChatInputMessage
      }
      return { role: m.role, content: textContent } as ChatInputMessage
    })
    // A persona replaces the system prompt and adds its primer turns, so it must run BEFORE pruning:
    // the persona's system prompt (which can be 36KB) must be counted in the pruner's budget. Without
    // this order the budget was calculated against the short platform prompt, and the final payload
    // overshot the context window by thousands of tokens.
    const withSystem = [{ role: 'system', content: SYSTEM_CONTEXT } as ChatInputMessage, ...providerMessages]
    const withPersona = route?.persona
      ? (applyPersonaToMessages(withSystem as unknown as Parameters<typeof applyPersonaToMessages>[0], route.persona) as unknown as ChatInputMessage[])
      : withSystem
    const messages = pruneMessages(withPersona, lim.contextTokens)
    const resolved = custom
      ? { id: custom.model, thinking: custom.thinking }
      : route
        ? { id: route.upstreamModel, thinking: route.thinking }
        : resolveModel(modelId)

    // The menu's choice for this turn. No selection sent means every tool.
    const enabled = toolIds ? new Set(toolIds) : undefined
    const specs: ToolSpec[] = [
      ...(deps.webTools ? buildWebToolSpecs() : []),
      ...builtinToolSpecs(enabled, CLIENT_TOOL_IDS),
      ...builtinToolSpecs(enabled, SERVER_BUILTIN_IDS),
    ].filter((spec) => toolSpecEnabled(enabled, spec.name))
    const toolCallsMeta: ops.ToolCallMeta[] = []
    const thinkingStart = Date.now()
    let sawTool = false
    let firstTextAt = 0
    let answerLength = 0

    // A subagent is one more generation: the same provider and model, the enabled tools minus itself, and
    // its final text as the result. Its own tool calls are not shown in this turn's trace.
    const runSubagent = async (task: string): Promise<string> => {
      const inner = specs.filter((spec) => spec.name !== 'runSubagent')
      const answer = await callProviderWithTools(provider, [
        { role: 'system', content: SUBAGENT_SYSTEM },
        { role: 'user', content: task },
      ], resolved.id, {
        thinking: resolved.thinking,
        tools: inner.length ? inner : undefined,
        allowedTools: inner.map((spec) => spec.name),
        toolBridge: { ownerKey: identity.ownerKey, threadId },
        runTool: dispatch,
        maxSteps: 8,
      })
      return answer.text.trim() || 'The subagent returned no answer.'
    }

    // The one place a tool call runs. A model can name a tool it was never offered; that is refused here.
    const dispatch = async (call: { id: string; name: string; argsJson: string }): Promise<string> => {
      if (!specs.some((spec) => spec.name === call.name)) return `Tool ${call.name} is not enabled for this chat.`
      if (call.name === 'runSubagent') {
        let prompt = ''
        try { prompt = String(JSON.parse(call.argsJson || '{}').prompt ?? '') } catch { prompt = '' }
        return prompt.trim() ? runSubagent(prompt.slice(0, 8000)) : 'runSubagent needs a prompt.'
      }
      if (CLIENT_TOOL_IDS.has(call.name)) {
        return requestClientTool({ ownerKey: identity.ownerKey, threadId, callId: call.id, name: call.name, argsJson: call.argsJson })
      }
      if (!deps.webTools) return `Tool ${call.name} is unavailable.`
      return runWebTool(deps.webTools, call.name, call.argsJson)
    }
    const runTool = specs.length ? dispatch : undefined

    // Streamed text and thinking are sent in the order the model produced them. Each emit writes the event log before it
    // broadcasts, so unawaited emits can finish in any order and the client would append the tokens out of order.
    // One queue keeps them in sequence.
    let streamTail: Promise<unknown> = Promise.resolve()
    const streamEmit = (type: string, payload: Record<string, unknown>): void => {
      streamTail = streamTail.then(() => emit(identity.ownerKey, type, payload)).catch(() => {})
    }

    try {
      let thinkingText = ''
      let sawThinking = false
      const result = await generationRace(threadId, callProviderWithTools(provider, messages, resolved.id, {
        thinking: resolved.thinking,
        tools: specs.length ? specs : undefined,
        allowedTools: specs.map((spec) => spec.name),
        toolBridge: { ownerKey: identity.ownerKey, threadId },
        runTool,
        maxSteps: deps.webTools?.maxSteps ?? 10,
        onText: (delta) => {
          if (!firstTextAt) firstTextAt = Date.now()
          answerLength += delta.length
          streamEmit('thread.delta', { threadId, text: delta })
        },
        onThinking: (delta) => {
          if (!delta) return
          thinkingText += delta
          if (!sawThinking) {
            sawThinking = true
            streamEmit('thread.thinking.start', { threadId, title: 'Thinking' })
          }
          streamEmit('thread.thinking.delta', { threadId, text: delta })
        },
        onToolEvent: (event: ToolEvent) => {
          if (event.phase === 'start') {
            sawTool = true
            // Position in both timelines: thinking (where it sits in the thought) and
            // answer (where it sits in the reply). The client places it by textAt.
            const atChar = thinkingText.length
            const textAt = answerLength
            const meta: ops.ToolCallMeta = {
              callId: event.callId,
              tool: event.tool,
              title: event.title,
              args: event.args,
              atChar,
              textAt,
            }
            if (!toolCallsMeta.some((c) => c.callId === event.callId)) toolCallsMeta.push(meta)
            // Only a tool that runs before the answer starts is part of the thinking.
            if (!textAt) streamEmit('thread.thinking.start', { threadId, title: 'Thinking' })
            streamEmit('thread.tool.start', {
              threadId, callId: event.callId, tool: event.tool, title: event.title, args: event.args, atChar, textAt,
            })
            return
          }
          const existing = toolCallsMeta.find((c) => c.callId === event.callId)
          const meta: ops.ToolCallMeta = existing || { callId: event.callId, tool: event.tool, title: event.title, args: event.args }
          meta.ok = event.ok
          meta.summary = event.summary
          meta.durationMs = event.durationMs
          meta.output = event.output
          if (!existing) toolCallsMeta.push(meta)
          streamEmit('thread.tool.end', {
            threadId, callId: event.callId, tool: event.tool, ok: event.ok, summary: event.summary, durationMs: event.durationMs, output: event.output,
          })
        },
      }))
      const thinkingDurationMs = sawTool || firstTextAt ? (firstTextAt || Date.now()) - thinkingStart : 0
      if (sawTool || sawThinking) streamEmit('thread.thinking.end', { threadId, durationMs: thinkingDurationMs })
      // Every streamed event is in the log before the turn moves on.
      await streamTail
      // Weighted quota: provider-reported usage, else an estimate (chars/4).
      const inputTokens = result.inputTokens ?? messages.reduce((sum, m) => sum + messageCost(m.content), 0)
      const outputTokens = result.outputTokens ?? Math.ceil((result.text.length + (result.thinking?.length ?? thinkingText.length)) / 4)
      await chargeTokens(identity, result.tokens ?? inputTokens + outputTokens)
      // Custom endpoints are not metered against the platform plan; the token
      // totals above still feed the admin statistics.
      if (abstractMeter) {
        // Abstract AI models count against the user's windows, not the platform quota.
        try {
          await recordUsage({
            userId: abstractMeter.userId,
            model: abstractMeter.model,
            multiplier: abstractMeter.multiplier,
            units: unitsFor(inputTokens, outputTokens, abstractMeter.multiplier),
            inputTokens,
            outputTokens,
          })
        } catch (error) {
          console.error('[ai] abstract usage not recorded:', error instanceof Error ? error.message : 'unknown error')
        }
      } else if (!custom) {
        await chargeQuota(identity, modelId, inputTokens, outputTokens, route?.chatOnlyMultiplier)
      }
      await emitUsage(identity, lim)
      const answer = result.text || 'The provider returned an empty response.'

      const metadata: ops.MessageMetadata = { model: shown || 'auto' }
      if (thinkingText) metadata.thinking = thinkingText
      if (result.thinking && !thinkingText) metadata.thinking = result.thinking
      if (toolCallsMeta.length) {
        metadata.toolCalls = toolCallsMeta
        metadata.thinkingDurationMs = thinkingDurationMs
      }
      return await ops.appendAssistantMessage(threadId, identity.ownerKey, answer, {
        tokens: result.tokens,
        ms: Date.now() - started,
        metadata,
      })
    } catch (error) {

      if (entry.cancelled) {
        await refund(identity, lim)
        return null
      }

      await refund(identity, lim)
      if (error instanceof ops.OpError) throw error

      // Custom header values (key, base URL, model) never reach a log or the reply.
      const secrets = custom?.secrets ?? []
      console.error('[ai] generate failed:', error instanceof Error ? scrubSecrets(error.stack || error.message, secrets) : error)
      // The upstream's own text names its model and provider, so the user only gets the generic message.
      throw new ops.OpError(502, 'The AI provider returned an error. That message was not counted, try again.', true)
    }
  } finally {

    if (generations.get(threadId) === entry) {
      generations.delete(threadId)
      await ops.setGenerating(threadId, identity.ownerKey, false)
    }
  }
}

export async function cancelGeneration(threadId: string, ownerKey: string): Promise<void> {
  cancelClientToolsFor(threadId)
  const thread = await ops.getThread(threadId, ownerKey).catch(() => null)
  if (!thread) throw new ops.OpError(404, 'Thread not found')
  const entry = generations.get(threadId)
  if (entry) {
    await stopGeneration(threadId)
    return
  }

  if (thread.generating) await ops.setGenerating(threadId, ownerKey, false)
}

export interface OpResult {
  userMessage?: ops.ThreadMessage
  reply?: ops.ThreadMessage | null
  idempotent?: boolean
  ok?: boolean
}

export async function runOp(
  deps: EngineDeps,
  identity: Identity,
  op: 'send' | 'edit' | 'retry' | 'delete' | 'cancel',
  rawArgs: { threadId: string; text?: string; messageId?: string; clientId?: string; model?: string; thinking?: string; tools?: string[]; customHeaders?: CustomHeaders; attachments?: ops.ThreadMessage['attachments'] },
): Promise<OpResult> {
  // Auto is a menu entry, not a model: every entry point routes it to its target here.
  const args = { ...rawArgs, model: resolveAutoModel(rawArgs.model) }
  const lim = limitsFor(tierOf(identity), deps.limits)
  if (op !== 'delete' && op !== 'cancel' && !checkMinute(identity.ownerKey, lim.perMinute)) {
    throw new ops.OpError(429, 'Too many requests. Try again in a minute.')
  }

  if (op === 'cancel') {
    await cancelGeneration(args.threadId, identity.ownerKey)
    return { ok: true }
  }

  // Resolved before any write, so a custom endpoint that is not set up fails
  // without leaving a half-sent message. The custom headers (key included) are
  // used here and nowhere else; with none present this reads no database.
  const custom = op === 'send' || op === 'edit' || op === 'retry'
    ? await customRouteFor(identity, args.customHeaders)
    : null

  if (op === 'send') {
    const text = (args.text ?? '').trim()
    if (!text && !args.attachments?.length) throw new ops.OpError(400, 'Empty message')
    const { message: userMessage, existed } = await ops.appendUserMessage(args.threadId, identity.ownerKey, text, {
      attachments: args.attachments,
      clientId: args.clientId,
    })
    if (existed) return { userMessage, reply: null, idempotent: true }
    const reply = await generate(deps, identity, args.threadId, args.model, custom, args.thinking, args.tools, rawArgs.model)
    void autoTitle(deps, identity, args.threadId, text, custom)
    return { userMessage, reply }
  }

  if (op === 'edit') {
    if (!args.messageId || !(args.text ?? '').trim()) throw new ops.OpError(400, 'Missing messageId or text')

    await stopGeneration(args.threadId)
    await ops.editUserMessage(args.threadId, identity.ownerKey, args.messageId, args.text!.trim(), args.attachments)
    const reply = await generate(deps, identity, args.threadId, args.model, custom, args.thinking, args.tools, rawArgs.model)
    return { reply }
  }

  if (op === 'retry') {
    if (!args.messageId) throw new ops.OpError(400, 'Missing messageId')
    await stopGeneration(args.threadId)
    await ops.retryFrom(args.threadId, identity.ownerKey, args.messageId)
    const reply = await generate(deps, identity, args.threadId, args.model, custom, args.thinking, args.tools, rawArgs.model)
    return { reply }
  }

  if (!args.messageId) throw new ops.OpError(400, 'Missing messageId')
  await ops.deleteMessage(args.threadId, identity.ownerKey, args.messageId)
  return { ok: true }
}
