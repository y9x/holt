// Discord's "Remove embeds" (SUPPRESS_EMBEDS, flags 1 << 2) for bridged
// messages. Web-originated rows were delivered by the channel webhook, so the
// webhook edits its own message's flags; Discord-originated rows are edited
// by the bot, which Discord only allows with MANAGE_MESSAGES in the channel.
// The route in discord-bridge-api.ts handles who may ask (the author, or
// staff); this module answers whether the bot can, and performs the edit.

import { query } from './db.js'
import { discordFetch, guildMemberRoles } from './discord-roles.js'
import { channelPermissions, guildSnapshot } from './discord-channel-access.js'

export const MESSAGE_FLAG_SUPPRESS_EMBEDS = 1 << 2
const MANAGE_MESSAGES = 1n << 13n
const DISCORD_API = 'https://discord.com/api/v10'

let botIdPromise: Promise<string | null> | null = null
function botUserId(): Promise<string | null> {
  if (!botIdPromise) {
    botIdPromise = discordFetch('/users/@me')
      .then(async (r) => (r.ok ? ((await r.json()) as { id?: string }).id || null : null))
      .catch(() => null)
      .then((id) => {
        if (!id) botIdPromise = null // retry next time
        return id
      })
  }
  return botIdPromise
}

// The bot's role ids per guild, cached 5 min.
const botRoles = new Map<string, { expires: number; roles: string[] | null }>()
async function botRoleIds(botId: string, guildId: string): Promise<string[] | null> {
  const hit = botRoles.get(guildId)
  if (hit && hit.expires > Date.now()) return hit.roles
  const roles = await guildMemberRoles(botId, guildId).catch(() => null)
  botRoles.set(guildId, { expires: Date.now() + 5 * 60_000, roles })
  return roles
}

async function channelGuildId(channelId: string): Promise<string | null> {
  const { rows } = await query<{ guild_id: string }>(
    `SELECT guild_id FROM discord_bridge_channel WHERE channel_id = $1`,
    [channelId],
  )
  return rows[0]?.guild_id || null
}

// Does the bot hold MANAGE_MESSAGES in this channel (Discord's algorithm over
// the live roles + channel overwrites of the channel's own guild)? Unknown →
// false (hide the X).
export async function botCanManageMessages(channelId: string, guildId?: string): Promise<boolean> {
  try {
    const botId = await botUserId()
    if (!botId) return false
    const gid = guildId || (await channelGuildId(channelId))
    if (!gid) return false
    const snap = await guildSnapshot(gid)
    const channel = snap?.byId.get(channelId)
    if (!snap || !channel) return false
    const roleIds = await botRoleIds(botId, gid)
    if (!roleIds) return false
    const perms = channelPermissions(snap, channel, { memberId: botId, roleIds })
    return (perms & MANAGE_MESSAGES) !== 0n
  } catch {
    return false
  }
}

export type SuppressResult = { ok: true } | { ok: false; status: number; error: string }

// Set SUPPRESS_EMBEDS on the Discord copy of a bridged message.
export async function suppressOnDiscord(target: {
  direction: string
  channelId: string
  discordMessageId: string
}): Promise<SuppressResult> {
  const body = JSON.stringify({ flags: MESSAGE_FLAG_SUPPRESS_EMBEDS })
  if (target.direction === 'web') {
    const { rows } = await query<{ webhook_id: string | null; webhook_token: string | null }>(
      `SELECT webhook_id, webhook_token FROM discord_bridge_channel WHERE channel_id = $1`,
      [target.channelId],
    )
    const hook = rows[0]
    if (!hook?.webhook_id || !hook.webhook_token) return { ok: false, status: 409, error: 'This channel has no webhook yet.' }
    // Webhook-token auth (no bot token): PATCH the webhook's own message.
    const response = await fetch(
      `${DISCORD_API}/webhooks/${encodeURIComponent(hook.webhook_id)}/${encodeURIComponent(hook.webhook_token)}/messages/${encodeURIComponent(target.discordMessageId)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body },
    ).catch(() => null)
    if (!response) return { ok: false, status: 502, error: 'Could not reach Discord.' }
    await response.body?.cancel().catch(() => {})
    return response.ok ? { ok: true } : { ok: false, status: 502, error: `Discord refused the edit (HTTP ${response.status}).` }
  }
  if (!(await botCanManageMessages(target.channelId))) {
    return { ok: false, status: 403, error: 'Missing Permissions' }
  }
  const response = await discordFetch(
    `/channels/${encodeURIComponent(target.channelId)}/messages/${encodeURIComponent(target.discordMessageId)}`,
    { method: 'PATCH', body },
    'Embeds removed from the web chat',
  ).catch(() => null)
  if (!response) return { ok: false, status: 502, error: 'Could not reach Discord.' }
  await response.body?.cancel().catch(() => {})
  return response.ok ? { ok: true } : { ok: false, status: 502, error: `Discord refused the edit (HTTP ${response.status}).` }
}
