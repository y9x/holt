// Discord Server Onboarding, 1:1 for web webhooks.
//
// A port of Discord's GuildOnboardingPage (webpack 123071, lazy chunk 839579)
// and its pieces: the cover (426508 / 201991: guild icon, "Welcome to
// {guildName}", "Let's customize your experience", auto-advances after 3s),
// one step per in-onboarding prompt (MULTIPLE_CHOICE option cards 164048, or
// the DROPDOWN multi-select 839447; "Question N of M · Required", Back /
// Skip / Next / Finish 🎉, the "You will receive the @role role." help text
// 218785), and the rules step (eo: "One last step!", "Read & Agree to Server
// Rules", numbered terms, Finish unlocks once the last rule scrolls into
// view). Strings are Discord's en-US intl messages.
//
// The data is the guild's real onboarding config, served by the bridge
// (GET /api/discord/bridge/onboarding); answers are stored per webhook
// identity and emulated (roles for channel visibility, opt-in channels) -
// nothing is written to Discord.
//
// Exports for the Channels & Roles / Customize page: OnboardingOptionCard,
// OnboardingPromptOptions, OnboardingDropdown, OnboardingEmojiGlyph,
// OnboardingButton, useOnboardingHelpText, toggleOnboardingOption,
// openOnboarding().

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { subscribeBridge } from '../../lib/rt'
import { HolyText } from '../../components/common/HolyText'
import { navigateTo } from '../../lib/navigate'
import {
  BRIDGE_ONBOARDING_EVENT,
  bridgeOnboarding,
  bridgeOnboardingResponses,
  type BridgeOnboarding,
  type BridgeOnboardingEmoji,
  type BridgeOnboardingOption,
  type BridgeOnboardingPrompt,
  type BridgeOnboardingState,
} from '../../lib/bridge'
import { toCodepoint, twemojiUrl } from './twemoji'
import { DiscordSelect, type SelectOption } from './DiscordSelect'
import './onboarding.css'

// --- Icons (Discord's Mana icon paths) ---------------------------------------

function ArrowLargeRightIcon({ size = 20 }: { size?: number }) {
  return (
    <svg className="dcOnbBtnIcon" aria-hidden="true" role="img" width={size} height={size} fill="none" viewBox="0 0 24 24">
      <path fill="currentColor" d="M20.7 12.7a1 1 0 0 0 0-1.4l-8-8a1 1 0 1 0-1.4 1.4l6.29 6.3H4a1 1 0 1 0 0 2h13.59l-6.3 6.3a1 1 0 0 0 1.42 1.4l8-8Z" />
    </svg>
  )
}

function ArrowLargeLeftIcon({ size = 20 }: { size?: number }) {
  return (
    <svg className="dcOnbBtnIcon" aria-hidden="true" role="img" width={size} height={size} fill="none" viewBox="0 0 24 24">
      <path fill="currentColor" d="M3.3 11.3a1 1 0 0 0 0 1.4l8 8a1 1 0 1 0 1.4-1.4L6.42 13H20a1 1 0 1 0 0-2H6.41l6.3-6.3a1 1 0 0 0-1.42-1.4l-8 8Z" />
    </svg>
  )
}

function CheckmarkLargeIcon({ size = 10 }: { size?: number }) {
  return (
    <svg aria-hidden="true" role="img" width={size} height={size} fill="none" viewBox="0 0 24 24">
      <path fill="#fff" d="M21.7 5.3a1 1 0 0 1 0 1.4l-12 12a1 1 0 0 1-1.4 0l-6-6a1 1 0 1 1 1.4-1.4L9 16.58l11.3-11.3a1 1 0 0 1 1.4 0Z" />
    </svg>
  )
}

function XIcon() {
  return (
    <svg aria-hidden="true" role="img" width="20" height="20" fill="none" viewBox="0 0 24 24">
      <path fill="currentColor" d="M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z" />
    </svg>
  )
}

// --- Primitives -----------------------------------------------------------------

