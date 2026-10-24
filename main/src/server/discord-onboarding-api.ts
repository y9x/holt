import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ChatIdentity as Identity } from './chat-caller.ts'
import { DISCORD_BRIDGE_OWNER_KEY, emit } from './events.js'
import { rateLimit, sendRateLimited } from './rate-limit.ts'
import { Perm, bypassesOverwrites, chatPermsForUser, hasPerm, subjectOfUser, webhookKeys, webhookOverwrites } from './discord-chat-perms.js'
import { bridgedGuildIds, listChannels } from './discord-bridge-db.js'
import { parseRequestUrl } from './request-url.ts'
import { chatKeyOfUser } from './chat-identity-key.ts'
import {
  DiscordChannelType,
  RENDERABLE_CHANNEL_TYPES,
  buildSidebar,
  canViewChannel,
  invalidateIdentityVisibility,
  onboardingView,
  viewerFor,
  type ChannelViewer,
  type DiscordGuildChannel,
  type GuildPermissionContext,
  type OnboardingView,
} from './discord-channel-access.js'
import {
  applyChannelOptIn,
  saveOnboardingState,
  sidebarOptInFilter,
  stateOut,
  validateResponses,
  type OnboardingStateOut,
} from './discord-onboarding.js'

// Server Onboarding + Browse Channels endpoints (mounted under
// /api/discord/bridge/ by discord-bridge-api.ts), per bridged guild:
//   GET  onboarding?guild=<id>           config + the caller's state
//   POST onboarding/responses            { guild, optionIds, completed?, rulesAccepted? } -> state
//   POST channel-optin                   { guild, channelId, optedIn } -> state
//   POST channel-optin/show-all          { guild, showAllChannels } -> state
// `guild` is REQUIRED and must be a bridged guild (404 Unknown Guild, code
// 10004, otherwise).
// Guests read (nothing persists, state is the empty default); writes need a
// site account. Every write emits a `bridge.onboarding.updated` event scoped
// to the caller's webhook keys so its sidebar refetches /channels.

const ROUTES = new Set(['onboarding', 'onboarding/responses', 'channel-optin', 'channel-optin/show-all'])

export function isOnboardingRoute(path: string): boolean {
  return ROUTES.has(path)
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}

const MAX_BODY_BYTES = 16 * 1024

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buf = Buffer.from(chunk)
    total += buf.length
    if (total <= MAX_BODY_BYTES) chunks.push(buf)
  }
  if (total > MAX_BODY_BYTES || !chunks.length) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const GUEST_STATE: OnboardingStateOut = {
  responses: [],
  completed: false,
  optedInChannelIds: [],
  optedOutChannelIds: [],
  showAllChannels: true,
  isNew: false,
  rulesAccepted: false,
}

function stateFor(view: OnboardingView): OnboardingStateOut {
  return view.row ? stateOut(view.config, view.row, view.member) : GUEST_STATE
}

// One Browse Channels row is listed only when the caller can VIEW it on
// Discord (same math as the /channels sidebar); a bridged channel must
// additionally pass the bridge gate (chat VIEW bit + webhook view overwrite).
// The bridge gate is an extra restriction, never a substitute: bridged staff
// channels used to skip the Discord check here and leaked (with their
// category) into everyone's Browse Channels list. Pure.
export function browseVisible(
  guild: GuildPermissionContext,
  channel: DiscordGuildChannel,
  viewer: ChannelViewer,
  knownBridged: ReadonlySet<string>,
  bridgeViewable: ReadonlySet<string>,
): boolean {
  if (!canViewChannel(guild, channel, viewer)) return false
  return !knownBridged.has(channel.id) || bridgeViewable.has(channel.id)
}

