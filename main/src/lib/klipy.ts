/* KLIPY GIF/sticker client. Requests go straight from the end-user's browser to
 * api.klipy.com (KLIPY's standard integration requires client-originated calls
 * and direct media loads - no server proxy/cache). The app key is revealed by
 * /api/discord/bridge/expressions only to embed-permitted users. The API is
 * Tenor-compatible: {key, q, limit, pos, media_filter, contentfilter}. */

const KLIPY_BASE = 'https://api.klipy.com'

export interface KlipyMediaFormat {
  url: string
  dims: [number, number]
  size?: number
}

export interface KlipyObject {
  id: string
  title?: string
  content_description?: string
  media_formats?: Record<string, KlipyMediaFormat>
  // Tenor-style fallback shape
  media?: Array<Record<string, KlipyMediaFormat>>
  tags?: string[]
}

export interface KlipyPage {
  results: KlipyObject[]
  next: string
}

function formats(o: KlipyObject): Record<string, KlipyMediaFormat> {
  if (o.media_formats) return o.media_formats
  if (o.media && o.media[0]) return o.media[0]
  return {}
}

/** Best small preview (grid thumbnail) URL for a result. */
export function klipyPreview(o: KlipyObject): { url: string; width: number; height: number } | null {
  const f = formats(o)
  const pick = f.nanogif || f.tinygif || f.gifpreview || f.preview || f.gif || f.mediumgif || f.webp || f.png
  if (!pick?.url) return null
  return { url: pick.url, width: pick.dims?.[0] || 0, height: pick.dims?.[1] || 0 }
}

/** Full-size URL to embed in the sent message. */
export function klipyFull(o: KlipyObject): { url: string; width: number; height: number } | null {
  const f = formats(o)
  const pick = f.gif || f.mediumgif || f.webp || f.mp4 || f.png || f.tinygif
  if (!pick?.url) return null
  return { url: pick.url, width: pick.dims?.[0] || 0, height: pick.dims?.[1] || 0 }
}

async function klipyGet(kind: 'gifs' | 'stickers', endpoint: string, key: string, params: Record<string, string>): Promise<KlipyPage> {
  const qs = new URLSearchParams({ key, media_filter: 'minimal', contentfilter: 'high', ...params })
  const res = await fetch(`${KLIPY_BASE}/v2/${kind}/${endpoint}?${qs}`)
  if (!res.ok) throw new Error(`KLIPY ${res.status}`)
  const data = (await res.json()) as { results?: KlipyObject[]; next?: string }
  // KLIPY keeps content sources separate per endpoint; results stay in the
  // returned order (we must not reorder/filter them ourselves).
  return { results: data.results || [], next: data.next || '' }
}

export function klipyGifsSearch(key: string, q: string, pos = '', limit = 24): Promise<KlipyPage> {
  return klipyGet('gifs', 'search', key, { q, limit: String(limit), pos })
}

export function klipyGifsTrending(key: string, pos = '', limit = 24): Promise<KlipyPage> {
  return klipyGet('gifs', 'trending', key, { limit: String(limit), pos })
}

export function klipyStickersSearch(key: string, q: string, pos = '', limit = 24): Promise<KlipyPage> {
  return klipyGet('stickers', 'search', key, { q, limit: String(limit), pos })
}

export function klipyStickersTrending(key: string, pos = '', limit = 24): Promise<KlipyPage> {
  return klipyGet('stickers', 'trending', key, { limit: String(limit), pos })
}