export function OnboardingButton({ variant, text, icon, iconPosition = 'start', disabled, loading, onClick }: {
  variant: 'primary' | 'secondary'
  text: string
  icon?: ReactNode
  iconPosition?: 'start' | 'end'
  disabled?: boolean
  loading?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      className={`dcOnbBtn md hasText ${variant}`}
      aria-busy={loading || undefined}
      disabled={disabled}
      onClick={disabled || loading ? undefined : onClick}
    >
      <div className="dcOnbBtnWrapper">
        <div className={`dcOnbBtnChildren${loading ? ' loading' : ''}`}>
          {icon && iconPosition === 'start' && icon}
          <span className="dcOnb-text-md-medium">{text}</span>
          {icon && iconPosition === 'end' && icon}
        </div>
        {loading && <div className="dcOnbBtnSpinner" aria-hidden="true"><span /><span /><span /></div>}
      </div>
    </button>
  )
}

function TooltipContainer({ text, children }: { text: string | null; children: ReactNode }) {
  if (!text) return <>{children}</>
  return (
    <div className="dcOnbTooltipWrap">
      {children}
      <div className="dcOnbTooltip" role="tooltip">{text}</div>
    </div>
  )
}

/** An option/prompt emoji: custom emoji from Discord's CDN, unicode via Twemoji. */
export function OnboardingEmojiGlyph({ emoji, className = 'dcOnbButtonEmoji', size }: { emoji: BridgeOnboardingEmoji | null; className?: string; size?: number }) {
  const [broken, setBroken] = useState(false)
  if (!emoji || (!emoji.id && !emoji.name)) return null
  const src = emoji.url || (emoji.name ? twemojiUrl(toCodepoint(emoji.name)) : null)
  if (!src || broken) {
    return emoji.id ? null : <span className="dcOnbButtonEmojiText" aria-hidden="true">{emoji.name}</span>
  }
  return (
    <img
      className={`emoji ${className}`}
      src={src}
      alt={emoji.id ? `:${emoji.name || 'emoji'}:` : emoji.name || ''}
      draggable={false}
      data-type="emoji"
      {...(emoji.id ? { 'data-id': emoji.id } : { 'data-name': emoji.name || '' })}
      style={size ? { width: size, height: size } : undefined}
      onError={() => setBroken(true)}
    />
  )
}

/** Discord's option card (455168 optionButtonWrapper): emoji, title,
 *  description and the brand check badge when selected. */
export function OnboardingOptionCard({ option, selected, onSelect }: {
  option: BridgeOnboardingOption
  selected: boolean
  onSelect: (selected: boolean) => void
}) {
  const [pressed, setPressed] = useState(false)
  return (
    <div className={`dcOnbOption${selected ? ' selected' : ''}${pressed ? ' pressed' : ''}`}>
      <button
        type="button"
        className="dcOnbOptionButton"
        aria-pressed={selected}
        onClick={() => onSelect(!selected)}
        onMouseDown={() => setPressed(true)}
        onMouseUp={() => setPressed(false)}
        onMouseLeave={() => setPressed(false)}
      >
        <OnboardingEmojiGlyph emoji={option.emoji} />
        <div className="dcOnbButtonText">
          <div className="dcOnb-text-md-medium dcOnb-c-strong">{option.title}</div>
          {option.description.length > 0 && <div className="dcOnb-text-xs dcOnb-c-default">{option.description}</div>}
        </div>
        <div className="dcOnbCheckIcon" aria-hidden="true"><CheckmarkLargeIcon /></div>
      </button>
    </div>
  )
}

/** Discord's selectOption for one prompt: single_select replaces the
 *  prompt's previous answer; multi-select toggles. Returns the new full
 *  response list (all prompts). */
export function toggleOnboardingOption(prompt: BridgeOnboardingPrompt, responses: string[], optionId: string, selected: boolean): string[] {
  const own = new Set(prompt.options.map((o) => o.id))
  if (!selected) return responses.filter((id) => id !== optionId)
  const base = prompt.single_select ? responses.filter((id) => !own.has(id)) : responses.filter((id) => id !== optionId)
  return [...base, optionId]
}

/** Discord's DROPDOWN prompt (839447): a multi-select with emoji prefixes and
 *  the selected answers as pills, on the shared Discord Select (opens below
 *  the field at its width, flips above only when there's no room). */
