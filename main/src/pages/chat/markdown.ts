// Discord message markdown, ported 1:1 from the live client.
//
// Discord parses message content with its fork of simple-markdown (web.js
// module 478676) and the message rule set in module 999915 (`RULES`, merged
// with the override block `X`), rendered by the react rules in 247186. This
// file ports that engine and every rule a chat message uses - same regexes,
// same rule orders / qualities / requiredFirstCharacters, same state flags -
// and renders the AST to an HTML string (the chat injects message HTML).
//
// Engine (simple-markdown fork):
//   - rules are sorted by `order`, then rules with a `quality` first, then by
//     name; rules with `requiredFirstCharacters` are only tried when the
//     source starts with one of them (bucketed per first character, tried
//     before the generic bucket).
//   - the lowest-order match wins; among equal orders, a strictly higher
//     quality replaces the current match (em/strong/u/looseEm compete on
//     length this way, which is what makes `***x***` an <em><strong>).
//   - each nested parse copies the state (and caps depth at 1000).
//   - messages parse with inline = true, allowHeading/allowList/allowLinks.
//   - after parsing: adjacent text nodes merge, a node nested in a node of
//     the same type is flattened, and the AST is capped at 200 non-text nodes.
//
// Output safety: every piece of message text is HTML-escaped; tags/attributes
// come only from this renderer; link hrefs are produced by URL parsing and
// only http(s) targets become anchors (Discord's other allowed schemes -
// mailto/tel/sms/discord - render as their plain text here).

