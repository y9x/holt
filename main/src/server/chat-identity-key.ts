// A site account's chat identity key (message authors, reactors, onboarding state, presence, moderation).
// It is `abulxt:<id>` since migration 037, the same key holt uses for this site's accounts. Before that
// it was `user:<id>`, which is still accepted when reading (an old browser tab, an in-flight event), but
// never written.
//
// NOT the account's event channel: emit('user:<id>', …), rt subscriptions, rate limits and AI chat
// thread ownership keep using identity.ts userOwnerKey (`user:<id>`). Only chat identity moved.
//
// Pure: no imports, so every chat module can use it without an import cycle.

export const SITE_CHAT_PREFIX = 'abulxt:'
const LEGACY_PREFIX = 'user:'
const KEY_RE = /^(?:abulxt|user):(\d{1,10})$/

/** The chat key for site account `id`. */
export function siteChatKey(id: number): string {
  return `${SITE_CHAT_PREFIX}${id}`
}

/** The pre-037 chat key for site account `id`, for reading old data or matching an old client. */
export function legacySiteChatKey(id: number): string {
  return `${LEGACY_PREFIX}${id}`
}

/** Both chat keys a site account may appear under, new first. */
export function siteChatKeys(id: number): string[] {
  return [siteChatKey(id), legacySiteChatKey(id)]
}

/** The site account id in a chat key (`abulxt:<id>` or legacy `user:<id>`), or null. */
export function siteIdOfChatKey(key: unknown): number | null {
  if (typeof key !== 'string') return null
  const match = KEY_RE.exec(key)
  if (!match) return null
  const id = Number(match[1])
  return Number.isSafeInteger(id) && id > 0 ? id : null
}
