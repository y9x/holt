// Discord's "Channels & Roles" (ChannelsAndRolesPage, web chunk 472165 module
// 807780) for the bridged guild:
//
//   - Sidebar: the guild-action row at the very top of the channel list
//     (144888 `n4` → 652793 row: li > containerDefault wrapper > link > icon +
//     text-md/medium name), labelled "Channels & Roles" when the guild has
//     onboarding prompts, else "Browse Channels", followed by the action
//     section's divider (sectionDivider__629e4). Right-click opens Discord's
//     guild-browse-channels-context-menu ("Show All Channels" checkbox).
//   - Page: the channel-header-styled title bar + the brand "top" TabBar
//     (Customize / Browse Channels; routes customize-community and
//     channel-browser), then
//       Customize - the onboarding prompts (Onboarding.tsx's option cards /
//         dropdown) as editable cards with Discord's "You received …" help
//         text, saved through the responses API;
//       Browse Channels - search + every viewable channel grouped by
//         category: Follow Category switches, per-channel follow checkboxes,
//         a hover "View" button. Channels that can't leave the list (bridged,
//         default, role-gated) render checked + disabled.
//
// Data comes from Onboarding.tsx's useBridgeOnboarding (GET /onboarding incl.
// `browse`), loaded once by chat.tsx for the open guild and shared with the
// onboarding gate; writes go through lib/bridge.ts (scoped to that guild) and
// then refetch the sidebar.

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { HolyInput } from '../../components/common/HolyAttr'
import {
  bridgeChannelOptIn,
  bridgeOnboardingResponses,
  bridgeShowAllChannels,
  type BridgeBrowseChannel,
  type BridgeCategory,
  type BridgeOnboarding,
  type BridgeOnboardingPrompt,
  type BridgeOnboardingState,
} from '../../lib/bridge'
import { OnboardingPromptOptions, type BridgeOnboardingHandle } from './Onboarding'
import { ChannelTypeIcon, channelIconKind } from './channelIcons'
import { HoverTooltip } from './author-style'
import type { MenuEntry } from './ContextMenu'
import nuxImage from './channel-browser-nux.svg'
import './channels-roles.css'

export type ChannelsAndRolesSection = 'customize' | 'browse'

// --- Strings (Discord en-US bundle) -------------------------------------------

const S = {
  channelsAndRoles: 'Channels & Roles', // h9mGOP
  browseChannels: 'Browse Channels', // et6wav
  customize: 'Customize', // H2cICW
  showAllChannels: 'Show All Channels', // FB2ZZV
  actions: 'Actions', // ogxXGq
  followCategory: 'Follow Category', // mSQwnW
  view: 'View', // vetGQs
  searchChannels: 'Search Channels', // s5MnmC
  unfollowCategoryFirst: 'You must unfollow this category to add or remove specific channels.', // Lz94y1
  defaultChannels: 'Default Channels that every member starts with.', // QQ3tBi
  questions: (n: number) => `${n} Customization Question${n === 1 ? '' : 's'}`, // 8IV8K9
  questionsSub: 'Answer questions to get access to more channels and roles.', // Ecz7T9
  emptyTitle: 'There are no customization options yet.', // leKHQz
  chooseAll: 'Choose all that apply.', // JshhEl
  nuxTitle: 'Choose Your Channels', // utqWEC
  nuxBody: 'Customize what\'s on your channel list, so you see just the stuff you care about.', // +9etcM
  nuxTip: ' Channels with mentions will always appear on your channel list, even if you hide them.', // Z0axjk
}

// --- Icons (Mana icon paths) ----------------------------------------------------

/** 740426 - the list-with-magnifier icon on the sidebar row and page header. */
export function ChannelsAndRolesIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} aria-hidden="true" role="img" xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill="none" viewBox="0 0 24 24">
      <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d="M18.5 23c.88 0 1.7-.25 2.4-.69l1.4 1.4a1 1 0 0 0 1.4-1.42l-1.39-1.4A4.5 4.5 0 1 0 18.5 23Zm0-2a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
      <path fill="currentColor" d="M3 3a1 1 0 0 0 0 2h18a1 1 0 1 0 0-2H3ZM2 8a1 1 0 0 1 1-1h18a1 1 0 1 1 0 2H3a1 1 0 0 1-1-1ZM3 11a1 1 0 1 0 0 2h11a1 1 0 1 0 0-2H3ZM2 16a1 1 0 0 1 1-1h8a1 1 0 1 1 0 2H3a1 1 0 0 1-1-1ZM3 19a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2H3Z" />
    </svg>
  )
}

