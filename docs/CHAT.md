<!-- Moved from abulxt's AGENTS.md at the standalone cutover (2026-10-24). Where it says "site account",
"web-only", `user:<id>` or `users.*`, read "web identity" (`<namespace>:<subject>`, any platform's user, in
holt's chat_identity directory): abulxt accounts are `abulxt:<n>` and come from abulxt's sign-in like any
platform's users. Site admin, a linked Discord account and avatars come only from trusted platforms
(platforms.ts `trusted`). Bans/timeouts/overwrites name web identities with subject_type 'ext'. Perk changes
reach holt as identity pushes (holt-account-api.ts). -->

# The chat: Discord bridge, permissions, moderation

The site chatbox (`main/src/pages/chat/`) is a Discord-replica bridge to guild
text channels. Web-originated messages are persisted in `discord_bridge_message`
and delivered to Discord via that channel's **webhook**; Discord-originated
messages are persisted by the `abulxt-discord` bot and broadcast to web clients
over `/api/rt`.

**Multi-guild, category-based bridging.** `config.discord.bridgeCategories`
lists Discord category ids (any guild the bot is in): every text (0) /
announcement (5) channel inside one is bridged, including channels created or
moved in later; `config.discord.bridgeChannels` (legacy) still bridges single
channels. The bot (`discord-bridge-bot.ts`, pure core
`discord-bridge-categories.ts`) resolves the set at startup and again after
every channel/guild gateway event (debounced): it upserts each channel
(+ `parent_id`, webhook), DISABLES rows that left the set (moved out, deleted,
guild left — row, webhook and history kept; moving back re-enables), and emits
`bridge.channels.changed { guildId }` for every guild whose set or layout
(names, positions, categories, overwrites) changed. A guild is **bridged** when
it has ≥1 enabled `discord_bridge_channel` row. `config.discord.guildId` stays
the **home** guild (verification gate, entitlement/holt roles, `/ai`, account
link, deletion queue); nothing chat-related may assume it. Every per-guild path
takes the channel's guild (`discord_bridge_channel.guild_id`) or a `guild`
param validated against the bridged set (404 `{code:10004}` otherwise):
`chatPermsForUser/ForDiscord/ForIdentity(…, guildId)` and the
`discord-channel-access.ts` helpers take it explicitly, and every cache
(guild snapshot, member roles `guild:user`, onboarding config, site-admin role,
member floor, bot roles) is per guild. A linked user who isn't a member of
guild B is a guest there (perk floor still applies). Unbridged channels are
not listed or readable (no live reads). **Discord VIEW fails closed**: without
a guild snapshot (Discord unreachable, nothing cached) only channels with
`everyone_can_view` (computed by the bot from @everyone's role + channel
overwrite; FALSE until synced) stay readable, and they still need the chat
VIEW bit + webhook overwrites (`discordViewAllowed`). Only the bot's set sync
enables a row; message persistence updates metadata only. A configured
category / legacy id that doesn't resolve (typo, foreign, deleted) never
disables the rows under it — the sync logs it loudly instead. `/bridge` slash commands are registered
in every bridged guild; all other guild commands stay home-only.

**Forum channels** (migration `038_discord_bridge_forums`; interface in `../holt/docs/forum/contract.md`).
Forum (15) channels are bridged like text channels; media (16) only with
`discord.bridge.mediaChannels: true`. A post is a Discord thread, one `discord_bridge_post` row; its messages
are ordinary `discord_bridge_message` rows with `channel_id` = the thread id. A web post is `post:<pk>` until
the forum webhook creates the thread (`deliverPendingPost` re-keys it in one transaction). Every gate resolves
a post to its FORUM first (`discord-bridge-db.ts scopeFor`): Discord permissions (replies need
`SEND_MESSAGES_IN_THREADS` → chat bit `SEND_IN_POSTS`), overwrites, timeouts, bans, lockdown; `events.ts`
stamps `forumId` on events inside a post and `allowBridgeEvent` follows the forum. Locked posts are staff-only;
archived posts take replies (unarchives) but not edits/reactions. The bot pages archived posts to
`discord.bridge.forumBackfill` (default newest 200 / 90 days).

**Server rail + folders** (`pages/chat/GuildRail.tsx`, pure model
`guildFolders.ts`; migration `028_user_guild_folders`). The rail layout is
per account, Discord's `guildFolders` shape: `users.guild_folders` holds one
entry per root item (`{guildIds:[id]}` = a server, `{id,name,color,guildIds}`
= a folder), validated in `server/guild-folders.ts`. `GET
/api/account/guild-folders` is sealed (`writeSealedJson`, read via
`cryptoFetch`); `POST` saves the whole layout and emits
`account.guild_folders` to the account's other sockets. Drag/drop follows
Discord's rules (insert-before / combine → new folder / append; folders only
at root; an emptied folder disappears, a one-server folder stays). Servers the
layout doesn't mention render first; unknown ids are kept so a briefly missing
server keeps its place. Folder expand state is per device (localStorage).
Guests get no layout and no drag.

