// Chat preferences from Settings > Appearance / Accessibility / Notifications.
// Stored in localStorage (per browser) under one key and applied live: the chat
// root reads them through useChatPrefs() and the realtime path calls
// notifyDesktop(). Reduced Motion itself lives in the shared browser
// preferences (preferences.ts `reduceMotion`) so the Abstract settings page and
// the chat stay in agreement; "Sync with Device Settings" overrides it with the
// OS `prefers-reduced-motion` value.
import { useEffect, useState, type CSSProperties } from 'react'
import { loadBrowserPreferences, type BrowserPreferences } from '../settings/preferences'
import { channelAlertLevel } from './notifSettings'
import './chatPrefs.css'

export interface ChatPrefs {
  /** Message text size, percent of the default (80-150). */
  fontScale: number
  /** Zoom of the chat root, percent (80-150). */
  zoom: number
  /** Color saturation, percent (0-100); feeds the token sheet's --saturation-factor. */
  saturation: number
  /** Gap between message groups in px (0-26); null = the density's default. */
  groupSpacing: number | null
  linkUnderlines: boolean
  syncReducedMotion: boolean
  desktopNotifications: boolean
  messageNotifications: boolean
  mentionNotifications: boolean
}

export const chatPrefsKey = 'abulxt:chat-prefs'
export const chatPrefsEvent = 'abulxt:chat-prefs'

export const defaultChatPrefs: ChatPrefs = {
  fontScale: 100,
  zoom: 100,
  saturation: 100,
  groupSpacing: null,
  linkUnderlines: false,
  syncReducedMotion: false,
  desktopNotifications: false,
  messageNotifications: false,
  mentionNotifications: true,
}

export function loadChatPrefs(): ChatPrefs {
  try {
    return { ...defaultChatPrefs, ...(JSON.parse(localStorage.getItem(chatPrefsKey) ?? '{}') as Partial<ChatPrefs>) }
  } catch {
    return defaultChatPrefs
  }
}

export function saveChatPrefs(update: Partial<ChatPrefs>): ChatPrefs {
  const next = { ...loadChatPrefs(), ...update }
  try { localStorage.setItem(chatPrefsKey, JSON.stringify(next)) } catch { /* storage unavailable */ }
  document.dispatchEvent(new CustomEvent<ChatPrefs>(chatPrefsEvent, { detail: next }))
  return next
}

const osReduceQuery = '(prefers-reduced-motion: reduce)'
function osReducesMotion(): boolean {
  try { return window.matchMedia(osReduceQuery).matches } catch { return false }
}

/** Live chat preferences plus the root class/style they translate to. */
export function useChatPrefs() {
  const [prefs, setPrefs] = useState<ChatPrefs>(loadChatPrefs)
  const [browser, setBrowser] = useState<BrowserPreferences>(loadBrowserPreferences)
  const [osReduce, setOsReduce] = useState(osReducesMotion)

  useEffect(() => {
    const onChat = (e: Event) => setPrefs((e as CustomEvent<ChatPrefs>).detail)
    const onBrowser = (e: Event) => setBrowser((e as CustomEvent<BrowserPreferences>).detail)
    const onStorage = () => { setPrefs(loadChatPrefs()); setBrowser(loadBrowserPreferences()) }
    const onOs = () => setOsReduce(osReducesMotion())
    let mq: MediaQueryList | null = null
    try { mq = window.matchMedia(osReduceQuery); mq.addEventListener('change', onOs) } catch { mq = null }
    document.addEventListener(chatPrefsEvent, onChat)
    document.addEventListener('dusk:preferences', onBrowser)
    window.addEventListener('storage', onStorage)
    return () => {
      mq?.removeEventListener('change', onOs)
      document.removeEventListener(chatPrefsEvent, onChat)
      document.removeEventListener('dusk:preferences', onBrowser)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const reduceMotion = prefs.syncReducedMotion ? osReduce : browser.reduceMotion
  const classes = [
    'chat-prefs',
    reduceMotion ? 'chat-reduce-motion' : '',
    prefs.linkUnderlines ? 'chat-underline-links' : '',
    prefs.fontScale !== 100 ? 'chat-font-scaled' : '',
    prefs.groupSpacing != null ? 'chat-group-spacing' : '',
  ].filter(Boolean).join(' ')
  const style = {
    '--saturation-factor': String(prefs.saturation / 100),
    '--chat-font-scale': String(prefs.fontScale / 100),
    '--chat-group-spacing': prefs.groupSpacing != null ? `${prefs.groupSpacing}px` : undefined,
    zoom: prefs.zoom !== 100 ? prefs.zoom / 100 : undefined,
  } as CSSProperties
  return { prefs, reduceMotion, rootClassName: classes, rootStyle: style }
}

/** Desktop notification permission, or 'unsupported' where the API is missing. */
export function notificationPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

/** Discord's desktop notification for a new message. Only while the site is in
 * the background, only if the user enabled it, and never for a muted channel
 * or a "Nothing" level. Mentions follow the mention toggle; everything else
 * needs the message toggle and the All Messages level. */
export function notifyDesktop(
  message: { id: number; channelId: string; authorName: string; content: string },
  mentioned: boolean,
  // The message's guild and its channel's parent category, so server and
  // category mutes / levels apply (not just the channel's own).
  scope: { guildId: string; parentId?: string | null },
) {
  const prefs = loadChatPrefs()
  if (!prefs.desktopNotifications || notificationPermission() !== 'granted') return
  if (!document.hidden && document.hasFocus()) return
  const level = channelAlertLevel(message.channelId, scope.parentId, scope.guildId)
  if (level === 'muted' || level === 'nothing') return
  if (mentioned ? !prefs.mentionNotifications : !(prefs.messageNotifications && level === 'all')) return
  try {
    const note = new Notification(message.authorName, { body: message.content.slice(0, 200), tag: `msg-${message.id}`, icon: '/favicon.ico' })
    note.onclick = () => { window.focus(); note.close() }
  } catch { /* blocked by the browser */ }
}
