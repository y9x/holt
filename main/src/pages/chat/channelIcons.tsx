/* Discord's guild-channel glyphs, ripped verbatim from the web bundle
 * (web.d3978f1210c00a8f.js) - never hand-drawn:
 *   TextIcon           (module 276293) - the open-center hash; evenodd so the
 *                       inner square stays a hole.
 *   AnnouncementsIcon  (module 778492) - megaphone body (evenodd) + the small
 *                       mouthpiece rect, two paths.
 *   BookCheckIcon      (module 622629) - the guild's rules channel.
 * Discord's channel-icon resolver (getChannelIconComponent) checks
 * `channel.id === guild.rulesChannelId` FIRST (→ BookCheckIcon), then switches
 * on type: GUILD_ANNOUNCEMENT (5) → AnnouncementsIcon, GUILD_TEXT (0) →
 * TextIcon, GUILD_FORUM (15) → ForumIcon (module 56059 export b), GUILD_MEDIA
 * (16) → ImageIcon (module 191023). A forum post (thread) row/header uses
 * ChatIcon. NSFW / private (lock) variants need channel flags the bridge does
 * not expose, so they're not rendered. */

import { escapeHtml } from './markdown'

export const TEXT_ICON_PATH = 'M10.99 3.16A1 1 0 1 0 9 2.84L8.15 8H4a1 1 0 0 0 0 2h3.82l-.67 4H3a1 1 0 1 0 0 2h3.82l-.8 4.84a1 1 0 0 0 1.97.32L8.85 16h4.97l-.8 4.84a1 1 0 0 0 1.97.32l.86-5.16H20a1 1 0 1 0 0-2h-3.82l.67-4H21a1 1 0 1 0 0-2h-3.82l.8-4.84a1 1 0 1 0-1.97-.32L15.15 8h-4.97l.8-4.84ZM14.15 14l.67-4H9.85l-.67 4h4.97Z'
export const ANNOUNCEMENTS_ICON_PATHS = [
  'M19.56 2a3 3 0 0 0-2.46 1.28 3.85 3.85 0 0 1-1.86 1.42l-8.9 3.18a.5.5 0 0 0-.34.47v10.09a3 3 0 0 0 2.27 2.9l.62.16c1.57.4 3.15-.56 3.55-2.12a.92.92 0 0 1 1.23-.63l2.36.94c.42.27.79.62 1.07 1.03A3 3 0 0 0 19.56 22h.94c.83 0 1.5-.67 1.5-1.5v-17c0-.83-.67-1.5-1.5-1.5h-.94Zm-8.53 15.8L8 16.7v1.73a1 1 0 0 0 .76.97l.62.15c.5.13 1-.17 1.12-.67.1-.41.29-.78.53-1.1Z',
  'M2 10c0-1.1.9-2 2-2h.5c.28 0 .5.22.5.5v7a.5.5 0 0 1-.5.5H4a2 2 0 0 1-2-2v-4Z',
] as const
export const BOOK_CHECK_ICON_PATH = 'M15 2a3 3 0 0 1 3 3v12H5.5a1.5 1.5 0 0 0 0 3h14a.5.5 0 0 0 .5-.5V5h1a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H5a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3h10Zm-.3 5.7a1 1 0 0 0-1.4-1.4L9 10.58l-2.3-2.3a1 1 0 0 0-1.4 1.42l3 3a1 1 0 0 0 1.4 0l5-5Z'