function MagnifyingGlassIcon() {
  return (
    <svg aria-hidden="true" role="img" width="16" height="16" fill="none" viewBox="0 0 24 24">
      <path fill="currentColor" fillRule="evenodd" d="M15.62 17.03a9 9 0 1 1 1.41-1.41l4.68 4.67a1 1 0 0 1-1.42 1.42l-4.67-4.68ZM17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z" clipRule="evenodd" />
    </svg>
  )
}

function CircleXIcon() {
  return (
    <svg aria-hidden="true" role="img" width="16" height="16" fill="none" viewBox="0 0 24 24">
      <path fill="currentColor" fillRule="evenodd" d="M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22Zm4.7-15.7a1 1 0 0 0-1.4 0L12 10.58l-3.3-3.3a1 1 0 0 0-1.4 1.42L10.58 12l-3.3 3.3a1 1 0 1 0 1.42 1.4L12 13.42l3.3 3.3a1 1 0 0 0 1.4-1.42L13.42 12l3.3-3.3a1 1 0 0 0 0-1.4Z" clipRule="evenodd" />
    </svg>
  )
}

function XLargeIcon() {
  return (
    <svg aria-hidden="true" role="img" width="24" height="24" fill="none" viewBox="0 0 24 24">
      <path fill="currentColor" d="M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z" />
    </svg>
  )
}

// --- State hook -------------------------------------------------------------------

export interface ChannelsAndRolesApi {
  data: BridgeOnboarding | null
  /** Guild has onboarding prompts → "Channels & Roles" (Customize + Browse);
   *  otherwise the row/page is just "Browse Channels". */
  hasPrompts: boolean
  showAllChannels: boolean
  /** Whether `id` (channel or category) is on the caller's list under the
   *  opt-in model - Discord's isChannelOptedIn (pending writes applied). */
  isFollowing: (id: string) => boolean
  setShowAllChannels: (on: boolean) => void
  setFollowing: (id: string, on: boolean) => void
  setResponses: (optionIds: string[]) => void
  /** Discord's guild-browse-channels-context-menu / server-menu entry. */
  showAllMenuItem: () => MenuEntry
}

/** Onboarding data + the Channels & Roles writes for the open guild
 *  (`onboarding.guildId`). Every successful write refetches the onboarding
 *  payload (browse flags) and calls `onChannelsChanged` with the written
 *  guild so the sidebar re-reads that guild's /channels. A write that lands
 *  after a guild switch never touches the new guild's state. */
