import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { backdropDismissProps } from './ContextMenu'
import { MUTE_DURATIONS, mutedUntilText, type NotifLevel, type useNotificationSettings } from './notifSettings'
import { DiscordSelect, type SelectOption } from './DiscordSelect'

/* Discord's server "Notification Settings" modal (web chunk 9c127d…, module
 * 585617, the legacy `eI` layout), reduced to the controls the bridge can
 * actually act on (all wired to notifSettings.ts):
 *   - Mute {server} switch (+ "Mute duration" select, "Muted until …");
 *   - Server Notification Settings radios: All Messages / Only @mentions /
 *     Nothing (disabled while muted);
 *   - Suppress @everyone and @here / Suppress All Role @mentions switches;
 *   - "Select a channel or category…" picker + the Notification Overrides
 *     table (Channel or Category | All | Mentions | Nothing | Mute, with a
 *     remove button per row).
 * Omitted (no bridge equivalent): Community Activity Alerts, Suppress
 * Highlights, Mute New Events, Mobile Push Notifications.
 * Shell = Discord's mana modal (size md: max-width 480px, header title,
 * scrolling body, full-width "Done" in the action bar). */

type NotifApi = ReturnType<typeof useNotificationSettings>

const MUTE_OPTIONS: SelectOption<number>[] = MUTE_DURATIONS.map((d) => ({ value: d.seconds, label: d.label }))

export interface NotifModalChannel { channelId: string; name: string; parentId?: string | null }
export interface NotifModalCategory { id: string; name: string }

function Switch({ checked, disabled, onChange, label, description }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode }) {
  return (
    <label className={`gnmSwitchRow${disabled ? ' disabled' : ''}`}>
      <span className="gnmSwitchText">
        <span className="gnmSwitchLabel">{label}</span>
        {description && <span className="gnmSwitchDesc">{description}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="gnmSwitch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
    </label>
  )
}

function Check({ checked, onChange, label, color }: { checked: boolean; onChange: () => void; label: string; color?: 'green' }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} aria-label={label} className={`gnmCheck${checked ? ' checked' : ''}${color === 'green' ? ' green' : ''}`} onClick={onChange}>
      {checked && <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.7 7.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4l3.3 3.29 7.3-7.3a1 1 0 0 1 1.4 0Z" /></svg>}
    </button>
  )
}

