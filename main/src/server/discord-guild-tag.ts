// Server-tag (primary_guild / clan) popout data for the chatbox - the guild
// card Discord opens when a server-tag chiplet is clicked (web.js 534400 →
// 517905 GuildProfilePopout → 109026 / 42780 GuildProfileCard).
//
// Discord's client reads GET /guilds/{id}/profile (name, description,
// icon_hash, custom_banner_hash, online/member counts, brand color, traits,
// games, tag/badge, features, visibility). That endpoint is not part of the
// documented bot API, so this resolver tries the sources a bot token CAN use,
// in order, and returns whatever was available:
//
//   1. GET /guilds/{id}/profile        (bot token; used if Discord allows it)
//   2. GET /guilds/{id}/preview        (bot token; discoverable guilds, or
//                                       guilds the bot is a member of)
//   3. GET /guilds/{id}?with_counts    (bot token; only guilds the bot is in -
//                                       adds vanity_url_code for a Join link)
//   4. GET /guilds/{id}/widget.json    (no auth; only when the widget is on -
//                                       name, presence count, instant_invite)
//
// Nothing resolved → `restricted: true` (the client renders Discord's
// "Private Server" card). Results - including misses - are cached per guild so
// popout clicks never fan out to Discord REST.

import { loadConfig } from './config.js'

const API = 'https://discord.com/api/v10'
const CDN = 'https://cdn.discordapp.com'
const CACHE_MS = 10 * 60_000
const MISS_CACHE_MS = 5 * 60_000

export interface GuildTagTrait { label: string; emoji: { id: string | null; name: string | null; animated: boolean } | null }
export interface GuildTagGame { id: string; name: string; icon: string | null; level: number; score: number }

export interface GuildTagProfile {
  guildId: string
  restricted: boolean
  name: string | null
  description: string
  icon: string | null
  /** Discovery splash as the card banner (Discord only uses custom_banner on
   *  DISCOVERABLE guilds); null → the client draws the color gradient. */
  banner: string | null
  brandColor: string | null
  onlineCount: number | null
  memberCount: number | null
  traits: GuildTagTrait[]
  games: GuildTagGame[]
  tag: string | null
  badge: string | null
  features: string[]
  premiumTier: number
  premiumSubscriptionCount: number
  /** A real invite link (vanity or widget instant invite), else null. */
  inviteUrl: string | null
}

const cache = new Map<string, { expires: number; body: GuildTagProfile }>()
const inflight = new Map<string, Promise<GuildTagProfile>>()

