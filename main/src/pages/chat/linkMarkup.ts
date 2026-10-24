// Link facts about message content, read off the Discord markdown AST
// (markdown.ts parseMarkdown - the same parse that renders the content), so
// the embed layer agrees exactly with what the content shows:
//
// - contentLinks(): every url / masked-link / attachmentLink target in order
//   (Discord unfurls these), with <url> autolinks and [x](<url>) marked
//   suppressed (Discord never embeds them) and links inside ||spoilers||
//   flagged.
// - singleLinkContent(): Discord's hideSimpleEmbedContent AST test (448767
//   dn/iz with predicate `type === "link" || type === "attachmentLink"`): the
//   content is exactly ONE link node and nothing else.

import { parseMarkdown, type MdNode } from './markdown'

export interface ContentLink {
  url: string
  kind: 'url' | 'masked' | 'attachment' | 'autolink'
  suppressed: boolean
  spoiler: boolean
}

function linkTarget(n: MdNode): string | null {
  const raw = n.type === 'attachmentLink' ? n.attachmentUrl : n.target
  if (typeof raw !== 'string') return null
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch {
    return null
  }
}

const cache = new Map<string, MdNode[]>()
function ast(content: string): MdNode[] {
  let hit = cache.get(content)
  if (!hit) {
    hit = parseMarkdown(content)
    if (cache.size > 500) cache.delete(cache.keys().next().value as string)
    cache.set(content, hit)
  }
  return hit
}

export function contentLinks(content: string | null | undefined): ContentLink[] {
  if (!content || !/https?:\/\//i.test(content)) return []
  const out: ContentLink[] = []
  const walk = (nodes: MdNode[], spoiler: boolean) => {
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue
      if (n.type === 'link' || n.type === 'attachmentLink') {
        const url = linkTarget(n)
        if (url) {
          const masked = n.type === 'link' && !n.autolink && Array.isArray(n.content) && !(n.content.length === 1 && n.content[0]?.type === 'text' && linkTarget({ type: 'link', target: n.content[0].content }) === url)
          const kind: ContentLink['kind'] = n.type === 'attachmentLink' ? 'attachment' : n.autolink ? 'autolink' : masked ? 'masked' : 'url'
          // [label](<url>) suppresses the embed like <url>.
          const angle = kind === 'masked' && /\]\(\s*<[^>\s]+>/.test(content)
          out.push({ url, kind, suppressed: kind === 'autolink' || angle, spoiler })
        }
        continue
      }
      const inner = n.type === 'spoiler' || spoiler
      if (Array.isArray(n.content)) walk(n.content as MdNode[], inner)
      if (Array.isArray(n.items)) for (const item of n.items as MdNode[][]) walk(item, inner)
    }
  }
  walk(ast(content), false)
  return out
}

export function singleLinkContent(content: string | null | undefined): string | null {
  const text = (content || '').trim()
  if (!text || !/^https?:\/\//i.test(text)) return null
  let nodes = ast(text)
  if (nodes.length === 1 && nodes[0].type === 'paragraph' && Array.isArray(nodes[0].content)) nodes = nodes[0].content as MdNode[]
  if (nodes.length !== 1) return null
  const n = nodes[0]
  if ((n.type !== 'link' || n.autolink) && n.type !== 'attachmentLink') return null
  return linkTarget(n)
}
