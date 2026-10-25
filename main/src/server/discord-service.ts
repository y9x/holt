// holt's Discord bot: the chat bridge (discord-bridge-bot.ts), /bridge, and the one gateway connection holt
// shares with its platforms. A platform's own Discord features (abulxt: verification, account roles, /links,
// /ai, deletion requests) are not holt's: holt relays their commands, buttons and home-guild member events to
// the platform's hook and registers the commands the platform describes (discord-platform-relay.ts).

import { Client, GatewayIntentBits, MessageFlags, Partials, REST, Routes } from 'discord.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.js'
import { configureDatabase, ensureSchema } from './db.js'
import { loadStructures } from './discord-commands/index.js'
import { isCommand, type Command } from './discord-commands/types.js'
import { bridgedGuildIds, startBridge } from './discord-bridge-bot.js'
import { loadConfig as loadHoltConfig } from './holt-config.ts'
import { startPlatformRelay } from './discord-platform-relay.ts'

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
        console.error(`[holt-discord] Discord session-start limit reached; next login attempt at ${new Date(Date.now() + waitMs).toISOString()}`)
        await new Promise((resolve) => setTimeout(resolve, waitMs))
        continue
      }
      if (/disallowed intents/i.test(message)) {
        console.error('[holt-discord] FATAL: enable the Server Members and Message Content privileged intents for this bot in the Discord developer portal.')
      }
      throw error
    }
  }
}

