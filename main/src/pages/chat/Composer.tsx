import { forwardRef, type ClipboardEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { HolyText } from '../../components/common/HolyText'
import { useHolyAttr } from '../../lib/holy-attr'
import { EmojiSpriteButton } from './EmojiSpriteButton'
import { ChannelTypeIcon, type ChannelIconKind } from './channelIcons'
import { twemojiUrl } from './twemoji'
import type { EmojiEntry } from './emoji-data'

/* Discord's filled composer glyphs (ripped from the live client's SVGs - all
 * SOLID fill="currentColor", not lucide's stroked outlines). */

// Sticker: Discord's StickerIcon (web.js module 797285) - rounded square with
// a smiley and the peeled bottom-right corner, verbatim incl. its evenodd body.
function ComposerStickerIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d="M6 2h12a4 4 0 0 1 4 4v7.5a.5.5 0 0 1-.5.5H19a5 5 0 0 0-5 5v2.5a.5.5 0 0 1-.5.5H6a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4Zm.5 8a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM19 8.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm-9.91 2.94a1 1 0 0 0-1.66 1.12 5.5 5.5 0 0 0 9.14 0 1 1 0 0 0-1.66-1.12 3.5 3.5 0 0 1-5.82 0Z" />
      <path fill="currentColor" d="M21.66 16c.03 0 .05.03.04.06a3 3 0 0 1-.58.82l-4.24 4.24a3 3 0 0 1-.82.58.04.04 0 0 1-.06-.04V19a3 3 0 0 1 3-3h2.66Z" />
    </svg>
  )
}

// GIF: Discord's GifIcon (rounded square with the letters knocked out).
function ComposerGifIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d="M5 2a3 3 0 0 0-3 3v14a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V5a3 3 0 0 0-3-3H5Zm2.18 13.87a2.9 2.9 0 0 1-1.66-.49 3.18 3.18 0 0 1-1.12-1.35A4.88 4.88 0 0 1 4 12c0-.75.14-1.42.42-2 .29-.59.7-1.04 1.24-1.37a3.7 3.7 0 0 1 1.95-.5c.64 0 1.21.14 1.72.4.5.28.89.67 1.15 1.16l-1.22.88a1.76 1.76 0 0 0-1.64-1.02c-.66 0-1.17.22-1.52.65a2.74 2.74 0 0 0-.53 1.8c0 .78.18 1.39.53 1.81.35.42.86.64 1.52.64.3 0 .57-.06.81-.16.25-.12.45-.27.58-.47v-.93H7.3v-1.4h3.24v4.23H9.27l-.2-.71c-.43.57-1.06.86-1.89.86Zm6.34-.15h-1.57V8.28h1.57v7.44Zm1.51 0h1.57v-2.83h2.76v-1.42H16.6V9.7H20V8.28h-4.97v7.44Z" />
    </svg>
  )
}

// Locked-channel / error notice: Discord's CircleErrorIcon.
function ComposerCircleAlertIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d="M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22Zm1.44-15.94L13.06 14a1.06 1.06 0 0 1-2.12 0l-.38-6.94a1 1 0 0 1 1-1.06h.88a1 1 0 0 1 1 1.06Zm-.19 10.69a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z" />
    </svg>
  )
}

// Mention-autocomplete member/everyone/here row: Discord's UserIcon.
function ComposerPersonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM11.53 11A9.53 9.53 0 0 0 2 20.53c0 .81.66 1.47 1.47 1.47h.22c.24 0 .44-.17.5-.4.29-1.12.84-2.17 1.32-2.91.14-.21.43-.1.4.15l-.26 2.61c-.02.3.2.55.5.55h11.7a.5.5 0 0 0 .5-.55l-.27-2.6c-.02-.26.27-.37.41-.16.48.74 1.03 1.8 1.32 2.9.06.24.26.41.5.41h.22c.81 0 1.47-.66 1.47-1.47A9.53 9.53 0 0 0 12.47 11h-.94Z" />
    </svg>
  )
}

