import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Check } from 'lucide-react'
import { db, putEntity } from '@/db/db'
import type { Product } from '@/db/types'
import { uid } from '@/lib/id'
import { toast } from '@/state/toast'
import { Button, Field, Modal, Select, TextInput } from '@/components/ui'

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
  onSold: () => void
}) {
  const accounts = useLiveQuery(() => db.accounts.toArray(), [])
  const [price, setPrice] = useState('')
  const [accountId, setAccountId] = useState('')
  const [buyer, setBuyer] = useState('')

  useEffect(() => {
    if (open) {
      setPrice(product.listingPrice ? String(product.listingPrice) : '')
      setAccountId(product.accountId ?? '')
      setBuyer('')
    }
  }, [open, product])

  const confirm = async () => {
    const salePrice = Number(price)
    if (!salePrice || salePrice <= 0) return toast.error('Podaj cenę sprzedaży.')
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
      soldAt: Date.now(),
      createdAt: Date.now(),
    })
    toast.success('Dodano do ewidencji sprzedaży 💸')
    onSold()
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
          <TextInput
            type="number"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            autoFocus
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
