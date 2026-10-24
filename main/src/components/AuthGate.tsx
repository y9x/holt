// holt-owned stand-in for abulxt's components/AuthGate.tsx, which the vendored chatbox opens when a guest
// tries to post. holt has no account UI: instead of a sign-in form, this sends the user to the platform's
// own account page (navigate.ts), and the chat picks the session up when they come back.

import type { ReactNode } from 'react'
import { HolyText } from './common/HolyText'
import { navigateTo } from '../lib/navigate'
import type { AbulxtUser } from '../lib/auth-api'
import './AuthGate.css'

export type AuthGateProps = {
  icon: ReactNode
  title?: string
  subtitle?: string
  /** Kept for the vendored call sites. Never called here: the sign-in happens on the platform's page. */
  onDone: (user: AbulxtUser) => void
  onClose?: () => void
  initialMode?: 'login' | 'register'
}

export function AuthModal({ onClose, icon, title, subtitle }: AuthGateProps & { onClose: () => void }) {
  return (
    <div className="holt-auth-overlay" role="dialog" aria-modal="true">
      <div className="holt-auth-card">
        <span className="holt-auth-icon" aria-hidden="true">{icon}</span>
        <HolyText as="h2" className="holt-auth-title" text={title || 'Sign in to chat'} />
        <HolyText as="p" className="holt-auth-subtitle" text={subtitle || 'Sign in on the site to join the conversation.'} />
        <div className="holt-auth-actions">
          <button type="button" className="holt-auth-primary" onClick={() => navigateTo('account')}>
            <HolyText text="Sign in" />
          </button>
          <button type="button" className="holt-auth-secondary" onClick={onClose}>
            <HolyText text="Not now" />
          </button>
        </div>
      </div>
    </div>
  )
}