export function GuildNotificationsModal({ guildId, guildName, notif, channels, categories, onClose }: {
  guildId: string
  guildName: string
  notif: NotifApi
  channels: NotifModalChannel[]
  categories: NotifModalCategory[]
  onClose: () => void
}) {
  const [added, setAdded] = useState<string[]>([])
  const guildMute = notif.guildMute(guildId)
  const muted = Boolean(guildMute)
  const level = notif.guildLevel(guildId)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const nameOf = (id: string) => channels.find((c) => c.channelId === id)?.name ?? categories.find((c) => c.id === id)?.name ?? id
  const isCategory = (id: string) => categories.some((c) => c.id === id)
  const subtitle = (id: string) => {
    if (isCategory(id)) {
      const n = channels.filter((c) => c.parentId === id).length
      return `${n} ${n === 1 ? 'channel' : 'channels'}`
    }
    const parent = channels.find((c) => c.channelId === id)?.parentId
    const cat = parent ? categories.find((c) => c.id === parent) : null
    return cat ? `in ${cat.name}` : 'No Category'
  }
  // Discord's override order follows the channel list (categories first, then
  // their channels).
  const listOrder = useMemo(() => {
    const out: string[] = []
    for (const c of channels.filter((ch) => !ch.parentId)) out.push(c.channelId)
    for (const cat of categories) {
      out.push(cat.id)
      for (const c of channels.filter((ch) => ch.parentId === cat.id)) out.push(c.channelId)
    }
    return out
  }, [channels, categories])
  const overrideSet = new Set([...notif.overrideIds(), ...added])
  const rows = listOrder.filter((id) => overrideSet.has(id))
  const pickable = listOrder.filter((id) => !overrideSet.has(id) && (!isCategory(id) || channels.some((c) => c.parentId === id)))

  const rowLevel = (id: string): NotifLevel => notif.channelLevel(id) || (isCategory(id) ? level : notif.effectiveLevel(id, channels.find((c) => c.channelId === id)?.parentId, guildId))

  return (
    <div className="gnmBackdrop" role="presentation" {...backdropDismissProps(onClose)}>
      <div className="gnmModal" role="dialog" aria-modal="true" aria-label="Notification Settings">
        <header className="gnmHeader">
          <h2 className="gnmTitle">Notification Settings</h2>
          <button type="button" className="gnmClose" aria-label="Close" onClick={onClose}>
            <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z" /></svg>
          </button>
        </header>
        <div className="gnmBody">
          <section className="gnmSection">
            <Switch
              checked={muted}
              onChange={(v) => (v ? notif.muteGuild(guildId, -1) : notif.unmuteGuild(guildId))}
              label={<>Mute <strong>{guildName}</strong></>}
              description="Muting a server prevents unread indicators and notifications from appearing unless you are mentioned."
            />
            {muted && (
              <div className="gnmField">
                <div className="gnmFieldLabel">Mute duration</div>
                <DiscordSelect
                  className="gnmSelect"
                  aria-label="Mute duration"
                  options={MUTE_OPTIONS}
                  selected={[guildMute?.window ?? -1]}
                  onSelect={(seconds) => notif.muteGuild(guildId, seconds)}
                />
                {mutedUntilText(guildMute) && <div className="gnmFieldDesc">{mutedUntilText(guildMute)}</div>}
              </div>
            )}
          </section>
          <div className="gnmDivider" role="presentation" />
          <section className="gnmSection">
            <div className="gnmFieldLabel" id="gnm-level-label">Server Notification Settings</div>
            <div className="gnmRadioGroup" role="radiogroup" aria-labelledby="gnm-level-label">
              {([['all', <>All Messages</>], ['mentions', <>Only <strong>@mentions</strong></>], ['nothing', <>Nothing</>]] as Array<[NotifLevel, ReactNode]>).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={level === value}
                  disabled={muted}
                  className={`gnmRadio${level === value ? ' checked' : ''}`}
                  onClick={() => notif.setGuildLevel(guildId, value)}
                >
                  <svg className="gnmRadioMark" width="20" height="20" viewBox="0 0 40 40" aria-hidden="true">
                    <circle className="contextMenuRadioRing" cx="20" cy="20" r="19" />
                    {level === value && <circle className="contextMenuRadioDot" cx="20" cy="20" r="8" />}
                  </svg>
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </section>
          <div className="gnmDivider" role="presentation" />
          <section className="gnmSection gnmStack">
            <Switch checked={notif.suppressEveryone(guildId)} onChange={() => notif.toggleSuppressEveryone(guildId)} label={<>Suppress <strong>@everyone</strong> and <strong>@here</strong></>} />
            <div className="gnmDivider" role="presentation" />
            <Switch checked={notif.suppressRoles(guildId)} onChange={() => notif.toggleSuppressRoles(guildId)} label="Suppress All Role @mentions" />
          </section>
          <div className="gnmDivider" role="presentation" />
          <section className="gnmSection">
            <div className="gnmFieldLabel">Select a channel or category…</div>
            <div className="gnmFieldDesc gnmFieldDescTop">Add a channel to override its default notification settings</div>
            <DiscordSelect
              className="gnmSelect"
              aria-label="Select a channel or category…"
              placeholder="Select a channel or category…"
              options={pickable.map((id) => ({ value: id, label: isCategory(id) ? nameOf(id).toUpperCase() : `#${nameOf(id)}` }))}
              selected={[]}
              onSelect={(id) => {
                // Discord creates the override with the channel's resolved level.
                notif.setChannelLevel(id, rowLevel(id))
                setAdded((cur) => (cur.includes(id) ? cur : [...cur, id]))
              }}
            />
          </section>
          <div className="gnmTable" role="table" aria-label="Notification Overrides">
            <div className="gnmTableHead" role="row">
              <div className="gnmColName" role="columnheader">Channel or Category</div>
              <div className="gnmCol" role="columnheader">All</div>
              <div className="gnmCol" role="columnheader">Mentions</div>
              <div className="gnmCol" role="columnheader">Nothing</div>
              <div className="gnmCol" role="columnheader" title="Muting a server prevents unread indicators and notifications from appearing unless you are mentioned.">Mute</div>
              <div className="gnmColRemove" role="presentation" />
            </div>
            {rows.length === 0 ? (
              <div className="gnmTableEmpty" role="row"><div role="cell">Add a channel to override its default notification settings</div></div>
            ) : rows.map((id) => {
              const lvl = rowLevel(id)
              const rowMuted = notif.isChannelMuted(id)
              return (
                <div key={id} className="gnmRow" role="row">
                  <div className="gnmColName" role="cell">
                    <div className="gnmRowName">{isCategory(id) ? nameOf(id) : `#${nameOf(id)}`}</div>
                    <div className="gnmRowSub">{subtitle(id)}</div>
                  </div>
                  {(['all', 'mentions', 'nothing'] as NotifLevel[]).map((value) => (
                    <div key={value} className="gnmCol" role="cell">
                      <Check checked={lvl === value} color="green" label={`${value === 'all' ? 'All messages' : value === 'mentions' ? 'Only @mentions' : 'Nothing'} for ${nameOf(id)}`} onChange={() => notif.setChannelLevel(id, value)} />
                    </div>
                  ))}
                  <div className="gnmCol" role="cell">
                    <Check checked={rowMuted} color="green" label={`Mute ${nameOf(id)}`} onChange={() => (rowMuted ? notif.unmuteChannel(id) : notif.muteChannel(id, -1))} />
                  </div>
                  <div className="gnmColRemove" role="cell">
                    <button
                      type="button"
                      className="gnmRemove"
                      aria-label={`Remove notification override for ${nameOf(id)}`}
                      onClick={() => { notif.clearOverride(id); setAdded((cur) => cur.filter((x) => x !== id)) }}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z" /></svg>
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        <footer className="gnmFooter">
          <button type="button" className="gnmDone" onClick={onClose}>Done</button>
        </footer>
      </div>
    </div>
  )
}
