import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js'
import type { ButtonInteraction, ChatInputCommandInteraction, StringSelectMenuInteraction } from 'discord.js'
import { checkMinute } from '../chat-engine.js'
import { getConfig } from '../config.js'
import { ABSTRACT_SALES_OPEN } from '../../abstract-plans.js'
import { logWebhook } from '../discord-verify.js'
import {
  MONTHLY_LINKS,
  PLAN_NAMES,
  REPORTS_TO_RETIRE,
  dispenseLink,
  linkIdentity,
  linksThisMonth,
  monthWindow,
  quotaFor,
  reportLink,
  usedThisMonth,
  type LinkIdentity,
} from '../link-dispenser.js'
import type { Command } from './types.js'

// Member side of the link dispenser: /links get|mine|plans and the panel
// buttons /linkadmin panel posts (custom ids links:get, links:mine,
// links:plans), plus blocked reports (links:report:<linkId> on a fresh draw,
// the links:reportpick select on My links). Every reply is ephemeral so links
// stay with whoever drew them. Component custom ids and select values are
// never trusted: every action re-checks the gate and that the caller drew the
// link.
// Every draw comes from the free allowance. The upsell points at the Abstract
// AI plans on the Pricing page (the `pricing` view).

type LinksInteraction = ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction

const REPORTS_PER_MINUTE = 5

const PURPLE = 0x600080
const GOLD = 0xf1c40f

function siteOrigin(): string {
  const raw = (getConfig().mail?.publicOrigin || '').trim().replace(/\/+$/, '')
  return /^https?:\/\/[^/\s]+$/i.test(raw) ? raw : ''
}

function resetStamp(): string {
  return `<t:${Math.floor(monthWindow().reset.getTime() / 1000)}:D>`
}

function upgradeButtons(identity: LinkIdentity | null): ActionRowBuilder<ButtonBuilder>[] {
  const origin = siteOrigin()
  if (!ABSTRACT_SALES_OPEN || !origin) return []
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(`${origin}/#/pricing`).setLabel('See Abstract plans'),
  )
  if (!identity?.userId) {
    row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(`${origin}/#/account`).setLabel('Link Discord'))
  }
  return [row]
}

// Plan summary + how to upgrade. The site origin is itself a cloak whose decoy
// drops the URL hash, so a #/pricing deep link can't reach the page: the steps
// walk through Ctrl+E and the sidebar instead.
export function plansDescription(identity: LinkIdentity | null): string {
  const origin = siteOrigin()
  const where = origin ? `[${origin.replace(/^https?:\/\//, '')}](${origin}/)` : 'the Abstract site'
  const account = '**Account** (the person icon, bottom left)'
  const current = identity ? `\nYour plan: **${PLAN_NAMES[identity.plan]}**${identity.userId ? '' : ' (Discord not linked to an Abstract account)'}` : ''
  if (!ABSTRACT_SALES_OPEN) {
    return [`**Free: ${MONTHLY_LINKS.free} links every month.**`, current, '', 'Paid plans open soon.'].join('\n')
  }
  const steps = [
    `Open ${where}, press **Ctrl+E** (**⌘+E** on a Mac), then click **Pricing** (the $ icon in the sidebar). Sign in${identity?.userId ? '' : ' or make a free account'}.`,
    'Pick an Abstract plan and check out.',
    ...(identity?.userId ? [] : [`On ${account}, link your Discord so this bot can see your account.`]),
  ]
  return [
    `**Free: ${MONTHLY_LINKS.free} links every month.**`,
    current,
    '',
    '**How to upgrade**',
    ...steps.map((step, i) => `${i + 1}. ${step}`),
  ].join('\n')
}

// After a draw: point at the paid Abstract plans.
function nudge(identity: LinkIdentity): string {
  if (!ABSTRACT_SALES_OPEN) return 'Paid plans open soon.'
  const linked = identity.userId ? '' : '\nLink your Discord on the Account page to connect your Abstract account.'
  return `Want more AI? Abstract plans are on the Pricing page.${linked}`
}

