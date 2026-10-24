// Discord's masked-link warning ("Leaving Discord"). Discord intercepts a
// click on a link whose visible text differs from its target (a masked link
// `[text](url)`, or a link inside embed markup) and, unless the domain is
// trusted, asks before navigating:
//
//   Leaving Discord
//   This link is taking you to the following website
//   [ https://example.com/… ]
//   [ ] Trust example.com links from now on
//                                   [Go Back] [Visit Site]
//
// Plain links (text === href) and Discord's own hosts are always trusted.
// Trusted domains persist per browser (Discord keeps them in its
// MaskedLinkStore; ours lives in localStorage).

import { useEffect, useRef, useState } from 'react'
import { openOverlay } from './overlay'
import { HolyText } from '../../components/common/HolyText'

const TRUST_KEY = 'abulxt:chat-trusted-domains'

// Discord's always-trusted hosts (invite/gift/template hosts, the media
// proxy, discord(app).com) plus the page's own origin.
const BUILTIN_TRUSTED = /(^|\.)(discord\.com|discordapp\.com|discord\.gg|discord\.new|discord\.gift|discordapp\.net|discord\.media)$/i

export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const parsed = new URL(value, window.location.href)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null
  } catch {
    return null
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function readTrusted(): Set<string> {
  try {
    const raw = localStorage.getItem(TRUST_KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(Array.isArray(list) ? list.filter((d): d is string => typeof d === 'string') : [])
  } catch {
    return new Set()
  }
}

function addTrusted(domain: string): void {
  try {
    const set = readTrusted()
    set.add(domain)
    localStorage.setItem(TRUST_KEY, JSON.stringify([...set]))
  } catch {
    /* storage unavailable - the trust simply doesn't persist */
  }
}

export function isTrustedDomain(url: string): boolean {
  const host = hostOf(url)
  if (!host) return false
  if (host === window.location.hostname.toLowerCase()) return true
  if (BUILTIN_TRUSTED.test(host)) return true
  return readTrusted().has(host)
}

function visit(url: string): void {
  const opened = window.open(url, '_blank', 'noopener,noreferrer')
  if (opened) opened.opener = null
}

function normalizeText(text: string): string {
  return text.trim().replace(/\/+$/, '')
}

// Click handler for an <a> rendered from message/embed markup. Returns true
// when the click was intercepted (the warning modal is showing).
export function guardLinkClick(event: { preventDefault: () => void; button?: number }, anchor: HTMLAnchorElement): boolean {
  if (event.button !== undefined && event.button !== 0) return false
  const href = safeHttpUrl(anchor.getAttribute('href'))
  if (!href) {
    // Never follow a non-http(s) href that slipped into markup.
    event.preventDefault()
    return true
  }
  const text = normalizeText(anchor.textContent || '')
  const masked = text !== normalizeText(href) && text !== normalizeText(anchor.getAttribute('href') || '')
  if (!masked || isTrustedDomain(href)) return false
  event.preventDefault()
  showLeavingModal(href)
  return true
}

// Open the warning for an arbitrary URL (masked embed title links etc.).
export function showLeavingModal(url: string): void {
  openOverlay((close) => <LeavingModal url={url} onClose={close} />)
}

function LeavingModal({ url, onClose }: { url: string; onClose: () => void }) {
  const [trust, setTrust] = useState(false)
  const visitRef = useRef<HTMLButtonElement | null>(null)
  const domain = hostOf(url)
  useEffect(() => {
    visitRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const confirm = () => {
    if (trust && domain) addTrusted(domain)
    onClose()
    visit(url)
  }
  return (
    <div className="dcModalBackdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dcLinkModal" role="dialog" aria-modal="true" aria-labelledby="dcLinkModalTitle">
        <div className="dcLinkModalHeader">
          <h1 id="dcLinkModalTitle" className="dcLinkModalTitle"><HolyText text="Leaving Discord" /></h1>
        </div>
        <div className="dcLinkModalBody">
          <div className="dcLinkModalText"><HolyText text="This link is taking you to the following website" /></div>
          <div className="dcLinkModalUrl">{url}</div>
          <label className="dcLinkModalCheck">
            <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
            <span className="dcLinkModalCheckBox" aria-hidden="true">
              {trust && (
                <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M21.7 5.3a1 1 0 0 1 0 1.4l-12 12a1 1 0 0 1-1.4 0l-6-6a1 1 0 1 1 1.4-1.4L9 16.58l11.3-11.3a1 1 0 0 1 1.4 0Z" /></svg>
              )}
            </span>
            <span className="dcLinkModalCheckLabel">Trust <strong>{domain}</strong> links from now on</span>
          </label>
        </div>
        <div className="dcLinkModalFooter">
          <button type="button" className="dcButton dcButtonSecondary" onClick={onClose}>Go Back</button>
          <button type="button" ref={visitRef} className="dcButton dcButtonBrand" onClick={confirm}>Visit Site</button>
        </div>
      </div>
    </div>
  )
}
