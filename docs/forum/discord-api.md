# Discord forum and media channels: API reference for the holt bridge

Research notes for bridging Discord forum (type 15) and media (type 16) channels
into the holt chatbox. Written 2026-10-24 against discord.js **14.27.0**
(installed in `main/node_modules`; `main/package.json` pins `^14.26.4`) and
discord-api-types **0.38.57**.

**Sources.** The `discord.com/developers/docs/*` pages now 301-redirect to
`docs.discord.com/developers/*`. Field tables below come from those pages. The
raw Markdown is in the `discord/discord-api-docs` repo under `developers/`, and
it was read on 2026-10-24. The page abbreviations used throughout:

| Abbrev | Page |
|---|---|
| **[CH]** | https://docs.discord.com/developers/resources/channel |
| **[TH]** | https://docs.discord.com/developers/topics/threads |
| **[WH]** | https://docs.discord.com/developers/resources/webhook |
| **[MSG]** | https://docs.discord.com/developers/resources/message |
| **[GLD]** | https://docs.discord.com/developers/resources/guild |
| **[GWE]** | https://docs.discord.com/developers/events/gateway-events |
| **[GW]** | https://docs.discord.com/developers/events/gateway (intents) |
| **[PERM]** | https://docs.discord.com/developers/topics/permissions |
| **[RL]** | https://docs.discord.com/developers/topics/rate-limits |
| **[CODES]** | https://docs.discord.com/developers/topics/opcodes-and-status-codes |
| **[CL]** | https://docs.discord.com/developers/change-log |

The text marks anything that is inferred or unverified rather than documented.

---

## 0. The model in one paragraph

A forum or media channel holds **only threads**. Each thread is a **post**: a
`PUBLIC_THREAD` (type 11) whose `parent_id` is the forum. Creating a post also
creates its first message, the **starter message**, and that message has the
**same id as the thread**. Messages cannot be sent to the forum channel itself
(error `40058 Cannot send a message in a forum channel` [CODES]). Every reply in a
post is an ordinary message whose `channel_id` is the thread id. Threads have
no permission overwrites of their own; they inherit the forum's. The gateway
syncs only **active** threads. **Archived** posts have to be paged in over REST.

