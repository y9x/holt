// Forum post sync (reconcile), pure core. docs/forum/discord-api.md §4.3, §6.5, §7.3 step 12.
//
// The gateway only knows ACTIVE posts. Every reconcile pass (bot startup, a forum bridged while running)
// lists a forum's active posts (GET /guilds/{id}/threads/active, filtered to the forum) and then pages its
// archived public posts (GET /channels/{forum}/threads/archived/public, newest archive first, `before` = an
// ISO timestamp) down to a horizon: the newest `posts` posts or the last `days` days, whichever is fewer
// (config.discord.bridge.forumBackfill, default { posts: 200, days: 90 }). Each taken post is upserted and
// its messages reconciled like a channel.
//
// A post holt stored but Discord no longer lists is tombstoned only after a COMPLETE pass (the archived
// listing ran out before the horizon): with a truncated listing, an unlisted post may just be older.
//
// What this does not do: talk to Discord. The bot (discord-bridge-bot.ts) runs the requests.

export interface ForumBackfill {
  posts: number
  days: number
}

export const DEFAULT_FORUM_BACKFILL: ForumBackfill = { posts: 200, days: 90 }
const MAX_POSTS = 1000
const MAX_DAYS = 3650

// config.discord.bridge.forumBackfill → a bounded horizon (defaults for anything missing or invalid).
export function resolveForumBackfill(raw: unknown): ForumBackfill {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const int = (v: unknown, fallback: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.min(Math.floor(v), max) : fallback
  return { posts: int(o.posts, DEFAULT_FORUM_BACKFILL.posts, MAX_POSTS), days: int(o.days, DEFAULT_FORUM_BACKFILL.days, MAX_DAYS) }
}

const DAY_MS = 24 * 60 * 60 * 1000

export interface ActiveThread {
  id: string
}

// Active posts to take: all of them up to the post cap, newest first (snowflake order). Ids are
// compared as (length, text), which is numeric order for decimal snowflakes.
export function planActivePosts(active: ActiveThread[], horizon: ForumBackfill): string[] {
  return [...active]
    .sort((a, b) => (b.id.length - a.id.length) || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0))
    .slice(0, horizon.posts)
    .map((t) => t.id)
}

export interface ArchivedThread {
  id: string
  // thread_metadata.archive_timestamp in ms (null when Discord gave none).
  archiveTimestamp: number | null
}

export interface ArchivedPagePlan {
  // Ids of this page to take, in page order.
  take: string[]
  // `before` for the next page, or null to stop.
  next: Date | null
  // The listing ran out inside the horizon: every archived post was seen.
  complete: boolean
}

// One page of the archived listing. `taken` = posts already taken this pass (active ones included);
// `page` is in Discord's order (archive_timestamp descending).
export function planArchivedPage(input: {
  taken: number
  page: ArchivedThread[]
  hasMore: boolean
  horizon: ForumBackfill
  nowMs: number
}): ArchivedPagePlan {
  const cutoff = input.nowMs - input.horizon.days * DAY_MS
  let room = Math.max(0, input.horizon.posts - input.taken)
  const take: string[] = []
  let truncated = false
  for (const t of input.page) {
    if (room <= 0 || (t.archiveTimestamp !== null && t.archiveTimestamp < cutoff)) {
      truncated = true
      break
    }
    take.push(t.id)
    room--
  }
  if (truncated) return { take, next: null, complete: false }
  if (!input.hasMore || !input.page.length) return { take, next: null, complete: true }
  if (room <= 0) return { take, next: null, complete: false }
  const last = input.page[input.page.length - 1].archiveTimestamp
  // Without a timestamp there is no cursor to page from (Discord pages by archive time).
  return last === null ? { take, next: null, complete: false } : { take, next: new Date(last), complete: false }
}

// Stored live posts of the forum that Discord no longer lists: tombstone them only after a complete pass.
export function postsToTombstone(stored: string[], seen: ReadonlySet<string>, complete: boolean): string[] {
  return complete ? stored.filter((id) => !seen.has(id)) : []
}
