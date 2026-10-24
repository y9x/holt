import type { BrowserPreferences } from '../pages/settings/preferences'
import { getCloakShadowRoot } from './config'

export type ThemeName = BrowserPreferences['theme']

// Shell transparency. "clear" makes the surface tokens translucent
// so the site background shows through the sidebar, tabs and every page;
// text tokens stay opaque. Percent = how much of the colour is kept.
export type SurfaceStyle = BrowserPreferences['surfaceStyle']
const SURFACE_ALPHA: Record<SurfaceStyle, { bg: number; surface: number; raised: number; hover: number } | null> = {
  solid: null,
  clear: { bg: 0, surface: 38, raised: 62, hover: 72 },
}
let currentSurface: SurfaceStyle = 'clear'
const veil = (color: string, pct: number | undefined) => (pct === undefined || pct >= 100 ? color : `color-mix(in srgb, ${color} ${pct}%, transparent)`)
function surfaceTokens(background: string, fg: string) {
  const a = SURFACE_ALPHA[currentSurface]
  const surface = `color-mix(in srgb, ${background} 96%, ${fg})`
  const raised = `color-mix(in srgb, ${background} 93%, ${fg})`
  const hover = `color-mix(in srgb, ${background} 91%, ${fg})`
  return {
    bg: veil(background, a?.bg),
    surface: veil(surface, a?.surface),
    raised: veil(raised, a?.raised),
    hover: veil(hover, a?.hover),
  }
}

export interface ThemePreset {
  name: ThemeName
  label: string
  description: string
  background: string
  accent: string
  fg?: string
}

