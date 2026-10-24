import {
  ApplicationIntegrationType,
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js'
import type { Attachment, AutocompleteInteraction, ChatInputCommandInteraction, Guild, Message, TextChannel } from 'discord.js'
import { USER_AI_MODELS, providerForModelId, resolveModel } from '../../ai-models.js'
import { callProvider, loadProviders, type ChatInputMessage, type ImagePart, type ProviderConfig, type ProviderSet } from '../ai-providers.js'
import { SYSTEM_CONTEXT } from '../ai-prompt.js'
import { getConfig } from '../config.js'
import { checkMinute } from '../chat-engine.js'
import { planAccessDenial, planForUser, planModelId } from '../ai-quota.js'
import { userForDiscordId } from '../discord-roles.js'
import type { Command } from './types.js'

// Free-plan models need only guild membership; others need a linked Abstract
// account whose plan (ai-plans.ts) includes the model.
const CALL_TIMEOUT_MS = 120_000
const MAX_REPLY_CHARS = 6000
const DISCORD_MESSAGE_CHARS = 2000
const CONTEXT_MESSAGES = 30
const CONTEXT_TEXT_CHARS = 24_000
const CONTEXT_IMAGES = 8
const CONTEXT_IMAGE_BYTES = 8 * 1024 * 1024
const CONTEXT_FILE_BYTES = 256 * 1024
const FETCH_TIMEOUT_MS = 15_000

function providerFor(providers: ProviderSet, modelId: string): ProviderConfig | null {
  return providers[providerForModelId(modelId)]
}

async function inviteFor(guild: Guild): Promise<string | null> {
  await guild.channels.fetch().catch(() => null)
  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null)
  if (!me) return null
  const channel = guild.channels.cache.find((c): c is TextChannel =>
    c.type === ChannelType.GuildText && c.permissionsFor(me)?.has(PermissionFlagsBits.CreateInstantInvite) === true)
  if (!channel) return null
  const invite = await channel.createInvite({ maxAge: 86400, maxUses: 1, unique: true }).catch(() => null)
  return invite?.url ?? null
}

async function sendAnswer(interaction: ChatInputCommandInteraction, text: string): Promise<void> {
  const chunks = text.slice(0, MAX_REPLY_CHARS).match(new RegExp(`[\\s\\S]{1,${DISCORD_MESSAGE_CHARS}}`, 'g')) ?? ['']
  const allowedMentions = { parse: [] }
  await interaction.editReply({ content: chunks[0], allowedMentions })
  for (const chunk of chunks.slice(1)) await interaction.followUp({ content: chunk, allowedMentions })
}

async function fetchBase64(url: string): Promise<string | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).catch(() => null)
  if (!res?.ok) return null
  return Buffer.from(await res.arrayBuffer()).toString('base64')
}

interface DescribedMessage {
  text: string
  images: ImagePart[]
}

async function describeAttachments(attachments: Iterable<Attachment>, imagesLeft: { left: number }): Promise<{ notes: string[]; images: ImagePart[] }> {
  const notes: string[] = []
  const images: ImagePart[] = []
  for (const attachment of attachments) {
    const mime = attachment.contentType || 'application/octet-stream'
    const label = `${attachment.name} (${mime})`
    if (mime.startsWith('image/') && !mime.includes('svg')) {
      if (imagesLeft.left <= 0 || attachment.size > CONTEXT_IMAGE_BYTES) {
        notes.push(`[Image not included: ${label}]`)
        continue
      }
      const data = await fetchBase64(attachment.url)
      if (!data) {
        notes.push(`[Image unavailable: ${label}]`)
        continue
      }
      imagesLeft.left -= 1
      images.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } })
      continue
    }
    if (/^text\/|application\/json/.test(mime) && attachment.size <= CONTEXT_FILE_BYTES) {
      const text = await fetch(attachment.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).then((r) => (r.ok ? r.text() : null)).catch(() => null)
      notes.push(text === null ? `[File unavailable: ${label}]` : `[Attached file: ${attachment.name}]\n\`\`\`\n${text}\n\`\`\``)
      continue
    }
    notes.push(`[Attached file not included: ${label}]`)
  }
  return { notes, images }
}

async function describeMessage(message: Message, imagesLeft: { left: number }): Promise<DescribedMessage> {
  const { notes, images } = await describeAttachments(message.attachments.values(), imagesLeft)
  const text = [message.content, ...notes].filter(Boolean).join('\n\n')
  return { text, images }
}

type HistoryResult = { turns: ChatInputMessage[] } | { error: string }

const HISTORY_UNAVAILABLE = 'Discord does not let the bot read messages in this conversation. Attach files to /ai instead.'

