import {
  EmbedBuilder,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js'
import { getConfig } from '../config.js'
import { processPendingDeletions } from '../discord-verify.js'
import type { Command } from './types.js'

export default {
  data: new SlashCommandBuilder()
    .setName('deletepending')
    .setDescription('Process all pending verification-data deletion requests.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    if (!interaction.guild) return
    const initialEmbed = new EmbedBuilder()
      .setTitle('Processing data deletion requests...')
      .setDescription('This might take a few seconds.')
      .setColor('#600080')
    await interaction.reply({ embeds: [initialEmbed] })

    const ids = await processPendingDeletions()
    const verifiedRoles = getConfig().discord?.roleIds?.verified || []
    for (const id of ids) {
      const member = await interaction.guild.members.fetch(id).catch(() => null)
      if (member && verifiedRoles.length) await member.roles.remove(verifiedRoles).catch(() => {})
    }

    const embed = new EmbedBuilder()
      .setTitle('Data deletion requests have been processed.')
      .setDescription(`All queued verification data has been erased and verified roles removed. Processed ${ids.length} request${ids.length === 1 ? '' : 's'}.`)
      .setColor('#600080')
    await interaction.editReply({ embeds: [embed] })
  },
} as Command
