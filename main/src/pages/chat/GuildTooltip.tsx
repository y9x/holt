import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { BridgeGuild } from '../../lib/bridge'
import { HolyText } from '../../components/common/HolyText'

/* Discord's guild-hover tooltip, copied 1:1 from the live client DOM
 * (L-dom.html) and the GuildTooltip component in the web bundle:
 *   .tooltip_fa450d[data-position=right]  (bg surface-high, radius-sm,
 *       box-shadow inset 0 0 0 1px border-subtle + shadow-high, padding 8/12)
 *     .caret__0b5f9.caret--left.caret--center  (SVG caret pointing LEFT)
 *     .tooltipContent_fa450d
 *       .text-md/semibold.guildTooltipWrapper_b1f768  (color --text-default)
 *         .row_b1f768.rowGuildName_b1f768
 *           .flowerStarContainer.rowIconV2.rowIcon (18px GuildBadge V2 - only
 *             for Community/Discoverable/Verified/Partnered guilds)
 *           .guildNameText.guildNameTextLimitedSize → name
 *         .text-xs/normal.muteText_b1f768 (--text-muted) → "Muted"
 * GuildBadge V2 colours (module 107773): a boosted guild (boost count > 0 or
 * premium tier > 0) gets the PREMIUM_GUILD_BADGE_V2_BACKGROUND flower
 * (rotate(45) linear gradient premium-tier-2 purple → pink) with a white
 * glyph - Discord's "server boost" look. An unboosted guild gets a white
 * flower with a --primary-500 glyph (dark theme). Community → HomeIcon,
 * Community + Discoverable (PUBLIC) → GlobeEarthIcon; glyph size is
 * floor(.75 * 18) - 2 = 11px. The caret is an SVG with a fill path and a
 * stroked outline path, NOT a CSS triangle. */

const FLOWER_STAR_PATH = 'M5.52995 0.431867C6.27995 0.181867 7.2 1.23199 8 1.23199C8.8 1.23199 9.75007 0.231867 10.4701 0.431867C11.19 0.631965 11.38 2.07173 12 2.52171C12.62 2.9717 14.0003 2.70184 14.4603 3.32184C14.9199 3.94191 14.2303 5.16178 14.4603 5.91169C14.6903 6.66159 15.9998 7.21166 16 8.00153C16 8.79146 14.72 9.38146 14.4798 10.0914C14.2398 10.8014 14.9198 12.0919 14.4798 12.6819C14.0397 13.2716 12.6401 13.0321 12.0202 13.482C11.4002 13.932 11.2298 15.3219 10.4798 15.5719C9.72987 15.8216 8.80967 14.7717 8.00973 14.7717C7.2098 14.7719 6.25964 15.7718 5.53971 15.5719C4.81995 15.3716 4.61982 13.9321 4 13.482C3.38 13.032 1.99971 13.3019 1.53971 12.6819C1.07975 12.0619 1.76971 10.8414 1.53971 10.0914C1.30939 9.34159 0 8.79139 0 8.00153C0.000177681 7.21159 1.2802 6.62163 1.52018 5.91169C1.76012 5.20167 1.08021 3.91183 1.52018 3.32184C1.96018 2.73184 3.36999 3.0017 4 2.52171C4.62997 2.04173 4.78003 0.681954 5.52995 0.431867Z'
// HomeIcon (Community) and GlobeEarthIcon (Community + Discoverable), ripped
// from the live tooltip DOM.
const HOME_ICON_PATH = 'm2.4 8.4 8.38-6.46a2 2 0 0 1 2.44 0l8.39 6.45a2 2 0 0 1-.79 3.54l-.32.07-.82 8.2a2 2 0 0 1-1.99 1.8H16a1 1 0 0 1-1-1v-5a3 3 0 1 0-6 0v5a1 1 0 0 1-1 1H6.31a2 2 0 0 1-1.99-1.8L3.5 12l-.32-.07a2 2 0 0 1-.79-3.54Z'
const GLOBE_EARTH_ICON_PATH = 'M23 12a11 11 0 1 1-22 0 11 11 0 0 1 22 0Zm-4.16 5.85A9 9 0 0 0 15 3.52V4a3 3 0 0 1-3 3h-.77c-.13 0-.23.1-.23.23A2.77 2.77 0 0 1 8.23 10c-.13 0-.23.1-.23.23v1.52c0 .14.11.25.25.25H13a3 3 0 0 1 3 3v.77c0 .13.1.23.23.23 1.2 0 2.23.77 2.61 1.85ZM3.18 10.18A9 9 0 0 0 11 20.94v-2.7c0-.14-.1-.24-.23-.24h-.65A2.12 2.12 0 0 1 8 15.88c0-.56-.22-1.1-.62-1.5l-4.2-4.2Z'

/** Discord's GuildBadge V2 for the tooltip row, or null for guilds that get no
 *  badge (plain, non-Community servers). Verified/Partnered variants are not
 *  rendered - the bridged guild is neither. */