// Browse Channels: every BRIDGED channel of this guild the caller can VIEW
// (ignoring the opt-in filter; unbridged channels can't be opened in the
// chatbox any more, so they aren't offered), in sidebar order, with whether
// it currently shows in their list (`following`) and whether it can be
// unfollowed (bridged, default and role-gated channels always show).
async function browseList(identity: Identity, view: OnboardingView) {
  const snap = view.snapshot
  const perms = await chatPermsForUser(identity.user, view.guildId)
  const subject = subjectOfUser(identity.user)
  const viewer = await viewerFor(identity.user, perms, view.guildId)
  const bridgedRows = await listChannels(true, view.guildId).catch(() => [])
  const bridged = new Set<string>()
  if (hasPerm(perms.permissions, Perm.VIEW_MESSAGES)) {
    for (const c of bridgedRows) {
      const ok = bypassesOverwrites(perms.tier)
        || (await webhookOverwrites(c.channelId, subject, perms.roleIds || (perms.roleId ? [perms.roleId] : []), perms).catch(() => ({ view: false }))).view
      if (ok) bridged.add(c.channelId)
    }
  }
  const knownBridged = new Set(bridgedRows.map((c) => c.channelId))
  const isBridged = (c: { id: string }) => bridged.has(c.id)
  const layout = buildSidebar(snap.channels, (c) => isBridged(c) && browseVisible(snap, c, viewer, knownBridged, bridged), isBridged)
  const everyone: ChannelViewer = { memberId: null, roleIds: [] }
  const everyoneCanView = (c: Parameters<typeof isBridged>[0]) => canViewChannel(snap, snap.byId.get(c.id)!, everyone)
  const shown = view.row
    ? sidebarOptInFilter(view.config, { ...view.row, showAllChannels: false }, everyoneCanView, isBridged)
    : () => true
  const defaults = new Set(view.config?.defaultChannelIds || [])
  const channels = layout.channels.map((c) => ({
    channelId: c.id,
    name: c.name,
    topic: c.topic || '',
    type: c.type,
    parentId: c.parent_id || null,
    position: c.position,
    bridged: bridged.has(c.id),
    isDefault: defaults.has(c.id),
    following: shown(c),
    removable: !(bridged.has(c.id) || defaults.has(c.id) || !everyoneCanView(c)),
  }))
  return { categories: layout.categories, channels }
}

async function publish(identity: Identity, guildId: string, state: OnboardingStateOut): Promise<void> {
  invalidateIdentityVisibility(identity.ownerKey)
  const targetKeys = webhookKeys(subjectOfUser(identity.user))
  await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.onboarding.updated', { targetKeys, state, guildId }).catch(() => {})
  // Onboarding answers change a web identity's EFFECTIVE roles in that guild,
  // hence its chat perms (role grants/overwrites), hierarchy position and
  // name color: a targeted perms change makes its sockets re-fetch perms +
  // sidebar. (Never with empty keys: that would read as a GLOBAL perms change.)
  if (targetKeys.length) await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.perms.changed', { keys: targetKeys, reason: 'onboarding', guildId }).catch(() => {})
}

// `guild` validated against the bridged guild set.
async function bridgedGuild(raw: unknown): Promise<string | null> {
  if (typeof raw !== 'string' || !/^\d{15,22}$/.test(raw)) return null
  const ids = await bridgedGuildIds().catch(() => [] as string[])
  return ids.includes(raw) ? raw : null
}