/* Discord's channel text area, rebuilt to their real DOM:
 *   .channelTextArea
 *     .scrollableContainer (themedBackground)
 *       .inner
 *         .textArea.textAreaSlate   (the contenteditable, 44px slate)
 *         .buttons                  (right-side action row, sticky)
 *           [gif] [sticker] [emoji]  (gif/sticker only with embed perms + KLIPY)
 *         [sendButton]              (visible only with content - Discord's
 *                                    paper-plane at the right edge)
 * Geometry/tokens come from the vendored composer CSS (d-channelTextArea etc.).
 * There is no attach (+) button: the bridge has no upload path. The GIF and
 * sticker buttons render only when canGifs/canStickers (embed permission + a
 * KLIPY key, the picker's own gate) - Discord hides controls you can't use. */

/* Mention autocomplete (Discord's @-tab): chat.tsx owns the trigger/query
 * state and the fetched suggestions; the Composer only renders the popup above
 * the bar and reports interactions back. Items are a flat list - section
 * headers (Members / Roles) are inserted between runs of one kind, exactly
 * like Discord's grouped autocomplete. Selecting an item calls onSelect with
 * the item's index; keyboard nav (up/down/enter/tab/esc) is intercepted
 * in chat.tsx's composer keydown BEFORE the Enter-to-send handling. */

export interface MentionSuggestionItem {
  /** Row kind - drives the leading affordance (avatar, role dot, icon). */
  kind: 'member' | 'role' | 'everyone' | 'here' | 'channel' | 'emoji'
  /** Stable identity for keys (snowflake, or 'everyone'/'here'). */
  id: string
  /** Primary label (display name / role name / everyone / here). */
  label: string
  /** Secondary line - @username for members. */
  sublabel?: string
  /** Discord CDN avatar url for members. */
  avatarUrl?: string | null
  /** Role color (any CSS color) for the colored dot. */
  color?: string | null
  /** Enhanced role colors (gradient / holographic) - gradient-filled dot. */
  colors?: { primary: string; secondary: string; tertiary: string | null } | null
  /** Channel rows: which Discord channel glyph leads the row. */
  channelKind?: ChannelIconKind
  /** Emoji rows: the catalog entry (label is ':name:'). */
  emoji?: EmojiEntry
}

export interface ComposerMentionAutocomplete {
  items: MentionSuggestionItem[]
  activeIndex: number
  onSelect: (index: number) => void
  onHover: (index: number) => void
  /** Right-click on a suggestion row - chat.tsx opens Discord's Mention /
      Copy ID menu for it. */
  onContext?: (index: number, e: MouseEvent) => void
  /** The typed query - the emoji section title reads "Emoji matching :q". */
  query?: string
}

/* The autocomplete popup shared by the composer and the inline message
 * editor (MessageEditor.tsx) - one renderer so both text areas look and
 * behave identically. Rows are flat with a section header ahead of each run
 * of a kind (Discord renders "Members" / "Roles" group titles the same way;
 * the emoji tab's title is "Emoji matching **:query**"). mousedown (not
 * click) selects so the contenteditable keeps focus and the caret position
 * the owner recorded stays valid for the token splice. */