export function useChannelsAndRoles(onboarding: BridgeOnboardingHandle, onChannelsChanged: (guildId: string) => void): ChannelsAndRolesApi {
  const { data, reload, setState, guildId } = onboarding
  const guildRef = useRef(guildId)
  guildRef.current = guildId
  const changedRef = useRef(onChannelsChanged)
  changedRef.current = onChannelsChanged
  // Optimistic follow toggles until the refetched browse list lands.
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const browseRef = useRef(data?.browse)
  useEffect(() => {
    if (data?.browse !== browseRef.current) {
      browseRef.current = data?.browse
      setPending({})
    }
  }, [data?.browse])
  const stateRef = useRef<BridgeOnboardingState | null>(data?.state ?? null)
  stateRef.current = data?.state ?? null

  // Settle a write made in `gid`: the sidebar of that guild always refreshes;
  // the local state only when it's still the open guild.
  const settle = useCallback((gid: string, state: BridgeOnboardingState) => {
    if (guildRef.current === gid) {
      setState(state)
      reload()
    }
    changedRef.current(gid)
  }, [setState, reload])

  const setShowAllChannels = useCallback((on: boolean) => {
    const prev = stateRef.current
    const gid = guildRef.current
    if (!prev || !gid) return
    setState({ ...prev, showAllChannels: on })
    bridgeShowAllChannels(gid, on)
      .then((state) => settle(gid, state))
      .catch(() => { if (guildRef.current === gid) setState(prev) })
  }, [setState, settle])

  const setFollowing = useCallback((id: string, on: boolean) => {
    const gid = guildRef.current
    if (!gid) return
    setPending((p) => ({ ...p, [id]: on }))
    bridgeChannelOptIn(gid, id, on).then((state) => settle(gid, state)).catch(() => setPending((p) => {
      const next = { ...p }
      delete next[id]
      return next
    }))
  }, [settle])

  const setResponses = useCallback((optionIds: string[]) => {
    const prev = stateRef.current
    const gid = guildRef.current
    if (!prev || !gid) return
    setState({ ...prev, responses: optionIds })
    bridgeOnboardingResponses(gid, optionIds)
      .then((state) => settle(gid, state))
      .catch(() => { if (guildRef.current === gid) setState(prev) })
  }, [setState, settle])

  const following = useMemo(() => {
    const map = new Map<string, boolean>()
    if (!data) return map
    for (const c of data.browse?.channels || []) map.set(c.channelId, c.following)
    // Categories: followed when granted (defaults, selected options, manual
    // follows) and not explicitly unfollowed - the server's optedInSet.
    const granted = new Set<string>([...data.defaultChannelIds, ...data.state.optedInChannelIds])
    for (const p of data.prompts) for (const o of p.options) if (data.state.responses.includes(o.id)) o.channel_ids.forEach((id) => granted.add(id))
    const out = new Set(data.state.optedOutChannelIds)
    for (const cat of data.browse?.categories || []) map.set(cat.id, data.enabled && granted.has(cat.id) && !out.has(cat.id))
    return map
  }, [data])

  const isFollowing = useCallback((id: string) => (id in pending ? pending[id] : Boolean(following.get(id))), [pending, following])
  const showAllChannels = data?.state.showAllChannels ?? true

  const showAllMenuItem = useCallback((): MenuEntry => ({
    key: 'opt-in',
    label: S.showAllChannels,
    affordance: 'check',
    checked: showAllChannels,
    onSelect: () => setShowAllChannels(!showAllChannels),
  }), [showAllChannels, setShowAllChannels])

  return {
    data,
    hasPrompts: Boolean(data && data.prompts.length > 0),
    showAllChannels,
    isFollowing,
    setShowAllChannels,
    setFollowing,
    setResponses,
    showAllMenuItem,
  }
}

// --- Sidebar row --------------------------------------------------------------------

/** The guild-action row (652793) + the action section's divider. */
export function ChannelsAndRolesSidebarRow({ api, selected, onOpen, onContextMenu }: {
  api: ChannelsAndRolesApi
  selected: boolean
  onOpen: () => void
  onContextMenu: (e: ReactMouseEvent) => void
}) {
  if (!api.data) return null
  const label = api.hasPrompts ? S.channelsAndRoles : S.browseChannels
  return (
    <>
      <ul className="cr-actionRows" role="group" aria-label="Server actions">
        <li>
          <div
            className={`d-channelInteractive cr-sidebarRow${selected ? ' d-channelInteractiveSelected' : ''}`}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(e) }}
          >
            <button
              type="button"
              id="channels-community"
              className="d-channelLink cr-sidebarRowLink"
              aria-label={label}
              aria-current={selected ? 'page' : undefined}
              onClick={onOpen}
            >
              <ChannelsAndRolesIcon className="d-channelLinkButtonIcon cr-sidebarRowIcon" />
              <span className="d-channelName channel-name cr-sidebarRowName" aria-hidden="true">{label}</span>
            </button>
          </div>
        </li>
      </ul>
      <div className="cr-sectionFooter" aria-hidden="true"><div className="cr-sectionDivider" /></div>
    </>
  )
}

// --- Discord controls ------------------------------------------------------------------

/** Mana Switch (489718): 48x24 track, 16px thumb, brand when on. */
function Switch({ id, checked, disabled, onChange, labelledBy }: { id?: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void; labelledBy?: string }) {
  return (
    <label className="cr-switch" data-disabled={disabled || undefined}>
      <span className={`cr-switchTrack${checked ? ' checked' : ''}`} data-mana-component="switch" aria-hidden="true">
        <svg className="cr-switchThumb" viewBox="0 0 24 24" preserveAspectRatio="xMidYMin meet" aria-hidden="true">
          <rect fill="currentColor" x="4" y="4" width="16" height="16" rx="8" />
        </svg>
      </span>
      <input
        type="checkbox"
        role="switch"
        id={id}
        className="cr-visuallyHidden"
        checked={checked}
        disabled={disabled}
        aria-labelledby={labelledBy}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
    </label>
  )
}

