// Discord's channel-header message search, ported 1:1 from the live web
// client (web.d3978f1210c00a8f.js + its lazy "Search" chunk group):
//
// - SearchBar  - module 239793 (`Search`): a single-line rich editor whose
//   plain-text query is tokenized on every change (searchTokens.ts). Filter
//   tokens (`from:`) and their answers (` username`) are decorated in place as
//   `searchFilter` / `searchAnswer` pills - the text itself stays
//   "from: username", exactly like Discord's Slate `decorate`. Backspace /
//   Delete on a non-mutable token (every filter, has:/authorType: answers)
//   removes the whole token (Discord's deleteBackward override).
// - Popout     - the search autocomplete (modes EMPTY / FILTER / FILTER_ALL):
//   "Filters" rows with "More filters", "History" (5 most recent, trash to
//   clear), "From User" / "Mentions User" / "In Channel" / "Message Contains"
//   suggestion groups, "Search for …" row, a calendar for date filters.
//   Arrow keys move the selection (wraps), Enter accepts it (or searches),
//   Escape clears the query (then blurs when already empty).
// - SearchResults - module 320704: `searchResultsWrap` sidebar with the
//   "N Results" / "Searching…" header, Filters + Sort buttons, results grouped
//   by channel (module 187654), hover "Jump", page-limit warning and the
//   5-page paginator (modules 876689 / 932793), empty + error art.
// - FiltersModal - module 561965 ("Filters": From / In / Has / Mentions /
//   Date / Author Type, Clear Filters, Cancel, Apply Filters).
//
// Searches are debounced 500 ms like Discord's fetchMessages. A 429 from the
// server is waited out + retried by the shared rate-limit queue
// (lib/rate-limit-queue.ts, Discord's HTTP client behavior), so the UI simply
// stays on "Searching…"; aborting cancels the wait too.

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type SyntheticEvent } from 'react'
import { HolyInput } from '../../components/common/HolyAttr'
import { createPortal } from 'react-dom'
import {
  bridgeMembers,
  bridgeSearch,
  type BridgeChannel,
  type BridgeMemberSuggestion,
  type BridgeMessage,
  type BridgeSearchResult,
  type BridgeSearchSort,
} from '../../lib/bridge'
import { ChannelTypeIcon, TEXT_ICON_PATH, type ChannelIconKind } from './channelIcons'
import { ContextMenu } from './ContextMenu'
import { Popout } from './popout'
import { DiscordSelect, SelectChevronIcon, SelectListBox, SelectPopout, useListNavigation, type SelectOption } from './DiscordSelect'
import {
  AUTHOR_TYPE_VALUES,
  HAS_VALUES,
  RULE,
  autocompleteMode,
  buildQuery,
  cleanQueryString,
  cursorScope,
  filterCount,
  fuzzy,
  highlightStems,
  isAnswer,
  isDateFilter,
  isFilter,
  nonFilterText,
  queryIsEmpty,
  quoteAnswer,
  rememberUser,
  resolveDate,
  searchChannels,
  setSearchChannels,
  tokenCounts,
  tokenize,
  userById,
  wordMatches,
  type FilterType,
  type KnownUser,
  type Mode,
} from './searchTokens'
import './search.css'

export const SEARCH_PAGE_SIZE = 25          // Discord T_y
const MAX_OFFSET = 9975                     // Discord's search offset ceiling
const HISTORY_KEY = 'abulxt:chat-search-history'
const HISTORY_MAX = 5
const MAX_QUERY = 512
const MIN_DATE = new Date(2015, 4, 15)

// ---- Discord strings (en-US intl bundle) ------------------------------------
const S = {
  search: 'Search',
  searchIn: (name: string) => `Search ${name}`,
  filters: 'Filters',
  filtersN: (n: number) => `Filters (${n})`,
  history: 'History',
  clearHistory: 'Clear Search History',
  fromUser: 'From User',
  mentionsUser: 'Mentions User',
  inChannel: 'In Channel',
  messageContains: 'Message Contains',
  fromSpecific: 'From a specific user',
  inSpecific: 'Sent in a specific channel',
  hasSpecific: 'Includes a specific type of data',
  mentionsSpecific: 'Mentions a specific user',
  moreFilters: 'More filters',
  moreFiltersSub: 'dates, author type, and more',
  addSearchFilters: 'Add search filters',
  searchFor: 'Search for ',
  userHint: 'user',
  hasHint: 'link, embed or file',
  channelHint: 'channel',
  dateHint: 'specific date',
  authorTypeHint: 'user, bot or webhook',
  results: (n: number) => (n === 0 ? 'No Results' : n === 1 ? '1 Result' : `${n.toLocaleString()} Results`),
  searching: 'Searching…',
  sort: 'Sort',
  newest: 'Newest',
  oldest: 'Oldest',
  mostRelevant: 'Most Relevant',
  sortActions: 'Search Result Sort Actions',
  searchResults: 'Search Results',
  noResults: 'We searched far and wide. Unfortunately, no results were found.',
  error: 'We dropped the magnifying glass. Can you try searching again?',
  maxPages: (n: number) => `We can only return up to ${n} pages of results. Try making your search more specific!`,
  jump: 'Jump',
  previous: 'Previous',
  next: 'Next',
  page: (n: number) => `Page ${n}`,
  nextMonth: 'Next month',
  previousMonth: 'Previous month',
  // Filters modal
  from: 'From',
  fromSub: 'Sent by any of the selected users',
  inLabel: 'In',
  inSub: 'Sent in any of the selected channels',
  has: 'Has',
  hasSub: 'Includes any of the selected types of data',
  anyContent: 'Any content',
  mentions: 'Mentions',
  mentionsSub: 'Mentions any of the selected users',
  date: 'Date',
  dateSub: 'When the message was sent',
  addDate: 'Add date',
  before: 'Before',
  after: 'After',
  during: 'During',
  changeDateType: 'Change date filter type',
  selectDate: 'Select a date',
  removeDate: (n: number) => `Remove date filter ${n}`,
  authorType: 'Author Type',
  authorTypeSub: 'Sent by any of the selected types of author',
  exBot: 'ex. Bot',
  ex: (s: string) => `ex. ${s}`,
  clearFilters: 'Clear Filters',
  cancel: 'Cancel',
  applyFilters: 'Apply Filters',
}