// The dispenser is for verified home-guild members only. The verified role is
// the server's anti-alt gate, so it also keeps alt accounts from farming
// free links.
function gateDenial(interaction: LinksInteraction): string | null {
  const d = getConfig().discord
  if (!d?.guildId || interaction.guildId !== d.guildId) return 'Use this in the Abstract Discord server.'
  const verified = d.roleIds?.verified || []
  if (!verified.length) return null
  const member = interaction.member
  const roles = !member ? [] : Array.isArray(member.roles) ? member.roles : [...member.roles.cache.keys()]
  return verified.some((id) => roles.includes(id)) ? null : 'Verify in this server first, then come back for your link.'
}

async function handleGet(interaction: LinksInteraction): Promise<unknown> {
  const denial = gateDenial(interaction)
  if (denial) return interaction.reply({ content: denial, flags: [MessageFlags.Ephemeral] })
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] })
  const identity = await linkIdentity(interaction.user.id)
  const result = await dispenseLink(identity)

  if (result.kind === 'granted') {
    const embed = new EmbedBuilder()
      .setColor(PURPLE)
      .setTitle('Your link')
      .setDescription([
        `**${result.url}**`,
        '',
        'Open it, then press **Ctrl+E** (**⌘+E** on a Mac) to get into Abstract. It remembers you after that.',
        'This link was picked for you and won\'t be handed to you again. Keep it to yourself so it lasts longer. Blocked where you are? Press **Report blocked**.',
      ].join('\n'))
      .addFields(
        { name: 'This month', value: `${result.left} of ${result.limit} links left (${PLAN_NAMES[identity.plan]}). Resets ${resetStamp()}.` },
        { name: 'More links', value: nudge(identity) },
      )
    const report = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`links:report:${result.linkId}`).setStyle(ButtonStyle.Danger).setLabel('Report blocked'),
    )
    return interaction.editReply({ embeds: [embed], components: [report, ...upgradeButtons(identity)] })
  }

  if (result.kind === 'empty') {
    return interaction.editReply({
      content: `No new links are available right now, so nothing was taken from your allowance (${result.left} of ${result.limit} left this month). Staff add links regularly. Try again later.`,
    })
  }

  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(`You've used all ${result.limit} of your ${PLAN_NAMES[identity.plan]} links`)
    .setDescription(`New links unlock ${resetStamp()}.\n\n${plansDescription(identity)}`)
  return interaction.editReply({ embeds: [embed], components: upgradeButtons(identity) })
}

async function handleMine(interaction: LinksInteraction): Promise<unknown> {
  const denial = gateDenial(interaction)
  if (denial) return interaction.reply({ content: denial, flags: [MessageFlags.Ephemeral] })
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] })
  const identity = await linkIdentity(interaction.user.id)
  const [links, used] = await Promise.all([linksThisMonth(identity), usedThisMonth(identity)])
  const quota = quotaFor(identity.plan, used)
  const list = links.length
    ? links.map((l) => `• ${l.retired ? `~~${l.url}~~ (retired)` : `${l.url}${l.reported ? ' (you reported it)' : ''}`}`).join('\n')
    : 'You haven\'t drawn any links this month.'
  const embed = new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle('Your links this month')
    .setDescription(list.slice(0, 3500))
    .addFields({ name: 'Allowance', value: `${quota.left} of ${quota.limit} left (${PLAN_NAMES[identity.plan]}). Resets ${resetStamp()}.` })
  if (links.length) embed.addFields({ name: 'Opening a link', value: 'Press **Ctrl+E** (**⌘+E** on a Mac) on the page to get into Abstract.' })
  embed.addFields({ name: 'More links', value: nudge(identity) })
  const reportable = links.filter((l) => !l.retired && !l.reported).slice(0, 25)
  const picker = reportable.length
    ? [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('links:reportpick')
        .setPlaceholder('Report a blocked link')
        .addOptions(reportable.map((l) => ({ label: l.url.replace(/^https:\/\//, '').slice(0, 100), value: String(l.linkId) }))),
    )]
    : []
  return interaction.editReply({ embeds: [embed], components: [...picker, ...upgradeButtons(identity)] })
}

async function handleReport(interaction: LinksInteraction, linkId: number): Promise<unknown> {
  const denial = gateDenial(interaction)
  if (denial) return interaction.reply({ content: denial, flags: [MessageFlags.Ephemeral] })
  if (!checkMinute(`link-report:${interaction.user.id}`, REPORTS_PER_MINUTE)) {
    return interaction.reply({ content: 'You are reporting too quickly. Wait a minute and try again.', flags: [MessageFlags.Ephemeral] })
  }
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] })
  const identity = await linkIdentity(interaction.user.id)
  const result = await reportLink(identity, linkId)
  if (result.kind === 'not-drawn') return interaction.editReply({ content: 'You can only report links you got from the dispenser.' })
  if (result.kind === 'already-retired') return interaction.editReply({ content: `${result.url} has already been retired. Thanks anyway.` })
  if (result.kind === 'already-reported') return interaction.editReply({ content: `You already reported ${result.url}. Thanks!` })
  if (result.retiredNow) {
    await logWebhook(`Link dispenser: ${result.url} was retired after ${result.reports} blocked reports (last by <@${interaction.user.id}>).`)
  }
  return interaction.editReply({
    content: result.retiredNow
      ? `Thanks. ${result.url} has been pulled from the dispenser.`
      : `Thanks. ${result.url} is reported as blocked. It's pulled automatically once ${REPORTS_TO_RETIRE} people report it. Reports don't give the link back to your monthly allowance.`,
  })
}

