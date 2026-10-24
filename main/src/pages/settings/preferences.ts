import { BACKGROUND_IDS } from "./backgrounds"

export type BrowserPreferences = {
  searchEngine: "Google" | "Brave" | "DuckDuckGo"
  wispUrl: string
  userAgent: string
  tabCloak: boolean
  cloakTitle: string
  cloakIcon: string
  reduceMotion: boolean
  homeBackground: boolean
  /** Site-wide animated background: a React Bits id from ./backgrounds.ts. */
  homeBackgroundStyle: string
  /** Shell transparency: clear (see-through) or solid. */
  surfaceStyle: "clear" | "solid"
  /** Backdrop blur behind clear panels, in px (0 = none). */
  surfaceBlur: number
  /** Draw the background in theme colours (components/visual/fx-theme.ts). */
  backgroundTint: boolean
  /** How much the theme background covers the animated background, 0-85 %. */
  backgroundDim: number
  /** Background/glass quality. auto = saver on low-end devices (Chromebooks). */
  performanceMode: "auto" | "quality" | "saver"
  mediaApiBase: string
  musicResults: number
  autoplayNext: boolean
  chatAppearance: "cozy" | "compact"
  chatNickname: string
  /** A preset name from lib/theme.ts THEME_PRESETS, or "custom". */
  theme: string
  customBackground: string
  customAccent: string
  tabLayout: "horizontal" | "vertical"
  /** Browser-in-browser transport: epoxy (Rust/WASM TLS, faster) or libcurl. */
  transport: "epoxy" | "libcurl"
  /** Relay path: race direct edges vs Cloudflare, or force one. */
  relayMode: "auto" | "cloudflare" | "direct"
}

export const browserPreferencesKey = "abulxt:browser-preferences"

export const defaultBrowserPreferences: BrowserPreferences = {
  searchEngine: "Brave",
  wispUrl: "",
  userAgent: "Default",
  tabCloak: false,
  cloakTitle: "Google",
  cloakIcon: "https://www.google.com/favicon.ico",
  reduceMotion: false,
  homeBackground: true,
  homeBackgroundStyle: "dark-veil",
  surfaceStyle: "clear",
  surfaceBlur: 6,
  backgroundTint: true,
  backgroundDim: 60,
  performanceMode: "auto",
  mediaApiBase: "",
  musicResults: 40,
  autoplayNext: true,
  // Default message density is cozy (chat.tsx falls back to the same value).
  // Compact remains selectable in the appearance settings.
  chatAppearance: "cozy",
  chatNickname: "",
  theme: "dark",
  customBackground: "#0b0b10",
  customAccent: "#ffffff",
  tabLayout: "horizontal",
  transport: "epoxy",
  relayMode: "auto",
}

export function loadBrowserPreferences(): BrowserPreferences {
  try {
    // `chatAvatar` (the retired free-form avatar URL) is dropped on load so
    // it is never used again and disappears from storage on the next save.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { chatAvatar: _legacyChatAvatar, ...stored } = JSON.parse(localStorage.getItem(browserPreferencesKey) ?? localStorage.getItem("dusk:browser-preferences") ?? "{}") as Record<string, unknown>
    const prefs = {
      ...defaultBrowserPreferences,
      ...stored,
    } as BrowserPreferences
    if (!BACKGROUND_IDS.has(prefs.homeBackgroundStyle)) prefs.homeBackgroundStyle = defaultBrowserPreferences.homeBackgroundStyle
    if (!["clear", "solid"].includes(prefs.surfaceStyle)) prefs.surfaceStyle = defaultBrowserPreferences.surfaceStyle
    if (typeof prefs.surfaceBlur !== "number" || !Number.isFinite(prefs.surfaceBlur)) prefs.surfaceBlur = defaultBrowserPreferences.surfaceBlur
    prefs.surfaceBlur = Math.min(24, Math.max(0, Math.round(prefs.surfaceBlur)))
    if (typeof prefs.backgroundTint !== "boolean") prefs.backgroundTint = defaultBrowserPreferences.backgroundTint
    if (typeof prefs.backgroundDim !== "number" || !Number.isFinite(prefs.backgroundDim)) prefs.backgroundDim = defaultBrowserPreferences.backgroundDim
    prefs.backgroundDim = Math.min(85, Math.max(0, Math.round(prefs.backgroundDim)))
    if (!["auto", "quality", "saver"].includes(prefs.performanceMode)) prefs.performanceMode = defaultBrowserPreferences.performanceMode
    return prefs
  } catch {
    return defaultBrowserPreferences
  }
}

export function saveBrowserPreferences(update: Partial<BrowserPreferences>): BrowserPreferences {
  const next = { ...loadBrowserPreferences(), ...update }
  try {
    localStorage.setItem(browserPreferencesKey, JSON.stringify(next))
  } catch { /* storage unavailable */ }
  document.dispatchEvent(new CustomEvent<BrowserPreferences>("dusk:preferences", { detail: next }))
  return next
}
