// Discord attachment normalization shared by the gateway bot
// (discord-bridge-bot.ts, discord.js Attachment objects) and the live REST
// mapper (discord-channel-access.ts, raw API JSON). Both produce the SAME
// persisted shape (discord_bridge_message.attachments JSONB) so the web
// client's attachment renderer (pages/chat/Embeds.tsx) sees one format no
// matter where a message came from.
//
// Field names stay camelCase for backwards compatibility with rows written
// before this module existed ({ url, name, contentType, width, height }) and
// with the search filters in discord-bridge-db.ts (`@.contentType`). Embeds,
// by contrast, are persisted in Discord's raw API shape (snake_case - exactly
// what Embed#toJSON() / the REST payload carry), which is what the client's
// embed normalizer expects.

import type { Attachment } from 'discord.js'

// Discord attachment flags (https://discord.com/developers/docs/resources/message#attachment-object-attachment-flags).
export const ATTACHMENT_FLAG_IS_CLIP = 1 << 0
export const ATTACHMENT_FLAG_IS_THUMBNAIL = 1 << 1
export const ATTACHMENT_FLAG_IS_REMIX = 1 << 2
export const ATTACHMENT_FLAG_IS_SPOILER = 1 << 3
export const ATTACHMENT_FLAG_IS_ANIMATED = 1 << 5

export interface BridgeAttachment {
  id: string | null
  url: string
  // media.discordapp.net proxy URL - what Discord's own client loads media
  // from (resizable via ?width=&height=, format=webp for stills).
  proxyUrl: string | null
  name: string
  title: string | null
  // Alt text (Discord stores it as `description`).
  description: string | null
  contentType: string | null
  size: number
  width: number | null
  height: number | null
  // Voice messages / audio: duration + base64 waveform.
  durationSecs: number | null
  waveform: string | null
  flags: number
  spoiler: boolean
  isRemix: boolean
  ephemeral: boolean
}

// Raw REST attachment object (subset we read).
export interface RawApiAttachment {
  id: string
  url: string
  proxy_url?: string
  filename?: string
  title?: string
  description?: string
  content_type?: string
  size?: number
  width?: number | null
  height?: number | null
  duration_secs?: number
  waveform?: string
  flags?: number
  ephemeral?: boolean
}

// Only http(s) URLs are ever persisted for media - a hostile payload can't
// smuggle javascript:/data: into an <a href>/<img src> through the bridge.
function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null
  } catch {
    return null
  }
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

export function attachmentFromApi(a: RawApiAttachment): BridgeAttachment | null {
  const url = httpUrl(a.url)
  if (!url) return null
  const name = a.filename || 'attachment'
  const flags = typeof a.flags === 'number' ? a.flags : 0
  return {
    id: a.id || null,
    url,
    proxyUrl: httpUrl(a.proxy_url),
    name,
    title: a.title || null,
    description: a.description || null,
    contentType: a.content_type || null,
    size: typeof a.size === 'number' ? a.size : 0,
    width: positive(a.width),
    height: positive(a.height),
    durationSecs: positive(a.duration_secs),
    waveform: typeof a.waveform === 'string' ? a.waveform : null,
    flags,
    // Discord marks spoilers both ways: the SPOILER_ filename prefix (what
    // clients upload) and the IS_SPOILER flag.
    spoiler: name.startsWith('SPOILER_') || (flags & ATTACHMENT_FLAG_IS_SPOILER) !== 0,
    isRemix: (flags & ATTACHMENT_FLAG_IS_REMIX) !== 0,
    ephemeral: a.ephemeral === true,
  }
}

// discord.js Attachment → the raw REST shape, so both paths share one mapper.
export function rawFromDjsAttachment(a: Attachment): RawApiAttachment {
  return {
    id: a.id,
    url: a.url,
    proxy_url: a.proxyURL,
    filename: a.name,
    title: a.title ?? undefined,
    description: a.description ?? undefined,
    content_type: a.contentType ?? undefined,
    size: a.size,
    width: a.width,
    height: a.height,
    duration_secs: a.duration ?? undefined,
    waveform: a.waveform ?? undefined,
    flags: a.flags?.bitfield ?? 0,
    ephemeral: a.ephemeral,
  }
}

export function attachmentFromDjs(a: Attachment): BridgeAttachment | null {
  return attachmentFromApi(rawFromDjsAttachment(a))
}

export function attachmentsFromApi(list: RawApiAttachment[] | undefined | null): BridgeAttachment[] {
  return (list || []).map(attachmentFromApi).filter((a): a is BridgeAttachment => a !== null)
}
