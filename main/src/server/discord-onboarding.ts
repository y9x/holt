import { query } from './db.js'
import { discordFetch } from './discord-roles.js'
import type { DiscordGuildChannel, DiscordGuildRole } from './discord-channel-access.js'

// Discord Server Onboarding, emulated for the web chatbox.
//
// Discord's onboarding (https://discord.com/developers/docs/resources/guild#guild-onboarding-object)
// asks new members questions whose answers grant roles and opt them into
// channels; with onboarding enabled, a member's channel list only shows what
// they opted into ("opt-in channels"). Web webhooks aren't guild members, so
// the bridge emulates it locally:
//
// - The guild's onboarding config (+ member-verification rules and welcome
//   screen) is read with the bot token and cached ~5 min (stale copy served
//   for 24h through Discord outages).
// - Per-identity state (selected option ids, completion, manual channel
//   opt-ins/outs, "Show All Channels") lives in discord_bridge_onboarding_state
//   keyed by the webhook's author key ('user:<siteId>').
// - Selected options' role_ids are added to a WEB-ONLY identity's effective
//   roles for Discord's permission algorithm (never assigned on Discord); a
//   linked guild member keeps their real roles and only gets local opt-ins.
// - Sidebar visibility follows Discord's opt-in model (sidebarOptInFilter).
//
// Nothing in this module writes to Discord.

// --- Config -------------------------------------------------------------------

export interface OnboardingEmoji {
  id: string | null
  name: string | null
  animated: boolean
  // CDN url for a custom emoji; null for a unicode emoji (render via Twemoji).
  url: string | null
}

// Field names mirror Discord's onboarding object (snake_case) so the client
// can treat them exactly like Discord's own payload.
export interface OnboardingOption {
  id: string
  title: string
  description: string
  emoji: OnboardingEmoji | null
  role_ids: string[]
  channel_ids: string[]
}

export interface OnboardingPrompt {
  id: string
  type: number // 0 MULTIPLE_CHOICE, 1 DROPDOWN
  title: string
  single_select: boolean
  required: boolean
  in_onboarding: boolean
  options: OnboardingOption[]
}

export interface OnboardingRules {
  description: string | null
  // Member-verification TERMS field values (the numbered server rules).
  terms: string[]
  rulesChannelId: string | null
  version: string | null
}

export interface OnboardingWelcomeScreen {
  description: string | null
  channels: Array<{ channelId: string; description: string; emoji: OnboardingEmoji | null }>
}

export interface OnboardingGuild {
  id: string
  name: string
  icon: string | null
  splash: string | null
  banner: string | null
  description: string | null
  features: string[]
}

export interface OnboardingConfig {
  guildId: string
  enabled: boolean
  mode: number // 0 ONBOARDING_DEFAULT, 1 ONBOARDING_ADVANCED
  defaultChannelIds: string[]
  prompts: OnboardingPrompt[]
  rules: OnboardingRules | null
  welcomeScreen: OnboardingWelcomeScreen | null
  guild: OnboardingGuild | null
}

interface RawEmoji { id?: string | null; name?: string | null; animated?: boolean }
interface RawOption {
  id: string
  title?: string
  description?: string | null
  emoji?: RawEmoji | null
  emoji_id?: string | null
  emoji_name?: string | null
  emoji_animated?: boolean
  role_ids?: string[]
  channel_ids?: string[]
}
interface RawPrompt {
  id: string
  type?: number
  title?: string
  single_select?: boolean
  required?: boolean
  in_onboarding?: boolean
  options?: RawOption[]
}
export interface RawOnboarding {
  enabled?: boolean
  mode?: number
  default_channel_ids?: string[]
  prompts?: RawPrompt[]
}
export interface RawGuild {
  id: string
  name?: string
  icon?: string | null
  splash?: string | null
  banner?: string | null
  description?: string | null
  features?: string[]
  rules_channel_id?: string | null
  emojis?: Array<{ id: string | null; name?: string | null; animated?: boolean }>
}
export interface RawVerification {
  description?: string | null
  version?: string | null
  form_fields?: Array<{ field_type?: string; values?: string[] | null; required?: boolean }>
}
export interface RawWelcomeScreen {
  description?: string | null
  welcome_channels?: Array<{ channel_id: string; description?: string; emoji_id?: string | null; emoji_name?: string | null }>
}

