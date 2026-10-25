-- holt's database schema (its own `holt` database since the standalone cutover, 2026-10-24).
--
-- Applied by main/src/server/db.ts ensureSchema() at startup: this baseline (everything before the first
-- `-- migration:` marker) runs every time and must stay idempotent; each migration runs exactly once, in
-- order, recorded in schema_migrations. Never edit an applied migration: append a new one.
--
-- The baseline is the chat schema as it stood in abulxt's database at the cutover (abulxt migrations up to
-- 038_discord_bridge_forums), generated from pg_dump. The cutover copies those tables, data included, so on
-- the live database the guarded block below is a no-op; on a fresh database it creates them.

CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $holt_baseline$
BEGIN
  IF to_regclass('public.discord_bridge_message') IS NULL THEN
    CREATE TABLE public.discord_bridge_ban (
        id bigint NOT NULL,
        subject_type text NOT NULL,
        subject text NOT NULL,
        reason text DEFAULT ''::text NOT NULL,
        created_by text DEFAULT ''::text NOT NULL,
        created_at timestamp with time zone DEFAULT now() NOT NULL,
        expires_at timestamp with time zone,
        revoked_at timestamp with time zone,
        guild_id text,
        CONSTRAINT discord_bridge_ban_subject_type_check CHECK ((subject_type = ANY (ARRAY['user'::text, 'discord'::text, 'ip'::text, 'ext'::text])))
    );
    CREATE SEQUENCE public.discord_bridge_ban_id_seq
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1;
    ALTER SEQUENCE public.discord_bridge_ban_id_seq OWNED BY public.discord_bridge_ban.id;
    CREATE TABLE public.discord_bridge_channel (
        id bigint NOT NULL,
        guild_id text NOT NULL,
        channel_id text NOT NULL,
        webhook_id text,
        webhook_token text,
        name text DEFAULT ''::text NOT NULL,
        topic text DEFAULT ''::text NOT NULL,
        "position" integer DEFAULT 0 NOT NULL,
        enabled boolean DEFAULT true NOT NULL,
        created_at timestamp with time zone DEFAULT now() NOT NULL,
        locked boolean DEFAULT false NOT NULL,
        parent_id text,
        everyone_can_view boolean DEFAULT false NOT NULL,
        type smallint DEFAULT 0 NOT NULL,
        available_tags jsonb DEFAULT '[]'::jsonb NOT NULL,
        default_reaction_emoji jsonb,
        default_sort_order smallint,
        default_forum_layout smallint DEFAULT 0 NOT NULL,
        flags integer DEFAULT 0 NOT NULL,
        default_thread_rate_limit_per_user integer DEFAULT 0 CONSTRAINT discord_bridge_channel_default_thread_rate_limit_per_u_not_null NOT NULL,
        rate_limit_per_user integer DEFAULT 0 NOT NULL
    );
    CREATE SEQUENCE public.discord_bridge_channel_id_seq
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1;
    ALTER SEQUENCE public.discord_bridge_channel_id_seq OWNED BY public.discord_bridge_channel.id;
    CREATE TABLE public.discord_bridge_chat_role (
        id bigint NOT NULL,
        role_id text NOT NULL,
        role_name text DEFAULT ''::text NOT NULL,
        tier text NOT NULL,
        "position" integer DEFAULT 0 NOT NULL,
        color text DEFAULT ''::text NOT NULL,
        permissions bigint DEFAULT 1 NOT NULL,
        updated_at timestamp with time zone DEFAULT now() NOT NULL,
        guild_id text,
        CONSTRAINT discord_bridge_chat_role_tier_check CHECK ((tier = ANY (ARRAY['member'::text, 'mod'::text, 'admin'::text, 'owner'::text])))
    );
    CREATE SEQUENCE public.discord_bridge_chat_role_id_seq
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1;
    ALTER SEQUENCE public.discord_bridge_chat_role_id_seq OWNED BY public.discord_bridge_chat_role.id;
    CREATE TABLE public.discord_bridge_guild_member (
        guild_id text NOT NULL,
        user_id text NOT NULL,
        username text NOT NULL,
        display_name text NOT NULL,
        avatar text,
        role_ids text[],
        joined_at timestamp with time zone,
        member_flags integer DEFAULT 0 NOT NULL,
        bot boolean DEFAULT false NOT NULL,
        style jsonb
    );
    CREATE TABLE public.discord_bridge_guild_role (
        guild_id text NOT NULL,
        role_id text NOT NULL,
        name text NOT NULL,
        color text,
        "position" integer DEFAULT 0 NOT NULL,
        colors jsonb
    );
    CREATE TABLE public.discord_bridge_message (
        id bigint NOT NULL,
        channel_id text NOT NULL,
        direction text NOT NULL,
        discord_message_id text,
        author_key text NOT NULL,
        author_name text NOT NULL,
        author_avatar text,
        author_color text,
        content text DEFAULT ''::text NOT NULL,
        attachments jsonb DEFAULT '[]'::jsonb NOT NULL,
        embeds jsonb DEFAULT '[]'::jsonb NOT NULL,
        mentions jsonb DEFAULT '[]'::jsonb NOT NULL,
        reply_to text,
        client_id text,
        created_at timestamp with time zone DEFAULT now() NOT NULL,
        edited_at timestamp with time zone,
        deleted_at timestamp with time zone,
        author_role text,
        forwarded jsonb,
        reply_mention boolean DEFAULT true NOT NULL,
        author_bot boolean DEFAULT false NOT NULL,
        message_type smallint DEFAULT 0 NOT NULL,
        interaction jsonb,
        components jsonb DEFAULT '[]'::jsonb NOT NULL,
        flags integer DEFAULT 0 NOT NULL,
        CONSTRAINT discord_bridge_message_direction_check CHECK ((direction = ANY (ARRAY['discord'::text, 'web'::text])))
    );
    CREATE SEQUENCE public.discord_bridge_message_id_seq
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1;
    ALTER SEQUENCE public.discord_bridge_message_id_seq OWNED BY public.discord_bridge_message.id;
    CREATE TABLE public.discord_bridge_onboarding_state (
        guild_id text NOT NULL,
        identity_key text NOT NULL,
        responses text[] DEFAULT '{}'::text[] NOT NULL,
        opted_in_channel_ids text[] DEFAULT '{}'::text[] NOT NULL,
        opted_out_channel_ids text[] DEFAULT '{}'::text[] NOT NULL,
        show_all_channels boolean DEFAULT false NOT NULL,
        new_member boolean DEFAULT true NOT NULL,
        completed_at timestamp with time zone,
        rules_accepted_at timestamp with time zone,
        created_at timestamp with time zone DEFAULT now() NOT NULL,
        updated_at timestamp with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE public.discord_bridge_post (
        id bigint NOT NULL,
        thread_id text,
        channel_id text NOT NULL,
        guild_id text NOT NULL,
        name text NOT NULL,
        owner_key text NOT NULL,
        owner_name text DEFAULT ''::text NOT NULL,
        owner_avatar text,
        owner_color text,
        applied_tags text[] DEFAULT '{}'::text[] NOT NULL,
        flags integer DEFAULT 0 NOT NULL,
        archived boolean DEFAULT false NOT NULL,
        locked boolean DEFAULT false NOT NULL,
        auto_archive_duration integer,
        archive_timestamp timestamp with time zone,
        rate_limit_per_user integer DEFAULT 0 NOT NULL,
        message_count integer DEFAULT 0 NOT NULL,
        total_message_sent integer DEFAULT 0 NOT NULL,
        last_message_id text,
        last_activity_at timestamp with time zone DEFAULT now() NOT NULL,
        starter_message_id bigint,
        direction text NOT NULL,
        client_id text,
        delivery_error integer,
        created_at timestamp with time zone DEFAULT now() NOT NULL,
        deleted_at timestamp with time zone,
        CONSTRAINT discord_bridge_post_direction_check CHECK ((direction = ANY (ARRAY['discord'::text, 'web'::text])))
    );
    CREATE SEQUENCE public.discord_bridge_post_id_seq
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1;
    ALTER SEQUENCE public.discord_bridge_post_id_seq OWNED BY public.discord_bridge_post.id;
    CREATE TABLE public.discord_bridge_reaction (
        id bigint NOT NULL,
        message_id bigint NOT NULL,
        emoji text NOT NULL,
        reactor_key text NOT NULL,
        created_at timestamp with time zone DEFAULT now() NOT NULL
    );
    CREATE SEQUENCE public.discord_bridge_reaction_id_seq
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1;
    ALTER SEQUENCE public.discord_bridge_reaction_id_seq OWNED BY public.discord_bridge_reaction.id;
    CREATE TABLE public.discord_bridge_timeout (
        id bigint NOT NULL,
        channel_id text NOT NULL,
        subject text NOT NULL,
        subject_name text DEFAULT ''::text NOT NULL,
        reason text DEFAULT ''::text NOT NULL,
        issued_by text DEFAULT ''::text NOT NULL,
        issued_by_name text DEFAULT ''::text NOT NULL,
        created_at timestamp with time zone DEFAULT now() NOT NULL,
        timeout_until timestamp with time zone NOT NULL,
        revoked_at timestamp with time zone,
        subject_type text DEFAULT 'discord'::text NOT NULL,
        CONSTRAINT discord_bridge_timeout_subject_type_check CHECK ((subject_type = ANY (ARRAY['discord'::text, 'site'::text, 'ext'::text])))
    );
    CREATE SEQUENCE public.discord_bridge_timeout_id_seq
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1;
    ALTER SEQUENCE public.discord_bridge_timeout_id_seq OWNED BY public.discord_bridge_timeout.id;
    CREATE TABLE public.discord_bridge_webhook_perm (
        id bigint NOT NULL,
        channel_id text NOT NULL,
        subject_type text NOT NULL,
        subject text NOT NULL,
        allow bigint DEFAULT 0 NOT NULL,
        deny bigint DEFAULT 0 NOT NULL,
        created_by text DEFAULT ''::text NOT NULL,
        created_at timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT discord_bridge_webhook_perm_subject_type_check CHECK ((subject_type = ANY (ARRAY['user'::text, 'role'::text, 'site'::text, 'ext'::text])))
    );
    CREATE SEQUENCE public.discord_bridge_webhook_perm_id_seq
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1;
    ALTER SEQUENCE public.discord_bridge_webhook_perm_id_seq OWNED BY public.discord_bridge_webhook_perm.id;
    CREATE TABLE public.event_log (
        seq bigint NOT NULL,
        owner_key text NOT NULL,
        type text NOT NULL,
        payload jsonb,
        created timestamp with time zone DEFAULT now() NOT NULL
    );
    CREATE SEQUENCE public.event_log_seq_seq
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1;
    ALTER SEQUENCE public.event_log_seq_seq OWNED BY public.event_log.seq;
    CREATE TABLE public.moderation_event (
        id bigint NOT NULL,
        actor text DEFAULT ''::text NOT NULL,
        action text NOT NULL,
        subject text DEFAULT ''::text NOT NULL,
        reason text DEFAULT ''::text NOT NULL,
        meta jsonb DEFAULT '{}'::jsonb NOT NULL,
        created_at timestamp with time zone DEFAULT now() NOT NULL,
        guild_id text
    );
    CREATE SEQUENCE public.moderation_event_id_seq
        START WITH 1
        INCREMENT BY 1
        NO MINVALUE
        NO MAXVALUE
        CACHE 1;
    ALTER SEQUENCE public.moderation_event_id_seq OWNED BY public.moderation_event.id;
    ALTER TABLE ONLY public.discord_bridge_ban ALTER COLUMN id SET DEFAULT nextval('public.discord_bridge_ban_id_seq'::regclass);
    ALTER TABLE ONLY public.discord_bridge_channel ALTER COLUMN id SET DEFAULT nextval('public.discord_bridge_channel_id_seq'::regclass);
    ALTER TABLE ONLY public.discord_bridge_chat_role ALTER COLUMN id SET DEFAULT nextval('public.discord_bridge_chat_role_id_seq'::regclass);
    ALTER TABLE ONLY public.discord_bridge_message ALTER COLUMN id SET DEFAULT nextval('public.discord_bridge_message_id_seq'::regclass);
    ALTER TABLE ONLY public.discord_bridge_post ALTER COLUMN id SET DEFAULT nextval('public.discord_bridge_post_id_seq'::regclass);
    ALTER TABLE ONLY public.discord_bridge_reaction ALTER COLUMN id SET DEFAULT nextval('public.discord_bridge_reaction_id_seq'::regclass);
    ALTER TABLE ONLY public.discord_bridge_timeout ALTER COLUMN id SET DEFAULT nextval('public.discord_bridge_timeout_id_seq'::regclass);
    ALTER TABLE ONLY public.discord_bridge_webhook_perm ALTER COLUMN id SET DEFAULT nextval('public.discord_bridge_webhook_perm_id_seq'::regclass);
    ALTER TABLE ONLY public.event_log ALTER COLUMN seq SET DEFAULT nextval('public.event_log_seq_seq'::regclass);
    ALTER TABLE ONLY public.moderation_event ALTER COLUMN id SET DEFAULT nextval('public.moderation_event_id_seq'::regclass);
    ALTER TABLE ONLY public.discord_bridge_ban
        ADD CONSTRAINT discord_bridge_ban_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.discord_bridge_channel
        ADD CONSTRAINT discord_bridge_channel_channel_id_key UNIQUE (channel_id);
    ALTER TABLE ONLY public.discord_bridge_channel
        ADD CONSTRAINT discord_bridge_channel_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.discord_bridge_chat_role
        ADD CONSTRAINT discord_bridge_chat_role_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.discord_bridge_chat_role
        ADD CONSTRAINT discord_bridge_chat_role_role_id_key UNIQUE (role_id);
    ALTER TABLE ONLY public.discord_bridge_guild_member
        ADD CONSTRAINT discord_bridge_guild_member_pkey PRIMARY KEY (guild_id, user_id);
    ALTER TABLE ONLY public.discord_bridge_guild_role
        ADD CONSTRAINT discord_bridge_guild_role_pkey PRIMARY KEY (guild_id, role_id);
    ALTER TABLE ONLY public.discord_bridge_message
        ADD CONSTRAINT discord_bridge_message_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.discord_bridge_onboarding_state
        ADD CONSTRAINT discord_bridge_onboarding_state_pkey PRIMARY KEY (guild_id, identity_key);
    ALTER TABLE ONLY public.discord_bridge_post
        ADD CONSTRAINT discord_bridge_post_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.discord_bridge_post
        ADD CONSTRAINT discord_bridge_post_thread_id_key UNIQUE (thread_id);
    ALTER TABLE ONLY public.discord_bridge_reaction
        ADD CONSTRAINT discord_bridge_reaction_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.discord_bridge_timeout
        ADD CONSTRAINT discord_bridge_timeout_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.discord_bridge_webhook_perm
        ADD CONSTRAINT discord_bridge_webhook_perm_channel_id_subject_type_subject_key UNIQUE (channel_id, subject_type, subject);
    ALTER TABLE ONLY public.discord_bridge_webhook_perm
        ADD CONSTRAINT discord_bridge_webhook_perm_pkey PRIMARY KEY (id);
    ALTER TABLE ONLY public.event_log
        ADD CONSTRAINT event_log_pkey PRIMARY KEY (seq);
    ALTER TABLE ONLY public.moderation_event
        ADD CONSTRAINT moderation_event_pkey PRIMARY KEY (id);
    CREATE INDEX discord_bridge_ban_subject_idx ON public.discord_bridge_ban USING btree (subject_type, subject) WHERE (revoked_at IS NULL);
    CREATE INDEX discord_bridge_channel_guild_idx ON public.discord_bridge_channel USING btree (guild_id) WHERE (enabled = true);
    CREATE INDEX discord_bridge_chat_role_guild_idx ON public.discord_bridge_chat_role USING btree (guild_id, tier, "position" DESC);
    CREATE INDEX discord_bridge_chat_role_position_idx ON public.discord_bridge_chat_role USING btree ("position" DESC);
    CREATE INDEX discord_bridge_guild_member_display_name_idx ON public.discord_bridge_guild_member USING btree (guild_id, lower(display_name));
    CREATE INDEX discord_bridge_guild_member_username_idx ON public.discord_bridge_guild_member USING btree (guild_id, lower(username));
    CREATE INDEX discord_bridge_guild_role_name_idx ON public.discord_bridge_guild_role USING btree (guild_id, lower(name));
    CREATE INDEX discord_bridge_message_author_idx ON public.discord_bridge_message USING btree (author_key, id DESC) WHERE (deleted_at IS NULL);
    CREATE INDEX discord_bridge_message_channel_idx ON public.discord_bridge_message USING btree (channel_id, id DESC);
    CREATE UNIQUE INDEX discord_bridge_message_client_idx ON public.discord_bridge_message USING btree (author_key, client_id) WHERE (client_id IS NOT NULL);
    CREATE INDEX discord_bridge_message_content_fts_idx ON public.discord_bridge_message USING gin (to_tsvector('english'::regconfig, content)) WHERE (deleted_at IS NULL);
    CREATE UNIQUE INDEX discord_bridge_message_discord_id_idx ON public.discord_bridge_message USING btree (discord_message_id) WHERE (discord_message_id IS NOT NULL);
    CREATE INDEX discord_bridge_post_activity_idx ON public.discord_bridge_post USING btree (channel_id, last_activity_at DESC, id DESC) WHERE (deleted_at IS NULL);
    CREATE UNIQUE INDEX discord_bridge_post_client_idx ON public.discord_bridge_post USING btree (owner_key, client_id) WHERE (client_id IS NOT NULL);
    CREATE INDEX discord_bridge_post_created_idx ON public.discord_bridge_post USING btree (channel_id, created_at DESC, id DESC) WHERE (deleted_at IS NULL);
    CREATE INDEX discord_bridge_reaction_message_idx ON public.discord_bridge_reaction USING btree (message_id, emoji);
    CREATE UNIQUE INDEX discord_bridge_reaction_unique_idx ON public.discord_bridge_reaction USING btree (message_id, emoji, reactor_key);
    CREATE INDEX discord_bridge_timeout_subject_active_idx ON public.discord_bridge_timeout USING btree (channel_id, subject_type, subject) WHERE (revoked_at IS NULL);
    CREATE INDEX event_log_owner_idx ON public.event_log USING btree (owner_key, seq);
    CREATE INDEX moderation_event_created_idx ON public.moderation_event USING btree (id DESC);
    CREATE INDEX moderation_event_guild_idx ON public.moderation_event USING btree (guild_id, id DESC);
    CREATE INDEX moderation_event_subject_idx ON public.moderation_event USING btree (subject, id DESC);
    ALTER TABLE ONLY public.discord_bridge_post
        ADD CONSTRAINT discord_bridge_post_starter_message_id_fkey FOREIGN KEY (starter_message_id) REFERENCES public.discord_bridge_message(id) ON DELETE SET NULL;
    ALTER TABLE ONLY public.discord_bridge_reaction
        ADD CONSTRAINT discord_bridge_reaction_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.discord_bridge_message(id) ON DELETE CASCADE;
  END IF;
END
$holt_baseline$;

-- migration: 002_holt_identity
-- holt's identity directory: every web identity holt has seen, refreshed from its platform's sign-in answer.
-- discord_id and admin are set only for trusted platforms (platforms.ts `trusted`), which vouch for them.
CREATE TABLE IF NOT EXISTS chat_identity (
    key TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    name TEXT NOT NULL,
    avatar TEXT,
    discord_id TEXT,
    admin BOOLEAN NOT NULL DEFAULT FALSE,
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chat_identity_discord_idx ON chat_identity (discord_id) WHERE discord_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS chat_identity_name_idx ON chat_identity (lower(name));
-- Set Status (online / idle / dnd / invisible), per identity.
CREATE TABLE IF NOT EXISTS chat_presence (
    key TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('online', 'idle', 'dnd', 'invisible')),
    updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- The server rail layout (Discord's guildFolders shape), per identity.
CREATE TABLE IF NOT EXISTS chat_guild_folders (
    key TEXT PRIMARY KEY,
    folders JSONB NOT NULL DEFAULT '[]',
    updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- migration: 003_site_subjects_to_ext
-- abulxt accounts are a platform like any other now: their moderation rows name `abulxt:<n>` (subject_type
-- 'ext') instead of abulxt's own 'site'/'user' + numeric id, and any legacy `user:<n>` key becomes `abulxt:<n>`.
UPDATE discord_bridge_ban SET subject_type = 'ext', subject = 'abulxt:' || subject WHERE subject_type = 'user';
UPDATE discord_bridge_timeout SET subject_type = 'ext', subject = 'abulxt:' || subject WHERE subject_type = 'site';
UPDATE discord_bridge_webhook_perm SET subject_type = 'ext', subject = 'abulxt:' || subject WHERE subject_type = 'site';
DELETE FROM discord_bridge_reaction r WHERE r.reactor_key LIKE 'user:%'
  AND EXISTS (SELECT 1 FROM discord_bridge_reaction o WHERE o.message_id = r.message_id AND o.emoji = r.emoji
              AND o.reactor_key = 'abulxt:' || substring(r.reactor_key FROM 6));
UPDATE discord_bridge_reaction SET reactor_key = 'abulxt:' || substring(reactor_key FROM 6) WHERE reactor_key LIKE 'user:%';
UPDATE discord_bridge_message SET author_key = 'abulxt:' || substring(author_key FROM 6)
  WHERE author_key LIKE 'user:%' AND client_id IS NULL;
UPDATE discord_bridge_message m SET author_key = 'abulxt:' || substring(m.author_key FROM 6)
  WHERE m.author_key LIKE 'user:%' AND m.client_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM discord_bridge_message o WHERE o.author_key = 'abulxt:' || substring(m.author_key FROM 6) AND o.client_id = m.client_id);
DELETE FROM discord_bridge_onboarding_state s WHERE s.identity_key LIKE 'user:%'
  AND EXISTS (SELECT 1 FROM discord_bridge_onboarding_state o WHERE o.guild_id = s.guild_id AND o.identity_key = 'abulxt:' || substring(s.identity_key FROM 6));
UPDATE discord_bridge_onboarding_state SET identity_key = 'abulxt:' || substring(identity_key FROM 6) WHERE identity_key LIKE 'user:%';
UPDATE discord_bridge_post SET owner_key = 'abulxt:' || substring(owner_key FROM 6) WHERE owner_key LIKE 'user:%' AND client_id IS NULL;
