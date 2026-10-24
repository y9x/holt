// Discord's Developer Mode (Settings > Advanced). Purely a client view
// preference: when on, the context menus show their "Copy … ID" entries.
// Persisted per browser in localStorage and synced across open tabs/components
// through a same-window custom event (the `storage` event only fires cross-tab).
import { useEffect, useState } from 'react'

export const DEVELOPER_MODE_KEY = 'abulxt:chat-developer-mode'
const CHANGE_EVENT = 'abulxt:developer-mode'

export function readDeveloperMode(): boolean {
  try { return localStorage.getItem(DEVELOPER_MODE_KEY) === '1' } catch { return false }
}

export function writeDeveloperMode(on: boolean): void {
  try { localStorage.setItem(DEVELOPER_MODE_KEY, on ? '1' : '0') } catch { /* ignore */ }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function useDeveloperMode(): boolean {
  const [on, setOn] = useState(readDeveloperMode)
  useEffect(() => {
    const sync = () => setOn(readDeveloperMode())
    window.addEventListener(CHANGE_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  return on
}
