import { Check, ChevronDown, UserPlus, X } from 'lucide-react'
import clsx from 'clsx'
import type { Account, Product } from '@/db/types'
import { assignAccount } from '@/lib/productActions'
import { toast } from '@/state/toast'
import { ResponsivePicker, OptionRow } from '@/components/Popover'

/**
 * Account chip that doubles as the trigger for an in-place account picker.
 * Shows the current account (color dot + name) or a subtle "Przypisz konto" affordance
 * when none is set. Includes a "Bez konta" row to clear the assignment.
 */
export function AccountPicker({
  product,
  accounts,
  className,
}: {
  product: Product
  accounts: Account[]
  className?: string
}) {
  const current = accounts.find((a) => a.id === product.accountId)

  const pick = async (accountId: string | undefined, close: () => void) => {
    close()
    if (accountId === product.accountId) return
    try {
      await assignAccount(product.id, accountId)
    } catch {
      toast.error('Nie udało się przypisać konta.')
    }
  }

  // No accounts exist at all → nothing to assign; render nothing.
  if (accounts.length === 0) return null

  return (
    <ResponsivePicker
      title="Przypisz konto"
      trigger={({ ref, toggle, aria }) => (
        <button
          ref={ref}
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            toggle()
          }}
          className={clsx(
            'inline-flex items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[11px] transition hover:bg-ink-100',
            current ? 'text-ink-500' : 'text-ink-400 ring-1 ring-dashed ring-ink-200',
            className,
          )}
          {...aria}
        >
          {current ? (
            <>
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: current.color }} />
              <span className="max-w-[8rem] truncate">{current.name}</span>
            </>
          ) : (
            <>
              <UserPlus size={12} /> Przypisz konto
            </>
          )}
          <ChevronDown size={11} className="opacity-70" />
        </button>
      )}
    >
      {(close) => (
        <div role="listbox" aria-label="Konto">
          {accounts.map((a) => {
            const selected = a.id === product.accountId
            return (
              <OptionRow key={a.id} selected={selected} onClick={() => pick(a.id, close)}>
                <span className="h-3 w-3 rounded-full" style={{ background: a.color }} />
                <span className="truncate">{a.name}</span>
                {selected && <Check size={15} className="ml-auto text-ink-500" />}
              </OptionRow>
            )
          })}
          <OptionRow selected={!product.accountId} onClick={() => pick(undefined, close)}>
            <X size={14} className="text-ink-400" />
            <span className="text-ink-500">Bez konta</span>
          </OptionRow>
        </div>
      )}
    </ResponsivePicker>
  )
}
