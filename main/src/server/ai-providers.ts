

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { callCloudflarePlayground, isCloudflarePlaygroundEndpoint } from './cloudflare-playground.js'
import { resolveModel } from '../ai-models.js'
import { pinnedPost, type PinnedAddress } from './ai-settings/pinned-post.js'

export type EndpointType = 'chat-completions' | 'responses' | 'messages' | 'gemini' | 'cloudflare-playground'

export interface ProviderConfig {
  baseUrl: string
  apiKey: string
  model: string
  endpoint: EndpointType
  auth: 'api-key' | 'gcloud'
  // User-supplied endpoint (ai-settings/send-route.ts). The model id and thinking
  // pass through unchanged, redirects are refused, and `connect` pins the socket
  // to an address that was validated just before the call.
  verbatim?: boolean
  connect?: PinnedAddress
}

export interface TextPart {
  type: 'text'
  text: string
}

export interface ImagePart {
  type: 'image_url'
  image_url: { url: string }
}
export type MessageContent = string | Array<TextPart | ImagePart>

export interface ChatInputMessage {
  role: 'user' | 'assistant' | 'system'
  content: MessageContent
}

export interface ProviderResult {
  status: number
  text: string

  tokens?: number
  inputTokens?: number
  outputTokens?: number

  reply?: string
}

export interface CallOptions {
  thinking?: string

  tools?: ToolSpec[]

  /** The tool names this turn may use. The Cloudflare playground's MCP session enforces it on tools/list and tools/call. */
  allowedTools?: string[]

  /** Whose browser workspace runs the client tools, and which turn they belong to. The MCP route needs it to reach the browser. */
  toolBridge?: { ownerKey: string; threadId: string }

  runTool?: (call: ToolCall) => Promise<string>

  onText?: (delta: string) => void

  onThinking?: (delta: string) => void

  onToolEvent?: (event: ToolEvent) => void

  // Aborts the upstream request (used for hard timeouts, e.g. avatar moderation).
  signal?: AbortSignal
}

export interface ToolSpec {
  name: string
  description: string

  inputSchema: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string

  argsJson: string
}

/** Largest tool output kept on a message for the UI. The model still receives the full result. */
export const TOOL_OUTPUT_KEEP = 20_000

export interface ToolEvent {
  phase: 'start' | 'end'
  callId: string
  tool: string
  title: string
  args?: Record<string, unknown>
  ok?: boolean
  summary?: string
  durationMs?: number
  /** The text the model received for this call, kept for the UI (a terminal card shows it). */
  output?: string
}

export function detectEndpoint(baseUrl: string, explicit?: string): EndpointType {
  if (
    explicit === 'chat-completions'
    || explicit === 'responses'
    || explicit === 'messages'
    || explicit === 'gemini'
    || explicit === 'cloudflare-playground'
  ) {
    return explicit
  }
  const url = baseUrl.toLowerCase()
  if (url.includes('playground.ai.cloudflare.com')) return 'cloudflare-playground'
  if (url.includes('generativelanguage') || url.includes('googleapis')) return 'gemini'
  if (url.includes('anthropic') || url.endsWith('/messages')) return 'messages'
  if (url.endsWith('/responses')) return 'responses'
  return 'chat-completions'
}

function readProvider(cfg: { baseUrl?: string; apiKey?: string; model?: string; endpoint?: string; auth?: string } | undefined): ProviderConfig | null {
  const baseUrl = (cfg?.baseUrl || '').trim().replace(/\/$/, '')
  const apiKey = (cfg?.apiKey || '').trim()
  const model = (cfg?.model || '').trim()
  const auth = cfg?.auth === 'gcloud' ? 'gcloud' : 'api-key'
  if (!baseUrl || (auth === 'api-key' && !apiKey)) return null
  return { baseUrl, apiKey, model, endpoint: detectEndpoint(baseUrl, cfg?.endpoint), auth }
}

type ProviderInput = { baseUrl?: string; apiKey?: string; model?: string; endpoint?: string; auth?: string }
export type ProviderSet = {
  free: ProviderConfig | null
  premium: ProviderConfig | null
  vertex: ProviderConfig | null
  cloudflare: ProviderConfig | null
}

const CLOUDFLARE_DEFAULT_MODEL = 'glm-5.3'

