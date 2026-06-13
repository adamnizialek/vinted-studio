import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import clsx from 'clsx'
import type { Product, ProductStatus } from '@/db/types'
import { STATUS_LABELS, STATUS_OPTIONS, STATUS_TONE } from '@/lib/constants'
import { applyStatusChange, requiresSaleModal } from '@/lib/productActions'
import { patchEntity } from '@/db/db'
import { toast } from '@/state/toast'
import { ResponsivePicker, OptionRow } from '@/components/Popover'
import { SoldModal } from '@/components/SoldModal'

/**
 * Status pill that doubles as the trigger for an in-place status picker.
 * 5 statuses flip instantly via patchEntity; 'sold' opens SoldModal (records a Sale).
 */
export function StatusPicker({ product, className }: { product: Product; className?: string }) {
  const [soldOpen, setSoldOpen] = useState(false)

  const pick = async (status: ProductStatus, close: () => void) => {
    close()
    if (status === product.status && status !== 'sold') return
    if (requiresSaleModal(status)) {
      setSoldOpen(true)
      return
    }
    try {
      await applyStatusChange(product.id, status)
    } catch {
      toast.error('Nie udało się zmienić statusu.')
    }
  }

  return (
    <>
      <ResponsivePicker
        title="Zmień status"
        trigger={({ ref, toggle, aria }) => (
          <button
            ref={ref}
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              toggle()
            }}
            className={clsx('badge shadow-sm', STATUS_TONE[product.status], className)}
            {...aria}
          >
            {STATUS_LABELS[product.status]}
            <ChevronDown size={12} className="-mr-0.5 opacity-70" />
          </button>
        )}
      >
        {(close) => (
          <div role="listbox" aria-label="Status">
            {STATUS_OPTIONS.map((o) => {
              const selected = o.value === product.status
              return (
                <OptionRow key={o.value} selected={selected} onClick={() => pick(o.value, close)}>
                  <span className={clsx('badge', STATUS_TONE[o.value])}>{o.label}</span>
                  {selected && <Check size={15} className="ml-auto text-ink-500" />}
                </OptionRow>
              )
            })}
          </div>
        )}
      </ResponsivePicker>

      <SoldModal
        open={soldOpen}
        onClose={() => setSoldOpen(false)}
        product={product}
        onSold={() => {
          void patchEntity('products', product.id, { status: 'sold', soldAt: Date.now() })
          setSoldOpen(false)
        }}
      />
    </>
  )
}