export function MentionAutocompletePopup({ ac, className = '' }: { ac: ComposerMentionAutocomplete; className?: string }) {
  if (ac.items.length === 0) return null
  let lastSection = ''
  const sectionFor = (kind: MentionSuggestionItem['kind']) =>
    kind === 'member' ? 'Members'
      : kind === 'role' ? 'Roles'
        : kind === 'channel' ? 'Text Channels'
          : kind === 'emoji' ? 'Emoji'
            : '' // @everyone/@here lead the list with no header, like Discord
  return (
    <div className={`mentionAutocomplete${className ? ` ${className}` : ''}`} role="listbox" aria-label="Mention suggestions">
      {ac.items.map((item, index) => {
        const section = sectionFor(item.kind)
        const header = section !== lastSection && section !== ''
          ? (
            <div key={`section-${section}`} className="mentionAutocompleteSection">
              {item.kind === 'emoji'
                ? <>Emoji matching <strong className="mentionAutocompleteQuery">:{ac.query ?? ''}</strong></>
                : section}
            </div>
          )
          : null
        lastSection = section
        const selected = index === ac.activeIndex
        return (
          <div key={`${item.kind}-${item.id}`}>
            {header}
            <div
              role="option"
              aria-selected={selected}
              className={`mentionAutocompleteItem ${selected ? 'selected' : ''}`}
              onMouseEnter={() => ac.onHover(index)}
              // preventDefault for every button keeps focus in the editor;
              // only the primary button picks - a right-click press must not
              // select the row before its context menu opens.
              onMouseDown={(e: MouseEvent) => { e.preventDefault(); if (e.button === 0) ac.onSelect(index) }}
              onContextMenu={(e: MouseEvent) => ac.onContext?.(index, e)}
            >
              {item.kind === 'member' && (
                item.avatarUrl
                  ? <img className="mentionAutocompleteAvatar" src={item.avatarUrl} alt="" aria-hidden="true" />
                  : <span className="mentionAutocompleteIcon" aria-hidden="true"><ComposerPersonIcon /></span>
              )}
              {item.kind === 'role' && (
                <span
                  className="mentionAutocompleteRoleDot"
                  style={item.colors
                    ? { background: `linear-gradient(to right, ${[item.colors.primary, item.colors.secondary, item.colors.tertiary].filter(Boolean).join(', ')})` }
                    : { backgroundColor: item.color || 'var(--interactive-muted)' }}
                  aria-hidden="true"
                />
              )}
              {(item.kind === 'everyone' || item.kind === 'here') && (
                <span className="mentionAutocompleteIcon" aria-hidden="true"><ComposerPersonIcon /></span>
              )}
              {item.kind === 'channel' && (
                <span className="mentionAutocompleteIcon" aria-hidden="true"><ChannelTypeIcon kind={item.channelKind || 'text'} size={16} /></span>
              )}
              {item.kind === 'emoji' && item.emoji && (
                <img className="emoji mentionAutocompleteEmoji" src={twemojiUrl(item.emoji[3])} alt={item.emoji[1]} draggable={false} aria-hidden="true" />
              )}
              <span className="mentionAutocompleteLabel">{item.label}</span>
              {item.sublabel && <span className="mentionAutocompleteSublabel">{item.sublabel}</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* Discord's reply bar (replyBar__841c8) - rendered INSIDE the channelTextArea
 * as the first stackedBars child, so it shares the bar's 1px border and 8px
 * top radius instead of floating above it. */
export interface ComposerReplyBar {
  authorName: string
  /** Show the "@ ON/OFF" switch (Discord hides it when replying to yourself). */
  showMentionToggle: boolean
  mention: boolean
  onToggleMention: () => void
  onCancel: () => void
  /** Clicking the bar jumps to the replied-to message (Discord). */
  onJump?: () => void
}

// Discord's 16px at-sign (mentionIcon__841c8) - AtIcon, verbatim.
function ComposerAtIcon() {
  return (
    <svg className="replyBarMentionIcon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M16.44 6.96c.29 0 .51.25.47.54l-.82 6.34c-.02.08-.03.2-.03.34 0 .71.28 1.07.85 1.07.49 0 .94-.21 1.36-.63.43-.42.77-1 1.02-1.72.26-.75.38-1.57.38-2.48 0-1.35-.29-2.54-.87-3.56a5.92 5.92 0 0 0-2.45-2.35 7.68 7.68 0 0 0-3.61-.83c-1.55 0-2.96.37-4.22 1.1a7.66 7.66 0 0 0-2.96 3.07 9.53 9.53 0 0 0-1.09 4.66c0 1.45.26 2.77.78 3.95a6.3 6.3 0 0 0 2.47 2.81 8.3 8.3 0 0 0 4.36 1.05 12.43 12.43 0 0 0 5.35-1.18.5.5 0 0 1 .7.24l.46 1.07c.1.22.02.47-.19.59-.77.43-1.69.77-2.75 1.02-1.23.3-2.48.44-3.76.44-2.18 0-4-.44-5.48-1.33a8.1 8.1 0 0 1-3.27-3.57 11.93 11.93 0 0 1-1.07-5.12c0-2.24.47-4.19 1.4-5.84a9.7 9.7 0 0 1 3.86-3.8c1.62-.9 3.4-1.34 5.36-1.34 1.8 0 3.4.37 4.8 1.12 1.4.72 2.5 1.76 3.28 3.1a8.86 8.86 0 0 1 1.16 4.56c0 1.36-.23 2.57-.7 3.64a5.81 5.81 0 0 1-1.92 2.47c-.82.58-1.76.87-2.81.87a2.4 2.4 0 0 1-1.6-.5c-.4-.35-.65-.78-.73-1.32-.3.55-.74 1-1.36 1.34a4.3 4.3 0 0 1-2.03.48A3.4 3.4 0 0 1 8 16C7.33 15.16 7 14 7 12.5c0-1.14.2-2.16.6-3.05.43-.89 1-1.57 1.73-2.06a4.3 4.3 0 0 1 4.27-.31c.47.29.82.68 1.07 1.16l.3-.95c.06-.2.25-.33.46-.33h1.02Zm-5.06 8.24c.8 0 1.45-.35 1.97-1.04.51-.7.77-1.6.77-2.7 0-.88-.18-1.56-.53-2.03a1.76 1.76 0 0 0-1.5-.73c-.8 0-1.45.35-1.97 1.04a4.28 4.28 0 0 0-.78 2.67c0 .9.17 1.58.51 2.06.36.49.87.73 1.53.73Z" />
    </svg>
  )
}

// Discord's 16px filled circle-x (closeIcon_e876a8).
function ComposerCircleXIcon() {
  return (
    <svg className="replyBarCloseIcon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d="M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22Zm4.7-15.7a1 1 0 0 0-1.4 0L12 10.58l-3.3-3.3a1 1 0 0 0-1.4 1.42L10.58 12l-3.3 3.3a1 1 0 1 0 1.42 1.4L12 13.42l3.3 3.3a1 1 0 0 0 1.4-1.42L13.42 12l3.3-3.3a1 1 0 0 0 0-1.4Z" />
    </svg>
  )
}

function ReplyBar({ bar }: { bar: ComposerReplyBar }) {
  const activate = (fn: () => void) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn() }
  }
  return (
    <div className="d-stackedBars">
      <div className="replyBar" role="note" aria-label={`Replying to ${bar.authorName}`} onClick={bar.onJump}>
        <div className="replyBarText">
          Replying to <span className="replyBarName">{bar.authorName}</span>
        </div>
        <div className="replyBarActions">
          {bar.showMentionToggle && (
            <>
              <div
                className={`replyBarMention${bar.mention ? ' on' : ''}`}
                role="switch"
                aria-checked={bar.mention}
                aria-label="Mention"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); bar.onToggleMention() }}
                onKeyDown={activate(bar.onToggleMention)}
              >
                <ComposerAtIcon />
                {bar.mention ? 'On' : 'Off'}
              </div>
              <div className="replyBarSeparator" aria-hidden="true" />
            </>
          )}
          <div
            className="replyBarClose"
            role="button"
            aria-label="Cancel Reply"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); bar.onCancel() }}
            onKeyDown={activate(bar.onCancel)}
          >
            <ComposerCircleXIcon />
          </div>
        </div>
      </div>
    </div>
  )
}