export const THEME_PRESETS: ThemePreset[] = [
  { name: 'dark', label: 'Dark', description: 'Black and white.', background: '#000000', accent: '#ffffff' },
  { name: 'light', label: 'Light', description: 'Paper white, ink black.', background: '#f5f5f4', accent: '#111111' },
  { name: 'blue', label: 'Blue', description: 'Deep navy, electric accent.', background: '#070b16', accent: '#5b8cff' },
  { name: 'amoled-blue', label: 'AMOLED Blue', description: 'True black, blue accent.', background: '#000000', accent: '#3b82f6' },
  { name: 'slate', label: 'Slate', description: 'Cool grey, steel accent.', background: '#0f172a', accent: '#94a3b8', fg: '#e2e8f0' },
  { name: 'midnight', label: 'Midnight', description: 'Ink blue, soft white.', background: '#0a0f1e', accent: '#c7d2fe', fg: '#e6e9f5' },
  { name: 'ocean', label: 'Ocean', description: 'Deep sea, cyan accent.', background: '#06141d', accent: '#4cc9f0', fg: '#e3f4fb' },
  { name: 'nord', label: 'Nord', description: 'Arctic blues.', background: '#2e3440', accent: '#88c0d0', fg: '#eceff4' },
  { name: 'tokyo', label: 'Tokyo Night', description: 'Night city blues.', background: '#1a1b26', accent: '#7aa2f7', fg: '#c0caf5' },
  { name: 'onedark', label: 'One Dark', description: 'Atom classic.', background: '#282c34', accent: '#61afef', fg: '#abb2bf' },
  { name: 'palenight', label: 'Palenight', description: 'Material purple.', background: '#292d3e', accent: '#c792ea', fg: '#a6accd' },
  { name: 'dracula', label: 'Dracula', description: 'Purple on charcoal.', background: '#282a36', accent: '#bd93f9', fg: '#f8f8f2' },
  { name: 'mocha', label: 'Mocha', description: 'Catppuccin mocha.', background: '#1e1e2e', accent: '#cba6f7', fg: '#cdd6f4' },
  { name: 'kanagawa', label: 'Kanagawa', description: 'Wave ink, wisteria.', background: '#1f1f28', accent: '#957fb8', fg: '#dcd7ba' },
  { name: 'everforest', label: 'Everforest', description: 'Soft woodland greens.', background: '#2d353b', accent: '#a7c080', fg: '#d3c6aa' },
  { name: 'gruvbox', label: 'Gruvbox', description: 'Warm retro.', background: '#282828', accent: '#fabd2f', fg: '#ebdbb2' },
  { name: 'ayu', label: 'Ayu Mirage', description: 'Dusk with amber.', background: '#1f2430', accent: '#ffcc66', fg: '#cccac2' },
  { name: 'rosepine', label: 'Rosé Pine', description: 'Soft rose on pine.', background: '#191724', accent: '#ebbcba', fg: '#e0def4' },
  { name: 'solarized', label: 'Solarized', description: 'Classic dark teal.', background: '#002b36', accent: '#2aa198', fg: '#93a1a1' },
  { name: 'monokai', label: 'Monokai', description: 'Green on olive.', background: '#272822', accent: '#a6e22e', fg: '#f8f8f2' },
  { name: 'forest', label: 'Forest', description: 'Deep green, moss accent.', background: '#0b1410', accent: '#7bd389', fg: '#e3efe6' },
  { name: 'terminal', label: 'Terminal', description: 'Phosphor green on black.', background: '#000000', accent: '#33ff33', fg: '#c8ffc8' },
  { name: 'ember', label: 'Ember', description: 'Near-black, orange accent.', background: '#120c0a', accent: '#ff7a45', fg: '#f3ece8' },
  { name: 'crimson', label: 'Crimson', description: 'Dark wine, red accent.', background: '#120508', accent: '#e63946', fg: '#f7e8ea' },
  { name: 'cyberpunk', label: 'Cyberpunk', description: 'Neon pink on void.', background: '#0b0b14', accent: '#ff2a6d', fg: '#e8e8ff' },
  { name: 'synthwave', label: 'Synthwave', description: 'Retro violet, hot pink.', background: '#241b3a', accent: '#ff7edb', fg: '#f4ecff' },
  { name: 'coffee', label: 'Coffee', description: 'Espresso brown, caramel.', background: '#1b1512', accent: '#d4a373', fg: '#f1e9e2' },
  { name: 'sepia', label: 'Sepia', description: 'Warm paper.', background: '#f3ead8', accent: '#8a5a2b', fg: '#2b2118' },
  { name: 'lavender', label: 'Lavender', description: 'Light lilac, violet accent.', background: '#f3f0fa', accent: '#6b4fbb', fg: '#221a33' },
  { name: 'mint', label: 'Mint', description: 'Light mint, green accent.', background: '#eef7f2', accent: '#1f8a5b', fg: '#10261b' },
  { name: 'peach', label: 'Peach', description: 'Light cream, coral accent.', background: '#fff4ec', accent: '#d9532b', fg: '#33201a' },
  { name: 'nordlight', label: 'Nord Light', description: 'Snow storm, frost blue.', background: '#eceff4', accent: '#5e81ac', fg: '#2e3440' },
  { name: 'album', label: 'Match Song', description: 'Colours from the album art.', background: '#0c0c12', accent: '#8a8aff', fg: '#f2f2f2' },
  { name: 'custom', label: 'Custom', description: 'Pick your own colours.', background: '#0b0b10', accent: '#ffffff' },
]

