// Chat display name: the name a site account's WEB messages show in the
// chatbox. Pure (no DB/config imports) so it can be unit-tested directly.
//
// Stored on users.chat_display_name (NULL = use the site username). The
// effective name is what the send path records as author_name, which the bot
// hands to Discord as the webhook `username`.

export const CHAT_DISPLAY_NAME_MAX = 32

// Words a non-admin may not use (case-insensitive substring) so a web account
// can't pass as staff in the chatbox.
const RESERVED_WORDS = ['admin', 'mod', 'owner', 'staff', 'abstract']

// Characters that break mention/markdown rendering in the chatbox and in
// Discord. Control characters (incl. newlines) are rejected separately.
const BREAKING_CHARS = ['@', '`', '<', '>', '\\', '|']

export type ChatDisplayNameCheck =
  | { ok: true; name: string | null; notice?: string }
  | { ok: false; error: string }

// Discord webhook name rules: 1-80 chars, may not contain "discord" or
// "clyde" (case-insensitive). Our cap is 32, so only the substrings matter.
export function discordWebhookNameProblem(name: string): string | null {
  const lower = name.toLowerCase()
  if (lower.includes('discord')) return 'Discord does not allow "discord" in a webhook name.'
  if (lower.includes('clyde')) return 'Discord does not allow "clyde" in a webhook name.'
  return null
}

// Validate a requested chat display name. `isAdmin` lifts only the staff-word
// rule. An empty (after trimming) value clears the name (returns name: null).
export function validateChatDisplayName(raw: unknown, options: { isAdmin?: boolean } = {}): ChatDisplayNameCheck {
  if (raw === null || raw === undefined) return { ok: true, name: null }
  if (typeof raw !== 'string') return { ok: false, error: 'Chat name must be text.' }
  if (raw === '' || raw.trim() === '') return { ok: true, name: null }
  if (raw !== raw.trim()) return { ok: false, error: 'Chat name cannot start or end with spaces.' }

  // Counted in UTF-16 code units, like the field's maxLength, its counter and the
  // About Me / pronouns checks (String.length), so every limit means the same thing.
  if (raw.length > CHAT_DISPLAY_NAME_MAX) {
    return { ok: false, error: `Chat name must be ${CHAT_DISPLAY_NAME_MAX} characters or fewer.` }
  }
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(raw)) {
    return { ok: false, error: 'Chat name cannot contain control characters or line breaks.' }
  }
  if (raw.includes('#:')) return { ok: false, error: 'Chat name cannot contain "#:".' }
  const bad = BREAKING_CHARS.find((c) => raw.includes(c))
  if (bad) return { ok: false, error: `Chat name cannot contain "${bad}".` }

  if (!options.isAdmin) {
    const lower = raw.toLowerCase()
    const reserved = RESERVED_WORDS.find((w) => lower.includes(w))
    if (reserved) return { ok: false, error: 'That name is reserved for staff.' }
  }

  // Discord rules are a hard limit for the webhook name. The caller turns this
  // into "store/show the site username instead" (see effectiveChatName), and
  // the save route reports it, rather than rejecting the request outright.
  const discordProblem = discordWebhookNameProblem(raw)
  if (discordProblem) {
    return {
      ok: true,
      name: null,
      notice: `${discordProblem} Your site username is shown instead.`,
    }
  }

  return { ok: true, name: raw }
}

// The name a web message is recorded (and delivered to Discord) under: the
// stored chat name when it is set and still valid for Discord, else the site
// username.
export function effectiveChatName(username: string, chatDisplayName: string | null | undefined): string {
  const name = chatDisplayName?.trim()
  if (!name) return username
  if (discordWebhookNameProblem(name)) return username
  return name
}
