// Signatures on the private hook between holt and a platform (platforms.ts `hook`), both directions:
//
//   X-Holt-Signature: t=<unix seconds>,v1=<base64url HMAC-SHA256(secret, "<t>.<body>")>
//
// A request is accepted only within five minutes of `t`, so a captured request can't be replayed later.
// The same code is used by the platform's side (abulxt keeps a copy in main/src/server/holt-hook.ts).

import { createHmac, timingSafeEqual } from 'node:crypto'

export const SIGNATURE_HEADER = 'x-holt-signature'
const MAX_SKEW_SECONDS = 300

export function signHookBody(secret: string, body: string, nowMs = Date.now()): string {
  const t = Math.floor(nowMs / 1000)
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('base64url')
  return `t=${t},v1=${v1}`
}

/** Does `header` sign `body` with `secret`, recently? Pure. */
export function verifyHookBody(secret: string, body: string, header: string | string[] | undefined, nowMs = Date.now()): boolean {
  if (typeof header !== 'string') return false
  const parts = Object.fromEntries(header.split(',').map((part) => part.trim().split('=', 2) as [string, string]))
  const t = Number(parts.t)
  if (!Number.isSafeInteger(t) || Math.abs(nowMs / 1000 - t) > MAX_SKEW_SECONDS || typeof parts.v1 !== 'string') return false
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${body}`).digest('base64url'))
  const given = Buffer.from(parts.v1)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** POST a JSON body to the platform's hook, signed. Throws on a network error or a non-2xx answer. */
export async function postToHook(hook: { url: string; secret: string }, path: string, payload: unknown, timeoutMs = 2500): Promise<unknown> {
  const body = JSON.stringify(payload)
  const response = await fetch(`${hook.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signHookBody(hook.secret, body) },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`hook ${path} answered ${response.status}`)
  return response.headers.get('content-type')?.includes('json') ? response.json() : null
}
