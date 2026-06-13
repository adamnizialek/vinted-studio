import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { Modal } from '@/components/ui'
import { useMediaQuery } from '@/lib/useMediaQuery'

const GAP = 6 // px between trigger and panel
const MARGIN = 8 // px min distance from viewport edge

/**
 * Anchored popover rendered in a portal on document.body so it escapes the card's
 * `overflow-hidden`. Positioned with fixed coords from the trigger's rect; clamps
 * horizontally to the viewport and flips above the trigger when there isn't room
 * below. Closes on outside-pointerdown, Escape (restoring focus to the trigger),
 * and any scroll/resize (so it never orphans). Desktop only — mobile uses Modal.
 */
function PopoverPanel({
  anchorRef,
  onClose,
  children,
  ariaLabel,
}: {
  anchorRef: RefObject<HTMLElement>
  onClose: () => void
  children: ReactNode
  ariaLabel: string
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const panel = panelRef.current
    if (!anchor || !panel) return
    const a = anchor.getBoundingClientRect()
    const pw = panel.offsetWidth
    const ph = panel.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    // Vertical: prefer below; flip above if it would overflow the bottom.
    let top = a.bottom + GAP
    if (top + ph > vh - MARGIN && a.top - GAP - ph >= MARGIN) top = a.top - GAP - ph
    top = Math.max(MARGIN, Math.min(top, vh - ph - MARGIN))
    // Horizontal: align left edges, clamp into the viewport.
    let left = a.left
    left = Math.max(MARGIN, Math.min(left, vw - pw - MARGIN))
    setPos({ top, left })
  }, [anchorRef])

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!panelRef.current?.contains(t) && !anchorRef.current?.contains(t)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        anchorRef.current?.focus()
      }
    }
    const onScrollOrResize = () => onClose()
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    // capture:true so we also catch scrolls inside any nested scroll container.
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [anchorRef, onClose])

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={ariaLabel}
      style={{
        position: 'fixed',
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        visibility: pos ? 'visible' : 'hidden',
      }}
      className="z-[70] min-w-[11rem] max-w-[80vw] rounded-xl bg-white p-1 shadow-pop ring-1 ring-ink-100"
    >
      {children}
    </div>,
    document.body,
  )
}

export interface PickerTriggerProps {
  ref: RefObject<HTMLButtonElement>
  open: boolean
  toggle: () => void
  /** Spread directly onto the trigger button. */
  aria: { 'aria-haspopup': 'dialog'; 'aria-expanded': boolean }
}

/**
 * Picker shell: renders `trigger` (which must spread `aria` onto a button and attach
 * `ref`), then — when open — shows `children` in an anchored popover on desktop
 * (>=640px) or the existing Modal bottom-sheet on mobile. `children` is a render-prop
 * receiving `close` so options can dismiss after selecting.
 */
export function ResponsivePicker({
  title,
  trigger,
  children,
}: {
  title: string
  trigger: (p: PickerTriggerProps) => ReactNode
  children: (close: () => void) => ReactNode
}) {
  const isDesktop = useMediaQuery('(min-width: 640px)')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const close = () => setOpen(false)

  return (
    <>
      {trigger({
        ref,
        open,
        toggle: () => setOpen((v) => !v),
        aria: { 'aria-haspopup': 'dialog', 'aria-expanded': open },
      })}
      {open &&
        (isDesktop ? (
          <PopoverPanel anchorRef={ref} onClose={close} ariaLabel={title}>
            {children(close)}
          </PopoverPanel>
        ) : (
          <Modal open onClose={close} title={title} size="sm">
            <div className="-m-1">{children(close)}</div>
          </Modal>
        ))}
    </>
  )
}

/** Shared option-row look for both pickers. */
export function OptionRow({
  selected,
  onClick,
  children,
}: {
  selected?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={clsx(
        'flex min-h-[44px] w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition hover:bg-ink-50',
        selected && 'bg-ink-50',
      )}
    >
      {children}
    </button>
  )
}