function cloudflareProvider(ai: { cloudflare?: { enabled?: boolean; defaultModel?: string } } | undefined): ProviderConfig | null {
  if (ai?.cloudflare?.enabled === false) return null
  return {
    baseUrl: 'https://playground.ai.cloudflare.com',
    apiKey: '',
    model: resolveModel(ai?.cloudflare?.defaultModel || CLOUDFLARE_DEFAULT_MODEL).id || '',
    endpoint: 'cloudflare-playground',
    auth: 'api-key',
  }
}

export function loadProviders(ai: {
  free?: ProviderInput
  premium?: ProviderInput
  vertex?: ProviderInput
  cloudflare?: { enabled?: boolean; defaultModel?: string }
} | undefined): ProviderSet {
  const free = readProvider(ai?.free)
  const premium = readProvider(ai?.premium)
  const vertex = readProvider(ai?.vertex)
  const cloudflare = cloudflareProvider(ai)

  if (vertex) return { free: free || vertex, premium, vertex, cloudflare }
  return { free: free || premium, premium: premium || free, vertex: null, cloudflare }
}

const execFileAsync = promisify(execFile)
let gcloudToken: { value: string; refreshAt: number } | undefined

// The Cloud SDK installs outside the default PATH (typically ~/google-cloud-sdk/bin),
// and systemd units do not inherit an interactive shell's PATH, so a bare "gcloud"
// spawn fails with ENOENT under the service but works fine in a terminal.
const gcloudCandidates = [
  process.env.GCLOUD_BIN,
  process.env.CLOUDSDK_HOME ? `${process.env.CLOUDSDK_HOME}/bin/gcloud` : '',
  process.env.HOME ? `${process.env.HOME}/google-cloud-sdk/bin/gcloud` : '',
  '/root/google-cloud-sdk/bin/gcloud',
  '/usr/local/google-cloud-sdk/bin/gcloud',
  '/opt/google-cloud-sdk/bin/gcloud',
  '/usr/lib/google-cloud-sdk/bin/gcloud',
  '/usr/local/bin/gcloud',
  '/usr/bin/gcloud',
].filter((path): path is string => Boolean(path))

let gcloudBin: string | undefined

async function resolveGcloudBin(): Promise<string> {
  if (gcloudBin) return gcloudBin
  for (const candidate of gcloudCandidates) {
    try {
      await execFileAsync(candidate, ['--version'], { timeout: 10_000 })
      gcloudBin = candidate
      return candidate
    } catch {
      continue
    }
  }
  throw new Error('gcloud CLI not found. Install the Cloud SDK or set GCLOUD_BIN to its absolute path.')
}

async function bearerToken(config: ProviderConfig): Promise<string> {
  if (config.auth !== 'gcloud') return config.apiKey
  if (gcloudToken && Date.now() < gcloudToken.refreshAt) return gcloudToken.value
  const { stdout } = await execFileAsync(await resolveGcloudBin(), ['auth', 'print-access-token'], { timeout: 15_000 })
  const value = stdout.trim()
  if (!value) throw new Error('gcloud did not return an access token; run `gcloud auth login`.')

  gcloudToken = { value, refreshAt: Date.now() + 50 * 60_000 }
  return value
}

