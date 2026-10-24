import { useEffect, useRef, useState } from 'react'
import { HolyText } from '../../components/common/HolyText'
import { useHolyAttr } from '../../lib/holy-attr'
import { backdropDismissProps } from './ContextMenu'
import { DEFAULT_FOLDER_COLOR } from './guildFolders'

/* Discord's Folder Settings modal: "Folder Name" + "Folder Color", Done saves,
 * Escape / close / backdrop discard. The color picker follows Discord's shared
 * ColorPicker (lazy module 508274): a large default swatch, a large custom
 * swatch (pencil; here it opens the browser's color picker), then the 20 preset
 * colors in two rows. Folder chunk 906240 isn't in the ripped bundle, so the
 * layout is inferred from the shared picker; the strings are Discord's. */

// Discord's preset color list (constant _tK, web bundle @376437).
const PRESET_COLORS = [
  0x1abc9c, 0x2ecc71, 0x3498db, 0x9b59b6, 0xe91e63, 0xf1c40f, 0xe67e22, 0xe74c3c, 0x95a5a6, 0x607d8b,
  0x11806a, 0x1f8b4c, 0x206694, 0x71368a, 0xad1457, 0xc27c0e, 0xa84300, 0x992d22, 0x979c9f, 0x546e7a,
]

const FOLDER_NAME_MAX = 32

const hex = (color: number) => `#${color.toString(16).padStart(6, '0')}`

// The checkmark is dark on light swatches, white on dark ones (Discord picks by luminance).
function checkColor(color: number): string {
  const r = (color >> 16) & 0xff
  const g = (color >> 8) & 0xff
  const b = color & 0xff
  return 0.299 * r + 0.587 * g + 0.114 * b > 186 ? '#000' : '#fff'
}

const CHECK_PATH = 'M18.7 7.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4l3.3 3.29 7.3-7.3a1 1 0 0 1 1.4 0Z'
const PENCIL_PATH = 'm13.96 5.46 4.58 4.58a1 1 0 0 0 1.42 0l1.38-1.38a2 2 0 0 0 0-2.82l-3.18-3.18a2 2 0 0 0-2.82 0l-1.38 1.38a1 1 0 0 0 0 1.42ZM2.11 20.16l.73-4.22a3 3 0 0 1 .83-1.61l7.87-7.87a1 1 0 0 1 1.42 0l4.58 4.58a1 1 0 0 1 0 1.42l-7.87 7.87a3 3 0 0 1-1.6.83l-4.23.73a1.5 1.5 0 0 1-1.73-1.73Z'

function Swatch({ color, selected, onSelect, large, label }: { color: number; selected: boolean; onSelect: () => void; large?: boolean; label: string }) {
  // The hex value is a data value; the "Default" label is static and wrapped.
  const holy = useHolyAttr({ 'aria-label': label })
  return (
    <button
      type="button"
      ref={holy.ref}
      {...holy.placeholder}
      role="radio"
      aria-checked={selected}
      className={`gfsSwatch${large ? ' gfsSwatchLarge' : ''}`}
      style={{ backgroundColor: hex(color) }}
      onClick={onSelect}
    >
      {selected && (
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill={checkColor(color)} d={CHECK_PATH} /></svg>
      )}
    </button>
  )
}

export function FolderSettingsModal({ name, color, placeholder, onSave, onClose }: {
  name: string | null
  color: number | null
  /** The unnamed-folder label (its servers' names), shown as the input placeholder. */
  placeholder: string
  onSave: (patch: { name: string | null; color: number | null }) => void
  onClose: () => void
}) {
  const [draftName, setDraftName] = useState(name ?? '')
  const [draftColor, setDraftColor] = useState<number>(color ?? DEFAULT_FOLDER_COLOR)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const isCustom = draftColor !== DEFAULT_FOLDER_COLOR && !PRESET_COLORS.includes(draftColor)
  const dialogLabel = useHolyAttr({ 'aria-label': 'Folder Settings' })
  const closeLabel = useHolyAttr({ 'aria-label': 'Close' })
  const customLabel = useHolyAttr({ 'aria-label': 'Custom color' })
  const nameLabel = useHolyAttr({ 'aria-label': 'Folder Name' })

  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = () => {
    onSave({ name: draftName.trim() || null, color: draftColor === DEFAULT_FOLDER_COLOR ? null : draftColor })
    onClose()
  }

  return (
    <div className="gnmBackdrop" role="presentation" {...backdropDismissProps(onClose)}>
      <div className="gnmModal gfsModal" role="dialog" aria-modal="true" ref={dialogLabel.ref} {...dialogLabel.placeholder}>
        <header className="gnmHeader">
          <HolyText as="h2" className="gnmTitle" text="Folder Settings" />
          <button type="button" className="gnmClose" ref={closeLabel.ref} {...closeLabel.placeholder} onClick={onClose}>
            <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z" /></svg>
          </button>
        </header>
        <form className="gfsForm" onSubmit={(e) => { e.preventDefault(); save() }}>
          <div className="gnmBody">
          <section className="gnmSection">
            <label className="gnmField">
              <HolyText className="gnmFieldLabel" text="Folder Name" />
              {/* The placeholder is the folder's server names (a data value), so
                  only the static label is obfuscated. */}
              <input
                ref={(node) => { inputRef.current = node; nameLabel.ref(node) }}
                {...nameLabel.placeholder}
                className="gfsInput"
                placeholder={placeholder}
                maxLength={FOLDER_NAME_MAX}
                value={draftName}
                onChange={(e) => setDraftName(e.currentTarget.value)}
              />
            </label>
          </section>
          <section className="gnmSection">
            <HolyText className="gnmFieldLabel" text="Folder Color" />
            <div className="gfsPicker" role="radiogroup">
              <Swatch color={DEFAULT_FOLDER_COLOR} large label="Default" selected={draftColor === DEFAULT_FOLDER_COLOR} onSelect={() => setDraftColor(DEFAULT_FOLDER_COLOR)} />
              <label
                className={`gfsSwatch gfsSwatchLarge gfsSwatchCustom${isCustom ? ' selected' : ''}`}
                style={isCustom ? { backgroundColor: hex(draftColor) } : undefined}
                ref={customLabel.ref}
                {...customLabel.placeholder}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" className="gfsPencil"><path fill={isCustom ? checkColor(draftColor) : 'currentColor'} d={PENCIL_PATH} /></svg>
                {isCustom && <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill={checkColor(draftColor)} d={CHECK_PATH} /></svg>}
                <input
                  type="color"
                  className="gfsNativeColor"
                  value={hex(draftColor)}
                  onChange={(e) => setDraftColor(parseInt(e.currentTarget.value.slice(1), 16))}
                />
              </label>
              <div className="gfsPresets">
                {[PRESET_COLORS.slice(0, 10), PRESET_COLORS.slice(10)].map((row, index) => (
                  <div className="gfsPresetRow" key={index}>
                    {row.map((preset) => (
                      <Swatch key={preset} color={preset} label={hex(preset)} selected={draftColor === preset} onSelect={() => setDraftColor(preset)} />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </section>
          </div>
          <footer className="gnmFooter">
            <button type="submit" className="gnmDone"><HolyText text="Done" /></button>
          </footer>
        </form>
      </div>
    </div>
  )
}
