# Forum channels: server ↔ chatbox contract

The one interface between the server work (database, bot, permissions, chat API, realtime) and the
chatbox work (forum view, post cards, composer, open post). Both sides build to this; neither changes it
without updating this file. Background: `discord-api.md` (§7 plan), `discord-ui.md` + `discord-forum.css`.

## Owner decisions (2026-10-24)

- Replying in an archived post is allowed and unarchives it, like Discord. Locked posts are read-only for
  everyone except staff.
- First sync of a forum loads the newest 200 posts or the last 90 days, whichever is fewer (tunable:
  `discord.bridge.forumBackfill = { posts: 200, days: 90 }`, default those values, no parity needed).
- Media channels (type 16) are supported but off unless `discord.bridge.mediaChannels: true`.
- Technical (from the research recommendations): `discord_bridge_message.channel_id` = the thread id for
  post messages; new `discord_bridge_post` table; a pending web post's starter row uses
  `channel_id = 'post:<post id>'` until the webhook returns the thread; new chat bit `SEND_IN_POSTS`.

## Ids

- A **forum** is a bridged channel with `type` 15 (or 16). It has no messages of its own.
- A **post** is a Discord thread in a forum. Its id is the thread id (snowflake string). A web-created post
  that has not reached Discord yet has the id `post:<n>`; `bridge.post.delivered` re-keys it.
- Messages in a post are ordinary `BridgeMessage`s whose `channelId` is the post id. The post's first
  message (the starter) has `discordMessageId === <thread id>` and `starter: true`.

## `GET channels?guild=` (existing, extended)

Every channel row gains `type` (0, 5, 15, 16; the fallback path no longer hardcodes 0). Forum rows also have:

```ts
forum?: {
  availableTags: Array<{ id: string; name: string; moderated: boolean; emoji: { id: string | null; name: string | null } | null }>
  defaultReactionEmoji: { id: string | null; name: string | null } | null
  defaultSortOrder: 0 | 1 | null      // 0 latest activity, 1 creation date, null = not set (activity)
  defaultLayout: 0 | 1 | 2            // 0 not set (list), 1 list, 2 gallery
  requireTag: boolean                 // flag REQUIRE_TAG (16)
  guidelines: string                  // the forum topic (markdown, up to 4096 chars)
  media: boolean                      // type 16
}
```

`lastMessageId` for a forum = the newest message id in any of its posts (unread dot).

## `GET posts?channel=<forum id>&sort=activity|created&tags=<id,id>&match=some|all&q=<text>&before=<cursor>&limit=<1-50>`

VIEW-gated on the forum (same gate as `history`). Sealed with `writeSealedJson` like `channels`; the client
fetches it with `cryptoFetch`. Pinned posts come first on the first page only. Default limit 25.

```ts
{ posts: ForumPost[]; nextCursor: string | null; total: number }

interface ForumPost {
  id: string                      // thread id, or 'post:<n>' while pending
  forumId: string
  guildId: string
  name: string
  ownerKey: string                // 'discord:<id>' | 'abulxt:<n>' | '<ns>:<subject>'
  ownerName: string
  ownerAvatar: string | null
  ownerColor: string | null
  appliedTags: string[]           // tag ids, in Discord's order
  pinned: boolean
  archived: boolean
  locked: boolean
  pending: boolean                // web post not yet on Discord
  messageCount: number            // replies (excludes the starter), counted from holt's rows
  lastMessageId: number | null    // newest bridge message id in the post (unread / "(N New)")
  lastActivityAt: string          // ISO
  createdAt: string               // ISO
  starter: {
    messageId: number | null      // bridge id of the starter, null if not synced yet
    content: string               // first 300 chars, raw markdown
    image: string | null          // first image attachment or embed thumbnail URL (gallery / thumbnail)
    reactions: Array<{ emoji: string; count: number }>   // the starter's reactions (card shows the top one)
  }
}
```

## `POST post` (new) — create a post

Body `{ channelId: <forum id>, name: string (1-100), content: string (1-2000: the webhook message limit; a
longer body is refused with 50035, not truncated; may be empty only with attachments later), appliedTags:
string[] (≤5), clientId: string }`. Write gate action `post-create`:
everything `send` checks, plus SEND_IN_POSTS-independent forum checks: `requireTag` → ≥1 tag, tags ⊂
`availableTags`, `moderated` tags staff only. Rate-limited separately from `send`. Idempotent on
`clientId`. Response `201 { post: ForumPost, message: BridgeMessage }`. Errors follow Discord codes:
`40067` (a tag is required), `10087` (unknown tag), `50013` (missing permissions), `50035` (invalid name).

## Replies and everything else inside a post

Existing routes with `channel = <post id>` / `channelId = <post id>`: `history`, `send`, `edit`, `react`,
`delete`, `typing`, `pins`, `pin`, `search`, `members`, `perms`, `forward`, `suppress-embeds`. The server
resolves the post to its forum for every gate, overwrite, timeout and ban. Sending to a `post:<n>` id is
409 (`{ error: 'This post has not reached Discord yet.' }`).

