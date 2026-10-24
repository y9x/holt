import type { ToolSpec } from './ai-providers.js'
import { mcpToolSpecs } from '../lib/chat-tools.ts'

// The DuckDuckGo tools (search, fetch_content, expand_link) carry the DuckDuckGo MCP server's own names and
// schemas (lib/chat-tools.ts). The built-in `fetch` tool is served here too.

/** The DuckDuckGo MCP tools, as the MCP route lists them. */
export function buildWebToolSpecs(): ToolSpec[] {
  return mcpToolSpecs(undefined)
}

type WebToolHost = {
  search: (q: string, n?: number) => Promise<string>
  fetchContent: (url: string, n?: number) => Promise<string>
  // WebSearchTools.expandLink is sync; accept either.
  expandLink: (t: string) => string | Promise<string>
}

const FETCH_CHARACTERS = 8000

export async function runWebTool(
  tools: WebToolHost,
  name: string,
  argsJson: string,
): Promise<string> {
  let args: Record<string, unknown> = {}
  try { args = JSON.parse(argsJson || '{}') } catch { args = {} }
  if (name === 'search') return tools.search(String(args.query ?? ''), numOr(args.max_results, 10))
  if (name === 'fetch_content') {
    const start = Math.max(0, numOr(args.start_index, 0))
    const length = numOr(args.max_length, FETCH_CHARACTERS)
    const text = await tools.fetchContent(String(args.url ?? ''), start + length)
    return text.slice(start, start + length)
  }
  if (name === 'expand_link') return await tools.expandLink(String(args.token ?? ''))
  if (name === 'fetch') {
    const urls = Array.isArray(args.urls) ? args.urls.filter((url): url is string => typeof url === 'string').slice(0, 5) : []
    if (!urls.length) return 'fetch needs at least one URL.'
    const pages: string[] = []
    for (const url of urls) {
      try {
        pages.push(`## ${url}\n${await tools.fetchContent(url, FETCH_CHARACTERS)}`)
      } catch (error) {
        pages.push(`## ${url}\nCould not fetch this page: ${error instanceof Error ? error.message : 'unknown error'}`)
      }
    }
    return pages.join('\n\n')
  }
  return `Unknown tool: ${name}`
}

function numOr(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
