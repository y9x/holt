import {
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js'
import { getConfig } from '../config.js'
import { checkIp, logWebhook, setVerification } from '../discord-verify.js'
import { verifiedRoleNames } from './state.js'
import type { Command } from './types.js'

export default {
  data: new SlashCommandBuilder()
    .setName('manverify')
    .setDescription('Manually verify a user against a staff-supplied IP address.')
    .addUserOption((option) =>
      option.setName('user').setDescription('The user to verify.').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('ip').setDescription('The IP address to record.').setRequired(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    if (!interaction.guild) return
    const user = interaction.options.getUser('user', true)
    const ip = interaction.options.getString('ip', true)
    const member = await interaction.guild.members.fetch(user.id).catch(() => null)
    if (!member) {
      return interaction.reply({ content: `<@${user.id}> is not in this server.`, flags: [MessageFlags.Ephemeral] })
    }

    const existingId = await checkIp(ip)
    if (existingId && existingId !== user.id) {
      return interaction.reply({
        content: `<@${user.id}>'s IP is already verified as <@${existingId}>.`,
        flags: [MessageFlags.Ephemeral],
      })
    }

    const verifiedRoles = getConfig().discord?.roleIds?.verified || []
    await setVerification(user.id, ip)
    if (verifiedRoles.length) await member.roles.add(verifiedRoles).catch(() => {})
    await logWebhook(`<@!${user.id}> was manually verified by <@!${interaction.user.id}>.`)

    const formatter = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' })
    const names = verifiedRoleNames.length ? verifiedRoleNames : ['verified']
    const embed = new EmbedBuilder()
      .setTitle('Manually verified.')
      .setDescription(`<@${user.id}> has been verified and granted the ${formatter.format(names)} role${names.length > 1 ? 's' : ''}.`)
      .setColor('#600080')
    return interaction.reply({ embeds: [embed] })
  },
} as Command