/** Checkbox indicator (658675 → checkboxIndicator__714a9, display only). */
function CheckboxIndicator({ checked, disabled }: { checked: boolean; disabled: boolean }) {
  return (
    <span className="cr-checkboxOption" data-selected={checked || undefined} data-disabled={disabled || undefined} aria-hidden="true">
      <span className="cr-checkboxIndicator">
        {checked && (
          <svg className="cr-checkmark" viewBox="0 0 24 24" width="20" height="20">
            <path fill="currentColor" d="M18.7 7.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4l3.3 3.29 7.3-7.3a1 1 0 0 1 1.4 0Z" />
          </svg>
        )}
      </span>
    </span>
  )
}

/** Hover tooltip with Discord's delay (Tooltip delay prop). */
function useDelayedTooltip(delay: number) {
  const [anchor, setAnchor] = useState<Element | null>(null)
  const timer = useRef<number | null>(null)
  const clear = () => { if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null } }
  useEffect(() => clear, [])
  return {
    anchor,
    bind: {
      onMouseEnter: (e: ReactMouseEvent<HTMLElement>) => {
        const el = e.currentTarget
        clear()
        timer.current = window.setTimeout(() => setAnchor(el), delay)
      },
      onMouseLeave: () => { clear(); setAnchor(null) },
    },
  }
}

// --- Page ------------------------------------------------------------------------------

export function ChannelsAndRolesPage({ api, section, onSectionChange, guildName, rulesChannelId, onViewChannel }: {
  api: ChannelsAndRolesApi
  section: ChannelsAndRolesSection
  onSectionChange: (section: ChannelsAndRolesSection) => void
  guildName: string
  rulesChannelId?: string | null
  onViewChannel: (channelId: string) => void
}) {
  const hasPrompts = api.hasPrompts
  // Discord falls back to Browse when the guild has no prompts.
  const active: ChannelsAndRolesSection = hasPrompts ? section : 'browse'
  const title = hasPrompts ? S.channelsAndRoles : S.browseChannels
  useEffect(() => {
    const prev = document.title
    document.title = `${title} - ${guildName}`
    return () => { document.title = prev }
  }, [title, guildName])

  return (
    <div className="cr-chat" role="main" aria-label={title}>
      <section className="d-headerContainer d-headerThemed cr-header" aria-label="Channel header">
        <div className="d-headerUpperContainer">
          <div className="d-headerChildren">
            <div className="d-headerChannelIcon d-headerIconWrapper">
              <ChannelsAndRolesIcon size={24} className="d-headerIcon" />
            </div>
            <div className="d-headerTitleWrapper">
              <h1 className="d-headerTitle ns">{title}</h1>
            </div>
          </div>
        </div>
      </section>
      <div className="cr-content">
        {hasPrompts && (
          <div className="cr-tabBar" role="tablist" aria-orientation="horizontal">
            {([['customize', S.customize], ['browse', S.browseChannels]] as const).map(([id, label]) => (
              <div
                key={id}
                role="tab"
                tabIndex={active === id ? 0 : -1}
                aria-selected={active === id}
                aria-controls={`${id}-tab`}
                aria-label={id === 'browse' ? S.browseChannels : undefined}
                className={`cr-tabBarItem${active === id ? ' selected' : ''}`}
                onClick={() => onSectionChange(id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSectionChange(id) }
                  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); onSectionChange(id === 'customize' ? 'browse' : 'customize') }
                }}
              >
                <span className="cr-tabBarItemText">{label}</span>
              </div>
            ))}
          </div>
        )}
        {active === 'customize' && api.data
          ? <CustomizeTab api={api} data={api.data} onBrowseChannels={() => onSectionChange('browse')} />
          : api.data ? <BrowseTab api={api} data={api.data} rulesChannelId={rulesChannelId} onViewChannel={onViewChannel} /> : null}
      </div>
    </div>
  )
}

// --- Customize --------------------------------------------------------------------------

