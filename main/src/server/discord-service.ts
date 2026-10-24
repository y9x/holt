import { Client, GatewayIntentBits, MessageFlags, PermissionFlagsBits, REST, Routes } from 'discord.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.js'
import { configureDatabase, ensureSchema, query } from './db.js'
import { loadStructures } from './discord-commands/index.js'
import { isCommand, type Command } from './discord-commands/types.js'
import { verifiedRoleNames } from './discord-commands/state.js'
import { bridgedGuildIds, startBridge } from './discord-bridge-bot.js'
import {
  managedEntitlementRoles,
  syncDiscordRoles,
  userForDiscordId,
  type DiscordUserRow,
} from './discord-roles.js'
import { cancelDeletion, queueDeletion } from './discord-verify.js'

// Discord caps how often a bot can start a gateway session (IDENTIFY) per day.
// Retrying a failed login in a loop burns that quota; when Discord reports the
// cap, wait until its stated reset time and then log in exactly once.
const SESSION_LIMIT_RE = /Not enough sessions remaining.*?resets at (\S+)/
async function loginWithBackoff(client: Client, token: string): Promise<void> {
  for (;;) {
    try {
      await client.login(token)
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const limit = SESSION_LIMIT_RE.exec(message)
      if (limit) {
        const resetAt = Date.parse(limit[1])
        const waitMs = Number.isFinite(resetAt) ? Math.max(resetAt - Date.now(), 60_000) : 60 * 60_000
        console.error(`[abulxt-discord] Discord session-start limit reached; next login attempt at ${new Date(Date.now() + waitMs).toISOString()}`)
        await new Promise((resolve) => setTimeout(resolve, waitMs))
        continue
      }
      if (/disallowed intents/i.test(message)) {
        console.error('[abulxt-discord] FATAL: enable the Server Members and Message Content privileged intents for this bot in the Discord developer portal.')
      }
      throw error
    }
  }
}

