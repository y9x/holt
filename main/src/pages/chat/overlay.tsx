// Imperative overlay host for chat modals opened from outside the React tree
// - e.g. a click on a link inside dangerouslySetInnerHTML message markup (the
// "Leaving Discord" warning), on message media (the image modal), or the
// embed-suppress confirmation. Like Discord's layer stack, the host is a
// window-level layer: it lives directly under <body>, fixed over the whole
// browser window above the site shell and sidebar. It carries the
// `chat-page` class so the Discord token variables scoped there apply
// (dcOverlayBody neutralizes the chat root's layout box). One overlay is shown
// at a time; opening another replaces it.

import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

let host: HTMLDivElement | null = null
let root: Root | null = null

function ensureRoot(): Root {
  if (!host || !host.isConnected) {
    host = document.createElement('div')
    host.className = 'chat-page dcOverlayBody'
    document.body.appendChild(host)
    root = createRoot(host)
  }
  // Keep the host last in <body> so it stacks above later-added portals.
  if (host.nextSibling) document.body.appendChild(host)
  return root!
}

export function closeOverlay(): void {
  root?.render(null)
}

// Popout layer (Discord's layer container for Popouts): a click-through,
// viewport-sized fixed box appended as the LAST child of the live chat root,
// so anchored popouts (popout.tsx) escape every ancestor's overflow clip,
// inline-size container and backdrop-filter, yet still stack inside the chat
// page - below its modals (delete/forward/settings) and context menus, and
// below the window-level modal host above. Popouts set their own
// pointer-events back to auto.
let layer: HTMLDivElement | null = null

export function popoutLayer(): HTMLElement {
  const root = document.querySelector('.chat-page:not(.dcOverlayBody)')
  if (layer && layer.isConnected && layer.parentElement === root) return layer
  layer = document.createElement('div')
  layer.className = 'chatPopoutLayer'
  Object.assign(layer.style, { position: 'fixed', inset: '0', zIndex: '50', pointerEvents: 'none' })
  ;(root || document.body).appendChild(layer)
  return layer
}

// Select layer: the top of the layer stack, for field-anchored listboxes
// (DiscordSelect.tsx) and date pickers. Those fields live inside modals
// (onboarding, Notification Settings, search Filters…) that stack above the
// popout layer, and inside scrollers that clip, so their popouts go in a
// window-level fixed layer directly under <body> - like the overlay host,
// with the `chat-page` class for the tokens - stacked one above the host.
let selectHost: HTMLDivElement | null = null

export function selectLayer(): HTMLElement {
  if (!selectHost) {
    selectHost = document.createElement('div')
    selectHost.className = 'chat-page dcOverlayBody dcSelectLayer'
    selectHost.style.zIndex = '2147483001'
  }
  if (!selectHost.isConnected) document.body.appendChild(selectHost)
  return selectHost
}

// Render `render(close)` as the active overlay. Returns the close function.
export function openOverlay(render: (close: () => void) => ReactNode): () => void {
  const r = ensureRoot()
  const close = () => r.render(null)
  r.render(render(close))
  return close
}
