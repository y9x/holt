-- Abulxt database schema (baseline v1)
--
-- This file is the authoritative DDL for the abulxt Postgres database
-- (hosted on amph, see deploy/). It is applied automatically by
-- main/src/server/db.ts -> ensureSchema() on server startup.
--
-- Format:
--   * Plain SQL with no migration marker == the idempotent baseline
--     (everything uses IF NOT EXISTS / ON CONFLICT so it is safe to re-run).
--   * Future schema changes are appended as migrations, NOT edited into the
--     baseline. See AGENTS.md ("Database migrations") for the procedure.
--
-- Migration marker syntax (one per section, at the top of the section):
--   -- migration: 002_add_bio_to_users
--   ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
-- Migrations run exactly once, in numeric order, tracked in
-- the schema_migrations table. The baseline is migration 001_baseline.

CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,             -- e.g. '001_baseline'
    applied TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- entitlement caches; isPremium() == (now() < paid_until), no-ads == (now() < noads_until)
    paid_until TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    noads_until TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ads_disabled BOOLEAN NOT NULL DEFAULT FALSE,
    stripe_customer_id TEXT,

    -- Email + account controls
    email TEXT,
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    email_verification_code TEXT,
    new_email TEXT,
    new_email_secret TEXT,
    password_reset_secret TEXT,
    admin BOOLEAN NOT NULL DEFAULT FALSE,

    -- Optional two-factor auth (opt-in; never forced)
    totp_secret TEXT,
    totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    totp_backup_code TEXT,
    email_otp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    login_otp TEXT
);

CREATE TABLE IF NOT EXISTS session (
    secret TEXT PRIMARY KEY,
    created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ip TEXT,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires TIMESTAMPTZ,               -- set by the app at login (30 days)
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    totp_verified BOOLEAN NOT NULL DEFAULT FALSE,
    -- Device + coarse geolocation (city/region only; never expose the raw IP)
    user_agent TEXT,
    device TEXT,                       -- parsed OS/platform label
    geo_city TEXT,
    geo_region TEXT,
    geo_country TEXT
);

