// Chat-only models: the model lists of config.ai.upstreams entries marked chatOnly (api.navy). They are
// offered in the chat interface only, and only when they output text. Image, video, audio and speech models are
// left out. They are never relayed on /v1: loadCandidates (abstract-relay/upstream.ts) drops chatOnly upstreams
// from every candidate list.
//
// Each upstream's GET {baseUrl}/models is cached for 10 minutes, with at most one fetch in flight per upstream.
// A failed refresh serves the last good list and waits 60 s before it tries again. The key goes only in the
// Authorization header: it is never logged, returned, or put in an error message.

import { loadConfig } from './config.js'
import { parseUpstreams, type Candidate } from './abstract-relay/upstream.ts'
import { modelDisplayName } from '../model-names.ts'

export interface ChatOnlyModel {
  id: string
  displayName: string
  /** The upstream's own context window; null when it reports none. */
  contextWindow: number | null
}

export interface ChatOnlyFound {
  upstream: Candidate
  model: ChatOnlyModel
}

const CACHE_TTL_MS = 10 * 60_000
const FAILURE_BACKOFF_MS = 60_000
const FETCH_TIMEOUT_MS = 10_000
const MAX_MODELS = 500
const MAX_BODY_CHARS = 2_000_000
/** Ids as upstreams name them, for example "kimi-k3" or "org/model:tag". Anything else is ignored. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/

/** A reason we can say out loud. Anything else is reported as a plain request failure. */
class ModelListError extends Error {}

interface CacheEntry {
  models: ChatOnlyModel[]
  /** 0 until the first successful fetch. */
  fetchedAt: number
  /** Earliest time a failed upstream is tried again. */
  retryAt: number
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<ChatOnlyModel[]>>()

function cacheKey(upstream: Candidate): string {
  return `${upstream.name}\n${upstream.baseUrl}`
}

/** The upstream's context window for one model, when it reports a positive whole number. */
function reportedContext(item: unknown): number | null {
  if (typeof item !== 'object' || item === null) return null
  const { context_window } = item as { context_window?: unknown }
  return typeof context_window === 'number' && Number.isInteger(context_window) && context_window > 0 ? context_window : null
}

/**
 * Only text-output models are offered. An entry that lists its output modalities without text is an image, video,
 * audio or speech model. An entry that lists none counts as text.
 */
function outputsText(item: unknown): boolean {
  const modalities = typeof item === 'object' && item !== null ? (item as { output_modalities?: unknown }).output_modalities : undefined
  return !Array.isArray(modalities) || modalities.includes('text')
}

/** The models in an OpenAI-style {data:[{id}]} body: valid text-output ids only, no duplicates, at most MAX_MODELS. */
export function parseModelList(body: unknown): ChatOnlyModel[] {
  const data = typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : undefined
  if (!Array.isArray(data)) throw new ModelListError('unexpected model list')
  const seen = new Set<string>()
  const out: ChatOnlyModel[] = []
  for (const item of data) {
    if (out.length >= MAX_MODELS) break
    const id = typeof item === 'object' && item !== null ? (item as { id?: unknown }).id : undefined
    if (typeof id !== 'string' || !MODEL_ID.test(id) || seen.has(id) || !outputsText(item)) continue
    seen.add(id)
    out.push({ id, displayName: modelDisplayName(id), contextWindow: reportedContext(item) })
  }
  return out
}

async function fetchModels(upstream: Candidate): Promise<ChatOnlyModel[]> {
  let response: Response
  try {
    response = await fetch(`${upstream.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${upstream.apiKey}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch {
    throw new ModelListError('request failed')
  }
  if (!response.ok) throw new ModelListError(`HTTP ${response.status}`)
  let text: string
  try {
    text = await response.text()
  } catch {
    throw new ModelListError('request failed')
  }
  if (text.length > MAX_BODY_CHARS) throw new ModelListError('model list too large')
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new ModelListError('invalid JSON')
  }
  return parseModelList(body)
}

/** One fetch per upstream at a time. Resolves to the new list, or to the last good one after a failure. */
function refresh(upstream: Candidate): Promise<ChatOnlyModel[]> {
  const key = cacheKey(upstream)
  const running = inflight.get(key)
  if (running) return running
  const job = fetchModels(upstream)
    .then((models) => {
      cache.set(key, { models, fetchedAt: Date.now(), retryAt: 0 })
      return models
    }, (error: unknown) => {
      const stale = cache.get(key)
      const reason = error instanceof ModelListError ? error.message : 'request failed'
      console.warn(`chat-models: ${upstream.name} model list not refreshed (${reason}); serving the last good list`)
      const models = stale?.models ?? []
      cache.set(key, { models, fetchedAt: stale?.fetchedAt ?? 0, retryAt: Date.now() + FAILURE_BACKOFF_MS })
      return models
    })
    .finally(() => {
      inflight.delete(key)
    })
  inflight.set(key, job)
  return job
}

async function modelsFor(upstream: Candidate): Promise<ChatOnlyModel[]> {
  const entry = cache.get(cacheKey(upstream))
  const now = Date.now()
  if (entry && now - entry.fetchedAt < CACHE_TTL_MS) return entry.models
  if (entry && now < entry.retryAt) return entry.models
  return refresh(upstream)
}

/** Every chat-only upstream in config, in priority order, with its current model list. */
export async function chatOnlyLists(): Promise<Array<{ upstream: Candidate; models: ChatOnlyModel[] }>> {
  const config = await loadConfig()
  const upstreams = parseUpstreams(config.ai?.upstreams).filter((upstream) => upstream.chatOnly)
  return Promise.all(upstreams.map(async (upstream) => ({ upstream, models: await modelsFor(upstream) })))
}

/** The chat-only models for the picker: one entry per id, in upstream priority order. */
export async function listChatOnlyModels(): Promise<ChatOnlyModel[]> {
  const seen = new Set<string>()
  const out: ChatOnlyModel[] = []
  for (const { models } of await chatOnlyLists()) {
    for (const model of models) {
      if (seen.has(model.id)) continue
      seen.add(model.id)
      out.push(model)
    }
  }
  return out
}

/** The current chat-only model with exactly this id, and the upstream that lists it. Null when none does. */
export async function findChatOnlyModel(id: string): Promise<ChatOnlyFound | null> {
  for (const { upstream, models } of await chatOnlyLists()) {
    const model = models.find((candidate) => candidate.id === id)
    if (model) return { upstream, model }
  }
  return null
}
