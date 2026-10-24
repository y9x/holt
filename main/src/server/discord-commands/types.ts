import type {
  AutocompleteInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js'

export interface Command {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder
  execute: (interaction: ChatInputCommandInteraction) => Promise<unknown> | unknown
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<unknown>
  // Persistent buttons / string selects whose custom id is
  // `<command name>:<action>[:<arg>]` (they outlive restarts, unlike a message
  // component collector). The custom id is routing only: handlers re-check
  // permissions and ownership.
  component?: (interaction: ButtonInteraction | StringSelectMenuInteraction) => Promise<unknown>
  // Registered globally (DMs and user installs) instead of per guild.
  global?: boolean
}

export function isCommand(structure: unknown): structure is Command {
  if (!structure || typeof structure !== 'object') return false
  const s = structure as Record<string, unknown>
  return typeof s.data === 'object' && typeof s.execute === 'function'
}
