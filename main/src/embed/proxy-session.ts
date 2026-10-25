// Sign-in for the chatbox on every platform.
//
// The page asks holt (POST ./_holt/session) who is signed in on the platform: holt checks with the platform
// itself (its cookies, or its localStorage token passed as `Authorization: Bearer`) and answers with a
// short holt session, kept under `holt:session` on this page's origin (never the platform's own login key):
// every chat API call and the realtime socket carry it, and holt-service turns it into the caller.
//
// Renewed every few minutes, when the tab comes back and when the platform's login changes in another tab,
// so signing out on the platform signs the chatbox out too (within one renewal).

const CHAT_TOKEN_KEY = 'holt:session'
const RENEW_MS = 10 * 60_000
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/-]+=*$/

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(token: string | null): void {
  try {
    if (token) localStorage.setItem(CHAT_TOKEN_KEY, token)
    else localStorage.removeItem(CHAT_TOKEN_KEY)
  } catch { /* storage blocked: the chatbox reads as signed out */ }
}

/** One exchange. A network or server error keeps the stored session (it expires on its own). */
async function exchange(tokenStorageKey: string | null): Promise<boolean> {
  const headers: Record<string, string> = { 'X-Holt': '1', Accept: 'application/json' }
  const platformToken = tokenStorageKey ? read(tokenStorageKey) : null
  if (platformToken && TOKEN_SHAPE.test(platformToken)) headers.Authorization = `Bearer ${platformToken}`
  try {
    const response = await fetch('./_holt/session', { method: 'POST', headers, credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) return false
    const body = (await response.json()) as { session?: unknown }
    write(typeof body.session === 'string' && TOKEN_SHAPE.test(body.session) ? body.session : null)
    return true
  } catch {
    return false
  }
}

/**
 * Sign the chatbox in (or out) before it mounts, then keep the session fresh. Resolves after the first
 * exchange, or after `waitMs` if the platform is slow (the chatbox then starts with whatever is stored).
 */
export function startProxySession(tokenStorageKey: string | null, waitMs = 4000): Promise<void> {
  const first = exchange(tokenStorageKey)
  let last = Date.now()
  const renew = () => {
    last = Date.now()
    void exchange(tokenStorageKey)
  }
  setInterval(renew, RENEW_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - last > 60_000) renew()
  })
  if (tokenStorageKey) {
    // The platform signed in or out in another tab: follow it, and reload so the chatbox starts over.
    window.addEventListener('storage', (event) => {
      if (event.key !== tokenStorageKey) return
      void exchange(tokenStorageKey).then(() => window.location.reload())
    })
  }
  return Promise.race([first.then(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, waitMs))])
}