// Recent messages from the invoking channel as chat turns, oldest first.
async function channelHistory(interaction: ChatInputCommandInteraction, imagesLeft: { left: number }): Promise<HistoryResult> {
  const channel = interaction.channel ?? await interaction.client.channels.fetch(interaction.channelId).catch(() => null)
  if (!channel?.isTextBased()) return { error: HISTORY_UNAVAILABLE }
  const fetched = await channel.messages.fetch({ limit: CONTEXT_MESSAGES }).catch(() => null)
  if (!fetched) return { error: HISTORY_UNAVAILABLE }
  const botId = interaction.client.user?.id
  const turns: ChatInputMessage[] = []
  let chars = 0
  for (const message of fetched.values()) {
    const { text, images } = await describeMessage(message, imagesLeft)
    if (!text && !images.length) continue
    chars += text.length
    if (chars > CONTEXT_TEXT_CHARS) break
    const isBot = message.author.id === botId
    const speaker = isBot ? '' : `${message.member?.displayName || message.author.username}: `
    const body = text || '[image]'
    const content: ChatInputMessage['content'] = images.length ? [{ type: 'text', text: speaker + body }, ...images] : speaker + body
    turns.unshift({ role: isBot ? 'assistant' : 'user', content })
  }
  return { turns }
}

export default {
  global: true,
  data: new SlashCommandBuilder()
    .setName('ai')
    .setDescription('Ask the Abstract AI a question.')
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
    .addStringOption((o) => o.setName('prompt').setDescription('What to ask').setRequired(true).setMaxLength(2000))
    .addStringOption((o) => o.setName('model').setDescription('Model (default: Auto)').setRequired(false).setAutocomplete(true))
    .addAttachmentOption((o) => o.setName('file1').setDescription('Image or file to include').setRequired(false))
    .addAttachmentOption((o) => o.setName('file2').setDescription('Image or file to include').setRequired(false))
    .addAttachmentOption((o) => o.setName('file3').setDescription('Image or file to include').setRequired(false))
    .addBooleanOption((o) => o.setName('context').setDescription('Include recent messages, images and files from this channel').setRequired(false)),

  async autocomplete(interaction: AutocompleteInteraction) {
    const focused = interaction.options.getFocused().trim().toLowerCase()
    const choices = USER_AI_MODELS
      .filter((m) => !focused || m.id.includes(focused) || (m.display_name || '').toLowerCase().includes(focused))
      .slice(0, 25)
      .map((m) => ({ name: (m.display_name || m.id).slice(0, 100), value: m.id }))
    await interaction.respond(choices)
  },

  async execute(interaction) {
    const config = getConfig()
    const guildId = config.discord?.guildId
    if (!guildId) return interaction.reply({ content: 'AI is not configured.', ephemeral: true })

    const modelRaw = (interaction.options.getString('model') || 'auto').trim().toLowerCase()
    const prompt = interaction.options.getString('prompt', true).trim()

    const guild = await interaction.client.guilds.fetch(guildId).catch(() => null)
    const member = guild ? await guild.members.fetch(interaction.user.id).catch(() => null) : null
    if (!guild || !member) {
      const invite = guild ? await inviteFor(guild) : null
      return interaction.reply({
        content: invite ? `Join the server to use /ai: ${invite}` : 'Join the server to use /ai.',
        ephemeral: true,
      })
    }

    const modelId = planModelId(modelRaw)
    if (planAccessDenial('free', modelId)) {
      const row = await userForDiscordId(interaction.user.id).catch(() => null)
      if (!row) {
        return interaction.reply({ content: 'Paid models need a linked Abstract account. Link your Discord on the Abstract site, then try again.', ephemeral: true })
      }
      const denial = planAccessDenial(planForUser(row), modelId)
      if (denial) {
        return interaction.reply({ content: `${denial.replace(/\.$/, '')} on the Abstract site.`, ephemeral: true })
      }
    }

    if (!checkMinute(`discord:${interaction.user.id}`, config.ai?.limits?.perMinute ?? 30)) {
      return interaction.reply({ content: 'You are sending requests too quickly. Wait a minute and try again.', ephemeral: true })
    }

    const provider = providerFor(loadProviders(config.ai), modelId)
    if (!provider) return interaction.reply({ content: 'That AI model is not available right now.', ephemeral: true })
    const resolved = resolveModel(modelId)

    await interaction.deferReply()
    const imagesLeft = { left: CONTEXT_IMAGES }
    const attachments = ['file1', 'file2', 'file3']
      .map((name) => interaction.options.getAttachment(name))
      .filter((a): a is Attachment => Boolean(a))
    const { notes, images } = await describeAttachments(attachments, imagesLeft)
    const userText = [prompt, ...notes].filter(Boolean).join('\n\n')
    const userContent: ChatInputMessage['content'] = images.length ? [{ type: 'text', text: userText }, ...images] : userText
    let history: ChatInputMessage[] = []
    if (interaction.options.getBoolean('context')) {
      const result = await channelHistory(interaction, imagesLeft)
      if ('error' in result) return interaction.editReply({ content: result.error })
      history = result.turns
    }
    try {
      const result = await callProvider(
        provider,
        [
          { role: 'system', content: SYSTEM_CONTEXT },
          ...history,
          { role: 'user', content: userContent },
        ],
        resolved.id,
        { thinking: resolved.thinking, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
      )
      await sendAnswer(interaction, result.reply?.trim() || 'The model returned no text.')
    } catch (error) {
      console.error('[abulxt-discord] /ai failed:', error instanceof Error ? error.message : error)
      await interaction.editReply({ content: 'The AI request failed. Try again in a moment.' })
    }
  },
} as Command