// ---- Discord icons (paths ripped from the bundle modules noted) -------------
type IconProps = { size?: number; className?: string }
function Svg({ size = 24, className, paths, evenodd }: IconProps & { paths: string[]; evenodd?: boolean }) {
  return (
    <svg className={className} aria-hidden="true" role="img" width={size} height={size} fill="none" viewBox="0 0 24 24">
      {paths.map((d, i) => <path key={i} fill="currentColor" fillRule={evenodd ? 'evenodd' : undefined} clipRule={evenodd ? 'evenodd' : undefined} d={d} />)}
    </svg>
  )
}
const P = {
  magnifier: ['M15.62 17.03a9 9 0 1 1 1.41-1.41l4.68 4.67a1 1 0 0 1-1.42 1.42l-4.67-4.68ZM17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z'], // 7689
  clear: ['M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z'],
  user: ['M12 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM11.53 11A9.53 9.53 0 0 0 2 20.53c0 .81.66 1.47 1.47 1.47h.22c.24 0 .44-.17.5-.4.29-1.12.84-2.17 1.32-2.91.14-.21.43-.1.4.15l-.26 2.61c-.02.3.2.55.5.55h11.7a.5.5 0 0 0 .5-.55l-.27-2.6c-.02-.26.27-.37.41-.16.48.74 1.03 1.8 1.32 2.9.06.24.26.41.5.41h.22c.81 0 1.47-.66 1.47-1.47A9.53 9.53 0 0 0 12.47 11h-.94Z'], // 950305
  paperclip: ['M10.57 4.01a6.97 6.97 0 0 1 9.86 0l.54.55a6.99 6.99 0 0 1 0 9.88l-7.26 7.27a1 1 0 0 1-1.42-1.42l7.27-7.26a4.99 4.99 0 0 0 0-7.06L19 5.43a4.97 4.97 0 0 0-7.02 0l-8.02 8.02a3.24 3.24 0 1 0 4.58 4.58l6.24-6.24a1.12 1.12 0 0 0-1.58-1.58l-3.5 3.5a1 1 0 0 1-1.42-1.42l3.5-3.5a3.12 3.12 0 1 1 4.42 4.42l-6.24 6.24a5.24 5.24 0 0 1-7.42-7.42l8.02-8.02Z'], // 588975
  at: ['M16.44 6.96c.29 0 .51.25.47.54l-.82 6.34c-.02.08-.03.2-.03.34 0 .71.28 1.07.85 1.07.49 0 .94-.21 1.36-.63.43-.42.77-1 1.02-1.72.26-.75.38-1.57.38-2.48 0-1.35-.29-2.54-.87-3.56a5.92 5.92 0 0 0-2.45-2.35 7.68 7.68 0 0 0-3.61-.83c-1.55 0-2.96.37-4.22 1.1a7.66 7.66 0 0 0-2.96 3.07 9.53 9.53 0 0 0-1.09 4.66c0 1.45.26 2.77.78 3.95a6.3 6.3 0 0 0 2.47 2.81 8.3 8.3 0 0 0 4.36 1.05 12.43 12.43 0 0 0 5.35-1.18.5.5 0 0 1 .7.24l.46 1.07c.1.22.02.47-.19.59-.77.43-1.69.77-2.75 1.02-1.23.3-2.48.44-3.76.44-2.18 0-4-.44-5.48-1.33a8.1 8.1 0 0 1-3.27-3.57 11.93 11.93 0 0 1-1.07-5.12c0-2.24.47-4.19 1.4-5.84a9.7 9.7 0 0 1 3.86-3.8c1.62-.9 3.4-1.34 5.36-1.34 1.8 0 3.4.37 4.8 1.12 1.4.72 2.5 1.76 3.28 3.1a8.86 8.86 0 0 1 1.16 4.56c0 1.36-.23 2.57-.7 3.64a5.81 5.81 0 0 1-1.92 2.47c-.82.58-1.76.87-2.81.87a2.4 2.4 0 0 1-1.6-.5c-.4-.35-.65-.78-.73-1.32-.3.55-.74 1-1.36 1.34a4.3 4.3 0 0 1-2.03.48A3.4 3.4 0 0 1 8 16C7.33 15.16 7 14 7 12.5c0-1.14.2-2.16.6-3.05.43-.89 1-1.57 1.73-2.06a4.3 4.3 0 0 1 4.27-.31c.47.29.82.68 1.07 1.16l.3-.95c.06-.2.25-.33.46-.33h1.02Zm-5.06 8.24c.8 0 1.45-.35 1.97-1.04.51-.7.77-1.6.77-2.7 0-.88-.18-1.56-.53-2.03a1.76 1.76 0 0 0-1.5-.73c-.8 0-1.45.35-1.97 1.04a4.28 4.28 0 0 0-.78 2.67c0 .9.17 1.58.51 2.06.36.49.87.73 1.53.73Z'], // 935063
  filters: ['M22 5a1 1 0 0 1-1 1h-8.2a2.5 2.5 0 1 1 0-2H21a1 1 0 0 1 1 1ZM6 5c0 .34.04.67.11 1H3a1 1 0 0 1 0-2h3.11A4.5 4.5 0 0 0 6 5ZM22 19a1 1 0 0 1-1 1h-8.2a2.5 2.5 0 1 1 0-2H21a1 1 0 0 1 1 1ZM6 19c0 .34.04.67.11 1H3a1 1 0 1 1 0-2h3.11A4.5 4.5 0 0 0 6 19ZM21 13a1 1 0 1 0 0-2h-3.2a2.5 2.5 0 1 0 0 2H21ZM11.11 13a4.5 4.5 0 0 1 0-2H3a1 1 0 1 0 0 2h8.11Z'], // 783977
  sort: ['M16.3 21.7a1 1 0 0 0 1.4 0l4-4a1 1 0 0 0-1.4-1.4L18 18.58V3a1 1 0 1 0-2 0v15.59l-2.3-2.3a1 1 0 0 0-1.4 1.42l4 4ZM6.3 2.3a1 1 0 0 1 1.4 0l4 4a1 1 0 0 1-1.4 1.4L8 5.42V21a1 1 0 1 1-2 0V5.41l-2.3 2.3a1 1 0 0 1-1.4-1.42l4-4Z'], // 112173
  trash: ['M14.25 1c.41 0 .75.34.75.75V3h5.25c.41 0 .75.34.75.75v.5c0 .41-.34.75-.75.75H3.75A.75.75 0 0 1 3 4.25v-.5c0-.41.34-.75.75-.75H9V1.75c0-.41.34-.75.75-.75h4.5Z', 'M5.06 7a1 1 0 0 0-1 1.06l.76 12.13a3 3 0 0 0 3 2.81h8.36a3 3 0 0 0 3-2.81l.75-12.13a1 1 0 0 0-1-1.06H5.07ZM11 12a1 1 0 1 0-2 0v6a1 1 0 1 0 2 0v-6Zm3-1a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1Z'], // 241326
  chevronLeft: ['M14.7 5.3a1 1 0 0 1 0 1.4L9.42 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0Z'], // 921853
  chevronRight: ['M9.3 5.3a1 1 0 0 0 0 1.4l5.29 5.3-5.3 5.3a1 1 0 1 0 1.42 1.4l6-6a1 1 0 0 0 0-1.4l-6-6a1 1 0 0 0-1.42 0Z'], // 320448
  plus: ['M13 5a1 1 0 1 0-2 0v6H5a1 1 0 1 0 0 2h6v6a1 1 0 1 0 2 0v-6h6a1 1 0 1 0 0-2h-6V5Z'],
  link: ['M16.32 14.72a1 1 0 0 1 0-1.41l2.51-2.51a3.98 3.98 0 0 0-5.62-5.63l-2.52 2.51a1 1 0 0 1-1.41-1.41l2.52-2.52a5.98 5.98 0 0 1 8.45 8.46l-2.52 2.51a1 1 0 0 1-1.41 0ZM7.68 9.29a1 1 0 0 1 0 1.41l-2.52 2.51a3.98 3.98 0 1 0 5.63 5.63l2.51-2.52a1 1 0 0 1 1.42 1.42l-2.52 2.51a5.98 5.98 0 0 1-8.45-8.45l2.51-2.51a1 1 0 0 1 1.42 0Z', 'M14.7 10.7a1 1 0 0 0-1.4-1.4l-4 4a1 1 0 1 0 1.4 1.4l4-4Z'], // 173936
  embed: ['M9.5 11.87a1 1 0 0 1 1.55-.83l3.2 2.13a1 1 0 0 1 0 1.66l-3.2 2.13a1 1 0 0 1-1.55-.83v-4.26Z', 'M5 2a3 3 0 0 0-3 3v14a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V5a3 3 0 0 0-3-3H5Zm2 7a2 2 0 0 0-2 2v6c0 1.1.9 2 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H7ZM5 6a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1Z'], // 11023
  file: ['M18 22H6a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4h7.5c.28 0 .5.22.5.5V5a5 5 0 0 0 5 5h2.5c.28 0 .5.22.5.5V18a4 4 0 0 1-4 4Z', 'M21.7 7.94c.01.03 0 .06-.04.06H19a3 3 0 0 1-3-3V2.34c0-.03.03-.05.06-.04a3 3 0 0 1 .82.58l4.24 4.24a3 3 0 0 1 .58.82Z'], // 514042
  video: ['M4 4a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h11a3 3 0 0 0 3-3v-2.12a1 1 0 0 0 .55.9l3 1.5a1 1 0 0 0 1.45-.9V7.62a1 1 0 0 0-1.45-.9l-3 1.5a1 1 0 0 0-.55.9V7a3 3 0 0 0-3-3H4Z'], // 428689
  image: ['M2 5a3 3 0 0 1 3-3h14a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V5Zm13.35 8.13 3.5 4.67c.37.5.02 1.2-.6 1.2H5.81a.75.75 0 0 1-.59-1.22l1.86-2.32a1.5 1.5 0 0 1 2.34 0l.5.64 2.23-2.97a2 2 0 0 1 3.2 0ZM10.2 5.98c.23-.91-.88-1.55-1.55-.9a.93.93 0 0 1-1.3 0c-.67-.65-1.78-.01-1.55.9a.93.93 0 0 1-.65 1.12c-.9.26-.9 1.54 0 1.8.48.14.77.63.65 1.12-.23.91.88 1.55 1.55.9a.93.93 0 0 1 1.3 0c.67.65 1.78.01 1.55-.9a.93.93 0 0 1 .65-1.12c.9-.26.9-1.54 0-1.8a.93.93 0 0 1-.65-1.12Z'], // 191023
  sound: ['M14.24 1.03a1 1 0 0 1 .73 1.21l-1 4a1 1 0 1 1-1.94-.48l1-4a1 1 0 0 1 1.21-.73ZM20.7 4.7a1 1 0 0 0-1.4-1.4l-4 4a1 1 0 0 0 1.4 1.4l4-4Z', 'M15.14 20.14c1.78-1.78.7-5.75-2.42-8.86-3.11-3.12-7.08-4.2-8.86-2.42A3.13 3.13 0 0 0 3 11V11l-1.16 8.92a2 2 0 0 0 2.24 2.24L13 21c.86-.04 1.6-.32 2.14-.86Zm-1.3-3.4a9.61 9.61 0 0 0-2.53-4.05 9.61 9.61 0 0 0-4.05-2.53c-1.27-.35-1.82-.05-1.99.11-.16.17-.46.72-.11 2a9.61 9.61 0 0 0 2.53 4.04 9.61 9.61 0 0 0 4.05 2.53c1.27.35 1.82.05 1.99-.11.16-.17.46-.72.11-2Z', 'M7.05 3.32a1 1 0 0 1 1.9-.64l1 3a1 1 0 0 1-1.9.64l-1-3ZM22.97 9.76a1 1 0 0 0-1.21-.73l-4 1a1 1 0 1 0 .48 1.94l4-1a1 1 0 0 0 .73-1.21ZM20.68 16.95a1 1 0 0 0 .64-1.9l-3-1a1 1 0 0 0-.64 1.9l3 1Z'], // 7807
  forward: ['M21.7 7.3a1 1 0 0 1 0 1.4l-5 5a1 1 0 0 1-1.4-1.4L18.58 9H13a7 7 0 0 0-7 7v4a1 1 0 1 1-2 0v-4a9 9 0 0 1 9-9h5.59l-3.3-3.3a1 1 0 0 1 1.42-1.4l5 5Z'], // 292801
  robot: ['M7.89 13.46a1 1 0 0 1-1.78-.9L7 13l-.9-.45.01-.01.01-.02a2.24 2.24 0 0 1 .14-.23c.1-.14.23-.31.4-.5.37-.36.98-.79 1.84-.79.86 0 1.47.43 1.83.8a3.28 3.28 0 0 1 .55.72v.02h.01v.01L10 13l.9-.45a1 1 0 0 1-1.79.9 1.28 1.28 0 0 0-.19-.25c-.14-.13-.28-.2-.42-.2-.14 0-.28.07-.42.2a1.28 1.28 0 0 0-.19.25ZM13.55 13.9a1 1 0 0 0 1.34-.44c0-.02.02-.04.04-.06.03-.05.08-.13.15-.2.14-.13.28-.2.42-.2.14 0 .28.07.42.2a1.28 1.28 0 0 1 .19.25 1 1 0 0 0 1.78-.9L17 13l.9-.45-.01-.01-.01-.02a2.1 2.1 0 0 0-.14-.23 3.28 3.28 0 0 0-.4-.5c-.37-.36-.98-.79-1.84-.79-.86 0-1.47.43-1.83.8a3.28 3.28 0 0 0-.55.72v.02h-.01v.01L14 13l-.9-.45a1 1 0 0 0 .45 1.34Z', 'M12 21c5.52 0 10-1.86 10-6 0-5.59-2.8-10.07-4.26-11.67a1 1 0 1 0-1.48 1.34 14.8 14.8 0 0 1 2.35 3.86A10.23 10.23 0 0 0 12 6C9.47 6 7.15 7.02 5.4 8.53a14.8 14.8 0 0 1 2.34-3.86 1 1 0 1 0-1.48-1.34A18.65 18.65 0 0 0 2 15c0 4.14 4.48 6 10 6Zm0-12c3.87 0 7 2 7 4.2S15.87 17 12 17s-7-1.6-7-3.8C5 11 8.13 9 12 9Z'], // 430392
  webhook: ['m7.7 16.95 3.68-6.76a1 1 0 0 0-.5-1.4A3 3 0 1 1 15 6a1 1 0 1 0 2 0 5 5 0 1 0-7.85 4.1L5.95 16a2 2 0 1 0 1.78 3h8.54a2 2 0 1 0 0-2H7.73l-.02-.05Z', 'M13.8 6.86A2 2 0 1 0 12.16 8l4.53 6.58a1 1 0 0 0 .82.43h.5a3 3 0 1 1-1.98 5.25 1 1 0 0 0-.66-.25h-.01a1 1 0 0 0-.66 1.75A4.98 4.98 0 0 0 23 18a5 5 0 0 0-4.97-5L13.8 6.86ZM5.97 13.88a1 1 0 0 1-.72 1.21 3 3 0 1 0 2.73 5.16 1 1 0 1 1 1.33 1.5A4.98 4.98 0 0 1 1 18a5 5 0 0 1 3.75-4.84 1 1 0 0 1 1.22.72Z'], // 39619
}
const HAS_ICON: Record<string, string[]> = { link: P.link, embed: P.embed, file: P.file, video: P.video, image: P.image, sound: P.sound, forward: P.forward }
const AUTHOR_ICON: Record<string, string[]> = { user: P.user, bot: P.robot, webhook: P.webhook }

