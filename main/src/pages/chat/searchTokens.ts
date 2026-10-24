// Discord's search query tokenizer, ported from the web bundle
// (web.d3978f1210c00a8f.js):
//   module 988665 - the Tokenizer: scans left→right; at each offset it tries
//     the "follower" rules of the previous token (only when that token ended
//     exactly here), then the base rules; unmatched characters accumulate into
//     a NON_TOKEN run.
//   module 304578 - the rule table (FILTER_* / ANSWER_*), regexes, validators,
//     `mutable` flags, query keys and the date-answer resolver.
//   module 822382 - cursor scope (zZ), autocomplete mode (Gk), the
//     tokens → search-API query builder (Zf) and the "is this token kept"
//     check (Zh: a filter only counts when an answer follows it).
// Filters the bridge can't answer from stored data (pinned:, linkFrom:,
// fileType:, fileName:) are not registered, so they tokenize as plain text.

export type TokenType =
  | 'NON_TOKEN'
  | 'FILTER_FROM' | 'ANSWER_USERNAME_FROM'
  | 'FILTER_MENTIONS' | 'ANSWER_USERNAME_MENTIONS'
  | 'FILTER_HAS' | 'ANSWER_HAS'
  | 'FILTER_BEFORE' | 'FILTER_ON' | 'FILTER_AFTER'
  | 'ANSWER_BEFORE' | 'ANSWER_ON' | 'ANSWER_AFTER'
  | 'FILTER_IN' | 'ANSWER_IN'
  | 'FILTER_AUTHOR_TYPE' | 'ANSWER_AUTHOR_TYPE'

export type FilterType = 'FILTER_FROM' | 'FILTER_MENTIONS' | 'FILTER_HAS' | 'FILTER_BEFORE' | 'FILTER_ON' | 'FILTER_AFTER' | 'FILTER_IN' | 'FILTER_AUTHOR_TYPE'

export interface KnownUser {
  userId: string
  username: string
  displayName: string
  avatar: string | null
}

export interface KnownChannel {
  channelId: string
  name: string
}

export class Token {
  type: TokenType
  start: number
  match: string[]
  data: Record<string, unknown> = {}
  constructor(match: string[], type: TokenType, start: number) {
    this.match = match
    this.type = type
    this.start = start
  }
  get text(): string { return this.match[0] ?? '' }
  get length(): number { return this.text.length }
  get end(): number { return this.start + this.length }
  group(i: number): string | undefined { return this.match[i] }
}

// ---- shared lookup context (users seen in autocomplete, bridged channels) ----

const USERS_KEY = 'abulxt:chat-search-users'
const usersByName = new Map<string, KnownUser>()
const usersById = new Map<string, KnownUser>()
let channels: KnownChannel[] = []

;(function loadUsers() {
  try {
    const raw = JSON.parse(localStorage.getItem(USERS_KEY) || '[]')
    if (Array.isArray(raw)) for (const u of raw) if (u && typeof u.userId === 'string' && typeof u.username === 'string') rememberUser(u, false)
  } catch { /* storage blocked */ }
})()

export function rememberUser(u: KnownUser, persist = true): void {
  usersByName.set(u.username.toLowerCase(), u)
  usersById.set(u.userId, u)
  if (!persist) return
  try {
    const list = [...usersById.values()].slice(-300)
    localStorage.setItem(USERS_KEY, JSON.stringify(list))
  } catch { /* storage blocked */ }
}
export function userById(id: string): KnownUser | undefined { return usersById.get(id) }
export function setSearchChannels(list: KnownChannel[]): void { channels = list }
export function searchChannels(): KnownChannel[] { return channels }

// ---- rules ----------------------------------------------------------------

export interface Rule {
  type: TokenType
  regex: RegExp
  follows?: TokenType[]
  validator?: (t: Token) => boolean
  mutable?: boolean
  componentType: 'FILTER' | 'ANSWER'
  key?: string        // 'from:' (B(e) = `${e}:`)
  queryKey?: string
}

