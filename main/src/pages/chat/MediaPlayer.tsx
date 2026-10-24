// Discord's inline audio/video player (the chat-embed "wrapper" + controls bar).
//
// Ported from Discord's client: the control bar (play/pause, time, seek bar,
// volume pill, fullscreen), the vertical volume slider that opens on hover or
// keyboard focus and stays open while dragged, the 3s idle hide for video
// (1s in fullscreen, never while playing is paused or a bar is being dragged),
// and the play/pause pop. Glyphs are Discord's own SVG paths.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import './media-player.css'

// Discord's icon paths (24x24 viewBox), copied from its client bundle.
// Control-bar glyphs are 16px inside the 24px control box (Discord's
// controlIcon: 4px padding), the same as its PlayIcon size "xs".
const ICON_PLAY = ['M9.25 3.35C7.87 2.45 6 3.38 6 4.96v14.08c0 1.58 1.87 2.5 3.25 1.61l10.85-7.04a1.9 1.9 0 0 0 0-3.22L9.25 3.35Z']
const ICON_PAUSE = ['M6 4a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H6ZM15 4a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1h-3Z']
const ICON_REPLAY = ['M12,5 L12,1 L7,6 L12,11 L12,7 C15.31,7 18,9.69 18,13 C18,16.31 15.31,19 12,19 C8.69,19 6,16.31 6,13 L4,13 C4,17.42 7.58,21 12,21 C16.42,21 20,17.42 20,13 C20,8.58 16.42,5 12,5 L12,5 Z']
const ICON_VOLUME_HIGH = [
  'M12 3a1 1 0 0 0-1-1h-.06a1 1 0 0 0-.74.32L5.92 7H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2.92l4.28 4.68a1 1 0 0 0 .74.32H11a1 1 0 0 0 1-1V3ZM15.1 20.75c-.58.14-1.1-.33-1.1-.92v-.03c0-.5.37-.92.85-1.05a7 7 0 0 0 0-13.5A1.11 1.11 0 0 1 14 4.2v-.03c0-.6.52-1.06 1.1-.92a9 9 0 0 1 0 17.5Z',
  'M15.16 16.51c-.57.28-1.16-.2-1.16-.83v-.14c0-.43.28-.8.63-1.02a3 3 0 0 0 0-5.04c-.35-.23-.63-.6-.63-1.02v-.14c0-.63.59-1.1 1.16-.83a5 5 0 0 1 0 9.02Z',
]
const ICON_VOLUME_LOW = [
  'M12 3a1 1 0 0 0-1-1h-.06a1 1 0 0 0-.74.32L5.92 7H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2.92l4.28 4.68a1 1 0 0 0 .74.32H11a1 1 0 0 0 1-1V3ZM15.18 15.36c-.55.35-1.18-.12-1.18-.78v-.27c0-.36.2-.67.45-.93a2 2 0 0 0 0-2.76c-.24-.26-.45-.57-.45-.93v-.27c0-.66.63-1.13 1.18-.78a4 4 0 0 1 0 6.72Z',
]
const ICON_VOLUME_OFF = [
  'M12 3a1 1 0 0 0-1-1h-.06a1 1 0 0 0-.74.32L5.92 7H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2.92l4.28 4.68a1 1 0 0 0 .74.32H11a1 1 0 0 0 1-1V3ZM22.7 8.3a1 1 0 0 0-1.4 0L19 10.58l-2.3-2.3a1 1 0 1 0-1.4 1.42L17.58 12l-2.3 2.3a1 1 0 0 0 1.42 1.4L19 13.42l2.3 2.3a1 1 0 0 0 1.4-1.42L20.42 12l2.3-2.3a1 1 0 0 0 0-1.4Z',
]
const ICON_FULLSCREEN = ['M4 6c0-1.1.9-2 2-2h3a1 1 0 0 0 0-2H6a4 4 0 0 0-4 4v3a1 1 0 0 0 2 0V6ZM4 18c0 1.1.9 2 2 2h3a1 1 0 1 1 0 2H6a4 4 0 0 1-4-4v-3a1 1 0 1 1 2 0v3ZM18 4a2 2 0 0 1 2 2v3a1 1 0 1 0 2 0V6a4 4 0 0 0-4-4h-3a1 1 0 1 0 0 2h3ZM20 18a2 2 0 0 1-2 2h-3a1 1 0 1 0 0 2h3a4 4 0 0 0 4-4v-3a1 1 0 1 0-2 0v3Z']
const ICON_FULLSCREEN_EXIT = ['M8 6a2 2 0 0 1-2 2H3a1 1 0 0 0 0 2h3a4 4 0 0 0 4-4V3a1 1 0 0 0-2 0v3ZM8 18a2 2 0 0 0-2-2H3a1 1 0 1 1 0-2h3a4 4 0 0 1 4 4v3a1 1 0 1 1-2 0v-3ZM18 8a2 2 0 0 1-2-2V3a1 1 0 1 0-2 0v3a4 4 0 0 0 4 4h3a1 1 0 1 0 0-2h-3ZM16 18c0-1.1.9-2 2-2h3a1 1 0 1 0 0-2h-3a4 4 0 0 0-4 4v3a1 1 0 1 0 2 0v-3Z']