export interface MdNode {
  type: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

type Capture = RegExpExecArray | (string[] & { index?: number })

export interface MdState {
  inline?: boolean
  prevCapture?: Capture | null
  inQuote?: boolean
  nested?: boolean
  _list?: boolean
  _listLevel?: number
  _parseDepth?: number
  allowHeading?: boolean
  allowList?: boolean
  allowLinks?: boolean
  allowEscape?: boolean
  allowSubtext?: boolean
  parseInlineCodeChildContent?: boolean
  disableAutoBlockNewlines?: boolean
  emojiFromName?: (name: string) => string | null
}

type NestedParse = (source: string, state?: MdState) => MdNode[]

interface Rule {
  order: number
  first?: string[]
  quality?: (capture: Capture, state: MdState, prev: string) => number
  match: (source: string, state: MdState, prev: string) => Capture | null
  parse: (capture: Capture, parse: NestedParse, state: MdState) => MdNode | MdNode[]
}

// ---------------------------------------------------------------------------
// simple-markdown helpers
// ---------------------------------------------------------------------------

const inlineRegex = (re: RegExp) => (source: string, state: MdState) => (state.inline ? re.exec(source) : null)
const blockRegex = (re: RegExp) => (source: string, state: MdState) => (state.inline ? null : re.exec(source))
const anyScopeRegex = (re: RegExp) => (source: string) => re.exec(source)

function parseInline(parse: NestedParse, content: string, state: MdState): MdNode[] {
  const wasInline = state.inline || false
  state.inline = true
  const result = parse(content, state)
  state.inline = wasInline
  return result
}

const parseCaptureInline = (capture: Capture, parse: NestedParse, state: MdState): MdNode => ({
  type: '',
  content: parseInline(parse, capture[1], state),
})

const unescapeUrl = (url: string) => url.replace(/\\([^0-9A-Za-z\s])/g, '$1')

function preprocess(source: string): string {
  return source.replace(/\r\n?/g, '\n').replace(/\f/g, '').replace(/\t/g, '    ')
}

function parserFor(rules: Record<string, Rule>) {
  const names = Object.keys(rules)
  names.sort((a, b) => {
    const ra = rules[a]
    const rb = rules[b]
    if (ra.order !== rb.order) return ra.order - rb.order
    const qa = ra.quality ? 0 : 1
    const qb = rb.quality ? 0 : 1
    if (qa !== qb) return qa - qb
    return a < b ? -1 : a > b ? 1 : 0
  })
  const byChar = new Map<number, string[]>()
  const generic: string[] = []
  for (const name of names) {
    const first = rules[name].first
    if (!first) {
      generic.push(name)
      continue
    }
    for (const ch of first) {
      const code = ch.charCodeAt(0)
      if (!byChar.has(code)) byChar.set(code, [])
      byChar.get(code)!.push(name)
    }
  }

  let latest: MdState = {}
  const nested: NestedParse = (input, stateIn) => {
    const out: MdNode[] = []
    let state = stateIn || latest
    const depth = (state._parseDepth ?? 0) + 1
    if (depth > 1000) {
      if (input) out.push({ type: 'text', content: input })
      return out
    }
    state = latest = { ...state, _parseDepth: depth }
    let source = input
    while (source) {
      let ruleName = ''
      let rule: Rule | null = null
      let capture: Capture | null = null
      let quality = -1e5
      let bestOrder = 1e5
      for (const list of [byChar.get(source.charCodeAt(0)), generic]) {
        if (!list) continue
        for (const name of list) {
          const r = rules[name]
          if (r.order > bestOrder) break
          const prev = state.prevCapture == null ? '' : state.prevCapture[0]
          const c = r.match(source, state, prev)
          if (c) {
            const q = r.quality ? r.quality(c, state, prev) : 0
            if (r.order < bestOrder || q > quality) {
              ruleName = name
              rule = r
              capture = c
              quality = q
              bestOrder = r.order
            }
          }
        }
      }
      // The text rule always matches; these guards only stop a malformed
      // match from looping forever.
      if (!rule || !capture || capture.index || !capture[0]) {
        out.push({ type: 'text', content: source.charAt(0) })
        state.prevCapture = [source.charAt(0)]
        source = source.substring(1)
        continue
      }
      const parsed = rule.parse(capture, nested, state)
      if (Array.isArray(parsed)) out.push(...parsed)
      else {
        if (!parsed.type) parsed.type = ruleName
        out.push(parsed)
      }
      state.prevCapture = capture
      source = source.substring(capture[0].length)
    }
    return out
  }

  return (source: string, state: MdState): MdNode[] => {
    latest = state
    if (!state.inline && !state.disableAutoBlockNewlines) source += '\n\n'
    state.prevCapture = null
    return nested(preprocess(source), state)
  }
}

// ---------------------------------------------------------------------------
// URL sanitizing (Discord modules 417964 / 694403 / 721779)
// ---------------------------------------------------------------------------

const INVISIBLE_FILLERS = ['\u034F', '\u17B4', '\u17B5', '\u1160', '\u3164', '\uFFA0']
const INVISIBLE_RE = new RegExp(`${/\p{Cf}|\p{Zl}|\p{Zp}|[^\P{Cc}\n]|[^\P{Zs} ]/u.source}|${INVISIBLE_FILLERS.join('|')}`, 'gu')

// Discord's whitespaceSanitized(): strips format/control/separator chars
// (except '\n' and ' ') and Hangul/Khmer filler glyphs.
function stripInvisible(s: string): string {
  return s.replace(INVISIBLE_RE, '')
}

const HOMOGLYPHS: Array<[string, RegExp]> = ([
  ['h', ['H','\u04BB','\u0570','\u13C2','\u210E','\uD835\uDC21','\uD835\uDC89','\uD835\uDCBD','\uD835\uDCF1','\uD835\uDD25','\uD835\uDD59','\uD835\uDD8D','\uD835\uDDC1','\uD835\uDDF5','\uD835\uDE29','\uD835\uDE5D','\uD835\uDE91','\uFF48']],
  ['t', ['T','\uD835\uDC2D','\uD835\uDC61','\uD835\uDC95','\uD835\uDCC9','\uD835\uDCFD','\uD835\uDD31','\uD835\uDD65','\uD835\uDD99','\uD835\uDDCD','\uD835\uDE01','\uD835\uDE35','\uD835\uDE69','\uD835\uDE9D']],
  ['p', ['P','\u03C1','\u03F1','\u0440','\u2374','\u2CA3','\uD835\uDC29','\uD835\uDC5D','\uD835\uDC91','\uD835\uDCC5','\uD835\uDCF9','\uD835\uDD2D','\uD835\uDD61','\uD835\uDD95','\uD835\uDDC9','\uD835\uDDFD','\uD835\uDE31','\uD835\uDE65','\uD835\uDE99','\uD835\uDED2','\uD835\uDEE0','\uD835\uDF0C','\uD835\uDF1A','\uD835\uDF46','\uD835\uDF54','\uD835\uDF80','\uD835\uDF8E','\uD835\uDFBA','\uD835\uDFC8','\uFF50','\u048F']],
  ['s', ['S','\u01BD','\u0455','\uA731','\uABAA','\uD801\uDC48','\uD806\uDCC1','\uD835\uDC2C','\uD835\uDC60','\uD835\uDC94','\uD835\uDCC8','\uD835\uDCFC','\uD835\uDD30','\uD835\uDD64','\uD835\uDD98','\uD835\uDDCC','\uD835\uDE00','\uD835\uDE34','\uD835\uDE68','\uD835\uDE9C','\uFF53']],
  [':', ['\u02D0','\u02F8','\u0589','\u05C3','\u0703','\u0704','\u0903','\u0A83','\u16EC','\u1803','\u1809','\u205A','\u2236','\uA4FD','\uA789','\uFE30','\uFF1A',';','\u037E']],
  ['/', ['\u1735','\u2041','\u2044','\u2215','\u2571','\u27CB','\u29F8','\u2CC6','\u2F03','\u3033','\u30CE','\u31D3','\u4E3F','\uD834\uDE3A']],
] as Array<[string, string[]]>).map(([ch, list]) => [ch, new RegExp(list.join('|'), 'gu')])

// Discord's fullySanitized(): whitespace-sanitized + homoglyphs of the
// characters that spell a URL scheme folded to ASCII.
function foldHomoglyphs(s: string): string {
  let out = s
  for (const [ch, re] of HOMOGLYPHS) out = out.replace(re, ch)
  return out
}

function safeDecodeURIComponent(s: string): string | null {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

// ASCII chars Discord shows decoded in a link's display text (1) vs keeps
// percent-encoded (0).
const URL_DISPLAY_SAFE = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0]

function isUnsafeDisplayCodePoint(t: number): boolean {
  return t === 8206 || t === 8207 || t === 8234 || t === 8235 || t === 8236 || t === 8237 || t === 8238 || t === 1564 || t === 8294 || t === 8295 || t === 8296 || t === 8297 || t === 128271 || t === 128272 || t === 128274 || t === 128275 || t === 133 || t === 160 || t === 5760 || (t >= 8192 && t <= 8202) || t === 8232 || t === 8233 || t === 8239 || t === 8287 || t === 12288 || t === 10240 || t === 173 || t === 847 || (t >= 1536 && t <= 1541) || t === 1757 || t === 1807 || t === 2274 || t === 4447 || t === 4448 || t === 6068 || t === 6069 || (t >= 6155 && t <= 6158) || (t >= 8203 && t <= 8205) || (t >= 8288 && t <= 8293) || (t >= 8298 && t <= 8303) || t === 12644 || (t >= 65520 && t <= 65528) || (t >= 65024 && t <= 65039) || t === 65279 || t === 65440 || t === 65529 || t === 65530 || t === 65531 || t === 69821 || t === 69837 || (t >= 78896 && t <= 78904) || (t >= 113824 && t <= 113827) || (t >= 119155 && t <= 119162) || (t >= 917504 && t <= 921599)
}

// Decode a URL component for display, keeping anything confusable encoded.
function decodeForDisplay(e: string): string {
  const decoded = safeDecodeURIComponent(e)
  if (decoded == null) return e
  let out = ''
  let raw = e
  let dec = decoded
  while (raw.length > 0) {
    const rc = raw.codePointAt(0)!
    const dc = dec.codePointAt(0)!
    if (rc === dc) {
      const ch = String.fromCodePoint(rc)
      out += ch
      raw = raw.substring(ch.length)
      dec = dec.substring(ch.length)
      continue
    }
    const ch = String.fromCodePoint(dc)
    const enc = encodeURIComponent(ch)
    const skip = enc === ch ? 3 : enc.length
    const keepEncoded = dc >= 0 && dc < 128 ? URL_DISPLAY_SAFE[dc] !== 1 : isUnsafeDisplayCodePoint(dc)
    out += keepEncoded ? enc : ch
    raw = raw.substring(skip)
    dec = dec.substring(ch.length)
  }
  return out
}

function normalizeUrl(u: URL): string {
  let base: string
  if (u.origin === 'null' && u.pathname.startsWith('//')) base = u.protocol
  else {
    let auth = ''
    if (u.username !== '') auth += u.username
    if (u.password !== '') auth += ':' + u.password
    if (auth !== '') auth += '@'
    const slashes = u.href.substr(u.protocol.length, 2) === '//'
    base = `${u.protocol}${slashes ? '//' : ''}${auth}${u.host}`
  }
  return base + decodeForDisplay(u.pathname) + decodeForDisplay(u.search) + decodeForDisplay(u.hash)
}

function toUrl(s: string): URL | null {
  try {
    return new URL(s)
  } catch {
    return null
  }
}

// Discord's isSuspiciousUrl: invisible characters, unparseable, or an http(s)
// URL whose host part is percent-encoded / malformed.
function suspiciousUrl(e: string): boolean {
  if (stripInvisible(e) !== e) return true
  const u = toUrl(e)
  if (u == null) return true
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const parts = e.split('/')
  return parts.length < 3 || parts[1] !== '' || safeDecodeURIComponent(parts[2]) !== parts[2]
}

const ALLOWED_PROTOCOLS = ['http:', 'https:', 'discord:', 'tel:', 'sms:', 'mailto:']

function validateUrl(e: string): { target: string; display: string } | null {
  if (suspiciousUrl(e)) return null
  const u = toUrl(e)
  if (!u) return null
  const protocol = u.protocol.toLowerCase()
  if (!ALLOWED_PROTOCOLS.includes(protocol)) return null
  if ((protocol === 'http:' || protocol === 'https:') && !u.hostname) return null
  const target = normalizeUrl(u)
  u.username = ''
  u.password = ''
  return { target, display: normalizeUrl(u) }
}

const IPV4 = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)){3}'
const URL_FIND_RE = new RegExp(`(?:(?:(?:https?:)?//)|www\\.)(?:[^\\s:@]+(?::[^\\s@]*)?@)?(?:localhost|${IPV4}|(?:[a-z\\u00a1-\\uffff0-9-_]+\\.)+(?:(?:[a-z\\u00a1-\\uffff]{2,})))(?::\\d{2,5})?(?:[/?#][^\\s"()\\[\\]<>]*)?`, 'ig')
const DISCORD_HOST_RE = /((https?:\/\/[^ ]*)|^|\s)(discord\.gg|discord\.new|discord\.com|discordapp\.com)/g
const CODE_SPAN_RE = /`{3,}[\s\S]*?(?:`{3,}|$)|(`{1,2})[^`]+\1(?!`)/g

// Discord's findUrls (721779 Ay) - only its "is there any URL" answer is used.
function containsUrl(text: string): boolean {
  const s = text
    .replace(DISCORD_HOST_RE, (m, lead: string, url: string | undefined, host: string) => (url == null ? `${lead}http://${host}` : m))
    .replace(CODE_SPAN_RE, ' ')
  URL_FIND_RE.lastIndex = 0
  return URL_FIND_RE.test(s)
}

