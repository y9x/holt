import { getConfig } from './config.js'
import { DISCORD_BRIDGE_OWNER_KEY, emit } from './events.js'
import * as bridge from './discord-bridge-db.js'
import {
  chatPermsForIdentity,
  issueTimeout,
  moderationDenial,
  revokeTimeout,
  setWebhookMemberPerm,
  webhookKey,
  webhookKeys,
  type ChatPerms,
  type ModerationAction,
  type WebhookIdentity,
  type WebhookSubject,
} from './discord-chat-perms.js'

// Webhook moderation shared by the web chatbox (POST /api/discord/bridge/
// moderate) and the Discord-side /bridge slash commands, so every surface
// applies the same bits, hierarchy, identity resolution, DB writes, audit log
// entries and realtime events. Targets are WebhookIdentity values (see
// discord-chat-perms.ts): web-only site accounts, linked accounts, and
// Discord users are all first-class.

export interface ModerationActor {
  /** Channel-effective perms (a timed-out/banned actor is rejected upstream). */
  perms: ChatPerms
  subject: WebhookSubject
  /** Display name for the audit log / events. */
  name: string
  /** Stable actor id for issued_by ('user:<id>' or 'discord:<id>'). */
  id: string
}

export type ModerationRequest =
  | { action: 'timeout'; seconds: number; reason: string }
  | { action: 'untimeout' }
  | { action: 'ban'; reason: string }
  | { action: 'unban' }
  | { action: 'webhook-perm'; allow: bigint; deny: bigint }

export type ModerationResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; error: string }

// Discord's timeout ceiling is 28 days; the floor keeps a typo from being a
// no-op. The web modal offers Discord's presets (60s, 5m, 10m, 1h, 1d, 1w).
export const TIMEOUT_MIN_SECONDS = 10
export const TIMEOUT_MAX_SECONDS = 28 * 24 * 3600

export function clampTimeoutSeconds(raw: unknown): number {
  const n = Math.floor(Number(raw) || 0)
  return Math.min(Math.max(n, TIMEOUT_MIN_SECONDS), TIMEOUT_MAX_SECONDS)
}

// The event fields that name the target. `target` is the canonical key
// (site key when there is a site account); `targetKeys` lists every key the
// identity appears under so the rt filter and clients match linked accounts
// on either side.
export function targetEventFields(target: WebhookIdentity): Record<string, unknown> {
  return {
    target: webhookKey(target),
    targetKeys: webhookKeys(target),
    targetUserId: target.userId,
    targetDiscordId: target.discordId,
    targetName: target.name,
  }
}

// The bridge-ban rows that cover one webhook identity: the site account
// ('user' = site user id) and its Discord side ('discord'). A linked account
// is banned/unbanned on both, so the bot also removes its Discord-side posts
// and the ban survives a later link/unlink. Pure (unit-tested).
export function banSubjects(subject: WebhookSubject): Array<{ subjectType: 'user' | 'discord' | 'ext'; subject: string }> {
  const rows: Array<{ subjectType: 'user' | 'discord' | 'ext'; subject: string }> = []
  if (subject.userId !== null) rows.push({ subjectType: 'user', subject: String(subject.userId) })
  if (subject.discordId) rows.push({ subjectType: 'discord', subject: subject.discordId })
  // Another platform's identity (holt): checked like the others, so an ext-only identity is never
  // "not banned" by omission. Writing an 'ext' ban needs the CHECK widened (holt phase 1 step 3).
  if (subject.extKey) rows.push({ subjectType: 'ext', subject: subject.extKey })
  return rows
}

// Active bridge ban for either side of an identity in `guildId` (global bans
// plus that guild's own; no guild = global bans only). IP bans are per
// request, see bridgeBanFor in discord-bridge-api.ts.
export async function webhookBanFor(subject: WebhookSubject, guildId?: string | null): Promise<string | null> {
  for (const row of banSubjects(subject)) {
    const reason = await bridge.isBanned(row.subjectType, row.subject, guildId)
    if (reason) return reason
  }
  return null
}

// Ban scope (contract decision 1): a moderator's ban is scoped to the guild
// of the channel it was issued from; site admins and staff acting in the
// HOME guild issue global bans (guild null), as before multi-guild. The same
// rule decides which bans an unban may lift: global-capable actors lift the
// global rows too, everyone lifts their own guild's rows. Pure.
export function banScopeFor(input: { siteAdmin: boolean; guildId: string; homeGuildId: string }): string | null {
  if (input.siteAdmin || !input.guildId || input.guildId === input.homeGuildId) return null
  return input.guildId
}

async function banWebhook(subject: WebhookSubject, reason: string, createdBy: string, guildId: string | null, issuedInGuildId: string): Promise<void> {
  for (const row of banSubjects(subject)) await bridge.addBan({ ...row, reason, createdBy, guildId, issuedInGuildId })
}

