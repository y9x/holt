import {
  EmbedBuilder,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js'
import type { ChatInputCommandInteraction } from 'discord.js'
import * as bridge from '../discord-bridge-db.js'
import {
  Perm,
  activeTimeout,
  applyTimeout,
  chatPermsForIdentity,
  hasPerm,
  parseWebhookTarget,
  resolveWebhookTarget,
  webhookKeys,
  type WebhookIdentity,
} from '../discord-chat-perms.js'
import { identitiesByName } from '../identity-directory.ts'
import { banListLine, banScopeFor, moderateWebhook, moderationViewGuild, webhookBanFor, type ModerationRequest } from '../discord-chat-moderation.js'
import { getConfig } from '../config.js'
import type { Command } from './types.js'

// Staff controls for the site chatbox bridge: time out / ban webhooks, list
// active bans, and page the moderation audit log. Guarded by ManageMessages so
// only staff see it. Timeout/untimeout/ban/unban target WEBHOOK identities -
// web-only site accounts, linked accounts, and Discord users alike - and run
// through the same moderateWebhook() as the web chatbox (chat bits + Discord
// role hierarchy + not-self, actor not timed out/banned). Targets accept a
// guild member mention/id, `user:<siteId>`, `discord:<id>`, a site username,
// or a bridged message (`msg:<bridgeId>`, a Discord message link, or a web
// chat link) to act on its author. IP subjects (`ip:<addr>`) are ban-only.

// Discord's timeout presets (the Timeout modal's duration pills).
const TIMEOUT_CHOICES = [
  { name: '60 seconds', value: 60 },
  { name: '5 minutes', value: 5 * 60 },
  { name: '10 minutes', value: 10 * 60 },
  { name: '1 hour', value: 3600 },
  { name: '1 day', value: 86400 },
  { name: '1 week', value: 7 * 86400 },
]

// Resolve a target option into a webhook identity.
async function resolveTargetOption(raw: string): Promise<WebhookIdentity | null> {
  const value = raw.trim().replace(/^<@!?(\d+)>$/, '$1')
  const direct = parseWebhookTarget(value)
  if (direct) return resolveWebhookTarget(direct)
  // A bridged message → its author.
  let message: bridge.BridgeMessage | null = null
  const bridgeId = /^msg:(\d{1,18})$/.exec(value) || /[?&]message=(\d{1,18})\b/.exec(value)
  const discordLink = /discord(?:app)?\.com\/channels\/\d+\/\d+\/(\d{15,22})/.exec(value)
  if (discordLink) message = await bridge.byDiscordMessageId(discordLink[1]).catch(() => null)
  else if (bridgeId) message = await bridge.messageFor(Number(bridgeId[1])).catch(() => null)
  if (message) {
    const author = parseWebhookTarget(message.authorKey)
    return author ? resolveWebhookTarget(author) : null
  }
  // A bare abulxt account id (the home site's), or a web identity's name.
  if (/^\d{1,10}$/.test(value)) return resolveWebhookTarget({ kind: 'ext', key: `abulxt:${value}` })
  const [byName] = await identitiesByName(value, 1).catch(() => [])
  return byName ? resolveWebhookTarget({ kind: 'ext', key: byName.key }) : null
}

// The guild a command acts in: the bridged channel's guild when the channel
// is bridged, else the guild the command was run in. (/bridge is registered
// in every bridged guild, so a moderator's perms resolve in that guild.)
async function commandGuildId(interaction: ChatInputCommandInteraction, channelId: string): Promise<string> {
  // A forum post resolves to its forum's row.
  const channel = (await bridge.scopeFor(channelId).catch(() => null))?.channel ?? null
  return channel?.guildId || interaction.guildId || ''
}

function homeGuildId(): string {
  try {
    return getConfig().discord?.guildId || ''
  } catch {
    return ''
  }
}

// The invoker's chat bits in this command's guild (Discord ManageMessages
// only hides the command; the chat bits are the real gate), with their
// identity. null bits = no identity / no guild.
async function actorChatBits(interaction: ChatInputCommandInteraction, guildId: string): Promise<{ identity: WebhookIdentity | null; bits: bigint }> {
  const identity = await resolveWebhookTarget({ kind: 'discord', discordId: interaction.user.id }).catch(() => null)
  if (!identity || !guildId) return { identity, bits: 0n }
  const perms = await chatPermsForIdentity(identity, guildId).catch(() => null)
  return { identity, bits: perms ? perms.permissions : 0n }
}

const canBan = (bits: bigint) => hasPerm(bits, Perm.BAN_WEBHOOKS) || hasPerm(bits, Perm.MANAGE_WEBHOOKS)

// Run one identity moderation action as the invoking Discord member.
async function moderateAs(
  interaction: ChatInputCommandInteraction,
  targetRaw: string,
  rawChannelId: string,
  request: ModerationRequest,
): Promise<string> {
  // Run inside a forum post: timeouts act on the forum (threads inherit them).
  const channelId = (await bridge.scopeFor(rawChannelId).catch(() => null))?.channel.channelId || rawChannelId
  const target = await resolveTargetOption(targetRaw)
  if (!target) return 'Unknown webhook. Use a member, user:<siteId>, discord:<id>, a site username, or a bridged message link.'
  const actorIdentity = await resolveWebhookTarget({ kind: 'discord', discordId: interaction.user.id })
  if (!actorIdentity) return 'Could not resolve your chat identity.'
  const guildId = await commandGuildId(interaction, channelId)
  if (!guildId) return 'Run this command in a server.'
  // The actor gate the web applies: not banned, not timed out here.
  if (await webhookBanFor(actorIdentity, guildId)) return 'You are banned from the site chatbox.'
  const actorTimeout = await activeTimeout(channelId, actorIdentity).catch(() => null)
  if (actorTimeout) return 'You are timed out in this channel.'
  const perms = applyTimeout(await chatPermsForIdentity(actorIdentity, guildId), actorTimeout)
  const result = await moderateWebhook(
    { perms, subject: actorIdentity, name: interaction.user.globalName || interaction.user.username, id: `discord:${interaction.user.id}` },
    target,
    channelId,
    request,
    guildId,
  )
  if (!result.ok) return result.error
  const who = `**${target.name}** (${webhookKeys(target).join(' / ')})`
  switch (request.action) {
    case 'timeout': return `Timed out ${who} in <#${channelId}> until <t:${Math.floor(new Date(String(result.body.timeoutUntil)).getTime() / 1000)}:R>.`
    case 'untimeout': return `Removed the timeout for ${who} in <#${channelId}>.`
    case 'ban': return `Banned ${who} from the site chatbox${result.body.scope === 'guild' ? ' in this server' : ''}.`
    case 'unban': return `Unbanned ${who}.`
    default: return 'Done.'
  }
}

async function bridgedChannelOption(interaction: ChatInputCommandInteraction): Promise<string | null> {
  const channelId = interaction.options.getChannel('channel')?.id || interaction.channelId
  const channel = channelId ? (await bridge.scopeFor(channelId).catch(() => null))?.channel ?? null : null
  return channel && channel.enabled ? channel.channelId : null
}

function parseSubject(raw: string): { subjectType: 'user' | 'discord' | 'ip'; subject: string } | null {
  const match = /^(user|discord|ip):(.+)$/.exec(raw.trim())
  if (match) {
    const subjectType = match[1] as 'user' | 'discord' | 'ip'
    const subject = match[2].trim()
    if (!subject) return null
    return { subjectType, subject }
  }
  const value = raw.trim()
  if (!value) return null
  if (/^\d{17,20}$/.test(value)) return { subjectType: 'discord', subject: value }
  if (/^\d{1,10}$/.test(value)) return { subjectType: 'user', subject: value }
  if (/^[\da-f.:]{3,45}$/i.test(value)) return { subjectType: 'ip', subject: value }
  return null
}

export default {
  data: new SlashCommandBuilder()
    .setName('bridge')
    .setDescription('Moderate the site chatbox bridge.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub.setName('timeout')
        .setDescription('Time out a webhook (web or Discord) in a bridged channel.')
        .addStringOption((o) => o.setName('target').setDescription('@member / user:<siteId> / discord:<id> / site username / msg:<id> / message link').setRequired(true))
        .addIntegerOption((o) => o.setName('duration').setDescription('Duration').setRequired(true).addChoices(...TIMEOUT_CHOICES))
        .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(false))
        .addChannelOption((o) => o.setName('channel').setDescription('Bridged channel (default: this one)').setRequired(false)),
    )
    .addSubcommand((sub) =>
      sub.setName('untimeout')
        .setDescription('Remove a webhook\'s timeout in a bridged channel.')
        .addStringOption((o) => o.setName('target').setDescription('Same format as /bridge timeout').setRequired(true))
        .addChannelOption((o) => o.setName('channel').setDescription('Bridged channel (default: this one)').setRequired(false)),
    )
    .addSubcommand((sub) =>
      sub.setName('ban')
        .setDescription('Ban a webhook (web or Discord) or an IP from the site chatbox.')
        .addStringOption((o) => o.setName('subject').setDescription('@member / user:<siteId> / discord:<id> / site username / msg:<id> / link / ip:<addr>').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Why').setRequired(false)),
    )
    .addSubcommand((sub) =>
      sub.setName('unban')
        .setDescription('Lift a chatbox ban (webhook or IP).')
        .addStringOption((o) => o.setName('subject').setDescription('Same format as /bridge ban').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName('bans').setDescription('List active chatbox bans.'),
    )
    .addSubcommand((sub) =>
      sub.setName('modlog')
        .setDescription('Show recent moderation events.')
        .addIntegerOption((o) => o.setName('count').setDescription('How many (default 10, max 25)').setRequired(false)),
    )
    .addSubcommand((sub) =>
      sub.setName('perms')
        .setDescription('Show how the site chatbox resolves a member\'s chat permissions (tier diagnosis).')
        .addUserOption((o) => o.setName('member').setDescription('Guild member to inspect (default: you)').setRequired(false)),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand()
    const actor = `discord:${interaction.user.id}`

    if (sub === 'timeout' || sub === 'untimeout') {
      const channelId = await bridgedChannelOption(interaction)
      if (!channelId) return interaction.reply({ content: 'That is not a bridged channel. Pick one with the channel option.', ephemeral: true })
      const target = interaction.options.getString('target', true)
      const request: ModerationRequest = sub === 'timeout'
        ? { action: 'timeout', seconds: interaction.options.getInteger('duration', true), reason: interaction.options.getString('reason') || '' }
        : { action: 'untimeout' }
      return interaction.reply({ content: await moderateAs(interaction, target, channelId, request), ephemeral: true })
    }

    if (sub === 'ban' || sub === 'unban') {
      const raw = interaction.options.getString('subject', true)
      const parsed = parseSubject(raw)
      // IP subjects have no webhook identity: plain ban rows, scoped like
      // webhook bans (global from the home guild or by a site admin, else
      // this server only).
      if (parsed?.subjectType === 'ip' && (/^ip:/i.test(raw.trim()) || /[.:]/.test(raw))) {
        const guildId = await commandGuildId(interaction, interaction.channelId)
        const { identity: actorIdentity, bits } = await actorChatBits(interaction, guildId)
        if (!canBan(bits)) return interaction.reply({ content: 'You do not have permission to ban webhooks.', ephemeral: true })
        if (actorIdentity && (await webhookBanFor(actorIdentity, guildId))) return interaction.reply({ content: 'You are banned from the site chatbox.', ephemeral: true })
        const scope = banScopeFor({ siteAdmin: actorIdentity?.admin === true, guildId, homeGuildId: homeGuildId() })
        if (sub === 'ban') {
          const reason = interaction.options.getString('reason') || ''
          await bridge.addBan({ ...parsed, reason, createdBy: actor, guildId: scope, issuedInGuildId: guildId })
          return interaction.reply({ content: `Banned ip:${parsed.subject} from the site chatbox${scope ? ' in this server' : ''}.${reason ? ` (${reason})` : ''}`, ephemeral: true })
        }
        const lifted = await bridge.revokeBan('ip', parsed.subject, actor, { guildId, global: scope === null })
        return interaction.reply({ content: lifted ? `Unbanned ip:${parsed.subject}.` : 'No active ban found for that subject.', ephemeral: true })
      }
      const request: ModerationRequest = sub === 'ban'
        ? { action: 'ban', reason: interaction.options.getString('reason') || '' }
        : { action: 'unban' }
      return interaction.reply({ content: await moderateAs(interaction, raw, interaction.channelId, request), ephemeral: true })
    }

    if (sub === 'bans') {
      // BAN_WEBHOOKS in this guild. The home guild sees every ban; any other
      // guild only its own scoped bans, IP subjects redacted.
      const guildId = interaction.guildId || ''
      if (!canBan((await actorChatBits(interaction, guildId)).bits)) {
        return interaction.reply({ content: 'You do not have permission to view chatbox bans.', ephemeral: true })
      }
      const view = moderationViewGuild(guildId, homeGuildId())
      const bans = await bridge.listBans(25, view)
      if (!bans.length) return interaction.reply({ content: 'No active chatbox bans.', ephemeral: true })
      const embed = new EmbedBuilder()
        .setTitle('Active chatbox bans')
        .setColor('#600080')
        .setDescription(
          bans.map((b) => banListLine(b, view !== null)).join('\n').slice(0, 4000),
        )
      return interaction.reply({ embeds: [embed], ephemeral: true })
    }

    if (sub === 'modlog') {
      // MANAGE_WEBHOOKS in this guild. The home guild keeps the full log; any
      // other guild sees only its own events.
      const guildId = interaction.guildId || ''
      if (!hasPerm((await actorChatBits(interaction, guildId)).bits, Perm.MANAGE_WEBHOOKS)) {
        return interaction.reply({ content: 'You do not have permission to view the moderation log.', ephemeral: true })
      }
      const count = Math.min(Math.max(interaction.options.getInteger('count') || 10, 1), 25)
      const events = await bridge.listModerationEvents(count, moderationViewGuild(guildId, homeGuildId()))
      if (!events.length) return interaction.reply({ content: 'No moderation events yet.', ephemeral: true })
      const embed = new EmbedBuilder()
        .setTitle('Recent moderation events')
        .setColor('#600080')
        .setDescription(
          events.map((e) => `\`${e.action}\` **${e.subject}** by ${e.actor || 'system'}${e.reason ? ` - ${e.reason}` : ''}`).join('\n').slice(0, 4000),
        )
      return interaction.reply({ embeds: [embed], ephemeral: true })
    }

    if (sub === 'perms') {
      // Diagnose how the site chatbox resolves a member: their resolved tier,
      // whether their Discord account is linked to a web account, and whether
      // their guild roles match any synced chat-role rows. This is the first
      // thing to run when someone reports "no permission" in the site chat.
      const target = interaction.options.getUser('member') || interaction.user
      const { chatPermsForDiscord, hasPerm, Perm } = await import('../discord-chat-perms.js')
      const { identityByDiscordId } = await import('../identity-directory.ts')
      const perms = interaction.guildId ? await chatPermsForDiscord(target.id, interaction.guildId).catch(() => null) : null
      const linked = await identityByDiscordId(target.id).catch(() => null)
      if (!perms) {
        return interaction.reply({ content: `Could not resolve chat permissions for <@${target.id}> - check the service logs.`, ephemeral: true })
      }
      const bits: string[] = []
      if (hasPerm(perms.permissions, Perm.VIEW_MESSAGES)) bits.push('VIEW')
      if (hasPerm(perms.permissions, Perm.SEND_MESSAGES)) bits.push('SEND')
      if (hasPerm(perms.permissions, Perm.ADD_REACTIONS)) bits.push('REACT')
      if (hasPerm(perms.permissions, Perm.TIMEOUT_WEBHOOKS)) bits.push('TIMEOUT')
      if (hasPerm(perms.permissions, Perm.BAN_WEBHOOKS)) bits.push('BAN')
      if (hasPerm(perms.permissions, Perm.MANAGE_WEBHOOKS)) bits.push('MANAGE')
      if (hasPerm(perms.permissions, Perm.SEND_EMBEDS)) bits.push('EMBEDS')
      const lines = [
        `**Tier:** ${perms.tier}${perms.roleName ? ` (via role "${perms.roleName}", position ${perms.position})` : ' (no mapped chat role matched - @everyone default)'}`,
        `**Bits:** ${bits.join(', ') || 'none'}`,
        `**Web account linked:** ${linked ? `yes (${linked.key}${linked.admin ? ', site admin' : ''}) - web chat uses these perms` : 'NO - on the website this member resolves as a guest. They must link Discord in their account settings.'}`,
      ]
      if (perms.tier === 'member' || perms.tier === 'guest') {
        lines.push('If this member should be staff: their guild role id must be listed under discord.chatRoles in the site config and the discord service restarted (startup syncs the chat-role table).')
      }
      return interaction.reply({ content: lines.join('\n'), ephemeral: true })
    }
  },
} satisfies Command