const HIDE_AFTER_MS = 3000
const HIDE_AFTER_FULLSCREEN_MS = 1000
const SEEK_STEP_SEC = 5
const VOLUME_STEP = 0.05
const SHOW_TIME_MIN_WIDTH = 250

type DragKind = 'duration' | 'volume' | null

export interface MediaPlayerProps {
  kind: 'audio' | 'video'
  src: string
  poster?: string
  width?: number
  height?: number
  /** Metadata row (audio) or overlay (video) rendered by the embed. */
  header?: ReactNode
  durationHint?: number | null
}

function PlayerIcon({ paths, size }: { paths: readonly string[]; size: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none">
      {paths.map((d, i) => <path key={i} fill="currentColor" d={d} />)}
    </svg>
  )
}

// Discord's time format: m:ss (no hour split), current time padded to the
// total's width.
function formatTime(seconds: number): string {
  const t = Math.floor(seconds)
  const s = t % 60
  return `${(t - s) / 60}:${String(s).padStart(2, '0')}`
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

function readBuffers(el: HTMLMediaElement): Array<[number, number]> {
  const dur = el.duration
  if (!Number.isFinite(dur) || dur <= 0) return []
  const out: Array<[number, number]> = []
  for (let i = 0; i < el.buffered.length; i++) {
    const start = el.buffered.start(i)
    const end = el.buffered.end(i)
    if (end - start < 1) continue
    out.push([start / dur, (end - start) / dur])
  }
  return out
}

export function MediaPlayer({ kind, src, poster, width, height, header, durationHint }: MediaPlayerProps) {
  const isVideo = kind === 'video'
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)
  const volBarRef = useRef<HTMLDivElement | null>(null)
  const progressRef = useRef<HTMLDivElement | null>(null)
  const curRef = useRef<HTMLSpanElement | null>(null)
  const totRef = useRef<HTMLSpanElement | null>(null)
  const lastMoveRef = useRef(0)
  const draggingRef = useRef<DragKind>(null)
  const fullscreenRef = useRef(false)
  const volTimer = useRef<number | undefined>(undefined)
  const dragCleanup = useRef<(() => void) | null>(null)

  const [playing, setPlaying] = useState(false)
  const [started, setStarted] = useState(false)
  const [ended, setEnded] = useState(false)
  const [buffers, setBuffers] = useState<Array<[number, number]>>([])
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [dragging, setDragging] = useState<DragKind>(null)
  const [volHover, setVolHover] = useState(false)
  const [volFocus, setVolFocus] = useState(false)
  const [preview, setPreview] = useState<number | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [pop, setPop] = useState<{ key: number; glyph: 'play' | 'pause' } | null>(null)
  // Measured player width (Discord's getWidth()): the time readout is shown
  // only when the player is wider than 250px.
  const [boxWidth, setBoxWidth] = useState<number | null>(null)

  const setMedia = useCallback((el: HTMLMediaElement | null) => {
    mediaRef.current = el
  }, [])

  const durationNow = useCallback((): number => {
    const el = mediaRef.current
    if (el && Number.isFinite(el.duration) && el.duration > 0) return el.duration
    return durationHint && durationHint > 0 ? durationHint : 0
  }, [durationHint])

  // Progress and time text are painted straight into the DOM (no React
  // re-render per frame), the same way Discord animates its bar.
  const paint = useCallback(() => {
    const el = mediaRef.current
    const dur = durationNow()
    const cur = el && dur ? Math.min(Math.max(el.currentTime || 0, 0), dur) : 0
    if (progressRef.current) progressRef.current.style.width = `${dur ? (cur / dur) * 100 : 0}%`
    const total = dur ? formatTime(dur) : '-:--'
    if (curRef.current) curRef.current.textContent = dur ? formatTime(cur).padStart(total.length, '0') : '-:--'
    if (totRef.current) totRef.current.textContent = total
  }, [durationNow])

  useEffect(() => {
    const el = mediaRef.current
    if (!el) return
    const onPlay = () => {
      setPlaying(true)
      setEnded(false)
      setStarted(true)
      lastMoveRef.current = Date.now()
    }
    const onPause = () => {
      setPlaying(false)
      setHidden(false)
    }
    const onEnded = () => {
      setPlaying(false)
      setEnded(true)
      setHidden(false)
    }
    const onProgress = () => setBuffers(readBuffers(el))
    const onTime = () => paint()
    const events: Array<[string, () => void]> = [
      ['play', onPlay],
      ['pause', onPause],
      ['ended', onEnded],
      ['progress', onProgress],
      ['timeupdate', onTime],
      ['seeking', onTime],
      ['seeked', onTime],
      ['loadedmetadata', onTime],
      ['durationchange', onTime],
    ]
    for (const [name, fn] of events) el.addEventListener(name, fn)
    paint()
    return () => {
      for (const [name, fn] of events) el.removeEventListener(name, fn)
    }
  }, [paint])

  // Volume is applied to the element; muting is separate, as in Discord.
  useEffect(() => {
    const el = mediaRef.current
    if (!el) return
    el.volume = volume
    el.muted = muted
  }, [volume, muted])

  // While playing: keep the bar moving and hide video controls after 3s of
  // mouse stillness (1s in fullscreen). Never hide while a bar is dragged.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      paint()
      if (isVideo) {
        const idle = Date.now() - lastMoveRef.current > (fullscreenRef.current ? HIDE_AFTER_FULLSCREEN_MS : HIDE_AFTER_MS)
        setHidden(draggingRef.current ? false : idle)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, isVideo, paint])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => setBoxWidth(el.getBoundingClientRect().width)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const onChange = () => {
      const on = document.fullscreenElement === wrapRef.current
      fullscreenRef.current = on
      setFullscreen(on)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      dragCleanup.current?.()
      if (volTimer.current !== undefined) window.clearTimeout(volTimer.current)
    }
  }, [])

  const showPop = (glyph: 'play' | 'pause') => setPop({ key: Date.now(), glyph })

  const togglePlay = () => {
    const el = mediaRef.current
    if (!el) return
    if (el.paused) {
      setStarted(true)
      showPop('play')
      void el.play().catch(() => {})
    } else {
      showPop('pause')
      el.pause()
    }
  }

  const replay = () => {
    const el = mediaRef.current
    if (!el) return
    el.currentTime = 0
    setEnded(false)
    void el.play().catch(() => {})
  }

  const seekBy = (delta: number) => {
    const el = mediaRef.current
    const dur = durationNow()
    if (!el || !dur) return
    el.currentTime = Math.min(dur, Math.max(0, el.currentTime + delta))
    paint()
  }

  const seekRatio = (ratio: number) => {
    const el = mediaRef.current
    const dur = durationNow()
    if (el && dur) {
      el.currentTime = ratio * dur
      paint()
    }
    setPreview(ratio)
  }

  const applyVolume = (v: number) => {
    if (v <= 0) {
      setVolume(0)
      setMuted(true)
    } else {
      setVolume(v)
      setMuted(false)
    }
  }

  const beginDrag = (
    type: Exclude<DragKind, null>,
    track: HTMLElement,
    ratioAt: (x: number, y: number, rect: DOMRect) => number,
    apply: (ratio: number) => void,
    e: ReactMouseEvent<HTMLElement>,
  ) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragCleanup.current?.()
    draggingRef.current = type
    setDragging(type)
    const update = (ev: MouseEvent) => apply(ratioAt(ev.clientX, ev.clientY, track.getBoundingClientRect()))
    const end = () => {
      window.removeEventListener('mousemove', update)
      window.removeEventListener('mouseup', end)
      dragCleanup.current = null
      draggingRef.current = null
      setDragging(null)
      setPreview(null)
      lastMoveRef.current = Date.now()
    }
    window.addEventListener('mousemove', update)
    window.addEventListener('mouseup', end)
    dragCleanup.current = end
    update(e.nativeEvent)
  }

  const volumeEnter = () => {
    if (volTimer.current !== undefined) window.clearTimeout(volTimer.current)
    setVolHover(true)
  }
  // Discord keeps the slider open for 150ms after the pointer leaves.
  const volumeLeave = () => {
    if (volTimer.current !== undefined) window.clearTimeout(volTimer.current)
    volTimer.current = window.setTimeout(() => setVolHover(false), 150)
  }

  const onVolumeKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    e.stopPropagation()
    if (!volFocus) {
      setVolFocus(true)
      return
    }
    const next = e.key === 'ArrowUp' ? Math.min(1, volume + VOLUME_STEP) : Math.max(0, volume - VOLUME_STEP)
    applyVolume(next)
  }

  const onRootKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.key === ' ' || e.key.toLowerCase() === 'k') {
      e.preventDefault()
      if (ended) replay()
      else togglePlay()
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      seekBy(e.key === 'ArrowLeft' ? -SEEK_STEP_SEC : SEEK_STEP_SEC)
    }
  }

  const onRootMove = () => {
    if (!isVideo) return
    lastMoveRef.current = Date.now()
    setHidden(false)
  }

  const onRootLeave = () => {
    if (playing) lastMoveRef.current = 0
  }

  const toggleFullscreen = () => {
    const el = wrapRef.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void el.requestFullscreen?.().catch(() => {})
  }

  const stop = (e: ReactMouseEvent<HTMLElement>) => e.stopPropagation()

  const showControls = !isVideo || started
  const volumeGlyph = muted || volume === 0 ? ICON_VOLUME_OFF : volume < 0.5 ? ICON_VOLUME_LOW : ICON_VOLUME_HIGH
  const sliderVisible = volHover || volFocus || dragging === 'volume'
  const showTime = (boxWidth ?? width ?? 432) > SHOW_TIME_MIN_WIDTH
  const previewRatio = preview ?? 0
  const previewLabel = formatTime(previewRatio * durationNow())
  const playGlyph = playing ? ICON_PAUSE : ended ? ICON_REPLAY : ICON_PLAY

  const controls = showControls ? (
    <div className={isVideo ? 'dcVideoControls' : 'dcAudioControls'} onClick={stop} onDoubleClick={stop}>
      <button
        type="button"
        className="dcControlButton dcVideoButton"
        aria-label={playing ? 'Pause' : ended ? 'Replay' : 'Play'}
        onClick={ended ? replay : togglePlay}
      >
        <span className="dcControlIcon"><PlayerIcon paths={playGlyph} size={16} /></span>
      </button>
      {showTime && (
        <div className="dcDurationTimeWrapper">
          <span className="dcDurationTimeDisplay" ref={curRef} />
          <span className="dcDurationTimeSeparator">/</span>
          <span className="dcDurationTimeDisplay" ref={totRef} />
        </div>
      )}
      <div
        className={`dcMediaBarInteraction${dragging === 'duration' ? ' dragging' : ''}`}
        ref={barRef}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(durationNow())}
        aria-valuenow={Math.round((mediaRef.current?.currentTime ?? 0))}
        tabIndex={0}
        onMouseDown={(e) => {
          const track = barRef.current
          if (!track) return
          beginDrag('duration', track, (x, _y, rect) => clamp01((x - rect.left) / rect.width), seekRatio, e)
        }}
        onMouseMove={(e) => {
          if (draggingRef.current) return
          const rect = e.currentTarget.getBoundingClientRect()
          setPreview(clamp01((e.clientX - rect.left) / rect.width))
        }}
        onMouseLeave={() => {
          if (!draggingRef.current) setPreview(null)
        }}
      >
        <div className="dcMediaBarWrapper">
          {buffers.map(([start, size], i) => (
            <div key={i} className="dcMediaBarBuffer" style={{ left: `${start * 100}%`, width: `${size * 100}%` }} />
          ))}
          <div className="dcMediaBarPreview" style={{ width: `${previewRatio * 100}%` }} />
          <div className="dcMediaBarProgress" ref={progressRef}>
            <span className="dcMediaBarGrabber" />
          </div>
          <div className="dcMediaBarBubble" style={{ left: `${previewRatio * 100}%` }}>{previewLabel}</div>
        </div>
      </div>
      <div className="dcVolumeControl" onMouseEnter={volumeEnter} onMouseLeave={volumeLeave} onBlur={() => setVolFocus(false)} onKeyDown={onVolumeKey}>
        <div className={`dcVolumeButtonSlider${sliderVisible ? ' sliderVisible' : ''}`} onMouseEnter={volumeEnter} onMouseLeave={volumeLeave}>
          <div className="dcMediaBar dcMediaBarVertical">
            <div
              className="dcMediaBarInteraction dcMediaBarInteractionVolume"
              ref={volBarRef}
              onMouseDown={(e) => {
                const track = volBarRef.current
                if (!track) return
                beginDrag('volume', track, (_x, y, rect) => clamp01((rect.bottom - y) / rect.height), applyVolume, e)
              }}
            >
              <div className="dcMediaBarWrapper dcMediaBarWrapperVolume">
                <div className="dcMediaBarProgress" style={{ width: `${(muted ? 0 : volume) * 100}%` }}>
                  <span className="dcMediaBarGrabber" />
                </div>
              </div>
            </div>
          </div>
        </div>
        <button type="button" className="dcVolumeButton" aria-label={muted ? 'Unmute' : 'Mute'} onClick={() => setMuted((m) => !m)}>
          <span className="dcControlIcon"><PlayerIcon paths={volumeGlyph} size={16} /></span>
        </button>
      </div>
      {isVideo && (
        <button
          type="button"
          className="dcControlButton dcVideoButton"
          aria-label={fullscreen ? 'Exit Full Screen' : 'Full Screen'}
          onClick={toggleFullscreen}
        >
          <span className="dcControlIcon"><PlayerIcon paths={fullscreen ? ICON_FULLSCREEN_EXIT : ICON_FULLSCREEN} size={16} /></span>
        </button>
      )}
    </div>
  ) : null

  if (!isVideo) {
    return (
      <div ref={wrapRef} className="dcMediaWrapper dcWrapperAudio" tabIndex={0} onKeyDown={onRootKey}>
        {header}
        <audio ref={setMedia} className="dcAudio" src={src} preload="metadata" />
        {controls}
      </div>
    )
  }

  const rootClass = [
    'dcMediaWrapper',
    'dcWrapperVideo',
    playing ? 'wrapperPlaying' : 'wrapperPaused',
    hidden ? 'wrapperControlsHidden' : '',
    fullscreen ? 'fullscreen' : '',
  ].filter(Boolean).join(' ')

  return (
    <div
      ref={wrapRef}
      className={rootClass}
      style={width && height ? { aspectRatio: `${width} / ${height}` } : undefined}
      tabIndex={0}
      onKeyDown={onRootKey}
      onMouseMove={onRootMove}
      onMouseLeave={onRootLeave}
    >
      {header}
      <video
        ref={setMedia}
        className="dcVideo"
        src={src}
        poster={poster}
        preload={poster ? 'none' : 'metadata'}
        playsInline
        onClick={togglePlay}
      />
      {!started && (
        <div className="dcPlayCenter">
          <button type="button" className="dcPlayCenterButton" aria-label="Play" onClick={togglePlay}>
            <PlayerIcon paths={ICON_PLAY} size={24} />
          </button>
        </div>
      )}
      {pop && (
        <div key={pop.key} className="dcPlayPausePop" onAnimationEnd={() => setPop(null)}>
          <PlayerIcon paths={pop.glyph === 'play' ? ICON_PLAY : ICON_PAUSE} size={24} />
        </div>
      )}
      {controls}
    </div>
  )
}
