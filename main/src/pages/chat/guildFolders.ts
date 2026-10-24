import type { BridgeGuild } from '../../lib/bridge'
import type { GuildFolder } from '../../lib/guild-folders'

/* Server rail layout model (Discord's guildFolders user setting).
 *
 * The saved layout is one entry per root rail item: a bare server is
 * `{ guildIds: [id] }`, a folder carries a numeric `id`. Every edit works on
 * the EFFECTIVE layout - the saved entries as-is, plus any rendered server the
 * layout doesn't mention yet prepended as a bare entry (Discord shows a newly
 * joined server at the top). Ids the rail doesn't render are kept, so a server
 * that's briefly unavailable keeps its place instead of being dropped by the
 * next save. Rules follow Discord's reducer (web bundle @9166659):
 *   - a folder emptied by a move disappears; a one-server folder stays;
 *   - combining onto a root server makes a folder [target, source];
 *   - combining onto a folder (or its end) appends;
 *   - a folder only ever lands at root, never inside another folder. */

/** Discord's default folder color (BRAND_500 #5865f2); null means "default". */
export const DEFAULT_FOLDER_COLOR = 0x5865f2

export type RailFolder = { id: number; name: string | null; color: number | null; guilds: BridgeGuild[] }
export type RailEntry =
  | { kind: 'guild'; guild: BridgeGuild }
  | { kind: 'folder'; folder: RailFolder }

/** Where a dragged server lands. */
export type GuildDrop =
  | { type: 'before-guild'; guildId: string }   // root or inside its folder
  | { type: 'before-folder'; folderId: number } // root
  | { type: 'root-end' }
  | { type: 'combine-guild'; guildId: string }  // root server → new folder
  | { type: 'into-folder'; folderId: number }   // append

/** Where a dragged folder lands (root only). */
export type FolderDrop =
  | { type: 'before-guild'; guildId: string }
  | { type: 'before-folder'; folderId: number }
  | { type: 'root-end' }

const isFolder = (entry: GuildFolder) => entry.id !== undefined && entry.id !== null

function cloneLayout(layout: GuildFolder[]): GuildFolder[] {
  return layout.map((entry) => ({ ...entry, guildIds: [...entry.guildIds] }))
}

/** Saved layout + rendered servers it doesn't mention (prepended, in server order). */
export function effectiveLayout(guilds: BridgeGuild[], saved: GuildFolder[]): GuildFolder[] {
  const known = new Set(saved.flatMap((entry) => entry.guildIds))
  const missing = guilds.filter((guild) => !known.has(guild.id)).map((guild) => ({ guildIds: [guild.id] }))
  return [...missing, ...cloneLayout(saved)]
}

/** What the rail renders: saved order, unknown ids skipped, empty folders hidden. */
export function railEntries(guilds: BridgeGuild[], saved: GuildFolder[]): RailEntry[] {
  const byId = new Map(guilds.map((guild) => [guild.id, guild]))
  const entries: RailEntry[] = []
  for (const entry of effectiveLayout(guilds, saved)) {
    const present = entry.guildIds.map((id) => byId.get(id)).filter((guild): guild is BridgeGuild => Boolean(guild))
    if (!present.length) continue
    if (isFolder(entry)) {
      entries.push({ kind: 'folder', folder: { id: entry.id as number, name: entry.name ?? null, color: entry.color ?? null, guilds: present } })
    } else {
      entries.push({ kind: 'guild', guild: present[0] })
    }
  }
  return entries
}

/** Discord's folder id: a random uint32, re-rolled until it's unused (and non-zero). */
export function newFolderId(layout: GuildFolder[], random: () => number = Math.random): number {
  const used = new Set(layout.filter(isFolder).map((entry) => entry.id))
  for (;;) {
    const id = Math.floor(2 ** 32 * random())
    if (id > 0 && !used.has(id)) return id
  }
}

// Take a server out of wherever it is; a folder left empty disappears.
function withoutGuild(layout: GuildFolder[], guildId: string): GuildFolder[] {
  const out: GuildFolder[] = []
  for (const entry of layout) {
    if (!entry.guildIds.includes(guildId)) {
      out.push(entry)
      continue
    }
    const guildIds = entry.guildIds.filter((id) => id !== guildId)
    if (guildIds.length) out.push({ ...entry, guildIds })
  }
  return out
}

const rootIndexOfGuild = (layout: GuildFolder[], guildId: string) =>
  layout.findIndex((entry) => !isFolder(entry) && entry.guildIds[0] === guildId)