// ---------------------------------------------------------------------------
// Rules (module 999915 RULES + override block, 704726 text, 873879 list,
// 223637 heading, 683412 subtext, 694403 link, 379418 timestamp)
// ---------------------------------------------------------------------------

const TEXT_RE = /^[\s\S]+?(?=[^0-9A-Za-z\s\u00c0-\uffff]|\n\n| {2,}\n|\w+:\S|[0-9]+\.|$)/
const HEADING_RE = /^ *(#{1,3})(?:\s+)((?!\s*#{1,3}\s)[^\n]+?)#*\s*(?:\n|$)/
const SUBTEXT_RE = /^ *-# +((?!-#)[^\n]+)(?:\n|$)/
const ENDS_NEWLINE = /\n$/
const CODE_BLOCK_RE = /^```(?:([a-z0-9_+\-.#]+?)\n)?\n*([^\n][^]*?)\n*```/i
const BLOCK_QUOTE_RE = /^( *>>> +([\s\S]*))|^( *>(?!>>) +[^\n]*(\n *>(?!>>) +[^\n]*)*\n?)/
const BLOCK_QUOTE_PREV_RE = /^$|\n *$/
const TRIPLE_QUOTE_PREFIX = /^ *>>> ?/
const QUOTE_PREFIX = /^ *> ?/gm
const URL_RE = /^((?:https?|steam):\/\/[^\s<]+[^<.,:;"'\]\s])/
// 258072: Discord CDN / media-proxy attachment URLs (`/attachments/` or
// `/ephemeral-attachments/`, two snowflakes, file name, simple query).
export const ATTACHMENT_LINK_RE = /^https:\/\/(?:[A-Za-z0-9-]+\.)*(?:(?:media|images)(?:-[A-Za-z0-9]+)?\.discordapp\.net|(?:cdn(?:-[A-Za-z0-9]+)?\.discordapp\.com))\/(?:attachments|ephemeral-attachments)\/\d+\/\d+\/([A-Za-z0-9._-]*[A-Za-z0-9_-])(?:[?][a-zA-Z0-9?&=_-]*)?/
// Discord's AttachmentIcon (paperclip, size xs = 16px) for attachmentLink.
const ATTACHMENT_ICON_SVG = '<svg class="attachmentLinkIcon" aria-hidden="true" role="img" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24"><path fill="currentColor" d="M10.57 4.01a6.97 6.97 0 0 1 9.86 0l.54.55a6.99 6.99 0 0 1 0 9.88l-7.26 7.27a1 1 0 0 1-1.42-1.42l7.27-7.26a4.99 4.99 0 0 0 0-7.06L19 5.43a4.97 4.97 0 0 0-7.02 0l-8.02 8.02a3.24 3.24 0 1 0 4.58 4.58l6.24-6.24a1.12 1.12 0 0 0-1.58-1.58l-3.5 3.5a1 1 0 0 1-1.42-1.42l3.5-3.5a3.12 3.12 0 1 1 4.42 4.42l-6.24 6.24a5.24 5.24 0 0 1-7.42-7.42l8.02-8.02Z"></path></svg>'
const INLINE_CODE_RE = /^(`+)([\s\S]*?[^`])\1(?!`)/
const INLINE_CODE_TRIM = /^ (?= *`)|(` *) $/g
const EM_RE = /^\b_((?:__|\\[\s\S]|[^\\_])+?)_\b|^\*(?=\S)((?:\*\*|\\[\s\S]|\s+(?:\\[\s\S]|[^\s*\\]|\*\*)|[^\s*\\])+?)\*(?!\*)/
const LOOSE_EM_RE = /^\*(?=\S)((?:\*\*|\\[\s\S]|\s+(?:\\[\s\S]|[^\s*\\]|\*\*)|[^\s*\\])+?) {1,2}\*(?!\*)/
const STRONG_RE = /^\*\*((?:\\[\s\S]|[^\\])+?)\*\*(?!\*)/
const UNDERLINE_RE = /^__((?:\\[\s\S]|[^\\])+?)__(?!_)/
const STRIKE_RE = /^~~([\s\S]+?)~~(?!_)/
const SPOILER_RE = /^\|\|([\s\S]+?)\|\|/
const TIMESTAMP_RE = /^<t:(-?\d{1,17})(?::(t|T|d|D|f|F|s|S|R))?>/
const EMOJI_NAME_RE = /^:([^\s:]+?(?:::skin-tone-\d)?):/
const COMMAND_MENTION_RE = /^<\/((?:[-_\p{Letter}\p{Number}\p{sc=Deva}\p{sc=Thai}]{1,32})(?: [-_\p{Letter}\p{Number}\p{sc=Deva}\p{sc=Thai}]{1,32})?(?: [-_\p{Letter}\p{Number}\p{sc=Deva}\p{sc=Thai}]{1,32})?):(\d+)>/u

const LINK_INSIDE = '(?:\\[[^\\]]*\\]|[^\\[\\]]|\\](?=[^\\[]*\\]))*'
const LINK_HREF_AND_TITLE = '\\s*<?((?:\\([^)]*\\)|[^\\s\\\\()]|\\\\.)*?)>?(?:\\s+[\'"]([\\s\\S]*?)[\'"])?\\s*'
const LINK_RE = new RegExp('^\\[(' + LINK_INSIDE + ')\\]\\(' + LINK_HREF_AND_TITLE + '\\)')

// List (873879)
const LIST_BULLET = '(?:[*-]|\\d+\\.)'
const LIST_ITEM_PREFIX = '(%INDENT%)(' + LIST_BULLET + ') +'
const LIST_ITEM_PREFIX_RE = new RegExp('^' + LIST_ITEM_PREFIX.replace('%INDENT%', ' *'))
const LIST_ITEM_TEMPLATE = LIST_ITEM_PREFIX + '[^\\n]*(?:\\n(?!%INDENT%' + LIST_BULLET + ' )[^\\n]*)*(\n|$)'
const LIST_ITEM_TRAILING = / *\n$/
const LIST_SOURCE = '^( *)(' + LIST_BULLET + ') [\\s\\S]+?(?:\\n(?! )(?!\\1' + LIST_BULLET + ' )|$)'
const LIST_RE = new RegExp(LIST_SOURCE)
const LIST_AFTER_NEWLINE_RE = new RegExp('^\\n' + LIST_SOURCE.slice(1))
const LIST_TRAILING_NEWLINES = /\n{2,}$/
const LEADING_NEWLINE = /^\n/
const PREV_ENDS_NEWLINE_SPACES = /\n *$/
const PREV_LINE_INDENT = /(?:^|\n)( *)$/
const WHITESPACE_ONLY = /^[ \t\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$/

const textNode = (content: string): MdNode => ({ type: 'text', content })

function urlNode(url: string): MdNode {
  const v = validateUrl(url)
  if (v == null) return textNode(url)
  return { type: 'link', content: [textNode(v.display)], target: v.target, title: undefined }
}

// Masked-link label / title node-type allowlists (694403).
const LABEL_BASE = ['text', 'u', 'strong', 'em', 's', 'inlineCode', 'spoiler', 'br', 'timestamp']
const LABEL_BLOCKS = ['list', 'heading', 'blockQuote', 'subtext']
const LABEL_TYPES = [...LABEL_BASE, ...LABEL_BLOCKS]
const TITLE_TYPES = ['text', 'u', 'strong', 'em', 's', 'inlineCode', 'spoiler', 'br', 'timestamp', 'emoji', 'customEmoji', ...LABEL_BLOCKS]
// Discord's text rule splits emoji surrogates into emoji nodes; ours keeps
// them in the text (twemoji runs on the rendered HTML), so the allowlist
// check looks for them directly.
const EMOJI_IN_TEXT = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u

function onlyTypes(nodes: MdNode | MdNode[] | undefined, allowed: string[], extraForCode: string[] = []): MdNode[] | null {
  const list = Array.isArray(nodes) ? nodes : [nodes]
  for (const n of list) {
    if (n === undefined || !allowed.includes(n.type)) return null
    if (n.type === 'text' && typeof n.content === 'string' && !allowed.includes('emoji') && EMOJI_IN_TEXT.test(n.content)) return null
    if (n.type === 'inlineCode' && onlyTypes(n.validationChildContent, [...allowed, ...extraForCode]) == null) return null
    if (Array.isArray(n.content) && onlyTypes(n.content, allowed) == null) return null
  }
  return list as MdNode[]
}

function plainText(nodes: MdNode[]): string {
  let out = ''
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
      case 'inlineCode':
        out += n.content
        break
      case 'customEmoji':
        out += n.name
        break
      case 'emoji':
        out += n.surrogate
        break
      case 'br':
        out += '\n'
        break
      case 'strong':
      case 'em':
      case 'u':
      case 's':
      case 'spoiler':
        out += plainText(n.content)
        break
      case 'timestamp':
        out += '<timestamp>'
        break
      case 'blockQuote':
      case 'list':
      case 'heading':
      case 'subtext':
        out += `<${n.type}Content>`
        break
      default:
        break
    }
  }
  return out
}

const RULES: Record<string, Rule> = {
  heading: {
    order: 0,
    first: [' ', '#'],
    match: (s, st, prev) => (st.allowHeading && (prev === '' || ENDS_NEWLINE.test(prev)) ? HEADING_RE.exec(s) : null),
    parse: (c, parse, st) => ({ type: 'heading', level: c[1].length, content: parseInline(parse, c[2].trim(), st) }),
  },
  subtext: {
    order: 0,
    first: ['-'],
    match: (s, st, prev) => (st.allowSubtext === false ? null : prev === '' || ENDS_NEWLINE.test(prev) ? SUBTEXT_RE.exec(s) : null),
    parse: (c, parse, st) => ({ type: 'subtext', content: parseInline(parse, c[1].trim(), { ...st, allowSubtext: false }) }),
  },
  customEmoji: {
    order: 4,
    first: ['<'],
    match: anyScopeRegex(/^<(a)?:(\w+):(\d+)>/),
    parse: (c) => ({ type: 'customEmoji', emojiId: c[3], name: c[2], animated: c[1] === 'a' }),
  },
  codeBlock: {
    order: 4,
    first: ['`'],
    match: anyScopeRegex(CODE_BLOCK_RE),
    parse: (c, _p, st) => ({ type: 'codeBlock', lang: c[1] ?? '', content: c[2] ?? '', inQuote: st.inQuote || false }),
  },
  blockQuote: {
    order: 6,
    first: [' ', '>'],
    match: (s, st) => {
      if (st.inQuote || st.nested) return null
      if (st.prevCapture == null) return BLOCK_QUOTE_RE.exec(s)
      return BLOCK_QUOTE_PREV_RE.test(st.prevCapture[0]) ? BLOCK_QUOTE_RE.exec(s) : null
    },
    parse: (c, parse, st) => {
      const all = c[0]
      const triple = TRIPLE_QUOTE_PREFIX.test(all)
      const content = triple ? all.replace(TRIPLE_QUOTE_PREFIX, '') : all.replace(QUOTE_PREFIX, '')
      const wasQuote = st.inQuote || false
      const wasInline = st.inline || false
      st.inQuote = true
      if (!triple) st.inline = true
      const nodes = parse(content, st)
      st.inQuote = wasQuote
      st.inline = wasInline
      if (nodes.length === 0) nodes.push(textNode(' '))
      return { type: 'blockQuote', content: nodes }
    },
  },
  list: {
    order: 7,
    first: '\n *-0123456789'.split(''),
    match: (s, st) => {
      if (!st.allowList || (st._listLevel ?? 0) >= 11) return null
      const prev = st.prevCapture == null ? '' : st.prevCapture[0]
      if (s.charCodeAt(0) === 10) return prev === '' || PREV_ENDS_NEWLINE_SPACES.test(prev) ? null : LIST_AFTER_NEWLINE_RE.exec(s)
      const indent = PREV_LINE_INDENT.exec(prev)
      return indent == null || WHITESPACE_ONLY.test(indent[0]) ? null : LIST_RE.exec(s)
    },
    parse: (c, parse, st) => {
      const bullet = c[2]
      const ordered = bullet.length > 1
      const start = ordered ? Math.min(1e9, Math.max(1, +bullet)) : undefined
      const consumedLeadingNewline = LEADING_NEWLINE.test(c[0])
      const source = c[0].replace(LEADING_NEWLINE, '').replace(LIST_TRAILING_NEWLINES, '\n')
      const first = LIST_ITEM_PREFIX_RE.exec(source)
      const prefixLength = first != null ? first[0].length : 0
      const indentLength = first != null ? first[1].length : 0
      const indent = ` {${indentLength},${indentLength + 1}}`
      const itemRe = new RegExp(LIST_ITEM_TEMPLATE.replaceAll('%INDENT%', indent), 'gm')
      const outdent = new RegExp('^ {1,' + prefixLength + '}', 'gm')
      const raw = source.match(itemRe)
      if (raw == null) return textNode(c[0])
      let lastWasLoose = false
      const items = raw.map((item, i) => {
        const content = item.replace(LIST_ITEM_PREFIX_RE, '').replace(outdent, '')
        const isLast = i === raw.length - 1
        const loose = content.indexOf('\n\n') !== -1 || (isLast && lastWasLoose)
        lastWasLoose = loose
        const wasInline = st.inline
        const wasList = st._list
        const wasLevel = st._listLevel
        st._list = true
        st._listLevel = (wasLevel ?? 0) + 1
        let adjusted: string
        if (loose) {
          st.inline = false
          adjusted = content.replace(LIST_ITEM_TRAILING, '\n\n')
        } else {
          st.inline = true
          adjusted = content.replace(LIST_ITEM_TRAILING, '')
        }
        const nodes = parse(adjusted, { ...st, allowHeading: false }).map((n) => {
          if (n.type === 'text' && typeof n.content === 'string') n.content = n.content.replace(/\n+\s*$/, '')
          return n
        })
        st.inline = wasInline
        st._list = wasList
        st._listLevel = wasLevel
        return nodes
      })
      return { type: 'list', ordered, start, items, consumedLeadingNewline }
    },
  },
  newline: {
    order: 10,
    first: ['\n'],
    match: blockRegex(/^(?:\n *)*\n/),
    parse: () => ({ type: 'newline' }),
  },
  paragraph: {
    order: 11,
    match: blockRegex(/^((?:[^\n]|\n(?! *\n))+)(?:\n *)+\n/),
    parse: (c, parse, st) => ({ ...parseCaptureInline(c, parse, st), type: 'paragraph' }),
  },
  escape: {
    order: 12,
    first: ['\\'],
    match: (s, st) => (st.allowEscape === false ? null : inlineRegex(/^\\([^0-9A-Za-z\s])/)(s, st)),
    parse: (c) => textNode(c[1]),
  },
  autolink: {
    order: 14,
    first: ['<'],
    match: inlineRegex(/^<([^: >]+:\/[^ >]+)>/),
    parse: (c) => ({ ...urlNode(c[1]), autolink: true }),
  },
  mailto: {
    order: 15,
    first: ['<'],
    match: inlineRegex(/^<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/),
    parse: (c) => ({ type: 'link', content: [textNode(c[1])], target: c[1].startsWith('mailto:') ? c[1] : `mailto:${c[1]}` }),
  },
  tel: {
    order: 15,
    first: ['<'],
    match: inlineRegex(/^<((?:(?:tel|sms):\+?|\+)(?:(?:[0-9]|\([0-9]+\)))(?:[- ./]?(?:[0-9]|\([0-9]+\)))+)>/),
    parse: (c) => {
      const target = c[1].replaceAll(/[ /]+/g, '-')
      return { type: 'link', content: [textNode(c[1])], target: target.startsWith('tel:') || target.startsWith('sms:') ? target : `tel:${target}` }
    },
  },
  // 258072 attachmentLink (order url - 0.5): a Discord CDN attachment URL
  // renders as a paperclip + the bare file name instead of the long signed URL.
  attachmentLink: {
    order: 15.5,
    first: ['h'],
    match: (s) => ATTACHMENT_LINK_RE.exec(s),
    parse: (c) => (validateUrl(c[0]) == null
      ? textNode(c[0])
      : { type: 'attachmentLink', content: [textNode(c[1])], attachmentUrl: c[0], attachmentName: c[1] }),
  },
  url: {
    order: 16,
    first: ['h', 's'],
    match: (s, st) => {
      if (!st.inline) return null
      const m = URL_RE.exec(s)
      if (m != null) {
        let from = 0
        let t = m[0]
        for (let i = t.length - 1; i >= 0 && t[i] === ')'; i--) {
          const open = t.indexOf('(', from)
          if (open === -1) {
            t = t.slice(0, t.length - 1)
            break
          }
          from = open + 1
        }
        m[0] = m[1] = t
      }
      return m
    },
    parse: (c) => urlNode(c[1]),
  },
  link: {
    order: 17,
    first: ['['],
    match: (s, st) => {
      if (!st.allowLinks || s.indexOf('](') === -1) return null
      let depth = 0
      let parens = 0
      let deep = 0
      for (let i = 0; i < s.length; i++) {
        const ch = s[i]
        if (depth >= 2) {
          if (++deep > 100) return null
        } else deep = 0
        if (ch === ')') {
          parens = 0
          continue
        }
        if (ch === '[') {
          if (++depth > 10) return null
        } else if (ch === ']') {
          if (depth > 0) depth--
        } else if (ch !== '(') continue
        if (++parens > 200) return null
      }
      return inlineRegex(LINK_RE)(s, st)
    },
    parse: (c, parse, st) => {
      const [full, label, href, title] = c
      const asText = () => textNode(full)
      if (suspiciousUrl(href)) return asText()
      const hrefClean = stripInvisible(href)
      const labelClean = stripInvisible(label)
      const labelFolded = foldHomoglyphs(labelClean)
      const titleFolded = foldHomoglyphs(stripInvisible(title ?? ''))
      if (hrefClean.trim().length === 0 || labelFolded.trim().length === 0) return asText()
      const target = validateUrl(unescapeUrl(href))
      if (target == null) return asText()
      const vstate: MdState = { ...st, allowEscape: false, parseInlineCodeChildContent: true }
      const labelNodes = onlyTypes(parse(labelFolded, vstate), LABEL_TYPES, ['emoji'])
      const titleNodes = onlyTypes(parse(titleFolded, vstate), TITLE_TYPES)
      if (labelNodes == null || titleNodes == null) return asText()
      const shown = plainText(labelNodes)
      if (shown.trim().length === 0 || containsUrl(shown)) return asText()
      if (shown !== labelFolded && (containsUrl(labelFolded) || onlyTypes(parse(shown, vstate), [...LABEL_TYPES, 'emoji']) == null)) return asText()
      const content = labelParser(labelClean, { ...vstate })
      return { type: 'link', content, target: target.target, title: stripInvisible(title ?? '') || undefined }
    },
  },
  em: {
    order: 21,
    match: inlineRegex(EM_RE),
    quality: (c) => c[0].length + 0.2,
    parse: (c, parse, st) => ({ type: 'em', content: parse(c[2] || c[1], st) }),
  },
  looseEm: {
    order: 21,
    match: inlineRegex(LOOSE_EM_RE),
    quality: (c) => c[0].length + 0.2,
    parse: (c, parse, st) => ({ type: 'em', content: parse(c[1], st) }),
  },
  strong: {
    order: 21,
    first: ['*'],
    match: inlineRegex(STRONG_RE),
    quality: (c) => c[0].length + 0.1,
    parse: (c, parse, st) => ({ ...parseCaptureInline(c, parse, st), type: 'strong' }),
  },
  u: {
    order: 21,
    first: ['_'],
    match: inlineRegex(UNDERLINE_RE),
    quality: (c) => c[0].length,
    parse: (c, parse, st) => ({ ...parseCaptureInline(c, parse, st), type: 'u' }),
  },
  s: {
    order: 21,
    first: ['~'],
    match: inlineRegex(STRIKE_RE),
    parse: (c, parse, st) => ({ ...parseCaptureInline(c, parse, st), type: 's' }),
  },
  inlineCode: {
    order: 23,
    first: ['`'],
    match: inlineRegex(INLINE_CODE_RE),
    parse: (c, parse, st) => {
      const content = c[2].replace(INLINE_CODE_TRIM, '$1')
      const node: MdNode = { type: 'inlineCode', content }
      if (st.parseInlineCodeChildContent === true) node.validationChildContent = parse(content, st)
      return node
    },
  },
  br: {
    order: 24,
    first: [' '],
    match: anyScopeRegex(/^ {2,}\n/),
    parse: () => ({ type: 'br' }),
  },
  timestamp: {
    order: 24,
    first: ['<'],
    match: anyScopeRegex(TIMESTAMP_RE),
    parse: (c) => {
      const node = timestampNode(c[1], c[2])
      return node ?? textNode(c[0])
    },
  },
  emoticon: {
    order: 25,
    first: ['\u00af'],
    match: (s) => /^(\u00af\\_\(\u30c4\)_\/\u00af)/.exec(s),
    parse: (c) => textNode(c[1]),
  },
  emoji: {
    order: 25,
    first: [':'],
    match: (s, st) => {
      const m = EMOJI_NAME_RE.exec(s)
      if (m == null || !st.emojiFromName) return null
      const surrogate = st.emojiFromName(m[1])
      return surrogate ? m : null
    },
    parse: (c, _p, st) => {
      const surrogate = st.emojiFromName?.(c[1])
      return surrogate ? { type: 'emoji', name: `:${c[1]}:`, surrogate } : textNode(c[0])
    },
  },
  mention: {
    order: 25,
    first: ['<', '@'],
    match: (s) => /^<@!?(\d+)>|^(@(?:everyone|here))/.exec(s),
    parse: (c) => (c[1] != null ? { type: 'mention', userId: c[1], raw: c[0] } : { type: 'mention', everyone: c[2].slice(1) }),
  },
  roleMention: {
    order: 25,
    first: ['<'],
    match: (s) => /^<@&(\d+)>/.exec(s),
    parse: (c) => ({ type: 'roleMention', roleId: c[1] }),
  },
  channelMention: {
    order: 25,
    first: ['<'],
    match: (s) => /^<#(\d+)>/.exec(s),
    parse: (c) => ({ type: 'channelMention', channelId: c[1] }),
  },
  commandMention: {
    order: 25,
    first: ['<'],
    match: (s) => COMMAND_MENTION_RE.exec(s),
    parse: (c) => ({ type: 'commandMention', name: c[1], commandId: c[2] }),
  },
  spoiler: {
    order: 25,
    first: ['|'],
    match: (s) => SPOILER_RE.exec(s),
    parse: (c, parse, st) => ({ type: 'spoiler', content: parse(c[1], st) }),
  },
  text: {
    order: 25,
    match: anyScopeRegex(TEXT_RE),
    parse: (c) => textNode(c[0]),
  },
}

const parser = parserFor(RULES)
// Masked-link labels re-parse with only the formatting rules (694403: pick
// text/u/strong/em/s/inlineCode/spoiler/br/timestamp).
const labelParser = parserFor(Object.fromEntries(LABEL_BASE.map((k) => [k, RULES[k]])))

// ---------------------------------------------------------------------------
// Timestamps (379418): moment formats for en-US, R = fromNow() with
// Discord's thresholds (s: 60, ss: -1, m: 60).
// ---------------------------------------------------------------------------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const pad2 = (n: number) => String(n).padStart(2, '0')

function fmtLT(d: Date, seconds: boolean): string {
  const h = d.getHours()
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${pad2(d.getMinutes())}${seconds ? `:${pad2(d.getSeconds())}` : ''} ${h < 12 ? 'AM' : 'PM'}`
}
const fmtL = (d: Date) => `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}`
const fmtLL = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`

function fromNow(d: Date, now: number): string {
  const diff = d.getTime() - now
  const ms = Math.abs(diff)
  const seconds = Math.round(ms / 1000)
  const minutes = Math.round(ms / 60000)
  const hours = Math.round(ms / 3600000)
  const days = Math.round(ms / 864e5)
  const monthsExact = (ms / 864e5) * 4800 / 146097
  const months = Math.round(monthsExact)
  const years = Math.round(monthsExact / 12)
  let rel: string
  if (seconds < 60) rel = `${seconds} seconds`
  else if (minutes <= 1) rel = 'a minute'
  else if (minutes < 60) rel = `${minutes} minutes`
  else if (hours <= 1) rel = 'an hour'
  else if (hours < 22) rel = `${hours} hours`
  else if (days <= 1) rel = 'a day'
  else if (days < 26) rel = `${days} days`
  else if (months <= 1) rel = 'a month'
  else if (months < 11) rel = `${months} months`
  else if (years <= 1) rel = 'a year'
  else rel = `${years} years`
  return diff > 0 ? `in ${rel}` : `${rel} ago`
}

export function formatDiscordTimestamp(date: Date, format: string | undefined, now = Date.now()): string {
  switch (format) {
    case 't': return fmtLT(date, false)
    case 'T': return fmtLT(date, true)
    case 'd': return fmtL(date)
    case 'D': return fmtLL(date)
    case 'F': return `${WEEKDAYS[date.getDay()]}, ${fmtLL(date)} ${fmtLT(date, false)}`
    case 's': return `${fmtL(date)} ${fmtLT(date, false)}`
    case 'S': return `${fmtL(date)} ${fmtLT(date, true)}`
    case 'R': return fromNow(date, now)
    case 'f':
    default: return `${fmtLL(date)} ${fmtLT(date, false)}`
  }
}

function timestampNode(unix: string, format: string | undefined): MdNode | null {
  const date = new Date(Number(unix) * 1000)
  if (Number.isNaN(date.getTime())) return null
  return { type: 'timestamp', timestamp: unix, format, date }
}

// ---------------------------------------------------------------------------
// Post-processing (919535): merge text, flatten same-type nesting, cap at
// 200 non-text nodes.
// ---------------------------------------------------------------------------

function mergeText(nodes: MdNode[]): void {
  let prev: MdNode | null = null
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (prev == null || prev.type !== 'text' || n.type !== 'text' || typeof prev.content !== 'string' || typeof n.content !== 'string') {
      prev = n
      continue
    }
    prev.content += n.content
    nodes.splice(i, 1)
    i--
  }
}