export interface ComposerProps {
  /** Discord's "Replying to X" bar, stacked inside the text area; omit to hide. */
  replyBar?: ComposerReplyBar
  /** Mention autocomplete popup state; omit/undefined to hide the popup. */
  mentionAutocomplete?: ComposerMentionAutocomplete
  placeholder: string
  disabled: boolean
  sending: boolean
  canGifs: boolean
  canStickers: boolean
  locked: boolean
  /** True when the input holds any text - shows Discord's send button. */
  hasContent?: boolean
  /** Current input length (chars) - drives the near-limit counter. */
  charCount?: number
  /** Discord's message cap (2000). */
  maxLength?: number
  /** Show the remaining-chars counter within this many of the cap. */
  counterThreshold?: number
  onSubmit: (e?: React.FormEvent) => void
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void
  /** Fired on every input event with the contenteditable element (text mirror). */
  onInput?: (el: HTMLDivElement) => void
  /** Fired on paste; the handler sanitizes to plain text (no HTML injection). */
  onPaste?: (el: HTMLDivElement, e: ClipboardEvent<HTMLDivElement>) => void
  onOpenEmoji: () => void
  onOpenGifs: () => void
  onOpenStickers: () => void
  /** Display names of everyone currently typing (caller already filtered out). */
  typingNames?: string[]
}

