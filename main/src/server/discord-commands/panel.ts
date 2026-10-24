import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js'
import { authorizeUrl } from '../discord-verify.js'
import type { Command } from './types.js'

export default {
  data: new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Send a verification panel/button in this channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    if (!interaction.guild) return
    const messageEmbed = new EmbedBuilder()
      .setTitle('Verify with this server')
      .setDescription('In order to gain access to this server, we require verification in order to prevent alting.')
      .setColor('#600080')

    const button = new ButtonBuilder()
      .setLabel('Verify now!')
      .setURL(authorizeUrl())
      .setStyle(ButtonStyle.Link)

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button)

    await interaction.reply({ embeds: [messageEmbed], components: [row] })
  },
} as Command