**Terminology.** Webhook delivery identities — web users and Discord users
alike — are called **webhooks**. Chat roles and moderation apply to webhooks,
not to site accounts.

**Chat permission system** (`main/src/server/discord-chat-perms.ts`). Chat
permissions are **Discord-style permission bitfields** resolved from a webhook's
guild roles, independent of site admin:

- Bits: `VIEW_MESSAGES(1)`, `SEND_MESSAGES(2)`, `TIMEOUT_WEBHOOKS(4)`,
  `BAN_WEBHOOKS(8)`, `MANAGE_WEBHOOKS(16)`.
- `config.discord.chatRoles` maps guild role ids (from any bridged guild) →
  tiers `member`/`mod`/`admin`/`owner`; `discord-service` startup (and any
  change of the bridged guild set) syncs them into `discord_bridge_chat_role`
  (name/position/color + tier bitfield + `guild_id`). Positions only compare
  within a guild, so the site-admin role and member floor are per guild.
- **Chat admin/owner ≠ site admin.** `MANAGE_WEBHOOKS` gates chatbox commands
  and webhook-permission management only; revenue/analytics/account admin stay
  site-admin (`users.admin`) only.
- Hierarchy is by Discord role **position** (Owners/Owners Key/Manager > Admin >
  Mod > Member): a webhook can't moderate a webhook at or above its own
  position. Owners share the admin bitfield but outrank admins by position.

**Effective roles (one source of truth).** Every webhook resolves ONE guild
role set — `perms.roleIds`, attached by `chatPermsForUser` /
`chatPermsForIdentity` via `withEffectiveRoles` / `resolveEffectiveRoles`
(`discord-channel-access.ts`; pure core `unionEffectiveRoles`): a linked guild
member's real Discord roles, else (web-only, linked-but-not-in-guild, guest)
the tier's chat role ∪ `chatRoles.member` floor roles (member+ tier w/o a
mapped role, incl. perks) ∪ Server Onboarding grants (`emulatedRoleIds`;
elevated/managed roles never). It drives channel VIEW (`viewerFor`), bridge
role overwrites, hierarchy position (highest effective role,
`effectivePosition`), role-mention highlight (`perms.guildRoleIds`), name
color (highest colored role; stored as `author_color`, gradients via
`/authors` with `user:<id>` keys), the profile popout and role-member lists.
Per-channel chat bits come from `applyDiscordChannelPerms` (documented
precedence): tier bits → admin/owner bypass → GRANT VIEW/SEND/ADD_REACTIONS a
held non-@everyone role gives in the channel (role perms or role overwrite —
@everyone alone never lifts a guest; mention/embed bits are never granted) →
REMOVE bits Discord's full channel math lacks (VIEW_CHANNEL, SEND_MESSAGES,
ADD_REACTIONS, MENTION_EVERYONE, EMBED_LINKS + implicit denies) → bridge
webhook overwrites → timeout (VIEW-only) → lockdown. Moderation bits stay
tier-only. Perk changes (stripe/admin `emitWebhookPermsChanged`) and
onboarding writes emit a targeted `bridge.perms.changed` (`keys`, no
`discordId`), so only that identity's sockets refresh perms, sidebar and
author styles (`invalidateVisibilityForEvent` keeps the shared snapshot).

**Moderation applies to EVERY webhook identity** — web-only site accounts,
web accounts with a linked Discord, and Discord users — for every action:
timeout/untimeout, ban/unban, delete, pin/unpin, suppress embeds, per-channel
webhook overwrites (lock/unlock stays channel-scoped). One target-identity
model lives in `discord-chat-perms.ts`:

- `WebhookTarget` = `{kind:'site', userId}` | `{kind:'discord', discordId}`,
  parsed from an author key (`user:<siteId>` for web rows, `discord:<id>` for
  Discord rows) or a bare snowflake (`parseWebhookTarget`).
