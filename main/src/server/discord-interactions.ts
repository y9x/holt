// Discord application-command metadata + message components, normalized for
// the site chatbox. Shared by the gateway mapper (discord-bridge-bot.ts), the
// live REST mapper (discord-channel-access.ts) and the pins route so every
// path hands the client the same shape:
//
// - messageType: Discord message type (0 default, 19 reply, 20 CHAT_INPUT_COMMAND,
//   23 CONTEXT_MENU_COMMAND). Drives the "{user} used /cmd" header.
// - interaction: who ran which command (interaction_metadata, falling back to
//   the deprecated `interaction` object, which is the only one carrying the
//   full "cmd sub group" name path).
// - components: the raw API component tree (V1 action rows + V2 layout),
//   sanitized and with attachment:// media resolved to real CDN urls.
// - flags: message flags (IS_COMPONENTS_V2, LOADING "is thinking...",
//   SUPPRESS_EMBEDS).

export const MessageFlag = {
  SUPPRESS_EMBEDS: 1 << 2,
  EPHEMERAL: 1 << 6,
  LOADING: 1 << 7,
  IS_COMPONENTS_V2: 1 << 15,
} as const

export interface BridgeInteraction {
  // Interaction type: 2 APPLICATION_COMMAND, 3 MESSAGE_COMPONENT, 5 MODAL_SUBMIT.
  type: number
  // 1 CHAT_INPUT (slash), 2 USER, 3 MESSAGE (context menu). Derived from the
  // message type when Discord doesn't send command_type.
  commandType: number | null
  // Full command path for slash commands ("bridge ban"), display name for
  // context-menu commands ("Translate"). null when Discord didn't send one.
  name: string | null
  userId: string
  userName: string
  userAvatar: string | null
  userColor: string | null
}

const discordCdn = 'https://cdn.discordapp.com'

export interface RawInteractionUser {
  id: string
  username?: string
  global_name?: string | null
  avatar?: string | null
  discriminator?: string
}

export interface RawInteractionFields {
  type?: number
  interaction_metadata?: {
    id?: string
    type?: number
    name?: string
    command_type?: number
    user?: RawInteractionUser
  } | null
  interaction?: { id?: string; type?: number; name?: string; user?: RawInteractionUser } | null
}

export function userAvatarUrl(user: RawInteractionUser): string {
  if (user.avatar) {
    const ext = user.avatar.startsWith('a_') ? 'gif' : 'webp'
    return `${discordCdn}/avatars/${user.id}/${user.avatar}.${ext}?size=64`
  }
  let index = 0
  try { index = Number((BigInt(user.id) >> 22n) % 6n) } catch { index = 0 }
  return `${discordCdn}/embed/avatars/${index}.png`
}

export interface InteractionUserResolver {
  displayName?: (userId: string) => string | null | undefined
  avatar?: (userId: string) => string | null | undefined
  color?: (userId: string) => string | null | undefined
}

// Build the normalized interaction from raw API fields. Only command
// messages (types 20/23) and component/modal responses that carry metadata
// get one; ordinary messages return null.
export function interactionFromRaw(raw: RawInteractionFields, resolve: InteractionUserResolver = {}): BridgeInteraction | null {
  const meta = raw.interaction_metadata || null
  const legacy = raw.interaction || null
  const user = meta?.user || legacy?.user
  if (!user || !user.id) return null
  const messageType = typeof raw.type === 'number' ? raw.type : 0
  const commandType = typeof meta?.command_type === 'number'
    ? meta.command_type
    : messageType === 20 ? 1 : null
  const name = (typeof meta?.name === 'string' && meta.name) || (typeof legacy?.name === 'string' && legacy.name) || null
  return {
    type: typeof meta?.type === 'number' ? meta.type : typeof legacy?.type === 'number' ? legacy.type : 2,
    commandType,
    name,
    userId: user.id,
    userName: resolve.displayName?.(user.id) || user.global_name || user.username || 'Unknown User',
    userAvatar: resolve.avatar?.(user.id) || userAvatarUrl(user),
    userColor: resolve.color?.(user.id) || null,
  }
}

// --- Components ----------------------------------------------------------------

const MAX_COMPONENT_DEPTH = 4
const MAX_COMPONENT_NODES = 120

interface RawAttachmentLike { url?: string; name?: string; filename?: string; contentType?: string | null; content_type?: string | null; width?: number | null; height?: number | null; size?: number | null }

function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return /^(https?:\/\/|attachment:\/\/)/i.test(value) ? value : null
}

// Keep only the fields the client renders; drop anything else (custom_id
// payloads etc. are harmless but useless to the web client).
function cleanEmoji(e: unknown): Record<string, unknown> | null {
  if (!e || typeof e !== 'object') return null
  const emoji = e as { id?: unknown; name?: unknown; animated?: unknown }
  const id = typeof emoji.id === 'string' && /^\d+$/.test(emoji.id) ? emoji.id : null
  const name = typeof emoji.name === 'string' ? emoji.name.slice(0, 64) : null
  if (!id && !name) return null
  return { id, name, animated: emoji.animated === true }
}

