// The embed shell: finds out who is signed in and shows it with the platform's own account actions. The
// chat client mounts here once it moves in (docs/PLAN.md, phase 2); this shell is what stays around it.
//
//   proxy   The page is the platform's own `/chat/`. holt asks the platform server-side (./_holt/me) and
//           account actions navigate this page directly.
//   iframe  The handshake (ready -> token -> /api/session) with the framing page, which also performs
//           account actions (`navigate`).
//
// holt has no account UI. Every account action goes to one of the platform's links.

import { useEffect, useMemo, useRef, useState } from 'react'
import { HolyText } from '../components/common/HolyText'
import { HolyDynamic, HolyRich } from '../components/common/HolyRich'
import { HOLT_PROTOCOL, type LinkTarget } from './protocol'
import { hostChannel } from './host'
import { exchangeToken, fetchProxyPrincipal, type HoltSession, type PublicPrincipal } from './session'
import type { EmbedPlatform } from './platform'

/** Ask the platform for a fresh identity token this long before the holt session ends. */
const REFRESH_LEAD_MS = 5 * 60_000

type View =
  | { kind: 'connecting' }
  | { kind: 'standalone' }
  | { kind: 'guest' }
  | { kind: 'signed-in'; principal: PublicPrincipal }
  | { kind: 'error'; reason: 'rejected' | 'unreachable' }

interface Action {
  target: LinkTarget
  label: string
}

export function App({ platform }: { platform: EmbedPlatform }) {
  const proxied = platform.mode === 'proxy'
  const host = useMemo(() => hostChannel(platform.origins), [platform])
  const [view, setView] = useState<View>(proxied || host.embedded ? { kind: 'connecting' } : { kind: 'standalone' })
  const [reconnecting, setReconnecting] = useState(false)
  // The session token, for the chat API once it moves in. Memory only.
  const session = useRef<HoltSession | null>(null)
  const refreshTimer = useRef<number | undefined>(undefined)

  // Proxy embedding: ask again whenever the tab comes back, since the user may have signed in or out on
  // the platform in another tab.
  useEffect(() => {
    if (!proxied) return
    let cancelled = false
    const load = () => {
      void fetchProxyPrincipal(platform.tokenStorageKey).then((result) => {
        if (cancelled) return
        if (!result.ok) {
          console.warn(`holt: could not load who is signed in (${result.detail})`)
          setView({ kind: 'error', reason: 'unreachable' })
          return
        }
        setView(result.principal ? { kind: 'signed-in', principal: result.principal } : { kind: 'guest' })
      })
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') load()
    }
    load()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [proxied])

  useEffect(() => {
    if (proxied || !host.embedded) return
    const scheduleRefresh = (expiresAt: number) => {
      window.clearTimeout(refreshTimer.current)
      const delay = Math.max(expiresAt - Date.now() - REFRESH_LEAD_MS, 0)
      refreshTimer.current = window.setTimeout(() => {
        setReconnecting(true)
        host.send({ holt: HOLT_PROTOCOL, type: 'token-expired' })
      }, delay)
    }
    const unlisten = host.listen((message) => {
      if (message.token === null) {
        session.current = null
        window.clearTimeout(refreshTimer.current)
        setReconnecting(false)
        setView({ kind: 'guest' })
        return
      }
      void exchangeToken(platform.id, message.token).then((result) => {
        setReconnecting(false)
        if (!result.ok) {
          console.warn(`holt: session exchange failed (${result.detail})`)
          session.current = null
          setView({ kind: 'error', reason: result.reason })
          return
        }
        session.current = result.session
        scheduleRefresh(result.session.expiresAt)
        setView({ kind: 'signed-in', principal: result.session.principal })
      })
    })
    host.send({ holt: HOLT_PROTOCOL, type: 'ready' })
    return () => {
      unlisten()
      window.clearTimeout(refreshTimer.current)
    }
  }, [host, platform.id, proxied])

  // Hosts that size the frame to its content get the height on every change.
  useEffect(() => {
    if (proxied || !host.embedded || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      host.send({ holt: HOLT_PROTOCOL, type: 'resize', height: document.documentElement.scrollHeight })
    })
    observer.observe(document.body)
    return () => observer.disconnect()
  }, [host, proxied])

  const navigate = (target: LinkTarget) => {
    const url = platform.links[target]
    if (!url) return
    // Proxied, this page is the platform's own page; framed, the platform's page navigates itself.
    if (proxied) window.location.assign(url)
    else host.send({ holt: HOLT_PROTOCOL, type: 'navigate', target, url })
  }

  const actions: Action[] = []
  if (view.kind === 'guest') actions.push({ target: 'signIn', label: 'Sign in' })
  if (view.kind === 'signed-in') {
    actions.push({ target: 'account', label: 'Account' }, { target: 'settings', label: 'Settings' })
    if (!view.principal.emailVerified) actions.push({ target: 'verifyEmail', label: 'Verify email' })
  }
  const offered = actions.filter((action) => platform.links[action.target] !== null)

  return (
    <main className="holt-shell">
      <section className="holt-identity" aria-live="polite">
        {view.kind === 'connecting' && <HolyText as="p" className="holt-muted" text="Connecting…" />}
        {view.kind === 'standalone' && <HolyText as="p" className="holt-muted" text="This chat is meant to be embedded in another site." />}
        {view.kind === 'error' && (
          <HolyText as="p" className="holt-error" text={view.reason === 'rejected' ? 'Could not sign you in.' : 'Could not reach the chat service.'} />
        )}
        {view.kind === 'guest' && (
          <>
            <HolyText as="p" text="Browsing as a guest." />
            <HolyText as="p" className="holt-muted" text="Sign in to chat." />
          </>
        )}
        {view.kind === 'signed-in' && (
          <div className="holt-who">
            {/* Decorative: the name is rendered next to it. */}
            {view.principal.avatar && <img className="holt-avatar" src={view.principal.avatar} alt="" referrerPolicy="no-referrer" />}
            <div>
              <HolyRich as="p">
                Signed in as <HolyDynamic className="holt-name">{view.principal.name}</HolyDynamic>
              </HolyRich>
              {!view.principal.emailVerified && <HolyText as="p" className="holt-muted" text="Verify your email to chat." />}
            </div>
          </div>
        )}
        {reconnecting && <HolyText as="p" className="holt-muted" text="Reconnecting…" />}
      </section>
      {offered.length > 0 && (
        <nav className="holt-actions">
          {offered.map((action) => (
            <button key={action.target} type="button" className="holt-action" onClick={() => navigate(action.target)}>
              <HolyText text={action.label} />
            </button>
          ))}
        </nav>
      )}
    </main>
  )
}