const indexOfFolder = (layout: GuildFolder[], folderId: number) =>
  layout.findIndex((entry) => isFolder(entry) && entry.id === folderId)
const folderHolding = (layout: GuildFolder[], guildId: string) =>
  layout.findIndex((entry) => isFolder(entry) && entry.guildIds.includes(guildId))

/** True when the drop would leave the layout unchanged (hide the indicator). */
export function isNoopGuildDrop(layout: GuildFolder[], guildId: string, drop: GuildDrop): boolean {
  if (drop.type === 'before-guild' || drop.type === 'combine-guild') {
    if (drop.guildId === guildId) return true
  }
  const next = moveGuild(layout, guildId, drop)
  return JSON.stringify(next) === JSON.stringify(layout)
}

/** Move a server. Returns the layout unchanged when the drop isn't valid. */
export function moveGuild(layout: GuildFolder[], guildId: string, drop: GuildDrop, random: () => number = Math.random): GuildFolder[] {
  if ((drop.type === 'before-guild' || drop.type === 'combine-guild') && drop.guildId === guildId) return layout
  const base = withoutGuild(cloneLayout(layout), guildId)
  switch (drop.type) {
    case 'before-guild': {
      const root = rootIndexOfGuild(base, drop.guildId)
      if (root >= 0) {
        base.splice(root, 0, { guildIds: [guildId] })
        return base
      }
      const holder = folderHolding(base, drop.guildId)
      if (holder < 0) return layout
      const ids = base[holder].guildIds
      ids.splice(ids.indexOf(drop.guildId), 0, guildId)
      return base
    }
    case 'before-folder': {
      const index = indexOfFolder(base, drop.folderId)
      if (index < 0) return layout
      base.splice(index, 0, { guildIds: [guildId] })
      return base
    }
    case 'root-end':
      base.push({ guildIds: [guildId] })
      return base
    case 'combine-guild': {
      const root = rootIndexOfGuild(base, drop.guildId)
      if (root < 0) return layout // only a root server can become a folder
      base[root] = { id: newFolderId(base, random), name: null, color: null, guildIds: [drop.guildId, guildId] }
      return base
    }
    case 'into-folder': {
      const index = indexOfFolder(base, drop.folderId)
      if (index < 0) return layout
      base[index].guildIds.push(guildId)
      return base
    }
  }
}

/** Move a whole folder; it only ever lands at root. */
export function moveFolder(layout: GuildFolder[], folderId: number, drop: FolderDrop): GuildFolder[] {
  if (drop.type === 'before-folder' && drop.folderId === folderId) return layout
  const from = indexOfFolder(layout, folderId)
  if (from < 0) return layout
  const base = cloneLayout(layout)
  const [folder] = base.splice(from, 1)
  let to: number
  if (drop.type === 'root-end') to = base.length
  else if (drop.type === 'before-folder') to = indexOfFolder(base, drop.folderId)
  else to = rootIndexOfGuild(base, drop.guildId)
  if (to < 0) return layout
  base.splice(to, 0, folder)
  return base
}

export function isNoopFolderDrop(layout: GuildFolder[], folderId: number, drop: FolderDrop): boolean {
  return JSON.stringify(moveFolder(layout, folderId, drop)) === JSON.stringify(layout)
}

/** Folder Settings save: an empty name means unnamed; the default color is stored as null. */
export function updateFolder(layout: GuildFolder[], folderId: number, patch: { name: string | null; color: number | null }): GuildFolder[] {
  return layout.map((entry) => {
    if (!isFolder(entry) || entry.id !== folderId) return entry
    const name = patch.name?.trim() || null
    const color = patch.color === null || patch.color === DEFAULT_FOLDER_COLOR ? null : patch.color
    return { ...entry, guildIds: [...entry.guildIds], name, color }
  })
}

/** Discord's unnamed-folder label: server names joined within a 64-char budget. */
export function defaultFolderName(names: string[]): string {
  let budget = 64
  const picked: string[] = []
  let skipped = false
  for (const name of names) {
    if (name.length < budget || !picked.length) {
      picked.push(name)
      budget -= name.length
    } else {
      skipped = true
    }
  }
  const joined = picked.join(', ')
  return joined && skipped ? `${joined}, ...` : joined
}

export function folderColorCss(color: number | null | undefined): string | null {
  if (color == null || color === DEFAULT_FOLDER_COLOR) return null
  return `#${color.toString(16).padStart(6, '0')}`
}
