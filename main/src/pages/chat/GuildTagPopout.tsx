import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { bridgeGuildTag, type BridgeGuildTagProfile } from '../../lib/bridge'
import { HolyText } from '../../components/common/HolyText'
import { popoutLayer } from './overlay'
import { usePopoutPosition } from './popout'
import { GuildTooltipBadge } from './GuildTooltip'
import { clanBadgeUrl } from './author-style'
import './guild-tag.css'

/* Discord's server-tag popout - the GuildProfile card a primary_guild chiplet
 * opens (web.js 534400 → 517905 Popout position "right" → 109026):
 *
 *   container_d3846c (300px, radius 16, shadow-border + shadow-high)
 *     loading  → spinnerContainer_d3846c + wandering cubes
 *     profile  → 42780 GuildProfileCard (container_dca174):
 *       banner_dca174 (120px): discovery splash (DISCOVERABLE + custom banner)
 *         or radial-gradient(brighten(c, 1.75) → c), c = brand color ?? icon
 *         dominant color ?? --guild-profile-banner-background-default
 *       avatarContainer_dca174 > 70px CLAN_ICON mask (rx .3) > 64px icon
 *       header__6e500: name (heading-md/semibold) + GuildBadge + server tag;
 *         "{n} Online" / "{n} Members" dots; "Est. {Mon YYYY}"
 *       body_dca174: description, games, traits (or emptyBody_dca174)
 *       buttonContainer_dca174: the CTA (Join / Go to Server / Apply…)
 *     50001    → 576055 "Private Server" card
 *     error    → "Unknown Server" + "Unable to load server profile" (retry)
 *
 * Bridge limits: data is whatever the bot token can read (see
 * server/discord-guild-tag.ts); sections without data are omitted, and the
 * CTA is only "Join" when a real invite URL exists (no dead buttons). */

const TTL_MS = 5 * 60_000
const cache = new Map<string, { at: number; data: BridgeGuildTagProfile }>()

type State = { status: 'loading' } | { status: 'ready'; data: BridgeGuildTagProfile } | { status: 'error' }

function useGuildTagProfile(channelId: string, guildId: string): [State, () => void] {
  const [state, setState] = useState<State>(() => {
    const hit = cache.get(guildId)
    return hit && Date.now() - hit.at < TTL_MS ? { status: 'ready', data: hit.data } : { status: 'loading' }
  })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const hit = cache.get(guildId)
    if (attempt === 0 && hit && Date.now() - hit.at < TTL_MS) return
    let live = true
    setState({ status: 'loading' })
    bridgeGuildTag(channelId, guildId)
      .then((data) => {
        cache.set(guildId, { at: Date.now(), data })
        if (live) setState({ status: 'ready', data })
      })
      .catch(() => { if (live) setState({ status: 'error' }) })
    return () => { live = false }
  }, [channelId, guildId, attempt])
  return [state, useCallback(() => setAttempt((n) => n + 1), [])]
}

// --- banner color (649640) -------------------------------------------------

// chroma.js brighten(): Lab L + 18 * amount, back to sRGB.
function brighten(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  const r = lin(n >> 16), g = lin((n >> 8) & 255), b = lin(n & 255)
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
  const Z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787037 * t + 4 / 29)
  const L = 116 * f(Y) - 16 + 18 * amount
  const A = 500 * (f(X) - f(Y))
  const B = 200 * (f(Y) - f(Z))
  const fy = (L + 16) / 116
  const fi = (t: number) => (t > 6 / 29 ? t ** 3 : 3 * (6 / 29) ** 2 * (t - 4 / 29))
  const x = 0.95047 * fi(fy + A / 500), y = fi(fy), z = 1.08883 * fi(fy - B / 200)
  const gam = (c: number) => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)))
  const R = gam(3.2404542 * x - 1.5371385 * y - 0.4985314 * z)
  const G = gam(-0.969266 * x + 1.8760108 * y + 0.041556 * z)
  const Bb = gam(0.0556434 * x - 0.2040259 * y + 1.0572252 * z)
  return `rgba(${R}, ${G}, ${Bb}, 1)`
}

function bannerGradient(color: string): string {
  return `radial-gradient(105.43% 127.05% at 50.1% 127.05%, ${brighten(color, 1.75)} 20.65%, ${color} 85.16%)`
}

// Default banner color: --guild-profile-banner-background-default
// (theme-midnight → neutral-100, #000).
const DEFAULT_BANNER = '#000000'