function helpItem(text: string, key: string) {
  return <span key={key} className="cr-helpItem">{text}</span>
}

// ICU-style "a", "a and b", "a, b, and N other(s)" with highlighted items.
function listPhrase(items: string[], one: string, many: string, otherOne: string, otherMany: string, end: string): ReactNode[] {
  const [a, b] = items
  if (items.length === 1) return ['the ', helpItem(a, 'a'), ` ${one}${end}`]
  if (items.length === 2) return ['the ', helpItem(a, 'a'), ' and ', helpItem(b, 'b'), ` ${many}${end}`]
  const extra = items.length - 2
  return [helpItem(a, 'a'), ', ', helpItem(b, 'b'), ', and ', `${extra} ${extra === 1 ? otherOne : otherMany}${end}`]
}

/** Channels & Roles help text (218785 `W`): what the answers picked on this
 *  page granted - "You received the #a channel, and the @r role." - else
 *  "Choose all that apply." for multi-select prompts. */
function receivedHelpText(data: BridgeOnboarding, prompt: BridgeOnboardingPrompt, picked: Set<string>): ReactNode {
  const chosen = prompt.options.filter((o) => picked.has(o.id))
  const roleNames = new Map((data.roles || []).map((r) => [r.id, r.name]))
  const channelNames = new Map<string, string>()
  for (const c of data.browse?.channels || []) channelNames.set(c.channelId, `#${c.name}`)
  for (const c of data.browse?.categories || []) channelNames.set(c.id, c.name)
  const roles = [...new Set(chosen.flatMap((o) => o.role_ids))].map((id) => roleNames.get(id)).filter((n): n is string => Boolean(n)).map((n) => `@${n}`)
  const channels = [...new Set(chosen.flatMap((o) => o.channel_ids))].map((id) => channelNames.get(id)).filter((n): n is string => Boolean(n))
  if (channels.length === 0 && roles.length > 0) return <>You received {listPhrase(roles, 'role', 'roles', 'other role', 'other roles', '.')}</>
  if (channels.length > 0 && roles.length === 0) return <>You received {listPhrase(channels, 'channel', 'channels', 'other channel', 'other channels', '.')}</>
  if (channels.length > 0 && roles.length > 0) {
    return <>You received {listPhrase(channels, 'channel', 'channels', 'other channel', 'other channels', '')}, and {listPhrase(roles, 'role', 'roles', 'other role', 'other roles', '.')}</>
  }
  return prompt.single_select ? '' : S.chooseAll
}

function PromptCard({ data, prompt, onChange }: {
  data: BridgeOnboarding
  prompt: BridgeOnboardingPrompt
  onChange: (responses: string[]) => void
}) {
  const [error, setError] = useState(false)
  // Options selected on this page (Discord's per-mount Set) drive the help text.
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const responses = data.state.responses
  const own = new Set(prompt.options.map((o) => o.id))
  return (
    <div className="cr-prompt">
      <h3 className="cr-promptTitle cr-heading-md">
        {prompt.title}
        {prompt.required && <span className={`cr-required${error ? ' error' : ''}`}>*</span>}
      </h3>
      <div className="cr-promptOptions">
        <OnboardingPromptOptions
          prompt={prompt}
          responses={responses}
          onChange={(next) => {
            const mine = next.filter((id) => own.has(id))
            // Required prompts keep at least one answer (Discord flags the *).
            if (prompt.required && mine.length === 0) { setError(true); return }
            const added = mine.filter((id) => !responses.includes(id))
            const removed = responses.filter((id) => own.has(id) && !mine.includes(id))
            setPicked((prev) => {
              const s = new Set(prev)
              if (prompt.single_select && added.length) for (const id of own) s.delete(id)
              added.forEach((id) => s.add(id))
              removed.forEach((id) => s.delete(id))
              return s
            })
            setError(false)
            onChange(next)
          }}
        />
      </div>
      <div className="cr-helpText cr-text-xs cr-c-muted">{receivedHelpText(data, prompt, picked)}</div>
    </div>
  )
}