async function main() {
  const config = await loadConfig()
  const d = config.discord || {}
  if (!d.botToken || !d.guildId || !d.clientId) {
    console.log('[abulxt-discord] discord.botToken / clientId / guildId not set in config.js - exiting.')
    return
  }
  configureDatabase(config.db?.url)
  await ensureSchema()

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers, // privileged - enable in the dev portal
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions, // messageReactionAdd/Remove for the bridge
      GatewayIntentBits.MessageContent, // privileged - enable in the dev portal
    ],
  })

  const commandsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'discord-commands')
  const commands = await loadStructures<Command>(commandsDir, isCommand)
  const rest = new REST({ version: '10' }).setToken(d.botToken)
  const all = [...commands.values()]
  const guildBody = all.filter((c) => !c.global).map((c) => c.data.toJSON())
  const globalBody = all.filter((c) => c.global).map((c) => c.data.toJSON())
  await rest.put(Routes.applicationGuildCommands(d.clientId, d.guildId), { body: guildBody })
  await rest.put(Routes.applicationCommands(d.clientId), { body: globalBody })
  console.log(`[abulxt-discord] registered ${guildBody.length} guild and ${globalBody.length} global slash commands`)

  // /bridge is registered in every bridged guild (other guild commands stay
  // home-only; the home guild already has the full set above). A PUT replaces
  // that guild's command set, so a guild no longer bridged keeps /bridge
  // until the next restart (harmless: it only acts on bridged channels).
  const bridgeBody = all.filter((c) => !c.global && c.data.name === 'bridge').map((c) => c.data.toJSON())
  const bridgeRegistered = new Set<string>([d.guildId])
  const registerBridgeCommands = async (guildIds: string[]) => {
    for (const guildId of guildIds) {
      if (bridgeRegistered.has(guildId) || !bridgeBody.length) continue
      bridgeRegistered.add(guildId)
      await rest.put(Routes.applicationGuildCommands(d.clientId!, guildId), { body: bridgeBody })
        .then(() => console.log(`[abulxt-discord] registered /bridge in bridged guild ${guildId}`))
        .catch((error) => {
          bridgeRegistered.delete(guildId)
          console.error(`[abulxt-discord] /bridge registration in guild ${guildId} failed: ${error instanceof Error ? error.message : error}`)
        })
    }
  }
  // Chat roles live in every bridged guild (chatRoles may list roles from any
  // of them): resync when the bridged guild set changes.
  let knownBridgedGuilds = new Set<string>()
  const onBridgedGuildsChanged = (guildIds: string[]) => {
    const fresh = guildIds.filter((g) => !knownBridgedGuilds.has(g))
    knownBridgedGuilds = new Set(guildIds)
    void registerBridgeCommands(guildIds)
    if (!fresh.length) return
    void (async () => {
      const { syncChatRoles } = await import('./discord-chat-perms.js')
      await syncChatRoles(guildIds).catch((error) => {
        console.error(`[abulxt-discord] chat-role sync for new bridged guild(s) FAILED: ${error instanceof Error ? error.message : error}`)
      })
      const { emit, DISCORD_BRIDGE_OWNER_KEY } = await import('./events.js')
      await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.perms.changed', { guildId: null }).catch(() => {})
    })()
  }
  // Chat-relevant guilds: the home guild + every bridged guild.
  const chatGuild = (guildId: string) => guildId === d.guildId || bridgedGuildIds().includes(guildId)

  client.once('clientReady', async () => {
    if (!client.user) return
    console.log(`[abulxt-discord] logged in as ${client.user.tag}`)
    const invite =
      `https://discord.com/api/oauth2/authorize?client_id=${d.clientId}` +
      `&permissions=268435456&scope=bot%20applications.commands`

    const guild = await client.guilds.fetch(d.guildId!).catch(() => null)
    if (!guild) {
      console.error(`[abulxt-discord] FATAL: not a member of guild ${d.guildId}. Invite the bot:\n${invite}`)
      process.exit(1)
    }

    const me = await guild.members.fetch(client.user.id).catch(() => null)
    if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      console.error('[abulxt-discord] FATAL: bot lacks the Manage Roles permission.')
      process.exit(1)
    }

    const roleIds = d.roleIds || {}
    const managed = [...managedEntitlementRoles(roleIds), ...(roleIds.verified || []), roleIds.alt, roleIds.muted]
      .filter((r): r is string => Boolean(r))
    for (const roleId of managed) {
      const role = await guild.roles.fetch(roleId).catch(() => null)
      if (!role) {
        console.error(`[abulxt-discord] FATAL: configured role ${roleId} does not exist in the guild.`)
        process.exit(1)
      }
      if (me.roles.highest.comparePositionTo(role) <= 0) {
        console.error(`[abulxt-discord] FATAL: bot's highest role must be ABOVE "${role.name}" (${roleId}) to manage it.`)
        process.exit(1)
      }
    }

    for (const roleId of roleIds.verified || []) {
      const role = await guild.roles.fetch(roleId).catch(() => null)
      if (role) verifiedRoleNames.push(role.name)
    }

    // Sync configured chat roles (config.discord.chatRoles) into the chat-role
    // permission table so webhooks' view/send/timeout/ban/manage bits resolve.
    // Failures are loud: an unsynced table silently demotes every admin to
    // member in the site chatbox.
    const { syncChatRoles } = await import('./discord-chat-perms.js')
    const chatRolesConfigured = Object.values(d.chatRoles || {}).some((ids) => (ids || []).length > 0)
    const synced = await syncChatRoles().catch((error) => {
      console.error(`[abulxt-discord] chat-role sync FAILED: ${error instanceof Error ? error.message : error} - chat admins will resolve as members until this succeeds.`)
      return 0
    })
    if (synced) console.log(`[abulxt-discord] synced ${synced} chat role(s)`)
    else if (chatRolesConfigured) console.error('[abulxt-discord] chatRoles is configured but 0 roles synced - check the [chat-perms] error above; chat admins will resolve as members.')
    else console.warn('[abulxt-discord] discord.chatRoles is empty - all chat webhooks resolve to member/guest defaults.')

    console.log('[abulxt-discord] startup checks passed')

    await startBridge(client, { onGuildsChanged: onBridgedGuildsChanged })
  })

  client.on('guildMemberAdd', async (member) => {
    if (member.guild.id !== d.guildId) return
    await cancelDeletion(member.id).catch(() => {})
    const user = await userForDiscordId(member.id).catch(() => null)
    if (user) await syncDiscordRoles(user).catch(() => {})
  })

  client.on('guildMemberRemove', async (member) => {
    if (member.guild.id !== d.guildId) return

    await queueDeletion(member.id).catch(() => {})
  })

  // When a member's guild roles change (promote/demote) in the home guild or
  // any bridged guild, their chat tier there may have changed. Broadcast a
  // perms-changed event so connected chat clients re-resolve their
  // permissions (composer gating, badges, timeout).
  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    if (!chatGuild(newMember.guild.id)) return
    if (oldMember.roles.cache.equals(newMember.roles.cache)) return
    // This process's own member-role cache (bot author badges, /bridge).
    const { forgetCachedMemberRoles } = await import('./discord-roles.js')
    forgetCachedMemberRoles({ discordId: newMember.id })
    const { emit, DISCORD_BRIDGE_OWNER_KEY } = await import('./events.js')
    await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.perms.changed', { discordId: newMember.id, guildId: newMember.guild.id }).catch(() => {})
  })

  // When a role is edited/deleted in the home guild or a bridged guild,
  // re-sync the chat-role table and broadcast so clients pick up the new
  // bitfield / positions (e.g. Owners gained a bit).
  const resyncChatRoles = async (role: { guild: { id: string } }) => {
    if (!chatGuild(role.guild.id)) return
    const { syncChatRoles } = await import('./discord-chat-perms.js')
    await syncChatRoles(bridgedGuildIds()).catch((error) => {
      console.error(`[abulxt-discord] chat-role re-sync FAILED: ${error instanceof Error ? error.message : error}`)
      return 0
    })
    const { emit, DISCORD_BRIDGE_OWNER_KEY } = await import('./events.js')
    await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.perms.changed', { guildId: role.guild.id }).catch(() => {})
  }
  client.on('guildRoleUpdate', (_oldRole, newRole) => { void resyncChatRoles(newRole) })
  client.on('guildRoleDelete', (role) => { void resyncChatRoles(role) })

  client.on('threadCreate', async (thread) => {
    const message = await thread.fetchStarterMessage().catch(() => null)
    if (!message) return
    await message.react('👍').catch(() => {})
    await message.react('👎').catch(() => {})
  })

  client.on('interactionCreate', async (interaction) => {
    if (interaction.isAutocomplete()) {
      await commands.get(interaction.commandName)?.autocomplete?.(interaction).catch(() => {})
      return
    }
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      // Only `<command>:<action>` ids with a component handler;
      // collector-owned buttons (e.g. /deletionrequest confirm) are left alone.
      const name = interaction.customId.includes(':') ? interaction.customId.split(':')[0] : ''
      const command = name ? commands.get(name) : undefined
      if (!command?.component) return
      try {
        await command.component(interaction)
      } catch (error) {
        console.error(`[abulxt-discord] button ${interaction.customId} failed:`, error)
        const reply = { content: 'Something went wrong. Try again in a moment.', flags: [MessageFlags.Ephemeral] as const }
        if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {})
        else await interaction.reply(reply).catch(() => {})
      }
      return
    }
    if (!interaction.isChatInputCommand()) return
    const command = commands.get(interaction.commandName)
    if (!command) return
    try {
      await command.execute(interaction)
    } catch (error) {
      console.error(`[abulxt-discord] /${interaction.commandName} failed:`, error)
      const reply = { content: 'Something went wrong running that command.' }
      if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {})
      else await interaction.reply(reply).catch(() => {})
    }
  })

  await loginWithBackoff(client, d.botToken)

  const intervalMinutes = Number(d.reconcileIntervalMinutes) > 0 ? Number(d.reconcileIntervalMinutes) : 60
  const sweep = async () => {
    try {
      const { rows } = await query<DiscordUserRow>(
        'SELECT id, discord_id FROM users WHERE discord_id IS NOT NULL',
      )
      let synced = 0
      for (const user of rows) {
        const result = await syncDiscordRoles(user).catch(() => 'error' as const)
        if (result === 'synced') synced++
      }
      console.log(`[abulxt-discord] reconciliation sweep: ${synced}/${rows.length} linked members synced`)
    } catch (error) {
      console.error('[abulxt-discord] reconciliation sweep failed:', error instanceof Error ? error.message : error)
    }
  }
  setInterval(() => void sweep(), intervalMinutes * 60_000).unref()

  const { startDiscordHttpServer } = await import('./discord-http.js')
  startDiscordHttpServer(client)
}

void main()