async function main() {
  const config = await loadConfig()
  const d = config.discord || {}
  if (!d.botToken || !d.guildId || !d.clientId) {
    console.log('[holt-discord] discord.botToken / clientId / guildId not set in config.js - exiting.')
    return
  }
  configureDatabase(config.db?.url)
  await ensureSchema()
  const holtConfig = await loadHoltConfig()

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers, // privileged - enable in the dev portal
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions, // messageReactionAdd/Remove for the bridge
      GatewayIntentBits.MessageContent, // privileged - enable in the dev portal
    ],
    // Forum posts: the default sweeper evicts archived threads from the cache
    // after 4 h, and without Partials.Channel a gateway event in an uncached
    // thread (a delete or reaction in an old post) is dropped. The bridge
    // resolves such a thread to its forum through discord_bridge_post.
    partials: [Partials.Channel],
  })

  const commandsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'discord-commands')
  const commands = await loadStructures<Command>(commandsDir, isCommand)
  const rest = new REST({ version: '10' }).setToken(d.botToken)
  const own = [...commands.values()]

  // Command registration: holt's own commands plus whatever each platform hook describes (home guild and
  // global). A PUT replaces a scope's whole set, so the relay calls this again whenever a platform's set changes.
  const registerHome = async (platformGuild: unknown[], platformGlobal: unknown[]) => {
    const guildBody = [...own.filter((c) => !c.global).map((c) => c.data.toJSON()), ...platformGuild]
    const globalBody = [...own.filter((c) => c.global).map((c) => c.data.toJSON()), ...platformGlobal]
    await rest.put(Routes.applicationGuildCommands(d.clientId!, d.guildId!), { body: guildBody })
    await rest.put(Routes.applicationCommands(d.clientId!), { body: globalBody })
    console.log(`[holt-discord] registered ${guildBody.length} guild and ${globalBody.length} global slash commands (${platformGuild.length + platformGlobal.length} relayed to platforms)`)
  }

  // /bridge is registered in every bridged guild (other guild commands stay
  // home-only; the home guild already has the full set above). A PUT replaces
  // that guild's command set, so a guild no longer bridged keeps /bridge
  // until the next restart (harmless: it only acts on bridged channels).
  const bridgeBody = own.filter((c) => !c.global && c.data.name === 'bridge').map((c) => c.data.toJSON())
  const bridgeRegistered = new Set<string>([d.guildId])
  const registerBridgeCommands = async (guildIds: string[]) => {
    for (const guildId of guildIds) {
      if (bridgeRegistered.has(guildId) || !bridgeBody.length) continue
      bridgeRegistered.add(guildId)
      await rest.put(Routes.applicationGuildCommands(d.clientId!, guildId), { body: bridgeBody })
        .then(() => console.log(`[holt-discord] registered /bridge in bridged guild ${guildId}`))
        .catch((error) => {
          bridgeRegistered.delete(guildId)
          console.error(`[holt-discord] /bridge registration in guild ${guildId} failed: ${error instanceof Error ? error.message : error}`)
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
        console.error(`[holt-discord] chat-role sync for new bridged guild(s) FAILED: ${error instanceof Error ? error.message : error}`)
      })
      const { emit, DISCORD_BRIDGE_OWNER_KEY } = await import('./events.js')
      await emit(DISCORD_BRIDGE_OWNER_KEY, 'bridge.perms.changed', { guildId: null }).catch(() => {})
    })()
  }
  // Chat-relevant guilds: the home guild + every bridged guild.
  const chatGuild = (guildId: string) => guildId === d.guildId || bridgedGuildIds().includes(guildId)

  // Platform relay: decides which interactions and member events belong to a platform, before discord.js
  // handles anything (holt's own handlers skip every name the relay owns).
  const relay = startPlatformRelay({ client, platforms: holtConfig.platforms, homeGuildId: d.guildId, register: registerHome })

  client.once('clientReady', async () => {
    if (!client.user) return
    console.log(`[holt-discord] logged in as ${client.user.tag}`)
    const guild = await client.guilds.fetch(d.guildId!).catch(() => null)
    if (!guild) {
      const invite = `https://discord.com/api/oauth2/authorize?client_id=${d.clientId}&permissions=268435456&scope=bot%20applications.commands`
      console.error(`[holt-discord] FATAL: not a member of guild ${d.guildId}. Invite the bot:\n${invite}`)
      process.exit(1)
    }

    // Sync configured chat roles (config.discord.chatRoles) into the chat-role
    // permission table so webhooks' view/send/timeout/ban/manage bits resolve.
    // Failures are loud: an unsynced table silently demotes every admin to
    // member in the site chatbox.
    const { syncChatRoles } = await import('./discord-chat-perms.js')
    const chatRolesConfigured = Object.values(d.chatRoles || {}).some((ids) => (ids || []).length > 0)
    const synced = await syncChatRoles().catch((error) => {
      console.error(`[holt-discord] chat-role sync FAILED: ${error instanceof Error ? error.message : error} - chat admins will resolve as members until this succeeds.`)
      return 0
    })
    if (synced) console.log(`[holt-discord] synced ${synced} chat role(s)`)
    else if (chatRolesConfigured) console.error('[holt-discord] chatRoles is configured but 0 roles synced - check the [chat-perms] error above; chat admins will resolve as members.')
    else console.warn('[holt-discord] discord.chatRoles is empty - all chat webhooks resolve to member/guest defaults.')

    console.log('[holt-discord] startup checks passed')
    await relay.ready()
    await startBridge(client, { onGuildsChanged: onBridgedGuildsChanged })
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
      console.error(`[holt-discord] chat-role re-sync FAILED: ${error instanceof Error ? error.message : error}`)
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
    // A platform's command or button: relayed to its hook already.
    if (relay.owns(interaction)) return
    if (interaction.isAutocomplete()) {
      await commands.get(interaction.commandName)?.autocomplete?.(interaction).catch(() => {})
      return
    }
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      // Only `<command>:<action>` ids with a component handler;
      // collector-owned buttons are left alone.
      const name = interaction.customId.includes(':') ? interaction.customId.split(':')[0] : ''
      const command = name ? commands.get(name) : undefined
      if (!command?.component) return
      try {
        await command.component(interaction)
      } catch (error) {
        console.error(`[holt-discord] button ${interaction.customId} failed:`, error)
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
      console.error(`[holt-discord] /${interaction.commandName} failed:`, error)
      const reply = { content: 'Something went wrong running that command.' }
      if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {})
      else await interaction.reply(reply).catch(() => {})
    }
  })

  await loginWithBackoff(client, d.botToken)
}

void main()