export interface RawOnboardingBundle {
  onboarding: RawOnboarding | null
  guild: RawGuild | null
  verification: RawVerification | null
  welcomeScreen: RawWelcomeScreen | null
}

// Real Discord permission bits an EMULATED role must not carry: these would
// make the web identity staff for Discord's permission algorithm (Administrator
// = every channel). Roles holding any of them are never emulated.
const ELEVATED_BITS = (1n << 3n) /* ADMINISTRATOR */
  | (1n << 1n) /* KICK_MEMBERS */
  | (1n << 2n) /* BAN_MEMBERS */
  | (1n << 4n) /* MANAGE_CHANNELS */
  | (1n << 5n) /* MANAGE_GUILD */
  | (1n << 13n) /* MANAGE_MESSAGES */
  | (1n << 28n) /* MANAGE_ROLES */
  | (1n << 29n) /* MANAGE_WEBHOOKS */
  | (1n << 40n) /* MODERATE_MEMBERS */

function bits(value: string | number | undefined | null): bigint {
  try {
    return BigInt(value ?? 0)
  } catch {
    return 0n
  }
}

const SNOWFLAKE = /^\d{5,25}$/

function emojiFrom(
  raw: { emoji?: RawEmoji | null; emoji_id?: string | null; emoji_name?: string | null; emoji_animated?: boolean },
  guildEmojis: Map<string, { animated: boolean; name: string | null }> | null,
): OnboardingEmoji | null {
  const id = raw.emoji?.id ?? raw.emoji_id ?? null
  const name = raw.emoji?.name ?? raw.emoji_name ?? null
  if (id && SNOWFLAKE.test(id)) {
    // A custom emoji that no longer exists in the guild renders as nothing
    // (Discord drops deleted emojis the same way). Unknown emoji list = keep.
    const known = guildEmojis ? guildEmojis.get(id) : undefined
    if (guildEmojis && !known) return null
    const animated = Boolean(raw.emoji?.animated ?? raw.emoji_animated ?? known?.animated)
    return {
      id,
      name: name || known?.name || null,
      animated,
      url: `https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'webp'}?size=48&quality=lossless`,
    }
  }
  if (name) return { id: null, name, animated: false, url: null }
  return null
}

function cdn(kind: 'icons' | 'splashes' | 'banners', guildId: string, hash: string | null | undefined, size: number): string | null {
  if (!hash) return null
  const ext = hash.startsWith('a_') && kind !== 'splashes' ? 'gif' : 'webp'
  return `https://cdn.discordapp.com/${kind}/${guildId}/${hash}.${ext}?size=${size}`
}

