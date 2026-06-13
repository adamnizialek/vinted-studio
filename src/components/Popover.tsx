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
 * horizontally to the viewport, flips above the trigger when there isn't room below,
 * and caps its height to the viewport (scrolling internally when the list is long).
 * Closes on outside-pointerdown, Escape (restoring focus to the trigger), and any
 * window scroll/resize — but NOT on scrolls that originate inside the panel itself
 * (those scroll the list). Desktop only — touch/mobile uses the Modal bottom-sheet.
 */
function PopoverPanel({
  anchorRef,
  onClose,
  children,
}: {
  anchorRef: RefObject<HTMLElement>
  onClose: () => void
  children: ReactNode
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const panel = panelRef.current
    if (!anchor || !panel) return
    const a = anchor.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const pw = panel.offsetWidth
    // Clamp the measured height to the viewport so the positioning math matches what
    // the CSS max-height actually renders (the panel scrolls internally beyond this).
    const ph = Math.min(panel.offsetHeight, vh - 2 * MARGIN)
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
    // Close when the page scrolls (anchor moves away) — but ignore scrolls inside the
    // panel's own list, otherwise scrolling a long list would dismiss it.
    const onScroll = (e: Event) => {
      if (!panelRef.current?.contains(e.target as Node)) onClose()
    }
    const onResize = () => onClose()
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    // capture:true so we also catch scrolls inside any nested scroll container.
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [anchorRef, onClose])

  return createPortal(
    <div
      ref={panelRef}
      style={{
        position: 'fixed',
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        visibility: pos ? 'visible' : 'hidden',
      }}
      className="z-[70] max-h-[calc(100vh-16px)] min-w-[11rem] max-w-[80vw] overflow-y-auto overscroll-contain rounded-xl bg-white p-1 shadow-pop ring-1 ring-ink-100"
    >
      {children}
    </div>,
    document.body,
  )
}

export interface PickerTriggerProps {
  ref: RefObject<HTMLButtonElement>
  toggle: () => void
  /** Spread directly onto the trigger button (carries the open state via aria-expanded). */
  aria: { 'aria-haspopup': 'menu'; 'aria-expanded': boolean }
}

/**
 * Picker shell: renders `trigger` (which must spread `aria` onto a button and attach
 * `ref`), then — when open — shows `children` in an anchored popover on desktop
 * (fine pointer + width >= 640px) or the existing Modal bottom-sheet on touch/mobile.
 * `children` is a render-prop receiving `close` so options can dismiss after selecting.
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
  // Route ALL touch devices (phones AND tablets, any width) to the scroll-locked
  // Modal sheet; only a fine-pointer desktop gets the anchored popover (whose
  // close-on-page-scroll behaviour would misfire on a touch surface).
  const isDesktop = useMediaQuery('(min-width: 640px) and (hover: hover) and (pointer: fine)')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const close = () => {
    setOpen(false)
    ref.current?.focus()
  }

  // Dismiss cleanly if the breakpoint/pointer changes while open, rather than morphing
  // the bottom-sheet into an anchored popover (or vice-versa) mid-interaction.
  useEffect(() => {
    setOpen(false)
  }, [isDesktop])

  return (
    <>
      {trigger({
        ref,
        toggle: () => setOpen((v) => !v),
        aria: { 'aria-haspopup': 'menu', 'aria-expanded': open },
      })}
      {open &&
        (isDesktop ? (
          <PopoverPanel anchorRef={ref} onClose={close}>
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

/**
 * Shared option-row look for both pickers. A native <button> exposed as a
 * `menuitemradio` (one selectable value among the set) — keeps Tab + Enter/Space
 * without a custom keyboard model, while announcing the correct role and selection.
 */
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
      role="menuitemradio"
      aria-checked={selected}
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