function CustomizeTab({ api, data, onBrowseChannels }: { api: ChannelsAndRolesApi; data: BridgeOnboarding; onBrowseChannels: () => void }) {
  // Discord lists post-join prompts first, then the onboarding ones.
  const prompts = useMemo(() => [...data.prompts.filter((p) => !p.in_onboarding), ...data.prompts.filter((p) => p.in_onboarding)], [data.prompts])
  if (!prompts.length) {
    return (
      <div className="cr-emptyPage" id="customize-tab" role="tabpanel">
        <div className="cr-emptyContainer">
          <h3 className="cr-heading-md cr-emptyHeader">{S.emptyTitle}</h3>
          <div className="cr-text-sm-medium">
            You can add and remove channels from{' '}
            <a className="cr-link" href="#" onClick={(e) => { e.preventDefault(); onBrowseChannels() }}>{S.browseChannels}</a>.
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="cr-scroller cr-customizeScroller" id="customize-tab" role="tabpanel">
      <div className="cr-pageBody">
        <div>
          <h2 className="cr-heading-md cr-c-strong">{S.questions(prompts.length)}</h2>
          <div className="cr-text-xs cr-c-muted">{S.questionsSub}</div>
        </div>
        {prompts.map((p) => <PromptCard key={p.id} data={data} prompt={p} onChange={api.setResponses} />)}
      </div>
    </div>
  )
}

// --- Browse Channels ------------------------------------------------------------------------

const NUX_KEY = 'abulxt:chat-channel-browser-nux'

function ChannelBrowserNux({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="cr-nux">
      <div className="cr-nuxClose" role="button" tabIndex={0} aria-label="Close" onClick={onDismiss} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onDismiss() }}>
        <XLargeIcon />
      </div>
      <div className="cr-nuxContent">
        <img width={180} className="cr-nuxImage" src={nuxImage} alt="" aria-hidden="true" />
        <div>
          <h2 className="cr-heading-lg cr-c-strong cr-nuxHeading">{S.nuxTitle}</h2>
          <div className="cr-text-md cr-c-default">{S.nuxBody}</div>
          <div className="cr-text-md cr-c-default cr-nuxTip"><strong>Tip:</strong>{S.nuxTip}</div>
        </div>
      </div>
    </div>
  )
}

function ChannelRow({ api, channel, category, first, last, rulesChannelId, onViewChannel }: {
  api: ChannelsAndRolesApi
  channel: BridgeBrowseChannel
  category: BridgeCategory | null
  first: boolean
  last: boolean
  rulesChannelId?: string | null
  onViewChannel: (channelId: string) => void
}) {
  const categoryFollowed = Boolean(category && api.isFollowing(category.id))
  const locked = !channel.removable
  const disabled = categoryFollowed || locked
  const checked = categoryFollowed || locked || api.isFollowing(channel.channelId)
  const tip = categoryFollowed ? S.unfollowCategoryFirst : (channel.bridged || channel.isDefault) ? S.defaultChannels : null
  const tooltip = useDelayedTooltip(500)
  const view = (e: { stopPropagation: () => void }) => { e.stopPropagation(); onViewChannel(channel.channelId) }
  return (
    <>
      <div
        className={`cr-channelRow${first ? ' first' : ''}${last ? ' last' : ''}${disabled ? ' disabled' : ''}`}
        role="button"
        tabIndex={0}
        aria-pressed={checked}
        aria-label={channel.name}
        data-channel-id={channel.channelId}
        onClick={() => { if (!disabled) api.setFollowing(channel.channelId, !checked) }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return
          if ((e.key === 'Enter' || e.key === ' ') && !disabled) { e.preventDefault(); api.setFollowing(channel.channelId, !checked) }
        }}
        {...(tip ? tooltip.bind : {})}
      >
        <div className="cr-channelInfo">
          <div className="cr-channelName">
            <ChannelTypeIcon kind={channelIconKind(channel.type, channel.channelId === rulesChannelId)} size={20} className="cr-channelIcon" />
            <span className={`cr-channelText cr-text-md-medium ${disabled ? 'cr-c-muted' : 'cr-c-default'}`}>{channel.name}</span>
          </div>
          {channel.topic && (
            <div className="cr-channelSubtitles">
              <span className="cr-topic cr-text-xs">{channel.topic}</span>
            </div>
          )}
        </div>
        <div className="cr-channelActions">
          <div className="cr-viewButtonWrapper">
            <button
              type="button"
              className="cr-button cr-buttonOverlayPrimary"
              onClick={view}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); view(e) } }}
            >
              <span className="cr-buttonChildren">{S.view}</span>
            </button>
          </div>
          <CheckboxIndicator checked={checked} disabled={disabled} />
        </div>
      </div>
      {!last && <div className="cr-rowSeparator" />}
      {tip && tooltip.anchor && <HoverTooltip anchor={tooltip.anchor}>{tip}</HoverTooltip>}
    </>
  )
}