function hexToRgb(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return null
  const value = parseInt(match[1], 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function luminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function isLightColor(hex: string): boolean {
  const rgb = hexToRgb(hex)
  return rgb ? luminance(rgb) > 0.4 : false
}

export function resolveTheme(prefs: Pick<BrowserPreferences, 'theme' | 'customBackground' | 'customAccent'>): { background: string; accent: string; fg: string; light: boolean } {
  const preset = THEME_PRESETS.find((t) => t.name === prefs.theme) ?? THEME_PRESETS[0]
  const custom = preset.name === 'custom'
  const background = (custom && hexToRgb(prefs.customBackground) ? prefs.customBackground : preset.background).toLowerCase()
  const accent = (custom && hexToRgb(prefs.customAccent) ? prefs.customAccent : preset.accent).toLowerCase()
  const light = isLightColor(background)
  const fg = (!custom && preset.fg) || (light ? '#111111' : '#f2f2f2')
  return { background, accent, fg, light }
}

function pushUnique(out: HTMLElement[], el: Element | null | undefined) {
  if (el instanceof HTMLElement && !out.includes(el)) out.push(el)
}

function themeTargets(): HTMLElement[] {
  const out: HTMLElement[] = []
  if (typeof document === 'undefined') return out

  // SVG cloaks patch document.documentElement to the xhtml <html> inside
  // <foreignObject>. CSS :root in linked stylesheets can still bind to the
  // outer <svg>, so paint BOTH the patched root and the real document element.
  pushUnique(out, document.documentElement)
  try {
    const realRoot = Document.prototype.querySelector.call(document, ':root') as Element | null
    pushUnique(out, realRoot)
  } catch { /* ignore */ }
  try {
    pushUnique(out, document.firstElementChild)
  } catch { /* ignore */ }

  try {
    const holder = window as unknown as { __ABULXT_SHADOW_ROOT__?: ShadowRoot }
    const shadow = holder.__ABULXT_SHADOW_ROOT__
    pushUnique(out, shadow?.host as HTMLElement | undefined)
    pushUnique(out, shadow?.getElementById?.('root') || null)
  } catch { /* ignore */ }

  try {
    // Prefer the captured cloak shadow (window global is deleted after first read).
    const shadow = getCloakShadowRoot()
    pushUnique(out, shadow?.host as HTMLElement | undefined)
    pushUnique(out, shadow?.getElementById?.('root') || null)
  } catch { /* ignore */ }

  pushUnique(out, document.getElementById('root'))
  try {
    const body = document.body
    pushUnique(out, body)
  } catch { /* ignore */ }

  try {
    const captured = (window as unknown as { __abulxtThemeHosts?: HTMLElement[] }).__abulxtThemeHosts
    if (Array.isArray(captured)) for (const el of captured) pushUnique(out, el)
  } catch { /* ignore */ }
  return out
}

export function registerThemeHost(el: HTMLElement | null | undefined) {
  if (!el || typeof window === 'undefined') return
  const w = window as unknown as { __abulxtThemeHosts?: HTMLElement[] }
  const list = w.__abulxtThemeHosts || (w.__abulxtThemeHosts = [])
  if (!list.includes(el)) list.push(el)
}

/** Inline the full token pack. SVG/foreignObject cloaks often leave
 *  `--ui-*` / `--shell-*` defined on the outer <svg> :root while the app
 *  lives under a patched xhtml tree - inheritance never bridges that gap. */
function applyTokenPack(el: HTMLElement, background: string, accent: string, fg: string, onAccent: string, scheme: 'light' | 'dark', themeName: string) {
  const veiled = surfaceTokens(background, fg)
  const shellSurface = veiled.surface
  const shellRaised = veiled.raised
  const shellHover = veiled.hover
  const shellLine = `color-mix(in srgb, ${background} 90%, ${fg})`
  const shellLineStrong = `color-mix(in srgb, ${background} 82%, ${fg})`
  const shellMuted = `color-mix(in srgb, ${fg} 52%, ${background})`
  const shellFaint = `color-mix(in srgb, ${fg} 30%, ${background})`
  const tokens: Record<string, string> = {
    '--theme-bg': background,
    '--theme-accent': accent,
    '--theme-fg': fg,
    '--theme-on-accent': onAccent,
    '--shell-bg': veiled.bg,
    '--shell-surface': shellSurface,
    '--shell-raised': shellRaised,
    // Floating pickers and popouts stay opaque in every surface style; panels keep the veil.
    '--shell-popover': `color-mix(in srgb, ${background} 93%, ${fg})`,
    '--shell-hover': shellHover,
    '--shell-line': shellLine,
    '--shell-line-strong': shellLineStrong,
    '--shell-text': fg,
    '--shell-muted': shellMuted,
    '--shell-faint': shellFaint,
    '--shell-accent': accent,
    '--shell-on-accent': onAccent,
    '--ui-bg': shellSurface,
    '--ui-surface': shellRaised,
    '--ui-glass': `color-mix(in srgb, ${fg} 5%, transparent)`,
    '--ui-glass-2': `color-mix(in srgb, ${fg} 10%, transparent)`,
    '--ui-glass-3': `color-mix(in srgb, ${fg} 16%, transparent)`,
    '--ui-glass-hover': `color-mix(in srgb, ${fg} 8%, transparent)`,
    '--ui-border': `color-mix(in srgb, ${fg} 13%, transparent)`,
    '--ui-border-strong': `color-mix(in srgb, ${fg} 30%, transparent)`,
    '--ui-text': fg,
    '--ui-text-muted': shellMuted,
    '--ui-text-subtle': `color-mix(in srgb, ${fg} 42%, ${background})`,
    '--ui-white': fg,
    '--ui-accent': accent,
    '--surface': shellSurface,
    '--control': shellRaised,
    '--muted': shellMuted,
  }
  for (const [key, value] of Object.entries(tokens)) el.style.setProperty(key, value)
  el.dataset.theme = themeName
  el.dataset.scheme = scheme
  el.style.colorScheme = scheme
  el.style.background = background
  el.style.color = fg
}

function syncThemeStyleTag(background: string, accent: string, fg: string, onAccent: string, scheme: 'light' | 'dark', themeName: string) {
  if (typeof document === 'undefined') return
  const v = surfaceTokens(background, fg)
  const css = `:root, :host, html, body, #root, #__abulxt_host__ {
  --theme-bg: ${background} !important;
  --theme-accent: ${accent} !important;
  --theme-fg: ${fg} !important;
  --theme-on-accent: ${onAccent} !important;
  --shell-bg: ${v.bg} !important;
  --shell-surface: ${v.surface} !important;
  --shell-raised: ${v.raised} !important;
  --shell-popover: color-mix(in srgb, ${background} 93%, ${fg}) !important;
  --shell-hover: ${v.hover} !important;
  --shell-line: color-mix(in srgb, ${background} 90%, ${fg}) !important;
  --shell-line-strong: color-mix(in srgb, ${background} 82%, ${fg}) !important;
  --shell-text: ${fg} !important;
  --shell-muted: color-mix(in srgb, ${fg} 52%, ${background}) !important;
  --shell-faint: color-mix(in srgb, ${fg} 30%, ${background}) !important;
  --shell-accent: ${accent} !important;
  --shell-on-accent: ${onAccent} !important;
  --ui-bg: ${v.surface} !important;
  --ui-surface: ${v.raised} !important;
  --ui-glass: color-mix(in srgb, ${fg} 5%, transparent) !important;
  --ui-glass-2: color-mix(in srgb, ${fg} 10%, transparent) !important;
  --ui-glass-3: color-mix(in srgb, ${fg} 16%, transparent) !important;
  --ui-glass-hover: color-mix(in srgb, ${fg} 8%, transparent) !important;
  --ui-border: color-mix(in srgb, ${fg} 13%, transparent) !important;
  --ui-border-strong: color-mix(in srgb, ${fg} 30%, transparent) !important;
  --ui-text: ${fg} !important;
  --ui-text-muted: color-mix(in srgb, ${fg} 52%, ${background}) !important;
  --ui-text-subtle: color-mix(in srgb, ${fg} 42%, ${background}) !important;
  --ui-white: ${fg} !important;
  --ui-accent: ${accent} !important;
  --surface: ${v.surface} !important;
  --control: ${v.raised} !important;
  --muted: color-mix(in srgb, ${fg} 52%, ${background}) !important;
  color: ${fg} !important;
  background: ${background} !important;
  color-scheme: ${scheme} !important;
}`
  void themeName
  const ensure = (root: ParentNode | null | undefined) => {
    if (!root) return
    let style = (root as Document | ShadowRoot).getElementById?.('abulxt-theme-vars') as HTMLStyleElement | null
    if (!style) {
      try {
        style = document.createElement('style')
      } catch {
        return
      }
      style.id = 'abulxt-theme-vars'
      root.appendChild(style)
    }
    style.textContent = css
  }
  try { ensure(document.head) } catch { /* ignore */ }
  try {
    const holder = window as unknown as { __ABULXT_SHADOW_ROOT__?: ShadowRoot }
    ensure(holder.__ABULXT_SHADOW_ROOT__)
  } catch { /* ignore */ }
  try { ensure(getCloakShadowRoot()) } catch { /* ignore */ }
}

function paintTheme(prefs: Pick<BrowserPreferences, 'theme' | 'customBackground' | 'customAccent'>, palette?: AlbumPalette) {
  const { background, accent, fg, light } = palette
    ? { background: palette.background, accent: palette.accent, fg: palette.fg, light: false }
    : resolveTheme(prefs)
  const scheme = light ? 'light' : 'dark'
  const onAccent = isLightColor(accent) ? '#000000' : '#ffffff'
  for (const root of themeTargets()) {
    applyTokenPack(root, background, accent, fg, onAccent, scheme, prefs.theme)
  }
  syncThemeStyleTag(background, accent, fg, onAccent, scheme, prefs.theme)
}

export function applyTheme(prefs: Pick<BrowserPreferences, 'theme' | 'customBackground' | 'customAccent'> & { surfaceStyle?: SurfaceStyle }) {
  if (prefs.surfaceStyle && prefs.surfaceStyle in SURFACE_ALPHA) currentSurface = prefs.surfaceStyle
  try { document.documentElement.dataset.surface = currentSurface } catch { /* no document */ }
  // "Match Song" is driven by the now-playing art (see applyAlbumPalette). On
  // load, reuse the last palette we derived; the watcher refreshes it when a
  // track is playing, and resolveTheme's dark fallback covers "no song yet".
  if (prefs.theme === 'album') {
    const cached = loadStoredAlbumPalette()
    if (cached) { applyAlbumPalette(cached); return }
  }
  paintTheme(prefs)
}

// --- "Match Song": derive the theme from album artwork ----------------------

export interface AlbumPalette { background: string; accent: string; fg: string }

const ALBUM_PALETTE_KEY = 'abulxt:album-palette'

function loadStoredAlbumPalette(): AlbumPalette | null {
  try {
    const raw = JSON.parse(sessionStorage.getItem(ALBUM_PALETTE_KEY) || 'null') as AlbumPalette | null
    return raw && typeof raw.background === 'string' && typeof raw.accent === 'string' && typeof raw.fg === 'string' ? raw : null
  } catch {
    return null
  }
}

export function applyAlbumPalette(p: AlbumPalette) {
  try { sessionStorage.setItem(ALBUM_PALETTE_KEY, JSON.stringify(p)) } catch { /* storage unavailable */ }
  paintTheme({ theme: 'album', customBackground: '', customAccent: '' }, p)
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0))
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return [h / 6, s, l]
}