export function OnboardingDropdown({ prompt, value, onToggle }: {
  prompt: BridgeOnboardingPrompt
  value: string[]
  onToggle: (optionId: string, selected: boolean) => void
}) {
  const options = useMemo<SelectOption<string>[]>(() => prompt.options.map((o) => ({
    value: o.id,
    label: o.title,
    textValue: o.title,
    leading: o.emoji ? <OnboardingEmojiGlyph emoji={o.emoji} className="" size={20} /> : undefined,
  })), [prompt.options])
  const byId = useMemo(() => new Map(prompt.options.map((o) => [o.id, o])), [prompt.options])
  const selected = prompt.options.filter((o) => value.includes(o.id)).map((o) => o.id)
  return (
    <DiscordSelect
      className="dcOnbSelect"
      fieldClassName="dcOnbSelectControl"
      valueClassName="dcOnbSelectValues"
      optionClassName="dcOnbSelectOption"
      options={options}
      selected={selected}
      // single_select prompts replace their answer and close, like Discord.
      multiple={!prompt.single_select}
      onSelect={(id, next) => onToggle(id, prompt.single_select ? !value.includes(id) : next)}
      placeholder="Select…"
      aria-label={prompt.title}
      renderValue={(chosen) => chosen.map((c) => {
        const o = byId.get(c.value)
        return (
          <span key={c.value} className="dcOnbSelectValuePill dcOnb-text-sm-medium dcOnb-c-strong">
            <OnboardingEmojiGlyph emoji={o?.emoji ?? null} className="" size={16} />
            {o?.title}
          </span>
        )
      })}
    />
  )
}

/** A prompt's answers: option-card grid (MULTIPLE_CHOICE) or the dropdown. */
export function OnboardingPromptOptions({ prompt, responses, onChange }: {
  prompt: BridgeOnboardingPrompt
  responses: string[]
  onChange: (responses: string[]) => void
}) {
  const toggle = (optionId: string, on: boolean) => onChange(toggleOnboardingOption(prompt, responses, optionId, on))
  if (prompt.type === 1) return <OnboardingDropdown prompt={prompt} value={responses} onToggle={toggle} />
  return (
    <div className="dcOnbPromptOptions">
      {prompt.options.map((o) => (
        <OnboardingOptionCard key={o.id} option={o} selected={responses.includes(o.id)} onSelect={(on) => toggle(o.id, on)} />
      ))}
    </div>
  )
}

// --- Help text (218785) -----------------------------------------------------------

function item(node: string, key: string) {
  return <span key={key} className="dcOnbHelpTextItem">{node}</span>
}

// Discord's ICU plural lists: "=1" / "=2" / other ("x, y, and N other(s)").
function listOf(items: string[], other: (extra: number) => string, suffix: (count: number) => string): ReactNode[] {
  const [a, b] = items
  if (items.length === 1) return [item(a, 'a'), suffix(1)]
  if (items.length === 2) return [item(a, 'a'), ' and ', item(b, 'b'), suffix(2)]
  return [item(a, 'a'), ', ', item(b, 'b'), ', and ', other(items.length - 2), '.']
}

function rolesPhrase(roles: string[], also: boolean): ReactNode {
  return (
    <>
      {also ? 'You will also receive the ' : 'You will receive the '}
      {listOf(roles, (n) => `${n} other role${n === 1 ? '' : 's'}`, (c) => (c === 1 ? ' role.' : ' roles.'))}
    </>
  )
}

function channelsPhrase(channels: string[]): ReactNode {
  return <>You will be added to {listOf(channels, (n) => `${n} other${n === 1 ? '' : 's'}`, () => '.')}</>
}

/** Discord's prompt help text: "Choose all that apply." for multi-select, or
 *  what the current answers grant ("You will be added to #a and #b." /
 *  "You will (also) receive the @role role."). */
