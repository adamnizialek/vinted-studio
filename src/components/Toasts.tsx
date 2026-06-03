import { CheckCircle2, Info, XCircle, X } from 'lucide-react'
import clsx from 'clsx'
import { useToasts } from '@/state/toast'

export function Toasts() {
  const { toasts, dismiss } = useToasts()
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4">
      {toasts.map((t) => {
        const Icon = t.type === 'success' ? CheckCircle2 : t.type === 'error' ? XCircle : Info
        const tone =
          t.type === 'success'
            ? 'bg-emerald-600'
            : t.type === 'error'
              ? 'bg-red-600'
              : 'bg-ink-800'
        return (
          <div
            key={t.id}
            className={clsx(
              'pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl px-4 py-3 text-sm text-white shadow-pop',
              tone,
            )}
          >
            <Icon size={18} className="mt-0.5 shrink-0" />
            <span className="flex-1 whitespace-pre-wrap leading-snug">{t.message}</span>
            <button onClick={() => dismiss(t.id)} className="shrink-0 opacity-70 hover:opacity-100">
              <X size={16} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