export function GuildTooltipBadge({ guild }: { guild: Pick<BridgeGuild, 'features' | 'premiumTier' | 'premiumSubscriptionCount'> }) {
  const gradId = `guildTipBadge-${useId().replace(/:/g, '')}`
  const features = new Set(guild.features || [])
  if (!features.has('COMMUNITY')) return null
  const discoverable = features.has('DISCOVERABLE')
  const premium = (guild.premiumSubscriptionCount || 0) > 0 || (guild.premiumTier || 0) > 0
  const label = 'Community Server'
  return (
    <div role="img" aria-label={label}>
      <div className="flowerStarContainer chat-guildTooltipRowIcon" style={{ width: 18, height: 18 }}>
        <svg className="flowerStar" aria-hidden="true" role="img" width="16" height="16" viewBox="0 0 16 16">
          {premium && (
            <defs>
              <linearGradient id={gradId} gradientTransform="rotate(45)">
                <stop offset="0" stopColor="var(--premium-tier-2-purple)" />
                <stop offset="1" stopColor="var(--premium-tier-2-pink)" />
              </linearGradient>
            </defs>
          )}
          <path fill={premium ? `url(#${gradId})` : 'var(--white)'} fillRule="evenodd" clipRule="evenodd" d={FLOWER_STAR_PATH} />
        </svg>
        <div className="childContainer">
          <svg aria-hidden="true" role="img" width="11" height="11" fill="none" viewBox="0 0 24 24">
            {discoverable
              ? <path fill={premium ? 'var(--white)' : 'var(--primary-500)'} fillRule="evenodd" clipRule="evenodd" d={GLOBE_EARTH_ICON_PATH} />
              : <path fill={premium ? 'var(--white)' : 'var(--primary-500)'} d={HOME_ICON_PATH} />}
          </svg>
        </div>
      </div>
    </div>
  )
}

export interface GuildTooltipProps {
  guild: BridgeGuild
  /** Center-Y of the guild icon, in .chat-page coordinates. */
  anchorY: number
  muted?: boolean
}

// The rail's hover bubble (layer + left caret + content box), shared by the
// guild and folder tooltips.
function RailTooltipShell({ anchorY, children }: { anchorY: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(anchorY)

  useLayoutEffect(() => {
    const el = ref.current
    const page = document.querySelector('.chat-page')
    if (!el || !page) return
    const h = el.offsetHeight
    const pageH = page.getBoundingClientRect().height
    setTop(Math.max(8, Math.min(anchorY - h / 2, pageH - h - 8)))
  }, [anchorY])

  return (
    <div className="chat-guildTooltipLayer" style={{ top }} ref={ref}>
      <div className="d-tooltipAlt chat-guildTooltip" role="tooltip" data-position="right">
        {/* Left-pointing SVG caret, centered on the bubble's left edge. */}
        <div className="chat-caret chat-caretLeft" aria-hidden="true">
          <svg width="16" height="10" viewBox="0 0 16 10" fill="none" className="chat-caretIcon">
            <path className="chat-caretFill" d="M10.3426 7.0715C9.14163 8.57272 6.85837 8.57272 5.65739 7.0715L0 -0.000244141L16 -0.000244141L10.3426 7.0715Z" />
            <mask id="chatTooltipCaretMask" maskUnits="userSpaceOnUse" x="0" y="-1" width="16" height="10" style={{ maskType: 'alpha' }}>
              <path d="M10.3426 7.0715C9.14163 8.57272 6.85837 8.57272 5.65739 7.0715L0 -0.000244141L16 -0.000244141L10.3426 7.0715Z" className="chat-caretFill" />
            </mask>
            <g mask="url(#chatTooltipCaretMask)">
              <path className="chat-caretStroke" d="M9.93457 6.84546C8.93433 8.06766 7.06567 8.06766 6.06543 6.84546L0.0546875 -0.500244L15.9453 -0.500244L9.93457 6.84546Z" />
            </g>
          </svg>
        </div>
        <div className="d-tooltipAltContent">
          <div className="d-guildTooltipWrapper chat-guildTooltipWrapper">{children}</div>
        </div>
      </div>
    </div>
  )
}

export function GuildTooltip({ guild, anchorY, muted }: GuildTooltipProps) {
  return (
    <RailTooltipShell anchorY={anchorY}>
      <div className="chat-guildTooltipRow chat-guildTooltipRowGuildName">
        <GuildTooltipBadge guild={guild} />
        <span className="chat-guildTooltipName">{guild.name}</span>
      </div>
      {muted && <div className="chat-guildTooltipMuted"><HolyText text="Muted" /></div>}
    </RailTooltipShell>
  )
}

/** Discord's folder tooltip: the folder name, else its servers' names joined
 *  (defaultFolderName), else "Server Folder". A name is user data, so it stays
 *  plain; only the static fallback is wrapped. */
export function FolderTooltip({ label, anchorY }: { label: string | null; anchorY: number }) {
  return (
    <RailTooltipShell anchorY={anchorY}>
      <div className="chat-guildTooltipRow chat-guildTooltipRowGuildName">
        {label ? <span className="chat-guildTooltipName">{label}</span> : <HolyText className="chat-guildTooltipName" text="Server Folder" />}
      </div>
    </RailTooltipShell>
  )
}
