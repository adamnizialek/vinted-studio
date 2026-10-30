import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useEffect,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { Loader2, X } from 'lucide-react'
import clsx from 'clsx'
import { parseDecimal } from '@/lib/format'

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('animate-spin-slow', className)} />
}

export function SectionTitle({
  title,
  subtitle,
  right,
}: {
  title: string
  subtitle?: string
  right?: ReactNode
}) {
  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <h2 className="text-lg font-bold text-ink-900">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-ink-500">{subtitle}</p>}
      </div>
      {right}
    </div>
  )
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label?: string
  hint?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      {label && <label className="label">{label}</label>}
      {children}
      {hint && <p className="mt-1 text-xs text-ink-400">{hint}</p>}
    </div>
  )
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx('input', props.className)} />
}

function numToText(value: number | undefined | null): string {
  return value == null ? '' : String(value)
}

// Tekst startowy bufora: 0 traktujemy jak „nie podano" (puste pole), bo formularze
// inicjalizują cenę/kwotę zerem (np. nowa sprzedaż salePrice:0). Bez tego pole
// świeciłoby „0", które trzeba by skasować przed wpisaniem. Samodzielnie wpisane „0"
// żyje dalej w buforze — to dotyczy tylko wartości z propsa.
function seedText(value: number | undefined | null): string {
  return value ? String(value) : ''
}

/**
 * Pole liczbowe odporne na przecinek dziesiętny. Polskie klawiatury mobilne
 * pokazują „,", a natywny <input type="number"> odrzuca przecinek (czyści
 * wartość) — przez co nie dało się wpisać ceny z groszami na telefonie.
 *
 * Dlatego renderujemy `type="text"` + `inputMode="decimal"` (na telefonie i tak
 * wyświetla klawiaturę numeryczną), a przecinek normalizujemy przez parseDecimal.
 *
 * Trzyma WŁASNY bufor tekstu, bo wartość w górę emitujemy jako liczbę: gdyby
 * `value` było sterowane wprost liczbą, wpisanie „12," zaokrąglałoby się od razu
 * do „12" i nie dało się dopisać groszy. Bufor synchronizujemy z propsem `value`
 * tylko gdy pole NIE jest edytowane (np. seed formularza, przycisk „użyj ceny").
 * „Edytowane” = użytkownik coś wpisał od fokusu — sam fokus (np. autoFocus w oknie
 * „Sprzedane”) nie blokuje seeda, inaczej cena wystawienia nie trafiała do pola.
 */
export function NumberInput({
  value,
  onValueChange,
  integer = false,
  onBlur,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'inputMode'> & {
  value: number | undefined | null
  onValueChange: (value: number | undefined) => void
  integer?: boolean
}) {
  const [text, setText] = useState(() => seedText(value))
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (editing) return // użytkownik pisze — bufor lokalny ma pierwszeństwo
    // Celowo opróżnione pole zostaw puste, nawet gdy rodzic skoercował je do 0
    // (zachowuje UX „puste vs 0", np. cena domyślnie pusta zamiast „0").
    if (text === '' && (value == null || value === 0)) return
    const canonical = numToText(value)
    if (canonical !== text) setText(canonical)
    // `text` celowo poza zależnościami — efekt ma reagować na zmiany z ZEWNĄTRZ
    // (props `value`), a nie na własne wpisywanie; aktualny `text` i tak jest
    // widoczny w domknięciu przy każdym uruchomieniu efektu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editing])

  return (
    <TextInput
      {...props}
      type="text"
      inputMode={integer ? 'numeric' : 'decimal'}
      value={text}
      onChange={(e) => {
        setEditing(true)
        setText(e.target.value)
        onValueChange(parseDecimal(e.target.value, integer))
      }}
      onBlur={(e) => {
        setEditing(false)
        onBlur?.(e)
      }}
    />
  )
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={clsx('input', props.className)} />
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={clsx('input', props.className)} />
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-ink-200 bg-surface/50 px-6 py-14 text-center">
      {icon && <div className="mb-3 text-ink-300">{icon}</div>}
      <h3 className="text-base font-semibold text-ink-800">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-ink-500">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

export function StatCard({
  label,
  value,
  sub,
  tone = 'default',
  icon,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: 'default' | 'good' | 'warn' | 'brand' | 'bad'
  icon?: ReactNode
}) {
  const toneCls = {
    default: 'text-ink-900',
    good: 'text-emerald-600',
    warn: 'text-amber-600',
    brand: 'text-brand-600',
    bad: 'text-red-500',
  }[tone]
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">{label}</p>
        {icon && <span className="text-ink-300">{icon}</span>}
      </div>
      <p className={clsx('mt-2 text-2xl font-extrabold tabular-nums', toneCls)}>{value}</p>
      {sub && <p className="mt-1 text-xs text-ink-400">{sub}</p>}
    </div>
  )
}

export function Modal({
  open,
  onClose,
  title,
  children,
  size = 'md',
  footer,
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
  footer?: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null
  const widths = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }
  // Portal to body so the overlay is never affected by an ancestor's overflow,
  // transform, or pointer-events (e.g. the Magazyn card's pointer-events-none layer).
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 backdrop-blur-sm sm:items-center sm:p-4">
      <div className="absolute inset-0" onClick={onClose} />
      <div
        className={clsx(
          'relative z-10 flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl bg-surface shadow-pop sm:rounded-2xl',
          widths[size],
        )}
      >
        {title && (
          <div className="flex items-center justify-between border-b border-ink-100 px-5 py-3.5">
            <h3 className="text-base font-bold text-ink-900">{title}</h3>
            <button onClick={onClose} className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700">
              <X size={18} />
            </button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <div className="border-t border-ink-100 px-5 py-3.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

export function Button({
  variant = 'primary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'soft' | 'danger'
}) {
  const cls = {
    primary: 'btn-primary',
    ghost: 'btn-ghost',
    soft: 'btn-soft',
    danger: 'btn-danger',
  }[variant]
  return <button {...props} className={clsx(cls, className)} />
}