async function handlePlans(interaction: LinksInteraction): Promise<unknown> {
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] })
  const identity = await linkIdentity(interaction.user.id).catch(() => null)
  const embed = new EmbedBuilder().setColor(GOLD).setTitle('Get more links').setDescription(plansDescription(identity))
  return interaction.editReply({ embeds: [embed], components: upgradeButtons(identity) })
}

// Public panel posted by /linkadmin panel.
export function dispenserPanel(): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const embed = new EmbedBuilder()
    .setColor(PURPLE)
    .setTitle('Link Dispenser')
    .setDescription([
      'Press **Get a link** for a fresh Abstract link only you can see. You never get the same link twice.',
      '',
      '**Links per month**',
      `Free: **${MONTHLY_LINKS.free}**`,
      '',
      'Links reset on the 1st of each month (UTC).',
    ].join('\n'))
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('links:get').setStyle(ButtonStyle.Primary).setLabel('Get a link'),
    new ButtonBuilder().setCustomId('links:mine').setStyle(ButtonStyle.Secondary).setLabel('My links'),
    new ButtonBuilder().setCustomId('links:plans').setStyle(ButtonStyle.Success).setLabel('Get more links'),
  )
  return { embeds: [embed], components: [row] }
}

const handlers: Record<string, (interaction: LinksInteraction) => Promise<unknown>> = {
  get: handleGet,
  mine: handleMine,
  plans: handlePlans,
}

const LINK_ID = /^[1-9]\d{0,9}$/

export default {
  data: new SlashCommandBuilder()
    .setName('links')
    .setDescription('Get Abstract links from the link dispenser.')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName('get').setDescription('Get a new link (counts toward your monthly allowance).'))
    .addSubcommand((s) => s.setName('mine').setDescription('Show the links you got this month and how many you have left.'))
    .addSubcommand((s) => s.setName('plans').setDescription('See monthly link allowances and how to get more.')),

  async execute(interaction) {
    return handlers[interaction.options.getSubcommand()]?.(interaction)
  },

  async component(interaction: ButtonInteraction | StringSelectMenuInteraction) {
    const [, action = '', arg = ''] = interaction.customId.split(':')
    if (interaction.isStringSelectMenu()) {
      const value = interaction.values[0] || ''
      return action === 'reportpick' && LINK_ID.test(value) ? handleReport(interaction, Number(value)) : undefined
    }
    if (action === 'report') return LINK_ID.test(arg) ? handleReport(interaction, Number(arg)) : undefined
    return handlers[action]?.(interaction)
  },
} as Command