/* Discord's typing indicator (typing_b88801 base_b88801 inTextChannel_b88801),
 * rendered INSIDE the form exactly like the live client: absolutely positioned
 * at top:-24px, i.e. in the 24px strip directly ABOVE the chat bar (the
 * visual-refresh placement), with the dots centered under the avatar column
 * and the text aligned with message content. Class names keep `typingDots`
 * (Discord's text wrapper) and `typers` so chat.tsx's context-menu hit test
 * still finds them. */
function TypingIndicator({ names }: { names: string[] }) {
  const active = names.length > 0
  return (
    <div className={`chat-typing${active ? ' visible' : ''}`} aria-live="polite">
      {active && (
        <div className="typingDots">
          <span className="chat-typingDotsInner" aria-hidden="true">
            <span className="chat-typingDot" />
            <span className="chat-typingDot" />
            <span className="chat-typingDot" />
          </span>
          <span className="typers">
            {names.length === 1 && <><strong>{names[0]}</strong> is typing...</>}
            {names.length === 2 && <><strong>{names[0]}</strong> and <strong>{names[1]}</strong> are typing...</>}
            {names.length === 3 && <><strong>{names[0]}</strong>, <strong>{names[1]}</strong>, and <strong>{names[2]}</strong> are typing...</>}
            {names.length >= 4 && <>Several people are typing...</>}
          </span>
        </div>
      )}
    </div>
  )
}

