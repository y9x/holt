import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js'
import { queueDeletion } from '../discord-verify.js'
import type { Command } from './types.js'

export default {
  data: new SlashCommandBuilder()
    .setName('deletionrequest')
    .setDescription('Request the deletion of your verification data.')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const confirmationEmbed = new EmbedBuilder()
      .setTitle('Confirmation')
      .setDescription('Are you sure you want to request the deletion of your verification data?')
      .setColor('#600080')
    const confirmButton = new ButtonBuilder().setCustomId('confirm').setLabel('Yes').setStyle(ButtonStyle.Success)
    const denyButton = new ButtonBuilder().setCustomId('deny').setLabel('No').setStyle(ButtonStyle.Danger)
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton, denyButton)

    await interaction.reply({ embeds: [confirmationEmbed], components: [row], flags: [MessageFlags.Ephemeral] })
    const reply = await interaction.fetchReply()
    const collector = reply.createMessageComponentCollector({
      filter: (i) => i.user.id === interaction.user.id && (i.customId === 'confirm' || i.customId === 'deny'),
      time: 60_000,
    })
    collector.on('collect', async (i) => {
      if (i.customId === 'confirm') {
        await queueDeletion(interaction.user.id)
        const successEmbed = new EmbedBuilder()
          .setTitle('Success!')
          .setDescription('You have successfully submitted a data deletion request. It will be processed by staff.')
          .setColor('#600080')
        await i.update({ embeds: [successEmbed], components: [] })
      } else {
        await i.update({ content: 'Deletion request cancelled.', embeds: [], components: [] })
      }
      collector.stop()
    })
    collector.on('end', async (_collected, reason) => {
      if (reason === 'time') await interaction.editReply({ embeds: [], components: [] }).catch(() => {})
    })
  },
} as Command
