import {
  EmbedBuilder,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js'
import { getConfig } from '../config.js'
import { cancelDeletion, deleteVerification } from '../discord-verify.js'
import type { Command } from './types.js'

export default {
  data: new SlashCommandBuilder()
    .setName('manualdeletion')
    .setDescription("Manually erase a user's verification data and strip verified roles.")
    .addUserOption((option) =>
      option.setName('user').setDescription('The user to erase.').setRequired(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    if (!interaction.guild) return
    const user = interaction.options.getUser('user', true)
    await cancelDeletion(user.id)
    await deleteVerification(user.id)

    const verifiedRoles = getConfig().discord?.roleIds?.verified || []
    const member = await interaction.guild.members.fetch(user.id).catch(() => null)
    if (member && verifiedRoles.length) await member.roles.remove(verifiedRoles).catch(() => {})

    const embed = new EmbedBuilder()
      .setTitle('Manual data deletion processed.')
      .setDescription(`<@${user.id}> has been erased from the verification database.`)
      .setColor('#600080')
    await interaction.reply({ embeds: [embed] })
  },
} as Command