async function authHeaders(config: ProviderConfig): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await bearerToken(config)}` }
}

function contentText(content: MessageContent): string {
  if (typeof content === 'string') return content
  return content.filter((p): p is TextPart => p.type === 'text').map((p) => p.text).join('\n')
}

function toPrompt(messages: ChatInputMessage[]): string {
  return messages.map((m) => `${m.role === 'user' ? 'User' : m.role === 'system' ? 'System' : 'Assistant'}: ${contentText(m.content)}`).join('\n\n')
}

export interface SseEvent {

  event: string

  data: string
}

async function readSse(res: Response, onEvent: (event: SseEvent) => void): Promise<void> {
  if (res.status < 200 || res.status >= 300) {

    const text = await res.text()
    let message = `provider HTTP ${res.status}`
    try {
      const json = JSON.parse(text) as { error?: { message?: string } | string }
      message = String((typeof json.error === 'object' ? json.error?.message : json.error) || message)
    } catch { /* keep default */ }
    throw new Error(message)
  }
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = ''
  let dataLines: string[] = []
  const flush = () => {
    if (!dataLines.length) { eventName = ''; return }
    onEvent({ event: eventName, data: dataLines.join('\n') })
    eventName = ''
    dataLines = []
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      if (line === '') { flush(); continue }
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) { eventName = line.slice(6).trim(); continue }
      if (line.startsWith('data:')) { dataLines.push(line.slice(5).replace(/^ /, '')) }
    }
  }
  flush()
}

async function postStream(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal, config?: ProviderConfig): Promise<Response> {
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers },
    body: JSON.stringify(body),
    signal,
  }
  if (config?.connect) return pinnedPost(url, config.connect, init.headers, init.body, signal)
  return fetch(url, config?.verbatim ? { ...init, redirect: 'error' } : init)
}

// Image input parts arrive in the OpenAI chat-completions shape
// ({ type: 'image_url', image_url: { url: 'data:<mime>;base64,<data>' } }).
// Only inline base64 data URLs are converted for the other endpoint types;
// remote image URLs are never fetched or forwarded.
function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = /^data:([a-z0-9.+/-]+);base64,([a-z0-9+/=]+)$/i.exec(url)
  return match ? { mimeType: match[1].toLowerCase(), data: match[2] } : null
}

function hasImageParts(messages: ChatInputMessage[]): boolean {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'))
}

function toResponsesContent(content: MessageContent): unknown {
  if (typeof content === 'string') return content
  return content.flatMap<Record<string, unknown>>((p) => {
    if (p.type === 'text') return [{ type: 'input_text', text: p.text }]
    return parseDataUrl(p.image_url.url) ? [{ type: 'input_image', image_url: p.image_url.url }] : []
  })
}

function toMessagesContent(content: MessageContent): unknown {
  if (typeof content === 'string') return content
  return content.flatMap<Record<string, unknown>>((p) => {
    if (p.type === 'text') return [{ type: 'text', text: p.text }]
    const img = parseDataUrl(p.image_url.url)
    return img ? [{ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } }] : []
  })
}

function toGeminiParts(content: MessageContent): Array<Record<string, unknown>> {
  if (typeof content === 'string') return [{ text: content }]
  return content.flatMap<Record<string, unknown>>((p) => {
    if (p.type === 'text') return [{ text: p.text }]
    const img = parseDataUrl(p.image_url.url)
    return img ? [{ inline_data: { mime_type: img.mimeType, data: img.data } }] : []
  })
}

function isTransientProviderError(status: number, json: Record<string, unknown>): boolean {
  if (status === 408 || status === 409 || status === 425 || status === 429) return true
  if (status >= 500) return true
  if (status >= 400 && status < 500) {
    const msg = String((json.error as { message?: string } | undefined)?.message ?? json.error ?? '').toLowerCase()
    if (msg.includes('not found') || msg.includes('overloaded') || msg.includes('temporarily') || msg.includes('unavailable') || msg.includes('try again')) return true
    // Cloudflare's content filter occasionally blocks benign prompts ("run ls") with "Blocked for: <reason>".
    // A retry usually passes.
    if (msg.includes('blocked for')) return true
  }
  return false
}

async function postStreamWithRetry(config: ProviderConfig, body: unknown): Promise<Response> {
  const url = `${config.baseUrl}/chat/completions`
  const headers = await authHeaders(config)
  let res = await postStream(url, headers, body, undefined, config)
  for (let attempt = 1; attempt <= 2 && res.status >= 400; attempt++) {

    const text = await res.text()
    let json: Record<string, unknown>
    try { json = JSON.parse(text) } catch { json = { error: text } }
    if (!isTransientProviderError(res.status, json)) {
      throw new Error(String((json.error as { message?: string } | undefined)?.message || json.error || `provider HTTP ${res.status}`))
    }
    await new Promise((r) => setTimeout(r, attempt === 1 ? 250 : 750))
    res = await postStream(url, headers, body, undefined, config)
  }
  if (res.status >= 400) {
    const text = await res.text()
    let message = `provider HTTP ${res.status}`
    try {
      const json = JSON.parse(text) as { error?: { message?: string } | string }
      message = String((typeof json.error === 'object' ? json.error?.message : json.error) || message)
    } catch { /* keep default */ }
    throw new Error(message)
  }
  return res
}

/**
 * The reasoning fields of a chat-completions body. A level is reasoning_effort. 'off' is the upstream's disable switch,
 * which chat-engine sends only for a model whose check verified it (model-catalog.ts THINKING_VERIFIED).
 */
export function reasoningFields(thinking: string | undefined): Record<string, unknown> {
  if (!thinking) return {}
  return thinking === 'off' ? { thinking: { type: 'disabled' } } : { reasoning_effort: thinking }
}

export function normalizeModelAndThinking(
  config: ProviderConfig,
  rawModel: string | undefined,
  options?: CallOptions,
): { model: string; thinking: string | undefined } {
  // User-supplied endpoint: send the model id and thinking exactly as given. Only
  // pinned chat-completions endpoints may use this, so no other path can skip the pin.
  if (config.verbatim) {
    if (config.endpoint !== 'chat-completions' || !config.connect) {
      throw new Error('verbatim AI providers must be pinned chat-completions endpoints')
    }
    return { model: (rawModel || '').trim() || config.model, thinking: options?.thinking }
  }
  let model = (rawModel || '').trim()
  if (!model || model === 'auto') {
    model = (config.model || '').trim()
  }
  // 'off' is a switch only the chat-completions body carries (reasoningFields). Other endpoints send no thinking for it.
  let thinking = options?.thinking === 'off' && config.endpoint !== 'chat-completions' ? undefined : options?.thinking

  if (config.baseUrl.includes('chat.eli.gift')) {
    if (!model || model === 'auto' || model === 'gemini-3.8-flash') {
      model = config.model || 'gemini-3.8-flash-high'
    }
    return { model, thinking }
  }

  if (config.endpoint === 'gemini') {
    return { model, thinking }
  }

  if (config.baseUrl.includes('aiplatform.googleapis.com') && !model.includes('/')) {
    model = `google/${model}`
  }

  const match = model.match(/-(max|high|medium|low)$/i)
  if (match) {
    if (!thinking) {
      thinking = match[1].toLowerCase()
    }
    model = model.slice(0, -match[0].length)
  }

  return { model, thinking }
}

export async function callProvider(config: ProviderConfig, messages: ChatInputMessage[], modelOverride?: string, options?: CallOptions): Promise<ProviderResult> {
  const { model, thinking } = normalizeModelAndThinking(config, modelOverride, options)
  const normalizedOptions: CallOptions = { ...options, thinking }
  if (isCloudflarePlaygroundEndpoint(config.endpoint)) {
    const result = await callCloudflarePlayground(messages, model || config.model, normalizedOptions)
    return {
      status: 200,
      text: JSON.stringify({ reply: result.text }),
      tokens: result.tokens,
      reply: result.text,
    }
  }
  switch (config.endpoint) {
    case 'chat-completions': {
      const res = await postStream(
        `${config.baseUrl}/chat/completions`,
        await authHeaders(config),
        { model, messages, stream: true, ...reasoningFields(thinking) },
        options?.signal,
        config,
      )
      let reply = ''
      let tokens: number | undefined
      let inputTokens: number | undefined
      let outputTokens: number | undefined
      await readSse(res, ({ data }) => {
        if (data === '[DONE]') return
        let json: Record<string, unknown>
        try { json = JSON.parse(data) } catch { return }
        const deltaFields = (json.choices as Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string } }> | undefined)?.[0]?.delta
        const delta = deltaFields?.content
        if (delta) {
          reply += delta
          normalizedOptions?.onText?.(delta)
        }
        const think = deltaFields?.reasoning_content ?? deltaFields?.reasoning
        if (think) normalizedOptions?.onThinking?.(think)
        const usage = json.usage as { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } | undefined
        if (usage?.total_tokens) tokens = usage.total_tokens
        if (typeof usage?.prompt_tokens === 'number') inputTokens = usage.prompt_tokens
        if (typeof usage?.completion_tokens === 'number') outputTokens = usage.completion_tokens
      })
      return { status: res.status, text: JSON.stringify({ reply }), tokens, inputTokens, outputTokens, reply }
    }

    case 'responses': {
      const res = await postStream(
        `${config.baseUrl}/responses`,
        await authHeaders(config),
        { model, input: messages.map((m) => ({ role: m.role, content: toResponsesContent(m.content) })), stream: true, ...(thinking ? { reasoning: { effort: thinking } } : {}) },
        options?.signal,
      )
      let reply = ''
      let tokens: number | undefined
      await readSse(res, ({ event, data }) => {
        let json: Record<string, unknown>
        try { json = JSON.parse(data) } catch { return }
        if (event === 'response.output_text.delta' || json.type === 'response.output_text.delta') {
          const delta = String(json.delta ?? '')
          if (delta) {
            reply += delta
            normalizedOptions?.onText?.(delta)
          }
        }
        const usage = (json.response as { usage?: { total_tokens?: number; input_tokens?: number; output_tokens?: number } } | undefined)?.usage
          ?? (json.usage as { total_tokens?: number; input_tokens?: number; output_tokens?: number } | undefined)
        if (usage) tokens = usage.total_tokens ?? (usage.input_tokens || 0) + (usage.output_tokens || 0)
      })
      return { status: res.status, text: JSON.stringify({ reply }), tokens, reply }
    }

    case 'messages': {
      const system = messages.filter((m) => m.role === 'system').map((m) => contentText(m.content)).join('\n\n')
      const turns = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: toMessagesContent(m.content) }))
      const res = await postStream(
        `${config.baseUrl}/messages`,
        { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
        {
          model,
          max_tokens: 4096,
          stream: true,
          ...(system ? { system } : {}),
          messages: turns,

          ...(thinking ? { thinking: { type: 'enabled', budget_tokens: thinking === 'max' ? 8192 : 2048 } } : {}),
        },
        options?.signal,
      )
      let reply = ''
      let tokens: number | undefined
      await readSse(res, ({ event, data }) => {
        let json: Record<string, unknown>
        try { json = JSON.parse(data) } catch { return }
        if (event === 'content_block_delta' || json.type === 'content_block_delta') {
          const delta = (json.delta as { type?: string; text?: string; thinking?: string } | undefined)
          if (delta?.type === 'text_delta' && delta.text) {
            reply += delta.text
            normalizedOptions?.onText?.(delta.text)
          } else if (delta?.type === 'thinking_delta' && delta.thinking) {
            normalizedOptions?.onThinking?.(delta.thinking)
          }
        }
        const usage = (json.message as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined)?.usage
          ?? (json.usage as { input_tokens?: number; output_tokens?: number } | undefined)
        if (usage) tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0)
      })
      return { status: res.status, text: JSON.stringify({ reply }), tokens, reply }
    }

    case 'gemini': {
      // Text-only calls keep the flattened single-turn prompt; multimodal calls
      // send real turns with inline_data parts and a systemInstruction.
      const system = messages.filter((m) => m.role === 'system').map((m) => contentText(m.content)).join('\n\n')
      const body = hasImageParts(messages)
        ? {
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            contents: messages.filter((m) => m.role !== 'system').map((m) => ({
              role: m.role === 'assistant' ? 'model' : 'user',
              parts: toGeminiParts(m.content),
            })),
          }
        : { contents: [{ role: 'user', parts: [{ text: toPrompt(messages) }] }] }
      const res = await postStream(
        `${config.baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(config.apiKey)}`,
        {},
        body,
        options?.signal,
      )
      let reply = ''
      let tokens: number | undefined
      await readSse(res, ({ data }) => {
        let json: Record<string, unknown>
        try { json = JSON.parse(data) } catch { return }
        const parts = (json.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined)?.[0]?.content?.parts || []
        const delta = parts.map((p) => p.text || '').join('')
        if (delta) {
          reply += delta
          normalizedOptions?.onText?.(delta)
        }
        const total = (json.usageMetadata as { totalTokenCount?: number } | undefined)?.totalTokenCount
        if (total) tokens = total
      })
      return { status: res.status, text: JSON.stringify({ reply }), tokens, reply }
    }

    case 'cloudflare-playground': {
      // Handled above; kept for exhaustiveness so tsc knows every EndpointType returns.
      const result = await callCloudflarePlayground(messages, model || config.model, normalizedOptions)
      return {
        status: 200,
        text: JSON.stringify({ reply: result.text }),
        tokens: result.tokens,
        reply: result.text,
      }
    }
  }
}

export async function listModels(config: ProviderConfig): Promise<{ status: number; body: string }> {
  try {
    let url = ''
    const headers: Record<string, string> = {}
    if (config.endpoint === 'gemini') {
      url = `${config.baseUrl}/models?key=${encodeURIComponent(config.apiKey)}`
    } else if (config.endpoint === 'messages') {
      url = `${config.baseUrl}/models`
      headers['x-api-key'] = config.apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else {
      url = `${config.baseUrl}/models`
      Object.assign(headers, await authHeaders(config))
    }
    const res = await fetch(url, { headers })
    return { status: res.status, body: await res.text() }
  } catch (error) {
    return { status: 500, body: JSON.stringify({ error: error instanceof Error ? error.message : 'Model request failed' }) }
  }
}

export interface ToolCallResult {
  text: string

  thinking?: string
  tokens?: number
  // Summed across tool-loop steps when the provider reports them.
  inputTokens?: number
  outputTokens?: number
  steps: number
}

export async function callProviderWithTools(
  config: ProviderConfig,
  messages: ChatInputMessage[],
  modelOverride: string | undefined,
  options: CallOptions & { maxSteps?: number },
): Promise<ToolCallResult> {
  const { model, thinking } = normalizeModelAndThinking(config, modelOverride, options)
  const normalizedOptions: CallOptions & { maxSteps?: number } = { ...options, thinking }
  const tools = options.tools || []
  const maxSteps = options.maxSteps ?? 5
  if (!tools.length || !options.runTool) {
    const result = await callProvider(config, messages, model, normalizedOptions)

    const answer = result.reply ?? (() => { try { return JSON.parse(result.text).reply || '' } catch { return result.text } })()
    return { text: answer, tokens: result.tokens, inputTokens: result.inputTokens, outputTokens: result.outputTokens, steps: 1 }
  }

  // Playground Durable Objects run tools themselves via connectMCPServer against
  // our /api/mcp/ddg endpoint - skip the local OpenAI/Anthropic tool loops.
  if (isCloudflarePlaygroundEndpoint(config.endpoint)) {
    return callCloudflarePlayground(messages, model || config.model, normalizedOptions)
  }

  switch (config.endpoint) {
    case 'chat-completions':
      return runOpenAIToolLoop(config, messages, model, normalizedOptions, maxSteps)
    case 'messages':
      return runAnthropicToolLoop(config, messages, model, normalizedOptions, maxSteps)
    default:

      return callProviderWithTools({ ...config, endpoint: config.endpoint }, messages, model, { ...normalizedOptions, tools: undefined, runTool: undefined })
  }
}

const RESEARCH_LIMIT_TEXT = 'I did a fair bit of searching but hit my research limit before I could pull it all together. Try asking a more focused follow-up, or rephrase the question.'

/**
 * Accumulates answer text across tool-loop steps. Every byte goes through
 * `onText` in order, so the client's live stream and the persisted answer
 * share one offset space (tool calls record their position in it).
 */
function answerAccumulator(options: CallOptions) {
  let all = ''
  let breakPending = false
  return {
    get text() { return all },
    push(delta: string) {
      if (!delta) return
      if (breakPending && all) {
        all += '\n\n'
        options.onText?.('\n\n')
      }
      breakPending = false
      all += delta
      options.onText?.(delta)
    },
    /** A step that ended in tool calls: separate its text from the next step's. */
    endStep() { if (all) breakPending = true },
  }
}

async function runOpenAIToolLoop(
  config: ProviderConfig,
  messages: ChatInputMessage[],
  model: string,
  options: CallOptions,
  maxSteps: number,
): Promise<ToolCallResult> {
  const runTool = options.runTool!
  const oaiTools = (options.tools || []).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }))

  const convo: Array<Record<string, unknown>> = messages.map((m) => ({ role: m.role, content: m.content }))
  let totalTokens = 0
  let inputTokens = 0
  let outputTokens = 0
  let steps = 0
  const answer = answerAccumulator(options)

  for (let step = 0; step < maxSteps; step++) {
    steps = step + 1
    const res = await postStreamWithRetry(config, {
      model,
      messages: convo,
      tools: oaiTools,
      tool_choice: 'auto',
      stream: true,
      ...reasoningFields(options.thinking),
    })
    let text = ''
    let reasoning = ''
    let stepTokens = 0
    let stepInput = 0
    let stepOutput = 0

    const pendingCalls = new Map<number, { id: string; name: string; argsJson: string }>()
    await readSse(res, ({ data }) => {
      if (data === '[DONE]') return
      let json: Record<string, unknown>
      try { json = JSON.parse(data) } catch { return }
      const choice = (json.choices as Array<Record<string, unknown>> | undefined)?.[0] || {}
      const delta = (choice.delta as Record<string, unknown>) || {}
      const content = delta.content as string | undefined
      if (content) {
        text += content
        answer.push(content)
      }
      // Some upstreams name the reasoning field `reasoning`; both are read.
      const think = (delta.reasoning_content ?? delta.reasoning) as string | undefined
      if (think) {
        reasoning += think
        options.onThinking?.(think)
      }
      for (const tc of (delta.tool_calls as Array<Record<string, unknown>> | undefined) || []) {
        const index = typeof tc.index === 'number' ? tc.index : 0
        const entry = pendingCalls.get(index) || { id: '', name: '', argsJson: '' }
        if (tc.id) entry.id = String(tc.id)
        const fn = (tc.function as Record<string, unknown>) || {}
        if (fn.name) entry.name += String(fn.name)
        if (fn.arguments) entry.argsJson += String(fn.arguments)
        pendingCalls.set(index, entry)
      }
      const usage = json.usage as { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } | undefined
      if (usage?.total_tokens) stepTokens = usage.total_tokens
      if (typeof usage?.prompt_tokens === 'number') stepInput = usage.prompt_tokens
      if (typeof usage?.completion_tokens === 'number') stepOutput = usage.completion_tokens
    })
    totalTokens += stepTokens
    inputTokens += stepInput
    outputTokens += stepOutput

    const toolCalls = [...pendingCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c)
    if (!toolCalls.length) {
      return { text: answer.text, thinking: reasoning || undefined, tokens: totalTokens || undefined, inputTokens: inputTokens || undefined, outputTokens: outputTokens || undefined, steps }
    }

    answer.endStep()
    convo.push({
      role: 'assistant',
      content: text || null,
      tool_calls: toolCalls.map((c, i) => ({ id: c.id || `call_${step}_${i}`, type: 'function', function: { name: c.name, arguments: c.argsJson } })),
    })
    for (const [i, c] of toolCalls.entries()) {
      const id = c.id || `call_${step}_${i}`
      const result = await executeToolCall(runTool, options, { id, name: c.name, argsJson: c.argsJson })
      convo.push({ role: 'tool', tool_call_id: id, content: result })
    }
  }
  answer.endStep()
  answer.push(RESEARCH_LIMIT_TEXT)
  return { text: answer.text, tokens: totalTokens || undefined, inputTokens: inputTokens || undefined, outputTokens: outputTokens || undefined, steps }
}

async function runAnthropicToolLoop(
  config: ProviderConfig,
  messages: ChatInputMessage[],
  model: string,
  options: CallOptions,
  maxSteps: number,
): Promise<ToolCallResult> {
  const runTool = options.runTool!
  const anthTools = (options.tools || []).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }))
  const system = messages.filter((m) => m.role === 'system').map((m) => contentText(m.content)).join('\n\n')
  const convo: Array<Record<string, unknown>> = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }))
  let totalTokens = 0
  let steps = 0
  const answer = answerAccumulator(options)

  for (let step = 0; step < maxSteps; step++) {
    steps = step + 1
    const res = await postStream(
      `${config.baseUrl}/messages`,
      { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
      {
        model,
        max_tokens: 4096,
        stream: true,
        ...(system ? { system } : {}),
        messages: convo,
        tools: anthTools,
        ...(options.thinking ? { thinking: { type: 'enabled', budget_tokens: options.thinking === 'max' ? 8192 : 2048 } } : {}),
      },
    )
    let text = ''
    let stopReason = ''
    let stepTokens = 0

    const blocks = new Map<number, { type: string; id: string; name: string; inputJson: string }>()
    await readSse(res, ({ event, data }) => {
      let json: Record<string, unknown>
      try { json = JSON.parse(data) } catch { return }
      const type = String(json.type || event || '')
      if (type === 'content_block_start') {
        const index = Number(json.index ?? 0)
        const block = (json.content_block as Record<string, unknown>) || {}
        blocks.set(index, {
          type: String(block.type || ''),
          id: String(block.id || ''),
          name: String(block.name || ''),
          inputJson: '',
        })
        return
      }
      if (type === 'content_block_delta') {
        const index = Number(json.index ?? 0)
        const delta = (json.delta as Record<string, unknown>) || {}
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          text += delta.text
          answer.push(delta.text)
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          options.onThinking?.(delta.thinking)
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const block = blocks.get(index)
          if (block) block.inputJson += delta.partial_json
        }
        return
      }
      if (type === 'message_delta') {
        stopReason = String((json.delta as { stop_reason?: string } | undefined)?.stop_reason || stopReason)
        const usage = json.usage as { input_tokens?: number; output_tokens?: number } | undefined
        if (usage) stepTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0)
        return
      }
      if (type === 'message_start') {
        const usage = (json.message as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined)?.usage
        if (usage) stepTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0)
      }
    })
    totalTokens += stepTokens

    const toolUses = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b).filter((b) => b.type === 'tool_use')
    if (stopReason !== 'tool_use' || !toolUses.length) {
      return { text: answer.text, tokens: totalTokens || undefined, steps }
    }

    answer.endStep()
    const content: Array<Record<string, unknown>> = []
    if (text) content.push({ type: 'text', text })
    for (const b of toolUses) {
      let input: unknown = {}
      try { input = JSON.parse(b.inputJson || '{}') } catch { input = {} }
      content.push({ type: 'tool_use', id: b.id, name: b.name, input })
    }
    convo.push({ role: 'assistant', content })
    const toolResults: Array<Record<string, unknown>> = []
    for (const b of toolUses) {
      const result = await executeToolCall(runTool, options, { id: b.id, name: b.name, argsJson: b.inputJson || '{}' })
      toolResults.push({ type: 'tool_result', tool_use_id: b.id, content: result })
    }
    convo.push({ role: 'user', content: toolResults })
  }
  answer.endStep()
  answer.push(RESEARCH_LIMIT_TEXT)
  return { text: answer.text, tokens: totalTokens || undefined, steps }
}

async function executeToolCall(
  runTool: (call: ToolCall) => Promise<string>,
  options: CallOptions,
  call: ToolCall,
): Promise<string> {
  let args: Record<string, unknown> = {}
  try { args = JSON.parse(call.argsJson || '{}') } catch { args = {} }
  const title = toolTitle(call.name, args)
  const started = Date.now()
  options.onToolEvent?.({ phase: 'start', callId: call.id, tool: call.name, title, args })
  let result = ''
  let ok = true
  try {
    result = await runTool(call)
  } catch (error) {
    ok = false
    result = `Error: ${error instanceof Error ? error.message : 'tool failed'}`
  }
  options.onToolEvent?.({
    phase: 'end',
    callId: call.id,
    tool: call.name,
    title,
    ok,
    summary: ok ? summarize(call.name, args, result) : result.slice(0, 120),
    durationMs: Date.now() - started,
    output: result.slice(0, TOOL_OUTPUT_KEEP),
  })
  return result
}

function toolTitle(name: string, args: Record<string, unknown>): string {
  if (name === 'web_search') return `Searching the web for "${String(args.query ?? '')}"`
  if (name === 'web_fetch') return `Reading ${hostOf(String(args.url ?? ''))}`
  if (name === 'expand_link') return 'Expanding link'
  return `Using ${name}`
}

function hostOf(url: string): string {
  if (url.startsWith('ref://')) return 'a result link'
  try { return new URL(url).hostname } catch { return url.slice(0, 40) }
}

function summarize(name: string, _args: Record<string, unknown>, result: string): string {
  if (name === 'web_search') {
    const count = (result.match(/^\d+\. /gm) || []).length
    return `${count} result${count === 1 ? '' : 's'}`
  }
  if (name === 'web_fetch') return `${Math.round(result.length / 100) / 10}k chars`
  return 'Done'
}