function flatten(nodes: MdNode[], parent: MdNode | null): MdNode[] {
  const out: MdNode[] = []
  for (const n of nodes) {
    const r = flattenNode(n, parent)
    if (Array.isArray(r)) out.push(...r)
    else out.push(r)
  }
  mergeText(out)
  return out
}

function flattenNode(n: MdNode, parent: MdNode | null): MdNode | MdNode[] {
  if (Array.isArray(n.content)) n.content = flatten(n.content, n)
  if (n.type === 'inlineCode') delete n.validationChildContent
  if (n.type === 'list') n.items = n.items.map((item: MdNode[]) => (Array.isArray(item) ? flatten(item, null) : item))
  return parent != null && n.type === parent.type && Array.isArray(n.content) ? n.content : n
}

const BAIL = Symbol('bail')

function capArray(nodes: MdNode[], budget: { left: number }): MdNode[] {
  for (let i = 0; i < nodes.length; i++) {
    const r = capNode(nodes[i], budget)
    if (r === BAIL) {
      nodes.length = i
      break
    }
  }
  return nodes
}

function capNode(n: MdNode, budget: { left: number }): MdNode | typeof BAIL {
  if (n.type === 'text') return n
  budget.left -= 1
  if (budget.left <= 0) return BAIL
  if (Array.isArray(n.content)) n.content = capArray(n.content, budget)
  if (n.type === 'list') n.items = n.items.map((item: MdNode[]) => capArray(item, budget))
  return n
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface MarkdownOptions {
  allowLinks?: boolean
  allowHeading?: boolean
  allowList?: boolean
  // Mention chips: return the chip HTML, or null for an unknown target
  // (Discord then shows @unknown-user / @unknown-role / #unknown).
  userMention?: (id: string) => string | null
  roleMention?: (id: string) => string | null
  channelMention?: (id: string) => string | null
  everyoneMention?: (which: 'everyone' | 'here') => string | null
  // :name: → emoji surrogate (Discord's emoji rule); null when unknown.
  emojiFromName?: (name: string) => string | null
  // Syntax highlighting for fenced blocks: escaped HTML + the language class,
  // or null to render the block plain.
  highlight?: (lang: string, code: string) => { html: string; language: string } | null
  now?: number
}

export function parseMarkdown(source: string, options: MarkdownOptions = {}): MdNode[] {
  if (!source) return []
  const state: MdState = {
    inline: true,
    allowLinks: options.allowLinks ?? true,
    allowHeading: options.allowHeading ?? true,
    allowList: options.allowList ?? true,
    disableAutoBlockNewlines: true,
    emojiFromName: options.emojiFromName,
  }
  const ast = flatten(parser(source, state), null)
  return capArray(ast, { left: 200 })
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
}

// Discord's CopyIcon / CheckmarkLargeIcon (size xs = 16px).
export const COPY_ICON_SVG = '<svg aria-hidden="true" role="img" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24"><path fill="currentColor" d="M3 16a1 1 0 0 1-1-1v-5a8 8 0 0 1 8-8h5a1 1 0 0 1 1 1v.5a.5.5 0 0 1-.5.5H10a6 6 0 0 0-6 6v5.5a.5.5 0 0 1-.5.5H3Z"></path><path fill="currentColor" d="M6 18a4 4 0 0 0 4 4h8a4 4 0 0 0 4-4v-4h-3a5 5 0 0 1-5-5V6h-4a4 4 0 0 0-4 4v8Z"></path><path fill="currentColor" d="M21.73 12a3 3 0 0 0-.6-.88l-4.25-4.24a3 3 0 0 0-.88-.61V9a3 3 0 0 0 3 3h2.73Z"></path></svg>'
export const CHECK_ICON_SVG = '<svg aria-hidden="true" role="img" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24"><path fill="currentColor" d="M21.7 5.3a1 1 0 0 1 0 1.4l-12 12a1 1 0 0 1-1.4 0l-6-6a1 1 0 1 1 1.4-1.4L9 16.58l11.3-11.3a1 1 0 0 1 1.4 0Z"></path></svg>'

const CODE_CLASS = 'scrollbarGhostHairline scrollbar hljs'

function renderNodes(nodes: MdNode[], o: MarkdownOptions): string {
  let out = ''
  for (const n of nodes) out += renderNode(n, o)
  return out
}

function renderNode(n: MdNode, o: MarkdownOptions): string {
  const inner = () => (Array.isArray(n.content) ? renderNodes(n.content, o) : escapeHtml(String(n.content ?? '')))
  switch (n.type) {
    case 'text':
      return escapeHtml(n.content)
    case 'emoji':
      return escapeHtml(n.surrogate)
    case 'em':
      return `<em>${inner()}</em>`
    case 'strong':
      return `<strong>${inner()}</strong>`
    case 'u':
      return `<u>${inner()}</u>`
    case 's':
      return `<s>${inner()}</s>`
    case 'br':
      return '<br>'
    case 'newline':
      return '\n'
    case 'paragraph':
      return `<p>${inner()}</p>`
    case 'spoiler':
      return `<span class="spoiler" role="button" tabindex="0" aria-label="Spoiler">${inner()}</span>`
    case 'inlineCode':
      return `<code class="inline">${escapeHtml(n.content)}</code>`
    case 'codeBlock': {
      const lang = String(n.lang || '')
      const hl = lang ? o.highlight?.(lang, n.content) ?? null : null
      const code = hl
        ? `<code class="${CODE_CLASS} ${escapeHtml(hl.language)}">${hl.html}</code>`
        : `<code class="${CODE_CLASS}">${escapeHtml(n.content)}</code>`
      return `<pre><div class="codeContainer"><div class="codeActions"><div class="codeCopyButton" role="button" tabindex="0" aria-label="Copy Code">${COPY_ICON_SVG}</div></div>${code}</div></pre>`
    }
    case 'blockQuote':
      return `<div class="blockquoteContainer"><div class="blockquoteDivider"></div><blockquote>${inner()}</blockquote></div>`
    case 'heading': {
      const level = Math.min(3, Math.max(1, Number(n.level) || 1))
      return `<h${level}><span>${inner()}</span></h${level}>`
    }
    case 'subtext':
      return `<small><span>${inner()}</span></small>`
    case 'list': {
      const tag = n.ordered ? 'ol' : 'ul'
      let attrs = ''
      if (n.start != null) {
        const start = Number(n.start)
        const chars = String(start + (n.items.length - 1)).length
        attrs = ` start="${start}" style="--totalCharacters: ${chars}; --olCounterStart: ${start - 1};"`
      }
      const items = (n.items as MdNode[][]).map((item) => `<li><span>${renderNodes(item, o)}</span></li>`).join('')
      return `<${tag}${attrs}>${items}</${tag}>`
    }
    case 'link': {
      const body = renderNodes(n.content, o)
      const target = String(n.target || '')
      if (!/^https?:\/\//i.test(target)) return body
      const title = n.title ? ` title="${escapeHtml(n.title)}"` : ''
      return `<a class="anchor" href="${escapeHtml(target)}"${title} target="_blank" rel="noreferrer noopener" role="button" tabindex="0">${body}</a>`
    }
    case 'attachmentLink': {
      const target = String(n.attachmentUrl || '')
      if (!/^https:\/\//i.test(target)) return renderNodes(n.content, o)
      // Discord's attachmentLink span: mention-style chip (wrapper_f61d60) +
      // interactive hover. Anchor kept for href/target/keyboard semantics;
      // the label is the bare file name in its own span.
      return `<a class="anchor attachmentLink wrapper_f61d60 interactive" href="${escapeHtml(target)}" target="_blank" rel="noreferrer noopener" role="link" tabindex="0">${ATTACHMENT_ICON_SVG}<span>${renderNodes(n.content, o)}</span></a>`
    }
    case 'customEmoji': {
      const id = String(n.emojiId).replace(/\D/g, '')
      const name = String(n.name).replace(/\W/g, '')
      const src = n.animated
        ? `https://cdn.discordapp.com/emojis/${id}.gif?size=40&amp;quality=lossless`
        : `https://cdn.discordapp.com/emojis/${id}.webp?size=40`
      return `<img class="emoji" data-type="emoji" data-id="${id}" draggable="false" src="${src}" data=":${name}:" alt=":${name}:">`
    }
    case 'mention': {
      if (n.everyone) {
        const which = n.everyone === 'here' ? 'here' : 'everyone'
        return o.everyoneMention?.(which) ?? `<span class="mention" data-mention-type="everyone">@${which}</span>`
      }
      return o.userMention?.(String(n.userId)) ?? '<span class="mention">@unknown-user</span>'
    }
    case 'roleMention':
      return o.roleMention?.(String(n.roleId)) ?? '@unknown-role'
    case 'channelMention':
      return o.channelMention?.(String(n.channelId)) ?? '<span class="mention">#<em>unknown</em></span>'
    case 'commandMention':
      return `<span class="mention commandMention">/${escapeHtml(n.name)}</span>`
    case 'timestamp': {
      const date = n.date as Date
      const shown = formatDiscordTimestamp(date, n.format, o.now)
      const full = formatDiscordTimestamp(date, 'F', o.now)
      return `<span class="timestampInline" data-md-tooltip="${escapeHtml(full)}">${escapeHtml(shown)}</span>`
    }
    default:
      return Array.isArray(n.content) ? renderNodes(n.content, o) : typeof n.content === 'string' ? escapeHtml(n.content) : ''
  }
}

export function renderMarkdown(source: string, options: MarkdownOptions = {}): string {
  return renderNodes(parseMarkdown(source, options), options)
}

// Whether the source contains a fenced code block (lets callers subscribe to
// the lazily-loaded highlighter only when it matters).
export function hasCodeBlock(source: string | null | undefined): boolean {
  return !!source && source.includes('```')
}

// Apply `fn` (twemoji) to the HTML outside <code> elements: Discord never
// turns emoji inside inline code or code blocks into images.
export function mapOutsideCode(html: string, fn: (part: string) => string): string {
  return html
    .split(/(<code\b[^>]*>[\s\S]*?<\/code>)/)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join('')
}

// Click delegation for the code-block copy button (Discord's codeActions
// CopyIcon → CheckmarkLargeIcon once the text is on the clipboard). Returns
// true when the click was on a copy button.
export function handleCodeCopyClick(target: Element | null): boolean {
  const button = target?.closest('.codeCopyButton') as HTMLElement | null
  if (!button) return false
  const code = button.closest('.codeContainer')?.querySelector('code')
  const text = code?.textContent ?? ''
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
  if (!clip?.writeText) return true
  clip.writeText(text).then(
    () => { button.innerHTML = CHECK_ICON_SVG },
    () => { button.innerHTML = COPY_ICON_SVG },
  )
  return true
}

// Whether a message (content, embed text or component text) has a fenced
// block, i.e. whether it needs the highlighter.
export function messageHasCodeBlock(message: { content?: string | null; embeds?: unknown }): boolean {
  if (hasCodeBlock(message.content)) return true
  const embeds = Array.isArray(message.embeds) ? message.embeds : []
  return embeds.length > 0 && JSON.stringify(embeds).includes('```')
}