- `resolveWebhookTarget` resolves both ways (site → linked Discord id; Discord
  id → linked site account) into a `WebhookIdentity` `{userId, discordId}`;
  a linked account is ONE webhook. Timeouts, bans, and member overwrites are
  written for **every side** of the identity and matched on either side.
- Perms: `chatPermsForIdentity` (site accounts via `chatPermsForUser` = linked
  guild roles + perk floor). A perk-floored web-only webhook's hierarchy
  position = the highest member-tier chat role position (`applyPerkFloor`).
- Shared logic: `moderationDenial` (bits + hierarchy + not-self; unban skips
  hierarchy) and `discord-chat-moderation.ts` `moderateWebhook()` — used by
  the web `moderate` route AND the Discord `/bridge timeout|untimeout|ban|unban`
  slash commands (targets: @member, `user:<id>`, `discord:<id>`, site
  username, `msg:<bridgeId>`, or a Discord/web message link).
- **One write gate.** Every write route (send, edit, forward, typing, react,
  delete, suppress-embeds, pin, moderate) calls `writeDenial(user, ip,
  channel, action)` in `discord-bridge-api.ts` → pure `writeDenialCore`:
  bridged channel, email verification (composing), ban (site/Discord/IP),
  VIEW (Discord + chat bit + overwrite), timeout (all but own-message
  tidy-up), then SEND + send overwrite + lock / ADD_REACTIONS + react
  overwrite / Manage Messages. `/edit` re-checks current perms like `/send`.
  `perms.canSend/canReact` come from the same core. Don't add ad-hoc gates.

**Effective roles** (`resolveEffectiveRoles` in `discord-channel-access.ts`, pure core `unionEffectiveRoles`): a web-only webhook's roles = perk/tier chat role ∪ member-floor roles ∪ onboarding grants (`emulatedRoleIds`, no admin/moderation/managed roles); a linked guild member uses only their real roles. Channel VIEW/SEND/REACT/MENTION math, hierarchy position, author colour and the `webhook-profile` popout all read `perms.roleIds` from this one resolver.
Discord role overwrites apply on top of the effective roles, so a granted role's SEND can be removed by a role or member deny overwrite; onboarding and perk changes emit `bridge.perms.changed` / `bridge.onboarding.updated` so clients refresh.

**Endpoints** (`/api/discord/bridge/`): `guilds` lists the bridged guilds in
which the caller can VIEW ≥1 bridged channel (guests included; adds
`inviteUrl` from the vanity code; per-guild 5-min REST cache) and
`channels?guild=<id>` (guild REQUIRED) lists that guild's bridged channels
(+ `guildId`, `lastMessageId`) and the categories holding them; both are
sealed with `writeSealedJson` when `config.apiCrypto.enabled`. Onboarding
routes take a REQUIRED `guild` (query for GET, body for POST); `search` takes
an optional `guild`; every other channel-scoped route derives the guild from
`channel`. `perms` returns the caller's tier,
position, bitfield, `webhookKeys`, can* flags, ban, and any active timeout;
`target?channel&target` returns the caller's moderation view of one webhook
(canTimeout/canUntimeout/canBan/canUnban/canManageWebhook + its timeout, ban,
member overwrite) — drives the user menu / profile popout entries
("Timeout {name}" / "Remove Timeout", "Ban {name}" / "Revoke Ban", Channel
Permissions) and Discord's Timeout/Ban modals (`ModerationModals.tsx`);
`moderate` performs `timeout`/`untimeout`/`ban`/`unban`/`webhook-perm`/
`lockdown`. `profile?channel&user` (VIEW-gated, 5-min cache) feeds the profile
popout from live Discord REST; `webhook-profile?channel&key=user:<id>|self`
(VIEW-gated, 30s cache) serves a web identity's effective roles (Discord-style
role pills) + site join date as "Member Since" — never a Discord id, date or
avatar. `role-members` also lists web identities that effectively hold the
role (onboarding grant / perk floor, only identities with chat history or an
onboarding answer; flagged `webhook: true`). Guests may read public channels, member lists,
and profiles; site account ids being visible is fine.

**Realtime.** Every `bridge.*` event about a channel carries `guildId`
(stamped centrally in `events.ts emit`); `bridge.perms.changed` /
`bridge.onboarding.updated` carry `guildId` (null = every guild);
`bridge.channels.changed` reaches every socket. Socket visibility is the union
over all bridged guilds; moderation events reach moderators per channel
(`moderatorChannels`).