// Dominant icon color (Discord's palette hook on the 64px icon): the most
// populated 5-bit bucket of opaque, non-white pixels, averaged.
const dominantCache = new Map<string, string | null>()
function useDominantColor(src: string | null): string | null {
  const [color, setColor] = useState<string | null>(() => (src ? dominantCache.get(src) ?? null : null))
  useEffect(() => {
    if (!src) return
    if (dominantCache.has(src)) { setColor(dominantCache.get(src) ?? null); return }
    let live = true
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      let out: string | null = null
      try {
        const c = document.createElement('canvas')
        c.width = 32; c.height = 32
        const ctx = c.getContext('2d')
        if (ctx) {
          ctx.drawImage(img, 0, 0, 32, 32)
          const px = ctx.getImageData(0, 0, 32, 32).data
          const buckets = new Map<number, [number, number, number, number]>()
          for (let i = 0; i < px.length; i += 4) {
            const [r, g, b, a] = [px[i], px[i + 1], px[i + 2], px[i + 3]]
            if (a < 125 || (r > 250 && g > 250 && b > 250)) continue
            const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
            const e = buckets.get(k) ?? [0, 0, 0, 0]
            e[0] += r; e[1] += g; e[2] += b; e[3] += 1
            buckets.set(k, e)
          }
          let best: [number, number, number, number] | null = null
          for (const e of buckets.values()) if (!best || e[3] > best[3]) best = e
          if (best) out = `#${[best[0], best[1], best[2]].map((v) => Math.round(v / best![3]).toString(16).padStart(2, '0')).join('')}`
        }
      } catch { /* tainted canvas → default color */ }
      dominantCache.set(src, out)
      if (live) setColor(out)
    }
    img.onerror = () => { dominantCache.set(src, null) }
    img.src = src
    return () => { live = false }
  }, [src])
  return src ? color : null
}

// --- pieces ----------------------------------------------------------------

