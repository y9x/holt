// Abstract AI model catalogue, read from config.js (ai.models). Only enabled entries are routable; each
// entry's multiplier is its metering weight. The catalogue is configuration: edit config.js and restart.

import { loadConfig, type AbstractModelConfig } from '../config.js'

export type CatalogueModel = {
  id: string
  multiplier: number
}

/** Every configured entry, valid or not, in config order. Entries with a bad id or multiplier are dropped. */
export async function catalogueModels(): Promise<AbstractModelConfig[]> {
  const config = await loadConfig()
  return (config.ai?.models ?? []).filter((entry) =>
    typeof entry.id === 'string' && entry.id.length > 0
      && typeof entry.multiplier === 'number' && Number.isFinite(entry.multiplier) && entry.multiplier > 0
      && typeof entry.enabled === 'boolean',
  )
}

/**
 * Exact match on an enabled entry, or null. A name with no enabled entry is unknown: the route answers 404
 * and nothing is metered.
 */
export async function findEnabledModel(id: string): Promise<CatalogueModel | null> {
  const entry = (await catalogueModels()).find((candidate) => candidate.id === id && candidate.enabled)
  return entry ? { id: entry.id, multiplier: entry.multiplier } : null
}

/**
 * The metering weight for a chat-only model: the multiplier of the config entry with that id, enabled or not, so one
 * id weighs the same on every upstream. An id with no entry weighs 1.
 */
export async function chatOnlyMultiplier(id: string): Promise<number> {
  const entry = (await catalogueModels()).find((candidate) => candidate.id === id)
  return entry ? entry.multiplier : 1
}

/** Enabled entries, sorted by id, for GET /v1/models. */
export async function listEnabledModels(): Promise<CatalogueModel[]> {
  return (await catalogueModels())
    .filter((entry) => entry.enabled)
    .map((entry) => ({ id: entry.id, multiplier: entry.multiplier }))
    .sort((a, b) => a.id.localeCompare(b.id))
}
