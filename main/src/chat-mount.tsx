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

// Before the first paint, so the chat never flashes the default colors.
applySavedTheme()

export function ChatMount() {
  useEffect(() => {
    window.addEventListener('storage', applySavedTheme)
    return () => window.removeEventListener('storage', applySavedTheme)
  }, [])
  return <ChatPage />
}
