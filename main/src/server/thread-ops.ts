import { randomUUID } from 'node:crypto'
import { query } from './db.js'
import { emit } from './events.js'

export interface ToolCallMeta {
  callId: string
  tool: string
  title: string
  args?: Record<string, unknown>
  ok?: boolean
  summary?: string
  durationMs?: number
  /** What the tool returned, as the model saw it (the UI shows it in a terminal card). */
  output?: string
  /** Char offset into the thinking blob when this tool started - used to split thought around tools. */
  atChar?: number
  /** Char offset into the answer text when this tool started; above 0 it renders inline in the reply. */
  textAt?: number
}

export interface MessageMetadata {
  thinking?: string
  thinkingDurationMs?: number
  toolCalls?: ToolCallMeta[]

  model?: string
}

export interface ThreadMessage {
  id: string
  seq: number
  role: 'user' | 'assistant'
  content: string
  attachments?: Array<{ id: string; name: string; url: string; mime: string }>
  tokens?: number
  ms?: number
  edited?: boolean
  metadata?: MessageMetadata
}

interface MessageRow {
  id: string
  seq: number
  role: 'user' | 'assistant'
  content: string
  attachments: unknown
  tokens: number | null
  ms: number | null
  edited_at: Date | null
  metadata?: unknown
}

function toMessage(row: MessageRow): ThreadMessage {
  return {
    id: row.id,
    seq: row.seq,
    role: row.role,
    content: row.content,
    attachments: (row.attachments as ThreadMessage['attachments']) || undefined,
    tokens: row.tokens ?? undefined,
    ms: row.ms ?? undefined,
    edited: Boolean(row.edited_at),
    metadata: (row.metadata as MessageMetadata | null) || undefined,
  }
}

export class OpError extends Error {
  status: number
  retryable: boolean
  constructor(status: number, message: string, retryable = false) {
    super(message)
    this.status = status
    this.retryable = retryable
  }
}

async function getOwnedThread(threadId: string, ownerKey: string) {
  const { rows } = await query<{ id: string; generating: boolean }>(
    `SELECT id, generating FROM thread WHERE id = $1 AND owner_key = $2`,
    [threadId, ownerKey],
  )
  return rows[0] || null
}

