// The full chatbox, for a chat platform (platform.chat) mounted on its own origin. The vendored chatbox
// (pages/chat, VENDOR.md) talks to that origin's chat API and session exactly as it does inside the
// platform's own app; only navigation and sign-in are holt's (lib/navigate.ts, components/AuthGate.tsx).
//
// The theme is the platform's: the page shares its origin, so the user's saved preferences are readable
// here, and a change made on the platform page (another frame or tab) arrives as a storage event.

import { useEffect } from 'react'
import './index.css'
import { applyTheme } from './lib/theme'
import { loadBrowserPreferences } from './pages/settings/preferences'
import { ChatPage } from './pages/chat/chat'

function applySavedTheme(): void {
  applyTheme(loadBrowserPreferences())
}

/**
 * "Copy Message Link" inside the chat points at this page (`/chat/#/chat?guild=…&channel=…&message=…`).
 * Hand the target to the chatbox the way the platform app does for its own `#/chat?…` links: through
 * sessionStorage, which the chatbox reads on mount (abulxt App.tsx, `abulxt:chat-link`).
 */
function takeChatLink(): void {
  const match = /^#\/chat\?(.*)$/.exec(window.location.hash)
  if (!match) return
  const params = new URLSearchParams(match[1])
  const channel = params.get('channel')
  if (!channel) return
  try {
    sessionStorage.setItem('abulxt:chat-link', JSON.stringify({ guild: params.get('guild'), channel, message: params.get('message') }))
  } catch { /* storage blocked: the chat opens on its default channel */ }
  history.replaceState(null, '', window.location.pathname + window.location.search)
}

// Before the first paint, so the chat never flashes the default colors.
applySavedTheme()
takeChatLink()

export function ChatMount() {
  useEffect(() => {
    window.addEventListener('storage', applySavedTheme)
    return () => window.removeEventListener('storage', applySavedTheme)
  }, [])
  return <ChatPage />
}
