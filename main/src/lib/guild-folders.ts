import { apiUrl } from './api-base'
import { apiFetch } from './api-fetch'
import { cryptoFetch } from './api-crypto-fetch'
import { getAuthToken } from './auth-api'

// Server rail layout (Discord's guildFolders user setting), per account.
// Server: GET/POST /api/account/guild-folders (src/server/guild-folders.ts).
// One entry per root rail item: a bare server is { guildIds: [id] }; a folder
// has a numeric id, an optional name, and an optional 0xRRGGBB color.

export type GuildFolder = {
  id?: number
  name?: string | null
  color?: number | null
  guildIds: string[]
}

const endpoint = () => apiUrl('/api/account/guild-folders')

async function errorOf(res: Response, fallback: string): Promise<Error> {
  const data = (await res.json().catch(() => ({}))) as { error?: unknown }
  return new Error(typeof data.error === 'string' ? data.error : fallback)
}

// The read is sealed for negotiating clients, so it goes through cryptoFetch
// (which decrypts transparently) with the account's bearer token.
export async function fetchGuildFolders(): Promise<GuildFolder[]> {
  const token = getAuthToken()
  if (!token) return []
  const res = await cryptoFetch(endpoint(), { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) throw await errorOf(res, 'Could not load your servers.')
  const data = (await res.json().catch(() => ({}))) as { guildFolders?: unknown }
  return Array.isArray(data.guildFolders) ? (data.guildFolders as GuildFolder[]) : []
}

export async function saveGuildFolders(guildFolders: GuildFolder[]): Promise<GuildFolder[]> {
  const res = await apiFetch(endpoint(), { method: 'POST', body: JSON.stringify({ guildFolders }) })
  if (!res.ok) throw await errorOf(res, 'Could not save your servers.')
  const data = (await res.json().catch(() => ({}))) as { guildFolders?: unknown }
  return Array.isArray(data.guildFolders) ? (data.guildFolders as GuildFolder[]) : guildFolders
}