`perms?channel=<forum id or post id>` gains:

```ts
canCreatePost: boolean   // forum: SEND_MESSAGES on the forum (+ everything send needs)
canReply: boolean        // post: SEND_IN_POSTS (Discord SEND_MESSAGES_IN_THREADS) and not locked (staff bypass)
canManagePosts: boolean  // staff: lock/unlock, pin/unpin, archive, edit tags, rename, delete any post
post?: { id: string; forumId: string; locked: boolean; archived: boolean; pinned: boolean; ownerKey: string }
```

`canSend` on a post id = `canReply`; on a forum id = false (a forum takes no messages).

## `POST post-moderate` (new)

`{ postId, action: 'lock' | 'unlock' | 'pin' | 'unpin' | 'archive' | 'unarchive' | 'tags' | 'rename' |
'delete', appliedTags?: string[], name?: string }`. Staff (`canManagePosts`) for everything; the post's
owner may also `rename`, `tags`, `archive`/`unarchive` and `delete` their own post (Discord lets a post
owner edit title/tags and close it). Performed on Discord with the bot token; the result comes back
through the gateway as `bridge.post.updated` / `bridge.post.deleted`. Response `200 { post }` or
`200 { deleted: true }`.

## Realtime (`/api/rt`, bridge events)

All carry `guildId` (stamped as today) and `channelId = <forum id>`; visibility is the forum's.

- `bridge.post.created { channelId, post: ForumPost }`
- `bridge.post.updated { channelId, post: ForumPost }` (name, tags, pin, lock, archive, counts, activity)
- `bridge.post.deleted { channelId, postId }`
- `bridge.post.delivered { channelId, pendingId: 'post:<n>', post: ForumPost }` (pending → thread id)

Message events in a post (`bridge.message`, `bridge.message.updated`, deletes, reactions, typing) keep
their shapes, with `channelId = <post id>` and an added `forumId`. Visibility checks map post → forum.

## Chatbox behaviour (UI side)

- Sidebar: forum rows use Discord's forum icon (`discord-ui.md` §sidebar icon); clicking opens the forum
  view, not a message list.
- Forum view: Discord's layout from `discord-ui.md`: header card (search, Post Guidelines from
  `guidelines`), "Sort & View" menu (Recently Active / Date Posted, List / Gallery, tag Match Some / All,
  Reset to default; persisted per forum in localStorage), tag filter row, post list (or gallery for
  `defaultLayout: 2` / user choice), "Older Posts" paging via `nextCursor`, empty and no-access states.
- New post: Discord's composer ("New Post"): title, body (the existing rich composer), tag picker (≤5,
  required error when `requireTag`), disabled with Discord's wording when `!canCreatePost`.
- Open post: the existing message view, scoped to the post id, with the post title as the header
  breadcrumb (forum › post), tags, and staff/owner actions from `post-moderate`. Locked/archived banners
  as Discord words them. Composer uses `canReply`.
- Live: apply `bridge.post.*` to the list; re-key pending posts on `delivered`; unread "(N New)" from
  `lastMessageId` vs the client's read marker.
- Every new visible string wrapped (HolyText / useHolyAttr), per abulxt `HOLYTEXT.md`.

## Server notes (additive, 2026-10-24)

- Write errors inside a post use Discord's codes: `160005` (post locked, caller not staff: send, forward,
  typing, edit), `50083` (post archived: edit, react; replies are allowed and unarchive it), `40058` (a
  message sent straight to a forum id). Deleting your own message in a locked *and* archived post is
  `160005`.
- `bridge.post.deleted` may carry `failed: true, code` when Discord refused a pending web post for good
  (`40067`, `10087`, `40066`, `160006`, `50035`); the post and its starter are dropped. A refused reply
  (`160005`, `50083`, `10003`, `50001`) is removed with `bridge.message.deleted { ..., failed: true, code }`.
- Deleting a pending post's starter (`POST delete`) withdraws the post (`bridge.post.deleted`).
- After a forum reconcile pass that changed anything, the bot emits `bridge.channel.resync { channelId:
  <forum id> }` (refetch the post list) instead of one `bridge.post.*` event per post.
- `GET search` covers posts: a viewable forum's posts are searched, `channel_id` may name a forum (all its
  posts) or a post, and each `channels` entry for a post carries `forumId`.
- `GET posts` with no `sort` uses the forum's `defaultSortOrder`; an unreadable `before` cursor is 400.
- Bridge webhook overwrites: the one "send" bit also covers replying in posts (`SEND_IN_POSTS`, chat bit
  `1 << 9`, granted to members by default).
- `canManagePosts` = any chat moderation bit (TIMEOUT, BAN or MANAGE_WEBHOOKS), the MANAGE_THREADS analogue.
