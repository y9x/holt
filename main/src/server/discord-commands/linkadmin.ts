import {
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js'
import type { AutocompleteInteraction } from 'discord.js'
import { addLinks, normalizeLinkUrl, poolLinks, retireLink } from '../link-dispenser.js'
import { dispenserPanel } from './links.js'
import type { Command } from './types.js'

// Staff side of the link dispenser: post the panel, add links to the pool,
// retire blocked ones, and see how far each link has spread.
export default {
  data: new SlashCommandBuilder()
    .setName('linkadmin')
    .setDescription('Manage the link dispenser.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName('panel').setDescription('Post the link dispenser panel in this channel.'))
    .addSubcommand((s) => s
      .setName('add')
      .setDescription('Add links to the pool (a retired link is restored).')
      .addStringOption((o) => o.setName('urls').setDescription('One or more links, separated by spaces or commas').setRequired(true).setMaxLength(4000)))
    .addSubcommand((s) => s
      .setName('retire')
      .setDescription('Stop handing out a link (e.g. it got blocked).')
      .addStringOption((o) => o.setName('url').setDescription('Link to retire').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('list').setDescription('List the pool with how often each link was handed out.')),

  async autocomplete(interaction: AutocompleteInteraction) {
    const focused = interaction.options.getFocused().trim().toLowerCase()
    const links = await poolLinks()
    await interaction.respond(links
      .filter((l) => !l.retired && (!focused || l.url.toLowerCase().includes(focused)))
      .slice(0, 25)
      .map((l) => ({ name: l.url.slice(0, 100), value: l.url.slice(0, 100) })))
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand()

    if (sub === 'panel') {
      if (!interaction.channel?.isSendable()) {
        return interaction.reply({ content: 'I can\'t post in this channel.', flags: [MessageFlags.Ephemeral] })
      }
      await interaction.channel.send(dispenserPanel())
      return interaction.reply({ content: 'Link dispenser panel posted.', flags: [MessageFlags.Ephemeral] })
    }

    if (sub === 'add') {
      const raw = interaction.options.getString('urls', true).split(/[\s,]+/).filter(Boolean)
      const valid = [...new Set(raw.map(normalizeLinkUrl).filter((u): u is string => Boolean(u)))]
      const invalid = raw.filter((u) => !normalizeLinkUrl(u))
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] })
      const result = await addLinks(valid, interaction.user.id)
      const lines = [
        result.added.length && `Added ${result.added.length}: ${result.added.join(', ')}`,
        result.restored.length && `Restored ${result.restored.length}: ${result.restored.join(', ')}`,
        result.existing.length && `Already in the pool: ${result.existing.join(', ')}`,
        invalid.length && `Not a valid link: ${invalid.join(', ')}`,
      ].filter(Boolean) as string[]
      return interaction.editReply({ content: (lines.join('\n') || 'Nothing to add.').slice(0, 2000) })
    }

    if (sub === 'retire') {
      const url = normalizeLinkUrl(interaction.options.getString('url', true))
      const retired = url ? await retireLink(url) : false
      return interaction.reply({
        content: retired ? `Retired ${url}. It won't be handed out again.` : 'That link isn\'t active in the pool.',
        flags: [MessageFlags.Ephemeral],
      })
    }

    if (sub === 'list') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] })
      const links = await poolLinks()
      const active = links.filter((l) => !l.retired)
      const retiredCount = links.length - active.length
      const body = active.length
        ? active.map((l) => `• ${l.url}: ${l.month} this month, ${l.total} total${l.reports ? `, ⚠ ${l.reports} blocked report${l.reports > 1 ? 's' : ''}` : ''}`).join('\n')
        : 'The pool is empty. Add links with /linkadmin add.'
      const embed = new EmbedBuilder()
        .setColor(0x600080)
        .setTitle(`Link pool: ${active.length} active${retiredCount ? `, ${retiredCount} retired` : ''}`)
        .setDescription(body.length > 4000 ? `${body.slice(0, 3990)}\n…` : body)
      return interaction.editReply({ embeds: [embed] })
    }
  },
} as Command