// Normalize the raw Discord payloads against the live guild (pure): option
// role_ids keep only roles that exist (not @everyone), channel_ids/default
// channels keep only channels (incl. categories) that exist, custom emojis
// resolve to CDN urls, prompts left without options are dropped.
export function normalizeOnboarding(
  guildId: string,
  raw: RawOnboardingBundle,
  live: { roles: Map<string, DiscordGuildRole>; channels: Map<string, DiscordGuildChannel> } | null,
): OnboardingConfig {
  const g = raw.guild
  const guildEmojis = Array.isArray(g?.emojis)
    ? new Map(g!.emojis!.filter((e) => e.id).map((e) => [String(e.id), { animated: Boolean(e.animated), name: e.name || null }]))
    : null
  const roleOk = (id: string) => SNOWFLAKE.test(id) && id !== guildId && (!live || live.roles.has(id))
  const channelOk = (id: string) => SNOWFLAKE.test(id) && (!live || live.channels.has(id))
  const ob = raw.onboarding
  const prompts: OnboardingPrompt[] = []
  for (const p of Array.isArray(ob?.prompts) ? ob!.prompts! : []) {
    if (!p || typeof p.id !== 'string') continue
    const options: OnboardingOption[] = []
    for (const o of Array.isArray(p.options) ? p.options : []) {
      if (!o || typeof o.id !== 'string') continue
      options.push({
        id: o.id,
        title: String(o.title || ''),
        description: String(o.description || ''),
        emoji: emojiFrom(o, guildEmojis),
        role_ids: [...new Set((o.role_ids || []).map(String))].filter(roleOk),
        channel_ids: [...new Set((o.channel_ids || []).map(String))].filter(channelOk),
      })
    }
    if (!options.length) continue
    prompts.push({
      id: p.id,
      type: p.type === 1 ? 1 : 0,
      title: String(p.title || ''),
      single_select: Boolean(p.single_select),
      required: Boolean(p.required),
      in_onboarding: p.in_onboarding !== false,
      options,
    })
  }
  const features = Array.isArray(g?.features) ? g!.features!.filter((f): f is string => typeof f === 'string') : []
  const terms = (raw.verification?.form_fields || [])
    .filter((f) => f && f.field_type === 'TERMS')
    .flatMap((f) => (Array.isArray(f.values) ? f.values : []))
    .map((v) => String(v))
    .filter(Boolean)
  const rules: OnboardingRules | null = terms.length
    ? {
      description: raw.verification?.description || null,
      terms,
      rulesChannelId: g?.rules_channel_id || null,
      version: raw.verification?.version ? String(raw.verification.version) : null,
    }
    : null
  const ws = raw.welcomeScreen
  const welcomeScreen: OnboardingWelcomeScreen | null = ws
    ? {
      description: ws.description || null,
      channels: (ws.welcome_channels || [])
        .filter((c) => c && channelOk(String(c.channel_id)))
        .map((c) => ({ channelId: String(c.channel_id), description: String(c.description || ''), emoji: emojiFrom(c, guildEmojis) })),
    }
    : null
  return {
    guildId,
    enabled: Boolean(ob?.enabled) && prompts.length + (ob?.default_channel_ids?.length || 0) > 0,
    mode: typeof ob?.mode === 'number' ? ob.mode : 0,
    defaultChannelIds: [...new Set((ob?.default_channel_ids || []).map(String))].filter(channelOk),
    prompts,
    rules,
    welcomeScreen,
    guild: g
      ? {
        id: g.id,
        name: String(g.name || ''),
        icon: cdn('icons', g.id, g.icon, 256),
        splash: cdn('splashes', g.id, g.splash, 2048),
        banner: cdn('banners', g.id, g.banner, 960),
        description: g.description || null,
        features,
      }
      : null,
  }
}

const CONFIG_TTL_MS = 5 * 60_000
const CONFIG_STALE_MS = 24 * 60 * 60_000
const CONFIG_FAIL_BACKOFF_MS = 30_000
// Per guild (every bridged guild has its own onboarding).
const rawCache = new Map<string, { fetchedAt: number; value: RawOnboardingBundle }>()
const rawInflight = new Map<string, Promise<RawOnboardingBundle | null>>()
const rawFailedAt = new Map<string, number>()

async function getJson<T>(path: string): Promise<T | null> {
  const res = await discordFetch(path).catch(() => null)
  if (!res || !res.ok) return null
  return (await res.json().catch(() => null)) as T | null
}