export function useOnboardingHelpText(data: Pick<BridgeOnboarding, 'roles' | 'browse'>, prompt: BridgeOnboardingPrompt, responses: string[]): { helpText: ReactNode; helpTextAdditional: ReactNode } {
  return useMemo(() => {
    const chosen = prompt.options.filter((o) => responses.includes(o.id))
    const roleNames = new Map((data.roles || []).map((r) => [r.id, r.name]))
    const channelNames = new Map<string, string>()
    for (const c of data.browse?.channels || []) channelNames.set(c.channelId, `#${c.name}`)
    for (const c of data.browse?.categories || []) channelNames.set(c.id, c.name)
    const roles = [...new Set(chosen.flatMap((o) => o.role_ids))].map((id) => roleNames.get(id)).filter((n): n is string => Boolean(n)).map((n) => `@${n}`)
    // Only channels the viewer can see (Discord filters on VIEW_CHANNEL).
    const channels = [...new Set(chosen.flatMap((o) => o.channel_ids))].map((id) => channelNames.get(id)).filter((n): n is string => Boolean(n))
    let helpText: ReactNode = prompt.single_select ? '' : 'Choose all that apply.'
    let helpTextAdditional: ReactNode = ''
    if (channels.length === 0 && roles.length > 0) helpText = rolesPhrase(roles, false)
    else if (channels.length > 0) {
      helpText = channelsPhrase(channels)
      if (roles.length > 0) helpTextAdditional = rolesPhrase(roles, true)
    }
    return { helpText, helpTextAdditional }
  }, [data.roles, data.browse, prompt, responses])
}

// --- Steps --------------------------------------------------------------------------

type GuildLite = { id: string; name: string; icon: string | null; splash?: string | null }