const SNOWFLAKE = /^\d{17,20}$/

// V(e): RegExp(B(e), 'i'); the tokenizer anchors every regex with ^.
const filter = (word: string): RegExp => new RegExp(`^${word}:`, 'i')
// L(list): longest-first alternation with optional "-" negation.
function oneOf(list: string[]): RegExp {
  const sorted = [...list].sort((a, b) => b.length - a.length)
  return new RegExp(`^(?:\\s*(-?(?:${sorted.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})))`, 'i')
}
// ei: username answer.
const USERNAME = /^(?:\s*(\d{17,20}|@me|([^@#:]+)#([0-9]{4})|([a-z0-9_.]{2,32})))/i
// k: date answer.
const DATE = /^(?:\s*(([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})|([0-9]{4})-([0-9]{1,2})|\d{4}|([^\d\s]+)))/i
// O: channel answer (#name or "quoted name").
const CHANNEL = /^(?:\s*#?((?:"(\\\\|\\"|[^\\"])*")|(?:[^\s]+)))/i

// Discord's has: answers (Y()), minus poll/sticker which the bridge never
// persists. forward is Discord's `snapshot`.
export const HAS_VALUES = ['image', 'video', 'link', 'file', 'embed', 'sound', 'forward'] as const
export const AUTHOR_TYPE_VALUES = ['user', 'bot', 'webhook'] as const

// H: resolve the username answer to a user id. A name the client hasn't seen
// (typed, not picked from the suggestions) still counts as an answer: it
// carries `data.name` and the server resolves it (username, then display
// name - web and Discord authors alike), so `from:dreamfoid` searches by
// that user like Discord does instead of degrading to free text.
function validateUser(t: Token): boolean {
  const raw = t.group(1) ?? ''
  if (raw.toLowerCase() === '@me') return false
  if (SNOWFLAKE.test(raw)) { t.data.userId = raw; return true }
  const name = (t.group(4) ?? t.group(2) ?? '').trim()
  if (!name) return false
  const id = usersByName.get(name.toLowerCase())?.userId ?? null
  if (id != null) t.data.userId = id
  else t.data.name = name
  return true
}

/** A from:/mentions: answer typed as a name the client couldn't resolve. */
export const isUnresolvedUserAnswer = (t: Token | null | undefined): boolean =>
  t != null && (t.type === 'ANSWER_USERNAME_FROM' || t.type === 'ANSWER_USERNAME_MENTIONS') && typeof t.data.userId !== 'string'


// y(e, map, token): map a has:/authorType: answer (with "-" negation).
function validateEnum(dataKey: string, values: readonly string[]) {
  return (t: Token) => {
    const raw = (t.group(1) ?? '').toLowerCase()
    const neg = raw.startsWith('-')
    const v = neg ? raw.slice(1) : raw
    if (!values.includes(v)) return false
    t.data[dataKey] = neg ? `-${v}` : v
    return true
  }
}

// W: resolve the in: answer to bridged channel ids.
function validateChannel(t: Token): boolean {
  let name = t.group(1) ?? ''
  if (SNOWFLAKE.test(name)) { t.data.channelIds = [name]; return true }
  if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/\\(.)/g, '$1')
  const ids = channels.filter((c) => c.name === name).map((c) => c.channelId)
  if (!ids.length) return false
  t.data.channelIds = ids
  return true
}

// ---- date answers (x(), b(), M(), P(), G(), j()) ---------------------------

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
export const DATE_WORDS = ['today', 'yesterday', 'week', 'month', 'year']

function startOfDay(d: Date) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()) }
function addUnit(d: Date, unit: 'day' | 'week' | 'month' | 'year', n: number) {
  const r = new Date(d)
  if (unit === 'day') r.setDate(r.getDate() + n)
  else if (unit === 'week') r.setDate(r.getDate() + 7 * n)
  else if (unit === 'month') r.setMonth(r.getMonth() + n)
  else r.setFullYear(r.getFullYear() + n)
  return r
}
function startOf(unit: 'day' | 'week' | 'month' | 'year', now = new Date()) {
  const d = startOfDay(now)
  if (unit === 'week') d.setDate(d.getDate() - d.getDay())
  if (unit === 'month') d.setDate(1)
  if (unit === 'year') { d.setMonth(0); d.setDate(1) }
  return d
}

/** Resolve a date answer to [start, end) like Discord's j(). */
export function resolveDate(answer: string): [Date, Date] | null {
  const r = answer.trim().toLowerCase()
  const span = (s: Date, unit: 'day' | 'week' | 'month' | 'year'): [Date, Date] => [s, addUnit(s, unit, 1)]
  if (r === 'today') return span(startOf('day'), 'day')
  if (r === 'yesterday') return span(addUnit(startOf('day'), 'day', -1), 'day')
  if (r === 'week' || r === 'month' || r === 'year') return span(startOf(r), r)
  const mi = MONTHS.indexOf(r)
  if (mi >= 0) return span(new Date(new Date().getFullYear(), mi, 1), 'month')
  const wi = WEEKDAYS.indexOf(r)
  if (wi >= 0) { const s = startOf('week'); s.setDate(s.getDate() + wi); return span(s, 'day') }
  if (/^\d{4}$/.test(r)) {
    const y = Number(r)
    if (y >= 2015 && y <= new Date().getFullYear()) return span(new Date(y, 0, 1), 'year')
    return null
  }
  const m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(r)
  if (!m) return null
  const y = Number(m[1]); const mo = Number(m[2]) - 1; const d = m[3] ? Number(m[3]) : 1
  const date = new Date(y, mo, d)
  if (date.getFullYear() !== y || date.getMonth() !== mo || date.getDate() !== d) return null
  return span(date, 'day')
}

function validateDate(kind: 'before' | 'on' | 'after') {
  return (t: Token) => {
    const range = resolveDate(t.text)
    if (!range) return false
    let [start, end]: [Date | null, Date | null] = range
    if (kind === 'before') { end = start; start = null } else if (kind === 'after') { start = end; end = null }
    t.data.start = start
    t.data.end = end
    return true
  }
}

export const RULES: Rule[] = [
  { type: 'FILTER_FROM', regex: filter('from'), componentType: 'FILTER', key: 'from:' },
  { type: 'ANSWER_USERNAME_FROM', regex: USERNAME, follows: ['FILTER_FROM'], validator: validateUser, mutable: true, componentType: 'ANSWER', queryKey: 'author_id' },
  { type: 'FILTER_MENTIONS', regex: filter('mentions'), componentType: 'FILTER', key: 'mentions:' },
  { type: 'ANSWER_USERNAME_MENTIONS', regex: USERNAME, follows: ['FILTER_MENTIONS'], validator: validateUser, mutable: true, componentType: 'ANSWER', queryKey: 'mentions' },
  { type: 'FILTER_HAS', regex: filter('has'), componentType: 'FILTER', key: 'has:' },
  { type: 'ANSWER_HAS', regex: oneOf([...HAS_VALUES]), follows: ['FILTER_HAS'], validator: validateEnum('has', HAS_VALUES), componentType: 'ANSWER', queryKey: 'has' },
  { type: 'FILTER_BEFORE', regex: filter('before'), componentType: 'FILTER', key: 'before:' },
  { type: 'FILTER_ON', regex: /^(on|during):/i, componentType: 'FILTER', key: 'during:' },
  { type: 'FILTER_AFTER', regex: filter('after'), componentType: 'FILTER', key: 'after:' },
  { type: 'ANSWER_BEFORE', regex: DATE, follows: ['FILTER_BEFORE'], componentType: 'ANSWER', mutable: true, validator: validateDate('before') },
  { type: 'ANSWER_ON', regex: DATE, follows: ['FILTER_ON'], componentType: 'ANSWER', mutable: true, validator: validateDate('on') },
  { type: 'ANSWER_AFTER', regex: DATE, follows: ['FILTER_AFTER'], componentType: 'ANSWER', mutable: true, validator: validateDate('after') },
  { type: 'FILTER_IN', regex: filter('in'), componentType: 'FILTER', key: 'in:' },
  { type: 'ANSWER_IN', regex: CHANNEL, mutable: true, follows: ['FILTER_IN'], componentType: 'ANSWER', validator: validateChannel, queryKey: 'channel_id' },
  { type: 'FILTER_AUTHOR_TYPE', regex: filter('authorType'), componentType: 'FILTER', key: 'authorType:' },
  { type: 'ANSWER_AUTHOR_TYPE', regex: oneOf([...AUTHOR_TYPE_VALUES]), follows: ['FILTER_AUTHOR_TYPE'], validator: validateEnum('author_type', AUTHOR_TYPE_VALUES), componentType: 'ANSWER', queryKey: 'author_type' },
]

export const RULE: Partial<Record<TokenType, Rule>> = Object.fromEntries(RULES.map((r) => [r.type, r]))
const baseRules = RULES.filter((r) => !r.follows)
const followers: Partial<Record<TokenType, Rule[]>> = {}
for (const r of RULES) for (const f of r.follows ?? []) (followers[f] ??= []).push(r)

export const isFilter = (type: TokenType): type is FilterType => type.startsWith('FILTER_')
export const isAnswer = (type: TokenType) => type.startsWith('ANSWER_')
export const isDateFilter = (type: TokenType | null | undefined) => type === 'FILTER_BEFORE' || type === 'FILTER_ON' || type === 'FILTER_AFTER'

function tryRules(rest: string, rules: Rule[] | undefined, offset: number): Token | null {
  if (!rules) return null
  for (const rule of rules) {
    const m = rest.match(rule.regex)
    if (!m) continue
    const t = new Token([...m], rule.type, offset)
    if (rule.validator && !rule.validator(t)) continue
    return t
  }
  return null
}

/** Module 988665 tokenize(). */
export function tokenize(input: string): Token[] {
  const out: Token[] = []
  let rest = input
  let pending = ''
  let pos = 0
  let prev: Token | null = null
  while (rest.length > 0) {
    const offset = pos + pending.length
    let m: Token | null = null
    if (prev && prev.end === offset) m = tryRules(rest, followers[prev.type], offset)
    if (!m) m = tryRules(rest, baseRules, offset)
    if (m) {
      if (pending) out.push(new Token([pending], 'NON_TOKEN', pos))
      prev = m
      out.push(m)
      pos += m.length + pending.length
      rest = rest.slice(m.length)
      pending = ''
    } else {
      pending += rest[0]
      rest = rest.slice(1)
    }
  }
  if (pending) out.push(new Token([pending], 'NON_TOKEN', pos))
  return out
}

/** S.Zh: a filter token only "counts" when an answer follows it. */
export function tokenCounts(t: Token, next: Token | undefined): boolean {
  if (!isFilter(t.type)) return true
  return next != null && isAnswer(next.type)
}

// ---- cursor scope + autocomplete mode (S.zZ / S.Gk) ------------------------

export interface CursorScope {
  previousToken?: Token
  currentToken: Token
  nextToken?: Token
}

export function cursorScope(tokens: Token[], focus: number, anchor: number): CursorScope | null {
  let previousToken: Token | undefined
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (focus >= t.start && focus <= t.end && anchor >= t.start && anchor <= t.end) {
      return { previousToken, currentToken: t, nextToken: tokens[i + 1] }
    }
    previousToken = t
  }
  return null
}

export type ModeType = 'EMPTY' | 'FILTER' | 'FILTER_ALL'
export interface Mode {
  type: ModeType
  filter: FilterType | null
  token: Token | null
}

export function autocompleteMode(scope: CursorScope | null, tokens: Token[]): Mode {
  if (tokens.length === 0) return { type: 'EMPTY', filter: null, token: null }
  if (!scope) return { type: 'FILTER_ALL', filter: null, token: null }
  const { currentToken: i, nextToken: r, previousToken: a } = scope
  // An unresolved typed name is still being completed: keep the member
  // suggestions up (FILTER mode on it) like a NON_TOKEN answer.
  if (isFilter(i.type)) {
    if (r == null || r.type === 'NON_TOKEN' || isUnresolvedUserAnswer(r)) return { type: 'FILTER', filter: i.type, token: r ?? null }
    if (!isAnswer(r.type)) return { type: 'FILTER', filter: i.type, token: null }
  }
  if ((i.type === 'NON_TOKEN' || isUnresolvedUserAnswer(i)) && a && isFilter(a.type)) return { type: 'FILTER', filter: a.type as FilterType, token: i }
  return { type: 'FILTER_ALL', filter: null, token: i.type === 'NON_TOKEN' ? i : null }
}

// ---- tokens → search API params (S.Zf) -------------------------------------

export interface SearchApiQuery {
  content?: string
  authorIds: string[]
  mentionIds: string[]
  // Typed names the client couldn't resolve; the server resolves them.
  authorNames: string[]
  mentionNames: string[]
  has: string[]
  channelIds: string[]
  authorTypes: string[]
  minTime?: string
  maxTime?: string
}

export function buildQuery(tokens: Token[]): SearchApiQuery {
  const q: SearchApiQuery = { authorIds: [], mentionIds: [], authorNames: [], mentionNames: [], has: [], channelIds: [], authorTypes: [] }
  const content: string[] = []
  const add = (list: string[], v: unknown) => { if (typeof v === 'string' && !list.includes(v)) list.push(v) }
  const addName = (list: string[], v: unknown) => { if (typeof v === 'string') add(list, v.toLowerCase()) }
  for (const t of tokens) {
    if (isFilter(t.type)) continue
    switch (t.type) {
      case 'ANSWER_BEFORE':
      case 'ANSWER_ON':
      case 'ANSWER_AFTER': {
        const s = t.data.start as Date | null
        const e = t.data.end as Date | null
        if (s) q.minTime = s.toISOString()
        if (e) q.maxTime = e.toISOString()
        break
      }
      case 'ANSWER_USERNAME_FROM': add(q.authorIds, t.data.userId); addName(q.authorNames, t.data.name); break
      case 'ANSWER_USERNAME_MENTIONS': add(q.mentionIds, t.data.userId); addName(q.mentionNames, t.data.name); break
      case 'ANSWER_HAS': add(q.has, t.data.has); break
      case 'ANSWER_IN': for (const id of (t.data.channelIds as string[]) ?? []) add(q.channelIds, id); break
      case 'ANSWER_AUTHOR_TYPE': add(q.authorTypes, t.data.author_type); break
      default: content.push(t.text.trim())
    }
  }
  const c = content.join(' ').trim()
  if (c) q.content = c
  return q
}

export function queryIsEmpty(q: SearchApiQuery): boolean {
  return !q.content && !q.authorIds.length && !q.mentionIds.length && !q.authorNames.length && !q.mentionNames.length && !q.has.length && !q.channelIds.length && !q.authorTypes.length && !q.minTime && !q.maxTime
}

/** Strip filters with no answer (Discord's K() before searching). */
export function cleanQueryString(input: string): string {
  const tokens = tokenize(input)
  let out = input
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (!tokenCounts(tokens[i], tokens[i + 1])) out = out.slice(0, tokens[i].start) + out.slice(tokens[i].end)
  }
  return out
}

