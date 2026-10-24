// Reactions: the reaction pill (hover tooltip with the reactors' names) and
// the reactions popout (tabs per emoji, scrollable list of reactors).
//
// Strings and structure follow Discord's reaction tooltip
// (intl/en-US.json: "reacted by", "and N others" as a link, "Click to remove
// {emojiName}", "Click to react with {emojiName}") and its reactions popout.
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { bridgeReactors, type BridgeReaction, type BridgeReactor, type BridgeReactors } from '../../lib/bridge'
import { HolyText } from '../../components/common/HolyText'
import { Popout } from './popout'
import { Emoji } from './Emoji'
import { allEmoji, type EmojiEntry } from './emoji-data'
import './reactors.css'

const REACTORS_TTL_MS = 30_000
const reactorsCache = new Map<string, { at: number; data: BridgeReactors }>()

// Cached per message + emoji. Entries are dropped when the count changes, so a
// live reaction update re-fetches the names.
export async function loadReactors(messageId: number, emoji: string, count: number): Promise<BridgeReactors> {
  const key = `${messageId}:${emoji}`
  const hit = reactorsCache.get(key)
  if (hit && hit.at + REACTORS_TTL_MS > Date.now() && hit.data.count === count) return hit.data
  const data = await bridgeReactors(messageId, emoji)
  reactorsCache.set(key, { at: Date.now(), data })
  return data
}

function entryFor(emoji: string): EmojiEntry | undefined {
  return allEmoji.find((e) => e[1] === emoji) || allEmoji.find((e) => e[0] === emoji)
}

// Discord's ":name:" form for the emoji (the catalog name, underscores kept).
function emojiNameOf(emoji: string): string {
  const entry = entryFor(emoji)
  return entry ? `:${entry[0]}:` : emoji
}

interface TooltipProps {
  messageId: number
  reaction: BridgeReaction
  reacted: boolean
  onMore: () => void
}

// Discord's reaction tooltip body: "<emoji> reacted by A, B, and N others".
// The "N others" / "N people" part is a link that opens the reactions popout.
function ReactionTooltipBody({ messageId, reaction, reacted, onMore }: TooltipProps) {
  const [data, setData] = useState<BridgeReactors | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let live = true
    setError(false)
    loadReactors(messageId, reaction.emoji, reaction.count)
      .then((d) => { if (live) setData(d) })
      .catch(() => { if (live) setError(true) })
    return () => { live = false }
  }, [messageId, reaction.emoji, reaction.count])

  const emojiName = emojiNameOf(reaction.emoji)
  const hint = reacted ? `Click to remove ${emojiName}` : `Click to react with ${emojiName}`
  const total = reaction.count
  const names = (data?.reactors || []).slice(0, 3).map((r: BridgeReactor) => r.name)
  const others = Math.max(0, total - names.length)
  const link = (text: string) => (
    <button type="button" className="reactionTooltipLink" onClick={(e) => { e.stopPropagation(); onMore() }}>{text}</button>
  )
  const othersLink = others === 1 ? link('1 other') : link(`${others} others`)

  let line: ReactNode = null
  if (!data || error) line = null
  else if (names.length === 0) line = total === 1 ? 'reacted by 1 person' : <>reacted by {link(`${total} people`)}</>
  else if (names.length === 1) line = others > 0 ? <>reacted by {names[0]} and {othersLink}</> : <>reacted by {names[0]}</>
  else if (names.length === 2) line = others > 0 ? <>reacted by {names[0]}, {names[1]}, and {othersLink}</> : <>reacted by {names[0]} and {names[1]}</>
  else line = others > 0 ? <>reacted by {names[0]}, {names[1]}, {names[2]}, and {othersLink}</> : <>reacted by {names[0]}, {names[1]}, and {names[2]}</>

  return (
    <div className="reactionTooltipInner">
      <div className="reactionTooltipText">
        <span className="reactionTooltipEmojiName">{emojiName}</span>
        {line && <> {line}</>}
      </div>
      <div className="reactionTooltipHint">{hint}</div>
    </div>
  )
}

interface ReactionPillProps {
  messageId: number
  reaction: BridgeReaction
  reacted: boolean
  className: string
  ariaLabel: string
  ariaPressed: boolean
  onClick: () => void
  onContextMenu: (e: ReactMouseEvent<HTMLButtonElement>) => void
  onOpenReactors: (el: Element) => void
  children: ReactNode
}