function hslToHex(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h * 12) % 12
    const a = s * Math.min(l, 1 - l)
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(255 * c).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

/** Pull a dark, art-tinted background + a vibrant accent from album artwork.
 *  Null when the image can't be loaded or the canvas is tainted (no CORS). */
export async function paletteFromArtwork(url: string): Promise<AlbumPalette | null> {
  if (!url || typeof document === 'undefined') return null
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.decoding = 'async'
  const ok = await new Promise<boolean>((resolve) => {
    img.onload = () => resolve(true)
    img.onerror = () => resolve(false)
    img.src = url
  })
  if (!ok) return null
  const size = 36
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, size, size)
  let data: Uint8ClampedArray
  try { data = ctx.getImageData(0, 0, size, size).data } catch { return null }

  // Bucket colours (4 bits/channel), score by population x saturation, biased
  // toward mid-lightness so the accent is punchy but not neon-white/near-black.
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>()
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const bk = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 }
    bk.n++; bk.r += r; bk.g += g; bk.b += b
    buckets.set(key, bk)
  }
  if (!buckets.size) return null
  let best: { h: number; s: number } | null = null
  let bestScore = -1
  let fallback: { h: number; s: number; n: number } | null = null
  for (const bk of buckets.values()) {
    const r = bk.r / bk.n, g = bk.g / bk.n, b = bk.b / bk.n
    const [h, s, l] = rgbToHsl(r, g, b)
    if (!fallback || bk.n > fallback.n) fallback = { h, s, n: bk.n }
    if (l < 0.12 || l > 0.9) continue
    const score = bk.n * (0.25 + s * s) * (1 - Math.abs(l - 0.55))
    if (score > bestScore) { bestScore = score; best = { h, s } }
  }
  const pick = best ?? (fallback ? { h: fallback.h, s: Math.max(fallback.s, 0.3) } : { h: 0, s: 0 })
  const sat = Math.min(0.85, Math.max(0.42, pick.s))
  return {
    accent: hslToHex(pick.h, sat, 0.62),
    background: hslToHex(pick.h, Math.min(0.5, sat * 0.6 + 0.08), 0.07),
    fg: hslToHex(pick.h, 0.12, 0.95),
  }
}

export function dotGradient(prefs: Pick<BrowserPreferences, 'theme' | 'customBackground' | 'customAccent'>): { from: string; to: string } {
  const { accent, light } = resolveTheme(prefs)
  const rgb = hexToRgb(accent) ?? (light ? [0, 0, 0] : [255, 255, 255])
  return {
    from: `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.35)`,
    to: `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.12)`,
  }
}
