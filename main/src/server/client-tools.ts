// Client tools: tool calls the browser runs in its own Dusk workspace (files and a shell that persist in
// that browser). The model's call becomes a `thread.client_tool` event to the owner's open tabs; the first
// tab to answer through POST /api/ai/tool-result settles it. The generation waits here until then.
//
// Pending calls live in this process. A call that nobody answers in time resolves to a message the model
// can read, so a closed tab never stalls a turn forever.

import { emit } from './events.js'

export const CLIENT_TOOL_TIMEOUT_MS = 120_000
const MAX_OUTPUT_CHARS = 40_000

type Pending = {
  ownerKey: string
  threadId: string
  name: string
  resolve: (output: string) => void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, Pending>()

function settle(callId: string, output: string): boolean {
  const entry = pending.get(callId)
  if (!entry) return false
  clearTimeout(entry.timer)
  pending.delete(callId)
  entry.resolve(output)
  return true
}

/** Sends one tool call to the owner's tabs and resolves with what the workspace returned. Never rejects. */
export function requestClientTool(args: { ownerKey: string; threadId: string; callId: string; name: string; argsJson: string }): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      settle(args.callId, `The workspace did not answer ${args.name} within ${Math.round(CLIENT_TOOL_TIMEOUT_MS / 1000)} seconds. Open the AI page in a browser tab and try again.`)
    }, CLIENT_TOOL_TIMEOUT_MS)
    pending.set(args.callId, { ownerKey: args.ownerKey, threadId: args.threadId, name: args.name, resolve, timer })
    emit(args.ownerKey, 'thread.client_tool', {
      threadId: args.threadId,
      callId: args.callId,
      name: args.name,
      argsJson: args.argsJson,
      deadline: Date.now() + CLIENT_TOOL_TIMEOUT_MS,
    }).catch((error: unknown) => {
      settle(args.callId, `The workspace request could not be sent: ${error instanceof Error ? error.message : 'unknown error'}`)
    })
  })
}

export type ClientToolAnswer = { output?: unknown; error?: unknown }

/**
 * Settles a pending call with a tab's answer. Only the owner who received the call may answer it.
 * Returns 'ok', 'unknown' (already answered, timed out, or never existed) or 'forbidden'.
 */
export function answerClientTool(callId: string, ownerKey: string, answer: ClientToolAnswer): 'ok' | 'unknown' | 'forbidden' {
  const entry = pending.get(callId)
  if (!entry) return 'unknown'
  if (entry.ownerKey !== ownerKey) return 'forbidden'
  const text = typeof answer.error === 'string' && answer.error.trim()
    ? `Error: ${answer.error.trim().slice(0, MAX_OUTPUT_CHARS)}`
    : typeof answer.output === 'string'
      ? answer.output.slice(0, MAX_OUTPUT_CHARS)
      : ''
  return settle(callId, text || 'The workspace returned no output.') ? 'ok' : 'unknown'
}

/** Ends every pending call of a stopped turn, so the model is not kept waiting on a stopped generation. */
export function cancelClientToolsFor(threadId: string): void {
  for (const [callId, entry] of pending) {
    if (entry.threadId === threadId) settle(callId, 'The turn was stopped before the workspace answered.')
  }
}