export async function handleOnboardingRequest(
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  identity: Identity,
): Promise<void> {
  if (path === 'onboarding' && request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' })
  if (path !== 'onboarding' && request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' })
  // GET: ?guild=<id>; POST: body field `guild`.
  const body = request.method === 'POST' ? await readBody(request) : {}
  const guildId = await bridgedGuild(request.method === 'POST' ? body.guild : parseRequestUrl(request.url).searchParams.get('guild'))
  if (!guildId) return sendJson(response, 404, { error: 'Unknown Guild', code: 10004 })
  const view = await onboardingView(identity.user, guildId).catch(() => null)
  if (!view) return sendJson(response, 503, { error: 'Discord is unavailable. Try again shortly.' })

  if (path === 'onboarding') {
    const config = view.config
    return sendJson(response, 200, {
      enabled: Boolean(config?.enabled),
      mode: config?.mode ?? 0,
      prompts: config?.prompts ?? [],
      defaultChannelIds: config?.defaultChannelIds ?? [],
      rules: config?.rules ?? null,
      welcomeScreen: config?.welcomeScreen ?? null,
      guild: config?.guild ?? null,
      // Roles the options grant (names for the "You will receive…" help text).
      roles: [...new Set((config?.prompts ?? []).flatMap((p) => p.options.flatMap((o) => o.role_ids)))]
        .map((id) => view.snapshot.roles.get(id))
        .filter((r): r is NonNullable<typeof r> => Boolean(r))
        .map((r) => ({ id: r.id, name: r.name, color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : null })),
      state: stateFor(view),
      browse: await browseList(identity, view).catch(() => ({ categories: [], channels: [] })),
    })
  }

  if (identity.isGuest || !identity.user || !view.row) return sendJson(response, 401, { error: 'Sign in to customize this server.' })
  const limit = rateLimit(`bridge:onboarding:${identity.ownerKey}`, { limit: 40, windowMs: 60_000, error: 'Too many requests. Slow down.' })
  if (!limit.ok) {
    return sendRateLimited(response, limit.retryAfterSec, limit.error)
  }
  // A site account's `abulxt:<id>`, or another platform's user's ext key: same state, same emulated roles.
  const key = chatKeyOfUser(identity.user)!
  const config = view.config
  let row = view.row

  if (path === 'onboarding/responses') {
    if (!config || !config.prompts.length) return sendJson(response, 400, { error: 'This server has no onboarding questions.' })
    const completing = body.completed === true
    const checked = validateResponses(config, body.optionIds, completing)
    if (!checked.ok) return sendJson(response, 400, { error: checked.error, code: 50035, promptId: checked.promptId, optionId: checked.optionId })
    if (completing && config.rules && body.rulesAccepted !== true && !row.rulesAcceptedAt) {
      return sendJson(response, 400, { error: 'You must agree to the server rules.', code: 50035, rulesRequired: true })
    }
    const now = new Date().toISOString()
    row = {
      ...row,
      responses: checked.optionIds,
      completedAt: row.completedAt || (completing ? now : null),
      rulesAcceptedAt: row.rulesAcceptedAt || (body.rulesAccepted === true ? now : null),
    }
  } else if (path === 'channel-optin') {
    const channelId = typeof body.channelId === 'string' ? body.channelId : ''
    if (typeof body.optedIn !== 'boolean') return sendJson(response, 400, { error: 'optedIn must be a boolean.' })
    const snap = view.snapshot
    const channel = snap.byId.get(channelId)
    const isCategory = channel?.type === DiscordChannelType.GUILD_CATEGORY
    if (!channel || (!isCategory && !RENDERABLE_CHANNEL_TYPES.has(channel.type))) {
      return sendJson(response, 404, { error: 'Unknown Channel', code: 10003 })
    }
    // Only channels the caller can VIEW (a category: any viewable channel in
    // it) can be followed - same rule as the sidebar.
    const viewer = await viewerFor(identity.user, await chatPermsForUser(identity.user, view.guildId), view.guildId)
    const children = isCategory ? snap.channels.filter((c) => c.parent_id === channel.id && RENDERABLE_CHANNEL_TYPES.has(c.type)) : []
    const viewable = isCategory ? children.some((c) => canViewChannel(snap, c, viewer)) : canViewChannel(snap, channel, viewer)
    if (!viewable) return sendJson(response, 403, { error: 'Missing Access', code: 50001 })
    row = applyChannelOptIn(config || { guildId: view.guildId, enabled: false, mode: 0, defaultChannelIds: [], prompts: [], rules: null, welcomeScreen: null, guild: null }, row, channel, body.optedIn, children.map((c) => c.id))
  } else if (path === 'channel-optin/show-all') {
    if (typeof body.showAllChannels !== 'boolean') return sendJson(response, 400, { error: 'showAllChannels must be a boolean.' })
    row = { ...row, showAllChannels: body.showAllChannels }
  } else {
    return sendJson(response, 404, { error: 'Not found' })
  }

  await saveOnboardingState(view.guildId, key, row)
  const state = stateOut(config, row, view.member)
  await publish(identity, view.guildId, state)
  return sendJson(response, 200, state)
}