> "A `GUILD_FORUM` (type `15`) channel is similar to a `GUILD_TEXT` channel, except *only* threads can be created in them. Unless otherwise noted, threads in forum channels behave in the same way as in text channels—meaning they use the same endpoints and receive the same Gateway events. Messages cannot be sent directly in forum channels." [TH#forums]

---

## 1. Forum / media channel object

### 1.1 Channel types [CH#channel-object-channel-types]

| Type | ID | Description |
|---|---|---|
| `GUILD_TEXT` | 0 | text channel |
| `GUILD_ANNOUNCEMENT` | 5 | announcement channel |
| `ANNOUNCEMENT_THREAD` | 10 | thread in a GUILD_ANNOUNCEMENT channel |
| `PUBLIC_THREAD` | 11 | "a temporary sub-channel within a GUILD_TEXT or GUILD_FORUM channel". **Forum and media posts are this type.** |
| `PRIVATE_THREAD` | 12 | text channels only |
| `GUILD_FORUM` | 15 | "Channel that can only contain threads" |
| `GUILD_MEDIA` | 16 | "Channel that can only contain threads, similar to `GUILD_FORUM` channels" |

discord.js: `ChannelType.GuildForum` (15), `ChannelType.GuildMedia` (16),
`ChannelType.PublicThread` (11), `ChannelType.AnnouncementThread` (10),
`ChannelType.PrivateThread` (12).

### 1.2 Forum-relevant channel fields [CH#channel-object-channel-structure]

| Field | Type | Meaning on a forum or media channel |
|---|---|---|
| `topic?` | ?string | **0-4096 chars** for `GUILD_FORUM`/`GUILD_MEDIA` (0-1024 for other channels). "The `topic` field is what is shown in the 'Guidelines' section within the Discord client." [TH]. Supports bulleted lists and headings [TH#forum-and-media-channel-formatting]. |
| `last_message_id?` | ?snowflake | For forums this is "the ID of the most recently created **thread**". No `CHANNEL_UPDATE` is sent when it changes. Update it from `THREAD_CREATE` [TH]. |
| `rate_limit_per_user?` | integer | On a forum this limits **how often posts are created**, 0-21600 s. Bots and `BYPASS_SLOWMODE` holders are exempt. |
| `default_thread_rate_limit_per_user?` | integer | Initial `rate_limit_per_user` for new posts, i.e. the slowmode **inside** a post. "copied to the thread at creation time and does not live update." |
| `default_auto_archive_duration?` | integer | 60, 1440, 4320 or 10080 minutes. Clients use it to preselect `auto_archive_duration`; the API does not apply it. |
| `available_tags?` | array of tag objects | "the set of tags that can be used in a `GUILD_FORUM` or a `GUILD_MEDIA` channel". **At most 20** (Modify Channel) [CH#modify-channel]. Error `30048` when exceeded [CODES]. |
| `default_reaction_emoji?` | ?default reaction object | "the emoji to show in the add reaction button on a thread in a `GUILD_FORUM` or a `GUILD_MEDIA` channel" |
| `default_sort_order?` | ?integer | Sort Order Type (below). **`null` = not set by an admin.** |
| `default_forum_layout?` | integer | Forum Layout Type (below). `GUILD_FORUM` only. **`0` = not set.** |
| `flags?` | integer | Channel flags bitfield (below). |
| `permission_overwrites?` | array | These are the forum's overwrites, and **they apply to every post** (see §5). |
| `nsfw?` | boolean | Threads inherit it from the parent; they don't set `nsfw` themselves [TH#age-restricted-threads]. |

#### Forum Tag object [CH#forum-tag-object]

| Field | Type | Description |
|---|---|---|
| `id` | snowflake | the id of the tag |
| `name` | string | the name of the tag (**0-20 characters**) |
| `moderated` | boolean | "whether this tag can only be added to or removed from threads by a member with the `MANAGE_THREADS` permission" |
| `emoji_id` | ?snowflake | a guild custom emoji id |
| `emoji_name` | ?string | a unicode emoji |

At most one of `emoji_id` and `emoji_name` is non-null. When updating, a tag needs
only `name`. discord.js: `GuildForumTag { id, name, moderated, emoji: { id, name } | null }`.

#### Default Reaction object [CH#default-reaction-object]

| Field | Type | Description |
|---|---|---|
| `emoji_id` | ?snowflake | a guild custom emoji id |
| `emoji_name` | ?string | a unicode emoji |

"Exactly one of `emoji_id` and `emoji_name` must be set."
discord.js: `DefaultReactionEmoji { id: Snowflake | null; name: string | null }`.

#### Sort Order Types [CH#channel-object-sort-order-types]

| Name | Value | Description |
|---|---|---|
| `LATEST_ACTIVITY` | 0 | Sort forum posts by activity |
| `CREATION_DATE` | 1 | Sort forum posts by creation time (from most recent to oldest) |

#### Forum Layout Types [CH#channel-object-forum-layout-types]

| Name | Value | Description |
|---|---|---|
| `NOT_SET` | 0 | No default has been set for forum channel |
| `LIST_VIEW` | 1 | Display posts as a list |
| `GALLERY_VIEW` | 2 | Display posts as a collection of tiles |

#### Channel Flags [CH#channel-object-channel-flags]

| Flag | Value | Applies to | Description |
|---|---|---|---|
| `PINNED` | `1 << 1` (2) | a **post** (thread) | "this thread is pinned to the top of its parent `GUILD_FORUM` or `GUILD_MEDIA` channel" |
| `REQUIRE_TAG` | `1 << 4` (16) | the forum or media channel | "a tag is required to be specified when creating a thread … Tags are specified in the `applied_tags` field." |
| `HIDE_MEDIA_DOWNLOAD_OPTIONS` | `1 << 15` (32768) | media channel | "hides the embedded media download options. Available only for media channels" |
| `CHANNEL_OBFUSCATED` | `1 << 17` | any (gateway only) | the bot cannot view this channel; metadata is redacted (see §6.8) |
| `IS_SPOILER_CHANNEL` | `1 << 21` | textual guild channels | users must opt in to view it |

discord-api-types names: `ChannelFlags.Pinned = 2`, `RequireTag = 16`,
`HideMediaDownloadOptions = 32768`.

### 1.3 Media channel differences

- Media channels work like forums: "Unless otherwise noted, threads in media
  channels behave in the same way as in forum channels - meaning they use the
  same endpoints and receive the same Gateway events." [TH#media-channels]
- Documented differences: `default_forum_layout` is `GUILD_FORUM` only (Modify
  Channel lists it for "Forum" only), and `HIDE_MEDIA_DOWNLOAD_OPTIONS` is media
  only. Everything else, including tags, `default_reaction_emoji`,
  `default_sort_order`, `REQUIRE_TAG` and the post endpoints, applies to both.
- The docs carry a warning: "`GUILD_MEDIA` channels are in beta and still being
  actively developed. The API and other technical details are subject to change."
  and "Avoid implementing any features that are not documented here" [CH, TH].
- Inferred from the Help Center description, not stated in the API docs: media
  posts are expected to carry an attachment. The API documents no rule that
  enforces this. The bridge should not assume a server-side requirement.

### 1.4 discord.js: `ForumChannel` / `MediaChannel`

Both extend the abstract `ThreadOnlyChannel extends GuildChannel`
(typings/index.d.ts):

```
type: ChannelType.GuildForum | ChannelType.GuildMedia
threads: GuildForumThreadManager
availableTags: GuildForumTag[]
defaultReactionEmoji: DefaultReactionEmoji | null
defaultThreadRateLimitPerUser: number | null
rateLimitPerUser: number | null
defaultAutoArchiveDuration: ThreadAutoArchiveDuration | null
nsfw: boolean
topic: string | null
defaultSortOrder: SortOrderType | null
ForumChannel only: defaultForumLayout: ForumLayoutType
flags (from GuildChannel): ChannelFlagsBitField
```

`ThreadOnlyChannel` has the webhook methods (`createWebhook`, `fetchWebhooks`)
but **not** `send`, `messages`, `sendTyping` or `bulkDelete`. Its interface
`Omit`s them from `TextBasedChannelFields`. Type guard: `channel.isThreadOnly()`.

---

## 2. Posts = threads

### 2.1 Thread fields [CH#channel-object, TH#thread-fields]

| Field | Meaning for a post |
|---|---|
| `id` | the post id, **equal to the starter message id** |
| `type` | `11` (`PUBLIC_THREAD`). "The type of the created thread is `PUBLIC_THREAD`" [CH#start-thread-in-forum-or-media-channel]. |
| `parent_id` | the forum or media channel id |
| `owner_id` | "id of the creator of the … thread". For webhook-created posts, the owner is presumably the webhook's id, as webhook messages have `author.id = webhook id`. This is **not documented**; verify it live. |
| `name` | the post title, 1-100 chars |
| `last_message_id` | the latest message in the post. **Not** updated through `THREAD_UPDATE`; track it from `MESSAGE_CREATE` [GWE#thread-update]. |
| `rate_limit_per_user` | slowmode inside the post, copied from the forum's `default_thread_rate_limit_per_user` |
| `flags` | `PINNED` (`1 << 1`) |
| `applied_tags` | "array of snowflakes": tag ids from the parent's `available_tags`. **Limited to 5** (Modify Thread) [CH#modify-channel-json-params-thread]. |
| `message_count` | "number of messages (**not including the initial message** or deleted messages) in a thread" |
| `total_message_sent` | "number of messages ever sent in a thread … will not decrement the number when a message is deleted" |
| `member_count` | "an approximate count of users in a thread, stops counting at 50". [TH] says it is "only used in our UI, so it is not valuable to bots". |
| `thread_metadata` | see below |
| `member?` | the bot's own thread member object, on certain endpoints only |
| `last_pin_timestamp` | as for channels (pinned *messages* inside the post) |

**Counter caveats.**
- Threads created before 2022-07-01 have inaccurate counts above 50.
- No `CHANNEL_UPDATE` or `THREAD_UPDATE` is sent when the counters change. "apps
  should update those values when receiving corresponding events" (i.e.
  `MESSAGE_CREATE` / `MESSAGE_DELETE` / `MESSAGE_DELETE_BULK`)
  [TH#forum-and-media-channel-thread-fields].
- **The docs contradict themselves on `total_message_sent` in thread-only
  channels.** The Channel object says it never decrements. The forum section of
  [TH] says both `message_count` and `total_message_sent` "decrement on
  `MESSAGE_DELETE` and `MESSAGE_DELETE_BULK`". holt should use its own row counts
  and treat Discord's counters as hints.
- Messages also have a `position?` field: "A generally increasing integer (there
  may be gaps or duplicates) that represents the approximate position of the
  message in a thread" [MSG].

#### Thread Metadata object [CH#thread-metadata-object]

| Field | Type | Description |
|---|---|---|
| `archived` | boolean | whether the thread is archived |
| `auto_archive_duration` | integer | "the thread will stop showing in the channel list after `auto_archive_duration` minutes of inactivity": 60, 1440, 4320, 10080 |
| `archive_timestamp` | ISO8601 | when the archive status last changed. It also changes on create and when `auto_archive_duration` changes [TH]. |
| `locked` | boolean | "when a thread is locked, only users with MANAGE_THREADS can unarchive it" |
| `invitable?` | boolean | private threads only (n/a for posts) |
| `create_timestamp?` | ?ISO8601 | thread creation time, "only populated for threads created after 2022-01-09" |

Since 2023-03-06 a thread can be `locked` without being `archived` [CL "Update
to Locked Threads"].

#### Thread Member object [CH#thread-member-object]

`id?` (thread id), `user_id?`, `join_timestamp`, `flags` (notification
settings), and `member?` (guild member, only with `with_member=true` on List or
Get Thread Member). The bridge does not need it.

### 2.2 The starter message

- "when creating threads in a threads-only channel, a message is created that
  has the same ID as the thread which requires you to pass parameters for both a
  thread *and* a message." [TH#creating-threads-in-forum-and-media-channels]
- The starter message lives **in the thread**: its `channel_id` is the thread id.
  It is fetched with `GET /channels/{thread.id}/messages/{thread.id}`.
  discord.js `ThreadChannel.fetchStarterMessage()` does exactly this for
  thread-only parents. For text-channel threads it fetches from the parent
  instead (`src/structures/ThreadChannel.js:320`).
- Inferred from [TH#new-message-types]: the starter message's type is `DEFAULT`
  (0), not `THREAD_STARTER_MESSAGE` (21). Type 21 is "sent as the first message
  in threads that are started from an existing message in the parent channel",
  and forum posts aren't started that way.
- The starter message is excluded from `message_count`. Reply count =
  `message_count`.
- The starter message can be **deleted** while the thread survives. Discord
  shows the post with its original message missing. This is the forum version
  of the "orphaned" public thread that [TH#public-and-private-threads]
  describes. Edits to the starter message arrive as plain `MESSAGE_UPDATE`.
- In thread-only channels "the first message in a thread and the channel topic
  can both contain markdown for bulleted lists and headings (unlike text
  channels)" [TH].

### 2.3 Pinned posts

- "A thread that is pinned will have the `(1 << 1)` flag set, and archiving that
  thread will unset the flag. A pinned thread will *not* auto-archive."
  [TH#forum-and-media-channel-thread-fields]
- Set it through Modify Thread `flags`. "`PINNED` can only be set for threads in
  forum and media channels" [CH#modify-channel-json-params-thread]. This needs
  `MANAGE_THREADS`.
- Error `30047 Maximum number of pinned threads in a forum channel has been
  reached` [CODES]. The cap is not given; the Discord client allows one pinned
  post (client behavior, unverified for the API).
- discord.js: `thread.flags.has(ChannelFlags.Pinned)`, `thread.pin()`,
  `thread.unpin()`. These are typed to forum threads only.
- Post pinning (a thread flag) and **message** pins inside a post
  (`PIN_MESSAGES`, `last_pin_timestamp`) are separate things.

### 2.4 discord.js `ThreadChannel`

Relevant members (typings/index.d.ts, `class ThreadChannel<ThreadOnly>`):

```
archived, archiveTimestamp, archivedAt, autoArchiveDuration, locked,
createdTimestamp (thread_metadata.create_timestamp), flags, appliedTags: Snowflake[],
messageCount, totalMessageSent, memberCount, ownerId, parentId,
parent: ForumChannel | MediaChannel (when ThreadOnly), rateLimitPerUser, type,
messages (MessageManager), sendable, unarchivable, manageable, viewable,
fetchStarterMessage(), fetchOwner(), setArchived(), setLocked(), setName(),
setAppliedTags(), pin(), unpin(), edit({ name, archived, autoArchiveDuration,
locked, rateLimitPerUser, appliedTags, flags }), delete()
```

`thread.permissionsFor(x)` delegates to `this.parent.permissionsFor(x)`
(`ThreadChannel.js:283`). Threads have no overwrites of their own.

---

## 3. Creating posts and replying

### 3.1 Start Thread in Forum or Media Channel (bot token)

`POST /channels/{channel.id}/threads` [CH#start-thread-in-forum-or-media-channel]

> Creates a new thread in a forum or a media channel, and sends a message within the created thread. Returns a channel, with a nested message object, on success, and a 400 BAD REQUEST on invalid parameters. Fires a Thread Create and Message Create Gateway event.

- The created thread is `PUBLIC_THREAD`.
- "The current user must have the `SEND_MESSAGES` permission
  (`CREATE_PUBLIC_THREADS` is ignored)."
- Max request size 25 MiB. Supports `X-Audit-Log-Reason`.

JSON/Form params:

| Field | Type | Description |
|---|---|---|
| `name` | string | 1-100 character channel name |
| `auto_archive_duration?` | integer | 60, 1440, 4320, 10080 |
| `rate_limit_per_user?` | ?integer | 0-21600 |
| `message` | forum thread message params | contents of the first message |
| `applied_tags?` | array of snowflakes | tag ids to apply |
| `files[n]?` | file contents | multipart |
| `payload_json?` | string | multipart only |

Forum and Media Thread Message Params: `content?` (≤2000), `embeds?` (≤10,
≤6000 chars), `allowed_mentions?`, `components?`, `sticker_ids?` (≤3),
`attachments?`, `flags?` (only `SUPPRESS_EMBEDS`, `SUPPRESS_NOTIFICATIONS`). At
least one of content, embeds, sticker_ids, components or files is required.

discord.js: `forum.threads.create({ name, autoArchiveDuration?,
rateLimitPerUser?, reason?, message: { content, embeds, files, allowedMentions,
flags, stickers }, appliedTags? })` returns a `ForumThreadChannel`
(`GuildForumThreadManager.create`).

### 3.2 Via webhook: Execute Webhook (what holt would use)

`POST /webhooks/{webhook.id}/{webhook.token}` [WH#execute-webhook]

> If the webhook channel is a forum or media channel, you must provide either `thread_id` in the query string params, or `thread_name` in the JSON/form params. If `thread_id` is provided, the message will send in that thread. If `thread_name` is provided, a thread with that name will be created in the channel.

Query string:

| Field | Type | Description |
|---|---|---|
| `wait` | boolean | wait for confirmation and return the created message (default `false`) |
| `thread_id` | snowflake | "Send a message to the specified thread within a webhook's channel. **The thread will automatically be unarchived.**" |
| `with_components` | boolean | respect `components` for non-app-owned webhooks |

JSON/Form params relevant to forums (plus the usual `content`, `username`,
`avatar_url`, `tts`, `embeds`, `allowed_mentions`, `components`, `files[n]`,
`payload_json`, `attachments`, `flags`, `poll`):

| Field | Type | Description |
|---|---|---|
| `thread_name` | string | "name of thread to create (requires the webhook channel to be a forum or media channel)" |
| `applied_tags` | array of snowflakes | "array of tag ids to apply to the thread (requires the webhook channel to be a forum or media channel)" |

**Creating a post:** POST to the **forum's** webhook with `thread_name` (+
`applied_tags`) and `?wait=true`. The returned message is the starter message.
Its `id` is the new thread id and so is its `channel_id`. A `THREAD_CREATE`
(with `newly_created: true`) and a `MESSAGE_CREATE` follow over the gateway.

**Replying in a post:** POST to the same forum webhook with `?thread_id=<post
id>&wait=true`. The webhook belongs to the **parent** forum; you cannot create
a webhook on a thread. `thread_id` must be "within a webhook's channel".

**Editing, fetching and deleting webhook messages in a post:** Get, Edit and Delete
Webhook Message (`/webhooks/{id}/{token}/messages/{message.id}`) each take
`?thread_id=` ("id of the thread the message is in") [WH]. Without it the call
targets the webhook's own channel, so it fails for messages inside posts.

Webhook-specific error codes [CODES]:

| Code | Meaning |
|---|---|
| `220001` | Webhooks posted to forum channels must have a thread_name or thread_id |
| `220002` | Webhooks posted to forum channels cannot have both a thread_name and thread_id |
| `220003` | Webhooks can only create threads in forum channels |
| `220004` | Webhook services cannot be used in forum channels (Slack/GitHub-compatible endpoints) |

discord.js `WebhookClient`:
- `send({ threadName, appliedTags, ... })` creates a post.
- `send({ threadId, ... })` replies.
- `editMessage(id, { threadId, ... })`, `fetchMessage(id, { threadId })` and
  `deleteMessage(id, threadId)` handle messages inside posts.

These come from `WebhookMessageCreateOptions`, `WebhookMessageEditOptions` and
`WebhookFetchMessageOptions` in typings/index.d.ts. For holt's raw-REST reply path
(`hook.client.rest.post(Routes.webhook(...))`), add `thread_id` to the `query`
`URLSearchParams`.

Creating a webhook on a forum: `POST /channels/{forum.id}/webhooks` needs
`MANAGE_WEBHOOKS` [WH#create-webhook]. discord.js
`forumChannel.createWebhook({ name })` exists on `ThreadOnlyChannel`. The name
must not contain `clyde` or `discord` and can be up to 80 chars.

### 3.3 Limits summary

| Limit | Value | Source |
|---|---|---|
| Post title (`name` / `thread_name`) | 1-100 chars | [CH] Start Thread in Forum. Execute Webhook gives no length; the same limit is assumed. |
| Tags on a post (`applied_tags`) | ≤ 5 | [CH] Modify Thread |
| Tags defined on a forum (`available_tags`) | ≤ 20 | [CH] Modify Channel; `30048` |
| Tag name | 0-20 chars | [CH] Forum Tag |
| Forum topic (guidelines) | 0-4096 chars | [CH] |
| Message content | ≤ 2000 chars | [WH], [CH] |
| Embeds | ≤ 10, ≤ 6000 chars total | [WH], [CH] |
| Webhook username override | ≤ 80 chars | [WH] Create Webhook (holt already slices to 80) |
| Request size | 25 MiB | [CH] |
| Thread participants | 1000 (`30033`) | [CODES] |
| Active threads per guild | a cap exists; the number is not documented. Error `160006`. | [TH], [CODES] |
| `REQUIRE_TAG` set and no tag sent | `40067 A tag is required to create a forum post in this channel` | [CODES] |
| Only moderated tags exist and caller lacks `MANAGE_THREADS` | `40066 There are no tags available that can be set by non-moderators` | [CODES] |
| Unknown tag id | `10087 Unknown Tag` | [CODES] |

**Unverified:**
- Whether a webhook may apply a `moderated` tag. Webhooks have no permissions
  of their own. Test this before exposing moderated tags to web users.
- Whether `REQUIRE_TAG` is enforced on webhook post creation. Assume it is and
  handle `40067`.

### 3.4 Required permissions for posting

| Action | Discord permission |
|---|---|
| Create a post (bot or user) | `SEND_MESSAGES` on the forum. `CREATE_PUBLIC_THREADS` is ignored [CH], [TH]. |
| Reply in a post | `SEND_MESSAGES_IN_THREADS`. `SEND_MESSAGES` "has no effect in threads" [TH]. |
| Create the forum webhook | `MANAGE_WEBHOOKS` |
| Execute a webhook | none. Anyone holding the token can post, so **holt's own gate is the only check** for web users. |
| Pin/unpin, lock, delete a post, set `rate_limit_per_user` | `MANAGE_THREADS` |
| Rename, archive, change `auto_archive_duration` | `MANAGE_THREADS` or being the thread creator [TH#editing--deleting-threads] |
| Unarchive (`archived: false`) when not locked | Modify Thread: "only the `SEND_MESSAGES` permission is required" [CH] (inside a thread that means the thread-send permission) |

---

## 4. Gateway and fetching

### 4.1 Events [GWE], [TH#gateway-events]

| Event | Payload | Notes |
|---|---|---|
| `GUILD_CREATE` | `threads`: array of channel objects | "All active threads in the guild that current user has permission to view". It does **not** include archived posts. |
| `THREAD_CREATE` | channel object | "Sent when a thread is created, relevant to the current user, or when the current user is added to a thread". Includes `newly_created: true` when actually created. It is also sent when the current user is **added** to an existing thread, so a THREAD_CREATE is not always a new post. |
| `THREAD_UPDATE` | channel object | name, tags, archive/lock, flags (pin). "This is not sent when the field `last_message_id` is altered." Unarchiving sends `THREAD_UPDATE` (full object) and then `THREAD_MEMBER_UPDATE` [TH#unarchiving-a-thread]. |
| `THREAD_DELETE` | `{ id, guild_id, parent_id, type }` | No per-message deletes are documented for a thread delete, so holt must tombstone the post's rows itself (inference). |
| `THREAD_LIST_SYNC` | `{ guild_id, channel_ids?, threads, members }` | "Sent when the current user _gains_ access to a channel". Clear active threads whose `parent_id` is in `channel_ids` (or the whole guild if omitted), then ingest `threads`. |
| `THREAD_MEMBER_UPDATE` | thread member + `guild_id` | the bot's own membership; "unlikely to be used by most bots" |
| `THREAD_MEMBERS_UPDATE` | `{ id, guild_id, member_count, added_members?, removed_member_ids? }` | covers other users only with `GUILD_MEMBERS` |
| `MESSAGE_CREATE` / `UPDATE` / `DELETE` / `DELETE_BULK`, reactions | as in channels | `channel_id` = the **thread id**. Track `last_message_id` and the counters from these. |
| `CHANNEL_CREATE` / `UPDATE` / `DELETE` | for the forum itself | tags, guidelines, flags, overwrites |

**Losing access:** "When an app loses access to a channel, the Gateway does
**not** send it Thread Delete event". The event that changed the permission
(`GUILD_ROLE_UPDATE`, `GUILD_MEMBER_UPDATE`, `CHANNEL_UPDATE`) is sent instead
[TH#losing-access-to-channels].

**Sync scope:** "The Gateway will only sync threads that the app has permission
to view". Apps "will be automatically subscribed to thread events and active
threads" on connect [TH#details-about-thread-access-and-syncing].

### 4.2 Intents [GW#list-of-intents]

| Intent | Events |
|---|---|
| `GUILDS (1 << 0)` | `THREAD_CREATE`, `THREAD_UPDATE`, `THREAD_DELETE`, `THREAD_LIST_SYNC`, `THREAD_MEMBER_UPDATE`, `THREAD_MEMBERS_UPDATE`* (+ the `GUILD_CREATE` `threads` array) |
| `GUILD_MEMBERS (1 << 1)` (privileged) | `THREAD_MEMBERS_UPDATE` for other users |
| `GUILD_MESSAGES (1 << 9)` | messages in posts |
| `GUILD_MESSAGE_REACTIONS (1 << 10)` | reactions in posts |
| `MESSAGE_CONTENT (1 << 15)` (privileged) | content of starter messages and replies |

holt's client (`main/src/server/discord-service.ts:55-62`) already requests
`Guilds`, `GuildMembers`, `GuildMessages`, `GuildMessageReactions` and
`MessageContent`. **No intent changes are needed.** Threads also need gateway
API v9+ [TH#backwards-compatibility]. discord.js v14 uses v10.

### 4.3 Enumerating posts over REST [TH#enumerating-threads]

| Route | Returns |
|---|---|
| `GET /guilds/{guild.id}/threads/active` [GLD#list-active-guild-threads] | `{ threads, members }`: all active threads in the guild the bot can access, ordered by id desc, **no `has_more`** |
| `GET /channels/{channel.id}/threads/archived/public` [CH#list-public-archived-threads] | `{ threads, members, has_more }`: archived public threads, "ordered by `archive_timestamp`, in descending order. **Requires the `READ_MESSAGE_HISTORY` permission.**" Query: `before?` (**ISO8601 timestamp**), `limit?` |
| `GET /channels/{channel.id}/threads/archived/private` | private archived threads (not used by forums) |
| `GET /channels/{thread.id}/messages` | messages in a post (newest first; `before`/`after`/`around`/`limit` ≤100) |
| `GET /channels/{thread.id}/messages/{thread.id}` | the starter message |

`GET /guilds/{guild.id}/channels` "Does not include threads" [GLD]. Neither the
REST guild snapshot nor permission math can find a post by id there.

**Archived post backfill:** page `/threads/archived/public` with `before = last
page's oldest archive_timestamp` until `has_more` is false. Archived threads are
"not synced up-front via the gateway" [TH]. Error `50085` = "`before` value is
earlier than the thread creation date" [CODES].

### 4.4 discord.js v14 surface

- **Classes:** `ForumChannel`, `MediaChannel` (both `ThreadOnlyChannel`),
  `ThreadChannel<true>` (= `ForumThreadChannel`), `GuildForumThreadManager`
  (`forum.threads`).
- **Type guards:** `channel.isThread()`, `channel.isThreadOnly()`,
  `channel.type === ChannelType.GuildForum | GuildMedia | PublicThread`.
- **Fetching:**
  - `forum.threads.fetchActive(cache = true)` calls
    `GET /guilds/{id}/threads/active` and **filters to `parentId === forum.id`**
    (`ThreadManager._mapThreads`). It returns `{ threads, members }` with no
    `hasMore`.
  - `forum.threads.fetchArchived({ type: 'public', before, limit }, cache)` calls
    `/threads/archived/public` and returns `{ threads, members, hasMore }`.
    **Gotchas** (`src/managers/ThreadManager.js`):
    - `fetchAll` does **not** auto-paginate. It only switches private listing
      from "joined" to all.
    - For `type: 'public'`, if `before` is a thread id or `ThreadChannel`, the
      timestamp comes from the **cached** thread's `archivedAt`. When that
      thread isn't cached, `before` is silently dropped. **Pass a `Date` or ISO
      string.**
  - `forum.threads.fetch(id)` fetches a single thread.
  - `thread.messages.fetch({ limit, before })` and `thread.fetchStarterMessage()`.
- **Events (ClientEvents):**
  - `threadCreate: [thread, newlyCreated: boolean]` (from `data.newly_created ?? false`)
  - `threadUpdate: [oldThread, newThread]`
  - `threadDelete: [thread]`
  - `threadListSync: [threads, guild]`
  - `threadMemberUpdate: [oldMember, newMember]`
  - `threadMembersUpdate: [addedMembers, removedMembers, thread]`
  - `messageCreate` and the rest, where `message.channel` is the `ThreadChannel`
    and `message.channel.parentId` is the forum.
- **Cache:**
  - Active threads from `GUILD_CREATE` land in `guild.channels.cache` /
    `client.channels.cache`.
  - **Default sweeper:** `Options.DefaultSweeperSettings.threads = { interval: 3600,
    lifetime: 14400 }`. Archived threads are evicted from cache 4 h after
    archiving.
  - Without `Partials.Channel`, a gateway event for an uncached channel is
    dropped (`Action.getChannel` → `getPayload` returns `cache.get(id)`). holt
    does not enable `Partials.Channel`.
  - In practice a reply to an archived post first unarchives it and sends
    `THREAD_UPDATE` with the full object, which re-caches it. Some events can
    still be missed. Examples: a reaction on a post evicted from cache, or a
    `MESSAGE_DELETE` in an archived post (deletes are allowed there).
  - Either enable `Partials.Channel` or keep a thread → forum map in the DB and
    fall back to `client.channels.fetch(id)`.

---

## 5. Permissions

### 5.1 Relevant bits [PERM#permissions-bitwise-permission-flags]

| Permission | Value | Description |
|---|---|---|
| `ADD_REACTIONS` | `1 << 6` | add new reactions |
| `VIEW_CHANNEL` | `1 << 10` | view the channel, and so **every post in it** |
| `SEND_MESSAGES` | `1 << 11` | "Allows for sending messages in a channel **and creating threads in a forum** (does not allow sending messages in threads)" |
| `MANAGE_MESSAGES` | `1 << 13` | delete others' messages |
| `EMBED_LINKS` | `1 << 14` | link embeds |
| `ATTACH_FILES` | `1 << 15` | uploads |
| `READ_MESSAGE_HISTORY` | `1 << 16` | read history. Also **required to list archived threads**. |
| `MENTION_EVERYONE` | `1 << 17` | @everyone/@here/all roles |
| `MANAGE_WEBHOOKS` | `1 << 29` | create the forum webhook |
| `MANAGE_THREADS` | `1 << 34` | "deleting and archiving threads, and viewing all private threads". Also lock, pin, set moderated tags, act in locked threads. |
| `CREATE_PUBLIC_THREADS` | `1 << 35` | public/announcement threads in text channels. **Ignored for forum posts.** |
| `CREATE_PRIVATE_THREADS` | `1 << 36` | n/a for forums |
| `SEND_MESSAGES_IN_THREADS` | `1 << 38` | "Allows for sending messages in threads", i.e. **replying in a post** |
| `PIN_MESSAGES` | `1 << 51` | pin messages (inside a post) |
| `BYPASS_SLOWMODE` | `1 << 52` | split from MANAGE_MESSAGES/MANAGE_CHANNEL/MANAGE_THREADS [CL] |

### 5.2 Inheritance [PERM#inherited-permissions-threads], [TH#permissions]

> Threads inherit permissions from the parent channel (the channel they were created in), with one exception: The `SEND_MESSAGES` permission is not inherited; users must have `SEND_MESSAGES_IN_THREADS` to send a message in a thread …
>
> Users must have the `VIEW_CHANNEL` permission to view _any_ threads in the channel, even if they are directly mentioned or added to the thread.

> Threads in thread-only channels have the same permissions behavior as threads in a text channel, inheriting all permissions from the parent channel, with one exception: creating a thread in a thread-only channel only requires the `SEND_MESSAGES` permission. [TH#creating-threads-in-forum-and-media-channels]

What this means in practice:

- Threads have **no `permission_overwrites`**. Compute a post's permissions as
  `computeOverwrites(base, member, forumChannel)` and then read
  `SEND_MESSAGES_IN_THREADS` for replies and `SEND_MESSAGES` for new posts.
  discord.js does the same: `ThreadChannel.permissionsFor` delegates to the
  parent.
- Implicit denies [PERM#implicit-permissions]:
  - Without `VIEW_CHANNEL` on the forum, nothing else applies.
  - Denying `SEND_MESSAGES` implicitly denies `MENTION_EVERYONE`,
    `SEND_TTS_MESSAGES`, `ATTACH_FILES` and `EMBED_LINKS`. The docs state this
    for "text channels". Inside threads Discord's client treats
    `SEND_MESSAGES_IN_THREADS` as the base send permission. The docs don't say
    so explicitly, so treat it as inferred.
- Locked posts: without `MANAGE_THREADS`, users "won't be able to create or
  update messages in locked threads, or update properties like its title or
  tags". Deleting messages and adding or removing reactions in a locked post are
  allowed "*only* … if that thread is also active (un-archived)"
  [TH#locked-threads].
- Archived posts: "Users cannot edit messages, add reactions, use application
  commands, or join archived threads. The only operation that should happen
  within an archived thread is messages being deleted. Sending a message will
  automatically unarchive the thread, unless the thread has been locked by a
  moderator." [TH#active--archived-threads]
- A timed-out member keeps only `VIEW_CHANNEL` and `READ_MESSAGE_HISTORY`
  [PERM].

---

## 6. Rate limits and gotchas for a bridge

1. **Archived post revival.** A webhook reply with `?thread_id=` "will
   automatically be unarchived" [WH]. Any message send unarchives a post "unless
   the thread has been locked by a moderator" [TH]. Replying from the web to an
   old post therefore bumps it back into Discord's active list, and under
   `LATEST_ACTIVITY` sort to the top. Expect a `THREAD_UPDATE` (archived →
   false) right after the delivery. If holt ever lets web users reply to
   archived posts, that is a product decision.
2. **Locked posts.**
   - If a post is `locked` and archived, a webhook reply fails. Discord returns
     `160005 Thread is locked` or `50083` (operation on an archived thread)
     [CODES]. Which one depends on state, so handle both.
   - Gate web replies on `locked && !MANAGE_THREADS` **before** queueing.
     Otherwise the outbox row is stuck undelivered: holt's sweep retries for 10
     minutes, then abandons it.
   - Edits and reactions in archived posts fail with `50083`.
3. **Deleted starter message.**
   - The thread (post) survives. Only `MESSAGE_DELETE` for `id == thread.id`
     arrives, with `channel_id == thread.id`.
   - holt must keep the post row, tombstone just the starter message, and still
     render the post ("original message was deleted").
   - Deleting the **thread** sends only `THREAD_DELETE`. Tombstone every row
     whose `channel_id` is the thread.
4. **Thread delete permissions.**
   - "Deleting a thread requires the `MANAGE_THREADS` permission" [TH]
     (`DELETE /channels/{thread.id}`). A web "delete post" action maps to
     this, not to a message delete.
   - Deleting the starter message with `MANAGE_MESSAGES` leaves the post in
     place.
5. **Gateway only knows active posts.**
   - Startup reconcile must call `GET /guilds/{id}/threads/active` (or
     `fetchActive`) and then page `/threads/archived/public` per forum.
     Otherwise posts that were archived while the bot was offline, and their
     final messages, are never seen.
   - Listing archived posts requires `READ_MESSAGE_HISTORY` on the forum.
6. **`last_message_id` and counters are event-maintained.** Neither
   `CHANNEL_UPDATE` (forum `last_message_id`) nor `THREAD_UPDATE` (post
   `last_message_id`, `message_count`, `total_message_sent`) fires when they
   change [TH], [GWE]. Derive "last activity" and reply counts from holt's own
   rows.
7. **THREAD_CREATE is not always a new post.** It also fires when the bot is
   added to a thread. Use `newly_created` (discord.js `newlyCreated`) to tell
   them apart. Upsert on thread id either way.
8. **Channel obfuscation (breaking, 2026-11-16).**
   - From **November 16, 2026**, channels the bot can't view arrive over the
     gateway with `name: "___hidden___"`, `CHANNEL_OBFUSCATED` (`1 << 17`) and
     a single @everyone VIEW deny overwrite.
   - From the same date, `GET /guilds/{id}/channels` **omits** them [CL "Channel
     Obfuscation for Users and Bots", CH#channel-object-obfuscated-channels].
   - A forum the bot can't view is unbridgeable anyway, but the bridged-set
     resolver must check the flag instead of trusting the name.
   - This affects holt's REST guild snapshot (`discord-channel-access.ts
     fetchSnapshot`) for *all* channel types. It is not specific to forums.
9. **Rate limits [RL].**
   - Per-route buckets are keyed by top-level resource, and webhooks are one of
     those resources (`webhook_id + webhook_token`). `thread_id` is a query
     param, so **every post and reply in one forum shares one webhook bucket**.
   - Read `X-RateLimit-*` headers. Don't hardcode limits; the per-webhook
     numbers are not documented.
   - Global limit is 50 req/s per bot token. Webhook executes are
     authenticated by token in the path; discord.js sends them with
     `auth: false`.
   - Invalid-request limit: 10,000 per 10 min of 401/403/429. "If a webhook
     returns a 404 status you should not attempt to use it again". Recreate
     the webhook instead of retrying.
   - Archived-thread paging during reconcile is one request per 50-ish posts
     per forum (the default page size is not documented). Use holt's existing
     `RECONCILE_PAUSE_MS` style throttling.
10. **Slowmode.** The forum's `rate_limit_per_user` limits post *creation*, and
    each post's `rate_limit_per_user` limits replies. Bots are unaffected [CH].
    Webhooks are not mentioned; in practice webhook messages aren't subject to
    slowmode (unverified). holt's own per-identity limits are what protect the
    forum from web spam, so apply both a post-creation limit and a reply limit.
11. **Webhook cannot be thread-scoped.**
    - You can't create a webhook *on* a post.
    - Execute, edit, fetch and delete all go through the forum's webhook plus
      `thread_id`.
    - holt's "ignore our own webhook deliveries" check has to compare
      `message.webhookId` with the webhook of `message.channel.parentId`, not
      of `message.channelId`.
12. **No messages in the forum itself.**
    - `GET /channels/{forum.id}/messages` is not a message list. Sending to it
      returns `40058`.
    - holt's per-channel reconcile (`channel.messages.fetch`) cannot run
      against a forum; `ThreadOnlyChannel` has no `messages` manager.
13. **Media channel beta.** The API "and other technical details are subject to
    change" [TH]. Ship forums first and gate media channels behind a flag.

---

## 7. Impact on holt

Files read:
- `main/src/server/discord-bridge-bot.ts` (1565 lines)
- `main/src/server/discord-bridge-db.ts` (1444 lines)
- `main/src/server/discord-bridge-api.ts` (2557 lines)
- `schema.sql` (`discord_bridge_*`, migrations 007-037)
- related helpers: `discord-bridge-categories.ts`, `discord-channel-access.ts`,
  `discord-chat-perms.ts`, `events.ts`, `discord-service.ts`

### 7.1 Where forums are excluded today

| Place | What excludes forums |
|---|---|
| `discord-bridge-bot.ts:963` `isBridgeTextChannel` | accepts only `ChannelType.GuildText` / `GuildAnnouncement`. Used by `resolveBridgeSet` for both legacy ids and category children. |
| `discord-bridge-categories.ts:12` `BRIDGEABLE_CHANNEL_TYPES = new Set([0, 5])` | `isBridgeable` / `resolveBridgedChannels` drop types 15/16 |
| `discord-channel-access.ts:62` `RENDERABLE_CHANNEL_TYPES` (0, 5) | `channelAccess()` returns `view:false` for a forum. `buildSidebar` / `visibleSidebar` hide it. Onboarding (`discord-onboarding-api.ts:231,237`) skips it. |
| `discord-bridge-bot.ts:49` `type BridgeTextChannel = TextChannel \| NewsChannel` | `runtime.channels`, `ensureWebhook`, `reconcileChannel` and `applyBridgeSetOnce` are typed to text channels |
| Every gateway handler (`messageCreate:1326`, `messageUpdate:1403`, `messageDelete:1467`, `messageReactionAdd:1482`, `messageReactionRemove:1499`) | `runtime.channels.has(message.channelId)` is false for a thread id, so post messages are dropped |
| `discord-bridge-api.ts` `/channels` fallback (~line 1066) | hardcodes `type: 0` |

### 7.2 Identity and keying decision

Discord's own model is `message.channel_id = thread id`. Recommendation: **keep
`discord_bridge_message.channel_id` = the Discord channel the message lives
in.** For post messages that is the thread id.

This way, everything keyed by `channel_id` works unchanged for posts:
- `history`, `historyWindow`, `discordRowsInWindow`, `lastMessageIds`
- `byDiscordMessageId`, `recordMessage` dedupe
- the `(channel_id, id DESC)` index, reactions and search

What changes is the **scope resolution**. Every gate, overwrite, timeout, ban
and guild lookup that takes a `channelId` must map a thread id to its forum
first. This needs a new `discord_bridge_post` table (thread id → forum id).

The alternative is `channel_id = forum id` plus a `thread_id` column. It would
need a `thread_id` predicate in every history and window query, and it would
diverge from Discord's ids in links and replies. Not recommended.

### 7.3 Numbered implementation plan

**Schema (`schema.sql`, new migration `038_discord_bridge_forums`; never edit
007-037)**

1. `ALTER TABLE discord_bridge_channel ADD COLUMN IF NOT EXISTS type SMALLINT
   NOT NULL DEFAULT 0`, then add forum metadata columns:
   - `available_tags JSONB NOT NULL DEFAULT '[]'` (`[{id,name,moderated,emoji_id,emoji_name}]`)
   - `default_reaction_emoji JSONB`
   - `default_sort_order SMALLINT`, nullable (null = not set)
   - `default_forum_layout SMALLINT NOT NULL DEFAULT 0`
   - `flags INT NOT NULL DEFAULT 0` (`REQUIRE_TAG` 16, `HIDE_MEDIA_DOWNLOAD_OPTIONS` 32768)
   - `default_thread_rate_limit_per_user INT NOT NULL DEFAULT 0`
   - `rate_limit_per_user INT NOT NULL DEFAULT 0`

   `topic` already exists. Widen nothing (TEXT), but the API should treat the
   topic as ≤4096 chars of guidelines markdown for forums.
2. `CREATE TABLE IF NOT EXISTS discord_bridge_post` with these columns:
   - `id BIGSERIAL PRIMARY KEY`
   - `thread_id TEXT UNIQUE` (NULL while a web-created post is pending delivery)
   - `channel_id TEXT NOT NULL` (the forum)
   - `guild_id TEXT NOT NULL`
   - `name TEXT NOT NULL`
   - `owner_key TEXT NOT NULL` (`discord:<id>` / `abulxt:<id>`, as `author_key`)
   - `applied_tags TEXT[] NOT NULL DEFAULT '{}'`
   - `flags INT NOT NULL DEFAULT 0` (PINNED = 2)
   - `archived BOOLEAN NOT NULL DEFAULT FALSE`
   - `locked BOOLEAN NOT NULL DEFAULT FALSE`
   - `auto_archive_duration INT`
   - `archive_timestamp TIMESTAMPTZ`
   - `rate_limit_per_user INT NOT NULL DEFAULT 0`
   - `message_count INT NOT NULL DEFAULT 0`
   - `total_message_sent INT NOT NULL DEFAULT 0` (both are Discord hints only, see §2.1)
   - `last_message_id TEXT`
   - `last_activity_at TIMESTAMPTZ`
   - `direction TEXT NOT NULL CHECK (direction IN ('discord','web'))`
   - `client_id TEXT`
   - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `deleted_at TIMESTAMPTZ`

   Indexes:
   - `(channel_id, last_activity_at DESC) WHERE deleted_at IS NULL` for `LATEST_ACTIVITY` sort
   - `(channel_id, id DESC)` for `CREATION_DATE`
   - unique `(owner_key, client_id) WHERE client_id IS NOT NULL` for idempotent web post creation

   The starter message is the `discord_bridge_message` row with
   `discord_message_id = thread_id`.
3. Pending web posts. Before delivery a web post has no thread id, so its
   starter row can't use `channel_id = thread id` yet. Options:
   - **(a)** Store the starter row with `channel_id = 'post:<post.id>'` and
     rewrite it to the thread id in one transaction when the webhook returns.
     Nothing else reads `post:` ids.
   - **(b)** Add `discord_bridge_message.post_id BIGINT REFERENCES
     discord_bridge_post(id)`.

   Recommendation: **(a)**. It keeps every message query on `channel_id`.

   Note that `/send` broadcasts a web message **before** Discord delivery
   (`broadcastMessage`, then `pg_notify`). A web post would be broadcast as
   `bridge.post.created` under its `post:<id>` key, followed by a
   `bridge.post.delivered { postId, threadId }` so clients re-key it. The other
   option is to list pending posts only to their author until delivery.

**Bridged-set resolution (`discord-bridge-bot.ts`, `discord-bridge-categories.ts`)**

4. Broaden the accepted types:
   - `discord-bridge-categories.ts` `BRIDGEABLE_CHANNEL_TYPES` → `{0, 5, 15}`,
     plus `16` behind a config flag (media is beta).
   - Replace `isBridgeTextChannel` with `isBridgeChannel`, which accepts
     `GuildForum` / `GuildMedia`.
   - Split the runtime type into `BridgeTextChannel | BridgeForumChannel`
     (`ForumChannel | MediaChannel`).
   - Never accept thread types. Posts are bridged *through* their forum, not
     configured individually.
5. `resolveBridgeSet` (`:1027`):
   - Category children and legacy ids may now be forums.
   - Add forum fields to the `LayoutEntry` signature (`available_tags`,
     `flags`, sort and layout defaults, topic), so a tag or guidelines change
     emits `bridge.channels.changed`.
   - Skip channels with `flags & (1 << 17)` (`CHANNEL_OBFUSCATED`) instead of
     relying on the name. This applies to all types.
6. `applyBridgeSetOnce` (`:1148`) and `bridge.upsertChannel` /
   `updateChannelMetadata` (`discord-bridge-db.ts:296,343`): write `type` and
   the forum columns. `ensureWebhook` (`:519`) works unchanged on a forum,
   because `ThreadOnlyChannel.createWebhook` exists. Widen its parameter type.

**Gateway handling (`discord-bridge-bot.ts startBridge`)**

7. Add a runtime map `threads: Map<threadId, forumId>`, rebuilt from
   `discord_bridge_post` at startup and from `guild.channels.cache` active
   threads. Add a helper `bridgedScope(channelId)` that returns
   `{ forumId, threadId } | { channelId }`, or null when neither is bridged.
   Every handler that now checks `runtime.channels.has(message.channelId)`
   (`messageCreate`, `messageUpdate`, `messageDelete`, `messageReactionAdd`,
   `messageReactionRemove`) switches to `bridgedScope(...)`.
8. New handlers, all filtered by `thread.parentId ∈ bridged forums`:
   - `threadCreate(thread, newlyCreated)` → upsert the post row. Fetch the
     starter message if it hasn't arrived via `messageCreate` (ordering between
     the two events is not guaranteed).
   - `threadUpdate(old, new)` → update name, `applied_tags`, `flags` (pin),
     `archived`, `locked`, `archive_timestamp`, `rate_limit_per_user`, then emit
     `bridge.post.updated`.
   - `threadDelete(thread)` → tombstone the post and all its messages, then
     emit `bridge.post.deleted`. No per-message deletes arrive (§6.3).
   - `threadListSync(threads, guild)` → upsert the listed threads. Treat
     threads missing from the sync as possibly archived, not deleted.
9. `persistDiscordMessage` (`:185`):
   - `updateChannelMetadata` must target the **forum** row, not the thread.
   - `chatPermsForDiscord(..., message.guildId)` is fine as is.
   - After `recordMessage`, bump the post's `last_message_id`,
     `last_activity_at` and counters, because `THREAD_UPDATE` won't carry them.
   - Mark the starter message so the client can render it as the post body,
     either by `discord_message_id = thread_id` or a `message_type`/flag.
10. Own-delivery suppression (`messageCreate:1330`, `reconcileChannel`
    `persistable` filter) must compare `message.webhookId` with the webhook of
    the **parent forum** (`runtime.webhooks.get(forumId)`).
11. Cache robustness: either add `Partials.Channel` to the `Client` in
    `discord-service.ts:55`, or resolve unknown thread ids through
    `client.channels.fetch` and the `threads` map. The default sweeper evicts
    archived threads after 4 h (§4.4).

**Reconcile (`reconcileChannel :364`, `reconcileBridgedHistory :484`)**

12. For a forum, `channel.messages` doesn't exist. Instead:
    1. `forum.threads.fetchActive()`.
    2. Page `forum.threads.fetchArchived({ type: 'public', before: <Date>,
       limit })` while `hasMore`, down to a configurable horizon (for example
       the newest N posts or the last M days). Pass a `Date`, not an id
       (§4.4 gotcha).
    3. Upsert each post, then run the existing `reconcileChannel` logic per
       **thread** (it is generic over anything with `.messages.fetch`; widen
       the parameter type).
    4. Throttle with `RECONCILE_PAUSE_MS` between threads.

    Mark posts that are in the DB but in neither listing as deleted only after
    a complete pass (same "complete" rule as `resolveBridgeSet`).

**Webhook delivery (`deliverWebMessageOnce :658`, `applyBotEdit :787`,
`applyBotDelete :812`, `applyBotReaction :766`)**

13. Outbox select (`:660`) also needs the post context:
    - Join `discord_bridge_post` on the pending `post:<id>` / thread id.
    - Get the webhook from the **forum** row.
    - `runtime.channels.get(row.channel_id)` becomes a scope lookup.
14. New post: `hook.send({ username, avatarURL, content, allowedMentions,
    threadName, appliedTags })` with `wait` (discord.js waits by default for
    `WebhookClient.send`). Then, in one transaction:
    - set `post.thread_id = sent.channel_id`
    - rewrite the starter row's `channel_id` from `post:<id>` to the thread id
    - `attachDiscordMessageId(row.id, sent.id)`

    Handle `40067` (tag required), `10087` (unknown tag), `40066` and `160006`
    (active thread cap) as permanent failures, and tell the author. Don't let
    the 10-minute sweep keep retrying them.
15. Reply in a post: `hook.send({ ..., threadId })`. On the raw-REST
    reply-threading branch (`:686-707`), add `thread_id` to `query`:
    `new URLSearchParams({ wait: 'true', thread_id })`.
16. Edits: `hook.editMessage(id, { content, allowedMentions, threadId })`. The
    fallback `channel.messages.fetch` must use the thread channel. Deletes and
    bot reactions: fetch the message from the **thread**
    (`client.channels.fetch(threadId)` → `.messages.fetch`), not
    `runtime.channels.get(forumId)`.

**Permissions (`discord-channel-access.ts`, `discord-chat-perms.ts`,
`discord-bridge-api.ts writeDenial/viewGate`)**

17. `DiscordPermission` / `DiscordBit`: add `SEND_MESSAGES_IN_THREADS (1n <<
    38n)`, `MANAGE_THREADS (1n << 34n)` and `PIN_MESSAGES (1n << 51n)`. Add
    15 (and 16) to `RENDERABLE_CHANNEL_TYPES`, or a separate
    `THREAD_ONLY_CHANNEL_TYPES` used by `channelAccess` and `buildSidebar`.
18. Post scope always resolves to the **forum's** snapshot entry. Threads are
    absent from `GET /guilds/{id}/channels`, and threads have no overwrites, so
    `snap.byId.get(threadId)` is always undefined. `channelAccess`,
    `discordChannelBits` and `discordViewDenied` take the forum id for post
    actions.
19. `applyDiscordChannelPerms` gets a context flag (`'channel' | 'post-create'
    | 'post-reply'`):
    - post-create maps Discord `SEND_MESSAGES` → chat `SEND_MESSAGES` (today's
      behavior on the forum entry).
    - post-reply maps `SEND_MESSAGES_IN_THREADS` → chat `SEND_MESSAGES`. Apply
      the implicit mention/embed denies off that bit.

    Alternatively, add a chat bit `SEND_IN_POSTS` next to `Perm.SEND_MESSAGES`
    so `perms` can report `canCreatePost` and `canReply` separately.
    Recommendation: the separate chat bit. The composer needs both answers at
    once on a forum view.
20. `writeDenialCore` / `WriteAction`:
    - Add `'post-create'` (with tag validation: `REQUIRE_TAG` → at least one
      tag, ≤5 tags, tags ⊂ `available_tags`, `moderated` tags only for staff)
      and `'post-reply'`.
    - Post state: `locked` → deny unless staff (Discord `MANAGE_THREADS`
      analogue). `archived` → allowed for replies (Discord auto-unarchives)
      unless locked. Product choice; see the decisions below.
    - React and edit on an archived post → deny (Discord `50083`).
    - `channel.locked` (holt lockdown) keeps applying at forum level.
21. Timeouts, webhook overwrites and bans are keyed by `channel_id`
    (`discord_bridge_timeout`, `discord_bridge_webhook_perm`) or by guild
    (`discord_bridge_ban`). Resolve thread → forum before
    `activeTimeout(channelId, ...)`, `overwriteFor` and `webhookOverwrites`,
    so a timeout in a forum covers all its posts. That mirrors Discord's
    inheritance. No schema change.

**Site API (`discord-bridge-api.ts`)**

22. `viewGate` (`:616`) and `writeDenial` (`:555`): accept a thread id, look up
    `discord_bridge_post`, gate on the forum row
    (`enabled`, `everyoneCanView`, `locked`), and return `{ bridged: forumRow,
    post }`. Every channel-scoped route (`history`, `members`, `search`,
    `profile`, `pins`, `send`, `edit`, `react`, `delete`, `typing`, `forward`,
    `suppress-embeds`, `pin`) then works for posts without per-route changes.
23. `channels` (`:1000`): emit `type` from the row (drop the hardcoded `0` in
    the fallback), plus the forum fields (`availableTags`,
    `defaultReactionEmoji`, `defaultSortOrder`, `defaultForumLayout`, `flags`).
    `lastMessageIds` for a forum = the newest post activity.
24. New sealed read route `posts?channel=<forum>&sort=activity|created&tag=<id>&before=<cursor>&limit`
    (`writeSealedJson`): lists posts from `discord_bridge_post`, each with
    name, owner, tags, flags (pinned first), archived, locked, reply count,
    last activity, and a starter preview (first chars + first image for gallery
    layout).
25. New write route `post` (POST `{ channelId, name, content, appliedTags,
    clientId }`):
    - Gate it through `writeDenial(..., 'post-create')`.
    - Rate-limit it separately from `send`.
    - Insert the post row and the starter row (`post:<id>`), then `pg_notify`
      the outbox.
    - Replies use the existing `send` with `channelId = thread id`.
    - Optional staff routes: `post-moderate` (lock/unlock, pin/unpin,
      edit tags, delete post). They map to Modify Thread / Delete Channel with
      the bot token (`MANAGE_THREADS`).

**Realtime (`events.ts`, `discord-channel-access.ts`)**

26. `events.ts channelGuildId` (`:122`) looks up `discord_bridge_channel` by
    `channel_id`, so it returns null for a thread id, and `bridge.*` events in
    posts would lose `guildId`. Fall back to `discord_bridge_post.guild_id`.
    `allowBridgeEvent` / `computeVisibility` check `vis.channels.has(channelId)`
    and must map a thread id to its forum (or the payload carries `forumId` /
    `parentId`). Add events `bridge.post.created`, `bridge.post.updated` and
    `bridge.post.deleted`, all carrying `channelId = forum id`.

**Config, docs, verification**

27. No new config keys are strictly needed: forums inside an already bridged
    category get picked up automatically once types are widened. That is a
    behavior change for existing deployments. Gate it with a key such as
    `bridge.forums: true` (and `bridge.mediaChannels: false`). Adding the key
    creates config parity work for every host.
28. Update the "Community chatbox" section of holt's AGENTS.md / PLAN.md and
    `config.example.js`.
29. Tests (pure cores): `isBridgeable` with 15/16, the `applyDiscordChannelPerms`
    post contexts, `writeDenialCore` post-create/post-reply/locked/archived,
    the tag validation helper, and `planDiscordReconcile` per thread.

### 7.4 Open decisions (recommendations in bold)

1. Keying: `channel_id = thread id` + `discord_bridge_post`, **yes** (§7.2).
2. Pending web post representation: **`post:<id>` placeholder rewritten on
   delivery** vs a `post_id` FK column.
3. Replying to archived posts from the web: **allow** (Discord does, and
   unarchives) vs read-only. Locked posts are read-only for non-staff either
   way.
4. Archived backfill horizon: **newest 200 posts or 90 days per forum**
   (tunable) vs everything.
5. Media channels (16): **behind a flag, off by default** (beta API).
6. Chat permission model: **new `SEND_IN_POSTS` chat bit** vs reusing
   `SEND_MESSAGES` with a context flag.
