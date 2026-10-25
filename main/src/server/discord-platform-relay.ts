// The platform relay: holt keeps the bot's only gateway connection, and a platform with a hook (platforms.ts
// `hook`) runs its own Discord features through it. Two gateway sessions on one token would handle every event
// twice, so a platform never connects itself.
//
// - Commands: holt asks each hook what it serves (POST <hook>/commands -> { guild, global, components }) at
//   startup and every few minutes, and registers those commands next to its own (the caller's `register`).
// - Interactions: an interaction for one of those commands, or a button/select/modal whose custom id starts
//   with one of their names (`links:get`), or a component on a message one of them created (collector
//   buttons), is posted raw to <hook>/interaction and nothing else. The platform answers it itself through
//   Discord's interaction callback (its own copy of the bot token for REST; REST is not exclusive).
// - Member events: GUILD_MEMBER_ADD / GUILD_MEMBER_REMOVE in the home guild go to <hook>/event.
//
// Everything is signed with the hook secret (hook-signature.ts). A platform whose hook is down keeps its last
// known commands registered; its interactions get an ephemeral "unavailable" reply instead of Discord's
// generic failure.

import { Routes, type Client, type Interaction } from 'discord.js'
import type { Platform } from './platforms.ts'
import { postToHook } from './hook-signature.ts'

const REFRESH_MS = 5 * 60_000
const INTERACTION_TYPE = { COMMAND: 2, COMPONENT: 3, AUTOCOMPLETE: 4, MODAL: 5 } as const

interface Described {
  guild: Array<{ name: string }>
  global: Array<{ name: string }>
  components: string[]
}

interface RawInteraction {
  id: string
  token: string
  type: number
  guild_id?: string
  data?: { name?: string; custom_id?: string }
  message?: { interaction_metadata?: { name?: string }; interaction?: { name?: string } }
}

export interface PlatformRelay {
  /** Resolves after the first command refresh (the bridge starts after it). */
  ready(): Promise<void>
  /** Is this discord.js interaction a platform's (already relayed)? */
  owns(interaction: Interaction): boolean
}

function asDescribed(raw: unknown): Described | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const named = (list: unknown) => (Array.isArray(list) ? list.filter((c): c is { name: string } => typeof c === 'object' && c !== null && typeof (c as { name?: unknown }).name === 'string') : [])
  return {
    guild: named(r.guild),
    global: named(r.global),
    components: Array.isArray(r.components) ? r.components.filter((c): c is string => typeof c === 'string' && /^[a-z0-9_-]{1,32}$/.test(c)) : [],
  }
}

