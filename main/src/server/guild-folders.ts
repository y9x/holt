// Per-identity server rail layout, Discord's `guildFolders` user setting
// (PreloadedUserSettings.guild_folders.folders): one entry per root rail item.
// A bare server is `{ guildIds: [id] }`; a folder carries a numeric `id` plus
// an optional `name` and `color` (0xRRGGBB int; null = Discord's default blurple).
// Stored per chat identity in chat_guild_folders (schema.sql 002_holt_identity), written by
// POST /api/holt-account/guild-folders and read (sealed) by GET of the same path (holt-account-api.ts).
// Ids the rail doesn't render are inert, so no pruning is needed here.

export type GuildFolder = {
  id?: number
  name?: string | null
  color?: number | null
  guildIds: string[]
}

// Discord's server cap with Nitro is 200; nothing legitimate exceeds it.
export const GUILD_FOLDERS_MAX_GUILDS = 200
// Discord's folder name input caps at 32 characters.
export const GUILD_FOLDER_NAME_MAX = 32

// Discord snowflake (same shape as discord-bridge-api's SNOWFLAKE).
const SNOWFLAKE = /^\d{15,22}$/

type Check = { ok: true; folders: GuildFolder[] } | { ok: false; error: string }

function parseEntry(raw: unknown, seen: Set<string>): GuildFolder | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Invalid folder entry.'
  const entry = raw as Record<string, unknown>
  if (!Array.isArray(entry.guildIds) || !entry.guildIds.length) return 'Every entry needs at least one server.'
  const guildIds: string[] = []
  for (const id of entry.guildIds) {
    if (typeof id !== 'string' || !SNOWFLAKE.test(id)) return 'Invalid server id.'
    if (seen.has(id)) return 'A server can only appear once.'
    seen.add(id)
    guildIds.push(id)
  }
  if (entry.id === undefined || entry.id === null) {
    // A bare server: no folder fields, exactly one guild.
    if (guildIds.length !== 1) return 'Group servers into a folder.'
    if (entry.name != null || entry.color != null) return 'Only folders have a name or color.'
    return { guildIds }
  }
  if (typeof entry.id !== 'number' || !Number.isSafeInteger(entry.id) || entry.id <= 0) return 'Invalid folder id.'
  let name: string | null = null
  if (entry.name != null) {
    if (typeof entry.name !== 'string') return 'Invalid folder name.'
    const trimmed = entry.name.trim()
    if ([...trimmed].length > GUILD_FOLDER_NAME_MAX) return `Folder names can be at most ${GUILD_FOLDER_NAME_MAX} characters.`
    name = trimmed || null
  }
  let color: number | null = null
  if (entry.color != null) {
    if (typeof entry.color !== 'number' || !Number.isInteger(entry.color) || entry.color < 0 || entry.color > 0xffffff) return 'Invalid folder color.'
    color = entry.color
  }
  return { id: entry.id, name, color, guildIds }
}

// Request body → layout to store. Rejects the whole write on any bad entry so a
// client bug is visible rather than silently reshaping the user's rail.
export function validateGuildFolders(raw: unknown): Check {
  if (!Array.isArray(raw)) return { ok: false, error: 'Expected a list of folders.' }
  const seen = new Set<string>()
  const folderIds = new Set<number>()
  const folders: GuildFolder[] = []
  for (const item of raw) {
    const parsed = parseEntry(item, seen)
    if (typeof parsed === 'string') return { ok: false, error: parsed }
    if (seen.size > GUILD_FOLDERS_MAX_GUILDS) return { ok: false, error: `Too many servers (max ${GUILD_FOLDERS_MAX_GUILDS}).` }
    if (parsed.id !== undefined) {
      if (folderIds.has(parsed.id)) return { ok: false, error: 'Duplicate folder id.' }
      folderIds.add(parsed.id)
    }
    folders.push(parsed)
  }
  return { ok: true, folders }
}

// Stored value → clean layout. A malformed column reads as an empty layout
// rather than failing the account read.
export function normalizeGuildFolders(raw: unknown): GuildFolder[] {
  const check = validateGuildFolders(raw)
  return check.ok ? check.folders : []
}
