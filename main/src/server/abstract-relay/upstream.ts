// Upstream candidates, Bearer auth, failover, and SSE / usage parsing. Port of
// the relay behaviour in metering-relay.md sections 5.1, 5.2 and 6.3.
//
// Secrets: upstream API keys are never logged, returned, or put in error text.

export type UpstreamProtocol = 'openai' | 'anthropic'

export type Candidate = {
  name: string
  baseUrl: string
  apiKey: string
  protocol: UpstreamProtocol
  priority: number
  /** true = a provider we resell and charge for. Only paid upstreams serve Abstract AI models. */
  paid: boolean
  /** true = chat-only (config `chatOnly`). Never in a relay candidate list; see loadCandidates. */
  chatOnly: boolean
}

export type Prepared = {
  path: string
  body: string
  headers?: Record<string, string>
}

export type Attempt = {
  ok: true
  candidate: Candidate
  response: Response
  controller: AbortController
}

export type Failure = {
  ok: false
  /** Status to return to the client: the last upstream status, or 502 after network errors. */
  status: number
  /** The last upstream status, or null when the last attempt never got a response. */
  upstreamStatus: number | null
}

/** Headers-only wait per attempt. Cleared once headers arrive, so streams are not cut. */
const HEADER_TIMEOUT_MS = 120_000
const PLACEHOLDER = 'CHANGE_ME'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validBaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * Every usable entry of config.ai.upstreams, chat-only ones included. Entries
 * that are disabled, malformed, or still hold the CHANGE_ME placeholder are
 * skipped with a warning that names the entry and the reason, never the key.
 * Sorted by priority (lower first), then list order.
 */
export function parseUpstreams(raw: unknown): Candidate[] {
  if (!Array.isArray(raw)) return []
  const out: { candidate: Candidate; index: number }[] = []
  raw.forEach((entry, index) => {
    if (!isObject(entry)) {
      console.warn(`abstract-relay: upstream #${index} is not an object; skipped`)
      return
    }
    if (entry.enabled === false) return
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : `#${index}`
    const baseUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl.trim() : ''
    const apiKey = typeof entry.apiKey === 'string' ? entry.apiKey.trim() : ''
    const protocol = entry.protocol === undefined || entry.protocol === 'openai' ? 'openai'
      : entry.protocol === 'anthropic' ? 'anthropic'
      : null
    const priority = typeof entry.priority === 'number' && Number.isFinite(entry.priority) ? entry.priority : 0

    if (!protocol) {
      console.warn(`abstract-relay: upstream "${name}" has an unknown protocol; skipped`)
      return
    }
    if (!validBaseUrl(baseUrl)) {
      console.warn(`abstract-relay: upstream "${name}" needs an http(s) baseUrl; skipped`)
      return
    }
    if (!apiKey || apiKey === PLACEHOLDER) {
      console.warn(`abstract-relay: upstream "${name}" has no apiKey set; skipped`)
      return
    }
    // Only an explicit paid: true makes an upstream resellable. Anything else is treated as free.
    const paid = entry.paid === true
    // Fails closed: only an absent or explicit false keeps an upstream relay-eligible.
    const chatOnly = entry.chatOnly !== undefined && entry.chatOnly !== false
    out.push({ candidate: { name, baseUrl, apiKey, protocol, priority, paid, chatOnly }, index })
  })
  return out
    .sort((a, b) => a.candidate.priority - b.candidate.priority || a.index - b.index)
    .map((entry) => entry.candidate)
}

/**
 * The relay candidates: usable upstreams that are not chat-only. Every /v1 route and the
 * Abstract send path use this list, so a chat-only upstream can never serve an API request.
 */
export function loadCandidates(raw: unknown): Candidate[] {
  return parseUpstreams(raw).filter((candidate) => !candidate.chatOnly)
}

/** Base URL without a trailing /v1, then the request path (upstreamURL, proxy.go:469-475). */
export function upstreamUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
  return `${base}${path}`
}

function upstreamHeaders(candidate: Candidate, extra: Record<string, string> | undefined): Record<string, string> {
  // Only an allowlist goes upstream. Client cookies and client credentials never do.
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    // Keeps upstream bodies uncompressed, so the relay can forward them byte for byte.
    'accept-encoding': 'identity',
    authorization: `Bearer ${candidate.apiKey}`,
    ...extra,
  }
}

/**
 * Tries candidates in order. Any transport error or any status >= 400 moves on
 * to the next one, as in Abstract (failoverStatus, proxy.go:184-186). A
 * successful attempt returns its open response and the controller that owns it,
 * so the caller can abort the upstream when the client leaves.
 */
export async function sendWithFailover(
  candidates: Candidate[],
  prepare: (candidate: Candidate) => Prepared,
): Promise<Attempt | Failure> {
  let lastStatus: number | null = null
  for (const candidate of candidates) {
    const prepared = prepare(candidate)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(upstreamUrl(candidate.baseUrl, prepared.path), {
        method: 'POST',
        headers: upstreamHeaders(candidate, prepared.headers),
        body: prepared.body,
        signal: controller.signal,
      })
    } catch {
      clearTimeout(timer)
      lastStatus = null
      continue
    }
    clearTimeout(timer)
    if (response.status < 400) return { ok: true, candidate, response, controller }
    lastStatus = response.status
    await response.body?.cancel().catch(() => {})
  }
  return { ok: false, status: lastStatus ?? 502, upstreamStatus: lastStatus }
}

/** Splits an SSE byte stream into `data:` payloads. Keeps partial lines across chunks. */
export class SseDataLines {
  private pending = ''

  push(text: string): string[] {
    this.pending += text
    const lines = this.pending.split('\n')
    this.pending = lines.pop() ?? ''
    return lines.flatMap(dataOf)
  }

  flush(): string[] {
    const rest = this.pending
    this.pending = ''
    return dataOf(rest)
  }
}

function dataOf(line: string): string[] {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
  if (!trimmed.startsWith('data:')) return []
  return [trimmed.slice(5).replace(/^ /, '')]
}

export type TokenUsage = { input: number; output: number }

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

function usageBlock(value: unknown): TokenUsage | null {
  if (!isObject(value)) return null
  const input = count(value.prompt_tokens) ?? count(value.input_tokens)
  const output = count(value.completion_tokens) ?? count(value.output_tokens)
  if (input === null && output === null) return null
  return { input: input ?? 0, output: output ?? 0 }
}

/**
 * Usage from one parsed body or event. Covers chat (`usage`), Responses
 * (`response.usage`) and Anthropic (`message.usage` on message_start, `usage`
 * on message_delta).
 */
export function usageFrom(value: unknown): TokenUsage | null {
  if (!isObject(value)) return null
  return usageBlock(value.usage)
    ?? usageBlock(isObject(value.response) ? value.response.usage : undefined)
    ?? usageBlock(isObject(value.message) ? value.message.usage : undefined)
}

/** Keeps the largest value seen for each field, since streams report usage in pieces. */
export class UsageTracker {
  input = 0
  output = 0
  seen = false

  observe(value: unknown): void {
    const usage = usageFrom(value)
    if (!usage) return
    this.seen = true
    this.input = Math.max(this.input, usage.input)
    this.output = Math.max(this.output, usage.output)
  }

  /** Reported usage, or null when the upstream sent none. */
  reported(): TokenUsage | null {
    return this.seen ? { input: this.input, output: this.output } : null
  }
}