-- Written by the Stripe webhook (source='stripe') and by admin entitlement
-- grants (source='grant'). period_end is the source of truth that the
-- users.paid_until / noads_until columns mirror.
CREATE TABLE IF NOT EXISTS payment (
    invoice_id TEXT PRIMARY KEY,
    subscription_id TEXT,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tier TEXT NOT NULL,                -- 'plus' | 'noads'
    period_start TIMESTAMPTZ,
    period_end TIMESTAMPTZ,
    stripe_renew BOOLEAN NOT NULL DEFAULT TRUE,
    amount_cents INT,                  -- NULL for $0 (grants)
    currency TEXT NOT NULL DEFAULT 'usd',
    source TEXT NOT NULL DEFAULT 'stripe',  -- 'stripe' (real revenue) | 'grant' (free)
    actor TEXT,                        -- who granted (admin username) or NULL for stripe
    created TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-user, per-day AI usage. Replaces the old per-IP in-memory counter.
CREATE TABLE IF NOT EXISTS ai_usage (
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day DATE NOT NULL,
    requests INT NOT NULL DEFAULT 0,
    tokens INT NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);

-- Guest (signed-out) AI usage, keyed by IP. Indefinite lifetime allowance for
-- trying the assistant before creating an account.
CREATE TABLE IF NOT EXISTS guest_ai_usage (
    ip TEXT PRIMARY KEY,
    requests INT NOT NULL DEFAULT 0,
    tokens INT NOT NULL DEFAULT 0,
    created TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Server-authoritative chat threads. The client never sends a transcript — it
-- issues operations; the server owns the message list (injection-proof).
CREATE TABLE IF NOT EXISTS thread (
    id TEXT PRIMARY KEY,
    owner_key TEXT NOT NULL,          -- 'user:{id}' or 'guest:{ip}'
    title TEXT NOT NULL DEFAULT 'New chat',
    generating BOOLEAN NOT NULL DEFAULT FALSE,
    created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS thread_owner_idx ON thread(owner_key);

CREATE TABLE IF NOT EXISTS thread_message (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
    seq INT NOT NULL,                  -- server-assigned order within the thread
    role TEXT NOT NULL,                -- 'user' | 'assistant'
    content TEXT NOT NULL,
    attachments JSONB,
    client_id TEXT,                    -- idempotency key for optimistic sends
    tokens INT,
    ms INT,
    created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    edited_at TIMESTAMPTZ,
    deleted BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS thread_message_thread_idx ON thread_message(thread_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS thread_message_clientid_idx ON thread_message(thread_id, client_id) WHERE client_id IS NOT NULL;

-- Append-only site-wide event log. Every mutation (chat op, purchase, usage
-- charge, ad entitlement) appends here and is broadcast to the owner's sockets.
-- seq is the realtime sync cursor for reconnects.
CREATE TABLE IF NOT EXISTS event_log (
    seq BIGSERIAL PRIMARY KEY,
    owner_key TEXT NOT NULL,
    type TEXT NOT NULL,
    payload JSONB,
    created TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS event_log_owner_idx ON event_log(owner_key, seq);

CREATE INDEX IF NOT EXISTS session_user_idx ON session(user_id);
CREATE INDEX IF NOT EXISTS payment_user_idx ON payment(user_id);

-- Bans (permanent when expires IS NULL)
CREATE TABLE IF NOT EXISTS ban (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires TIMESTAMPTZ,               -- NULL = permanent
    reason TEXT,
    created TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ban_user_idx ON ban(user_id);

-- Passkeys / WebAuthn credentials (optional 2FA + passwordless)
CREATE TABLE IF NOT EXISTS passkey (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL UNIQUE,
    public_key TEXT NOT NULL,
    counter BIGINT NOT NULL DEFAULT 0,
    name TEXT,
    transports TEXT,
    device TEXT,                       -- best-effort platform label
    last_used TIMESTAMPTZ,
    created TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS passkey_user_idx ON passkey(user_id);

-- Email audit / rate-limit log (every outbound email)
CREATE TABLE IF NOT EXISTS email_log (
    id SERIAL PRIMARY KEY,
    send_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    email TEXT,
    ip TEXT,
    user_id INT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS email_log_email_idx ON email_log(email);
CREATE INDEX IF NOT EXISTS email_log_ip_idx ON email_log(ip);

-- Pending WebAuthn challenges (registration + login ceremonies)
CREATE TABLE IF NOT EXISTS webauthn_challenge (
    challenge TEXT PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,                -- 'registration' | 'authentication'
    expires TIMESTAMPTZ NOT NULL,
    created TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit trail of every admin action (who did what to whom, when).
CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,
    admin_id INT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,              -- e.g. 'ban', 'unban', 'grant_entitlement', 'set_admin'
    target_user_id INT REFERENCES users(id) ON DELETE SET NULL,
    detail JSONB,                      -- action-specific payload (tier, days, reason, ...)
    created TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log(created);

-- ---------------------------------------------------------------------------
-- Migrations (append-only below this line — see AGENTS.md)
-- ---------------------------------------------------------------------------

-- migration: 002_music_library
-- Per-user music library: liked tracks, saved albums, playlists, queue, recents.
-- Track payloads are cached as JSONB so playback works without re-searching.

CREATE TABLE IF NOT EXISTS music_track_cache (
    track_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    album TEXT NOT NULL DEFAULT '',
    album_id TEXT,
    duration INT NOT NULL DEFAULT 0,
    artwork TEXT NOT NULL DEFAULT '',
    stream_url TEXT NOT NULL DEFAULT '',
    explicit BOOLEAN NOT NULL DEFAULT FALSE,
    isrc TEXT,
    source TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS music_liked_track (
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL REFERENCES music_track_cache(track_id) ON DELETE CASCADE,
    created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, track_id)
);
CREATE INDEX IF NOT EXISTS music_liked_track_user_idx ON music_liked_track(user_id, created DESC);

CREATE TABLE IF NOT EXISTS music_saved_album (
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    album_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    artist TEXT NOT NULL DEFAULT '',
    artwork TEXT NOT NULL DEFAULT '',
    track_count INT NOT NULL DEFAULT 0,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, album_id)
);
CREATE INDEX IF NOT EXISTS music_saved_album_user_idx ON music_saved_album(user_id, created DESC);

CREATE TABLE IF NOT EXISTS music_playlist (
    id BIGSERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_public BOOLEAN NOT NULL DEFAULT FALSE,
    cover_url TEXT NOT NULL DEFAULT '',
    created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS music_playlist_user_idx ON music_playlist(user_id, updated DESC);

CREATE TABLE IF NOT EXISTS music_playlist_track (
    playlist_id BIGINT NOT NULL REFERENCES music_playlist(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL REFERENCES music_track_cache(track_id) ON DELETE CASCADE,
    position INT NOT NULL DEFAULT 0,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (playlist_id, track_id)
);
CREATE INDEX IF NOT EXISTS music_playlist_track_pos_idx ON music_playlist_track(playlist_id, position);

CREATE TABLE IF NOT EXISTS music_queue (
    user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    track_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    current_index INT NOT NULL DEFAULT 0,
    shuffle BOOLEAN NOT NULL DEFAULT FALSE,
    repeat_mode TEXT NOT NULL DEFAULT 'off',
    updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS music_recent_track (
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL REFERENCES music_track_cache(track_id) ON DELETE CASCADE,
    played_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, track_id)
);
CREATE INDEX IF NOT EXISTS music_recent_track_user_idx ON music_recent_track(user_id, played_at DESC);

-- Sandbox (QA) users. A sandbox user's billing runs entirely against Stripe
-- TEST mode: checkout, portal, customer record, and webhook entitlement writes
-- all use the `stripe.sandbox` config block. `stripe_sandbox_customer_id` keeps
-- the test-mode customer separate from any live customer the same account may
-- have (so toggling sandbox off restores the live link untouched).
-- migration: 003_add_sandbox_to_users
ALTER TABLE users ADD COLUMN IF NOT EXISTS sandbox BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_sandbox_customer_id TEXT;

-- Assistant-message tool/reasoning traces. The server records the web-search
-- tool calls and thinking it performed to produce a reply so the client can
-- render them (VS Code chat style) after reload. Tool calls are display
-- artifacts only — they are never re-fed into provider context.
-- migration: 004_add_metadata_to_thread_message
ALTER TABLE thread_message ADD COLUMN IF NOT EXISTS metadata JSONB;

-- Discord account linking. A user links exactly one Discord account (unique
-- partial index); the link PERSISTS across guild leave/join cycles — leaving
-- the Discord server never clears discord_id, so entitlement roles (member /
-- no-ads / king-proxy) are re-granted automatically when they rejoin.
-- migration: 005_add_discord_to_users
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_avatar TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_updated TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS users_discord_id_idx ON users(discord_id) WHERE discord_id IS NOT NULL;

-- Discord guild verification (anti-alt gate). `ip_hash` is a salted SHA-256
-- of the verifier's IP — the raw IP is never stored. A second Discord account
-- verifying from the same IP hash is flagged as an alt.
-- `discord_pending_deletion` queues GDPR-style erasure requests (from the
-- /deletionrequest command or leaving the guild); processed by staff via
-- /deletepending, which also strips verified roles.
-- migration: 006_discord_verification
CREATE TABLE IF NOT EXISTS discord_verification (
    discord_id TEXT PRIMARY KEY,
    ip_hash TEXT NOT NULL,
    verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS discord_verification_ip_idx ON discord_verification(ip_hash);
CREATE TABLE IF NOT EXISTS discord_pending_deletion (
    discord_id TEXT PRIMARY KEY,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Discord community chat bridge. The site chatbox mirrors one or more public
-- guild text channels both ways (no DMs). `discord_bridge_message` is the
-- source of truth for web clients — every message the bot sees in a mapped
-- channel is persisted here, and every web-originated message is persisted
-- first, then delivered to Discord via that channel's webhook. Edits/deletes
-- are mirrored as `edited_at` / `deleted_at` tombstones (rows are never
-- removed). `discord_bridge_ban` backs site-side moderation; the shared
-- `moderation_event` audit log records every staff/automod action.
-- migration: 007_discord_bridge
CREATE TABLE IF NOT EXISTS discord_bridge_channel (
    id BIGSERIAL PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL UNIQUE,
    webhook_id TEXT,
    webhook_token TEXT,
    name TEXT NOT NULL DEFAULT '',
    topic TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS discord_bridge_message (
    id BIGSERIAL PRIMARY KEY,
    channel_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('discord', 'web')),
    discord_message_id TEXT,
    author_key TEXT NOT NULL,
    author_name TEXT NOT NULL,
    author_avatar TEXT,
    author_color TEXT,
    content TEXT NOT NULL DEFAULT '',
    attachments JSONB NOT NULL DEFAULT '[]',
    embeds JSONB NOT NULL DEFAULT '[]',
    mentions JSONB NOT NULL DEFAULT '[]',
    reply_to TEXT,
    client_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    edited_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS discord_bridge_message_discord_id_idx
    ON discord_bridge_message(discord_message_id) WHERE discord_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS discord_bridge_message_channel_idx
    ON discord_bridge_message(channel_id, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS discord_bridge_message_client_idx
    ON discord_bridge_message(author_key, client_id) WHERE client_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS discord_bridge_ban (
    id BIGSERIAL PRIMARY KEY,
    subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'discord', 'ip')),
    subject TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS discord_bridge_ban_subject_idx
    ON discord_bridge_ban(subject_type, subject) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS moderation_event (
    id BIGSERIAL PRIMARY KEY,
    actor TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    meta JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS moderation_event_created_idx ON moderation_event(id DESC);
CREATE INDEX IF NOT EXISTS moderation_event_subject_idx ON moderation_event(subject, id DESC);

-- Chat permissions use Discord-style permission bitfields over guild roles —
-- NOT site admin. "Webhooks" are the webhook delivery identities (web users
-- and Discord users alike). Each Discord guild role maps to a chat tier plus a
-- permission bitfield that gates viewing, sending, timing out, and banning
-- webhooks, and managing webhook permissions. Chat admin is independent of
-- site admin (revenue/analytics stay site-admin only).
-- migration: 008_discord_bridge_chat_roles
CREATE TABLE IF NOT EXISTS discord_bridge_chat_role (
    id BIGSERIAL PRIMARY KEY,
    role_id TEXT NOT NULL UNIQUE,          -- Discord guild role id
    role_name TEXT NOT NULL DEFAULT '',    -- display name (cached from guild)
    tier TEXT NOT NULL CHECK (tier IN ('member', 'mod', 'admin', 'owner')),
    position INTEGER NOT NULL DEFAULT 0,   -- Discord hierarchy position (higher = more powerful)
    color TEXT NOT NULL DEFAULT '',
    permissions BIGINT NOT NULL DEFAULT 1, -- bitfield: 1=VIEW,2=SEND,4=TIMEOUT,8=BAN,16=MANAGE_WEBHOOK
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS discord_bridge_chat_role_position_idx
    ON discord_bridge_chat_role(position DESC);

-- Active/expired timeouts against webhooks. A timed-out webhook cannot send in
-- the channel until timeout_until passes; the chat composer shows a live
-- countdown client-side. Issued by webhooks with the TIMEOUT permission (or
-- admin/owner), respecting Discord role hierarchy (can't time out a peer+).
CREATE TABLE IF NOT EXISTS discord_bridge_timeout (
    id BIGSERIAL PRIMARY KEY,
    channel_id TEXT NOT NULL,
    subject TEXT NOT NULL,                 -- webhook id (Discord user id or owner key)
    subject_name TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    issued_by TEXT NOT NULL DEFAULT '',
    issued_by_name TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    timeout_until TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS discord_bridge_timeout_active_idx
    ON discord_bridge_timeout(channel_id, subject) WHERE revoked_at IS NULL;

-- Per-channel webhook permission overrides. Webhooks with MANAGE_WEBHOOK grant
-- or revoke the right to view/send via a channel's webhook. `subject` is a
-- webhook id (Discord user id) or a chat role id.
CREATE TABLE IF NOT EXISTS discord_bridge_webhook_perm (
    id BIGSERIAL PRIMARY KEY,
    channel_id TEXT NOT NULL,
    subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'role')),
    subject TEXT NOT NULL,
    allow BIGINT NOT NULL DEFAULT 0,       -- allowed bits (VIEW=1, SEND=2)
    deny BIGINT NOT NULL DEFAULT 0,        -- denied bits (VIEW=1, SEND=2)
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (channel_id, subject_type, subject)
);

-- Carry the author's chat role tier on each message so the client can render a
-- role badge (MOD/ADMIN/OWNER) next to the author name. Webhook identities get
-- a WEBHOOK badge for free (direction='web'), so this column only stores the
-- moderation tier for users that have one.
-- migration: 009_discord_bridge_author_role
ALTER TABLE discord_bridge_message ADD COLUMN IF NOT EXISTS author_role TEXT;

-- Lockdown mode: a privileged webhook (mod+) can lock a channel, disabling
-- sending for all webhooks (a Discord-style channel lock). The composer shows a
-- "This channel is locked" bar client-side. Mods/admins/owners bypass the lock.
-- migration: 010_discord_bridge_channel_lock
ALTER TABLE discord_bridge_channel ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE;

-- Reactions on bridged messages. Each row is one webhook/user's reaction to a
-- message. `reactor_key` is the reactor's identity: a web user's author_key, or
-- `discord:<id>` for a Discord-originated reaction (a Discord user or another
-- bot). The bridge bot's own reaction is tracked by reactor_key = '__bridgebot'
-- so it is never persisted as a normal webhook reaction and is removed only
-- when the last real reactor unreacts. The bot reacts at most once per emoji
-- per message regardless of how many reactors there are.
-- migration: 011_discord_bridge_reaction
CREATE TABLE IF NOT EXISTS discord_bridge_reaction (
    id BIGSERIAL PRIMARY KEY,
    message_id BIGINT NOT NULL REFERENCES discord_bridge_message(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    reactor_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS discord_bridge_reaction_unique_idx
    ON discord_bridge_reaction(message_id, emoji, reactor_key);
CREATE INDEX IF NOT EXISTS discord_bridge_reaction_message_idx
    ON discord_bridge_reaction(message_id, emoji);

-- Guild member/role directory: a synced snapshot of the guild's members and
-- roles so the web chatbox can offer @mention autocomplete and resolve role
-- mentions without round-tripping Discord on every keystroke. The discord
-- service keeps these fresh from gateway events (member join/update/leave,
-- role create/update/delete) and an initial guild sync.
-- migration: 012_guild_member_role_directory
CREATE TABLE IF NOT EXISTS discord_bridge_guild_member (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL,
    avatar TEXT,
    PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS discord_bridge_guild_role (
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT,
    position INT NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, role_id)
);
-- Case-insensitive name lookups for mention autocomplete search.
CREATE INDEX IF NOT EXISTS discord_bridge_guild_member_display_name_idx
    ON discord_bridge_guild_member(guild_id, lower(display_name));
CREATE INDEX IF NOT EXISTS discord_bridge_guild_member_username_idx
    ON discord_bridge_guild_member(guild_id, lower(username));
CREATE INDEX IF NOT EXISTS discord_bridge_guild_role_name_idx
    ON discord_bridge_guild_role(guild_id, lower(name));

-- Message forwarding (Discord's Forward action). A forwarded message carries a
-- snapshot of the source message ({content, attachments, embeds, mentions,
-- createdAt, channelId, messageId, guildId}) — incoming Discord forwards from
-- message_snapshots, web forwards from the source bridge row. NULL for
-- ordinary messages. The snapshot's mentions never ping.
-- migration: 013_discord_bridge_forward
ALTER TABLE discord_bridge_message ADD COLUMN IF NOT EXISTS forwarded JSONB;

-- Reply mention toggle (Discord's reply-bar "@ ON/OFF"). TRUE = the reply
-- pings/highlights the replied-to author (Discord's default); FALSE = a quiet
-- reply (webhook delivery sends allowed_mentions.replied_user=false and the
-- web client doesn't count it as a mention). For Discord-originated replies it
-- records whether the reply actually pinged the referenced author.
-- migration: 014_discord_bridge_reply_mention
ALTER TABLE discord_bridge_message ADD COLUMN IF NOT EXISTS reply_mention BOOLEAN NOT NULL DEFAULT TRUE;

-- Uploaded chat avatars (replaces the client-side avatar URL setting). Every
-- upload is a row (audit trail): the server re-encodes the image itself (square
-- 256x256 WebP, metadata stripped) and stores only those bytes, never the
-- original upload. `source_sha256` hashes the raw upload, `sha256` the
-- normalized output (also the public URL key /api/avatars/<sha256>.webp).
-- A hash previously rejected/removed is rejected again immediately. Status:
-- 'pending' (awaiting automatic or manual review; also the fail-closed state
-- when the moderation model is unavailable), 'approved', 'rejected', 'removed'
-- (admin takedown; bytes purged, hashes kept for dedupe). Only 'approved' rows
-- are ever served or sent to Discord. users.chat_avatar_id points at the
-- user's active approved avatar (NULL = Discord avatar, then the default).
-- migration: 015_user_avatar
CREATE TABLE IF NOT EXISTS user_avatar (
    id BIGSERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    sha256 TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    source_format TEXT NOT NULL,
    bytes BYTEA,
    width INT NOT NULL,
    height INT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'removed')),
    categories TEXT[] NOT NULL DEFAULT '{}',
    reason TEXT,
    model TEXT,
    model_raw TEXT,
    -- Becomes the user's active avatar once approved. Cleared on the user's
    -- older rows when they upload again or remove their avatar, so a late
    -- approval never resurrects a superseded/cancelled upload.
    auto_activate BOOLEAN NOT NULL DEFAULT TRUE,
    reviewed_by INT REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS user_avatar_sha256_idx ON user_avatar(sha256);
CREATE INDEX IF NOT EXISTS user_avatar_source_sha256_idx ON user_avatar(source_sha256);
CREATE INDEX IF NOT EXISTS user_avatar_user_idx ON user_avatar(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS user_avatar_status_idx ON user_avatar(status, created_at DESC);
ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_avatar_id BIGINT REFERENCES user_avatar(id) ON DELETE SET NULL;

-- Message search (the chatbox's Discord-style channel-header search). Content
-- is matched with full-text search over the 'english' config (stemmed word
-- tokens + stop words, like Discord's analyzer); this GIN index backs the
-- `to_tsvector('english', content) @@ plainto_tsquery('english', $q)`
-- predicate in discord-bridge-db.ts searchMessages(). Partial on live rows
-- because search always excludes deleted messages. No extension required.
-- migration: 016_discord_bridge_message_search
CREATE INDEX IF NOT EXISTS discord_bridge_message_content_fts_idx
    ON discord_bridge_message USING GIN (to_tsvector('english', content))
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS discord_bridge_message_author_idx
    ON discord_bridge_message(author_key, id DESC) WHERE deleted_at IS NULL;

-- Discord APP tag. TRUE when a Discord-originated row was authored by a bot or
-- a (foreign) webhook, i.e. Discord renders the "APP" botTag next to the
-- author. Web-originated rows are always webhook deliveries and get the tag
-- from direction = 'web', so this stays FALSE for them.
-- migration: 017_discord_bridge_author_bot
ALTER TABLE discord_bridge_message ADD COLUMN IF NOT EXISTS author_bot BOOLEAN NOT NULL DEFAULT FALSE;

-- Application commands + message components (slash-command "{user} used /cmd"
-- header, "is thinking..." deferred state, buttons/selects/Components V2).
-- message_type: Discord message type (20 CHAT_INPUT_COMMAND, 23
-- CONTEXT_MENU_COMMAND, ...). interaction: normalized interaction metadata
-- (invoking user + command name path). components: normalized V1/V2 component
-- tree (discord-interactions.ts). flags: Discord message flags (LOADING,
-- IS_COMPONENTS_V2, SUPPRESS_EMBEDS).
-- migration: 018_discord_bridge_interactions
ALTER TABLE discord_bridge_message ADD COLUMN IF NOT EXISTS message_type SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE discord_bridge_message ADD COLUMN IF NOT EXISTS interaction JSONB;
ALTER TABLE discord_bridge_message ADD COLUMN IF NOT EXISTS components JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE discord_bridge_message ADD COLUMN IF NOT EXISTS flags INT NOT NULL DEFAULT 0;

-- Discord profile cosmetics a bot can read, for the chatbox's 1:1 author
-- rendering (author styles endpoint + profile popout):
--   discord_bridge_guild_role.colors: the role's enhanced colors
--     {primary, secondary, tertiary} as '#rrggbb' (secondary set = gradient
--     role style, tertiary set = holographic).
--   discord_bridge_guild_member.role_ids: held role ids (resolves the color
--     role, i.e. the highest-positioned role with a non-zero color).
--   joined_at / member_flags (bit 0 = DID_REJOIN) / bot: Discord's "I'm new
--     here, say hi!" new-member badge (joined <= 7 days ago, not a rejoin,
--     not a bot).
--   style: user cosmetics {decoration: {asset, skuId}, nameplate: {asset,
--     palette, label, skuId}, guildTag: {guildId, tag, badge},
--     displayNameStyles: {fontId, effectId, colors}}.
-- migration: 019_discord_bridge_author_style
ALTER TABLE discord_bridge_guild_role ADD COLUMN IF NOT EXISTS colors JSONB;
ALTER TABLE discord_bridge_guild_member ADD COLUMN IF NOT EXISTS role_ids TEXT[];
ALTER TABLE discord_bridge_guild_member ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ;
ALTER TABLE discord_bridge_guild_member ADD COLUMN IF NOT EXISTS member_flags INT NOT NULL DEFAULT 0;
ALTER TABLE discord_bridge_guild_member ADD COLUMN IF NOT EXISTS bot BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE discord_bridge_guild_member ADD COLUMN IF NOT EXISTS style JSONB;

-- Webhook identities for moderation. Every moderation action (timeouts,
-- bans, per-channel webhook overwrites) targets a WEBHOOK identity: a site
-- account (web-originated author_key `user:<id>`) and/or a Discord user
-- (`discord:<id>`); a site account with a linked Discord is one identity and
-- the server writes a row per side. Bans already had both subjects
-- ('user' = site account id, 'discord'). This adds:
--   discord_bridge_timeout.subject_type: 'discord' (subject = snowflake; every
--     pre-existing row) or 'site' (subject = site user id). Legacy rows that
--     stored an owner key ('user:<id>') are normalized to 'site'.
--   discord_bridge_webhook_perm.subject_type: 'site' (subject = site user id)
--     alongside 'user' (Discord user id) and 'role'.
-- The CREATE TABLE IF NOT EXISTS is a no-op where 008 already created it
-- (repairs environments whose 008 predates the timeout table).
-- migration: 020_discord_bridge_webhook_identity
CREATE TABLE IF NOT EXISTS discord_bridge_timeout (
    id BIGSERIAL PRIMARY KEY,
    channel_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    subject_name TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    issued_by TEXT NOT NULL DEFAULT '',
    issued_by_name TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    timeout_until TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
);
ALTER TABLE discord_bridge_timeout ADD COLUMN IF NOT EXISTS subject_type TEXT NOT NULL DEFAULT 'discord';
UPDATE discord_bridge_timeout SET subject_type = 'site', subject = substring(subject FROM 6)
    WHERE subject ~ '^user:[0-9]+$';
UPDATE discord_bridge_timeout SET subject = substring(subject FROM 9)
    WHERE subject ~ '^discord:[0-9]+$';
ALTER TABLE discord_bridge_timeout DROP CONSTRAINT IF EXISTS discord_bridge_timeout_subject_type_check;
ALTER TABLE discord_bridge_timeout ADD CONSTRAINT discord_bridge_timeout_subject_type_check
    CHECK (subject_type IN ('discord', 'site'));
DROP INDEX IF EXISTS discord_bridge_timeout_active_idx;
CREATE INDEX IF NOT EXISTS discord_bridge_timeout_subject_active_idx
    ON discord_bridge_timeout(channel_id, subject_type, subject) WHERE revoked_at IS NULL;
ALTER TABLE discord_bridge_webhook_perm DROP CONSTRAINT IF EXISTS discord_bridge_webhook_perm_subject_type_check;
ALTER TABLE discord_bridge_webhook_perm ADD CONSTRAINT discord_bridge_webhook_perm_subject_type_check
    CHECK (subject_type IN ('user', 'role', 'site'));

-- Server Onboarding, emulated for web webhooks (discord-onboarding.ts). One
-- row per (guild, webhook identity); identity_key is the web author key
-- ('user:<siteId>'). Nothing here is written to Discord: selected options'
-- roles are emulated for channel visibility of web-only identities, and the
-- opt-in lists drive the chatbox sidebar (Discord's opt-in channel model).
--   responses: selected onboarding option ids (all prompts).
--   opted_in_channel_ids / opted_out_channel_ids: Browse Channels follows and
--     explicit unfollows of option-granted channels (channel or category ids).
--   show_all_channels: Browse Channels "Show All Channels".
--   new_member: the identity was new (no chat history, not a guild member)
--     when its row was created — only new identities get the onboarding flow.
-- migration: 021_discord_bridge_onboarding
CREATE TABLE IF NOT EXISTS discord_bridge_onboarding_state (
    guild_id TEXT NOT NULL,
    identity_key TEXT NOT NULL,
    responses TEXT[] NOT NULL DEFAULT '{}',
    opted_in_channel_ids TEXT[] NOT NULL DEFAULT '{}',
    opted_out_channel_ids TEXT[] NOT NULL DEFAULT '{}',
    show_all_channels BOOLEAN NOT NULL DEFAULT FALSE,
    new_member BOOLEAN NOT NULL DEFAULT TRUE,
    completed_at TIMESTAMPTZ,
    rules_accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (guild_id, identity_key)
);

-- migration: 022_user_avatar_auto_activate
-- 015 gained auto_activate after some databases had already recorded it as
-- applied, so those databases never got the column. Add it idempotently.
ALTER TABLE user_avatar ADD COLUMN IF NOT EXISTS auto_activate BOOLEAN NOT NULL DEFAULT TRUE;

-- migration: 023_discord_bridge_chat_role_permissions
-- Some databases created discord_bridge_chat_role from an older design (no
-- `permissions` bitfield), and 008's CREATE TABLE IF NOT EXISTS skipped it.
-- Add the column idempotently; discord-service's startup role sync fills it.
ALTER TABLE discord_bridge_chat_role ADD COLUMN IF NOT EXISTS permissions BIGINT NOT NULL DEFAULT 1;

-- migration: 024_user_profile_text
-- Chat profile text (Discord Edit Profile): pronouns and About Me, shown in the
-- profile popout and the signed-in user's account card.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pronouns TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS about_me TEXT;

-- migration: 026_user_chat_display_name
-- Chat display name: the name a site account's WEB messages show in the
-- chatbox (delivered to Discord via the channel webhook). NULL = use the site
-- username. Validated in account-api / chat-display-name.ts.
ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_display_name TEXT;

-- migration: 025_ai_usage_ledger
-- Person-level AI usage. Limits follow the PERSON (verified email, linked
-- Discord id, and every identity an account has held), not the users row, so
-- deleting and recreating an account cannot reset today's allowance.
-- identity_key is an opaque salted hash (see ai-usage-identity.ts); no raw
-- emails or Discord ids are stored here.
CREATE TABLE IF NOT EXISTS ai_usage_ledger (
    identity_key TEXT NOT NULL,
    bucket_day DATE NOT NULL,
    requests INT NOT NULL DEFAULT 0,
    tokens BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (identity_key, bucket_day)
);

-- Which identity keys each account has held. Deliberately NO foreign key on
-- user_id: the history must outlive the account row.
CREATE TABLE IF NOT EXISTS ai_usage_identity (
    user_id INT NOT NULL,
    identity_key TEXT NOT NULL,
    PRIMARY KEY (user_id, identity_key)
);

-- Audit marker written when an account with a verified email is deleted.
-- email_hash = salted sha256 of the normalized email (never the raw address).
CREATE TABLE IF NOT EXISTS deleted_account_email (
    email_hash TEXT PRIMARY KEY,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Carry existing per-account usage into the ledger under each account's own
-- key so today's counters do not reset on deploy. Idempotent.
INSERT INTO ai_usage_identity (user_id, identity_key)
SELECT DISTINCT user_id, 'account:' || user_id FROM ai_usage
ON CONFLICT (user_id, identity_key) DO NOTHING;
INSERT INTO ai_usage_ledger (identity_key, bucket_day, requests, tokens)
SELECT 'account:' || user_id, day, requests, tokens FROM ai_usage
ON CONFLICT (identity_key, bucket_day) DO NOTHING;

-- migration: 027_user_presence_status
-- Persisted presence choice for site accounts (Set Status). Live state
-- (online/idle/offline) is derived from realtime sockets, never stored.
ALTER TABLE users ADD COLUMN IF NOT EXISTS presence_status TEXT NOT NULL DEFAULT 'online';

-- migration: 028_user_guild_folders
-- Per-account server rail layout (Discord's guildFolders user setting): a JSON
-- array of root rail entries, { guildIds: [id] } for a bare server or
-- { id, name, color, guildIds } for a folder. Written by
-- POST /api/account/guild-folders (validated in server/guild-folders.ts).
-- Ids that don't resolve to a bridged guild are skipped by the client.
ALTER TABLE users ADD COLUMN IF NOT EXISTS guild_folders JSONB NOT NULL DEFAULT '[]'::jsonb;

-- migration: 029_discord_bridge_multi_guild
-- Multi-guild, category-based bridging (config.discord.bridgeCategories).
--   discord_bridge_chat_role.guild_id: the guild the chat role belongs to.
--     Role positions only compare within one guild, so the per-guild site
--     admin role / member-floor position filter on it. Backfilled from the
--     synced role directory; discord-service's startup syncChatRoles stamps
--     every row (rows still NULL are treated as the home guild).
--   discord_bridge_ban.guild_id: NULL = a global ban (every pre-existing row,
--     site admins, home-guild staff); otherwise the guild of the channel the
--     ban was issued from. A ban check in guild G matches
--     guild_id IS NULL OR guild_id = G.
--   discord_bridge_channel.parent_id: the channel's Discord category, stored
--     on every upsert so /channels can group bridged channels by category
--     when the live guild snapshot is unavailable.
--   discord_bridge_channel.everyone_can_view: @everyone can VIEW the channel
--     on Discord (guild @everyone role + the channel's @everyone overwrite),
--     computed by the bot on every sync. When a guild snapshot is
--     unavailable, only these channels stay readable (fail closed); FALSE
--     until the bot has synced the row.
--   moderation_event.guild_id: the guild an action happened in. Partner
--     guilds' /bridge modlog shows only their own rows; NULL rows (global
--     actions) appear only in the home guild's view.
ALTER TABLE discord_bridge_chat_role ADD COLUMN IF NOT EXISTS guild_id TEXT;
UPDATE discord_bridge_chat_role c SET guild_id = r.guild_id
    FROM discord_bridge_guild_role r
    WHERE c.guild_id IS NULL AND r.role_id = c.role_id;
CREATE INDEX IF NOT EXISTS discord_bridge_chat_role_guild_idx
    ON discord_bridge_chat_role(guild_id, tier, position DESC);
ALTER TABLE discord_bridge_ban ADD COLUMN IF NOT EXISTS guild_id TEXT;
ALTER TABLE discord_bridge_channel ADD COLUMN IF NOT EXISTS parent_id TEXT;
ALTER TABLE discord_bridge_channel ADD COLUMN IF NOT EXISTS everyone_can_view BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS discord_bridge_channel_guild_idx
    ON discord_bridge_channel(guild_id) WHERE enabled = TRUE;
ALTER TABLE moderation_event ADD COLUMN IF NOT EXISTS guild_id TEXT;
UPDATE moderation_event e SET guild_id = c.guild_id
    FROM discord_bridge_channel c
    WHERE e.guild_id IS NULL AND c.channel_id = e.meta->>'channelId';
CREATE INDEX IF NOT EXISTS moderation_event_guild_idx
    ON moderation_event(guild_id, id DESC);

-- migration: 030_tools_usage
-- Daily free DeltaMath question/answer fetch counter (leak + problem).
CREATE TABLE IF NOT EXISTS tools_usage (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day DATE NOT NULL DEFAULT CURRENT_DATE,
  dm_fetches INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
CREATE INDEX IF NOT EXISTS tools_usage_day_idx ON tools_usage (day);

-- migration: 031_traffic_events
-- Admin traffic log: AI requests + wisp connects with IP / geo.
CREATE TABLE IF NOT EXISTS traffic_events (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ai', 'wisp')),
  ip TEXT NOT NULL,
  country TEXT,
  city TEXT,
  region TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  path TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS traffic_events_created_idx ON traffic_events (created DESC);
CREATE INDEX IF NOT EXISTS traffic_events_kind_created_idx ON traffic_events (kind, created DESC);
CREATE INDEX IF NOT EXISTS traffic_events_ip_idx ON traffic_events (ip, created DESC);

-- migration: 032_discord_link_dispenser
-- Discord link dispenser (/links). Staff keep a pool of site links; each
-- verified home-guild member draws a monthly quota by plan (free 2, No Ads 4,
-- King Proxy 8). A link is never handed to the same identity twice. Members
-- may report a link they drew as blocked; enough distinct reporters retire it.
CREATE TABLE IF NOT EXISTS link_dispenser_link (
  id SERIAL PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  added_by TEXT,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS link_dispenser_grant (
  id BIGSERIAL PRIMARY KEY,
  link_id INTEGER NOT NULL REFERENCES link_dispenser_link(id) ON DELETE CASCADE,
  discord_id TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  plan TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS link_dispenser_grant_discord_idx ON link_dispenser_grant (discord_id, granted_at);
CREATE INDEX IF NOT EXISTS link_dispenser_grant_user_idx ON link_dispenser_grant (user_id, granted_at) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS link_dispenser_grant_link_idx ON link_dispenser_grant (link_id, granted_at);
CREATE TABLE IF NOT EXISTS link_dispenser_report (
  link_id INTEGER NOT NULL REFERENCES link_dispenser_link(id) ON DELETE CASCADE,
  discord_id TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (link_id, discord_id)
);

-- migration: 033_ai_model_quota_ledger
-- Weighted-token AI quotas (main/src/ai-plans.ts): one row per identity key,
-- UTC day and model. weighted = input + output * model multiplier. The plan's
-- daily quota is the SUM over a key's models; the model quota is that model's
-- row. Keys are the person-level ledger keys (ai-usage-identity.ts) or
-- 'guest:<ip>' for signed-out callers.
CREATE TABLE IF NOT EXISTS ai_model_usage_ledger (
    identity_key TEXT NOT NULL,
    bucket_day DATE NOT NULL,
    model TEXT NOT NULL,
    weighted_tokens BIGINT NOT NULL DEFAULT 0,
    input_tokens BIGINT NOT NULL DEFAULT 0,
    output_tokens BIGINT NOT NULL DEFAULT 0,
    requests INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (identity_key, bucket_day, model)
);
CREATE INDEX IF NOT EXISTS ai_model_usage_ledger_day_idx ON ai_model_usage_ledger (bucket_day);

-- migration: 034_abstract_ai
-- Accounts API keys and Abstract AI: subscriptions, usage metering and billing events.
-- Folded from the unpushed 034-039 migrations; none of them had run on prod. The model
-- catalogue is configuration (config.js ai.models), so it has no table.

-- Account API keys for the /api/ai endpoints (Authorization: Bearer abs_...). Only the
-- sha256 hex of the full key is stored (key_hash); key_prefix is the short display form.
-- Revoked keys keep their row (revoked_at) for history.
CREATE TABLE IF NOT EXISTS api_keys (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_hash_idx ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS api_keys_user_active_idx ON api_keys (user_id) WHERE revoked_at IS NULL;

-- Abstract AI entitlement lives in its own columns so it never touches paid_until or
-- noads_until. plan_until is the current period end from Stripe; a plan is active
-- while it is in the future. The sandbox customer is kept apart from the live one.
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_stripe_sandbox_customer_id TEXT;
-- Password reset: users.password_reset_secret holds the sha256 of the emailed code; the code expires at password_reset_expires.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS users_plan_stripe_customer_idx ON users (plan_stripe_customer_id) WHERE plan_stripe_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_plan_stripe_sandbox_customer_idx ON users (plan_stripe_sandbox_customer_id) WHERE plan_stripe_sandbox_customer_id IS NOT NULL;

-- Each Stripe event id is recorded once, so webhook retries are no-ops.
CREATE TABLE IF NOT EXISTS billing_event (
    stripe_event_id TEXT PRIMARY KEY,
    received TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Usage metering (main/src/server/abstract-relay/). A window starts at its first recorded use
-- and resets as a whole at window_start + length (fixed, not sliding). Units are
-- (prompt + completion tokens) x multiplier.
CREATE TABLE IF NOT EXISTS usage_window (
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('five_hour', 'weekly')),
    window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    used_units NUMERIC NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, kind)
);

-- One row per metered request (the audit trail for the window totals).
CREATE TABLE IF NOT EXISTS usage_event (
    id BIGSERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    multiplier NUMERIC NOT NULL,
    units NUMERIC NOT NULL,
    created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    input_tokens INT NOT NULL DEFAULT 0,
    output_tokens INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS usage_event_user_idx ON usage_event (user_id, created DESC);

-- migration: 035_abstract_subscription
-- What the site shows and changes for an Abstract AI plan: the Stripe subscription behind it, its
-- billing interval, a pending cancel and a pending downgrade (a Subscription Schedule). Stripe is the
-- source; the billing routes and the webhook refresh this row. Entitlement stays in users.plan / plan_until.
CREATE TABLE IF NOT EXISTS abstract_subscription (
    user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('live', 'sandbox')),
    subscription_id TEXT NOT NULL,
    plan TEXT NOT NULL,
    billing_interval TEXT NOT NULL CHECK (billing_interval IN ('monthly', 'annual')),
    status TEXT NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    cancel_at TIMESTAMPTZ,
    schedule_id TEXT,
    next_plan TEXT,
    next_billing_interval TEXT,
    next_at TIMESTAMPTZ,
    updated TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS abstract_subscription_sub_idx ON abstract_subscription (subscription_id);

-- migration: 036_bridge_ext_subjects
-- holt phase 1 step 3: bans, timeouts and per-channel member overwrites can name another platform's
-- identity (subject_type 'ext', subject = '<namespace>:<subject>', for example 'nocturne:u_77').
-- Additive: widens the three CHECKs, changes no rows. The code matched 'ext' already and failed at
-- these CHECKs on write (abulxt 219480c8). Runs as one statement batch, so as one transaction.
ALTER TABLE discord_bridge_ban DROP CONSTRAINT IF EXISTS discord_bridge_ban_subject_type_check;
ALTER TABLE discord_bridge_ban ADD CONSTRAINT discord_bridge_ban_subject_type_check
    CHECK (subject_type IN ('user', 'discord', 'ip', 'ext'));
ALTER TABLE discord_bridge_timeout DROP CONSTRAINT IF EXISTS discord_bridge_timeout_subject_type_check;
ALTER TABLE discord_bridge_timeout ADD CONSTRAINT discord_bridge_timeout_subject_type_check
    CHECK (subject_type IN ('discord', 'site', 'ext'));
ALTER TABLE discord_bridge_webhook_perm DROP CONSTRAINT IF EXISTS discord_bridge_webhook_perm_subject_type_check;
ALTER TABLE discord_bridge_webhook_perm ADD CONSTRAINT discord_bridge_webhook_perm_subject_type_check
    CHECK (subject_type IN ('user', 'role', 'site', 'ext'));
