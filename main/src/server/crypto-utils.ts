import crypto from 'node:crypto'

export interface EncryptionSession {
  clientKey: Buffer
  iv: Buffer
  combinedKeyBase64: string
}

export function createEncryptionSession(): EncryptionSession {
  const clientKey = crypto.randomBytes(32)
  const iv = crypto.randomBytes(16)
  const combinedKeyBase64 = Buffer.concat([iv, clientKey]).toString('base64')
  return {
    clientKey,
    iv,
    combinedKeyBase64,
  }
}

export function encryptText(text: string, session: EncryptionSession): string {
  const cipher = crypto.createCipheriv('aes-256-cbc', session.clientKey, session.iv)
  const encrypted = Buffer.concat([
    cipher.update(text, 'utf8'),
    cipher.final(),
  ])
  return encrypted.toString('base64')
}
