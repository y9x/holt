// Pure identity helpers for the person-level AI usage ledger (ai-usage-ledger.ts).
// No imports with side effects so these can be unit-tested without a database.
import { createHash } from 'node:crypto'

export interface LedgerUser {
  id: number
  email: string | null
  email_verified: boolean
  discord_id?: string | null
}

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com'])

/**
 * Normalize an email for "same person" matching. Lowercases, drops a `+tag`
 * from the local part (all providers), and for Gmail removes dots from the
 * local part and maps googlemail.com to gmail.com. Returns null when the
 * input is not an address.
 */
export function normalizeEmail(raw: string): string | null {
  const email = String(raw ?? '').trim().toLowerCase()
  const at = email.lastIndexOf('@')
  if (at <= 0 || at === email.length - 1) return null
  let local = email.slice(0, at)
  let domain = email.slice(at + 1)
  const plus = local.indexOf('+')
  if (plus >= 0) local = local.slice(0, plus)
  if (GMAIL_DOMAINS.has(domain)) {
    domain = 'gmail.com'
    local = local.replace(/\./g, '')
  }
  if (!local) return null
  return `${local}@${domain}`
}

/** Salted sha256 (hex) of an arbitrary identity string, namespaced by kind. */
export function identityHash(kind: string, value: string, salt: string): string {
  return createHash('sha256').update(salt).update('\0').update(kind).update('\0').update(value).digest('hex')
}

/** Hex hash of a normalized email; also the value stored in deleted_account_email. */
export function emailHash(normalizedEmail: string, salt: string): string {
  return identityHash('email', normalizedEmail, salt)
}

/**
 * Identity keys a user currently resolves to. A verified email and a linked
 * Discord id are person identities. An account with neither falls back to its
 * own id (ledger history is still merged in by the caller).
 */
export function identityKeysFor(user: LedgerUser, salt: string): string[] {
  const keys = new Set<string>()
  if (user.email_verified && user.email) {
    const normalized = normalizeEmail(user.email)
    if (normalized) keys.add(`email:${emailHash(normalized, salt)}`)
  }
  if (user.discord_id) keys.add(`discord:${identityHash('discord', String(user.discord_id), salt)}`)
  if (keys.size === 0) keys.add(`account:${user.id}`)
  return [...keys]
}