function hasIcon(text: string, size = 18, className?: string) {
  const v = text.replace(/^-/, '').toLowerCase()
  const p = HAS_ICON[v]
  return p ? <Svg size={size} className={className} paths={p} evenodd /> : null
}
function authorIcon(text: string, size = 18, className?: string) {
  const p = AUTHOR_ICON[text.replace(/^-/, '').toLowerCase()]
  return p ? <Svg size={size} className={className} paths={p} evenodd /> : null
}

function Avatar({ src, size, className }: { src: string | null | undefined; size: number; className?: string }) {
  return <img className={`chatSearchAvatar ${className || ''}`} src={src || undefined} alt="" aria-hidden="true" width={size} height={size} style={{ width: size, height: size }} />
}

// ---- history (SearchHistoryStore: 5 entries, dedupe, prefix-merge) -----------

function loadHistory(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((q) => typeof q === 'string' && q.trim() !== '').slice(0, HISTORY_MAX) : []
  } catch { return [] }
}
function saveHistory(list: string[]) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)) } catch { /* storage blocked */ }
}
function addHistory(list: string[], q: string): string[] {
  q = q.trim()
  if (!q) return list
  const r = [...list]
  const i = r.indexOf(q)
  if (i !== -1) { r.splice(i, 1); r.unshift(q) } else if (r[0] && q.startsWith(r[0])) r[0] = q
  else r.unshift(q)
  return r.slice(0, HISTORY_MAX)
}

// ---- state hook --------------------------------------------------------------

export type SortMode = 'newest' | 'oldest' | 'relevance'

interface ResultsState {
  queryString: string
  page: number
  sort: SortMode
  status: 'loading' | 'done' | 'error'
  data: BridgeSearchResult | null
}

/** `guildId`: the open server; searches are limited to its channels (read
 *  through a ref so a guild switch doesn't recreate the callbacks - chat.tsx
 *  clears the search on switch). */
export function useChannelSearch(guildId: string | null = null) {
  const guildRef = useRef(guildId)
  guildRef.current = guildId
  const [text, setText] = useState('')
  const [results, setResults] = useState<ResultsState | null>(null)
  const [history, setHistory] = useState<string[]>(() => loadHistory())
  const [filtersOpen, setFiltersOpen] = useState(false)
  const timerRef = useRef<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const seqRef = useRef(0)

  const cancel = useCallback(() => {
    if (timerRef.current != null) { window.clearTimeout(timerRef.current); timerRef.current = null }
    abortRef.current?.abort()
  }, [])

  const fetchPage = useCallback((queryString: string, page: number, sort: SortMode, delay: number) => {
    cancel()
    const seq = ++seqRef.current
    setResults((r) => ({ queryString, page, sort, status: 'loading', data: r?.queryString === queryString ? r.data : null }))
    const go = () => {
      timerRef.current = null
      if (seq !== seqRef.current) return
      const q = buildQuery(tokenize(queryString))
      const ctl = new AbortController()
      abortRef.current = ctl
      bridgeSearch({ ...q, has: q.has as never, sort: sort as BridgeSearchSort, offset: Math.min(page * SEARCH_PAGE_SIZE, MAX_OFFSET) }, ctl.signal, guildRef.current)
        .then((data) => { if (seq === seqRef.current) setResults({ queryString, page, sort, status: 'done', data }) })
        .catch(() => {
          if (seq !== seqRef.current || ctl.signal.aborted) return
          setResults((r) => ({ queryString, page, sort, status: 'error', data: r?.data ?? null }))
        })
    }
    timerRef.current = window.setTimeout(go, delay)
  }, [cancel])

  /** PERFORM_SEARCH: returns false when the query has nothing to search. */
  const search = useCallback((queryString: string) => {
    const cleaned = cleanQueryString(queryString)
    const tokens = tokenize(cleaned)
    if (tokens.length === 0 || queryIsEmpty(buildQuery(tokens))) return false
    setHistory((h) => { const n = addHistory(h, cleaned); saveHistory(n); return n })
    fetchPage(cleaned, 0, 'newest', 500) // debounce(fetchMessages, 500); mode → NEWEST
    return true
  }, [fetchPage])

  const resultsRef = useRef<ResultsState | null>(null)
  resultsRef.current = results
  const goToPage = useCallback((page: number) => {
    const r = resultsRef.current
    if (r) fetchPage(r.queryString, page, r.sort, 0)
  }, [fetchPage])
  const changeSort = useCallback((sort: SortMode) => {
    const r = resultsRef.current
    if (r && r.sort !== sort && r.status !== 'loading') fetchPage(r.queryString, 0, sort, 0)
  }, [fetchPage])

  const closeResults = useCallback(() => { cancel(); seqRef.current += 1; setResults(null) }, [cancel])
  const clear = useCallback(() => { closeResults(); setText('') }, [closeResults])
  const clearHistory = useCallback(() => { setHistory([]); saveHistory([]) }, [])

  useEffect(() => () => cancel(), [cancel])

  return {
    text, setText, results, history, search, goToPage, changeSort, clear, closeResults, clearHistory,
    isSearching: results?.status === 'loading',
    filtersOpen, openFilters: () => setFiltersOpen(true), closeFilters: () => setFiltersOpen(false),
  }
}

export type ChannelSearchState = ReturnType<typeof useChannelSearch>

// ---- pills (eC: history rows / "Search for" label) -----------------------------

function QueryPills({ value, channelKind }: { value: string; channelKind?: (id: string) => ChannelIconKind }) {
  const tokens = tokenize(value)
  return (
    <div className="chatSearchPillContainer">
      {tokens.map((t, i) => {
        const keep = isFilter(t.type) ? tokenCounts(t, tokens[i + 1]) : true
        const text = t.text
        if (text.trim().length === 0) return null
        const key = `${t.type}-${text}-${i}`
        if (!keep || t.type === 'NON_TOKEN') return <span key={key} className="chatSearchPillText chatSearchNonText">{text}</span>
        if (isFilter(t.type)) return <span key={key} className="chatSearchPillText chatSearchFilterPill">{text}</span>
        if (t.type === 'ANSWER_USERNAME_FROM' || t.type === 'ANSWER_USERNAME_MENTIONS') {
          const u = typeof t.data.userId === 'string' ? userById(t.data.userId) : undefined
          // A typed name (server-resolved) is still a pill, showing the name.
          if (!u) return <span key={key} className="chatSearchPillText chatSearchAnswerPill">{typeof t.data.name === 'string' ? t.data.name : text}</span>
          return (
            <div key={key} className="chatSearchAnswerPill">
              <Avatar src={u.avatar} size={16} />
              <span className="chatSearchPillText">{u.username}</span>
            </div>
          )
        }
        if (t.type === 'ANSWER_IN') {
          const id = ((t.data.channelIds as string[]) ?? [])[0]
          const c = searchChannels().find((x) => x.channelId === id)
          if (!c) return <span key={key} className="chatSearchPillText chatSearchAnswerPill">{text}</span>
          return (
            <div key={key} className="chatSearchAnswerPill chatSearchChannelAnswerPill">
              <ChannelTypeIcon kind={channelKind?.(c.channelId) || 'text'} size={16} className="chatSearchChannelPillIcon" />
              <span className="chatSearchPillText">{c.name}</span>
            </div>
          )
        }
        return <span key={key} className="chatSearchPillText chatSearchAnswerPill">{text}</span>
      })}
    </div>
  )
}

// ep: "from: user" sublabel.
function FilterSublabel({ filter, answer }: { filter: FilterType; answer?: string }) {
  const hint = answer ?? (filter === 'FILTER_HAS' ? S.hasHint : filter === 'FILTER_IN' ? S.channelHint : isDateFilter(filter) ? S.dateHint : filter === 'FILTER_AUTHOR_TYPE' ? S.authorTypeHint : S.userHint)
  return (
    <div className="chatSearchFilterSublabel">
      <span className="chatSearchSublabelKey">{RULE[filter]?.key}</span>
      <span className="chatSearchSublabelValue">{hint}</span>
    </div>
  )
}

// ---- calendar (CalendarPicker / react-datepicker) ----------------------------