// Which moderation records a /bridge bans|modlog caller sees: the HOME guild
// keeps the full view (null); any other guild sees only rows scoped to
// itself (never global bans or other guilds' events). Pure.
export function moderationViewGuild(guildId: string | null | undefined, homeGuildId: string): string | null {
  if (guildId && homeGuildId && guildId === homeGuildId) return null
  // No guild context (shouldn't happen: /bridge is guild-only) → nothing
  // global leaks either: an impossible guild id matches no rows.
  return guildId || '-'
}

// One /bridge bans line. Outside the home guild IP subjects are redacted. Pure.
export function banListLine(
  ban: { subjectType: string; subject: string; reason: string; createdBy: string; guildId: string | null },
  redactIp: boolean,
): string {
  const subject = redactIp && ban.subjectType === 'ip' ? 'ip:[redacted]' : `${ban.subjectType}:${ban.subject}`
  return `**${subject}**${ban.guildId ? '' : ' (global)'} - ${ban.reason || 'no reason'} (by ${ban.createdBy || 'unknown'})`
}

async function unbanWebhook(subject: WebhookSubject, actor: string, scope: { guildId: string | null; global: boolean }): Promise<number> {
  let lifted = 0
  for (const row of banSubjects(subject)) lifted += await bridge.revokeBan(row.subjectType, row.subject, actor, scope)
  return lifted
}

function homeGuildId(): string {
  try {
    return getConfig().discord?.guildId || ''
  } catch {
    return ''
  }
}

// `guildId` = the guild the action is issued in (the channel's guild; for a
// /bridge slash command run outside a bridged channel, the interaction's
// guild). Target perms (hierarchy) are resolved in that guild.
export async function moderateWebhook(
  actor: ModerationActor,
  target: WebhookIdentity,
  channelId: string,
  request: ModerationRequest,
  guildId: string,
): Promise<ModerationResult> {
  const targetPerms = await chatPermsForIdentity(target, guildId)
  const denied = moderationDenial(request.action as ModerationAction, actor, { perms: targetPerms, subject: target })
  if (denied) return { ok: false, status: 403, error: denied }
  const subjectKey = webhookKey(target)
  const fields = targetEventFields(target)

  if (request.action === 'timeout') {
    const seconds = clampTimeoutSeconds(request.seconds)
    const reason = request.reason.slice(0, 512)
    const until = new Date(Date.now() + seconds * 1000)
    await issueTimeout({
      channelId,
      subject: target,
      subjectName: target.name,
      reason,
      issuedBy: actor.id,
      issuedByName: actor.name,
      until,
    })
    await bridge.logModeration({ actor: actor.name, action: 'timeout', subject: subjectKey, reason, meta: { channelId, seconds, keys: webhookKeys(target) }, guildId }).catch(() => {})
    await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.timeout', { channelId, ...fields, timeoutUntil: until.toISOString(), issuedByName: actor.name, reason })
    return { ok: true, body: { ok: true, timeoutUntil: until.toISOString() } }
  }

  if (request.action === 'untimeout') {
    const lifted = await revokeTimeout(channelId, target)
    await bridge.logModeration({ actor: actor.name, action: 'untimeout', subject: subjectKey, meta: { channelId }, guildId }).catch(() => {})
    await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.untimeout', { channelId, ...fields, issuedByName: actor.name })
    return { ok: true, body: { ok: true, lifted } }
  }

  const banGuildId = banScopeFor({ siteAdmin: Boolean(actor.perms.siteAdmin), guildId, homeGuildId: homeGuildId() })

  if (request.action === 'ban') {
    const reason = request.reason.slice(0, 512)
    await banWebhook(target, reason, actor.name, banGuildId, guildId)
    await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.ban', { channelId, guildId, banGuildId, ...fields, issuedByName: actor.name, reason })
    return { ok: true, body: { ok: true, scope: banGuildId ? 'guild' : 'global' } }
  }

  if (request.action === 'unban') {
    const lifted = await unbanWebhook(target, actor.name, { guildId, global: banGuildId === null })
    if (!lifted) return { ok: false, status: 404, error: 'No active ban found for that webhook.' }
    await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.unban', { channelId, guildId, ...fields, issuedByName: actor.name })
    return { ok: true, body: { ok: true, lifted } }
  }

  // webhook-perm: per-channel member overwrite for the identity.
  await setWebhookMemberPerm({ channelId, subject: target, allow: request.allow, deny: request.deny, createdBy: actor.name })
  await bridge.logModeration({
    actor: actor.name,
    action: 'webhook-perm',
    subject: subjectKey,
    meta: { channelId, allow: request.allow.toString(), deny: request.deny.toString() },
    guildId,
  }).catch(() => {})
  // Targeted perms change: the target's sockets recompute channel visibility
  // and their composer re-fetches perms.
  await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.perms.changed', {
    discordId: target.discordId,
    userId: target.userId,
    keys: webhookKeys(target),
    channelId,
    guildId,
  })
  return { ok: true, body: { ok: true } }
}