// ForumIcon (module 56059, export b): two paths, no fill-rule.
export const FORUM_ICON_PATHS = [
  'M18.91 12.98a5.45 5.45 0 0 1 2.18 6.2c-.1.33-.09.68.1.96l.83 1.32a1 1 0 0 1-.84 1.54h-5.5A5.6 5.6 0 0 1 10 17.5a5.6 5.6 0 0 1 5.68-5.5c1.2 0 2.32.36 3.23.98Z',
  'M19.24 10.86c.32.16.72-.02.74-.38L20 10c0-4.42-4.03-8-9-8s-9 3.58-9 8c0 1.5.47 2.91 1.28 4.11.14.21.12.49-.06.67l-1.51 1.51A1 1 0 0 0 2.4 18h5.1a.5.5 0 0 0 .49-.5c0-4.2 3.5-7.5 7.68-7.5 1.28 0 2.5.3 3.56.86Z',
] as const
// ImageIcon (module 191023) - Discord's media-channel glyph.
export const IMAGE_ICON_PATH = 'M2 5a3 3 0 0 1 3-3h14a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V5Zm13.35 8.13 3.5 4.67c.37.5.02 1.2-.6 1.2H5.81a.75.75 0 0 1-.59-1.22l1.86-2.32a1.5 1.5 0 0 1 2.34 0l.5.64 2.23-2.97a2 2 0 0 1 3.2 0ZM10.2 5.98c.23-.91-.88-1.55-1.55-.9a.93.93 0 0 1-1.3 0c-.67-.65-1.78-.01-1.55.9a.93.93 0 0 1-.65 1.12c-.9.26-.9 1.54 0 1.8.48.14.77.63.65 1.12-.23.91.88 1.55 1.55.9a.93.93 0 0 1 1.3 0c.67.65 1.78.01 1.55-.9a.93.93 0 0 1 .65-1.12c.9-.26.9-1.54 0-1.8a.93.93 0 0 1-.65-1.12Z'
// ChatIcon - forum posts (thread rows, post headers, message counts).
export const CHAT_ICON_PATH = 'M12 22a10 10 0 1 0-8.45-4.64c.13.19.11.44-.04.61l-2.06 2.37A1 1 0 0 0 2.2 22H12Z'

export type ChannelIconKind = 'text' | 'announcement' | 'rules' | 'forum' | 'media' | 'post'

/** Discord's resolver order: rules channel first, then channel type. */
export function channelIconKind(type: number | undefined, isRules = false): ChannelIconKind {
  if (isRules) return 'rules'
  if (type === 15) return 'forum'
  if (type === 16) return 'media'
  if (type === 11 || type === 12) return 'post'
  return type === 5 ? 'announcement' : 'text'
}

/** Inner <path> markup for a channel glyph (24×24 viewBox, currentColor). */
function ChannelIconPaths({ kind }: { kind: ChannelIconKind }) {
  if (kind === 'announcement') {
    return (
      <>
        <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d={ANNOUNCEMENTS_ICON_PATHS[0]} />
        <path fill="currentColor" d={ANNOUNCEMENTS_ICON_PATHS[1]} />
      </>
    )
  }
  if (kind === 'rules') return <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d={BOOK_CHECK_ICON_PATH} />
  if (kind === 'forum') return <><path fill="currentColor" d={FORUM_ICON_PATHS[0]} /><path fill="currentColor" d={FORUM_ICON_PATHS[1]} /></>
  if (kind === 'media') return <path fill="currentColor" d={IMAGE_ICON_PATH} />
  if (kind === 'post') return <path fill="currentColor" d={CHAT_ICON_PATH} />
  return <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d={TEXT_ICON_PATH} />
}

export function ChannelTypeIcon({ kind, size = 20, className }: { kind: ChannelIconKind; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" role="img" className={className}>
      <ChannelIconPaths kind={kind} />
    </svg>
  )
}

/** Static-HTML twin for the message-content mention pipeline (innerHTML). */
export function channelIconSvgHtml(kind: ChannelIconKind, className: string): string {
  const paths = kind === 'announcement'
    ? `<path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="${ANNOUNCEMENTS_ICON_PATHS[0]}"></path><path fill="currentColor" d="${ANNOUNCEMENTS_ICON_PATHS[1]}"></path>`
    : kind === 'rules'
      ? `<path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="${BOOK_CHECK_ICON_PATH}"></path>`
      : kind === 'forum'
        ? `<path fill="currentColor" d="${FORUM_ICON_PATHS[0]}"></path><path fill="currentColor" d="${FORUM_ICON_PATHS[1]}"></path>`
        : kind === 'media'
          ? `<path fill="currentColor" d="${IMAGE_ICON_PATH}"></path>`
          : kind === 'post'
            ? `<path fill="currentColor" d="${CHAT_ICON_PATH}"></path>`
            : `<path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="${TEXT_ICON_PATH}"></path>`
  // className lands in a double-quoted attribute of injected innerHTML; escape
  // it so a caller-supplied value can't break out of the attribute context.
  return `<svg class="${escapeHtml(className)}" aria-hidden="true" role="img" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24">${paths}</svg>`
}