function guildAcronym(name: string): string {
  return name.replace(/'s /g, ' ').replace(/\w+/g, (w) => w[0]).replace(/\s/g, '')
}

function ClanIcon({ name, icon }: { name: string; icon: string | null }) {
  return (
    <div className="chat-gtAvatarContainer">
      <div className="chat-gtAvatarWrapper">
        {icon
          ? <img className="chat-gtIcon" src={icon} alt={name} />
          : <div className="chat-gtIcon chat-gtAcronym" role="img" aria-label={name}>{guildAcronym(name)}</div>}
      </div>
    </div>
  )
}

function Spinner() {
  return (
    <span className="chat-gtSpinner" role="img" aria-label="Loading">
      <span className="chat-gtSpinnerInner"><span className="chat-gtSpinnerItem" /><span className="chat-gtSpinnerItem" /></span>
    </span>
  )
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

// "Est. Mar 2021" - snowflake timestamp, toLocaleDateString year numeric /
// month short (module 107123).
function establishedLabel(guildId: string): string | null {
  try {
    const ms = Number((BigInt(guildId) >> 22n) + 1420070400000n)
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short' })
  } catch { return null }
}

function ProfileCard({ data, tag, badge }: { data: BridgeGuildTagProfile; tag: string; badge: string | null }) {
  const name = data.name || 'Unknown Server'
  const dominant = useDominantColor(data.banner || data.brandColor ? null : data.icon)
  const bannerStyle: CSSProperties = data.banner
    ? { background: `url(${data.banner}) center / cover` }
    : { background: bannerGradient(data.brandColor || dominant || DEFAULT_BANNER) }
  const established = establishedLabel(data.guildId)
  const shownTag = data.tag || tag
  const shownBadge = data.badge || badge
  const hasBody = data.description.length > 0 || data.games.length > 0 || data.traits.length > 0
  const games = data.games.slice(0, 5)
  return (
    <div className="chat-gtCard">
      <div className="chat-gtBanner" style={bannerStyle} />
      <ClanIcon name={name} icon={data.icon} />
      <div className="chat-gtHeader">
        <div className="chat-gtNameContainer">
          <h2 className="chat-gtGuildName" title={name}>{name}</h2>
          <span className="chat-gtGuildBadge"><GuildTooltipBadge guild={data} /></span>
          {shownTag && (
            <span className="chat-chipletInner chat-gtServerTag">
              <span className="chat-chipletText">
                {shownBadge && <img className="chat-chipletBadge" src={clanBadgeUrl(data.guildId, shownBadge, 14)} alt="" width={14} height={14} />}
                <span className="chat-hiddenVisually">Server Tag: {shownTag}</span>
                <span className="chat-chipletTagText" aria-hidden="true">{shownTag}</span>
              </span>
            </span>
          )}
        </div>
        {(data.onlineCount != null || data.memberCount != null) && (
          <div className="chat-gtMembers">
            {data.onlineCount != null && (
              <div className="chat-gtMemberCount">
                <div className="chat-gtDot chat-gtDotOnline" />
                <span className="chat-gtText">{formatCount(data.onlineCount)} Online</span>
              </div>
            )}
            {data.memberCount != null && (
              <div className="chat-gtMemberCount">
                <div className="chat-gtDot" />
                <span className="chat-gtText">{formatCount(data.memberCount)} {data.memberCount === 1 ? 'Member' : 'Members'}</span>
              </div>
            )}
          </div>
        )}
        {established && <div className="chat-gtEstablished"><span className="chat-gtText">Est. {established}</span></div>}
      </div>
      {hasBody ? (
        <div className="chat-gtBody">
          {data.description && <div className="chat-gtText">{data.description}</div>}
          {games.length > 0 && (
            <div className="chat-gtGames">
              {games.map((g) => (
                <div key={g.id} className="chat-gtGameIcon" title={g.name}>
                  {g.icon && <img className="chat-gtGameIconImage" src={g.icon} alt={g.name} />}
                </div>
              ))}
            </div>
          )}
          {data.traits.length > 0 && (
            <div className="chat-gtTraits">
              {data.traits.map((t, i) => (
                <div key={i} className="chat-gtTrait">
                  {t.emoji?.id && (
                    <img className="chat-gtTraitEmoji" alt={t.emoji.name || ''} src={`https://cdn.discordapp.com/emojis/${t.emoji.id}.${t.emoji.animated ? 'gif' : 'webp'}?size=32`} />
                  )}
                  {!t.emoji?.id && t.emoji?.name && <span className="chat-gtTraitEmoji chat-gtTraitEmojiText">{t.emoji.name}</span>}
                  <span className="chat-gtTraitLabel">{t.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : <div className="chat-gtEmptyBody" />}
      {data.inviteUrl && (
        <div className="chat-gtButtonContainer">
          <a
            className="manaButton manaActive manaSm chat-gtCta"
            href={data.inviteUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="manaButtonChildren">Join</span>
          </a>
        </div>
      )}
    </div>
  )
}

function PrivateCard() {
  return (
    <article className="chat-gtCard" aria-label="Private Server">
      <div className="chat-gtBanner" style={{ background: bannerGradient(DEFAULT_BANNER) }} />
      <ClanIcon name="?" icon={null} />
      <div className="chat-gtCardHeader"><h2 className="chat-gtHeadingLg"><HolyText text="Private Server" /></h2></div>
      <div className="chat-gtBody"><div className="chat-gtText"><HolyText text="The server has limited who can see this profile." /></div></div>
    </article>
  )
}

function ErrorCard({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="chat-gtCard">
      <div className="chat-gtBanner" style={{ background: bannerGradient(DEFAULT_BANNER) }} />
      <ClanIcon name="Unknown Server" icon={null} />
      <div className="chat-gtCardHeader">
        <h2 className="chat-gtHeadingLg"><HolyText text="Unknown Server" /></h2>
        <button type="button" className="chat-gtError" onClick={onRetry}>
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21 2a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 1 1 0-2h3.93A8 8 0 0 0 6.97 5.78a1 1 0 0 1-1.26-1.56A9.98 9.98 0 0 1 20 6V3a1 1 0 0 1 1-1ZM3 22a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H5.07a8 8 0 0 0 11.96 2.22 1 1 0 1 1 1.26 1.56A9.99 9.99 0 0 1 4 18v3a1 1 0 0 1-1 1Z" /></svg>
          <span>Unable to load server profile</span>
        </button>
      </div>
    </div>
  )
}

/** The popout itself, anchored to the clicked chiplet (Popout position
 *  "right", default align "top", spacing 8). Outside press / Escape close. */
export function GuildTagPopout({ anchor, channelId, guildId, tag, badge, onClose }: {
  anchor: Element
  channelId: string
  guildId: string
  tag: string
  badge: string | null
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [state, retry] = useGuildTagProfile(channelId, guildId)
  usePopoutPosition(ref, anchor, { position: 'right', align: 'top', spacing: 8 })
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const path = e.composedPath()
      if ((ref.current && path.includes(ref.current)) || path.includes(anchor)) return
      onCloseRef.current()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current() }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown, true); document.removeEventListener('keydown', onKey) }
  }, [anchor])
  const label = state.status === 'ready' ? (state.data.name || 'Private Server') : undefined
  return createPortal(
    <div ref={ref} className="chat-gtPopout" role="dialog" aria-label={label} onClick={(e) => e.stopPropagation()}>
      {state.status === 'loading' && <div className="chat-gtSpinnerContainer"><Spinner /></div>}
      {state.status === 'error' && <ErrorCard onRetry={retry} />}
      {state.status === 'ready' && (state.data.restricted ? <PrivateCard /> : <ProfileCard data={state.data} tag={tag} badge={badge} />)}
    </div>,
    popoutLayer(),
  )
}
