import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import type { BridgeMembersResult, BridgeMessage } from '../../lib/bridge'
import { EmojiSpriteButton } from './EmojiSpriteButton'
import { MentionAutocompletePopup, type MentionSuggestionItem } from './Composer'
import { allEmoji, type EmojiEntry } from './emoji-data'
import { recordEmojiUse } from './emoji-frecency'
import {
  hydrateComposer,
  insertEmojiChip,
  insertMentionChip,
  pastePlainText,
  replaceWithEmojiChip,
  serializeComposer,
  serializedCaretOffset,
} from './composerRich'
import { convertTypedShortcode, detectTrigger, mentionChipFor, type AutocompleteTrigger } from './richAutocomplete'

/* Discord's inline message editor (MessageEditor, lazy chunk 42834): the
 * message body is swapped for a ChannelTextArea of type EDIT followed by the
 * operations line - 1:1 with the client's DOM:
 *
 *   div (onContextMenu → stopPropagation: the row menu never opens on it)
 *     div.channelTextArea__74017.channelTextArea__5126c   (margin-top 8px)
 *       div.scrollableContainer.themedBackground          (50vh cap, scrolls)
 *         div.inner (sansAttachButton - EDIT has no upload)
 *           div.textArea.textAreaSlate                    (the rich slate)
 *           div.buttons → [emoji]                          (EDIT: emoji only)
 *     div.operations_bab751  "escape to <a>cancel</a> • enter to <a>save</a>"
 *
 * The slate is the same rich contenteditable as the composer (composerRich:
 * mention/emoji chips that serialize back to wire tokens) with the same
 * autocomplete (richAutocomplete: @ members/roles, # channels, :emoji:).
 * Enter saves, Shift+Enter is a newline, Escape cancels. Saving is delegated
 * to the owner: Discord's onSubmit turns an empty value into the delete
 * confirmation and an unchanged one into a plain exit. */

export interface MessageEditorHandle {
  /** Insert a picked emoji (the expression picker opened from this editor). */
  insertEmoji: (entry: EmojiEntry) => void
  focus: () => void
}

export interface MessageEditorProps {
  message: BridgeMessage
  compact: boolean
  saving: boolean
  maxLength: number
  counterThreshold: number
  /** Channel name for '<#id>' tokens the message's mentions don't resolve. */
  channelName: (id: string) => string | undefined
  /** Suggestion fetch for @/@&/# triggers (the composer's /members call). */
  fetchSuggestions: (query: string) => Promise<BridgeMembersResult>
  /** Same row builder the composer uses, so both lists are identical. */
  buildItems: (trigger: AutocompleteTrigger, suggestions: BridgeMembersResult | null) => MentionSuggestionItem[]
  onSave: (content: string) => void
  onCancel: () => void
  /** The emoji button: open the expression picker anchored to `anchor`. */
  onOpenEmoji: (anchor: HTMLElement) => void
  onMentionContext?: (item: MentionSuggestionItem, e: MouseEvent) => void
}

