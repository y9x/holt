import { generateSecret as otplibGenerateSecret, generateURI, verify } from 'otplib'
import QRCode from 'qrcode'

export function generateTotpSecret(): string {
  return otplibGenerateSecret()
}

export async function totpUri(username: string, secret: string): Promise<{ uri: string; qr: string }> {
  const uri = generateURI({ strategy: 'totp', issuer: 'Abstract', label: username, secret })
  const qr = await QRCode.toDataURL(uri)
  return { uri, qr }
}

export async function checkTotp(token: string, secret: string): Promise<boolean> {
  if (!token) return false
  try {
    const result = await verify({ secret, token, epochTolerance: 30 })
    return Boolean(result?.valid)
  } catch {
    return false
  }
}
