// The custom AI endpoint for one chat send, edit or retry (runOp in
// chat-engine.ts). The browser keeps the custom endpoint settings and sends them
// on each request as X-Custom-* headers. The server stores nothing. A request
// with none of the headers takes the platform path and never touches the
// database. A custom request is validated in full on every send and its values
// are used for that call only.
import type { Identity } from '../identity.js'
import type { ProviderConfig } from '../ai-providers.js'
import { OpError } from '../thread-ops.js'
import { checkCustomEndpoint, checkModelId, checkProviderKey, isThinking } from './validate.js'

export const CUSTOM_HEADERS = {
  key: 'x-custom-api-key',
  baseUrl: 'x-custom-base-url',
  model: 'x-custom-model',
  thinking: 'x-custom-thinking',
} as const

/** Raw header values (Node joins a repeated header with ", ", so each is one string). */
export interface CustomHeaders {
  key?: string
  baseUrl?: string
  model?: string
  thinking?: string
}

export interface CustomRoute {
  provider: ProviderConfig
  model: string
  /** Undefined for "off", so no reasoning field is sent. */
  thinking?: string
  /** Every value that must be removed from any error text before it leaves the server. */
  secrets: string[]
}

const KEY_MISSING = 'Enter your API key in chat settings.'

function anyPresent(headers: CustomHeaders | undefined): boolean {
  return !!headers && Object.values(headers).some((v) => v !== undefined)
}

/** Values to scrub from error text: the key, the base URL and the model. */
export function secretsOf(headers: CustomHeaders | undefined): string[] {
  if (!headers) return []
  return [headers.key, headers.baseUrl, headers.model]
    .map((v) => (v ?? '').trim())
    .filter((v) => v.length >= 3)
}

/** Removes every occurrence of each secret from text that may leave the server. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) out = out.split(secret).join('[redacted]')
  return out
}

export async function customRouteFor(identity: Identity, headers?: CustomHeaders): Promise<CustomRoute | null> {
  if (!anyPresent(headers)) return null
  if (identity.isGuest || !identity.user) throw new OpError(401, 'Sign in to use a custom AI endpoint.')

  const key = checkProviderKey(headers!.key ?? '')
  if (!key.ok) throw new OpError(401, KEY_MISSING)

  const rawBaseUrl = (headers!.baseUrl ?? '').trim()
  if (!rawBaseUrl) throw new OpError(400, 'Enter the base URL of your OpenAI-compatible endpoint.')

  const model = checkModelId(headers!.model)
  if (!model.ok) throw new OpError(400, model.error)

  const thinking = (headers!.thinking ?? '').trim() || 'off'
  if (!isThinking(thinking)) throw new OpError(400, 'Thinking must be off, low, medium, high or max.')

  // SSRF checks run on every send: https, public addresses only, pinned connect.
  const endpoint = await checkCustomEndpoint(rawBaseUrl)
  if (!endpoint.ok) throw new OpError(400, endpoint.error)

  return {
    model: model.value,
    thinking: thinking === 'off' ? undefined : thinking,
    secrets: [key.value, rawBaseUrl, endpoint.value.baseUrl, model.value].filter((v) => v.length >= 3),
    provider: {
      baseUrl: endpoint.value.baseUrl,
      apiKey: key.value,
      model: model.value,
      endpoint: 'chat-completions',
      auth: 'api-key',
      verbatim: true,
      connect: { address: endpoint.value.address, family: endpoint.value.family },
    },
  }
}
