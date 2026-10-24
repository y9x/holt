// One request to a user-supplied https endpoint over a socket pinned to an
// address that validate.ts already approved. DNS is not consulted again, so a
// name that flips to a private address between the check and the connect cannot
// reach it. The host name is still used for SNI and the certificate check.
// Redirects are refused rather than followed.
import https from 'node:https'
import { Readable } from 'node:stream'

export interface PinnedAddress {
  address: string
  family: 4 | 6
}

export function pinnedRequest(
  method: 'GET' | 'POST',
  url: string,
  pin: PinnedAddress,
  headers: Record<string, string>,
  body: string | undefined,
  signal?: AbortSignal,
): Promise<Response> {
  const target = new URL(url)
  const options = {
    protocol: 'https:',
    hostname: target.hostname,
    port: target.port || '443',
    path: `${target.pathname}${target.search}`,
    method,
    headers: body === undefined ? { ...headers } : { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
    servername: target.hostname,
    // No socket pooling: pooled sockets are keyed by host name, so a reused
    // socket could skip the pin. Every request dials the approved address.
    agent: false,
    signal,
    lookup: (_host: string, lookupOptions: { all?: boolean }, done: (...args: unknown[]) => void) => {
      if (lookupOptions?.all) done(null, [{ address: pin.address, family: pin.family }])
      else done(null, pin.address, pin.family)
    },
  }

  return new Promise<Response>((resolve, reject) => {
    const req = https.request(options as unknown as https.RequestOptions, (res) => {
      const status = res.statusCode ?? 502
      if (status >= 300 && status < 400) {
        res.resume()
        reject(new Error('The AI endpoint answered with a redirect. Redirects are not followed; use the exact endpoint URL.'))
        return
      }
      const responseHeaders = new Headers()
      for (const [name, value] of Object.entries(res.headers)) {
        if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value)
      }
      if (status === 204 || status === 205 || status === 304) {
        res.resume()
        resolve(new Response(null, { status, headers: responseHeaders }))
        return
      }
      resolve(new Response(Readable.toWeb(res) as unknown as ReadableStream, { status, headers: responseHeaders }))
    })
    req.on('error', reject)
    if (body === undefined) req.end()
    else req.end(body)
  })
}

export function pinnedPost(
  url: string,
  pin: PinnedAddress,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal,
): Promise<Response> {
  return pinnedRequest('POST', url, pin, headers, body, signal)
}
