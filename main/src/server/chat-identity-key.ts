// Chat identity keys. Every web identity is `<namespace>:<subject>` (its platform's namespace: `abulxt:42`,
// `lab:1`, `nocturne:u_77`); Discord users are `discord:<snowflake>`. abulxt accounts were `user:<n>` before
// abulxt migration 037; such a key still reads as `abulxt:<n>` (an old tab, an old event), but is never written.
//
// Pure: no imports, so every chat module can use it without an import cycle.

const KEY_RE = /^([a-z][a-z0-9-]{0,31}):([A-Za-z0-9._-]{1,128})$/
/** Namespaces that are not a platform's identities. */
const RESERVED = new Set(['discord', 'guest', 'holt'])

/**
 * A chat caller, as the chat modules see it: its identity key (never from client input: holt-service verified
 * it with the platform) and, when a trusted platform vouches for one, its linked Discord account.
 */
export interface ChatSubjectUser {
  discord_id?: string | null
  ext_key?: string | null
}

/** A web identity key, normalised (`user:<n>` → `abulxt:<n>`), or null when `raw` is not one. Pure. */
export function webIdentityKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const legacy = /^user:(\d{1,10})$/.exec(raw)
  if (legacy) return `abulxt:${legacy[1]}`
  const match = KEY_RE.exec(raw)
  if (!match || RESERVED.has(match[1]) || match[1] === 'user') return null
  return raw
}

/** The chat identity key of a caller, or null for a guest. */
export function chatKeyOfUser(user: ChatSubjectUser | null | undefined): string | null {
  return webIdentityKey(user?.ext_key ?? null)
}
