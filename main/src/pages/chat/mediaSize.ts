// Discord's media sizing helpers (ported from the client's 515718 module).

// fitMedia = Discord's Uj(): scale (width, height) down - never up - so it
// fits inside maxWidth × maxHeight, preserving aspect ratio, then clamp to the
// minimums. Width is fitted first, then height.
export function fitMedia(input: {
  width: number
  height: number
  maxWidth: number
  maxHeight: number
  minWidth?: number
  minHeight?: number
}): { width: number; height: number } {
  let { width, height } = input
  const { maxWidth, maxHeight, minWidth = 0, minHeight = 0 } = input
  if (width !== maxWidth || height !== maxHeight) {
    const sx = width > maxWidth ? maxWidth / width : 1
    width = Math.max(Math.round(width * sx), minWidth)
    height = Math.max(Math.round(height * sx), minHeight)
    const sy = height > maxHeight ? maxHeight / height : 1
    width = Math.max(Math.round(width * sy), minWidth)
    height = Math.max(Math.round(height * sy), minHeight)
  }
  return { width, height }
}

// Discord loads proxied media at the displayed size (media.discordapp.net
// resizes on ?width=&height=). Non-proxy URLs are returned untouched.
export function sizedProxyUrl(url: string, width: number, height: number, opts: { format?: 'webp' | 'png' } = {}): string {
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'media.discordapp.net' && parsed.hostname !== 'images-ext-1.discordapp.net' && parsed.hostname !== 'images-ext-2.discordapp.net') {
      return url
    }
    const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2)
    if (width > 0 && height > 0) {
      parsed.searchParams.set('width', String(Math.round(width * dpr)))
      parsed.searchParams.set('height', String(Math.round(height * dpr)))
    }
    if (opts.format) parsed.searchParams.set('format', opts.format)
    return parsed.toString()
  } catch {
    return url
  }
}
