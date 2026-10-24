import { cbc } from '@noble/ciphers/aes.js'
import { clientConfig, getCloakShadowRoot } from './config'

let cachedKey: Uint8Array | undefined

function fromBase64(str: string): Uint8Array {
  const binary = atob(str.trim())
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

export const loadDecryptionKey = (): boolean => {
  if (typeof document === 'undefined') return false

  const shadowRoot = getCloakShadowRoot()
  const el = shadowRoot?.getElementById('eckey') || shadowRoot?.querySelector('#eckey') || document.getElementById('eckey')
  if (el?.textContent) {
    try {
      cachedKey = fromBase64(el.textContent)
      return true
    } catch {

    }
  }

  const cfgKey = clientConfig().ecKey
  if (cfgKey) {
    try {
      cachedKey = fromBase64(cfgKey)
      return true
    } catch {

    }
  }

  const winKey = (window as unknown as { __ABULXT_EC_KEY__?: string }).__ABULXT_EC_KEY__
  if (winKey) {
    try {
      cachedKey = fromBase64(winKey)
      return true
    } catch {

    }
  }

  return cachedKey !== undefined
}

if (typeof document !== 'undefined') {
  loadDecryptionKey()
  document.addEventListener('DOMContentLoaded', loadDecryptionKey)
}

const textDecoder = new TextDecoder()

let warnedMissingKey = false
let warnedDecryptError = false

export function holyDecrypt(ciphertextB64: string): string {
  if (!ciphertextB64) return ''

  if (!loadDecryptionKey() && cachedKey === undefined) {
    if (!warnedMissingKey) {
      warnedMissingKey = true
      console.error('holyDecrypt: obfuscation key unavailable; rendering placeholder')
    }
    return ''
  }

  try {
    const cipherBytes = fromBase64(ciphertextB64)

    const rawIv = cachedKey!.slice(0, 16)
    const rawKey = cachedKey!.slice(16)
    const stream = cbc(rawKey, rawIv)
    return textDecoder.decode(stream.decrypt(cipherBytes))
  } catch (err) {
    if (!warnedDecryptError) {
      warnedDecryptError = true
      console.error('Decryption error:', err)
    }
    return ''
  }
}

// Renamed from isHeadlessScraper (PLAN P7 A10). This is a TRIPWIRE, not a
// security control: it only flags a likely bot and must never block real users.
// The consolidated multi-signal version lives in shield/anti-tamper.ts
// (`isLikelyBot`); this one stays minimal because it gates DOM text reveal.
export function isLikelyBot(): boolean {
  if (typeof navigator === 'undefined') return false
  return Boolean(navigator.webdriver)
}
