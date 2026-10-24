// Talking to the platform page that frames this one (protocol.ts).
//
// The parent is one of the platform's origins. The referrer says which; when it is missing (a
// no-referrer policy on the host page) every origin is tried, and postMessage's targetOrigin check
// drops the misses, so a message never reaches a page outside the platform's list.

import { HOLT_PROTOCOL, isHoltMessage, type FrameToHost, type HostToFrame } from './protocol'

export interface HostChannel {
  embedded: boolean
  send(message: FrameToHost): void
  /** Calls `onMessage` for every protocol message the parent sends. Returns an unsubscribe. */
  listen(onMessage: (message: HostToFrame) => void): () => void
}

function parentOrigins(origins: readonly string[]): readonly string[] {
  try {
    const referrer = document.referrer ? new URL(document.referrer).origin.toLowerCase() : ''
    if (origins.includes(referrer)) return [referrer]
  } catch { /* unparseable referrer: try every origin */ }
  return origins
}

export function hostChannel(origins: readonly string[]): HostChannel {
  const embedded = window.parent !== window
  const targets = parentOrigins(origins)
  return {
    embedded,
    send(message) {
      if (!embedded) return
      for (const origin of targets) window.parent.postMessage(message, origin)
    },
    listen(onMessage) {
      const handler = (event: MessageEvent) => {
        if (event.source !== window.parent || !origins.includes(event.origin.toLowerCase())) return
        if (!isHoltMessage(event.data) || event.data.holt !== HOLT_PROTOCOL) return
        if (event.data.type === 'token') {
          const token = (event.data as { token?: unknown }).token
          onMessage({ holt: HOLT_PROTOCOL, type: 'token', token: typeof token === 'string' && token ? token : null })
        }
      }
      window.addEventListener('message', handler)
      return () => window.removeEventListener('message', handler)
    },
  }
}
