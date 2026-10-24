import type { BridgeGuild } from '../../lib/bridge'

// Discord's guild acronym (the icon-less rail tile): `name.replace(/'s /g,' ')
// .replace(/\w+/g, w => w[0]).replace(/\s/g, '')` - case kept, no length cap.
export function guildAcronym(name: string | null | undefined): string {
  return (name || '').replace(/'s /g, ' ').replace(/\w+/g, (w) => w[0]).replace(/\s/g, '')
}

// Acronym font size shrinks with length (Discord's LARGE size table; live
// renders a 2-letter rail acronym at 18px).
const GUILD_ACRONYM_FONT_SIZES = [18, 18, 16, 16, 14, 12, 10]
export function guildAcronymFontSize(acronym: string): number {
  return GUILD_ACRONYM_FONT_SIZES[Math.min(Math.max(acronym.length - 1, 0), GUILD_ACRONYM_FONT_SIZES.length - 1)]
}

// The rail icon body: Discord's wrapper__6e9f8 inside the BlobMask squircle.
// An image icon is just the masked img (no tile bg - a bg behind it bled
// through the anti-aliased edge as a ring); an icon-less guild is
// childWrapper + acronym on --background-mod-subtle. The guild name is data
// shown elsewhere (tooltip, aria-label), so the acronym stays plain.
// `mini` is a folder-grid cell: its acronym size comes from CSS, not the table.
export function GuildIconBody({ guild, className = 'guild-icon', mini = false }: { guild: Pick<BridgeGuild, 'name' | 'icon'>; className?: string; mini?: boolean }) {
  if (guild.icon) {
    return <span className={className} aria-hidden="true"><img src={guild.icon} alt="" loading="lazy" draggable={false} /></span>
  }
  const acronym = guildAcronym(guild.name)
  return (
    <span className={`${className} ${mini ? 'guild-mini-acronym' : 'guild-acronym'}`} aria-hidden="true" style={mini ? undefined : { fontSize: guildAcronymFontSize(acronym) }}>
      {acronym}
    </span>
  )
}
