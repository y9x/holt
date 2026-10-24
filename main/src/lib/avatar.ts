import { apiUrl } from './api-base'
import { apiFetch, apiFetchQueued } from './api-fetch'

// Uploaded chat avatars (server: src/server/avatar-api.ts). The server
// re-encodes and moderates every upload; only approved avatars get a URL.

export type AvatarUploadStatus = 'pending' | 'approved' | 'rejected'

export interface AvatarState {
  active: { id: string; url: string | null } | null
  latest: { id: string; status: AvatarUploadStatus; reason: string | null; createdAt: string } | null
}

export const AVATAR_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024
const ALLOWED_TYPES = new Set(AVATAR_ACCEPT.split(','))

const base = apiUrl('/api/avatars')

async function parse(response: Response): Promise<AvatarState & { error?: string; retryAfterSec?: number }> {
  const data = await response.json().catch(() => ({})) as AvatarState & { error?: string; retryAfterSec?: number; avatar?: AvatarState['latest'] }
  if (!response.ok) {
    const err = new Error(typeof data.error === 'string' ? data.error : 'Avatar request failed.') as Error & { status?: number; avatar?: AvatarState['latest'] }
    err.status = response.status
    if (data.avatar) err.avatar = data.avatar
    throw err
  }
  return data
}

export async function avatarMe(): Promise<AvatarState> {
  return parse(await apiFetchQueued(`${base}/me`))
}

export async function avatarRemove(): Promise<AvatarState> {
  return parse(await apiFetchQueued(`${base}/me`, { method: 'DELETE' }))
}

// Client-side pre-check only (the server sniffs bytes and decides). Returns an
// error message or null.
export function precheckAvatarFile(file: File): string | null {
  if (!ALLOWED_TYPES.has(file.type)) return 'Use a PNG, JPEG, WebP, or GIF image.'
  if (file.size > AVATAR_MAX_BYTES) return 'Images must be 5 MB or smaller.'
  if (!file.size) return 'That file is empty.'
  return null
}

// The server keeps only a 256x256 re-encode, so shipping a multi-megabyte
// original is wasted bandwidth, and the byod edge relays cap request bodies
// at nginx's 1 MB default. Large or high-resolution picks are downscaled in the
// browser first (max 1024px side). GIFs are sent as-is (server takes frame 1)
// unless too big. Any failure falls back to the original file; the server
// still validates everything.
const CLIENT_MAX_SIDE = 1024
const CLIENT_TARGET_BYTES = 900 * 1024

async function downscale(file: File): Promise<Blob> {
  if (typeof createImageBitmap !== 'function') return file
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, CLIENT_MAX_SIDE / Math.max(bitmap.width, bitmap.height))
    if (scale === 1 && file.size <= CLIENT_TARGET_BYTES) return file
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const encode = (type: string, quality: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))
    for (const [type, quality] of [['image/webp', 0.9], ['image/jpeg', 0.88]] as const) {
      const blob = await encode(type, quality)
      // toBlob silently falls back to PNG for unsupported types.
      if (blob && blob.type === type && blob.size <= CLIENT_TARGET_BYTES) return blob
    }
    return file
  } finally {
    bitmap.close()
  }
}

export async function avatarUpload(file: File): Promise<AvatarState> {
  const isGif = file.type === 'image/gif'
  const body = isGif && file.size <= CLIENT_TARGET_BYTES ? file : await downscale(file).catch(() => file)
  return parse(await apiFetchQueued(`${base}/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body,
  }))
}

// ---- Site-admin review (users.admin) ----

export type AdminAvatarStatus = 'pending' | 'approved' | 'rejected' | 'removed'

export interface AdminAvatar {
  id: string
  userId: number | null
  username: string | null
  status: AdminAvatarStatus
  categories: string[]
  reason: string | null
  model: string | null
  sourceFormat: string
  sha256: string
  active: boolean
  publicUrl: string | null
  reviewer: string | null
  reviewedAt: string | null
  createdAt: string
}

const adminBase = apiUrl('/api/admin/avatars')

export async function adminListAvatars(status: AdminAvatarStatus | 'all'): Promise<AdminAvatar[]> {
  const response = await apiFetch(`${adminBase}?status=${encodeURIComponent(status)}`)
  const data = await response.json().catch(() => ({})) as { avatars?: AdminAvatar[]; error?: string }
  if (!response.ok) throw new Error(data.error || 'Could not load avatars.')
  return data.avatars || []
}

// Non-approved avatars are never public, so the admin view loads the image
// with the bearer token and shows it through a blob URL. Caller revokes it.
export async function adminAvatarImageUrl(id: string): Promise<string | null> {
  const response = await apiFetch(`${adminBase}/${encodeURIComponent(id)}/image`)
  if (!response.ok) return null
  const blob = await response.blob()
  if (blob.type !== 'image/webp') return null
  return URL.createObjectURL(blob)
}

export async function adminReviewAvatar(id: string, action: 'approve' | 'reject' | 'remove', reason?: string): Promise<void> {
  const response = await apiFetch(`${adminBase}/review`, {
    method: 'POST',
    body: JSON.stringify({ id, action, ...(reason ? { reason } : {}) }),
  })
  const data = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(data.error || 'Review failed.')
}
