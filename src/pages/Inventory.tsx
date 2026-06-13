import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { Package, Plus, Search, Upload } from 'lucide-react'
import { db, putEntity } from '@/db/db'
import type { Product, ProductStatus } from '@/db/types'
import { uid } from '@/lib/id'
import { useSettings } from '@/state/settings'
import { STATUS_OPTIONS } from '@/lib/constants'
import { money } from '@/lib/format'
import { Button, EmptyState, Select, TextInput, SectionTitle } from '@/components/ui'
import { Thumb } from '@/components/ImageView'
import { ImportStockModal } from '@/components/ImportStockModal'
import { StatusPicker } from '@/components/StatusPicker'
import { AccountPicker } from '@/components/AccountPicker'

export function Inventory() {
  const nav = useNavigate()
  const settings = useSettings((s) => s.settings)
  // Sort by createdAt (stable) — NOT updatedAt — so an in-place status/account change
  // doesn't yank the just-edited card to the top mid-burst.
  const products = useLiveQuery(() => db.products.orderBy('createdAt').reverse().toArray(), [])
  const accounts = useLiveQuery(() => db.accounts.toArray(), [])

  const [q, setQ] = useState('')
  const [status, setStatus] = useState<ProductStatus | 'all'>('all')
  const [accountId, setAccountId] = useState<string>('all')
  const [importOpen, setImportOpen] = useState(false)

  const filtered = useMemo(() => {
    let list = products ?? []
    if (status !== 'all') list = list.filter((p) => p.status === status)
    if (accountId !== 'all') list = list.filter((p) => p.accountId === accountId)
    if (q.trim()) {
      const needle = q.toLowerCase()
      list = list.filter((p) =>
        [p.name, p.brand, p.category, p.sizeLabel, ...p.tags]
          .filter(Boolean)
          .some((s) => s!.toLowerCase().includes(needle)),
      )
    }
    return list
  }, [products, status, accountId, q])

  const createProduct = async () => {
    const now = Date.now()
    const p: Product = {
      id: uid(),
      name: '',
      condition: 'dobry',
      currency: settings?.currency ?? 'PLN',
      quantity: 1,
      status: 'draft',
      accountId: settings?.defaultAccountId,
      photoIds: [],
      generatedPhotoIds: [],
      descriptions: [],
      tags: [],
      createdAt: now,
      updatedAt: now,
    }
    await putEntity('products', p)
    nav(`/magazyn/${p.id}`)
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const p of products ?? []) c[p.status] = (c[p.status] ?? 0) + 1
    return c
  }, [products])

  return (
    <div>
      <SectionTitle
        title="Magazyn"
        subtitle={`${products?.length ?? 0} przedmiotów · ${counts.in_stock ?? 0} w magazynie · ${counts.listed ?? 0} wystawionych`}
        right={
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setImportOpen(true)}>
              <Upload size={16} /> Importuj stan
            </Button>
            <Button onClick={createProduct}>
              <Plus size={16} /> Dodaj produkt
            </Button>
          </div>
        }
      />

      {/* Filtry */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <TextInput
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Szukaj po nazwie, marce, rozmiarze, tagach…"
            className="pl-9"
          />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value as ProductStatus | 'all')} className="sm:w-44">
          <option value="all">Wszystkie statusy</option>
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        {accounts && accounts.length > 0 && (
          <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="sm:w-44">
            <option value="all">Wszystkie konta</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        )}
      </div>

      {products && products.length === 0 ? (
        <EmptyState
          icon={<Package size={40} />}
          title="Magazyn jest pusty"
          description="Dodaj pierwszy produkt — uzupełnij dane, wgraj zdjęcia, wygeneruj zdjęcia na modelce i opisy."
          action={
            <Button onClick={createProduct}>
              <Plus size={16} /> Dodaj produkt
            </Button>
          }
        />
      ) : filtered.length === 0 ? (
        <p className="rounded-2xl bg-surface px-4 py-10 text-center text-sm text-ink-400 ring-1 ring-ink-100">
          Brak produktów pasujących do filtrów.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {filtered.map((p) => {
            const cover = p.photoIds[0] ?? p.generatedPhotoIds[0]
            return (
              <div key={p.id} className="card group relative overflow-hidden transition hover:shadow-pop">
                {/* Stretched navigate hit-area — a real <button> (keyboard + focus-ring
                    intact). Sits BEHIND content; content is pointer-events-none so clicks
                    fall through, except the pickers which re-enable pointer-events. */}
                <button
                  type="button"
                  aria-label={`Otwórz ${p.name || 'produkt'}`}
                  onClick={() => nav(`/magazyn/${p.id}`)}
                  className="absolute inset-0 z-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400"
                />
                <div className="pointer-events-none relative z-10">
                  <div className="relative aspect-square w-full bg-ink-100">
                    <Thumb imageId={cover} className="h-full w-full object-cover" alt={p.name} />
                    <StatusPicker product={p} className="pointer-events-auto absolute left-2 top-2" />
                    {p.generatedPhotoIds.length > 0 && (
                      <span className="badge absolute right-2 top-2 bg-brand-500 text-white shadow-sm">
                        AI {p.generatedPhotoIds.length}
                      </span>
                    )}
                  </div>
                  <div className="p-3">
                    <p className="truncate font-semibold text-ink-900">{p.name || 'Bez nazwy'}</p>
                    <div className="mt-0.5 flex items-center justify-between">
                      <p className="truncate text-xs text-ink-400">{p.brand || '—'}</p>
                      <p className="shrink-0 text-sm font-bold text-brand-600">
                        {p.listingPrice ? money(p.listingPrice, p.currency) : '—'}
                      </p>
                    </div>
                    <div className="mt-2">
                      <AccountPicker product={p} accounts={accounts ?? []} className="pointer-events-auto" />
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
      <ImportStockModal open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  )
}