function BrowseTab({ api, data, rulesChannelId, onViewChannel }: {
  api: ChannelsAndRolesApi
  data: BridgeOnboarding
  rulesChannelId?: string | null
  onViewChannel: (channelId: string) => void
}) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const [nux, setNux] = useState(() => {
    try { return localStorage.getItem(NUX_KEY) !== '1' } catch { return true }
  })
  const dismissNux = () => {
    setNux(false)
    try { localStorage.setItem(NUX_KEY, '1') } catch { /* ignore */ }
  }
  // Groups in the server's order (bridged-first, Discord order within) - no
  // client-side re-sort; a group appears where its first channel does.
  const groups = useMemo(() => {
    const byId = new Map((data.browse?.categories || []).map((c) => [c.id, c]))
    const q = query.trim().toLowerCase()
    const out: Array<{ category: BridgeCategory | null; channels: BridgeBrowseChannel[] }> = []
    const index = new Map<string, number>()
    for (const c of data.browse?.channels || []) {
      const category = (c.parentId && byId.get(c.parentId)) || null
      const key = category?.id || ''
      if (!index.has(key)) { index.set(key, out.length); out.push({ category, channels: [] }) }
      if (!q || c.name.toLowerCase().includes(q)) out[index.get(key)!].channels.push(c)
    }
    return out.filter((g) => g.channels.length > 0)
  }, [data.browse, query])

  return (
    <div className="cr-browsePage" id="browse-tab" role="tabpanel">
      <div className="cr-browseHeader">
        <div className="cr-inputContainer" data-full-width="true">
          <div className="cr-inputWrapper cr-hasLeading">
            <div className="cr-inputIcon"><MagnifyingGlassIcon /></div>
            <HolyInput
              ref={inputRef}
              className="cr-input"
              type="text"
              value={query}
              placeholder={S.searchChannels}
              aria-label={S.searchChannels}
              data-mana-component="text-input"
              onChange={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return
                e.preventDefault()
                e.stopPropagation()
                if (query) setQuery('')
                else inputRef.current?.blur()
              }}
            />
            {query && (
              <div className="cr-clearButton" role="button" tabIndex={0} aria-label="Clear" onClick={() => { setQuery(''); requestAnimationFrame(() => inputRef.current?.focus()) }}>
                <CircleXIcon />
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="cr-browser">
        <div className="cr-browserInner">
          {nux && !query && <ChannelBrowserNux onDismiss={dismissNux} />}
          {groups.map((group) => {
            const cat = group.category
            const followed = Boolean(cat && api.isFollowing(cat.id))
            const labelId = cat ? `cr-follow-${cat.id}` : undefined
            return (
              <div key={cat?.id || 'null'} className="cr-categoryGroup">
                <div className={`cr-categoryRow${cat ? '' : ' uncategorized'}`}>
                  {cat && <h3 className="cr-categoryText cr-text-lg-medium cr-c-strong">{cat.name}</h3>}
                  {cat && (
                    <div className="cr-field" data-layout="horizontal">
                      <label id={labelId} htmlFor={`${labelId}-control`} className="cr-fieldLabel cr-text-md-medium cr-c-strong" data-interactive="true">
                        {S.followCategory}
                      </label>
                      <div className="cr-fieldControl">
                        <Switch id={`${labelId}-control`} checked={followed} labelledBy={labelId} onChange={(on) => api.setFollowing(cat.id, on)} />
                      </div>
                    </div>
                  )}
                </div>
                {group.channels.map((c, i) => (
                  <ChannelRow
                    key={c.channelId}
                    api={api}
                    channel={c}
                    category={cat}
                    first={i === 0}
                    last={i === group.channels.length - 1}
                    rulesChannelId={rulesChannelId}
                    onViewChannel={onViewChannel}
                  />
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
