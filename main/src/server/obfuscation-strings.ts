// The strings build-obfuscator-plugin encrypts into the page's string registry, so HolyText and
// friends reveal them from ciphertext. holt-owned (abulxt's list names abulxt's pages): list every
// static user-visible string the embed renders. A string missing here still renders, but in
// plaintext from the bundle's own (separately obfuscated) literal.

import { type EncryptionSession, encryptText } from './crypto-utils.js'

export const DEFAULT_OBFUSCATED_STRINGS: string[] = [
  'Connecting…',
  'Signed in as',
  'Browsing as a guest.',
  'Account',
  'Settings',
  'Verify email',
  'Sign in',
  'Sign in to chat.',
  'Verify your email to chat.',
  'Could not sign you in.',
  'Could not reach the chat service.',
  'This chat is meant to be embedded in another site.',
  'This site is not set up for chat.',
  'Reconnecting…',
]

export function buildEncryptedStringMap(
  session: EncryptionSession,
  extraStrings: string[] = []
): Record<string, string> {
  const map: Record<string, string> = {}
  const allStrings = Array.from(new Set([...DEFAULT_OBFUSCATED_STRINGS, ...extraStrings]))

  for (const str of allStrings) {
    map[str] = encryptText(str, session)
  }

  return map
}