function cleanMedia(m: unknown, attachments: RawAttachmentLike[], used: Set<string>): Record<string, unknown> | null {
  if (!m || typeof m !== 'object') return null
  const media = m as { url?: unknown; proxy_url?: unknown; width?: unknown; height?: unknown; content_type?: unknown; attachment_id?: unknown }
  let url = safeUrl(media.url)
  let contentType = typeof media.content_type === 'string' ? media.content_type : null
  let width = typeof media.width === 'number' ? media.width : null
  let height = typeof media.height === 'number' ? media.height : null
  let name: string | null = null
  let size: number | null = null
  if (url && url.toLowerCase().startsWith('attachment://')) {
    const file = url.slice('attachment://'.length)
    const match = attachments.find((a) => (a.name || a.filename) === file)
    if (match?.url) {
      used.add(match.url)
      url = match.url
      contentType = contentType || match.contentType || match.content_type || null
      width = width ?? match.width ?? null
      height = height ?? match.height ?? null
      size = typeof match.size === 'number' ? match.size : null
    } else {
      url = safeUrl(media.proxy_url)
    }
    name = file
  }
  if (!url) return null
  return { url, contentType, width, height, name, size }
}

function cleanComponent(c: unknown, depth: number, budget: { n: number }, attachments: RawAttachmentLike[], used: Set<string>): Record<string, unknown> | null {
  if (!c || typeof c !== 'object' || depth > MAX_COMPONENT_DEPTH || budget.n >= MAX_COMPONENT_NODES) return null
  budget.n += 1
  const src = c as Record<string, unknown>
  const type = typeof src.type === 'number' ? src.type : 0
  const str = (v: unknown, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : null)
  const children = (list: unknown) => (Array.isArray(list) ? list : [])
    .map((child) => cleanComponent(child, depth + 1, budget, attachments, used))
    .filter((child): child is Record<string, unknown> => child !== null)
  switch (type) {
    case 1: // action row
      return { type, components: children(src.components) }
    case 2: // button
      return {
        type,
        style: typeof src.style === 'number' ? src.style : 2,
        label: str(src.label, 80),
        emoji: cleanEmoji(src.emoji),
        url: src.style === 5 ? safeUrl(src.url) : null,
        disabled: src.disabled === true,
        skuId: str(src.sku_id, 32),
      }
    case 3: case 5: case 6: case 7: case 8: { // selects
      const options = Array.isArray(src.options) ? src.options.slice(0, 25).map((o) => {
        const opt = (o || {}) as Record<string, unknown>
        return { label: str(opt.label, 100) || '', description: str(opt.description, 100), emoji: cleanEmoji(opt.emoji), default: opt.default === true }
      }) : []
      return {
        type,
        placeholder: str(src.placeholder, 150),
        minValues: typeof src.min_values === 'number' ? src.min_values : 1,
        maxValues: typeof src.max_values === 'number' ? src.max_values : 1,
        disabled: src.disabled === true,
        options,
        defaultCount: Array.isArray(src.default_values) ? src.default_values.length : 0,
      }
    }
    case 9: // section
      return { type, components: children(src.components), accessory: cleanComponent(src.accessory, depth + 1, budget, attachments, used) }
    case 10: // text display
      return { type, content: str(src.content) || '' }
    case 11: // thumbnail
      return { type, media: cleanMedia(src.media, attachments, used), description: str(src.description, 1024), spoiler: src.spoiler === true }
    case 12: // media gallery
      return {
        type,
        items: (Array.isArray(src.items) ? src.items.slice(0, 10) : []).map((it) => {
          const item = (it || {}) as Record<string, unknown>
          return { media: cleanMedia(item.media, attachments, used), description: str(item.description, 1024), spoiler: item.spoiler === true }
        }).filter((it) => it.media),
      }
    case 13: // file
      return { type, file: cleanMedia(src.file, attachments, used), spoiler: src.spoiler === true, name: str(src.name, 256), size: typeof src.size === 'number' ? src.size : null }
    case 14: // separator
      return { type, divider: src.divider !== false, spacing: src.spacing === 2 ? 2 : 1 }
    case 17: { // container
      const accent = typeof src.accent_color === 'number' ? src.accent_color : null
      return { type, components: children(src.components), accentColor: accent, spoiler: src.spoiler === true }
    }
    default:
      return null
  }
}

// Normalize a raw API component tree. `attachments` resolves V2
// attachment:// media; the returned `usedAttachmentUrls` lets callers drop
// those attachments from the top-level list (Discord shows them only inside
// the components, never a second time as plain attachments).
export function componentsFromRaw(raw: unknown, attachments: RawAttachmentLike[] = []): { components: Array<Record<string, unknown>>; usedAttachmentUrls: Set<string> } {
  const used = new Set<string>()
  if (!Array.isArray(raw) || !raw.length) return { components: [], usedAttachmentUrls: used }
  const budget = { n: 0 }
  const components = raw
    .map((c) => cleanComponent(c, 0, budget, attachments, used))
    .filter((c): c is Record<string, unknown> => c !== null)
  return { components, usedAttachmentUrls: used }
}

export function flagsFromRaw(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
}
