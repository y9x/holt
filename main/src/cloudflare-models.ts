// Cloudflare AI models the chat picker offers. Free, no key, no plan lock.
//
// The order and the labels mirror the Cloudflare playground's own selector
// exactly (its excluded slugs are left out). Do not sort or reorder this list:
// the picker renders it as declared. The server's DEFAULT_SLUG
// (server/cloudflare-playground.ts) is what runs when no model is sent, and it
// is intentionally not listed here.

export interface CloudflareModel {
  id: string
  display_name: string
  /** Tokens, from the model's "Model Info" table on developers.cloudflare.com/workers-ai/models (checked 2026-10-23). */
  contextWindow: number
}

export const CLOUDFLARE_MODEL_PREFIX = '@cf/'

export const CLOUDFLARE_MODELS: readonly CloudflareModel[] = [
  { id: '@cf/google/gemma-4-26b-a4b-it', display_name: 'Gemma 4 26B', contextWindow: 256_000 },
  { id: '@cf/zai-org/glm-4.7-flash', display_name: 'GLM-4.7 Flash', contextWindow: 131_072 },
  { id: '@cf/zai-org/glm-5.3-flash', display_name: 'GLM-5.3 Flash', contextWindow: 1_048_576 },
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct', display_name: 'Llama 4 Scout 17B', contextWindow: 131_000 },
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', display_name: 'Llama 3.3 70B (fp8 fast)', contextWindow: 24_000 },
  { id: '@cf/ibm/granite-4.0-h-micro', display_name: 'Granite 4.0-H Micro', contextWindow: 131_000 },
  { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', display_name: 'Mistral Small 3.1 24B', contextWindow: 128_000 },
  { id: '@cf/qwen/qwen3-30b-a3b-fp8', display_name: 'Qwen3 30B-A3B (fp8)', contextWindow: 32_768 },
  { id: '@cf/openai/gpt-oss-120b', display_name: 'GPT-OSS 120B', contextWindow: 128_000 },
  { id: '@cf/openai/gpt-oss-20b', display_name: 'GPT-OSS 20B', contextWindow: 128_000 },
]

export function isCloudflareModelId(id: string): boolean {
  return id.startsWith(CLOUDFLARE_MODEL_PREFIX)
}
