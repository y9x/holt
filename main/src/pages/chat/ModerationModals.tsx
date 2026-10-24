import { useEffect, useRef, useState } from 'react'
import './moderation.css'

/* Discord's member-moderation modals for the chatbox, applied to WEBHOOK
 * identities (web-only site accounts, linked accounts, and Discord users
 * alike - see discord-chat-perms.ts):
 *   - Timeout: header "Timeout {name}", Discord's explainer, the six duration
 *     pills (60 SECS … 1 WEEK), an optional reason, Cancel / Timeout.
 *   - Ban: header "Ban '{name}'", the "Are you sure…" line, "Reason for Ban",
 *     Cancel / Ban.
 * Shares the delete confirmation's modal shell (deleteConfirm* in chat.css). */

export interface ModerationModalTarget {
  /** Webhook key: 'user:<siteId>' or 'discord:<id>'. */
  key: string
  name: string
}

export type ModerationModalKind = 'timeout' | 'ban'

// Discord's timeout duration presets.
const TIMEOUT_DURATIONS: Array<{ label: string; seconds: number }> = [
  { label: '60 SECS', seconds: 60 },
  { label: '5 MINS', seconds: 5 * 60 },
  { label: '10 MINS', seconds: 10 * 60 },
  { label: '1 HOUR', seconds: 3600 },
  { label: '1 DAY', seconds: 86400 },
  { label: '1 WEEK', seconds: 7 * 86400 },
]

const REASON_MAX = 512

export function ModerationModal({
  kind,
  target,
  onCancel,
  onConfirm,
  backdropProps,
}: {
  kind: ModerationModalKind
  target: ModerationModalTarget
  onCancel: () => void
  /** Resolves when the action succeeded; rejects with a displayable error. */
  onConfirm: (input: { seconds: number; reason: string }) => Promise<void>
  backdropProps: Record<string, unknown>
}) {
  const [seconds, setSeconds] = useState(TIMEOUT_DURATIONS[0].seconds)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => { dialogRef.current?.querySelector<HTMLElement>('.modDurationPill[aria-checked="true"], textarea')?.focus() }, [])

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm({ seconds, reason: reason.trim() })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
      setBusy(false)
    }
  }

  const title = kind === 'timeout' ? `Timeout ${target.name}` : `Ban '${target.name}'`
  return (
    <div className="deleteConfirmBackdrop modModalBackdrop" role="presentation" {...backdropProps}>
      <div
        ref={dialogRef}
        className="deleteConfirm modModal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onCancel() } }}
      >
        <div className="deleteConfirmHeader">
          <h2 className="deleteConfirmTitle">{title}</h2>
          <div className="deleteConfirmSub">
            {kind === 'timeout'
              ? 'Members who are in timeout are temporarily not allowed to chat or react in text channels.'
              : <>Are you sure you want to ban <strong>@{target.name}</strong>? They won't be able to return unless you unban them.</>}
          </div>
        </div>
        <div className="modModalBody">
          {kind === 'timeout' && (
            <>
              <div className="modFieldLabel" id="mod-duration-label">Duration</div>
              <div className="modDurationRow" role="radiogroup" aria-labelledby="mod-duration-label">
                {TIMEOUT_DURATIONS.map((d) => (
                  <button
                    key={d.seconds}
                    type="button"
                    role="radio"
                    aria-checked={seconds === d.seconds}
                    className={`modDurationPill${seconds === d.seconds ? ' selected' : ''}`}
                    disabled={busy}
                    onClick={() => setSeconds(d.seconds)}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </>
          )}
          <label className="modFieldLabel" htmlFor="mod-reason">{kind === 'timeout' ? 'Reason' : 'Reason for Ban'}</label>
          <textarea
            id="mod-reason"
            className="modReasonInput"
            rows={3}
            maxLength={REASON_MAX}
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
          />
          {error && <div className="modModalError" role="alert">{error}</div>}
        </div>
        <div className="deleteConfirmFooter">
          <button type="button" className="deleteConfirmCancel" disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className="deleteConfirmDelete" disabled={busy} onClick={() => void submit()}>
            {kind === 'timeout' ? 'Timeout' : 'Ban'}
          </button>
        </div>
      </div>
    </div>
  )
}
