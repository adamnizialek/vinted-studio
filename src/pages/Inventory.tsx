import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { Camera, FileSpreadsheet, Package, Plus, Search, Upload } from 'lucide-react'
import { db, putEntity, groupProducts, attachProductsToDesign } from '@/db/db'
import type { Design, Product, ProductStatus } from '@/db/types'
import { uid } from '@/lib/id'
import { useSettings } from '@/state/settings'
import { STATUS_OPTIONS } from '@/lib/constants'
import { passesInventoryFilter } from '@/lib/inventoryFilter'
import { coverImageIdOf } from '@/lib/listing'
import { money } from '@/lib/format'
import { Button, EmptyState, Select, TextInput, SectionTitle, Modal } from '@/components/ui'
import { toast } from '@/state/toast'
import { Thumb } from '@/components/ImageView'
import { ImportStockModal } from '@/components/ImportStockModal'
import { ImportStockScreenshotModal } from '@/components/ImportStockScreenshotModal'
import { ResponsivePicker, OptionRow } from '@/components/Popover'
import { StatusPicker } from '@/components/StatusPicker'
import { AccountPicker } from '@/components/AccountPicker'

export function Inventory() {
  const nav = useNavigate()
  const settings = useSettings((s) => s.settings)
  // Sort by createdAt (stable) — NOT updatedAt — so an in-place status/account change
  // doesn't yank the just-edited card to the top mid-burst.
  const products = useLiveQuery(() => db.products.orderBy('createdAt').reverse().toArray(), [])
  const accounts = useLiveQuery(() => db.accounts.toArray(), [])
  const designs = useLiveQuery(() => db.designs.toArray(), [])
  const designsById = useMemo(
    () => new Map((designs ?? []).map((d) => [d.id, d])),
    [designs],
  )

  type DisplayItem =
    | { kind: 'single'; product: Product }
    | { kind: 'design'; design: Design; members: Product[]; cover?: string }

  const items = useMemo<DisplayItem[]>(() => {
    const list = products ?? []
    const groups = new Map<string, Product[]>()
    const singles: Product[] = []
    for (const p of list) {
      if (p.designId && designsById.has(p.designId)) {
        const arr = groups.get(p.designId)
        if (arr) arr.push(p)
        else groups.set(p.designId, [p])
      } else {
        singles.push(p)
      }
    }
    const out: DisplayItem[] = singles.map((product) => ({ kind: 'single', product }))
    for (const [designId, members] of groups) {
      const design = designsById.get(designId)!
      out.push({
        kind: 'design',
        design,
        members,
        cover: design.photoIds[0] ?? design.generatedPhotoIds[0],
      })
    }
    // stabilne sortowanie po createdAt malejaco (model: createdAt modelu)
    return out.sort((a, b) => {
      const ca = a.kind === 'single' ? a.product.createdAt : a.design.createdAt
      const cb = b.kind === 'single' ? b.product.createdAt : b.design.createdAt
      return cb - ca
    })
  }, [products, designsById])

  const [q, setQ] = useState('')
  const [status, setStatus] = useState<ProductStatus | 'all'>('all')
  const [accountId, setAccountId] = useState<string>('all')
  const [importOpen, setImportOpen] = useState(false)
  const [screenshotOpen, setScreenshotOpen] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // Opcjonalny model docelowy: gdy zaznaczony, akcja DODAJE produkty do niego
  // zamiast tworzyc nowy. Tylko jeden naraz (radio-like).
  const [targetDesignId, setTargetDesignId] = useState<string | null>(null)
  const [groupOpen, setGroupOpen] = useState(false)
  const [attaching, setAttaching] = useState(false)

  const toggleSelect = (id: string) =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const toggleTargetDesign = (id: string) =>
    setTargetDesignId((cur) => (cur === id ? null : id))
  const exitSelect = () => {
    setSelecting(false)
    setSelected(new Set())
    setTargetDesignId(null)
  }

  const attachToModel = async () => {
    if (!targetDesignId || selected.size < 1 || attaching) return
    setAttaching(true)
    try {
      await attachProductsToDesign(targetDesignId, [...selected])
      toast.success('Dodano do modelu 🧩')
      exitSelect()
      nav(`/magazyn/model/${targetDesignId}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Nie udało się dodać do modelu.')
    } finally {
      setAttaching(false)
    }
  }

  const filtered = useMemo<DisplayItem[]>(() => {
    const needle = q.trim().toLowerCase()
    const f = { status, accountId }
    const matchesText = (p: Product) =>
      [p.name, p.brand, p.category, p.sizeLabel, ...p.tags]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(needle))

    const out: DisplayItem[] = []
    for (const it of items) {
      if (it.kind === 'single') {
        const p = it.product
        if (!passesInventoryFilter(p, f)) continue
        if (needle && !matchesText(p)) continue
        out.push(it)
        continue
      }
      // Narrow the model to the sizes that pass the filter — so a sold size drops
      // out of the default view and the card's count/price/summary reflect only
      // what's actually in the magazine. Hide the whole model if nothing remains.
      const { design, members } = it
      const shown = members.filter((m) => passesInventoryFilter(m, f))
      if (shown.length === 0) continue
      if (needle) {
        const designText = [design.name, design.brand, design.category, ...design.tags]
          .filter(Boolean)
          .some((s) => s!.toLowerCase().includes(needle))
        const sizeText = shown.some((m) => (m.sizeLabel ?? '').toLowerCase().includes(needle))
        if (!designText && !sizeText) continue
      }
      out.push({ ...it, members: shown })
    }
    return out
  }, [items, status, accountId, q])

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
          <div className="flex flex-wrap gap-2">
            {selecting ? (
              <>
                <Button variant="ghost" onClick={exitSelect}>Anuluj</Button>
                {targetDesignId ? (
                  <Button disabled={selected.size < 1 || attaching} onClick={attachToModel}>
                    {attaching ? 'Dodaję…' : `Dodaj do modelu (${selected.size})`}
                  </Button>
                ) : (
                  <Button disabled={selected.size < 2} onClick={() => setGroupOpen(true)}>
                    Połącz w model ({selected.size})
                  </Button>
                )}
              </>
            ) : (
              <Button variant="ghost" onClick={() => setSelecting(true)}>Połącz</Button>
            )}
            <ResponsivePicker
              title="Importuj stan"
              trigger={({ ref, toggle, aria }) => (
                <button ref={ref} type="button" onClick={toggle} className="btn-ghost" {...aria}>
                  <Upload size={16} /> Importuj stan
                </button>
              )}
            >
              {(close) => (
                <div role="menu" aria-label="Importuj stan">
                  <OptionRow
                    onClick={() => {
                      close()
                      setImportOpen(true)
                    }}
                  >
                    <FileSpreadsheet size={16} className="text-ink-500" /> Z pliku (CSV / XLSX)
                  </OptionRow>
                  <OptionRow
                    onClick={() => {
                      close()
                      setScreenshotOpen(true)
                    }}
                  >
                    <Camera size={16} className="text-ink-500" /> Ze zrzutu ekranu (AI)
                  </OptionRow>
                </div>
              )}
            </ResponsivePicker>
            <Button onClick={createProduct}>
              <Plus size={16} /> Dodaj produkt
            </Button>
          </div>
        }
      />

      {selecting && (
        <p className="mb-3 rounded-xl bg-brand-50 px-4 py-2.5 text-sm text-brand-700 ring-1 ring-brand-100">
          {targetDesignId
            ? 'Zaznaczone produkty trafią do wybranego modelu. Odznacz model, aby zamiast tego utworzyć nowy.'
            : 'Zaznacz produkty, a opcjonalnie jeden istniejący model — produkty dołączą do niego zamiast tworzyć nowy.'}
        </p>
      )}

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
          <option value="all">Wszystkie aktywne</option>
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
          {filtered.map((it) =>
            it.kind === 'single' ? (
              (() => {
                const p = it.product
                const cover = coverImageIdOf(p)
                return (
                  <div key={p.id} className="card group relative overflow-hidden transition hover:shadow-pop">
                    {/* Stretched navigate hit-area — a real <button> (keyboard + focus-ring
                        intact). Sits BEHIND content; content is pointer-events-none so clicks
                        fall through, except the pickers which re-enable pointer-events. */}
                    <button
                      type="button"
                      aria-label={`Otwórz ${p.name || 'produkt'}`}
                      onClick={() => (selecting ? toggleSelect(p.id) : nav(`/magazyn/${p.id}`))}
                      className="absolute inset-0 z-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400"
                    />
                    {selecting && (
                      <label className="pointer-events-auto absolute right-2 top-2 z-20 flex h-7 w-7 items-center justify-center rounded-lg bg-surface/90 ring-1 ring-ink-200">
                        <input
                          type="checkbox"
                          checked={selected.has(p.id)}
                          onChange={() => toggleSelect(p.id)}
                          aria-label="Zaznacz do połączenia"
                        />
                      </label>
                    )}
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
                          <p className="truncate text-xs text-ink-400">
                            {[p.sizeLabel, p.brand].filter(Boolean).join(' · ') || '—'}
                          </p>
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
              })()
            ) : (
              <DesignCard
                key={it.design.id}
                design={it.design}
                members={it.members}
                cover={it.cover}
                selecting={selecting}
                selected={targetDesignId === it.design.id}
                onToggle={() => toggleTargetDesign(it.design.id)}
                onOpen={() => nav(`/magazyn/model/${it.design.id}`)}
              />
            ),
          )}
        </div>
      )}
      <ImportStockModal open={importOpen} onClose={() => setImportOpen(false)} />
      <ImportStockScreenshotModal open={screenshotOpen} onClose={() => setScreenshotOpen(false)} />
      {groupOpen && (
        <GroupModal
          products={(products ?? []).filter((p) => selected.has(p.id))}
          onClose={() => setGroupOpen(false)}
          onConfirm={async (primaryId) => {
            try {
              const design = await groupProducts([...selected], primaryId)
              toast.success('Połączono w model 🧩')
              setGroupOpen(false)
              exitSelect()
              nav(`/magazyn/model/${design.id}`)
            } catch (e) {
              toast.error(e instanceof Error ? e.message : 'Nie udało się połączyć.')
            }
          }}
        />
      )}
    </div>
  )
}

const statusLabel = (s: ProductStatus) =>
  STATUS_OPTIONS.find((o) => o.value === s)?.label ?? s

/** Polska odmiana: 1 rozmiar, 2-4 rozmiary, 5+ rozmiarow (z wyjatkami 12-14). */
function rozmiarLabel(n: number): string {
  if (n === 1) return 'rozmiar'
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return 'rozmiary'
  return 'rozmiarów'
}

function GroupModal({ products, onClose, onConfirm }: {
  products: Product[]
  onClose: () => void
  onConfirm: (primaryId: string) => void | Promise<void>
}) {
  const [primaryId, setPrimaryId] = useState(products[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      open
      onClose={onClose}
      title="Połącz w jeden model"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Anuluj</Button>
          <Button
            disabled={!primaryId || busy}
            onClick={async () => {
              if (busy) return
              setBusy(true)
              try {
                await onConfirm(primaryId)
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? 'Łączę…' : 'Połącz'}
          </Button>
        </div>
      }
    >
      <div className="space-y-2">
        <p className="text-sm text-ink-500">
          Wybierz produkt główny — jego nazwa, zdjęcia i opisy staną się wspólne dla modelu.
        </p>
        {products.map((p) => (
          <label
            key={p.id}
            className="flex cursor-pointer items-center gap-3 rounded-xl p-2 ring-1 ring-ink-100 hover:bg-ink-50"
          >
            <input
              type="radio"
              name="primary"
              checked={primaryId === p.id}
              onChange={() => setPrimaryId(p.id)}
            />
            <Thumb imageId={coverImageIdOf(p)} className="h-12 w-12 rounded-lg object-cover" />
            <div className="min-w-0">
              <p className="truncate font-medium text-ink-900">{p.name || 'Bez nazwy'}</p>
              <p className="truncate text-xs text-ink-400">
                {[p.brand, p.sizeLabel].filter(Boolean).join(' · ') || '—'}
              </p>
            </div>
          </label>
        ))}
      </div>
    </Modal>
  )
}

function DesignCard({ design, members, cover, onOpen, selecting, selected, onToggle }: {
  design: Design; members: Product[]; cover?: string; onOpen: () => void
  selecting?: boolean; selected?: boolean; onToggle?: () => void
}) {
  const prices = members.map((m) => m.listingPrice).filter((n): n is number => n != null)
  const currency = members[0]?.currency ?? 'PLN'
  const priceText =
    prices.length === 0
      ? '—'
      : Math.min(...prices) === Math.max(...prices)
        ? money(Math.min(...prices), currency)
        : `${money(Math.min(...prices), currency)} – ${money(Math.max(...prices), currency)}`
  return (
    <div className="card group relative overflow-hidden transition hover:shadow-pop">
      <button
        type="button"
        aria-label={selecting ? `Wybierz model ${design.name || 'model'} jako docelowy` : `Otworz model ${design.name || 'model'}`}
        onClick={() => (selecting ? onToggle?.() : onOpen())}
        className="absolute inset-0 z-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400"
      />
      {selecting && (
        <label className="pointer-events-auto absolute right-2 top-2 z-20 flex h-7 w-7 items-center justify-center rounded-lg bg-surface/90 ring-1 ring-ink-200">
          <input
            type="checkbox"
            checked={!!selected}
            onChange={() => onToggle?.()}
            aria-label="Wybierz jako model docelowy"
          />
        </label>
      )}
      <div className="pointer-events-none relative z-10">
        <div className="relative aspect-square w-full bg-ink-100">
          <Thumb imageId={cover} className="h-full w-full object-cover" alt={design.name} />
          <span className="badge absolute left-2 top-2 bg-ink-900/80 text-white">
            {members.length} {rozmiarLabel(members.length)}
          </span>
          {!selecting && design.generatedPhotoIds.length > 0 && (
            <span className="badge absolute right-2 top-2 bg-brand-500 text-white shadow-sm">
              AI {design.generatedPhotoIds.length}
            </span>
          )}
        </div>
        <div className="p-3">
          <p className="truncate font-semibold text-ink-900">{design.name || 'Bez nazwy'}</p>
          <div className="mt-0.5 flex items-center justify-between">
            <p className="truncate text-xs text-ink-400">{design.brand}</p>
            <p className="shrink-0 text-sm font-bold text-brand-600">{priceText}</p>
          </div>
          <p className="mt-2 truncate text-xs text-ink-400">
            {members.map((m) => `${m.sizeLabel || '?'} ${statusLabel(m.status)}`).join(' · ')}
          </p>
        </div>
      </div>
    </div>
  )
}
