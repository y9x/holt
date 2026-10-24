// Model metadata for the Abstract AI catalogue (GET /api/ai/catalogue) and the
// thinking clamp for platform chat sends (chat-engine.ts abstractRoute).
//
// Thinking levels come from THINKING_VERIFIED (hand-checked against the upstream, see
// the table) for the models listed there, else from models.dev reasoning_options. No
// request path ever calls the upstream for metadata: a model with no verified entry
// and no catalogue reasoning options simply offers no levels.
//
// Context, output, prices and capability flags come from OpenRouter and models.dev,
// matched on the exact normalised id (no family matching). Each source has a 30-minute
// cache, single-flight refresh, a 20-second timeout and a 20 MB cap. A failed refresh
// keeps the last good copy and logs a warning without the body.
//
// Nothing here throws to a caller.

type Json = Record<string, unknown>
type Index = Map<string, Json[]>

export type ThinkingLevel = 'low' | 'medium' | 'high' | 'max'
export type ThinkingSource = 'verified' | 'catalogue' | 'none'

export interface ReferencePrice {
  inputPerMillion: number | null
  outputPerMillion: number | null
  cacheReadPerMillion: number | null
  /** Catalogue the prices came from, with the entry count. */
  source: string
}

export interface ModelCatalogEntry {
  displayName: string | null
  description: string | null
  contextWindow: number | null
  maxOutput: number | null
  reasoning: boolean | null
  vision: boolean | null
  toolUse: boolean | null
  referencePrice: ReferencePrice | null
  thinkingLevels: ThinkingLevel[]
  /** The model can be switched off: 'off' sends the disable switch (see THINKING_VERIFIED). */
  thinkingOff: boolean
  /** The model always reasons and no choice changes that. The picker shows no choice. */
  thinkingAlwaysOn: boolean
  thinkingSource: ThinkingSource
  /** One note per filled field. Internal: not sent to clients. */
  sources: string[]
}