// The reaction pill: the same button as before (click toggles the caller's
// reaction, right-click keeps the context menu), plus Discord's hover tooltip.
export function ReactionPill({ messageId, reaction, reacted, className, ariaLabel, ariaPressed, onClick, onContextMenu, onOpenReactors, children }: ReactionPillProps) {
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const [hover, setHover] = useState(false)
  const closeTimer = useRef<number | null>(null)
  const cancelClose = () => { if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null } }
  const scheduleClose = () => { cancelClose(); closeTimer.current = window.setTimeout(() => setHover(false), 150) }
  useEffect(() => () => cancelClose(), [])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={className}
        onClick={onClick}
        onContextMenu={onContextMenu}
        onMouseEnter={() => { cancelClose(); setHover(true) }}
        onMouseLeave={scheduleClose}
        onFocus={() => setHover(true)}
        onBlur={scheduleClose}
        aria-label={ariaLabel}
        aria-pressed={ariaPressed}
      >
        {children}
      </button>
      {hover && (
        <Popout anchor={() => btnRef.current} position="top" align="center" spacing={8}>{(ref) => (
          <div
            ref={ref}
            className="reactionTooltip"
            role="tooltip"
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
          >
            <ReactionTooltipBody
              messageId={messageId}
              reaction={reaction}
              reacted={reacted}
              onMore={() => {
                setHover(false)
                if (btnRef.current) onOpenReactors(btnRef.current)
              }}
            />
          </div>
        )}</Popout>
      )}
    </>
  )
}

interface ReactorsPopoutProps {
  messageId: number
  reactions: BridgeReaction[]
  /** The selected tab (controlled by the parent). */
  emoji: string
  anchor: Element
  onSelectEmoji: (emoji: string) => void
  onOpenProfile: (reactor: BridgeReactor, el: Element) => void
}

// Discord's reactions popout: one tab per emoji (emoji + count), the full
// reactor list for the selected tab. Clicking a row opens that user's profile.
export function ReactorsPopout({ messageId, reactions, emoji, anchor, onOpenProfile, onSelectEmoji }: ReactorsPopoutProps) {
  const selected = reactions.find((r) => r.emoji === emoji) || reactions[0] || null
  const [data, setData] = useState<BridgeReactors | null>(null)
  const [error, setError] = useState<string | null>(null)
  const selectedEmoji = selected?.emoji ?? null
  const selectedCount = selected?.count ?? 0

  useEffect(() => {
    if (!selectedEmoji) return
    let live = true
    setData(null)
    setError(null)
    loadReactors(messageId, selectedEmoji, selectedCount)
      .then((d) => { if (live) setData(d) })
      .catch(() => { if (live) setError('Could not load reactions.') })
    return () => { live = false }
  }, [messageId, selectedEmoji, selectedCount])

  if (!selected) return null

  return (
    <Popout anchor={anchor} position="top" align="center" spacing={8}>{(ref) => (
      <div ref={ref} className="reactorsPopout" role="dialog" aria-label="Reactions">
        <div className="reactorsTabs" role="tablist">
          {reactions.map((r) => {
            const e = entryFor(r.emoji)
            const active = r.emoji === selected.emoji
            return (
              <button
                key={r.emoji}
                type="button"
                role="tab"
                aria-selected={active}
                className={`reactorsTab${active ? ' active' : ''}`}
                onClick={() => onSelectEmoji(r.emoji)}
              >
                {e ? <Emoji entry={e} size={16} /> : <span className="emoji-text">{r.emoji}</span>}
                <span className="reactorsTabCount">{r.count}</span>
              </button>
            )
          })}
        </div>
        <div className="reactorsBody" role="tabpanel">
          {error ? (
            <div className="reactorsEmpty">{error}</div>
          ) : !data ? (
            <div className="reactorsEmpty">Loading…</div>
          ) : data.reactors.length === 0 ? (
            <div className="reactorsEmpty"><HolyText text="No one reacted with this emoji." /></div>
          ) : (
            <ul className="reactorsList">
              {data.reactors.map((r) => (
                <li key={r.key}>
                  <button
                    type="button"
                    className="reactorsRow"
                    onClick={(e) => onOpenProfile(r, e.currentTarget)}
                  >
                    <img src={r.avatar} alt="" loading="lazy" />
                    <span className="reactorsName" style={r.color ? { color: r.color } : undefined}>{r.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    )}</Popout>
  )
}
