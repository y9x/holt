

const DEFAULT_BASE = 'http://abulxt.local'

export function normalizeRequestUrlPath(raw: string | undefined | null): string {
  if (raw == null || raw === '') return '/'
  const trimmed = String(raw)

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed

  if (trimmed.startsWith('?') || trimmed.startsWith('#')) return trimmed

  if (trimmed.startsWith('//')) {
    const collapsed = trimmed.replace(/^\/+/, '/')
    return collapsed.length > 0 ? collapsed : '/'
  }
  return trimmed
}

export function parseRequestUrl(
  raw: string | undefined | null,
  base: string = DEFAULT_BASE,
): URL {
  const input = normalizeRequestUrlPath(raw)
  try {
    return new URL(input, base)
  } catch {
    try {
      const fallback = input.startsWith('/') ? input : `/${input}`
      return new URL(fallback.replace(/^\/+/, '/') || '/', base)
    } catch {
      return new URL('/', base)
    }
  }
}

export function sanitizeIncomingRequestUrl(req: { url?: string }): boolean {
  const before = req.url
  if (typeof before !== 'string') return false
  const after = normalizeRequestUrlPath(before)
  if (after === before) return false
  req.url = after
  return true
}