export const Composer = forwardRef<HTMLDivElement, ComposerProps>(function Composer(
  {
    replyBar,
    mentionAutocomplete,
    placeholder,
    disabled,
    sending,
    canGifs,
    canStickers,
    locked,
    hasContent = false,
    charCount = 0,
    maxLength = 2000,
    counterThreshold = 100,
    onSubmit,
    onKeyDown,
    onInput,
    onPaste,
    onOpenEmoji,
    onOpenGifs,
    onOpenStickers,
    typingNames = [],
  },
  inputRef,
) {
  // Obfuscate the composer action buttons' aria-label + title (tooltip). Hooks
  // must run before the early `locked` return, so they are declared here even
  // though the buttons render conditionally below.
  const gifAttr = useHolyAttr({ 'aria-label': 'Open GIF picker', title: 'Open GIF picker' })
  const stickerAttr = useHolyAttr({ 'aria-label': 'Open sticker picker', title: 'Open sticker picker' })
  const sendAttr = useHolyAttr({ 'aria-label': 'Send message', title: 'Send message' })
  const typingClass = typingNames.length > 0 ? ' isTyping' : ''
  if (locked) {
    return (
      <form className={`inputFields d-form${typingClass}`} onSubmit={onSubmit}>
        <TypingIndicator names={typingNames} />
        <div className="lockdownBar" role="note" aria-label="Channel locked">
          <ComposerCircleAlertIcon size={18} />
          <span><HolyText text="This channel is locked." /></span>
        </div>
      </form>
    )
  }

  // Discord's character counter: hidden until within threshold of the cap,
  // then shows the remaining count; over the cap it goes negative + red and
  // the send is blocked upstream (submit guards on the raw length).
  const remaining = maxLength - charCount
  const showCounter = remaining <= counterThreshold
  const overLimit = remaining < 0

  return (
    <form className={`inputFields d-form${typingClass}`} onSubmit={onSubmit}>
      <TypingIndicator names={typingNames} />
      {mentionAutocomplete && <MentionAutocompletePopup ac={mentionAutocomplete} />}
      <div className={`d-channelTextArea ${disabled ? 'd-channelTextAreaDisabled' : ''}`}>
        {replyBar && <ReplyBar bar={replyBar} />}
        <div className="d-scrollableContainer d-themedBackground">
          <div className="d-inner">
            {/* No attach (+) button: the bridge has no upload path, so the
                upload affordance is omitted rather than rendered dead. */}
            <div
              ref={inputRef}
              className={`d-textArea d-textAreaSlate msgInput ${disabled ? 'disabled' : ''}`}
              contentEditable={!disabled}
              role="textbox"
              aria-multiline="true"
              aria-label="Message input"
              aria-disabled={disabled}
              data-placeholder={placeholder}
              onKeyDown={onKeyDown}
              onInput={(e) => {
                const el = e.currentTarget
                // A contenteditable left with only a <br> after deleting all
                // text is NOT :empty, so the :empty::before placeholder never
                // reappears. Collapse an empty editor to real emptiness so the
                // placeholder returns immediately (safe: no caret content to
                // preserve when there's no text).
                if (!el.textContent && !el.querySelector('img, [data-token]')) el.innerHTML = ''
                onInput?.(el)
              }}
              onPaste={(e) => onPaste?.(e.currentTarget, e)}
            />
            {/* Discord renders .buttons EMPTY on a composer you can't send
                from (no SEND permission / timed out): no gif/sticker/emoji. */}
            <div className="d-buttons">
              {!disabled && <>
              {canGifs && (
                <div className="d-buttonContainer">
                  <button
                    ref={gifAttr.ref}
                    type="button"
                    className="d-button chat-composer-btn"
                    {...gifAttr.placeholder}
                    disabled={disabled}
                    onClick={onOpenGifs}
                  >
                    <ComposerGifIcon />
                  </button>
                </div>
              )}
              {canStickers && (
                <div className="d-buttonContainer">
                  <button
                    ref={stickerAttr.ref}
                    type="button"
                    className="d-button d-stickerButton chat-composer-btn"
                    {...stickerAttr.placeholder}
                    disabled={disabled}
                    onClick={onOpenStickers}
                  >
                    <ComposerStickerIcon />
                  </button>
                </div>
              )}
              <div className="d-buttonContainer">
                <EmojiSpriteButton onClick={onOpenEmoji} disabled={disabled} />
              </div>
              {/* Send button - Discord appends the paper-plane to the action row
                  once the input has content; it's a real submit so Enter and
                  click take the same path. Hidden (not disabled) while empty. */}
              {hasContent && (
                <div className="d-buttonContainer">
                  <button
                    ref={sendAttr.ref}
                    type="submit"
                    className="d-button chat-composer-btn chat-sendButton"
                    {...sendAttr.placeholder}
                    disabled={disabled || sending || overLimit}
                  >
                    {/* Discord's SendMessageIcon (paper plane), verbatim. */}
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path
                        fill="currentColor"
                        d="M6.6 10.02 14 11.4a.6.6 0 0 1 0 1.18L6.6 14l-2.94 5.87a1.48 1.48 0 0 0 1.99 1.98l17.03-8.52a1.48 1.48 0 0 0 0-2.64L5.65 2.16a1.48 1.48 0 0 0-1.99 1.98l2.94 5.88Z"
                      />
                    </svg>
                  </button>
                </div>
              )}
              </>}
            </div>
          </div>
        </div>
        {/* Discord's character counter - pinned to the composer's bottom-right
            (absolutely positioned against .d-channelTextArea so it never
            shrinks the text area), visible only near/over the cap; red when
            over. */}
        {showCounter && (
          <span
            className={`chat-charCounter ${overLimit ? 'overLimit' : ''}`}
            role="status"
            aria-label={`${remaining} characters remaining`}
          >
            {remaining}
          </span>
        )}
      </div>
      {/* Form-semantics fallback submit - Enter inside the contenteditable is
          intercepted by onKeyDown, so this stays for AT/form behavior only. */}
      <button type="submit" disabled={disabled || sending} aria-hidden="true" tabIndex={-1} style={{ display: 'none' }} />
    </form>
  )
})