async function getJson<T>(path: string, token: string | null): Promise<T | null> {
  const resp = await fetch(`${API}${path}`, {
    headers: token ? { Authorization: `Bot ${token}` } : {},
    signal: AbortSignal.timeout(6000),
  }).catch(() => null)
  if (!resp || !resp.ok) return null
  return (await resp.json().catch(() => null)) as T | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const iconUrl = (id: string, hash: string | null) =>
  hash ? `${CDN}/icons/${id}/${hash}.${hash.startsWith('a_') ? 'gif' : 'webp'}?size=128` : null

type Raw = Record<string, unknown>

async function resolve(guildId: string): Promise<GuildTagProfile> {
  const token = (await loadConfig()).discord?.botToken || null
  const out: GuildTagProfile = {
    guildId, restricted: true, name: null, description: '', icon: null, banner: null, brandColor: null,
    onlineCount: null, memberCount: null, traits: [], games: [], tag: null, badge: null, features: [], premiumTier: 0, premiumSubscriptionCount: 0, inviteUrl: null,
  }

  const profile = token ? await getJson<Raw>(`/guilds/${guildId}/profile`, token) : null
  if (profile && str(profile.name)) {
    out.restricted = false
    out.name = str(profile.name)
    out.description = str(profile.description) ?? ''
    out.icon = iconUrl(guildId, str(profile.icon_hash))
    out.features = Array.isArray(profile.features) ? profile.features.filter((f): f is string => typeof f === 'string') : []
    const banner = str(profile.custom_banner_hash)
    if (banner && out.features.includes('DISCOVERABLE')) out.banner = `${CDN}/discovery-splashes/${guildId}/${banner}.jpg?size=600`
    out.brandColor = str(profile.brand_color_primary)
    out.onlineCount = num(profile.online_count)
    out.memberCount = num(profile.member_count)
    out.premiumTier = num(profile.premium_tier) ?? 0
    out.premiumSubscriptionCount = num(profile.premium_subscription_count) ?? 0
    out.tag = str(profile.tag)
    out.badge = str(profile.badge_hash) ?? str(profile.badge)
    // Traits: five slots by position (Discord drops empty labels).
    const traits = Array.isArray(profile.traits) ? (profile.traits as Raw[]) : []
    out.traits = traits
      .filter((t) => typeof t.position === 'number' && t.position >= 0 && t.position < 5 && str(t.label))
      .sort((a, b) => (a.position as number) - (b.position as number))
      .map((t) => ({
        label: t.label as string,
        emoji: str(t.emoji_id) || str(t.emoji_name)
          ? { id: str(t.emoji_id), name: str(t.emoji_name), animated: t.emoji_animated === true }
          : null,
      }))
    const activity = (profile.game_activity && typeof profile.game_activity === 'object' ? profile.game_activity : {}) as Record<string, Raw>
    const games = Array.isArray(profile.games) ? (profile.games as Raw[]) : []
    out.games = games
      .filter((g) => str(g.id) && str(g.name))
      .map((g) => ({
        id: g.id as string,
        name: g.name as string,
        icon: str(g.icon) ? `${CDN}/app-icons/${g.id}/${g.icon}.webp?size=48` : null,
        level: num(activity[g.id as string]?.activity_level) ?? 0,
        score: num(activity[g.id as string]?.activity_score) ?? 0,
      }))
      .filter((g) => g.icon)
      .sort((a, b) => b.score - a.score)
  }

  if (out.restricted && token) {
    const preview = await getJson<Raw>(`/guilds/${guildId}/preview`, token)
    if (preview && str(preview.name)) {
      out.restricted = false
      out.name = str(preview.name)
      out.description = str(preview.description) ?? ''
      out.icon = iconUrl(guildId, str(preview.icon))
      out.features = Array.isArray(preview.features) ? preview.features.filter((f): f is string => typeof f === 'string') : []
      const splash = str(preview.discovery_splash)
      if (splash && out.features.includes('DISCOVERABLE')) out.banner = `${CDN}/discovery-splashes/${guildId}/${splash}.jpg?size=600`
      out.onlineCount = num(preview.approximate_presence_count)
      out.memberCount = num(preview.approximate_member_count)
    }
  }

  // Member guild: the vanity URL is the only invite a bot can read without
  // MANAGE_GUILD (and creating invites would be a side effect).
  if (token && !out.inviteUrl) {
    const guild = await getJson<Raw>(`/guilds/${guildId}?with_counts=true`, token)
    if (guild && str(guild.name)) {
      if (out.restricted) {
        out.restricted = false
        out.name = str(guild.name)
        out.description = str(guild.description) ?? ''
        out.icon = iconUrl(guildId, str(guild.icon))
        out.features = Array.isArray(guild.features) ? guild.features.filter((f): f is string => typeof f === 'string') : []
        out.onlineCount = num(guild.approximate_presence_count)
        out.memberCount = num(guild.approximate_member_count)
        out.premiumTier = num(guild.premium_tier) ?? 0
        out.premiumSubscriptionCount = num(guild.premium_subscription_count) ?? 0
      }
      const vanity = str(guild.vanity_url_code)
      if (vanity) out.inviteUrl = `https://discord.gg/${encodeURIComponent(vanity)}`
    }
  }

  if (!out.inviteUrl || out.restricted) {
    const widget = await getJson<Raw>(`/guilds/${guildId}/widget.json`, null)
    if (widget && str(widget.name)) {
      if (out.restricted) {
        out.restricted = false
        out.name = str(widget.name)
        out.onlineCount = num(widget.presence_count)
      }
      const invite = str(widget.instant_invite)
      if (invite && /^https:\/\/(discord\.com\/invite|discord\.gg)\//.test(invite)) out.inviteUrl = invite
    }
  }
  return out
}

/** Cached + de-duplicated guild-tag card data for `guildId`. */
export async function guildTagProfile(guildId: string): Promise<GuildTagProfile> {
  const hit = cache.get(guildId)
  if (hit && hit.expires > Date.now()) return hit.body
  const pending = inflight.get(guildId)
  if (pending) return pending
  const p = resolve(guildId)
    .then((body) => {
      cache.set(guildId, { expires: Date.now() + (body.restricted ? MISS_CACHE_MS : CACHE_MS), body })
      if (cache.size > 500) cache.delete(cache.keys().next().value as string)
      return body
    })
    .finally(() => inflight.delete(guildId))
  inflight.set(guildId, p)
  return p
}
