import { useState } from 'react'
import { resendVerification } from '../../lib/auth-api'
import { HolyText } from '../../components/common/HolyText'

// Discord's guild verification card (lazy/115332 + lazy/205406): shown in place
// of the chat bar when the account must verify before it can send here.
// Title: "You must verify your email before you can send messages in this
// server." Button: "Resend Verification Email" (verifyResend).
export function VerificationCard({ hasEmail, onResent }: { hasEmail: boolean; onResent?: () => void }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const resend = async () => {
    setState('sending')
    setError(null)
    try {
      await resendVerification()
      setState('sent')
      onResent?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the email right now.')
      setState('error')
    }
  }
  // Discord's verify card. No email yet -> the same title with "Add an Email"
  // (Discord's label), which opens the account page where the email is added.
  // Email on file but unverified -> "Resend Verification Email".
  if (!hasEmail) {
    return (
      <div className="chat-verifyCard">
        <div className="chat-verifyCardText">
          <div className="chat-verifyCardTitle">You must verify your email before you can send messages in this server.</div>
        </div>
        <div className="chat-verifyCardButton">
          <button type="button" className="chat-verifyCardBtn" onClick={() => { window.location.hash = '#/account' }}>Add an Email</button>
        </div>
      </div>
    )
  }
  return (
    <div className="chat-verifyCard">
      <div className="chat-verifyCardText">
        <div className="chat-verifyCardTitle">You must verify your email before you can send messages in this server.</div>
        {state === 'sent' && <div className="chat-verifyCardSub"><HolyText text="Check your inbox for the verification code." /></div>}
        {state === 'error' && error && <div className="chat-verifyCardSub chat-verifyCardError">{error}</div>}
      </div>
      <div className="chat-verifyCardButton">
        <button type="button" className="chat-verifyCardBtn" onClick={resend} disabled={state === 'sending'}>
          {state === 'sending' ? 'Sending…' : 'Resend Verification Email'}
        </button>
      </div>
    </div>
  )
}
