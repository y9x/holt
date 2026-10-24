import { useMemo } from 'react'
import { renderMarkdown } from './markdown'
import './codeblock.css'

// About Me / bio text, rendered with the same markdown pipeline as messages
// (Discord parses the bio with its message parser: markdown, links, line breaks).
// renderMarkdown escapes HTML first, so this is safe to inject.
// `bioMarkup` gives the output the message markup rules (codeblock.css, spoiler
// rules in chat.css) without a .content ancestor, so it also works on the account page.
export function BioText({ text, className }: { text: string; className: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  // Spoilers reveal on click / Enter / Space, as they do in messages.
  const toggleSpoiler = (e: { target: EventTarget; type: string; key?: string; preventDefault: () => void }) => {
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return
    const spoiler = (e.target as HTMLElement).closest?.('.spoiler')
    if (!spoiler) return
    e.preventDefault()
    spoiler.classList.toggle('revealed')
  }
  return (
    <div
      className={`${className} bioMarkup`}
      onClick={toggleSpoiler}
      onKeyDown={toggleSpoiler}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