**Bans** are per guild (migration `029`): `discord_bridge_ban.guild_id` NULL =
global (every pre-029 row), else the guild of the channel the ban was issued
from. Site admins and staff acting in the home guild issue global bans; other
guilds' moderators issue (and lift) bans scoped to their guild
(`banScopeFor`). A ban check in guild G matches `guild_id IS NULL OR guild_id =
G`; guild-independent checks (avatar uploads) see global bans only.
`/bridge bans` and IP bans need BAN_WEBHOOKS (chat bits in that guild),
`/bridge modlog` needs MANAGE_WEBHOOKS. The home guild sees every ban and
every `moderation_event`; any other guild sees only its own scoped bans (IP
subjects redacted) and only events with its `moderation_event.guild_id`.
Hierarchy: nobody can moderate the guild owner; a site admin in a guild with
no admin-tier chat role ranks above that guild's highest role, or skips the
hierarchy check while its snapshot is unavailable. Channel-less moderation
events reach only the target and site admins (presence stays site-wide).

**Timeouts.** `discord_bridge_timeout` holds active timeouts (per channel);
a timed-out webhook is view-only until `timeout_until` passes, and the bot
deletes its Discord-side posts in that channel (bans likewise). The composer
polls `perms` and shows a live countdown ("You are timed out. Try again in 5m
3s."). Moderation events (`bridge.timeout`/`untimeout`/`ban`/`unban`) carry
`targetKeys` and reach only the target's sockets (any key) and moderators who
can view the channel.

**Ping limits** (`discord-mention-limits.ts`, `config.discord.bridge.mentionLimits`): >`perMessage` unique user+role mentions → Discord AutoMod block (400, code 200000, admins exempt; never 429 — the client queue retries 429s); per-identity window budgets (pings incl. reply pings, @everyone, per-target) never reject — excess mentions are stored `inert: true` (chip kept, left out of allowed_mentions, no web highlight); edits keep prior live pings free, can't revive inert ones, and pay for new ones.
Windows are in-memory (one app-server process; N processes = N× budget). Blocks/neutralizations log to `moderation_event` (`automod-block`/`mention-limit`, ≤1 row/identity/min) and `target` returns staff-only `mentionLimit` counters.

**Tables** (migration `008_discord_bridge_chat_roles`, identity columns in
`020_discord_bridge_webhook_identity`): `discord_bridge_chat_role` (role →
tier + bitfield), `discord_bridge_timeout` (`subject_type` `discord`|`site`),
`discord_bridge_webhook_perm` (`subject_type` `role`|`user` (Discord)|`site`;
per-channel allow/deny overwrites; deny wins then allow, Discord-style),
`discord_bridge_ban` (`user` = site account, `discord`, `ip`; `guild_id`,
migration `029_discord_bridge_multi_guild`, which also adds
`discord_bridge_chat_role.guild_id` and `discord_bridge_channel.parent_id`).

**Server Onboarding (emulated)** (`discord-onboarding.ts`,
`discord-onboarding-api.ts`, `pages/chat/Onboarding.tsx`; migration
`021_discord_bridge_onboarding`). Per bridged guild: the guild's real
onboarding config (bot token, cached 5 min) drives Discord's flow for NEW web
identities (no chat history in that guild's channels, not a guild member); answers + Browse Channels opt-ins are stored per
webhook (`user:<id>`), never written to Discord. Selected options' roles join
a non-member web identity's effective roles (see Effective roles; elevated/
managed roles never emulated); the `/channels` sidebar applies Discord's
opt-in model (bridged, default and role-gated channels always show). Endpoints:
`onboarding`, `onboarding/responses`, `channel-optin`, `channel-optin/show-all`;
writes emit `bridge.onboarding.updated` scoped to the caller's `targetKeys`.

**Avatars** (`avatar-api.ts`, `avatar-image.ts`, `avatar-moderation.ts`,
`avatar-store.ts`; migration `015_user_avatar`). No avatar URLs: uploads are
magic-byte sniffed (PNG/JPEG/WebP/GIF only), decoded by sharp with every other
libvips loader blocked (`sharp.block`, so libheif is unreachable), re-encoded to
256x256 WebP, then classified by `gemini-3.8-flash-high` (fail closed: errors
leave it `pending` for site-admin review at `/api/admin/avatars`). Only
`approved` rows are served (`/api/avatars/<sha256>.webp`, stored and returned
as a same-origin path) or sent to Discord as `avatar_url` (made absolute with
`avatars.publicOrigin`/`mail.publicOrigin` only at webhook delivery).