export interface ThinkingInfo {
  levels: ThinkingLevel[]
  /** The model can be switched off. Only a verified entry sets this (THINKING_VERIFIED). */
  off: boolean
  /** The model always reasons and no choice changes that. */
  alwaysOn: boolean
  source: ThinkingSource
  sources: string[]
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models'
const MODELS_DEV_URL = 'https://models.dev/api.json'
const CATALOGUE_TTL_MS = 30 * 60_000
const CATALOGUE_FETCH_TIMEOUT_MS = 20_000
const CATALOGUE_BODY_LIMIT = 20 * 1024 * 1024
const CATALOGUE_RETRY_MS = 2 * 60_000
const LEVEL_ORDER: readonly ThinkingLevel[] = ['low', 'medium', 'high', 'max']
/** Last-resort context windows, used only when no catalogue matches. */
const SPEC_CONTEXT: Readonly<Record<string, number>> = {
  'kimi-k3': 1_048_576,
  'kimi-k2.7-code': 262_144,
}
/**
 * Hand-verified thinking behaviour, the authority for the models listed. `levels` are the reasoning_effort names the
 * upstream accepts (its 400 for an invalid effort listed them: low, high, max); the rest records what a request does
 * to the reasoning (usage.completion_tokens_details.reasoning_tokens). Checked 2026-10-22: 8 runs per setting, one
 * short word problem, max_tokens 300, through the paid upstream.
 *  - off: `thinking: {type: 'disabled'}` gave 0 reasoning tokens in 8 of 8 runs, and the prompt fell from 136 to 68
 *    tokens (the thinking template is gone). Every level gave reasoning tokens (kimi-k3 low 107, high 131, max 134;
 *    kimi-k2.8 low 90, high 110, max 140). Between-level gaps are small on this prompt, so the levels stay the upstream's.
 *  - alwaysOn: the switch did nothing (96 tokens, prompt still 136), and no level moved the count (default 109,
 *    low 105, high 92). Reasoning was present in every run, so no choice is offered.
 * A model not listed here takes its levels from models.dev and gets no Off. Re-run the checks and edit this table when
 * a model is added or an upstream changes; nothing re-derives it at runtime.
 */
const THINKING_VERIFIED: Readonly<Record<string, { levels?: ThinkingLevel[]; off?: true; alwaysOn?: true }>> = {
  'kimi-k3': { levels: ['low', 'high', 'max'], off: true },
  'kimi-k2.8': { levels: ['low', 'high', 'max'], off: true },
  'kimi-k2.7-code': { alwaysOn: true },
}

// ---- Small typed readers ---------------------------------------------------

function isObj(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function objectOf(value: unknown): Json {
  return isObj(value) ? value : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function positive(value: unknown): number | null {
  const n = nonNegative(value)
  return n !== null && n > 0 ? n : null
}

function flag(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function present<T>(values: Array<T | null>): T[] {
  return values.filter((v): v is T => v !== null)
}

function firstText(values: unknown[]): string | null {
  for (const value of values) {
    const found = text(value)
    if (found) return found
  }
  return null
}

function firstPositive(values: unknown[]): number | null {
  for (const value of values) {
    const found = positive(value)
    if (found !== null) return found
  }
  return null
}

/** Most common value; a tie goes to the lower value (the conservative choice for limits). */
function mode(values: number[]): number | null {
  const counts = new Map<number, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  let best: number | null = null
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && value < best)) {
      best = value
      bestCount = count
    }
  }
  return best
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Majority vote. A tie is unknown. */
function majority(values: boolean[]): boolean | null {
  const yes = values.filter(Boolean).length
  const no = values.length - yes
  if (yes === no) return null
  return yes > no
}

/** Matching key: the part after the last '/', lower case, '.' turned into '-'. */
export function normaliseModelId(raw: string): string {
  const tail = raw.trim().split('/').pop() ?? ''
  return tail.toLowerCase().replace(/\./g, '-')
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (LEVEL_ORDER as readonly string[]).includes(value)
}

/**
 * The level to send, or undefined. A level goes out only when the model's verified
 * list includes it. Otherwise the reasoning field is dropped, never mapped to a neighbour.
 */
export function clampThinking(requested: string | undefined, info: Pick<ThinkingInfo, 'levels' | 'source'>): ThinkingLevel | undefined {
  if (!isThinkingLevel(requested)) return undefined
  if (info.source === 'none' || info.levels.length === 0) return undefined
  return info.levels.includes(requested) ? requested : undefined
}

/**
 * The thinking a platform send carries: 'off' only when the model can be switched off (sent as the switch), a verified
 * level, or undefined for no field. Off on a model that always reasons is dropped here, never sent as nothing.
 */
export function thinkingFor(requested: string | undefined, info: Pick<ThinkingInfo, 'levels' | 'source' | 'off'>): string | undefined {
  if (requested === 'off') return info.off ? 'off' : undefined
  return clampThinking(requested, info)
}

// ---- Fetching the catalogues ----------------------------------------------

/** Error text without a response body. JSON parse errors can echo the body, so they are replaced. */
function reasonOf(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'timed out'
  if (error instanceof Error && error.message && !/[{"<]/.test(error.message)) return error.message
  return 'request failed'
}

async function readCapped(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) throw new Error('body over the size limit')
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => {})
      throw new Error('body over the size limit')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function fetchCatalogueJson(url: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CATALOGUE_FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`HTTP ${response.status}`)
    }
    const body = await readCapped(response, CATALOGUE_BODY_LIMIT)
    try {
      return JSON.parse(body)
    } catch {
      throw new Error('invalid JSON')
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One catalogue. Serves the fresh copy, else the last good one while a refresh runs
 * or after a failure (stale-on-error). Null only before the first success.
 */
class SourceCache<T> {
  private value: T | null = null
  private fetchedAt = 0
  private retryAt = 0
  private flight: Promise<void> | null = null
  private readonly name: string
  private readonly url: string
  private readonly parse: (json: unknown) => T

  constructor(name: string, url: string, parse: (json: unknown) => T) {
    this.name = name
    this.url = url
    this.parse = parse
  }

  async get(): Promise<T | null> {
    if (this.value !== null && Date.now() - this.fetchedAt < CATALOGUE_TTL_MS) return this.value
    if (!this.flight && Date.now() >= this.retryAt) this.flight = this.refresh()
    if (this.value === null && this.flight) await this.flight
    return this.value
  }

  private async refresh(): Promise<void> {
    try {
      this.value = this.parse(await fetchCatalogueJson(this.url))
      this.fetchedAt = Date.now()
      this.retryAt = 0
    } catch (error) {
      this.retryAt = Date.now() + CATALOGUE_RETRY_MS
      const served = this.value !== null ? 'serving the last good copy' : 'no copy yet'
      console.warn(`model-catalog: ${this.name} refresh failed (${reasonOf(error)}); ${served}`)
    } finally {
      this.flight = null
    }
  }
}

function push(index: Index, key: string, entry: Json): void {
  const bucket = index.get(key)
  if (bucket) bucket.push(entry)
  else index.set(key, [entry])
}

/** models.dev: { <provider>: { models: { <id>: entry } } }. Every provider feeds one index. */
function parseModelsDev(json: unknown): Index {
  if (!isObj(json)) throw new Error('unexpected models.dev shape')
  const index: Index = new Map()
  for (const provider of Object.values(json)) {
    const models: unknown = isObj(provider) ? provider.models : undefined
    if (!models || typeof models !== 'object') continue
    for (const [key, model] of Object.entries(models)) {
      if (!isObj(model)) continue
      push(index, normaliseModelId(text(model.id) ?? key), model)
    }
  }
  if (!index.size) throw new Error('no models in models.dev')
  return index
}

/** OpenRouter: { data: [entry] }. */
function parseOpenRouter(json: unknown): Index {
  const data = isObj(json) ? json.data : json
  if (!Array.isArray(data)) throw new Error('unexpected OpenRouter shape')
  const index: Index = new Map()
  for (const entry of data) {
    if (!isObj(entry)) continue
    const id = text(entry.id)
    if (id) push(index, normaliseModelId(id), entry)
  }
  if (!index.size) throw new Error('no models in OpenRouter')
  return index
}

const modelsDevCache = new SourceCache<Index>('models.dev', MODELS_DEV_URL, parseModelsDev)
const openRouterCache = new SourceCache<Index>('OpenRouter', OPENROUTER_URL, parseOpenRouter)

// ---- Thinking levels: verified table, catalogue fallback -------------------

/** models.dev reasoning_options for one entry, or null when it lists none. */
function catalogueEffort(model: Json): { levels: ThinkingLevel[]; ignored: string[] } | null {
  const options = list(model.reasoning_options).filter(isObj).filter((option) => option.type === 'effort')
  if (!options.length) return null
  const names = options
    .flatMap((option) => list(option.values))
    .map((value) => text(value)?.toLowerCase())
    .filter((value): value is string => !!value)
  const ignored = [...new Set(names.filter((name) => !isThinkingLevel(name)))]
  const levels = LEVEL_ORDER.filter((level) => names.includes(level))
  return { levels, ignored }
}

/**
 * Used when THINKING_VERIFIED lists no levels for the model. The levels every matching
 * models.dev entry offers (intersection), so a level must be backed by all of them.
 */
async function catalogueThinking(modelId: string): Promise<ThinkingInfo> {
  const index = await modelsDevCache.get()
  const matches = index?.get(normaliseModelId(modelId)) ?? []
  const offered = present(matches.map((model) => catalogueEffort(model)))
  if (!offered.length) {
    return { levels: [], off: false, alwaysOn: false, source: 'none', sources: ['thinkingLevels: not verified and no catalogue reasoning options'] }
  }
  const levels = LEVEL_ORDER.filter((level) => offered.every((entry) => entry.levels.includes(level)))
  const ignored = [...new Set(offered.flatMap((entry) => entry.ignored))]
  const sources = [`thinkingLevels: models.dev reasoning_options (${offered.length} entries)`]
  if (ignored.length) sources.push(`thinkingLevels ignored: ${ignored.join(', ')}`)
  return { levels, off: false, alwaysOn: false, source: levels.length ? 'catalogue' : 'none', sources }
}

/** Applies the verified entry on top of a catalogue answer. It decides Off and always-on; verified levels replace the catalogue's. */
function withVerified(modelId: string, info: ThinkingInfo): ThinkingInfo {
  const verified = THINKING_VERIFIED[modelId]
  if (verified?.alwaysOn) {
    return {
      levels: [],
      off: false,
      alwaysOn: true,
      source: 'none',
      sources: [...info.sources, 'thinkingLevels: verified, no level or switch changes the reasoning (always on)'],
    }
  }
  const levels = verified?.levels?.length ? verified.levels : info.levels
  const source: ThinkingSource = verified?.levels?.length ? 'verified' : info.source
  const sources = verified?.levels?.length ? ['thinkingLevels: verified against the upstream'] : [...info.sources]
  const off = verified?.off === true && levels.length > 0
  if (verified?.off) sources.push('thinking off: verified, disable switch checked')
  return { levels, off, alwaysOn: false, source, sources }
}

/** Thinking levels for one upstream model id. Never throws and never calls the upstream. */
export async function getThinking(modelId: string): Promise<ThinkingInfo> {
  try {
    return withVerified(modelId, await catalogueThinking(modelId))
  } catch (error) {
    console.warn(`model-catalog: thinking lookup failed for ${modelId} (${reasonOf(error)})`)
    return withVerified(modelId, { levels: [], off: false, alwaysOn: false, source: 'none', sources: ['thinkingLevels: lookup failed'] })
  }
}

// ---- Matching and the catalogue map ----------------------------------------

/**
 * Models no public catalogue lists yet. They borrow a listed sibling's pricing, limits and capability flags until
 * their own numbers exist. The model's own name and description are never borrowed, so it is not described as the sibling.
 */
const CATALOGUE_STAND_INS: Readonly<Record<string, string>> = {
  'kimi-k2.8': 'kimi-k2.7-code',
}

/**
 * A context window is a text window: the model takes text in and gives text out. models.dev's modalities decide;
 * OpenRouter's architecture is the fallback. Unknown counts as text, so an unlisted model keeps its number.
 */
function takesTextInAndOutput(md: Json[], or: Json[]): boolean {
  const fromModelsDev = majority(present(md.map((m): boolean | null => {
    const { input, output } = objectOf(m.modalities)
    if (!Array.isArray(input) || !Array.isArray(output)) return null
    return input.includes('text') && output.includes('text')
  })))
  if (fromModelsDev !== null) return fromModelsDev
  const architecture = or.map((m) => objectOf(m.architecture)).find((a) => Array.isArray(a.input_modalities) && Array.isArray(a.output_modalities))
  if (architecture) return list(architecture.input_modalities).includes('text') && list(architecture.output_modalities).includes('text')
  return true
}

/** upstreamContext: the context window the model's own upstream reports, used after models.dev and OpenRouter. */
function buildEntry(modelId: string, modelsDev: Index | null, openRouter: Index | null, thinking: ThinkingInfo, upstreamContext?: number): ModelCatalogEntry {
  const standIn = CATALOGUE_STAND_INS[modelId]
  const key = normaliseModelId(standIn ?? modelId)
  const md = modelsDev?.get(key) ?? []
  const or = openRouter?.get(key) ?? []
  const sources: string[] = [...thinking.sources]
  const note = (field: string, from: string) => sources.push(`${field}: ${from}`)
  if (standIn) note('catalogue', `stand-in ${standIn} (no public entry for ${modelId})`)

  // Names and text: models.dev first, then OpenRouter (its "Vendor: " prefix removed). A stand-in lends neither.
  const mdName = standIn ? null : firstText(md.map((m) => m.name))
  const orName = standIn ? null : (firstText(or.map((m) => m.name))?.replace(/^[^:]+:\s*/, '') ?? null)
  const displayName = mdName ?? orName
  if (displayName) note('displayName', mdName ? 'models.dev' : 'openrouter')

  const mdDescription = standIn ? null : firstText(md.map((m) => m.description))
  const orDescription = standIn ? null : firstText(or.map((m) => m.description))
  const description = mdDescription ?? orDescription
  if (description) note('description', mdDescription ? 'models.dev' : 'openrouter')

  // Limits: consensus across models.dev providers, else OpenRouter, else the spec table.
  const mdContext = mode(present(md.map((m) => positive(objectOf(m.limit).context))))
  let contextWindow = mdContext ?? firstPositive(or.map((m) => m.context_length))
  let contextFrom = mdContext !== null ? `models.dev, most common of ${md.length} entries` : 'openrouter'
  if (contextWindow === null && upstreamContext !== undefined) {
    contextWindow = upstreamContext
    contextFrom = 'upstream /models'
  }
  const spec: number | undefined = SPEC_CONTEXT[modelId]
  if (contextWindow === null && spec !== undefined) {
    contextWindow = spec
    contextFrom = 'tokenphile-spec'
  }
  if (contextWindow !== null && !takesTextInAndOutput(md, or)) {
    // An image, video, audio or speech model's number is not a text window (for example veo-3.1's 480).
    contextWindow = null
  }
  if (contextWindow !== null) note('contextWindow', contextFrom)

  const mdOutput = mode(present(md.map((m) => positive(objectOf(m.limit).output))))
  const orOutput = firstPositive(or.map((m) => objectOf(m.top_provider).max_completion_tokens))
  const maxOutput = mdOutput ?? orOutput
  if (maxOutput !== null) note('maxOutput', mdOutput !== null ? 'models.dev' : 'openrouter')

  // Capabilities. OpenRouter's supported_parameters and modalities are used when models.dev has no answer.
  const orParams = or.map((m) => (Array.isArray(m.supported_parameters) ? m.supported_parameters : null)).find((v) => v !== null)
  const orParamNames: string[] | null = orParams ? orParams.filter((p): p is string => typeof p === 'string') : null
  const mdReasoning = majority(present(md.map((m) => flag(m.reasoning))))
  const reasoning = mdReasoning ?? (orParamNames ? orParamNames.includes('reasoning') || orParamNames.includes('include_reasoning') : null)
  if (reasoning !== null) note('reasoning', mdReasoning !== null ? 'models.dev' : 'openrouter supported_parameters')

  const mdTools = majority(present(md.map((m) => flag(m.tool_call))))
  const toolUse = mdTools ?? (orParamNames ? orParamNames.includes('tools') : null)
  if (toolUse !== null) note('toolUse', mdTools !== null ? 'models.dev tool_call' : 'openrouter supported_parameters')

  const orModalities = or.map((m) => objectOf(m.architecture).input_modalities).find((v) => Array.isArray(v))
  let vision: boolean | null
  if (Array.isArray(orModalities)) {
    vision = orModalities.includes('image')
    note('vision', 'openrouter input_modalities')
  } else {
    vision = majority(present(md.map((m) => flag(m.attachment))))
    if (vision !== null) note('vision', 'models.dev attachment (proxy)')
  }

  // Prices: models.dev median (USD per 1M), else OpenRouter (USD per token, as strings).
  let referencePrice: ReferencePrice | null = null
  const costs = md.map((m) => objectOf(m.cost))
  const inputs = present(costs.map((c) => nonNegative(c.input)))
  const outputs = present(costs.map((c) => nonNegative(c.output)))
  if (inputs.length || outputs.length) {
    referencePrice = {
      inputPerMillion: median(inputs),
      outputPerMillion: median(outputs),
      cacheReadPerMillion: median(present(costs.map((c) => nonNegative(c.cache_read)))),
      source: `models.dev median of ${costs.length} entries`,
    }
  } else {
    const pricing = or.map((m) => objectOf(m.pricing)).find((p) => p.prompt !== undefined || p.completion !== undefined)
    if (pricing) {
      const perMillion = (value: unknown): number | null => {
        const n = typeof value === 'string' && value.trim() ? Number(value) : value
        return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Number((n * 1e6).toFixed(6)) : null
      }
      referencePrice = {
        inputPerMillion: perMillion(pricing.prompt),
        outputPerMillion: perMillion(pricing.completion),
        cacheReadPerMillion: perMillion(pricing.input_cache_read),
        source: 'openrouter',
      }
    }
  }
  if (referencePrice) note('referencePrice', referencePrice.source)

  return {
    displayName,
    description,
    contextWindow,
    maxOutput,
    reasoning,
    vision,
    toolUse,
    referencePrice,
    thinkingLevels: thinking.levels,
    thinkingOff: thinking.off,
    thinkingAlwaysOn: thinking.alwaysOn,
    thinkingSource: thinking.source,
    sources,
  }
}

/**
 * The entry for one model id, only when a public catalogue (models.dev or OpenRouter) recognizes it. Null for
 * any other id, so a typed guess gets no made-up entry.
 */
export async function recognizedModel(modelId: string): Promise<ModelCatalogEntry | null> {
  const [modelsDev, openRouter] = await Promise.all([modelsDevCache.get(), openRouterCache.get()])
  const key = normaliseModelId(CATALOGUE_STAND_INS[modelId] ?? modelId)
  const known =(modelsDev?.get(key)?.length ?? 0) > 0 || (openRouter?.get(key)?.length ?? 0) > 0
  if (!known) return null
  return buildEntry(modelId, modelsDev, openRouter, await getThinking(modelId))
}

/** Metadata for the given model ids (our names). Never throws. The external catalogues are fetched once per 30 minutes. */
export async function getCatalog(modelIds: readonly string[], upstreamContext: ReadonlyMap<string, number> = new Map()): Promise<Map<string, ModelCatalogEntry>> {
  const [modelsDev, openRouter] = await Promise.all([modelsDevCache.get(), openRouterCache.get()])
  const ids = [...new Set(modelIds)]
  const thinking = await Promise.all(ids.map((id) => getThinking(id)))
  const out = new Map<string, ModelCatalogEntry>()
  ids.forEach((id, i) => out.set(id, buildEntry(id, modelsDev, openRouter, thinking[i], upstreamContext.get(id))))
  return out
}
