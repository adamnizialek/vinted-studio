import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Check } from 'lucide-react'
import { db, putEntity } from '@/db/db'
import type { Product } from '@/db/types'
import { uid } from '@/lib/id'
import { toast } from '@/state/toast'
import { Button, Field, Modal, NumberInput, Select, TextInput } from '@/components/ui'
import { dateFromInput, dateInputValue } from '@/lib/format'

/**
 * Records a real Sale for the product, then calls onSold so the caller can flip
 * the product's status to 'sold'. Shared by ProductEditor (header button) and the
 * Magazyn grid status picker (selecting "Sprzedane").
 */
export function SoldModal({
  open,
  onClose,
  product,
  onSold,
}: {
  open: boolean
  onClose: () => void
  product: Product
  /** Dostaje datę sprzedaży, by produkt dostał ten sam `soldAt` co wpis w ewidencji. */
  onSold: (soldAt: number) => void
}) {
  const accounts = useLiveQuery(() => db.accounts.toArray(), [])
  const [price, setPrice] = useState<number | undefined>(undefined)
  const [accountId, setAccountId] = useState('')
  const [buyer, setBuyer] = useState('')
  // Data sprzedaży — sprzedaż wpisana rano za wczoraj musi trafić we właściwy dzień
  // ewidencji. null = „dziś” liczone w chwili zapisu (okno otwarte przed północą
  // i zapisane po niej nie może cofnąć sprzedaży o dzień).
  const [day, setDay] = useState<string | null>(null)

  // Seed the form only on the RISING EDGE of `open`, not on every `product` identity
  // change. In the grid, `product` comes from useLiveQuery and gets a fresh object on
  // any products-table write or sync pull — keying on it would wipe the user's typed
  // price/buyer mid-entry (e.g. when a sync fires on window.focus).
  const prevOpen = useRef(false)
  useEffect(() => {
    if (open && !prevOpen.current) {
      setPrice(product.listingPrice || undefined)
      setAccountId(product.accountId ?? '')
      setBuyer('')
      setDay(null)
    }
    prevOpen.current = open
  }, [open, product])

  const confirm = async () => {
    const salePrice = price
    if (!salePrice || salePrice <= 0) return toast.error('Podaj cenę sprzedaży.')
    if (day === '') return toast.error('Podaj datę sprzedaży.')
    const now = Date.now()
    // Dziś → dokładny czas; inny dzień → lokalne południe (jak w formularzu ewidencji).
    const soldAt = day == null || day === dateInputValue(now) ? now : dateFromInput(day, now)
    if (soldAt > now) return toast.error('Data sprzedaży nie może być z przyszłości.')
    await putEntity('sales', {
      id: uid(),
      productId: product.id,
      productName: product.name || 'Bez nazwy',
      brand: product.brand,
      accountId: accountId || undefined,
      salePrice,
      currency: product.currency,
      purchaseCost: product.purchasePrice,
      quantity: 1,
      buyer: buyer || undefined,
      status: 'completed',
      soldAt,
      createdAt: now,
    })
    toast.success('Dodano do ewidencji sprzedaży 💸')
    onSold(soldAt)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Oznacz jako sprzedane"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Anuluj
          </Button>
          <Button onClick={confirm}>
            <Check size={16} /> Zapisz sprzedaż
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label={`Cena sprzedaży (${product.currency})`}>
          <NumberInput value={price} onValueChange={setPrice} autoFocus />
        </Field>
        <Field label="Data sprzedaży">
          <TextInput
            type="date"
            value={day ?? dateInputValue(Date.now())}
            max={dateInputValue(Date.now())}
            onChange={(e) => setDay(e.target.value)}
          />
        </Field>
        <Field label="Konto">
          <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">— brak —</option>
            {accounts?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Kupujący (opcjonalnie)">
          <TextInput value={buyer} onChange={(e) => setBuyer(e.target.value)} placeholder="nick z Vinted" />
        </Field>
      </div>
    </Modal>
  )
}