async function fetchRaw(guildId: string): Promise<RawOnboardingBundle | null> {
  const [onboarding, guild] = await Promise.all([
    getJson<RawOnboarding>(`/guilds/${guildId}/onboarding`),
    getJson<RawGuild>(`/guilds/${guildId}`),
  ])
  if (!onboarding && !guild) return null
  const features = new Set(guild?.features || [])
  // Member verification (Rules Screening) isn't a documented bot endpoint;
  // the client's GET /guilds/{id}/member-verification is tried best-effort
  // when the gate is enabled and silently skipped if bots are refused.
  // Welcome screen: readable by bots when enabled (else needs MANAGE_GUILD).
  const [verification, welcomeScreen] = await Promise.all([
    features.has('MEMBER_VERIFICATION_GATE_ENABLED')
      ? getJson<RawVerification>(`/guilds/${guildId}/member-verification?with_guild=false`)
      : Promise.resolve(null),
    features.has('WELCOME_SCREEN_ENABLED') ? getJson<RawWelcomeScreen>(`/guilds/${guildId}/welcome-screen`) : Promise.resolve(null),
  ])
  return { onboarding, guild, verification, welcomeScreen }
}

// Raw onboarding bundle, cached ~5 min (deduped across concurrent callers); a
// failed refresh serves the last good copy for 24h and backs off 30s.
export async function onboardingBundle(guildId: string): Promise<RawOnboardingBundle | null> {
  if (!guildId) return null
  const now = Date.now()
  const current = rawCache.get(guildId) || null
  if (current && now - current.fetchedAt < CONFIG_TTL_MS) return current.value
  const stale = current && now - current.fetchedAt < CONFIG_STALE_MS ? current.value : null
  if (now - (rawFailedAt.get(guildId) || 0) < CONFIG_FAIL_BACKOFF_MS) return stale
  let inflight = rawInflight.get(guildId)
  if (!inflight) {
    inflight = fetchRaw(guildId)
      .catch(() => null)
      .then((value) => {
        if (value) rawCache.set(guildId, { fetchedAt: Date.now(), value })
        else rawFailedAt.set(guildId, Date.now())
        return value
      })
      .finally(() => { rawInflight.delete(guildId) })
    rawInflight.set(guildId, inflight)
  }
  return (await inflight) || stale
}

// Normalized config, memoized per guild per (raw bundle, live snapshot) pair.
const normalizedMemo = new Map<string, { raw: RawOnboardingBundle; live: object | null; value: OnboardingConfig }>()
export async function onboardingConfig(
  guildId: string,
  live: { roles: Map<string, DiscordGuildRole>; channels: Map<string, DiscordGuildChannel> } | null,
): Promise<OnboardingConfig | null> {
  const raw = await onboardingBundle(guildId)
  if (!raw) return null
  const liveKey = live ? live.roles : null
  const memo = normalizedMemo.get(guildId)
  if (memo && memo.raw === raw && memo.live === liveKey) return memo.value
  const value = normalizeOnboarding(guildId, raw, live)
  normalizedMemo.set(guildId, { raw, live: liveKey, value })
  return value
}

// No guild = every guild.
export function invalidateOnboardingConfig(guildId?: string | null): void {
  for (const [id, entry] of rawCache) {
    if (!guildId || id === guildId) rawCache.set(id, { ...entry, fetchedAt: 0 })
  }
  if (guildId) rawFailedAt.delete(guildId)
  else rawFailedAt.clear()
}

// --- Per-identity state ---------------------------------------------------------

export interface OnboardingStateRow {
  responses: string[]
  optedInChannelIds: string[]
  optedOutChannelIds: string[]
  showAllChannels: boolean
  newMember: boolean
  completedAt: string | null
  rulesAcceptedAt: string | null
}

export interface OnboardingStateOut {
  responses: string[]
  completed: boolean
  optedInChannelIds: string[]
  // Channels granted by a selected option (or an opted-in category) that the
  // identity explicitly unfollowed in Browse Channels.
  optedOutChannelIds: string[]
  showAllChannels: boolean
  // Show the onboarding flow: onboarding enabled, a NEW web identity (no chat
  // history when its state was first created, not a guild member) that
  // hasn't completed it.
  isNew: boolean
  rulesAccepted: boolean
}