function guildAcronym(name: string): string {
  return name.replace(/'s /g, ' ').replace(/\w+/g, (w) => w[0]).replace(/\s/g, '').slice(0, 3)
}

function CoverStep({ guild, headerId, onStart }: { guild: GuildLite; headerId: string; onStart: () => void }) {
  // Discord's cover auto-advances after 3s (useMount → setTimeout 3e3).
  const startRef = useRef(onStart)
  startRef.current = onStart
  useEffect(() => {
    const t = window.setTimeout(() => startRef.current(), 3000)
    return () => window.clearTimeout(t)
  }, [])
  return (
    <div className="dcOnbCover">
      <div className="dcOnbCoverCenter">
        <div>
          {guild.icon
            ? <img className="dcOnbGuildImage" src={guild.icon.replace(/size=\d+/, 'size=256')} alt="" />
            : <div className="dcOnbGuildAcronym" aria-hidden="true">{guildAcronym(guild.name)}</div>}
        </div>
        <div className="dcOnbCoverContent">
          <div className="dcOnbCoverTitle dcOnb-text-lg dcOnb-c-overlay" id={headerId}>Welcome to {guild.name}</div>
          <h2 className="dcOnb-heading-xxl dcOnb-c-overlay">Let&apos;s customize your experience</h2>
        </div>
      </div>
    </div>
  )
}

function PromptStep({ data, prompt, step, questionCount, lastPrompt, responses, setResponses, isSubmitting, headerId, onBack, onNext, onComplete }: {
  data: BridgeOnboarding
  prompt: BridgeOnboardingPrompt
  step: number
  questionCount: number
  lastPrompt: boolean
  responses: string[]
  setResponses: (next: string[]) => void
  isSubmitting: boolean
  headerId: string
  onBack: (() => void) | null
  onNext: () => void
  onComplete: () => void
}) {
  const own = responses.filter((id) => prompt.options.some((o) => o.id === id))
  const noneSelected = own.length === 0
  const blocked = noneSelected && prompt.required
  const { helpText, helpTextAdditional } = useOnboardingHelpText(data, prompt, own)
  return (
    <div className="dcOnbPrompt" role="dialog" aria-labelledby={headerId}>
      <div className="dcOnbPromptContent">
        <div className="dcOnbScrollerContent">
          <div className="dcOnbQuestionHeader">
            <div className="dcOnb-text-sm-medium dcOnb-c-muted">Question {step + 1} of {questionCount}</div>
            {prompt.required && (
              <>
                <div className="dcOnb-text-xs dcOnbHeaderSeparator">·</div>
                <div className="dcOnb-text-sm-medium dcOnb-c-brand"><HolyText text="Required" /></div>
              </>
            )}
          </div>
          <h1 className="dcOnbTitle dcOnb-heading-xl dcOnb-c-strong" id={headerId}>{prompt.title}</h1>
          <OnboardingPromptOptions prompt={prompt} responses={responses} onChange={setResponses} />
        </div>
        <div className="dcOnbNavButtons">
          <div className="dcOnbLeftButtons">
            {onBack && <OnboardingButton variant="secondary" text="Back" onClick={onBack} icon={<ArrowLargeLeftIcon />} iconPosition="start" />}
          </div>
          <div className="dcOnbRightButtons">
            <div className="dcOnbHelpText dcOnb-text-xs dcOnb-c-muted">{helpText} {helpTextAdditional}</div>
            <TooltipContainer text={blocked ? 'This is a required question.' : null}>
              <OnboardingButton
                variant={noneSelected ? 'secondary' : 'primary'}
                text={lastPrompt ? 'Finish \u{1F389}' : noneSelected ? 'Skip' : 'Next'}
                onClick={() => (lastPrompt ? onComplete() : onNext())}
                disabled={blocked || isSubmitting}
                loading={isSubmitting}
                icon={lastPrompt ? undefined : <ArrowLargeRightIcon />}
                iconPosition="end"
              />
            </TooltipContainer>
          </div>
        </div>
      </div>
    </div>
  )
}

function RulesStep({ terms, onBack, onComplete, isSubmitting, headerId }: {
  terms: string[]
  onBack: (() => void) | null
  onComplete: () => void
  isSubmitting: boolean
  headerId: string
}) {
  const [read, setRead] = useState(false)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  // Discord observes the last rule row; reaching it unlocks Finish. Checked
  // on scroll/resize against the scroller's visible box (an
  // IntersectionObserver fires spuriously while the step springs in from
  // scale .8).
  useEffect(() => {
    const scroller = scrollerRef.current
    const last = bodyRef.current?.lastElementChild
    if (!scroller || !last) { setRead(true); return }
    const check = () => {
      const box = scroller.getBoundingClientRect()
      const row = last.getBoundingClientRect()
      if (row.top < box.bottom - 1 && row.bottom > box.top) setRead(true)
    }
    const timer = window.setTimeout(check, 400)
    scroller.addEventListener('scroll', check, { passive: true })
    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(check) : null
    resize?.observe(scroller)
    return () => { window.clearTimeout(timer); scroller.removeEventListener('scroll', check); resize?.disconnect() }
  }, [terms])
  return (
    <div className="dcOnbPrompt" role="dialog" aria-labelledby={headerId}>
      <div className="dcOnbPromptContent">
        <div className="dcOnbScrollerContent" ref={scrollerRef}>
          <div className="dcOnb-text-sm-medium dcOnb-c-muted"><HolyText text="One last step!" /></div>
          <h1 className="dcOnb-heading-xl dcOnb-c-strong" id={headerId}>Read &amp; Agree to Server Rules</h1>
          <div className="dcOnbTermsFieldBody" ref={bodyRef}>
            {terms.map((rule, n) => (
              <div className="dcOnbTermsRow" key={`term-${n}`}>
                <div className="dcOnb-text-sm dcOnb-c-muted">{`${n + 1}.`}</div>
                <div className="dcOnb-text-sm dcOnbTermsRowContent">{rule}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="dcOnbOverlay" />
        <div className="dcOnbNavButtons">
          <div className="dcOnbLeftButtons">
            {onBack && <OnboardingButton variant="secondary" text="Back" onClick={onBack} icon={<ArrowLargeLeftIcon />} iconPosition="start" />}
          </div>
          <div className="dcOnbRightButtons">
            <div className="dcOnbHelpText dcOnb-text-xs dcOnb-c-muted">
              {read ? 'By clicking "Finish", you have read and agreed to the Server Rules.' : 'You must finish reading the rules to join.'}
            </div>
            <OnboardingButton variant="primary" text={'Finish \u{1F389}'} onClick={onComplete} disabled={!read || isSubmitting} loading={isSubmitting} />
          </div>
        </div>
      </div>
    </div>
  )
}

// --- Flow -----------------------------------------------------------------------------

type Step = 'cover' | 'rules' | number

/** The full-screen onboarding flow over the chat page. */
export function OnboardingFlow({ data, guild, onComplete, onDismiss, initialStep = 'cover' }: {
  data: BridgeOnboarding
  guild: GuildLite
  onComplete: (state: BridgeOnboardingState) => void
  /** Present only when the flow was reopened (Discord's own flow can't be dismissed). */
  onDismiss?: () => void
  initialStep?: Step
}) {
  const prompts = useMemo(() => data.prompts.filter((p) => p.in_onboarding), [data.prompts])
  const terms = data.rules?.terms || []
  const hasRules = terms.length > 0 && !data.state.rulesAccepted
  const [step, setStep] = useState<Step>(initialStep)
  const [responses, setResponses] = useState<string[]>(data.state.responses)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const headerId = useId()

  const complete = useCallback(async (rulesAccepted?: boolean) => {
    setSubmitting(true)
    setError(null)
    try {
      const state = await bridgeOnboardingResponses(guild.id, responses, true, rulesAccepted)
      onComplete(state)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.')
      setSubmitting(false)
    }
  }, [guild.id, responses, onComplete])

  const start = useCallback(() => {
    if (prompts.length) setStep(0)
    else if (hasRules) setStep('rules')
    else void complete()
  }, [prompts.length, hasRules, complete])

  useEffect(() => {
    if (!onDismiss) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onDismiss])

  const splash = guild.splash || data.guild?.splash || null
  let body: ReactNode = null
  if (step === 'cover') {
    body = <CoverStep guild={guild} headerId={headerId} onStart={start} />
  } else if (step === 'rules') {
    body = (
      <RulesStep
        terms={terms}
        headerId={headerId}
        isSubmitting={submitting}
        onBack={prompts.length ? () => setStep(prompts.length - 1) : null}
        onComplete={() => void complete(true)}
      />
    )
  } else {
    const prompt = prompts[step]
    if (prompt) {
      const lastPrompt = step + 1 >= prompts.length && !hasRules
      body = (
        <PromptStep
          data={data}
          prompt={prompt}
          step={step}
          questionCount={prompts.length}
          lastPrompt={lastPrompt}
          responses={responses}
          setResponses={setResponses}
          isSubmitting={submitting}
          headerId={headerId}
          onBack={step > 0 ? () => setStep(step - 1) : null}
          onNext={() => setStep(step + 1 < prompts.length ? step + 1 : 'rules')}
          onComplete={() => void complete()}
        />
      )
    }
  }

  return (
    <div className={`dcOnbPage${splash ? '' : ' fullBorderWithGradient'}`} data-step={String(step)}>
      {splash && <div className="dcOnbArtwork"><img src={splash} alt="" /></div>}
      {splash && <div className="dcOnbGradient" />}
      {onDismiss && (
        <button type="button" className="dcOnbClose" aria-label="Close" onClick={onDismiss}><XIcon /></button>
      )}
      <div className="dcOnbStage">
        <div className="dcOnbStepIn" key={String(step)}>{body}</div>
      </div>
      {error && step !== 'cover' && (
        <div className="dcOnbBottomCenter" role="alert">
          <div className="dcOnb-heading-sm" style={{ color: 'var(--text-feedback-critical, #f23f43)' }}>{error}</div>
        </div>
      )}
      {step === 'cover' && (
        <div className="dcOnbBottomCenter">
          <div className="dcOnb-heading-sm dcOnb-c-default dcOnbPrivacy">
            Your responses will be treated in accordance with our{' '}
            <button type="button" className="dcOnbLink" onClick={() => navigateTo('privacy')}>Privacy Policy</button>
          </div>
        </div>
      )}
    </div>
  )
}

// --- Gate (mounted by chat.tsx) ------------------------------------------------------------

const OPEN_EVENT = 'abulxt:onboarding-open'

/** Reopen the onboarding flow (e.g. from the Channels & Roles page). */
export function openOnboarding(): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT))
}

/** One guild's onboarding payload. chat.tsx loads it ONCE for the open
 *  guild and hands the handle to both consumers (the gate and Channels &
 *  Roles) so they can never disagree. */
export interface BridgeOnboardingHandle {
  /** The guild this handle tracks (the open server); null = none yet. */
  guildId: string | null
  /** The payload for `guildId` (null while loading, on error, or for a
   *  malformed payload). Never another guild's data. */
  data: BridgeOnboarding | null
  reload: () => void
  setState: (state: BridgeOnboardingState) => void
}

/** Shared onboarding data loader for `guildId`: reloads when the guild
 *  changes (a stale guild's response is dropped) and on the caller's scoped
 *  `bridge.onboarding.updated` events for this guild (guildId null = every
 *  guild). */
export function useBridgeOnboarding(guildId: string | null): BridgeOnboardingHandle {
  const [loaded, setLoaded] = useState<{ guildId: string; data: BridgeOnboarding | null } | null>(null)
  const guildRef = useRef(guildId)
  guildRef.current = guildId
  const reload = useCallback(() => {
    const gid = guildRef.current
    if (!gid) return
    // A malformed payload (proxy error page, empty object) is treated as "no
    // onboarding" rather than crashing every consumer that spreads its arrays.
    bridgeOnboarding(gid)
      .then((d) => {
        if (guildRef.current !== gid) return
        setLoaded({ guildId: gid, data: d && Array.isArray(d.defaultChannelIds) && Array.isArray(d.prompts) && d.state && Array.isArray(d.state.optedInChannelIds) ? d : null })
      })
      .catch(() => {})
  }, [])
  useEffect(() => { reload() }, [guildId, reload])
  useEffect(() => subscribeBridge((event) => {
    if (event.type !== BRIDGE_ONBOARDING_EVENT) return
    const payload = event.payload as { state?: BridgeOnboardingState; guildId?: string | null }
    const target = payload.guildId ? String(payload.guildId) : null
    const gid = guildRef.current
    if (!gid || (target !== null && target !== gid)) return
    // The pushed state belongs to one guild: only apply it when it's ours.
    if (payload.state && target === gid) {
      const state = payload.state
      setLoaded((l) => (l && l.guildId === gid && l.data ? { ...l, data: { ...l.data, state } } : l))
    }
    reload()
  }), [reload])
  const setState = useCallback((state: BridgeOnboardingState) => {
    const gid = guildRef.current
    setLoaded((l) => (l && l.guildId === gid && l.data ? { ...l, data: { ...l.data, state } } : l))
  }, [])
  const data = loaded && loaded.guildId === guildId ? loaded.data : null
  return useMemo(() => ({ guildId, data, reload, setState }), [guildId, data, reload, setState])
}

/** Shows the onboarding flow for a NEW web identity (signed in, onboarding
 *  enabled, not completed) in the open guild, and on openOnboarding(). Calls
 *  `onChannelsChanged` after finishing (refetch that guild's /channels; live
 *  `bridge.onboarding.updated` events are routed by chat.tsx) and
 *  `onNavigateChannel` with the first default channel (Discord drops you into
 *  the default channel). */
export function OnboardingGate({ signedIn, guild, onboarding, onChannelsChanged, onNavigateChannel }: {
  signedIn: boolean
  guild: GuildLite | null
  onboarding: BridgeOnboardingHandle
  onChannelsChanged: () => void
  onNavigateChannel?: (channelId: string) => void
}) {
  const { data, setState, reload, guildId } = onboarding
  const [reopened, setReopened] = useState(false)
  // Signing in/out mid-session changes the identity: refetch its state.
  const signedInRef = useRef(signedIn)
  useEffect(() => {
    if (signedInRef.current !== signedIn) reload()
    signedInRef.current = signedIn
  }, [signedIn, reload])
  const [dismissed, setDismissed] = useState(false)
  // Onboarding is per server: a dismissal/reopen in one guild never carries
  // over to the next one.
  useEffect(() => { setDismissed(false); setReopened(false) }, [guildId])
  const changedRef = useRef(onChannelsChanged)
  changedRef.current = onChannelsChanged

  useEffect(() => {
    const onOpen = () => { setDismissed(false); setReopened(true) }
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_EVENT, onOpen)
  }, [])

  const g: GuildLite | null = data?.guild ? { id: data.guild.id, name: data.guild.name, icon: data.guild.icon, splash: data.guild.splash } : guild
  const show = Boolean(data && g && signedIn && data.enabled && !dismissed && (reopened || data.state.isNew))
  if (!show || !data || !g) return null
  return (
    <OnboardingFlow
      key={g.id}
      data={data}
      guild={g}
      onDismiss={reopened ? () => { setReopened(false); setDismissed(true) } : undefined}
      onComplete={(state) => {
        setState(state)
        setReopened(false)
        setDismissed(true)
        changedRef.current()
        const first = data.defaultChannelIds.find((id) => data.browse?.channels.some((c) => c.channelId === id))
        if (first && onNavigateChannel) onNavigateChannel(first)
      }}
    />
  )
}
