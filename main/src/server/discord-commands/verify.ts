import crypto from 'node:crypto'
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  EmbedBuilder,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js'
import { getConfig } from '../config.js'
import { authorizeUrl, checkIp, getIpData, logWebhook, setVerification } from '../discord-verify.js'
import { verificationMap, verifiedRoleNames } from './state.js'
import type { Command } from './types.js'

export default {
  data: new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Interactively verify a user via their own OAuth flow.')
    .addUserOption((option) =>
      option.setName('user').setDescription('The user to verify.').setRequired(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    if (!interaction.channel || !interaction.guild) return
    const user = interaction.options.getUser('user', true)

    const verifyEmbed = new EmbedBuilder()
      .setTitle('Manual Verification')
      .setDescription(`Send the following link to <@${user.id}> - it captures their IP for the anti-alt check.`)
      .setColor('#600080')
    const state = crypto.randomBytes(16).toString('hex')
    const verifyButton = new ButtonBuilder()
      .setLabel('Verify now!')
      .setURL(authorizeUrl(state))
      .setStyle(ButtonStyle.Link)
    const verifyRow = new ActionRowBuilder<ButtonBuilder>().addComponents(verifyButton)

    let resolve!: (value: { ip: string; id: string }) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<{ ip: string; id: string }>((res, rej) => { resolve = res; reject = rej })
    verificationMap.set(state, resolve)
    const timeout = setTimeout(() => {
      verificationMap.delete(state)
      reject(new Error('timeout'))
      interaction.editReply({ content: 'A timeout occurred, please run the command again!', embeds: [], components: [] }).catch(() => {})
    }, 120_000)

    await interaction.reply({ embeds: [verifyEmbed], components: [verifyRow] })

    let data: { ip: string; id: string }
    try {
      data = await promise
    } catch {
      return
    }
    clearTimeout(timeout)

    if (user.id !== data.id) {
      return interaction.editReply({
        content: `<@!${user.id}> authenticated as <@!${data.id}>. (user mismatch)`,
        embeds: [],
        components: [],
      })
    }

    const existingId = await checkIp(data.ip)
    if (existingId && existingId !== user.id) {
      return interaction.editReply({
        content: `<@!${user.id}>'s IP is already verified as <@!${existingId}>.`,
        embeds: [],
        components: [],
      })
    }

    const ipData = await getIpData(data.ip)
    const confirmationEmbed = new EmbedBuilder()
      .setTitle('Would you like to verify this user?')
      .setDescription([
        `Country: ${ipData.country || 'unknown'}`,
        `Timezone: ${ipData.timezone || 'unknown'}`,
        `ISP: ${ipData.isp || 'unknown'}`,
        `ORG: ${ipData.org || 'unknown'}`,
        `AS: ${ipData.as || 'unknown'}`,
        `AS Name: ${ipData.asname || 'unknown'}`,
      ].join('\n'))
      .setColor('#600080')
    const confirmButton = new ButtonBuilder().setCustomId('confirm').setLabel('Yes').setStyle(ButtonStyle.Success)
    const denyButton = new ButtonBuilder().setCustomId('deny').setLabel('No').setStyle(ButtonStyle.Danger)
    const confirmationRow = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton, denyButton)

    const reply = await interaction.editReply({ embeds: [confirmationEmbed], components: [confirmationRow] })
    const collector = reply.createMessageComponentCollector({
      filter: (i) => i.user.id === interaction.user.id && (i.customId === 'confirm' || i.customId === 'deny'),
      time: 120_000,
    })
    collector.on('collect', async (i) => {
      collector.stop()
      if (i.customId !== 'confirm') {
        await i.update({ content: 'Verification cancelled.', embeds: [], components: [] })
        return
      }
      const verifiedRoles = getConfig().discord?.roleIds?.verified || []
      await setVerification(user.id, data.ip)
      const member = await interaction.guild!.members.fetch(user.id).catch(() => null)
      if (member && verifiedRoles.length) await member.roles.add(verifiedRoles).catch(() => {})
      await logWebhook(`<@!${user.id}> was manually verified by <@!${interaction.user.id}>.`)

      const formatter = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' })
      const names = verifiedRoleNames.length ? verifiedRoleNames : ['verified']
      const doneEmbed = new EmbedBuilder()
        .setTitle('Manually verified.')
        .setDescription(`<@${user.id}> has been verified and granted the ${formatter.format(names)} role${names.length > 1 ? 's' : ''}.`)
        .setColor(Colors.Green)
      await i.update({ embeds: [doneEmbed], components: [] })
    })
    collector.on('end', async (_c, reason) => {
      if (reason === 'time') await interaction.editReply({ embeds: [], components: [] }).catch(() => {})
    })
  },
} as Command