const stateCache = new Map<string, { expires: number; row: OnboardingStateRow | null }>()
const STATE_TTL_MS = 30_000

type StateDbRow = {
  responses: string[]
  opted_in_channel_ids: string[]
  opted_out_channel_ids: string[]
  show_all_channels: boolean
  new_member: boolean
  completed_at: Date | string | null
  rules_accepted_at: Date | string | null
}

function iso(value: Date | string | null): string | null {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

export async function loadOnboardingState(guildId: string, identityKey: string): Promise<OnboardingStateRow | null> {
  const cacheKey = `${guildId}|${identityKey}`
  const hit = stateCache.get(cacheKey)
  if (hit && hit.expires > Date.now()) return hit.row
  const { rows } = await query<StateDbRow>(
    `SELECT responses, opted_in_channel_ids, opted_out_channel_ids, show_all_channels, new_member, completed_at, rules_accepted_at
       FROM discord_bridge_onboarding_state WHERE guild_id = $1 AND identity_key = $2`,
    [guildId, identityKey],
  )
  const r = rows[0]
  const row: OnboardingStateRow | null = r
    ? {
      responses: r.responses || [],
      optedInChannelIds: r.opted_in_channel_ids || [],
      optedOutChannelIds: r.opted_out_channel_ids || [],
      showAllChannels: r.show_all_channels,
      newMember: r.new_member,
      completedAt: iso(r.completed_at),
      rulesAcceptedAt: iso(r.rules_accepted_at),
    }
    : null
  stateCache.set(cacheKey, { expires: Date.now() + STATE_TTL_MS, row })
  if (stateCache.size > 5000) stateCache.delete(stateCache.keys().next().value as string)
  return row
}

export function invalidateOnboardingState(guildId: string, identityKey: string): void {
  stateCache.delete(`${guildId}|${identityKey}`)
}

// Has this web identity ever chatted in this guild's bridged channels?
// Existing chatters are treated like existing guild members when onboarding
// is switched on: no forced flow, full channel list (Discord doesn't
// re-onboard members who joined before). Chatting in another guild doesn't
// count, so a new guild still onboards them.
export async function hasChatHistory(identityKey: string, guildId: string): Promise<boolean> {
  const { rows } = await query<{ one: number }>(
    `SELECT 1 AS one FROM discord_bridge_message m
     JOIN discord_bridge_channel c ON c.channel_id = m.channel_id
     WHERE m.author_key = $1 AND c.guild_id = $2 LIMIT 1`,
    [identityKey, guildId],
  ).catch(() => ({ rows: [] as Array<{ one: number }> }))
  return rows.length > 0
}

// The state a row-less identity starts from. `established` = a linked guild
// member or an identity with chat history.
export function defaultStateRow(established: boolean): OnboardingStateRow {
  return {
    responses: [],
    optedInChannelIds: [],
    optedOutChannelIds: [],
    showAllChannels: established,
    newMember: !established,
    completedAt: null,
    rulesAcceptedAt: null,
  }
}

// The option ids that still exist in the current config (stale answers to
// deleted options are ignored, as Discord does).
export function liveResponses(config: OnboardingConfig | null, responses: string[]): string[] {
  if (!config) return []
  const known = new Set(config.prompts.flatMap((p) => p.options.map((o) => o.id)))
  return responses.filter((id) => known.has(id))
}

export function stateOut(config: OnboardingConfig | null, row: OnboardingStateRow, member: boolean): OnboardingStateOut {
  const enabled = Boolean(config?.enabled)
  return {
    responses: liveResponses(config, row.responses),
    completed: Boolean(row.completedAt),
    optedInChannelIds: row.optedInChannelIds,
    optedOutChannelIds: row.optedOutChannelIds,
    showAllChannels: row.showAllChannels,
    isNew: enabled && !member && row.newMember && !row.completedAt,
    rulesAccepted: Boolean(row.rulesAcceptedAt),
  }
}

export async function saveOnboardingState(guildId: string, identityKey: string, row: OnboardingStateRow): Promise<void> {
  await query(
    `INSERT INTO discord_bridge_onboarding_state
       (guild_id, identity_key, responses, opted_in_channel_ids, opted_out_channel_ids, show_all_channels, new_member, completed_at, rules_accepted_at, updated_at)
     VALUES ($1, $2, $3::text[], $4::text[], $5::text[], $6, $7, $8, $9, NOW())
     ON CONFLICT (guild_id, identity_key) DO UPDATE SET
       responses = EXCLUDED.responses,
       opted_in_channel_ids = EXCLUDED.opted_in_channel_ids,
       opted_out_channel_ids = EXCLUDED.opted_out_channel_ids,
       show_all_channels = EXCLUDED.show_all_channels,
       completed_at = EXCLUDED.completed_at,
       rules_accepted_at = EXCLUDED.rules_accepted_at,
       updated_at = NOW()`,
    [guildId, identityKey, row.responses, row.optedInChannelIds, row.optedOutChannelIds, row.showAllChannels, row.newMember, row.completedAt, row.rulesAcceptedAt],
  )
  invalidateOnboardingState(guildId, identityKey)
}

// --- Validation (pure) ------------------------------------------------------------

export type ResponsesValidation =
  | { ok: true; optionIds: string[] }
  | { ok: false; error: string; promptId?: string; optionId?: string }

// Validate a full replacement set of selected option ids against the config:
// every id must be a current option, a single_select prompt takes at most one
// answer, and (when completing) every required in-onboarding prompt needs one.
export function validateResponses(config: OnboardingConfig, optionIds: unknown, completing: boolean): ResponsesValidation {
  if (!Array.isArray(optionIds) || optionIds.some((id) => typeof id !== 'string')) return { ok: false, error: 'optionIds must be an array of strings.' }
  const ids = [...new Set(optionIds as string[])]
  const promptOf = new Map<string, OnboardingPrompt>()
  for (const p of config.prompts) for (const o of p.options) promptOf.set(o.id, p)
  const perPrompt = new Map<string, number>()
  for (const id of ids) {
    const prompt = promptOf.get(id)
    if (!prompt) return { ok: false, error: 'Unknown onboarding option.', optionId: id }
    perPrompt.set(prompt.id, (perPrompt.get(prompt.id) || 0) + 1)
  }
  for (const p of config.prompts) {
    const n = perPrompt.get(p.id) || 0
    if (p.single_select && n > 1) return { ok: false, error: 'This question only allows one answer.', promptId: p.id }
    if (completing && p.required && p.in_onboarding && n === 0) return { ok: false, error: 'This is a required question.', promptId: p.id }
  }
  return { ok: true, optionIds: ids }
}

// --- Effects (pure) ---------------------------------------------------------------

function selectedOptions(config: OnboardingConfig, responses: string[]): OnboardingOption[] {
  const selected = new Set(responses)
  return config.prompts.flatMap((p) => p.options.filter((o) => selected.has(o.id)))
}

// Roles a web-only identity is emulated to hold from its onboarding answers:
// the selected options' role_ids that exist, aren't @everyone, aren't
// integration-managed, and carry no elevated permission bits.
export function emulatedRoleIds(
  config: OnboardingConfig | null,
  responses: string[],
  roles: Map<string, DiscordGuildRole & { managed?: boolean }>,
): string[] {
  if (!config) return []
  const out = new Set<string>()
  for (const option of selectedOptions(config, responses)) {
    for (const id of option.role_ids) {
      const role = roles.get(id)
      if (!role || id === config.guildId || role.managed) continue
      if (bits(role.permissions) & ELEVATED_BITS) continue
      out.add(id)
    }
  }
  return [...out]
}

// Channel (or category) ids the identity has opted into: the guild's default
// channels, the channel_ids of selected options, and manual Browse Channels
// opt-ins. Pure.
export function optedInSet(config: OnboardingConfig, state: Pick<OnboardingStateRow, 'responses' | 'optedInChannelIds'>): Set<string> {
  const out = new Set<string>(config.defaultChannelIds)
  for (const option of selectedOptions(config, state.responses)) for (const id of option.channel_ids) out.add(id)
  for (const id of state.optedInChannelIds) out.add(id)
  return out
}

// Discord's opt-in sidebar rule, as a predicate over channels the caller can
// already VIEW (compose with the permission check). With onboarding disabled
// (or no config) or "Show All Channels" on, everything viewable shows.
// Otherwise a channel shows when it is:
//   - bridged (the chatbox must always reach bridged channels),
//   - a default channel (never removable),
//   - not viewable by @everyone (a role-gated/private channel - opt-in only
//     applies to public channels, so channels granted through roles, incl.
//     onboarding-emulated roles, always show),
//   - opted into directly or through its category (defaults, selected
//     options' channel_ids, manual opt-ins) and not explicitly opted out.
export function sidebarOptInFilter(
  config: OnboardingConfig | null,
  state: Pick<OnboardingStateRow, 'responses' | 'optedInChannelIds' | 'optedOutChannelIds' | 'showAllChannels'> | null,
  everyoneCanView: (channel: DiscordGuildChannel) => boolean,
  isBridged: (channel: DiscordGuildChannel) => boolean,
): (channel: DiscordGuildChannel) => boolean {
  if (!config || !config.enabled || !state || state.showAllChannels) return () => true
  const optedIn = optedInSet(config, state)
  const optedOut = new Set(state.optedOutChannelIds)
  const defaults = new Set(config.defaultChannelIds)
  const manualIn = new Set(state.optedInChannelIds)
  return (channel) => {
    if (isBridged(channel)) return true
    if (defaults.has(channel.id)) return true
    if (!everyoneCanView(channel)) return true
    if (optedOut.has(channel.id)) return false
    // An unfollowed category hides its channels, even ones an onboarding
    // answer granted, unless the channel itself was followed afterwards.
    if (channel.parent_id && optedOut.has(channel.parent_id) && !manualIn.has(channel.id)) return false
    if (optedIn.has(channel.id)) return true
    return Boolean(channel.parent_id && optedIn.has(channel.parent_id))
  }
}

// Apply one Browse Channels toggle to a state row (pure). Following a channel
// adds it to the opt-ins and clears an explicit opt-out; unfollowing removes
// the manual opt-in and, when the channel is still granted by an option or its
// category, records an explicit opt-out. Default channels can't be unfollowed.
// Toggling a category applies to the category id itself (its channels follow
// it) and clears per-channel overrides beneath it.
export function applyChannelOptIn(
  config: OnboardingConfig,
  row: OnboardingStateRow,
  channel: Pick<DiscordGuildChannel, 'id' | 'type' | 'parent_id'>,
  optedIn: boolean,
  childIds: string[] = [],
): OnboardingStateRow {
  const inSet = new Set(row.optedInChannelIds)
  const outSet = new Set(row.optedOutChannelIds)
  const isCategory = channel.type === 4
  if (optedIn) {
    inSet.add(channel.id)
    outSet.delete(channel.id)
    if (isCategory) for (const id of childIds) outSet.delete(id)
  } else {
    if (config.defaultChannelIds.includes(channel.id)) return row
    inSet.delete(channel.id)
    if (isCategory) {
      for (const id of childIds) inSet.delete(id)
    }
    const stillGranted = optedInSet(config, { responses: row.responses, optedInChannelIds: [...inSet] })
    if (stillGranted.has(channel.id) || (channel.parent_id && stillGranted.has(channel.parent_id))) outSet.add(channel.id)
  }
  return { ...row, optedInChannelIds: [...inSet], optedOutChannelIds: [...outSet] }
}
