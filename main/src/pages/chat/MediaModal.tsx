// Discord's image modal: a click on message media (attachment or embed image)
// opens the media centered over a dark scrim, fitted with Discord's modal
// limits (min(75% viewport width, 2000) × min(65% viewport height, 2000)),
// with "Open in Browser" underneath. Clicking the media toggles zoom to its
// natural size (pannable by scroll); arrows/←→ page through every visual item
// in the message; Esc or a click on the scrim closes.

import { useCallback, useEffect, useState } from 'react'
import { openOverlay } from './overlay'
import { fitMedia } from './mediaSize'

export interface MediaModalItem {
  // What the modal loads (Discord proxy URL when available).
  src: string
  // The original URL ("Open in Browser").
  original: string
  width: number
  height: number
  kind: 'image' | 'video'
  alt?: string
}

export function openMediaModal(items: MediaModalItem[], index: number): void {
  if (!items.length) return
  openOverlay((close) => <MediaModal items={items} start={Math.max(0, Math.min(index, items.length - 1))} onClose={close} />)
}

function useViewport() {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return size
}

function MediaModal({ items, start, onClose }: { items: MediaModalItem[]; start: number; onClose: () => void }) {
  const [index, setIndex] = useState(start)
  const [zoomed, setZoomed] = useState(false)
  const viewport = useViewport()
  const item = items[index]
  const multi = items.length > 1
  const step = useCallback((delta: number) => {
    setZoomed(false)
    setIndex((i) => (i + delta + items.length) % items.length)
  }, [items.length])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (multi && e.key === 'ArrowLeft') step(-1)
      else if (multi && e.key === 'ArrowRight') step(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, step, multi])

  // Discord's modal fit (515718.z$): 75% × 65% of the viewport, capped at 2000.
  const known = item.width > 0 && item.height > 0
  const fitted = known
    ? fitMedia({
      width: item.width,
      height: item.height,
      maxWidth: Math.min(Math.round(0.75 * viewport.w), 2000),
      maxHeight: Math.min(Math.round(0.65 * viewport.h), 2000),
    })
    : null
  const zoomable = item.kind === 'image' && known && (item.width > (fitted?.width ?? 0) || item.height > (fitted?.height ?? 0))

  return (
    <div
      className="dcModalBackdrop dcMediaBackdrop"
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="dcMediaModal" role="dialog" aria-modal="true" aria-label={item.alt || 'Image'}>
        <div
          className={`dcMediaModalStage${zoomed ? ' zoomed' : ''}`}
          style={zoomed ? { maxWidth: Math.round(0.9 * viewport.w), maxHeight: Math.round(0.85 * viewport.h) } : undefined}
        >
          {item.kind === 'video' ? (
            <video
              className="dcMediaModalMedia"
              src={item.src}
              controls
              autoPlay
              playsInline
              style={fitted ? { width: fitted.width, height: fitted.height } : { maxWidth: '75vw', maxHeight: '65vh' }}
            />
          ) : (
            <img
              className={`dcMediaModalMedia${zoomable ? (zoomed ? ' zoomOut' : ' zoomIn') : ''}`}
              src={item.src}
              alt={item.alt || 'Image'}
              draggable={false}
              style={zoomed
                ? { width: item.width, height: item.height, maxWidth: 'none', maxHeight: 'none' }
                : fitted ? { width: fitted.width, height: fitted.height } : { maxWidth: '75vw', maxHeight: '65vh' }}
              onClick={() => { if (zoomable) setZoomed((z) => !z) }}
            />
          )}
        </div>
        <a className="dcMediaModalOpen" href={item.original} target="_blank" rel="noreferrer noopener">Open in Browser</a>
      </div>
      {multi && (
        <>
          <button type="button" className="dcMediaModalNav prev" aria-label="Previous" onClick={() => step(-1)}>
            <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M15.7 3.3a1 1 0 0 1 0 1.4L8.42 12l7.3 7.3a1 1 0 0 1-1.42 1.4l-8-8a1 1 0 0 1 0-1.4l8-8a1 1 0 0 1 1.42 0Z" /></svg>
          </button>
          <button type="button" className="dcMediaModalNav next" aria-label="Next" onClick={() => step(1)}>
            <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M8.3 3.3a1 1 0 0 0 0 1.4l7.29 7.3-7.3 7.3a1 1 0 1 0 1.42 1.4l8-8a1 1 0 0 0 0-1.4l-8-8a1 1 0 0 0-1.42 0Z" /></svg>
          </button>
          <div className="dcMediaModalCount">{index + 1} / {items.length}</div>
        </>
      )}
    </div>
  )
}