function isoDay(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

function Calendar({ onSelect, value }: { onSelect: (d: Date) => void; value?: Date | null }) {
  const today = new Date()
  const [view, setView] = useState(() => new Date((value ?? today).getFullYear(), (value ?? today).getMonth(), 1))
  const first = new Date(view.getFullYear(), view.getMonth(), 1)
  const start = new Date(first); start.setDate(1 - first.getDay())
  const weeks: Date[][] = []
  for (let w = 0; w < 6; w++) {
    const row: Date[] = []
    for (let d = 0; d < 7; d++) { const x = new Date(start); x.setDate(start.getDate() + w * 7 + d); row.push(x) }
    if (w > 3 && row[0].getMonth() !== view.getMonth()) break
    weeks.push(row)
  }
  const max = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const canPrev = new Date(view.getFullYear(), view.getMonth() - 1, 1) >= new Date(MIN_DATE.getFullYear(), MIN_DATE.getMonth(), 1)
  const canNext = new Date(view.getFullYear(), view.getMonth() + 1, 1) <= max
  return (
    <div className="chatSearchCalendar" onMouseDown={(e) => e.preventDefault()}>
      <div className="chatSearchCalendarHeader">
        <button type="button" className="chatSearchCalendarNav prev" aria-label={S.previousMonth} disabled={!canPrev} onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))} />
        <div className="chatSearchCalendarMonth">{view.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</div>
        <button type="button" className="chatSearchCalendarNav next" aria-label={S.nextMonth} disabled={!canNext} onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))} />
        <div className="chatSearchCalendarDayNames">
          {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => <div key={d} className="chatSearchCalendarDayName">{d}</div>)}
        </div>
      </div>
      <div className="chatSearchCalendarMonthGrid" role="listbox">
        {weeks.map((row, wi) => (
          <div key={wi} className="chatSearchCalendarWeek">
            {row.map((d) => {
              const outside = d.getMonth() !== view.getMonth()
              const disabled = d > max || d < MIN_DATE
              const selected = value != null && isoDay(value) === isoDay(d)
              return (
                <div
                  key={d.toISOString()}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={disabled}
                  className={`chatSearchCalendarDay${outside ? ' outside' : ''}${disabled ? ' disabled' : ''}${selected ? ' selected' : ''}${isoDay(d) === isoDay(today) ? ' today' : ''}`}
                  onClick={() => { if (!disabled) onSelect(d) }}
                >
                  {d.getDate()}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

// ---- search bar ----------------------------------------------------------------

interface Row {
  key: string
  icon: ReactNode
  label: ReactNode
  sublabel?: ReactNode
  resultText?: string
  onSelect: () => void
}
type Item = { type: 'row'; row: Row } | { type: 'group'; title: string; rows: Row[]; trailing?: ReactNode }

// Editor text offsets ↔ DOM.
function caretOffsets(root: HTMLElement): { anchor: number; focus: number } | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return null
  const offsetOf = (node: Node, off: number) => {
    const r = document.createRange()
    r.setStart(root, 0)
    try { r.setEnd(node, off) } catch { return 0 }
    return r.toString().length
  }
  return { anchor: offsetOf(sel.anchorNode!, sel.anchorOffset), focus: offsetOf(sel.focusNode!, sel.focusOffset) }
}
function placeCaret(root: HTMLElement, offset: number) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let left = offset
  let last: Text | null = null
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    last = n
    if (left <= n.length) {
      const r = document.createRange(); r.setStart(n, left); r.collapse(true)
      const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(r)
      return
    }
    left -= n.length
  }
  const r = document.createRange()
  if (last) r.setStart(last, last.length); else r.setStart(root, 0)
  r.collapse(true)
  const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(r)
}
// e6 decorate + eZ renderLeaf: FILTER → searchFilter, ANSWER → searchAnswer.
function paintEditor(root: HTMLElement, text: string) {
  const frag = document.createDocumentFragment()
  for (const t of tokenize(text)) {
    const span = document.createElement('span')
    const rule = RULE[t.type]
    if (rule) span.className = rule.componentType === 'FILTER' ? 'chatSearchToken chatSearchFilter' : 'chatSearchToken chatSearchAnswer'
    span.textContent = t.text
    frag.appendChild(span)
  }
  root.replaceChildren(frag)
}

export function SearchBar({
  search,
  guildName,
  suggestChannelId,
  channels,
  open,
  onOpenChange,
  channelKind,
}: {
  search: ChannelSearchState
  guildName: string
  // A bridged channel to resolve member suggestions against (the members
  // endpoint is channel-scoped + VIEW-gated).
  suggestChannelId: string | null
  channels: BridgeChannel[]
  open: boolean
  onOpenChange: (open: boolean) => void
  channelKind?: (channelId: string) => ChannelIconKind
}) {
  const { text, setText, history, results, isSearching } = search
  const editorRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const [focused, setFocused] = useState(false)
  const [caret, setCaret] = useState({ anchor: 0, focus: 0 })
  const [selected, setSelected] = useState(-1)
  const [members, setMembers] = useState<BridgeMemberSuggestion[]>([])
  const [usersVersion, setUsersVersion] = useState(0)

  const bridged = useMemo(() => channels.filter((c) => c.bridged !== false), [channels])
  useEffect(() => { setSearchChannels(bridged.map((c) => ({ channelId: c.channelId, name: c.name }))) }, [bridged])

  // usersVersion re-tokenizes once newly-seen users can validate answers.
  const tokens = useMemo(() => { void usersVersion; return tokenize(text) }, [text, usersVersion, bridged]) // eslint-disable-line react-hooks/exhaustive-deps
  const scope = useMemo(() => cursorScope(tokens, caret.focus, caret.anchor), [tokens, caret])
  const mode: Mode = useMemo(() => autocompleteMode(scope, tokens), [scope, tokens])
  const modeQuery = mode.token?.text.trim() ?? ''

  // Repaint the decorated DOM whenever the text changes from outside typing.
  const paintedRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    const el = editorRef.current
    if (!el || composing.current) return
    const caretNow = document.activeElement === el ? caretOffsets(el) : null
    if (paintedRef.current !== `${text}\u0000${usersVersion}`) {
      paintEditor(el, text)
      paintedRef.current = `${text}\u0000${usersVersion}`
      if (caretNow) placeCaret(el, Math.min(caretNow.focus, text.length))
    }
  }, [text, usersVersion])

  const syncCaret = useCallback(() => {
    const el = editorRef.current
    if (!el) return
    const c = caretOffsets(el)
    if (c) setCaret((prev) => (prev.anchor === c.anchor && prev.focus === c.focus ? prev : c))
  }, [])
  useEffect(() => {
    if (!focused) return
    document.addEventListener('selectionchange', syncCaret)
    return () => document.removeEventListener('selectionchange', syncCaret)
  }, [focused, syncCaret])

  const shown = open && focused

  // Member suggestions: FILTER (from:/mentions:) and FILTER_ALL modes.
  const wantsMembers = (mode.type === 'FILTER' && (mode.filter === 'FILTER_FROM' || mode.filter === 'FILTER_MENTIONS')) || (mode.type === 'FILTER_ALL' && modeQuery !== '')
  const memberQuery = wantsMembers ? modeQuery.replace(/^@/, '').split('#')[0] : null
  useEffect(() => {
    if (memberQuery === null || !suggestChannelId || !shown) return
    let cancelled = false
    const id = window.setTimeout(() => {
      bridgeMembers(suggestChannelId, memberQuery, 10)
        .then((r) => {
          if (cancelled) return
          for (const m of r.members) rememberUser({ userId: m.userId, username: m.username, displayName: m.displayName, avatar: m.avatar })
          setMembers(r.members)
          setUsersVersion((v) => v + 1)
        })
        .catch(() => { /* 429 etc. - keep the previous suggestions */ })
    }, 250)
    return () => { cancelled = true; window.clearTimeout(id) }
  }, [memberQuery, suggestChannelId, shown])

  const setValue = useCallback((next: string, caretPos: number) => {
    const el = editorRef.current
    const v = next.replace(/\n/g, '').slice(0, MAX_QUERY)
    setText(v)
    if (el) {
      paintEditor(el, v)
      paintedRef.current = `${v}\u0000${usersVersion}`
      if (document.activeElement === el) placeCaret(el, Math.min(caretPos, v.length))
    }
    setCaret({ anchor: Math.min(caretPos, v.length), focus: Math.min(caretPos, v.length) })
  }, [setText, usersVersion])

  const runSearch = useCallback((queryString?: string) => {
    if (isSearching) return false
    const ok = search.search(queryString ?? text)
    if (ok) { onOpenChange(false); editorRef.current?.blur() }
    return ok
  }, [isSearching, search, text, onOpenChange])

  // J (SET_SEARCH_QUERY): replace the mode's token (or insert at the caret).
  const setSearchQuery = useCallback((opts: { query: string; performSearch: boolean; replace?: boolean }) => {
    let q = opts.query
    let next: string
    let caretPos: number
    if (opts.replace) {
      if (q.charAt(q.length - 1) !== ' ') q += ' '
      next = q
      caretPos = q.length
    } else {
      const anchor = mode.token != null ? mode.token.start : scope?.currentToken != null ? scope.currentToken.end : 0
      const focus = mode.token != null ? mode.token.end : anchor
      if (q.charAt(q.length - 1) !== ' ') q += ' '
      if (anchor !== 0 && text.charAt(anchor - 1) !== ' ' && q.charAt(0) !== ' ') q = ' ' + q
      next = (text.slice(0, anchor) + q + text.slice(focus)).slice(0, MAX_QUERY)
      caretPos = anchor + q.length
    }
    setValue(next, caretPos)
    if (opts.performSearch) runSearch(next)
    else { onOpenChange(true); requestAnimationFrame(() => { const el = editorRef.current; if (el) { el.focus(); placeCaret(el, caretPos) } }) }
  }, [mode.token, scope, text, setValue, runSearch, onOpenChange])

  // ---- autocomplete rows -----------------------------------------------------
  const items: Item[] = useMemo(() => {
    void usersVersion
    const filterRow = (type: FilterType, icon: string[], label: string): Row => ({
      key: `f-${type}`,
      icon: <Svg size={18} className="chatSearchItemIcon" paths={icon} evenodd />,
      label: <span className="chatSearchRowLabel">{label}</span>,
      sublabel: <FilterSublabel filter={type} />,
      onSelect: () => setSearchQuery({ query: `${RULE[type]!.key} `, performSearch: false }),
    })
    const filterRows = (): Row[] => [
      filterRow('FILTER_FROM', P.user, S.fromSpecific),
      filterRow('FILTER_IN', [TEXT_ICON_PATH], S.inSpecific),
      filterRow('FILTER_HAS', P.paperclip, S.hasSpecific),
      filterRow('FILTER_MENTIONS', P.at, S.mentionsSpecific),
    ]
    const moreRow = (withSub: boolean): Row => ({
      key: 'more',
      icon: <Svg size={20} className="chatSearchItemIcon" paths={P.filters} />,
      label: <span className="chatSearchRowLabel">{withSub ? S.moreFilters : S.addSearchFilters}</span>,
      sublabel: withSub ? <span className="chatSearchRowSublabel">{S.moreFiltersSub}</span> : undefined,
      onSelect: () => { onOpenChange(false); search.openFilters() },
    })
    const userRows = (filter: FilterType, list: BridgeMemberSuggestion[], all: boolean): Row[] => list.map((m) => ({
      key: `${filter}-${m.userId}`,
      icon: all ? <Svg size={18} className="chatSearchItemIcon" paths={filter === 'FILTER_FROM' ? P.user : P.at} evenodd /> : <Avatar src={m.avatar} size={20} className="chatSearchItemIcon" />,
      label: all
        ? <div className="chatSearchLabelWithElements"><Avatar src={m.avatar} size={16} /><span className="chatSearchNameDefault">{m.displayName || m.username}</span></div>
        : <div className="chatSearchLabelWithElements"><span className="chatSearchNameDefault">{m.displayName || m.username}</span><span className="chatSearchUsernameSubtle">{m.username}</span></div>,
      sublabel: all ? <FilterSublabel filter={filter} answer={m.username} /> : undefined,
      resultText: all ? `${RULE[filter]!.key} ${m.username}` : m.username,
      onSelect: () => setSearchQuery({ query: all ? `${RULE[filter]!.key} ${m.username}` : m.username, performSearch: !all }),
    }))
    const channelRows = (list: BridgeChannel[], all: boolean): Row[] => list.map((c) => ({
      key: `in-${c.channelId}`,
      icon: <ChannelTypeIcon kind={channelKind?.(c.channelId) || 'text'} size={18} className="chatSearchItemIcon" />,
      label: all
        ? <div className="chatSearchLabelWithElements"><span className="chatSearchRowLabel">in:</span><span className="chatSearchChannelNameContainer"><ChannelTypeIcon kind={channelKind?.(c.channelId) || 'text'} size={16} className="chatSearchChannelNameIcon" /><span className="chatSearchChannelName">{c.name}</span></span></div>
        : <span className="chatSearchChannelName">{c.name}</span>,
      resultText: all ? `in: ${quoteAnswer(c.name)}` : quoteAnswer(c.name),
      onSelect: () => setSearchQuery({ query: all ? `in: ${quoteAnswer(c.name)}` : quoteAnswer(c.name), performSearch: !all }),
    }))
    const enumRows = (filter: FilterType, values: readonly string[], q: string, icon: (t: string) => ReactNode): Row[] => values
      .filter((v) => fuzzy(q, v)).slice(0, 10)
      .map((v) => ({ key: `${filter}-${v}`, icon: icon(v), label: <span className="chatSearchRowLabel">{v}</span>, resultText: v, onSelect: () => setSearchQuery({ query: v, performSearch: true }) }))

    if (mode.type === 'EMPTY') {
      const out: Item[] = [{ type: 'group', title: S.filters, rows: [...filterRows(), moreRow(true)] }]
      if (history.length) {
        out.push({
          type: 'group',
          title: S.history,
          trailing: (
            <button type="button" className="chatSearchClearHistory" title={S.clearHistory} aria-label={S.clearHistory} onClick={() => search.clearHistory()}>
              <Svg size={18} className="chatSearchClearHistoryIcon" paths={P.trash} evenodd />
            </button>
          ),
          rows: history.map((h, i) => ({
            key: `h-${i}-${h}`,
            icon: <Svg size={18} className="chatSearchItemIcon" paths={P.magnifier} evenodd />,
            label: <QueryPills value={h} channelKind={channelKind} />,
            resultText: h,
            onSelect: () => setSearchQuery({ query: h, performSearch: true }),
          })),
        })
      }
      return out
    }
    if (mode.type === 'FILTER') {
      const f = mode.filter!
      const q = modeQuery.toLowerCase().replace(/^["#]+/, '')
      if (f === 'FILTER_FROM' || f === 'FILTER_MENTIONS') {
        const rows = userRows(f, members.slice(0, 10), false)
        return rows.length ? [{ type: 'group', title: f === 'FILTER_FROM' ? S.fromUser : S.mentionsUser, rows }] : []
      }
      if (f === 'FILTER_IN') {
        let list = bridged.filter((c) => !q || c.name.toLowerCase().includes(q))
        if (!q && suggestChannelId) list = [...list.filter((c) => c.channelId === suggestChannelId), ...list.filter((c) => c.channelId !== suggestChannelId)]
        const rows = channelRows(list.slice(0, 10), false)
        return rows.length ? [{ type: 'group', title: S.inChannel, rows }] : []
      }
      if (f === 'FILTER_HAS') {
        const rows = enumRows(f, HAS_VALUES, q, (v) => hasIcon(v, 18, 'chatSearchItemIcon'))
        return rows.length ? [{ type: 'group', title: S.messageContains, rows }] : []
      }
      if (f === 'FILTER_AUTHOR_TYPE') {
        const rows = enumRows(f, AUTHOR_TYPE_VALUES, q, (v) => authorIcon(v, 18, 'chatSearchItemIcon'))
        return rows.length ? [{ type: 'group', title: '', rows }] : []
      }
      return []
    }
    // FILTER_ALL
    const out: Item[] = []
    if (text.trim() !== '') {
      out.push({
        type: 'row',
        row: {
          key: 'search-for',
          icon: <Svg size={18} className="chatSearchItemIcon" paths={P.magnifier} evenodd />,
          label: <div className="chatSearchLabelWithElements chatSearchRowLabel">{S.searchFor}<b><QueryPills value={text} channelKind={channelKind} /></b></div>,
          onSelect: () => runSearch(),
        },
      })
    }
    const groups: Item[] = []
    if (modeQuery !== '') {
      const q = modeQuery.toLowerCase()
      const matchUsers = members.filter((m) => m.username.toLowerCase().includes(q.replace(/^@/, '')) || (m.displayName || '').toLowerCase().includes(q.replace(/^@/, ''))).slice(0, 3)
      const from = userRows('FILTER_FROM', matchUsers, true)
      if (from.length) groups.push({ type: 'group', title: S.fromUser, rows: from })
      const mentions = userRows('FILTER_MENTIONS', matchUsers, true)
      if (mentions.length) groups.push({ type: 'group', title: S.mentionsUser, rows: mentions })
      const chans = channelRows(bridged.filter((c) => c.name.toLowerCase().includes(q.replace(/^#/, ''))).slice(0, 3), true)
      if (chans.length) groups.push({ type: 'group', title: S.inChannel, rows: chans })
    }
    if (groups.length === 0) out.push({ type: 'group', title: S.filters, rows: [...filterRows(), moreRow(true)] })
    else { out.push({ type: 'row', row: moreRow(false) }); out.push(...groups) }
    return out
  }, [mode, modeQuery, history, members, bridged, text, usersVersion, setSearchQuery, runSearch, search, onOpenChange, channelKind, suggestChannelId])

  const flat = useMemo(() => items.flatMap((it) => (it.type === 'row' ? [it.row] : it.rows)), [items])

  // Selection reset (eq's effect): FILTER mode preselects row 0.
  const lastMode = useRef<{ type: string; query: string }>({ type: mode.type, query: modeQuery })
  useEffect(() => {
    const prev = lastMode.current
    if (prev.type !== mode.type) setSelected(mode.type === 'FILTER' ? 0 : -1)
    else if (mode.type === 'FILTER' && prev.query !== modeQuery && flat.length > 0) setSelected(0)
    else setSelected((s) => (s >= flat.length ? Math.max(-1, flat.length - 1) : s))
    lastMode.current = { type: mode.type, query: modeQuery }
  }, [mode.type, modeQuery, flat.length])

  const move = (d: number) => {
    if (!flat.length) return
    let t = selected + d
    if (t > flat.length - 1) t = 0
    else if (t < 0) t = flat.length - 1
    setSelected(t)
    requestAnimationFrame(() => document.getElementById(`chat-search-opt-${t}`)?.scrollIntoView({ block: 'nearest' }))
  }

  const deleteToken = (forward: boolean): boolean => {
    const el = editorRef.current
    if (!el) return false
    const c = caretOffsets(el)
    if (!c || c.anchor !== c.focus) return false
    const r = c.focus
    for (const t of tokenize(text)) {
      const rule = RULE[t.type]
      if (!rule || rule.mutable === true) continue
      if (forward ? r >= t.start && r < t.end : r > t.start && r <= t.end) {
        setValue(text.slice(0, t.start) + text.slice(t.end), t.start)
        return true
      }
    }
    return false
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'Enter':
        e.preventDefault()
        if (shown && selected >= 0 && flat[selected]) flat[selected].onSelect()
        else runSearch()
        return
      case 'Escape':
        e.preventDefault(); e.stopPropagation()
        if (text.length === 0) editorRef.current?.blur()
        else { setValue('', 0); onOpenChange(true) }
        return
      case 'ArrowUp':
        e.preventDefault(); e.stopPropagation(); move(-1)
        return
      case 'ArrowDown':
        e.preventDefault(); e.stopPropagation(); move(1)
        return
      case 'Home':
      case 'End':
        if (!e.shiftKey && editorRef.current) {
          e.preventDefault()
          const pos = e.key === 'Home' ? 0 : text.length
          placeCaret(editorRef.current, pos)
          setCaret({ anchor: pos, focus: pos })
        }
        return
      case 'Backspace':
        if (deleteToken(false)) e.preventDefault()
        return
      case 'Delete':
        if (deleteToken(true)) e.preventDefault()
        return
    }
  }

  const onInput = () => {
    const el = editorRef.current
    if (!el || composing.current) return
    const raw = (el.textContent || '').replace(/\n/g, '').replace(/ /g, ' ')
    const c = caretOffsets(el)
    const v = raw.slice(0, MAX_QUERY)
    setText(v)
    paintEditor(el, v)
    paintedRef.current = `${v}\u0000${usersVersion}`
    const pos = Math.min(c?.focus ?? v.length, v.length)
    placeCaret(el, pos)
    setCaret({ anchor: pos, focus: pos })
    onOpenChange(true)
  }

  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = editorRef.current
    if (!el) return
    const pasted = e.clipboardData.getData('text/plain').replace(/\n/g, '')
    const c = caretOffsets(el) ?? { anchor: text.length, focus: text.length }
    const a = Math.min(c.anchor, c.focus); const b = Math.max(c.anchor, c.focus)
    const room = MAX_QUERY - (text.length - (b - a))
    if (room <= 0) return
    const ins = pasted.slice(0, room)
    setValue(text.slice(0, a) + ins + text.slice(b), a + ins.length)
  }

  // er: the clear (X) / magnifier icon.
  const onClear = (e: MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    if (text.length === 0) { editorRef.current?.focus(); return }
    setValue('', 0)
    search.closeResults()
    if (!shown) editorRef.current?.blur()
  }

  // Ctrl/Cmd+F focuses the search bar (Discord's SEARCH keybind).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        const el = editorRef.current
        if (el) { el.focus(); placeCaret(el, text.length) }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [text.length])

  const placeholder = S.searchIn(guildName)
  const hasContent = text.length > 0 || results != null
  const dateMode = mode.type === 'FILTER' && isDateFilter(mode.filter)
  let idx = -1

  return (
    <div className="chatSearch headerSearchWrap" ref={wrapRef}>
      <div className={`chatSearchInner${text.length > 0 || shown ? ' open' : ''}${shown ? ' focused' : ''}`}>
        <div className="chatSearchBar">
          <div className="chatSearchEditorWrap">
            {text.length === 0 && <span className="chatSearchPlaceholder" aria-hidden="true">{placeholder}</span>}
            <div
              ref={editorRef}
              className="chatSearchEditor"
              role="combobox"
              aria-expanded={shown}
              aria-controls={shown ? 'chat-search-popout' : undefined}
              aria-label={placeholder}
              aria-autocomplete="list"
              aria-activedescendant={selected >= 0 ? `chat-search-opt-${selected}` : undefined}
              aria-multiline="false"
              contentEditable
              suppressContentEditableWarning
              spellCheck={false}
              autoCorrect="off"
              onInput={onInput}
              onKeyDown={onKeyDown}
              onKeyUp={syncCaret}
              onMouseUp={syncCaret}
              onPaste={onPaste}
              onDrop={(e) => e.preventDefault()}
              onCompositionStart={() => { composing.current = true }}
              onCompositionEnd={() => { composing.current = false; onInput() }}
              onFocus={() => { setFocused(true); onOpenChange(true); syncCaret() }}
              onBlur={() => {
                setFocused(false)
                onOpenChange(false)
                if (text.length === 0) search.closeResults()
              }}
            />
          </div>
          <div className={`chatSearchIconLayout${hasContent ? ' pointer' : ''}`} data-size="sm" role="button" tabIndex={-1} aria-hidden="true" onMouseDown={onClear}>
            <div className="chatSearchIconContainer">
              <Svg className={`chatSearchIconGlyph${hasContent ? '' : ' visible'}`} paths={P.magnifier} evenodd />
              <Svg className={`chatSearchIconGlyph chatSearchClearGlyph${hasContent ? ' visible' : ''}`} paths={P.clear} />
            </div>
          </div>
        </div>
      </div>
      {/* Search autocomplete popout: anchored under the search bar (Popout
          position "bottom", align "left", spacing 8), nudged into the
          viewport and portaled to the popout layer (the header is an
          inline-size container that traps fixed descendants). */}
      {shown && (dateMode || items.length > 0) && (
        <Popout anchor={() => wrapRef.current} position="bottom" align="left" spacing={8}>{(ref) => (
        <div
          ref={ref}
          id="chat-search-popout"
          className={`chatSearchPopout${dateMode ? ' datePicker' : ''}`}
          role="listbox"
          tabIndex={-1}
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
        >
          {dateMode ? (
            <Calendar onSelect={(d) => setSearchQuery({ query: `${isoDay(d)} `, performSearch: true })} />
          ) : (
            items.map((it, gi) => {
              const renderRow = (row: Row) => {
                idx += 1
                const i = idx
                return (
                  <li
                    key={row.key}
                    id={`chat-search-opt-${i}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected === i}
                    className="chatSearchItemContainer"
                    onClick={() => row.onSelect()}
                  >
                    <div className="chatSearchItem">
                      {row.icon}
                      {row.sublabel == null ? row.label : <div>{row.label}{row.sublabel}</div>}
                    </div>
                  </li>
                )
              }
              if (it.type === 'row') return <ul key={`r-${gi}`} className="chatSearchRowList">{renderRow(it.row)}</ul>
              const start = idx + 1
              return (
                <div key={`g-${gi}-${it.title}`}>
                  {start > 0 && <div className="chatSearchDivider" />}
                  <ul role="group" aria-labelledby={`${it.title}-header`} className="chatSearchGroupWrapper">
                    {it.title !== '' && (
                      <div id={`${it.title}-header`} className="chatSearchGroupHeader">
                        <span className="chatSearchGroupTitle">{it.title}</span>
                        {it.trailing}
                      </div>
                    )}
                    {it.rows.map(renderRow)}
                  </ul>
                </div>
              )
            })
          )}
        </div>
        )}</Popout>
      )}
      {/* The header is an inline-size container (a containing block for
          fixed descendants), so the modal portals to the chat page root. */}
      {search.filtersOpen && createPortal(
        <FiltersModal search={search} suggestChannelId={suggestChannelId} bridged={bridged} channelKind={channelKind} />,
        wrapRef.current?.closest('.chat-page') ?? document.body,
      )}
    </div>
  )
}

// ---- results panel -----------------------------------------------------------

function highlightNode(root: HTMLElement, stems: Set<string>) {
  if (!stems.size) return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const p = n.parentElement
    if (!p || p.closest('.chatSearchHighlight, pre, code')) continue
    nodes.push(n as Text)
  }
  for (const node of nodes) {
    const parts = (node.nodeValue || '').split(/(\W+)/g)
    if (!parts.some((w) => wordMatches(w, stems))) continue
    const frag = document.createDocumentFragment()
    let buf = ''
    for (const w of parts) {
      if (wordMatches(w, stems)) {
        if (buf) { frag.appendChild(document.createTextNode(buf)); buf = '' }
        const span = document.createElement('span')
        span.className = 'chatSearchHighlight'
        span.textContent = w
        frag.appendChild(span)
      } else buf += w
    }
    if (buf) frag.appendChild(document.createTextNode(buf))
    node.parentNode?.replaceChild(frag, node)
  }
}

function ResultItem({
  message, stems, renderBody, avatarSrc, onAvatarError, formatTimestamp, onJump, onContext,
}: {
  message: BridgeMessage
  stems: Set<string>
  renderBody: (m: BridgeMessage) => ReactNode
  avatarSrc: (m: BridgeMessage) => string
  onAvatarError: (e: SyntheticEvent<HTMLImageElement>, name: string) => void
  formatTimestamp: (iso: string) => string
  onJump: (m: BridgeMessage) => void
  onContext?: (m: BridgeMessage, e: MouseEvent) => void
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    bodyRef.current?.querySelectorAll<HTMLElement>('.content > span').forEach((el) => highlightNode(el, stems))
  })
  const jump = (e?: MouseEvent) => { e?.preventDefault(); e?.stopPropagation(); onJump(message) }
  return (
    <li className="chatSearchResultContainer" aria-labelledby={`search-result-${message.id}`}>
      <div
        className="chatSearchResult"
        tabIndex={-1}
        // handleMessageClick: jump unless the click hit a link/button/image or
        // the user is selecting text.
        onClick={(e) => {
          const sel = window.getSelection()
          if (sel && !sel.isCollapsed) return
          for (let el = e.target as HTMLElement | null; el && el !== e.currentTarget; el = el.parentElement) {
            if (el.tagName.toUpperCase() === 'A' || el.tagName.toUpperCase() === 'BUTTON' || (el.tagName.toUpperCase() === 'IMG' && el.getAttribute('aria-hidden') !== 'true')) return
          }
          jump(e)
        }}
        onContextMenu={onContext ? (e) => onContext(message, e) : undefined}
      >
        <div className="chatSearchResultMessage" id={`search-result-${message.id}`}>
          <div className="message groupStart chatSearchMessage">
            <div className="avatar">
              <img src={avatarSrc(message)} alt="" aria-hidden="true" loading="lazy" onError={(e) => onAvatarError(e, message.authorName)} />
            </div>
            <div className="message-header" ref={bodyRef}>
              <span className="name" style={message.authorColor ? { color: message.authorColor } : undefined}>{message.authorName}</span>
              {/* Discord's cozy APP botTag for Discord-side bots only; web
                  (webhook-delivered) site users are first-class users. */}
              {message.direction !== 'web' && message.authorBot === true && (
                <span className="botTag botTagCozy botTagRegular"><span className="botText">APP</span></span>
              )}
              {message.authorRole && <span className={`bot role-badge role-${message.authorRole}`}>{message.authorRole}</span>}
              <span className="timestamp"><i className="chat-separator" aria-hidden="true"> - </i>{formatTimestamp(message.createdAt)}</span>
              {renderBody(message)}
            </div>
          </div>
        </div>
      </div>
      <div className="chatSearchButtonsContainer" aria-hidden="true">
        <button type="button" className="chatSearchJumpButton" onClick={(e) => jump(e)}>{S.jump}</button>
      </div>
    </li>
  )
}

// module 932793 paginator (maxVisiblePages 5).
function pageList(selected: number, total: number, maxVisible: number): Array<{ type: 'BACK' | 'NEXT' | 'GAP' | 'PAGE'; page?: number; key: string; disabled?: boolean }> {
  const half = Math.ceil(maxVisible / 2)
  const floor = Math.floor(maxVisible / 2)
  let [lo, hi] = selected <= half ? [1, maxVisible] : selected > total - floor ? [total - maxVisible + 1, total] : [selected - half + 1, selected + floor]
  lo = Math.max(lo, 1); hi = Math.min(hi, total)
  let left: Array<{ type: 'GAP' | 'PAGE'; page?: number; key: string }> = []
  let right: Array<{ type: 'GAP' | 'PAGE'; page?: number; key: string }> = []
  if (lo > 1) { left = [{ type: 'PAGE', page: 1, key: 'page-1' }, { type: 'GAP', key: 'left-gap' }]; lo += 2 }
  if (hi < total) { right = [{ type: 'GAP', key: 'right-gap' }, { type: 'PAGE', page: total, key: `page-${total}` }]; hi -= 2 }
  const mid = [] as Array<{ type: 'PAGE'; page: number; key: string }>
  for (let p = lo; p <= hi; p++) mid.push({ type: 'PAGE', page: p, key: `page-${p}` })
  return [{ type: 'BACK', key: 'back', disabled: selected === 1 }, ...left, ...mid, ...right, { type: 'NEXT', key: 'next', disabled: selected === total }]
}

function Paginator({ page, totalCount, onPageChange }: { page: number; totalCount: number; onPageChange: (index: number) => void }) {
  const total = Math.ceil(totalCount / SEARCH_PAGE_SIZE)
  if (total <= 1) return null
  const current = page + 1
  const go = (p: number) => { if (p !== current) onPageChange(p - 1) }
  return (
    <div className="chatSearchPageControlContainer">
      <nav className="chatSearchPageControl">
        {pageList(current, total, 5).map((it) => {
          if (it.type === 'BACK') return (
            <button key={it.key} type="button" rel="prev" className="chatSearchPageButton chatSearchEndButton" disabled={it.disabled} onClick={() => go(Math.max(current - 1, 1))}>
              <span className="chatSearchEndButtonInner"><Svg size={24} className="chatSearchIconCaret" paths={P.chevronLeft} /><span>{S.previous}</span></span>
            </button>
          )
          if (it.type === 'NEXT') return (
            <button key={it.key} type="button" rel="next" className="chatSearchPageButton chatSearchEndButton" disabled={it.disabled} onClick={() => go(Math.min(current + 1, total))}>
              <span className="chatSearchEndButtonInner"><span>{S.next}</span><Svg size={24} className="chatSearchIconCaret" paths={P.chevronRight} /></span>
            </button>
          )
          if (it.type === 'GAP') return <div key={it.key} className="chatSearchGap" aria-hidden="true">…</div>
          const sel = it.page === current
          return (
            <div
              key={it.key}
              role="button"
              tabIndex={0}
              className={`chatSearchPageButton chatSearchRoundButton${sel ? ' active' : ''}`}
              aria-label={S.page(it.page!)}
              aria-current={sel ? 'page' : undefined}
              onClick={sel ? undefined : () => go(it.page!)}
            >
              <span>{it.page}</span>
            </div>
          )
        })}
      </nav>
    </div>
  )
}

export function SearchResults({
  search,
  renderBody,
  avatarSrc,
  onAvatarError,
  formatTimestamp,
  onJump,
  onContext,
  channelKind,
  onSelectChannel,
}: {
  search: ChannelSearchState
  renderBody: (m: BridgeMessage) => ReactNode
  avatarSrc: (m: BridgeMessage) => string
  onAvatarError: (e: SyntheticEvent<HTMLImageElement>, name: string) => void
  formatTimestamp: (iso: string) => string
  onJump: (m: BridgeMessage) => void
  onContext?: (m: BridgeMessage, e: MouseEvent) => void
  /** Discord channel glyph for a result group's header (announcement/rules). */
  channelKind?: (channelId: string) => ChannelIconKind
  /** Channel-name header click → switch to that channel. */
  onSelectChannel?: (channelId: string) => void
}) {
  const { results } = search
  const scrollerRef = useRef<HTMLDivElement>(null)
  const sortRef = useRef<HTMLButtonElement>(null)
  const [sortMenu, setSortMenu] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => { scrollerRef.current?.scrollTo({ top: 0 }) }, [results?.page, results?.sort, results?.data])
  // Remember the last settled total while a page/sort fetch is in flight
  // (module 477654's pagination key logic).
  const lastTotal = useRef(0)
  if (!results) return null
  const { data, status, page, sort, queryString } = results
  const isSearching = status === 'loading'
  const total = data?.totalResults ?? 0
  if (!isSearching) lastTotal.current = total
  const paginationTotal = Math.min(isSearching ? lastTotal.current : total, MAX_OFFSET + SEARCH_PAGE_SIZE)
  const maxPage = Math.floor(MAX_OFFSET / SEARCH_PAGE_SIZE) + 1
  const limited = total > MAX_OFFSET + SEARCH_PAGE_SIZE && page >= maxPage - 1
  const tokens = tokenize(queryString)
  const stems = highlightStems(buildQuery(tokens).content ?? '')
  const nFilters = filterCount(tokens)
  const names = new Map((data?.channels || []).map((c) => [c.channelId, c.name]))
  const groups: Array<{ channelId: string; messages: BridgeMessage[] }> = []
  for (const m of data?.messages || []) {
    const g = groups[groups.length - 1]
    if (g && g.channelId === m.channelId) g.messages.push(m)
    else groups.push({ channelId: m.channelId, messages: [m] })
  }
  const sortOptions: Array<{ value: SortMode; label: string }> = [
    { value: 'newest', label: S.newest },
    { value: 'oldest', label: S.oldest },
    { value: 'relevance', label: S.mostRelevant },
  ]

  return (
    <section className="chatSearchResults searchResultsWrap" aria-label={S.searchResults}>
      <header className="chatSearchHeader">
        <div className="chatSearchTotalResults" role="status">
          {isSearching ? (
            <>
              <span className="chatSearchTotalText searching">{S.searching}</span>
              <div className="chatSearchSpinnerWrapper"><span className="chatSearchSpinner" /></div>
            </>
          ) : (
            <span className="chatSearchTotalText">{S.results(total)}</span>
          )}
        </div>
        <div className="chatSearchModeAndFilters">
          <button type="button" className="chatSearchManaButton" onClick={() => search.openFilters()}>
            <span className="chatSearchManaButtonChildren"><Svg size={16} paths={P.filters} />{nFilters > 0 ? S.filtersN(nFilters) : S.filters}</span>
          </button>
          <button
            ref={sortRef}
            type="button"
            className="chatSearchManaButton"
            aria-label={S.sort}
            aria-expanded={sortMenu != null}
            onClick={() => {
              if (sortMenu) { setSortMenu(null); return }
              // Discord's sort popout is position "bottom", align "right"
              // under the button (anchored via the shared popout helper).
              setSortMenu({ x: 0, y: 0 })
            }}
          >
            <span className="chatSearchManaButtonChildren"><Svg size={16} paths={P.sort} />{S.sort}</span>
          </button>
        </div>
      </header>
      <div className="chatSearchScroller" ref={scrollerRef}>
        {limited && !isSearching && <div className="chatSearchHelpMessage warning">{S.maxPages(maxPage)}</div>}
        {status === 'error' ? (
          <div className="chatSearchEmptyResultsWrap">
            <div className="chatSearchEmptyResultsContent">
              <div className="chatSearchErrorImage" />
              <div className="chatSearchEmptyResultsText chatSearchErrorMessage">{S.error}</div>
            </div>
          </div>
        ) : isSearching ? null : total > 0 ? (
          <div role="list" aria-busy={isSearching}>
            {groups.map((g, gi) => (
              <ul key={`${g.channelId}-${gi}`} role="group" className="chatSearchResultGroup" aria-label={names.get(g.channelId) || '???'}>
                <div className="chatSearchChannelNameContainerHeader" onClick={() => onSelectChannel?.(g.channelId)}>
                  <ChannelTypeIcon kind={channelKind?.(g.channelId) || 'text'} size={16} className="chatSearchGroupChannelIcon" />
                  <div className="chatSearchChannelNameTextWrapper">
                    <span className="chatSearchChannelNameText">{names.get(g.channelId) || '???'}</span>
                  </div>
                </div>
                {g.messages.map((m) => (
                  <ResultItem
                    key={m.id}
                    message={m}
                    stems={stems}
                    renderBody={renderBody}
                    avatarSrc={avatarSrc}
                    onAvatarError={onAvatarError}
                    formatTimestamp={formatTimestamp}
                    onJump={onJump}
                    onContext={onContext}
                  />
                ))}
              </ul>
            ))}
          </div>
        ) : (
          <div className="chatSearchEmptyResultsWrap">
            <div className="chatSearchEmptyResultsContent">
              <div className="chatSearchNoResultsImage" />
              <div className="chatSearchEmptyResultsText chatSearchNoResults">{S.noResults}</div>
            </div>
          </div>
        )}
      </div>
      {paginationTotal > SEARCH_PAGE_SIZE && (
        <div className="chatSearchPaginationDock">
          <Paginator page={page} totalCount={paginationTotal} onPageChange={(p) => search.goToPage(p)} />
        </div>
      )}
      {sortMenu && createPortal(
        <ContextMenu
          x={sortMenu.x}
          y={sortMenu.y}
          anchor={() => sortRef.current}
          anchorOptions={{ position: 'bottom', align: 'right', spacing: 8 }}
          ariaLabel={S.sortActions}
          onClose={() => setSortMenu(null)}
          entries={sortOptions.map((o) => ({
            key: `sort-by-option-${o.value}`,
            label: o.label,
            affordance: 'radio',
            group: 'sort-by',
            checked: sort === o.value,
            keepOpen: false,
            onSelect: () => { setSortMenu(null); search.changeSort(o.value) },
          }))}
        />,
        sortRef.current?.closest('.chat-page') ?? document.body,
      )}
    </section>
  )
}

// ---- Filters modal (module 561965) ------------------------------------------

interface Opt { value: string; label: string; leading?: ReactNode; trailing?: string }

function MultiSelect({ label, description, placeholder, value, options, onChange, onQuery }: {
  label: string
  description: string
  placeholder: string
  value: Opt[]
  options: Opt[]
  onChange: (v: Opt[]) => void
  onQuery?: (q: string) => void
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const fieldRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const chosen = new Set(value.map((v) => v.value))
  const list = options.filter((o) => !q || o.label.toLowerCase().includes(q.toLowerCase()) || (o.trailing || '').toLowerCase().includes(q.toLowerCase())).slice(0, 50)
  const listOpts: SelectOption<string>[] = list.map((o) => ({ value: o.value, label: o.label, textValue: o.label, leading: o.leading, trailing: o.trailing }))
  const { active, setActive, move } = useListNavigation(listOpts, open)
  const toggle = (o: Opt) => onChange(chosen.has(o.value) ? value.filter((v) => v.value !== o.value) : [...value, o])
  const show = () => { if (!open) { setOpen(true); setActive(list.length ? 0 : null) } }
  return (
    <div className="chatSearchFilterSection">
      <div className="chatSearchLabelContainer">
        <div className="chatSearchFieldLabel">{label}</div>
        <div className="chatSearchFieldDescription">{description}</div>
      </div>
      <div className="chatSearchSelect" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false) }}>
        <div ref={fieldRef} className={`chatSearchSelectInput${open ? ' open' : ''}`} onClick={(e) => { (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus(); show() }}>
          {value.map((v) => (
            <span key={v.value} className="chatSearchSelectTag">
              {v.leading}
              <span>{v.label}</span>
              <button type="button" aria-label={`Remove ${v.label}`} onClick={(e) => { e.stopPropagation(); toggle(v) }}><Svg size={12} paths={P.clear} /></button>
            </span>
          ))}
          <HolyInput
            value={q}
            role="combobox"
            aria-label={label}
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={open && active != null ? `${listId}-option-${active}` : undefined}
            placeholder={value.length ? '' : placeholder}
            onFocus={show}
            onChange={(e) => { setQ(e.target.value); onQuery?.(e.target.value); setOpen(true); setActive(0) }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) show(); else move(1) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); if (!open) show(); else move(-1) }
              else if (e.key === 'Enter' && open && active != null && list[active]) { e.preventDefault(); toggle(list[active]) }
              else if (e.key === 'Backspace' && !q && value.length) onChange(value.slice(0, -1))
              else if (e.key === 'Tab') setOpen(false)
            }}
          />
          <span className="dcSelectChevron chatSearchSelectChevron" aria-hidden="true">
            <span className={`dcSelectChevronIcon${open ? ' isOpen' : ''}`}><SelectChevronIcon /></span>
          </span>
        </div>
        {/* Discord's combobox dropdown: below the field at its width, flips
            above only when there's no room (shared DiscordSelect popout). */}
        <SelectPopout anchor={fieldRef} open={open} onRequestClose={() => setOpen(false)} className="chatSearchSelectPopout">
          <SelectListBox
            id={listId}
            options={listOpts}
            isSelected={(v) => chosen.has(v)}
            activeIndex={active}
            multiple
            onHover={setActive}
            onPick={(i) => { if (list[i]) toggle(list[i]) }}
            ariaLabel={label}
          />
        </SelectPopout>
      </div>
    </div>
  )
}

/** Discord's CalendarIcon (mana). */
function CalendarIcon({ size = 20 }: { size?: number }) {
  return (
    <svg aria-hidden="true" role="img" width={size} height={size} fill="none" viewBox="0 0 24 24">
      <path fill="currentColor" d="M7 1a1 1 0 0 1 1 1v.75c0 .14.11.25.25.25h7.5c.14 0 .25-.11.25-.25V2a1 1 0 1 1 2 0v.75c0 .14.11.25.25.25H19a3 3 0 0 1 3 3 1 1 0 0 1-1 1H3a1 1 0 0 1-1-1 3 3 0 0 1 3-3h.75c.14 0 .25-.11.25-.25V2a1 1 0 0 1 1-1Z" />
      <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d="M2 10a1 1 0 0 1 1-1h18a1 1 0 0 1 1 1v9a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3v-9Zm3.5 2a.5.5 0 0 0-.5.5v3c0 .28.22.5.5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-3Z" />
    </svg>
  )
}

const parseIsoDay = (v: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}

/** Date field (the Filters modal's date input): a select-style field whose
 *  calendar (react-datepicker → Calendar) opens like every Discord select -
 *  below the field, flipped above only when there's no room. */
function DateField({ value, onChange, ariaLabel }: { value: string; onChange: (iso: string) => void; ariaLabel: string }) {
  const [open, setOpen] = useState(false)
  const fieldRef = useRef<HTMLDivElement>(null)
  const date = parseIsoDay(value)
  return (
    <div className={`dcSelect chatSearchDateField${open ? ' isOpen' : ''}`}>
      <div
        ref={fieldRef}
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={`dcSelectField${open ? ' isOpen' : ''}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); setOpen(true) } }}
      >
        <div className="dcSelectValue">
          {date
            ? <span className="dcSelectValueText">{date.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })}</span>
            : <span className="dcSelectPlaceholder">{S.selectDate}</span>}
        </div>
        <span className="dcDateFieldIcon" aria-hidden="true"><CalendarIcon /></span>
      </div>
      <SelectPopout anchor={fieldRef} open={open} onRequestClose={() => setOpen(false)} matchWidth={false} className="dcDatePopout" role="dialog">
        <Calendar value={date} onSelect={(d) => { onChange(isoDay(d)); setOpen(false); fieldRef.current?.focus() }} />
      </SelectPopout>
    </div>
  )
}

const DATE_KIND_OPTIONS: SelectOption<DateKind>[] = [
  { value: 'before', label: S.before },
  { value: 'after', label: S.after },
  { value: 'during', label: S.during },
]

type DateKind = 'before' | 'after' | 'during'
interface DateRow { id: number; kind: DateKind; date: string }

function FiltersModal({ search, suggestChannelId, bridged, channelKind }: {
  search: ChannelSearchState
  suggestChannelId: string | null
  bridged: BridgeChannel[]
  channelKind?: (id: string) => ChannelIconKind
}) {
  const initial = useMemo(() => {
    const tokens = tokenize(search.text)
    const from: Opt[] = []; const mentions: Opt[] = []; const inCh: Opt[] = []; const has: Opt[] = []; const author: Opt[] = []; const dates: DateRow[] = []
    tokens.forEach((t, i) => {
      if (!isAnswer(t.type)) return
      const prev = tokens[i - 1]
      // Typed names the client can't resolve keep their name (server-resolved).
      const userOpt = (tok: typeof t): Opt | null => {
        const u = typeof tok.data.userId === 'string' ? userById(tok.data.userId) : undefined
        if (u) return { value: u.userId, label: u.displayName || u.username, trailing: u.username, leading: <Avatar src={u.avatar} size={24} /> }
        const name = tok.data.name
        return typeof name === 'string' ? { value: `name:${name.toLowerCase()}`, label: name, trailing: name } : null
      }
      if (t.type === 'ANSWER_USERNAME_FROM') { const o = userOpt(t); if (o) from.push(o) }
      else if (t.type === 'ANSWER_USERNAME_MENTIONS') { const o = userOpt(t); if (o) mentions.push(o) }
      else if (t.type === 'ANSWER_IN') for (const id of (t.data.channelIds as string[]) ?? []) { const c = bridged.find((x) => x.channelId === id); if (c) inCh.push({ value: c.channelId, label: c.name }) }
      else if (t.type === 'ANSWER_HAS') has.push({ value: String(t.data.has), label: String(t.data.has) })
      else if (t.type === 'ANSWER_AUTHOR_TYPE') author.push({ value: String(t.data.author_type), label: String(t.data.author_type) })
      else if (prev) {
        const kind: DateKind = prev.type === 'FILTER_BEFORE' ? 'before' : prev.type === 'FILTER_AFTER' ? 'after' : 'during'
        const r = resolveDate(t.text)
        if (r) dates.push({ id: dates.length + 1, kind, date: isoDay(r[0]) })
      }
    })
    return { from, mentions, inCh, has, author, dates, rest: nonFilterText(tokens) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const [from, setFrom] = useState(initial.from)
  const [mentions, setMentions] = useState(initial.mentions)
  const [inCh, setIn] = useState(initial.inCh)
  const [has, setHas] = useState(initial.has)
  const [author, setAuthor] = useState(initial.author)
  const [dates, setDates] = useState<DateRow[]>(initial.dates)
  const [members, setMembers] = useState<BridgeMemberSuggestion[]>([])
  const [memberQ, setMemberQ] = useState('')
  const nextId = useRef(initial.dates.length + 1)

  useEffect(() => {
    if (!suggestChannelId) return
    let cancelled = false
    const id = window.setTimeout(() => {
      bridgeMembers(suggestChannelId, memberQ, 25).then((r) => {
        if (cancelled) return
        for (const m of r.members) rememberUser({ userId: m.userId, username: m.username, displayName: m.displayName, avatar: m.avatar } as KnownUser)
        setMembers(r.members)
      }).catch(() => {})
    }, 250)
    return () => { cancelled = true; window.clearTimeout(id) }
  }, [memberQ, suggestChannelId])

  const userOpts: Opt[] = members.map((m) => ({ value: m.userId, label: m.displayName || m.username, trailing: m.username, leading: <Avatar src={m.avatar} size={24} /> }))
  const chanOpts: Opt[] = bridged.map((c) => ({ value: c.channelId, label: c.name, leading: <ChannelTypeIcon kind={channelKind?.(c.channelId) || 'text'} size={20} /> }))
  const hasOpts: Opt[] = HAS_VALUES.map((v) => ({ value: v, label: v, leading: hasIcon(v, 20) }))
  const authorOpts: Opt[] = AUTHOR_TYPE_VALUES.map((v) => ({ value: v, label: v, leading: authorIcon(v, 20) }))

  const compose = (st: { from: Opt[]; mentions: Opt[]; inCh: Opt[]; has: Opt[]; author: Opt[]; dates: DateRow[] }) => {
    const parts: string[] = []
    const uname = (o: Opt) => userById(o.value)?.username ?? o.trailing ?? o.label
    for (const o of st.from) parts.push(`from: ${uname(o)}`)
    for (const o of st.mentions) parts.push(`mentions: ${uname(o)}`)
    for (const o of st.inCh) parts.push(`in: #${quoteAnswer(o.label)}`)
    for (const o of st.has) parts.push(`has: ${o.value}`)
    for (const d of st.dates) if (d.date) parts.push(`${d.kind}: ${d.date}`)
    for (const o of st.author) parts.push(`authorType: ${o.value}`)
    return parts.join(' ')
  }
  const filterQuery = compose({ from, mentions, inCh, has, author, dates })
  const changed = filterQuery !== compose(initial)
  const count = from.length + mentions.length + inCh.length + has.length + author.length + dates.filter((d) => d.date).length

  const apply = () => {
    const q = `${filterQuery} ${initial.rest}`.trim()
    search.closeFilters()
    if (!q) { search.clear(); return }
    search.setText(q.endsWith(' ') ? q : `${q} `)
    search.search(q)
  }
  const clearAll = () => { setFrom([]); setMentions([]); setIn([]); setHas([]); setAuthor([]); setDates([]) }

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); search.closeFilters() } }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [search])

  return (
    <div className="chatSearchModalLayer" onMouseDown={(e) => { if (e.target === e.currentTarget) search.closeFilters() }}>
      <div className="chatSearchModal" role="dialog" aria-modal="true" aria-labelledby="chat-search-filters-title">
        <div className="chatSearchModalHeader">
          <h1 id="chat-search-filters-title" className="chatSearchModalTitle">{S.filters}</h1>
          <button type="button" className="chatSearchModalClose" aria-label="Close" onClick={() => search.closeFilters()}><Svg size={24} paths={P.clear} /></button>
        </div>
        <div className="chatSearchModalBody">
          <div className="chatSearchFiltersContainer">
            <MultiSelect label={S.from} description={S.fromSub} placeholder={S.ex('Wumpus')} value={from} options={userOpts} onChange={setFrom} onQuery={setMemberQ} />
            <MultiSelect label={S.inLabel} description={S.inSub} placeholder={S.ex(bridged[0]?.name ?? 'general')} value={inCh} options={chanOpts} onChange={setIn} />
            <MultiSelect label={S.has} description={S.hasSub} placeholder={S.anyContent} value={has} options={hasOpts} onChange={setHas} />
            <MultiSelect label={S.mentions} description={S.mentionsSub} placeholder={S.ex('Wumpus')} value={mentions} options={userOpts} onChange={setMentions} onQuery={setMemberQ} />
            <div className="chatSearchFilterSection">
              <div className="chatSearchLabelContainer">
                <div className="chatSearchFieldLabel">{S.date}</div>
                <div className="chatSearchFieldDescription">{S.dateSub}</div>
              </div>
              {dates.map((d, i) => (
                <div key={d.id} className="chatSearchDateFilter">
                  <DiscordSelect
                    className="chatSearchDateKind"
                    aria-label={S.changeDateType}
                    options={DATE_KIND_OPTIONS}
                    selected={[d.kind]}
                    onSelect={(kind) => setDates((list) => list.map((x) => (x.id === d.id ? { ...x, kind } : x)))}
                  />
                  <DateField ariaLabel={S.date} value={d.date} onChange={(date) => setDates((list) => list.map((x) => (x.id === d.id ? { ...x, date } : x)))} />
                  <button type="button" className="chatSearchRemoveDateFilterButton" aria-label={S.removeDate(i + 1)} onClick={() => setDates((list) => list.filter((x) => x.id !== d.id))}>
                    <Svg size={24} className="chatSearchTrashIcon" paths={P.trash} evenodd />
                  </button>
                </div>
              ))}
              {dates.length < 4 && (
                <button type="button" className="chatSearchManaButton fullWidth" onClick={() => setDates((list) => [...list, { id: nextId.current++, kind: 'before', date: isoDay(new Date()) }])}>
                  <span className="chatSearchManaButtonChildren"><Svg size={16} paths={P.plus} />{S.addDate}</span>
                </button>
              )}
            </div>
            <MultiSelect label={S.authorType} description={S.authorTypeSub} placeholder={S.exBot} value={author} options={authorOpts} onChange={setAuthor} />
          </div>
        </div>
        <footer className="chatSearchModalActionBar">
          <div className="chatSearchModalActionBarLeading">
            <button type="button" className="chatSearchTextButton" disabled={count === 0} onClick={clearAll}>{count === 0 ? S.clearFilters : `${S.clearFilters} (${count})`}</button>
          </div>
          <div className="chatSearchModalActionBarTrailing">
            <button type="button" className="chatSearchManaButton md" onClick={() => search.closeFilters()}><span className="chatSearchManaButtonChildren">{S.cancel}</span></button>
            <button type="button" className="chatSearchManaButton md primary" disabled={!changed} onClick={apply}><span className="chatSearchManaButtonChildren">{S.applyFilters}</span></button>
          </div>
        </footer>
      </div>
    </div>
  )
}