export const MessageEditor = forwardRef<MessageEditorHandle, MessageEditorProps>(function MessageEditor(
  { message, compact, saving, maxLength, counterThreshold, channelName, fetchSuggestions, buildItems, onSave, onCancel, onOpenEmoji, onMentionContext },
  ref,
) {
  const slateRef = useRef<HTMLDivElement>(null)
  const emojiBtnRef = useRef<HTMLDivElement>(null)
  const [length, setLength] = useState(message.content.length)
  const [trigger, setTrigger] = useState<AutocompleteTrigger | null>(null)
  const [suggestions, setSuggestions] = useState<BridgeMembersResult | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const fetchSeq = useRef(0)

  // Discord opens the editor with the message already rich (chips for
  // mentions/emoji), focused with the caret at the end.
  useLayoutEffect(() => {
    const el = slateRef.current
    if (!el) return
    hydrateComposer(el, message.content, { mentions: message.mentions, channelName, emoji: allEmoji })
    setLength(serializeComposer(el).length)
    // Only on (re)entering edit mode for this message.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.id])

  const placeCaretAtEnd = useCallback(() => {
    const el = slateRef.current
    if (!el) return
    el.focus({ preventScroll: true })
    const sel = window.getSelection()
    if (!sel) return
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    sel.removeAllRanges()
    sel.addRange(range)
  }, [])

  useLayoutEffect(() => { placeCaretAtEnd() }, [message.id, placeCaretAtEnd])

  const refreshLength = () => {
    const el = slateRef.current
    if (el) setLength(serializeComposer(el).length)
  }

  useImperativeHandle(ref, () => ({
    insertEmoji: (entry: EmojiEntry) => {
      const el = slateRef.current
      if (!el) return
      insertEmojiChip(el, entry)
      recordEmojiUse(entry[0])
      refreshLength()
    },
    focus: placeCaretAtEnd,
  }), [placeCaretAtEnd])

  // Debounced (~150ms) suggestion fetch - the composer's exact cadence. The
  // ':' emoji trigger is local (no request).
  useEffect(() => {
    if (!trigger || trigger.trigger === ':') { setSuggestions(null); return }
    const q = trigger.query
    const timer = setTimeout(() => {
      const seq = ++fetchSeq.current
      fetchSuggestions(q)
        .then((result) => { if (fetchSeq.current === seq) setSuggestions(result) })
        .catch(() => { if (fetchSeq.current === seq) setSuggestions({ members: [], roles: [], channels: [] }) })
    }, 150)
    return () => clearTimeout(timer)
  }, [trigger, fetchSuggestions])

  const items = useMemo(() => (trigger ? buildItems(trigger, suggestions) : []), [trigger, suggestions, buildItems])
  const itemsKey = items.map((i) => `${i.kind}:${i.id}`).join(',')
  useEffect(() => { setActiveIndex(0) }, [itemsKey])
  const popupOpen = trigger !== null && items.length > 0

  const closePopup = () => { setTrigger(null); setSuggestions(null) }

  const select = (index: number) => {
    const el = slateRef.current
    const item = items[index]
    if (!el || !trigger || !item) return
    const end = trigger.start + trigger.trigger.length + trigger.query.length
    if (item.kind === 'emoji' && item.emoji) {
      replaceWithEmojiChip(el, trigger.start, end, item.emoji)
      recordEmojiUse(item.emoji[0])
    } else {
      insertMentionChip(el, trigger.start, end, mentionChipFor(item))
    }
    refreshLength()
    closePopup()
  }

  const submit = () => {
    const el = slateRef.current
    if (!el || saving) return
    onSave(serializeComposer(el))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return
    if (popupOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex((i) => (i + 1) % items.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((i) => (i - 1 + items.length) % items.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); select(activeIndex); return }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePopup(); return }
    }
    // Discord's EDIT onKeyDown: Escape (without Shift) cancels.
    if (e.key === 'Escape' && !e.shiftKey) {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const remaining = maxLength - length
  const showCounter = remaining <= counterThreshold
  const overLimit = remaining < 0

  return (
    <div
      className={`chat-messageEditor${compact ? ' chat-messageEditorCompact' : ''}`}
      // Discord's editor wrapper stops contextmenu propagation so the message
      // row menu never opens over the text area (the page-level text-input
      // menu still runs in the capture phase).
      onContextMenu={(e) => e.stopPropagation()}
    >
      {popupOpen && (
        <MentionAutocompletePopup
          className="chat-editAutocomplete"
          ac={{
            items,
            activeIndex,
            query: trigger?.query,
            onSelect: select,
            onHover: setActiveIndex,
            onContext: onMentionContext ? (index, e) => onMentionContext(items[index], e) : undefined,
          }}
        />
      )}
      <div className="d-channelTextArea chat-editTextArea">
        <div className="d-scrollableContainer d-themedBackground">
          <div className="d-inner">
            <div
              ref={slateRef}
              className="d-textArea d-textAreaSlate msgInput chat-editInput"
              contentEditable
              suppressContentEditableWarning
              role="textbox"
              aria-multiline="true"
              aria-label="Edit message"
              spellCheck
              onKeyDown={onKeyDown}
              onInput={(e) => {
                const el = e.currentTarget
                if (!el.textContent && !el.querySelector('img, [data-token]')) el.innerHTML = ''
                convertTypedShortcode(el)
                const text = serializeComposer(el)
                setLength(text.length)
                setTrigger(detectTrigger(text, serializedCaretOffset(el) ?? text.length))
              }}
              onPaste={(e) => {
                pastePlainText(e.nativeEvent, e.currentTarget)
                refreshLength()
              }}
              onBlur={() => setTrigger(null)}
            />
            <div className="d-buttons">
              <div className="d-buttonContainer" ref={emojiBtnRef}>
                <EmojiSpriteButton
                  onClick={() => { if (emojiBtnRef.current) onOpenEmoji(emojiBtnRef.current) }}
                  disabled={saving}
                />
              </div>
            </div>
          </div>
        </div>
        {showCounter && (
          <span className={`chat-charCounter ${overLimit ? 'overLimit' : ''}`} role="status" aria-label={`${remaining} characters remaining`}>
            {remaining}
          </span>
        )}
      </div>
      {/* operations_bab751 - en-US wDsPXs: "escape to {cancel} • enter to
          {save}", both $link anchors (--text-link, underline on hover). */}
      <div className="chat-editOperations">
        escape to{' '}
        <a role="button" tabIndex={0} onClick={onCancel} onKeyDown={(e) => { if (e.key === 'Enter') onCancel() }}>cancel</a>
        {' • '}enter to{' '}
        <a role="button" tabIndex={0} onClick={submit} onKeyDown={(e) => { if (e.key === 'Enter') submit() }}>save</a>
      </div>
    </div>
  )
})
