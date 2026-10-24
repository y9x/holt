// holt-owned stand-in for abulxt's lib/navigate.ts, which the vendored chatbox imports (VENDOR.md).
//
// In holt the chatbox is the platform's own /chat/ page, or framed by the platform's page on the same
// origin. A link to one of the platform's views (account, settings, privacy) moves that page: the parent
// when framed, this page otherwise. It never changes only the chat frame.

export type NavigateView = 'home' | 'games' | 'music' | 'ai' | 'chat' | 'extensions' | 'credits' | 'pricing' | 'account' | 'settings' | 'browser' | 'tos' | 'privacy' | 'verify-email' | 'admin' | 'docs'

export function navigateTo(view: NavigateView): void {
  const hash = `#/${view}`
  try {
    if (window.top && window.top !== window) {
      window.top.location.hash = hash
      return
    }
  } catch {
    // A cross-origin parent (not a proxy mount): fall through and navigate this page.
  }
  window.location.assign(`/${hash}`)
}