// A client can hold a thread id the server no longer has: a popout that was
// discarded before its first message, a tab that outlived a delete, or a send
// that raced a cleanup. Recreating the row keeps the chat usable instead of
// failing every message with 404. Ids that exist under a different owner are
// still rejected, so this never crosses the ownership boundary.
async function ensureSendableThread(threadId: string, ownerKey: string) {
  const owned = await getOwnedThread(threadId, ownerKey)
  if (owned) return owned
  const { rows } = await query<{ id: string }>(`SELECT id FROM thread WHERE id = $1`, [threadId])
  if (rows[0]) throw new OpError(404, 'Thread not found')
  await query(`INSERT INTO thread (id, owner_key) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [threadId, ownerKey])
  return { id: threadId, generating: false }
}

async function nextSeq(threadId: string): Promise<number> {
  const { rows } = await query<{ seq: number | null }>(
    `SELECT max(seq) AS seq FROM thread_message WHERE thread_id = $1`,
    [threadId],
  )
  return (rows[0]?.seq ?? 0) + 1
}

async function insertMessage(
  threadId: string,
  role: 'user' | 'assistant',
  content: string,
  opts: { attachments?: ThreadMessage['attachments']; clientId?: string; tokens?: number; ms?: number; metadata?: MessageMetadata } = {},
): Promise<ThreadMessage> {
  const id = randomUUID()
  const seq = await nextSeq(threadId)
  const { rows } = await query<MessageRow>(
    `INSERT INTO thread_message (id, thread_id, seq, role, content, attachments, client_id, tokens, ms, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, seq, role, content, attachments, tokens, ms, edited_at, metadata`,
    [id, threadId, seq, role, content, opts.attachments ? JSON.stringify(opts.attachments) : null, opts.clientId || null, opts.tokens ?? null, opts.ms ?? null, opts.metadata ? JSON.stringify(opts.metadata) : null],
  )
  await query('UPDATE thread SET updated = NOW() WHERE id = $1', [threadId])
  return toMessage(rows[0])
}

export async function getThread(threadId: string, ownerKey: string): Promise<{ id: string; title: string; generating: boolean; messages: ThreadMessage[] }> {
  const thread = await getOwnedThread(threadId, ownerKey)
  if (!thread) throw new OpError(404, 'Thread not found')
  const { rows: titleRows } = await query<{ title: string }>('SELECT title FROM thread WHERE id = $1', [threadId])
  const { rows } = await query<MessageRow>(
    `SELECT id, seq, role, content, attachments, tokens, ms, edited_at, metadata
     FROM thread_message WHERE thread_id = $1 AND deleted = FALSE ORDER BY seq ASC`,
    [threadId],
  )
  return { id: threadId, title: titleRows[0]?.title || 'New chat', generating: thread.generating, messages: rows.map(toMessage) }
}

export async function listThreads(ownerKey: string) {
  const { rows } = await query<{ id: string; title: string; updated: Date }>(
    `SELECT id, title, updated FROM thread WHERE owner_key = $1 ORDER BY updated DESC LIMIT 50`,
    [ownerKey],
  )
  return rows
}

export async function createThread(ownerKey: string): Promise<{ id: string; title: string; messages: ThreadMessage[] }> {
  const id = randomUUID()
  await query('INSERT INTO thread (id, owner_key) VALUES ($1, $2)', [id, ownerKey])
  return { id, title: 'New chat', messages: [] }
}

export async function appendUserMessage(
  threadId: string,
  ownerKey: string,
  text: string,
  opts: { attachments?: ThreadMessage['attachments']; clientId?: string } = {},
): Promise<{ message: ThreadMessage; existed: boolean }> {
  const thread = await ensureSendableThread(threadId, ownerKey)
  if (thread.generating) throw new OpError(409, 'A reply is already being generated')

  if (opts.clientId) {
    const { rows } = await query<MessageRow>(
      `SELECT id, seq, role, content, attachments, tokens, ms, edited_at FROM thread_message WHERE thread_id = $1 AND client_id = $2`,
      [threadId, opts.clientId],
    )
    if (rows[0]) return { message: toMessage(rows[0]), existed: true }
  }
  const message = await insertMessage(threadId, 'user', text, opts)
  await emit(ownerKey, 'message.appended', { threadId, message })
  return { message, existed: false }
}

export async function appendAssistantMessage(
  threadId: string,
  ownerKey: string,
  content: string,
  opts: { tokens?: number; ms?: number; metadata?: MessageMetadata } = {},
): Promise<ThreadMessage> {
  const message = await insertMessage(threadId, 'assistant', content, opts)
  await emit(ownerKey, 'message.appended', { threadId, message })
  return message
}

async function tombstoneFrom(threadId: string, seq: number) {
  await query('UPDATE thread_message SET deleted = TRUE WHERE thread_id = $1 AND seq >= $2', [threadId, seq])
}

export async function editUserMessage(
  threadId: string,
  ownerKey: string,
  messageId: string,
  text: string,
  attachments?: ThreadMessage['attachments'],
): Promise<ThreadMessage> {
  const thread = await getOwnedThread(threadId, ownerKey)
  if (!thread) throw new OpError(404, 'Thread not found')
  const { rows } = await query<MessageRow & { role: string }>(
    `SELECT id, seq, role, content, attachments, tokens, ms, edited_at FROM thread_message
     WHERE id = $1 AND thread_id = $2 AND deleted = FALSE`,
    [messageId, threadId],
  )
  const original = rows[0]
  if (!original) throw new OpError(404, 'Message not found')
  if (original.role !== 'user') throw new OpError(400, 'Only your own messages can be edited')
  await tombstoneFrom(threadId, original.seq)
  await emit(ownerKey, 'message.deleted', { threadId, messageId, fromSeq: original.seq })

  const nextAttachments = attachments === undefined ? (original.attachments as ThreadMessage['attachments']) : attachments
  const edited = await insertMessage(threadId, 'user', text, { attachments: nextAttachments })
  await emit(ownerKey, 'message.appended', { threadId, message: edited })
  return edited
}

export async function deleteMessage(threadId: string, ownerKey: string, messageId: string): Promise<void> {
  const thread = await getOwnedThread(threadId, ownerKey)
  if (!thread) throw new OpError(404, 'Thread not found')
  const { rows } = await query<{ seq: number }>(
    `SELECT seq FROM thread_message WHERE id = $1 AND thread_id = $2 AND deleted = FALSE`,
    [messageId, threadId],
  )
  const target = rows[0]
  if (!target) throw new OpError(404, 'Message not found')
  await query('UPDATE thread_message SET deleted = TRUE WHERE thread_id = $1 AND seq >= $2', [threadId, target.seq])
  await emit(ownerKey, 'message.deleted', { threadId, messageId, fromSeq: target.seq })
}

export async function retryFrom(threadId: string, ownerKey: string, messageId: string): Promise<void> {
  const thread = await getOwnedThread(threadId, ownerKey)
  if (!thread) throw new OpError(404, 'Thread not found')
  const { rows } = await query<{ seq: number; role: string }>(
    `SELECT seq, role FROM thread_message WHERE id = $1 AND thread_id = $2 AND deleted = FALSE`,
    [messageId, threadId],
  )
  const target = rows[0]
  if (!target) throw new OpError(404, 'Message not found')

  const fromSeq = target.role === 'user' ? target.seq + 1 : target.seq
  await tombstoneFrom(threadId, fromSeq)
  await emit(ownerKey, 'message.deleted', { threadId, messageId, fromSeq })
}

export async function setGenerating(threadId: string, ownerKey: string, generating: boolean): Promise<void> {
  await query('UPDATE thread SET generating = $1 WHERE id = $2', [generating, threadId])
  await emit(ownerKey, 'thread.generating', { threadId, generating })
}

export async function deleteThread(threadId: string, ownerKey: string): Promise<void> {
  const thread = await getOwnedThread(threadId, ownerKey)
  if (!thread) throw new OpError(404, 'Thread not found')
  await query('DELETE FROM thread_message WHERE thread_id = $1', [threadId])
  await query('DELETE FROM thread WHERE id = $1', [threadId])
  await emit(ownerKey, 'thread.deleted', { threadId })
}

export async function getTitle(threadId: string, ownerKey: string): Promise<string> {
  const { rows } = await query<{ title: string }>(
    'SELECT title FROM thread WHERE id = $1 AND owner_key = $2',
    [threadId, ownerKey],
  )
  return rows[0]?.title ?? ''
}

export async function setThreadTitle(threadId: string, ownerKey: string, title: string): Promise<void> {
  const thread = await getOwnedThread(threadId, ownerKey)
  if (!thread) throw new OpError(404, 'Thread not found')
  await query('UPDATE thread SET title = $1 WHERE id = $2', [title, threadId])
  await emit(ownerKey, 'thread.renamed', { threadId, title })
}

export async function contextMessages(threadId: string): Promise<Array<{ role: 'user' | 'assistant'; content: string; attachments?: ThreadMessage['attachments'] }>> {
  const { rows } = await query<MessageRow>(
    `SELECT id, seq, role, content, attachments, tokens, ms, edited_at
     FROM thread_message WHERE thread_id = $1 AND deleted = FALSE ORDER BY seq ASC`,
    [threadId],
  )
  return rows.map((r) => ({ role: r.role, content: r.content, attachments: (r.attachments as ThreadMessage['attachments']) || undefined }))
}