/** Non-filter text of a query (S.Pp). */
export function nonFilterText(tokens: Token[]): string {
  return tokens.map((t) => (t.type === 'NON_TOKEN' ? t.text : '')).join(' ').trim()
}

/** Count of answered filters (the results header "Filters (n)"). */
export function filterCount(tokens: Token[]): number {
  return tokens.filter((t, i) => isFilter(t.type) && tokens[i + 1] && isAnswer(tokens[i + 1].type)).length
}

/** S.TZ: quote a channel name containing spaces/quotes/backslashes. */
export function quoteAnswer(s: string): string {
  if (!/[\\" ]/.test(s)) return s
  return `"${s.replace(/([\\"])/g, '\\$1')}"`
}

/** fuzzysearch (module a() in 304578's ee()): subsequence match. */
export function fuzzy(needle: string, hay: string): boolean {
  const n = needle.toLowerCase(); const h = hay.toLowerCase()
  if (n.length > h.length) return false
  if (n === h) return true
  let j = 0
  outer: for (let i = 0; i < n.length; i++) {
    const c = n.charCodeAt(i)
    while (j < h.length) { if (h.charCodeAt(j++) === c) continue outer }
    return false
  }
  return true
}

// ---- result highlighter (module 738768 wG) ---------------------------------
// Words split on \W+, possessive 's dropped, lower-cased, stop words removed,
// then Snowball-English stemmed; a content word is highlighted when its stem
// is in the query's stem set (code blocks are skipped).

const STOP = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in', 'into', 'is', 'it', 'no', 'not', 'of', 'on', 'or', 'such', 'that', 'the', 'their', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'will', 'with'])
const stripPossessive = (w: string) => w.replace(/('|’|＇)(s|S)$/, '')

export function highlightStems(queryText: string): Set<string> {
  return new Set(queryText.split(/\W+/).map(stripPossessive).filter(Boolean).map((w) => w.toLowerCase()).filter((w) => !STOP.has(w)).map(stem))
}
export function wordMatches(word: string, stems: Set<string>): boolean {
  const w = stripPossessive(word).toLowerCase()
  if (!w || STOP.has(w)) return false
  return stems.has(stem(w))
}

// Porter2 (Snowball English) stemmer, compact implementation.
const V = 'aeiouy'
const isV = (c: string) => V.includes(c)
const DOUBLES = ['bb', 'dd', 'ff', 'gg', 'mm', 'nn', 'pp', 'rr', 'tt']
const LI = 'cdeghkmnrt'
const EXC1: Record<string, string> = { skis: 'ski', skies: 'sky', dying: 'die', lying: 'lie', tying: 'tie', idly: 'idl', gently: 'gentl', ugly: 'ugli', early: 'earli', only: 'onli', singly: 'singl', sky: 'sky', news: 'news', howe: 'howe', atlas: 'atlas', cosmos: 'cosmos', bias: 'bias', andes: 'andes' }
const EXC2 = new Set(['inning', 'outing', 'canning', 'herring', 'earring', 'proceed', 'exceed', 'succeed'])

function regions(w: string): [number, number] {
  let r1 = w.length
  const pre = ['gener', 'commun', 'arsen'].find((p) => w.startsWith(p))
  if (pre) r1 = pre.length
  else for (let i = 1; i < w.length; i++) if (!isV(w[i]) && isV(w[i - 1])) { r1 = i + 1; break }
  let r2 = w.length
  for (let i = r1 + 1; i < w.length; i++) if (!isV(w[i]) && isV(w[i - 1])) { r2 = i + 1; break }
  return [r1, r2]
}
function shortSyllable(w: string, i: number): boolean {
  if (i === 1) return isV(w[0]) && !isV(w[1])
  return i >= 2 && !isV(w[i - 2]) && isV(w[i - 1]) && !isV(w[i]) && !'wxY'.includes(w[i])
}
function isShort(w: string, r1: number) { return r1 >= w.length && shortSyllable(w, w.length - 1) }
function hasVowel(s: string) { for (const c of s) if (isV(c)) return true; return false }

export function stem(word: string): string {
  let w = word.toLowerCase()
  if (w.length <= 2) return w
  if (EXC1[w]) return EXC1[w]
  if (w[0] === "'") w = w.slice(1)
  if (w[0] === 'y') w = 'Y' + w.slice(1)
  for (let i = 1; i < w.length; i++) if (w[i] === 'y' && isV(w[i - 1])) w = w.slice(0, i) + 'Y' + w.slice(i + 1)
  const [r1, r2] = regions(w)
  // Step 0
  for (const s of ["'s'", "'s", "'"]) if (w.endsWith(s)) { w = w.slice(0, -s.length); break }
  // Step 1a
  if (w.endsWith('sses')) w = w.slice(0, -2)
  else if (w.endsWith('ied') || w.endsWith('ies')) w = w.slice(0, -3) + (w.length > 4 ? 'i' : 'ie')
  else if (w.endsWith('us') || w.endsWith('ss')) { /* keep */ }
  else if (w.endsWith('s') && hasVowel(w.slice(0, -2))) w = w.slice(0, -1)
  if (EXC2.has(w)) return w
  // Step 1b
  const step1b = () => {
    for (const s of ['eedly', 'eed']) if (w.endsWith(s)) { if (w.length - s.length >= r1) w = w.slice(0, -s.length) + 'ee'; return }
    for (const s of ['ingly', 'edly', 'ing', 'ed']) {
      if (!w.endsWith(s)) continue
      const base = w.slice(0, -s.length)
      if (!hasVowel(base)) return
      w = base
      if (w.endsWith('at') || w.endsWith('bl') || w.endsWith('iz')) w += 'e'
      else if (DOUBLES.some((d) => w.endsWith(d))) w = w.slice(0, -1)
      else if (isShort(w, regions(w)[0])) w += 'e'
      return
    }
  }
  step1b()
  // Step 1c
  if (w.length > 2 && (w.endsWith('y') || w.endsWith('Y')) && !isV(w[w.length - 2])) w = w.slice(0, -1) + 'i'
  // Step 2
  const S2: Array<[string, string]> = [['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'], ['abli', 'able'], ['entli', 'ent'], ['izer', 'ize'], ['ization', 'ize'], ['ation', 'ate'], ['ator', 'ate'], ['alism', 'al'], ['aliti', 'al'], ['alli', 'al'], ['fulness', 'ful'], ['ousli', 'ous'], ['ousness', 'ous'], ['iveness', 'ive'], ['iviti', 'ive'], ['biliti', 'ble'], ['bli', 'ble'], ['fulli', 'ful'], ['lessli', 'less']]
  let done = false
  for (const [s, rep] of S2.sort((a, b) => b[0].length - a[0].length)) {
    if (w.endsWith(s)) { if (w.length - s.length >= r1) w = w.slice(0, -s.length) + rep; done = true; break }
  }
  if (!done) {
    if (w.endsWith('ogi') && w.length - 3 >= r1 && w[w.length - 4] === 'l') w = w.slice(0, -1)
    else if (w.endsWith('li') && w.length - 2 >= r1 && LI.includes(w[w.length - 3])) w = w.slice(0, -2)
  }
  // Step 3
  const S3: Array<[string, string]> = [['ational', 'ate'], ['tional', 'tion'], ['alize', 'al'], ['icate', 'ic'], ['iciti', 'ic'], ['ical', 'ic'], ['ful', ''], ['ness', '']]
  let s3 = false
  for (const [s, rep] of S3) if (w.endsWith(s)) { if (w.length - s.length >= r1) w = w.slice(0, -s.length) + rep; s3 = true; break }
  if (!s3 && w.endsWith('ative') && w.length - 5 >= r2) w = w.slice(0, -5)
  // Step 4
  const S4 = ['ement', 'ance', 'ence', 'able', 'ible', 'ment', 'ant', 'ent', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize', 'al', 'er', 'ic']
  let s4 = false
  for (const s of S4) if (w.endsWith(s)) { if (w.length - s.length >= r2) w = w.slice(0, -s.length); s4 = true; break }
  if (!s4 && w.endsWith('ion') && w.length - 3 >= r2 && 'st'.includes(w[w.length - 4])) w = w.slice(0, -3)
  // Step 5
  if (w.endsWith('e')) {
    const pos = w.length - 1
    if (pos >= r2 || (pos >= r1 && !shortSyllable(w, pos - 1))) w = w.slice(0, -1)
  } else if (w.endsWith('l') && w.length - 1 >= r2 && w[w.length - 2] === 'l') w = w.slice(0, -1)
  return w.replace(/Y/g, 'y')
}