export function startPlatformRelay(opts: {
  client: Client
  platforms: readonly Platform[]
  homeGuildId: string
  register: (guild: unknown[], global: unknown[]) => Promise<void>
}): PlatformRelay {
  const hooked = opts.platforms.filter((p): p is Platform & { hook: NonNullable<Platform['hook']> } => p.hook !== null)
  const described = new Map<string, Described>()
  let owners = new Map<string, Platform & { hook: NonNullable<Platform['hook']> }>()
  let registered = ''

  const rebuild = () => {
    const next = new Map<string, Platform & { hook: NonNullable<Platform['hook']> }>()
    for (const platform of hooked) {
      const d = described.get(platform.id)
      if (!d) continue
      for (const name of [...d.guild.map((c) => c.name), ...d.global.map((c) => c.name), ...d.components]) {
        if (!next.has(name)) next.set(name, platform)
      }
    }
    owners = next
  }

  const refresh = async () => {
    for (const platform of hooked) {
      try {
        const d = asDescribed(await postToHook(platform.hook, '/commands', {}, 5000))
        if (d) described.set(platform.id, d)
      } catch (error) {
        // Keep the last description: a platform that is briefly down keeps its commands.
        console.warn(`[holt-discord] ${platform.id} hook: commands unavailable (${error instanceof Error ? error.message : error})`)
      }
    }
    rebuild()
    const guild = hooked.flatMap((p) => described.get(p.id)?.guild ?? [])
    const global = hooked.flatMap((p) => described.get(p.id)?.global ?? [])
    const signature = JSON.stringify([guild, global])
    if (signature === registered) return
    try {
      await opts.register(guild, global)
      registered = signature
    } catch (error) {
      console.error(`[holt-discord] command registration failed: ${error instanceof Error ? error.message : error}`)
    }
  }

  const nameOf = (data: { name?: string; customId?: string; messageCommand?: string }, componentLike: boolean): string | null => {
    if (!componentLike) return data.name ?? null
    const prefix = data.customId && data.customId.includes(':') ? data.customId.split(':')[0] : null
    if (prefix && owners.has(prefix)) return prefix
    return data.messageCommand ?? null
  }

  const ownerOfRaw = (d: RawInteraction) => {
    const componentLike = d.type === INTERACTION_TYPE.COMPONENT || d.type === INTERACTION_TYPE.MODAL
    if (!componentLike && d.type !== INTERACTION_TYPE.COMMAND && d.type !== INTERACTION_TYPE.AUTOCOMPLETE) return null
    const name = nameOf({
      name: d.data?.name,
      customId: d.data?.custom_id,
      messageCommand: d.message?.interaction_metadata?.name?.split(' ')[0] ?? d.message?.interaction?.name?.split(' ')[0],
    }, componentLike)
    return name ? owners.get(name) ?? null : null
  }

  const unavailable = async (d: RawInteraction) => {
    // Autocomplete takes choices, everything else a message. Ephemeral (flag 64).
    const body = d.type === INTERACTION_TYPE.AUTOCOMPLETE
      ? { type: 8, data: { choices: [] } }
      : { type: 4, data: { content: 'This is unavailable right now. Try again in a minute.', flags: 64 } }
    await opts.client.rest.post(Routes.interactionCallback(d.id, d.token), { body, auth: false }).catch(() => {})
  }

  opts.client.on('raw', (packet: { t?: string | null; d?: unknown }) => {
    if (packet.t === 'INTERACTION_CREATE') {
      const d = packet.d as RawInteraction
      const platform = ownerOfRaw(d)
      if (!platform) return
      void postToHook(platform.hook, '/interaction', { interaction: d }).catch((error) => {
        console.warn(`[holt-discord] ${platform.id} hook: interaction not delivered (${error instanceof Error ? error.message : error})`)
        void unavailable(d)
      })
      return
    }
    if (packet.t === 'GUILD_MEMBER_ADD' || packet.t === 'GUILD_MEMBER_REMOVE') {
      const d = packet.d as { guild_id?: string }
      if (d?.guild_id !== opts.homeGuildId) return
      for (const platform of hooked) {
        void postToHook(platform.hook, '/event', { t: packet.t, d }).catch((error) => {
          console.warn(`[holt-discord] ${platform.id} hook: ${packet.t} not delivered (${error instanceof Error ? error.message : error})`)
        })
      }
    }
  })

  const first = refresh()
  setInterval(() => { void refresh() }, REFRESH_MS).unref()

  return {
    ready: () => first,
    owns(interaction) {
      const componentLike = interaction.isMessageComponent() || interaction.isModalSubmit()
      const message = interaction.isMessageComponent() ? interaction.message : null
      const metadata = message?.interactionMetadata as { name?: string } | null | undefined
      const name = nameOf({
        name: interaction.isCommand() || interaction.isAutocomplete() ? interaction.commandName : undefined,
        customId: componentLike ? (interaction as { customId: string }).customId : undefined,
        messageCommand: (metadata?.name ?? (message as { interaction?: { commandName?: string } } | null)?.interaction?.commandName)?.split(' ')[0],
      }, componentLike)
      return Boolean(name && owners.has(name))
    },
  }
}
