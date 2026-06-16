import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  ArrowLeft,
  Camera,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  Star,
  Tag,
  Trash2,
  Unlink,
  Wand2,
  X,
} from 'lucide-react'
import clsx from 'clsx'
import {
  addSizeToDesign,
  db,
  deleteDesignCascade,
  deleteEntity,
  deleteProductCascade,
  dissolveDesign,
  patchEntity,
  putEntity,
} from '@/db/db'
import type {
  AppSettings,
  Condition,
  DescriptionCandidate,
  Design,
  Measurements,
  Product,
  ProductStatus,
  SavedDescription,
} from '@/db/types'
import { removeCandidate, upsertCandidate } from '@/lib/descriptions'
import { resolveProduct, SHARED_FIELDS } from '@/lib/designs'
import { uid } from '@/lib/id'
import { useSettings } from '@/state/settings'
import { toast } from '@/state/toast'
import {
  CATEGORY_SUGGESTIONS,
  CONDITION_OPTIONS,
  CURRENCY_OPTIONS,
  SIZE_SUGGESTIONS,
  STATUS_OPTIONS,
} from '@/lib/constants'
import { money, relative } from '@/lib/format'
import { coverImageIdOf, listingHref } from '@/lib/listing'
import { requiresSaleModal, statusChangePatch } from '@/lib/productActions'
import { suggestPrice } from '@/lib/pricing'
import {
  DESCRIPTION_STYLES,
  DESCRIPTION_SYSTEM,
  buildDescriptionPrompt,
  buildSeoTitle,
  styleById,
} from '@/lib/prompts'
import { generateText } from '@/lib/gemini'
import { addImageFromFile } from '@/lib/images'
import { Button, Field, Select, TextArea, TextInput } from '@/components/ui'
import { Thumb } from '@/components/ImageView'
import { FileDrop } from '@/components/FileDrop'
import { SoldModal } from '@/components/SoldModal'

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('Skopiowano do schowka.')
  } catch {
    toast.error('Nie udało się skopiować.')
  }
}

type UpdateFn = (patch: Partial<Product> | ((prev: Product) => Partial<Product>)) => void

/** Zmiana statusu, która przy wejściu w 'listed' stempluje listedAt (cykl życia oferty). */
function changeStatus(prev: Product, next: ProductStatus, update: UpdateFn) {
  update(statusChangePatch(prev.status, next, Date.now()))
}

export function ProductEditor() {
  const { id, designId } = useParams()
  if (designId) return <DesignEditor designId={designId} />
  return <StandaloneEditor id={id} />
}

function StandaloneEditor({ id }: { id: string | undefined }) {
  const nav = useNavigate()
  const accounts = useLiveQuery(() => db.accounts.toArray(), [])
  const [draft, setDraft] = useState<Product | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'detale' | 'zdjecia' | 'opisy'>('detale')
  const [soldOpen, setSoldOpen] = useState(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    db.products.get(id!).then((p) => {
      if (alive) {
        setDraft(p ?? null)
        setLoading(false)
      }
    })
    return () => {
      alive = false
    }
  }, [id])

  // Patch może być obiektem lub funkcją (prev => patch). Forma funkcyjna jest
  // bezpieczna przy operacjach po await (dodawanie/usuwanie zdjęć), bo liczy
  // nową wartość z NAJświeższego stanu, nie ze starego snapshotu z domknięcia.
  const update = (patch: Partial<Product> | ((prev: Product) => Partial<Product>)) => {
    setDraft((prev) => {
      if (!prev) return prev
      const p = typeof patch === 'function' ? patch(prev) : patch
      const next = { ...prev, ...p, updatedAt: Date.now() }
      void putEntity('products', next)
      return next
    })
  }

  if (loading) return <div className="py-20 text-center text-ink-400">Wczytywanie…</div>
  if (!draft)
    return (
      <div className="py-20 text-center">
        <p className="text-ink-500">Nie znaleziono produktu.</p>
        <Link to="/magazyn" className="btn-ghost mt-4 inline-flex">
          <ArrowLeft size={16} /> Wróć do magazynu
        </Link>
      </div>
    )

  const remove = async () => {
    if (!window.confirm('Usunąć ten produkt wraz ze zdjęciami?')) return
    await deleteProductCascade(draft.id)
    toast.success('Usunięto produkt.')
    nav('/magazyn')
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <button onClick={() => nav('/magazyn')} className="btn-ghost btn-sm">
          <ArrowLeft size={15} /> Magazyn
        </button>
        <div className="flex items-center gap-2">
          <Select
            value={draft.status}
            onChange={(e) => changeStatus(draft, e.target.value as ProductStatus, update)}
            className="w-40"
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          {!requiresSaleModal(draft.status) && (
            <Button variant="soft" onClick={() => setSoldOpen(true)}>
              <Check size={16} /> Sprzedane
            </Button>
          )}
          <Button variant="danger" onClick={remove}>
            <Trash2 size={16} />
          </Button>
        </div>
      </div>

      <input
        value={draft.name}
        onChange={(e) => update({ name: e.target.value })}
        placeholder="Nazwa produktu…"
        className="w-full bg-transparent text-2xl font-extrabold text-ink-900 placeholder:text-ink-300 focus:outline-none"
      />

      {/* Taby */}
      <div className="mt-4 flex gap-1 border-b border-ink-100">
        {(
          [
            ['detale', 'Szczegóły'],
            ['zdjecia', `Zdjęcia (${draft.photoIds.length + draft.generatedPhotoIds.length})`],
            ['opisy', `Opisy (${draft.descriptions.length})`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={clsx(
              'border-b-2 px-4 py-2.5 text-sm font-semibold transition',
              tab === key
                ? 'border-brand-500 text-brand-600'
                : 'border-transparent text-ink-500 hover:text-ink-800',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="py-5">
        {tab === 'detale' && <DetailsTab draft={draft} update={update} accounts={accounts ?? []} />}
        {tab === 'zdjecia' && <PhotosTab draft={draft} update={update} />}
        {tab === 'opisy' && <DescriptionsTab draft={draft} update={update} />}
      </div>

      <SoldModal
        open={soldOpen}
        onClose={() => setSoldOpen(false)}
        product={draft}
        onSold={() => {
          update({ status: 'sold', soldAt: Date.now() })
          setSoldOpen(false)
        }}
      />
    </div>
  )
}

// ── Tryb modelu (wspolny blok + przelacznik rozmiarow) ───────────────────────
function DesignEditor({ designId }: { designId: string }) {
  const nav = useNavigate()
  const accounts = useLiveQuery(() => db.accounts.toArray(), [])
  const design = useLiveQuery(() => db.designs.get(designId), [designId])
  const members = useLiveQuery(
    () => db.products.where('designId').equals(designId).sortBy('createdAt'),
    [designId],
  )
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Product | null>(null)
  const [tab, setTab] = useState<'detale' | 'zdjecia' | 'opisy'>('detale')
  const [soldOpen, setSoldOpen] = useState(false)

  const designsById = useMemo(
    () => (design ? new Map([[design.id, design]]) : new Map<string, Design>()),
    [design],
  )

  // Wybierz aktywny rozmiar, gdy lista czlonkow sie zmieni a biezacy zniknal.
  useEffect(() => {
    if (members && members.length && !members.some((m) => m.id === activeId)) {
      setActiveId(members[0].id)
    }
  }, [members, activeId])

  // Zasiej optymistyczny draft przy zmianie rozmiaru i pierwszym zaladowaniu modelu —
  // NIE przy kazdej edycji pola modelu (design.id jest stabilne), by nie zadeptywac
  // optymistycznego pisania.
  useEffect(() => {
    if (!activeId || !design || !members) return
    const m = members.find((x) => x.id === activeId)
    if (m) setDraft(resolveProduct(m, designsById))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, design?.id, members?.length])

  if (design === undefined && members === undefined) {
    return <div className="py-20 text-center text-ink-400">Wczytywanie…</div>
  }
  if (!design) {
    return (
      <div className="py-20 text-center">
        <p className="text-ink-500">Nie znaleziono modelu.</p>
        <Link to="/magazyn" className="btn-ghost mt-4 inline-flex">
          <ArrowLeft size={16} /> Wróć do magazynu
        </Link>
      </div>
    )
  }

  // Routing update: pola wspolne -> design, pola per-size -> aktywny produkt.
  const update: UpdateFn = (patch) => {
    setDraft((prev) => {
      if (!prev) return prev
      const p = typeof patch === 'function' ? patch(prev) : patch
      const shared: Record<string, unknown> = {}
      const perSize: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(p)) {
        if ((SHARED_FIELDS as readonly string[]).includes(k)) shared[k] = v
        else perSize[k] = v
      }
      if (Object.keys(shared).length)
        void patchEntity('designs', designId, shared as Partial<Design>)
      if (activeId && Object.keys(perSize).length)
        void patchEntity('products', activeId, perSize as Partial<Product>)
      return { ...prev, ...p }
    })
  }

  const addSize = async () => {
    const p = await addSizeToDesign(designId)
    setActiveId(p.id)
    setTab('detale')
  }
  const removeSize = async () => {
    if (!activeId) return
    if (!window.confirm('Usunąć ten rozmiar?')) return
    await deleteProductCascade(activeId)
    const remaining = await db.products.where('designId').equals(designId).count()
    if (remaining === 0) nav('/magazyn')
    else setActiveId(null) // efekt wybierze pierwszy pozostaly rozmiar
  }
  const dissolve = async () => {
    if (!window.confirm('Rozłączyć model? Każdy rozmiar dostanie własną kopię zdjęć i opisów.'))
      return
    await dissolveDesign(designId)
    nav('/magazyn')
  }
  const removeModel = async () => {
    if (!window.confirm('Usunąć cały model wraz ze wszystkimi rozmiarami i zdjęciami?')) return
    await deleteDesignCascade(designId)
    nav('/magazyn')
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <button onClick={() => nav('/magazyn')} className="btn-ghost btn-sm">
          <ArrowLeft size={15} /> Magazyn
        </button>
        <div className="flex flex-wrap items-center gap-2">
          {draft && (
            <Select
              value={draft.status}
              onChange={(e) => changeStatus(draft, e.target.value as ProductStatus, update)}
              className="w-40"
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
          {draft && !requiresSaleModal(draft.status) && (
            <Button variant="soft" onClick={() => setSoldOpen(true)}>
              <Check size={16} /> Sprzedane
            </Button>
          )}
          <Button variant="ghost" onClick={dissolve}>
            <Unlink size={16} /> Rozłącz model
          </Button>
          <Button variant="danger" onClick={removeModel}>
            <Trash2 size={16} /> Usuń model
          </Button>
        </div>
      </div>

      {/* Pasek rozmiarów */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {members?.map((m) => (
          <button
            key={m.id}
            onClick={() => setActiveId(m.id)}
            className={clsx(
              'rounded-full px-3 py-1.5 text-sm font-medium transition',
              m.id === activeId
                ? 'bg-brand-500 text-white'
                : 'bg-ink-100 text-ink-600 hover:bg-ink-200',
            )}
          >
            {m.sizeLabel || 'rozmiar'}
          </button>
        ))}
        <button
          onClick={addSize}
          className="rounded-full bg-ink-100 px-3 py-1.5 text-sm font-medium text-ink-600 hover:bg-ink-200"
        >
          <Plus size={14} className="-mt-0.5 mr-1 inline" /> Dodaj rozmiar
        </button>
      </div>

      <input
        value={draft?.name ?? ''}
        onChange={(e) => update({ name: e.target.value })}
        placeholder="Nazwa modelu…"
        className="w-full bg-transparent text-2xl font-extrabold text-ink-900 placeholder:text-ink-300 focus:outline-none"
      />
      <p className="mt-1 text-xs text-ink-400">
        Nazwa, marka, kolor, materiał, zdjęcia i opisy są wspólne dla wszystkich rozmiarów.
        Rozmiar, stan, cena, ilość i konto ustawiasz osobno dla każdego rozmiaru.
      </p>

      {/* Taby */}
      <div className="mt-4 flex gap-1 border-b border-ink-100">
        {draft &&
          (
            [
              ['detale', 'Szczegóły'],
              ['zdjecia', `Zdjęcia (${draft.photoIds.length + draft.generatedPhotoIds.length})`],
              ['opisy', `Opisy (${draft.descriptions.length})`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={clsx(
                'border-b-2 px-4 py-2.5 text-sm font-semibold transition',
                tab === key
                  ? 'border-brand-500 text-brand-600'
                  : 'border-transparent text-ink-500 hover:text-ink-800',
              )}
            >
              {label}
            </button>
          ))}
      </div>

      <div className="py-5">
        {draft && tab === 'detale' && (
          <DetailsTab draft={draft} update={update} accounts={accounts ?? []} />
        )}
        {draft && tab === 'zdjecia' && <PhotosTab draft={draft} update={update} imageLink={{ designId }} />}
        {draft && tab === 'opisy' && <DescriptionsTab draft={draft} update={update} />}
      </div>

      {draft && (
        <SoldModal
          open={soldOpen}
          onClose={() => setSoldOpen(false)}
          product={{
            ...draft,
            name: `${design.name}${draft.sizeLabel ? ` — ${draft.sizeLabel}` : ''}`.trim(),
          }}
          onSold={() => {
            update({ status: 'sold', soldAt: Date.now() })
            setSoldOpen(false)
          }}
        />
      )}

      {/* Usuń bieżący rozmiar */}
      {members && members.length > 0 && (
        <div className="mt-6 border-t border-ink-100 pt-4">
          <Button variant="ghost" className="text-red-500" onClick={removeSize}>
            <Trash2 size={16} /> Usuń ten rozmiar
          </Button>
        </div>
      )}
    </div>
  )
}

// ── Szczegóły ───────────────────────────────────────────────────────────────
function DetailsTab({
  draft,
  update,
  accounts,
}: {
  draft: Product
  update: UpdateFn
  accounts: { id: string; name: string }[]
}) {
  const suggestion = useMemo(
    () => suggestPrice(draft.retailPrice ?? 0, draft.condition),
    [draft.retailPrice, draft.condition],
  )
  const seoTitle = useMemo(() => buildSeoTitle(draft), [draft])

  const num = (v: string) => (v === '' ? undefined : Number(v))
  const setM = (key: keyof Measurements, v: string) =>
    update({ measurements: { ...draft.measurements, [key]: v === '' ? undefined : Number(v) } })

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <div className="card grid gap-4 p-5 sm:grid-cols-2">
          <Field label="Marka">
            <TextInput value={draft.brand ?? ''} onChange={(e) => update({ brand: e.target.value })} placeholder="np. Zara" />
          </Field>
          <Field label="Kategoria">
            <TextInput
              list="cat-list"
              value={draft.category ?? ''}
              onChange={(e) => update({ category: e.target.value })}
              placeholder="np. Kobiety / Ubrania"
            />
            <datalist id="cat-list">
              {CATEGORY_SUGGESTIONS.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
          <Field label="Rozmiar">
            <TextInput
              list="size-list"
              value={draft.sizeLabel ?? ''}
              onChange={(e) => update({ sizeLabel: e.target.value })}
              placeholder="np. M / 38"
            />
            <datalist id="size-list">
              {SIZE_SUGGESTIONS.map((s, i) => (
                <option key={i} value={s} />
              ))}
            </datalist>
          </Field>
          <Field label="Kolor">
            <TextInput value={draft.color ?? ''} onChange={(e) => update({ color: e.target.value })} placeholder="np. czarny" />
          </Field>
          <Field label="Materiał">
            <TextInput value={draft.material ?? ''} onChange={(e) => update({ material: e.target.value })} placeholder="np. 100% bawełna" />
          </Field>
          <Field label="Stan">
            <Select
              value={draft.condition}
              onChange={(e) => update({ condition: e.target.value as Condition })}
            >
              {CONDITION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Tagi / słowa kluczowe" className="sm:col-span-2">
            <TextInput
              value={draft.tags.join(', ')}
              onChange={(e) =>
                update({ tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })
              }
              placeholder="oddziel przecinkami: oversize, vintage, lato"
            />
          </Field>
          <Field label="Notatki (w tym wady)" className="sm:col-span-2">
            <TextArea
              rows={2}
              value={draft.notes ?? ''}
              onChange={(e) => update({ notes: e.target.value })}
              placeholder="np. drobna plamka na rękawie, lekko sprane"
            />
          </Field>
        </div>

        {/* Wymiary */}
        <div className="card p-5">
          <p className="label">Wymiary (cm) — kupujący często o nie pytają</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                ['chest', 'Szer./klatka'],
                ['length', 'Długość'],
                ['sleeve', 'Rękaw'],
                ['waist', 'Pas'],
                ['hips', 'Biodra'],
                ['inseam', 'Nogawka wewn.'],
                ['shoulders', 'Ramiona'],
                ['footLength', 'Wkładka'],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={label}>
                <TextInput
                  type="number"
                  inputMode="decimal"
                  value={draft.measurements?.[key] ?? ''}
                  onChange={(e) => setM(key, e.target.value)}
                />
              </Field>
            ))}
          </div>
        </div>
      </div>

      {/* Boczna kolumna: ceny + kalkulator + tytuł SEO */}
      <div className="space-y-4">
        <div className="card space-y-4 p-5">
          <Field label="Cena wystawienia">
            <div className="flex gap-2">
              <TextInput
                type="number"
                inputMode="decimal"
                value={draft.listingPrice ?? ''}
                onChange={(e) => update({ listingPrice: num(e.target.value) })}
                placeholder="0"
              />
              <Select
                value={draft.currency}
                onChange={(e) => update({ currency: e.target.value })}
                className="w-24"
              >
                {CURRENCY_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </div>
          </Field>
          <Field label="Cena zakupu (koszt)">
            <TextInput
              type="number"
              inputMode="decimal"
              value={draft.purchasePrice ?? ''}
              onChange={(e) => update({ purchasePrice: num(e.target.value) })}
              placeholder="0"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Ilość">
              <TextInput
                type="number"
                value={draft.quantity}
                onChange={(e) => update({ quantity: Math.max(1, Number(e.target.value) || 1) })}
              />
            </Field>
            <Field label="Konto">
              <Select value={draft.accountId ?? ''} onChange={(e) => update({ accountId: e.target.value || undefined })}>
                <option value="">— brak —</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>

        {/* Kalkulator ceny */}
        <div className="card space-y-3 p-5">
          <div className="flex items-center gap-2">
            <Tag size={16} className="text-brand-500" />
            <p className="font-bold text-ink-900">Kalkulator ceny</p>
          </div>
          <Field label="Cena detaliczna (nowa)" hint="Wyliczy sugerowany przedział wg stanu.">
            <TextInput
              type="number"
              inputMode="decimal"
              value={draft.retailPrice ?? ''}
              onChange={(e) => update({ retailPrice: num(e.target.value) })}
              placeholder="np. 199"
            />
          </Field>
          {suggestion && (
            <div className="space-y-2 rounded-xl bg-ink-50 p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-ink-500">Sugerowany przedział</span>
                <span className="font-semibold">
                  {money(suggestion.low, draft.currency)} – {money(suggestion.high, draft.currency)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-500">Cena z miejscem na rabat</span>
                <button className="chip hover:bg-brand-100" onClick={() => update({ listingPrice: suggestion.anchor })}>
                  {money(suggestion.anchor, draft.currency)} → użyj
                </button>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-500">Próg ofert (min.)</span>
                <span className="font-semibold text-amber-600">{money(suggestion.floor, draft.currency)}</span>
              </div>
            </div>
          )}
        </div>

        {/* Tytuł SEO */}
        <div className="card space-y-2 p-5">
          <p className="label">Tytuł ogłoszenia (SEO)</p>
          <p className="rounded-xl bg-ink-50 px-3 py-2 text-sm text-ink-800">{seoTitle || '—'}</p>
          <Button variant="ghost" className="btn-sm w-full" onClick={() => copy(seoTitle)} disabled={!seoTitle}>
            <Copy size={14} /> Kopiuj tytuł
          </Button>
        </div>

        {/* Ogłoszenie: capture „Wystawiono” + link */}
        <ListingCard draft={draft} update={update} />

        <Link to={`/studio/${draft.id}`} className="btn-primary w-full">
          <Camera size={16} /> Zdjęcia na modelce (Studio)
        </Link>
      </div>
    </div>
  )
}

// ── Ogłoszenie (capture „Wystawiono” + link) ─────────────────────────────────
function ListingCard({ draft, update }: { draft: Product; update: UpdateFn }) {
  const href = listingHref(draft.listingUrl)
  const canMarkListed =
    draft.status !== 'listed' && draft.status !== 'sold' && draft.status !== 'archived'

  return (
    <div className="card space-y-3 p-5">
      <div className="flex items-center justify-between gap-2">
        <p className="label !mb-0">Ogłoszenie na Vinted</p>
        {draft.status === 'listed' && draft.listedAt != null && (
          <span
            className="text-xs text-ink-400"
            title={draft.listedAtApprox ? 'Data przybliżona (z historii edycji)' : undefined}
          >
            Wystawiono {draft.listedAtApprox ? '≈ ' : ''}
            {relative(draft.listedAt)}
          </span>
        )}
      </div>

      <Field label="Link do ogłoszenia">
        <div className="flex gap-2">
          <TextInput
            type="url"
            inputMode="url"
            value={draft.listingUrl ?? ''}
            onChange={(e) => update({ listingUrl: e.target.value || undefined })}
            placeholder="https://vinted.pl/items/…"
          />
          {href && (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost btn-sm shrink-0"
              title="Otwórz ogłoszenie"
              aria-label="Otwórz ogłoszenie na Vinted"
            >
              <ExternalLink size={15} />
            </a>
          )}
        </div>
      </Field>

      {canMarkListed && (
        <Button
          variant="primary"
          className="w-full"
          onClick={() => changeStatus(draft, 'listed', update)}
        >
          <Check size={16} /> Oznacz jako wystawione
        </Button>
      )}
    </div>
  )
}

// ── Zdjęcia ──────────────────────────────────────────────────────────────────
function PhotosTab({ draft, update, imageLink }: { draft: Product; update: UpdateFn; imageLink?: { productId?: string; designId?: string } }) {
  const [busy, setBusy] = useState(false)

  const addPhotos = async (files: File[]) => {
    setBusy(true)
    try {
      const ids: string[] = []
      for (const f of files) {
        const rec = await addImageFromFile(f, 'product', imageLink ?? { productId: draft.id })
        ids.push(rec.id)
      }
      // Forma funkcyjna — łączymy z najświeższym stanem (zdjęcia kodują się asynchronicznie).
      update((prev) => ({ photoIds: [...prev.photoIds, ...ids] }))
    } finally {
      setBusy(false)
    }
  }

  const removePhoto = async (id: string, kind: 'orig' | 'gen') => {
    await deleteEntity('images', id)
    update((prev) => ({
      ...(kind === 'orig'
        ? { photoIds: prev.photoIds.filter((x) => x !== id) }
        : { generatedPhotoIds: prev.generatedPhotoIds.filter((x) => x !== id) }),
      // Usuwając okładkę, czyść wskaźnik (fallback i tak złapie pierwsze zdjęcie).
      ...(prev.coverImageId === id ? { coverImageId: undefined } : {}),
    }))
  }

  // Okładka tylko dla produktów samodzielnych — w modelu karta zbiorcza i tak
  // pokazuje pierwsze wspólne zdjęcie, więc per-rozmiarowa okładka byłaby martwa.
  const showCover = !imageLink?.designId
  const cover = coverImageIdOf(draft)

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="label !mb-0">Oryginalne zdjęcia ({draft.photoIds.length})</p>
        </div>
        <FileDrop onFiles={addPhotos} disabled={busy} />
        {draft.photoIds.length > 0 && (
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5">
            {draft.photoIds.map((id) => (
              <PhotoCell
                key={id}
                id={id}
                onRemove={() => removePhoto(id, 'orig')}
                isCover={showCover && cover === id}
                onSetCover={showCover ? () => update({ coverImageId: id }) : undefined}
              />
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="label !mb-0">Zdjęcia na modelce AI ({draft.generatedPhotoIds.length})</p>
          <Link to={`/studio/${draft.id}`} className="btn-soft btn-sm">
            <Sparkles size={14} /> Generuj w Studio
          </Link>
        </div>
        {draft.generatedPhotoIds.length === 0 ? (
          <p className="rounded-xl bg-ink-50 px-4 py-6 text-center text-sm text-ink-400">
            Brak zdjęć na modelce. Otwórz Studio, by ubrać produkt na modelce AI.
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {draft.generatedPhotoIds.map((id) => (
              <PhotoCell
                key={id}
                id={id}
                ai
                onRemove={() => removePhoto(id, 'gen')}
                isCover={showCover && cover === id}
                onSetCover={showCover ? () => update({ coverImageId: id }) : undefined}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function PhotoCell({
  id,
  onRemove,
  ai,
  isCover,
  onSetCover,
}: {
  id: string
  onRemove: () => void
  ai?: boolean
  isCover?: boolean
  onSetCover?: () => void
}) {
  return (
    <div className="group relative overflow-hidden rounded-xl bg-ink-100">
      <Thumb imageId={id} className="aspect-square w-full object-cover" />
      {ai && (
        <span className="badge absolute left-1.5 top-1.5 bg-brand-500 text-white">
          <Sparkles size={11} /> AI
        </span>
      )}
      {onSetCover && (
        <button
          onClick={onSetCover}
          title={isCover ? 'Okładka' : 'Ustaw jako okładkę'}
          className={clsx(
            'absolute bottom-1.5 left-1.5 rounded-lg p-1 text-white transition',
            isCover ? 'bg-amber-500' : 'bg-black/50 opacity-0 group-hover:opacity-100',
          )}
        >
          <Star size={13} fill={isCover ? 'currentColor' : 'none'} />
        </button>
      )}
      <button
        onClick={onRemove}
        className="absolute right-1.5 top-1.5 rounded-lg bg-black/50 p-1 text-white opacity-0 transition group-hover:opacity-100"
      >
        <X size={13} />
      </button>
    </div>
  )
}

// ── Opisy ──────────────────────────────────────────────────────────────────
/** Wykonuje jedno generowanie opisu dla danego stylu (wspolny kod dla „Generuj”
 *  i „Generuj ponownie”). */
async function generateForStyle(
  style: NonNullable<ReturnType<typeof styleById>>,
  draft: Product,
  settings: AppSettings,
): Promise<DescriptionCandidate> {
  const text = await generateText(buildDescriptionPrompt(draft, style, settings), {
    apiKey: settings.geminiApiKey,
    model: settings.textModel,
    system: DESCRIPTION_SYSTEM,
    temperature: 1.0,
  })
  return { styleId: style.id, styleLabel: style.label, text }
}

function DescriptionsTab({ draft, update }: { draft: Product; update: UpdateFn }) {
  const settings = useSettings((s) => s.settings)
  const [selected, setSelected] = useState<string[]>(['zwiezly', 'casual', 'szczegolowy'])
  // Propozycje sa teraz TRWALE na produkcie — nie gina przy zmianie zakladki/nawigacji.
  const candidates = draft.descriptionCandidates ?? []
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [regenId, setRegenId] = useState<string | null>(null)

  const toggle = (idStyle: string) =>
    setSelected((s) => (s.includes(idStyle) ? s.filter((x) => x !== idStyle) : [...s, idStyle]))

  const generate = async () => {
    if (!settings?.geminiApiKey) return toast.error('Dodaj klucz API w Ustawieniach.')
    if (!draft.name.trim()) return toast.error('Najpierw podaj nazwę produktu.')
    if (selected.length === 0) return toast.error('Zaznacz co najmniej jeden styl.')
    setBusy(true)
    update({ descriptionCandidates: [] })
    try {
      for (let i = 0; i < selected.length; i++) {
        const style = styleById(selected[i])!
        setProgress(`Generuję: ${style.label} (${i + 1}/${selected.length})…`)
        const c = await generateForStyle(style, draft, settings)
        update((prev) => ({
          descriptionCandidates: upsertCandidate(prev.descriptionCandidates ?? [], c),
        }))
      }
      toast.success('Gotowe! Wybierz i zapisz najlepsze opisy.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Błąd generowania.')
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  const regenerate = async (styleId: string) => {
    if (!settings?.geminiApiKey) return toast.error('Dodaj klucz API w Ustawieniach.')
    if (!draft.name.trim()) return toast.error('Najpierw podaj nazwę produktu.')
    const style = styleById(styleId)
    if (!style) return
    setRegenId(styleId)
    try {
      const c = await generateForStyle(style, draft, settings)
      update((prev) => ({
        descriptionCandidates: upsertCandidate(prev.descriptionCandidates ?? [], c),
      }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Błąd generowania.')
    } finally {
      setRegenId(null)
    }
  }

  const editCandidate = (c: DescriptionCandidate, text: string) =>
    update((prev) => ({
      descriptionCandidates: upsertCandidate(prev.descriptionCandidates ?? [], { ...c, text }),
    }))

  const discardCandidate = (styleId: string) =>
    update((prev) => ({
      descriptionCandidates: removeCandidate(prev.descriptionCandidates ?? [], styleId),
    }))

  const saveCandidate = (c: DescriptionCandidate) => {
    update((prev) => {
      const desc: SavedDescription = {
        id: uid(),
        styleId: c.styleId,
        styleLabel: c.styleLabel,
        text: c.text,
        active: prev.descriptions.length === 0,
        createdAt: Date.now(),
      }
      return {
        descriptions: [...prev.descriptions, desc],
        descriptionCandidates: removeCandidate(prev.descriptionCandidates ?? [], c.styleId),
      }
    })
    toast.success('Zapisano opis do produktu.')
  }

  const setActive = (descId: string) =>
    update((prev) => ({
      descriptions: prev.descriptions.map((d) => ({ ...d, active: d.id === descId })),
    }))

  const removeDesc = (descId: string) =>
    update((prev) => ({ descriptions: prev.descriptions.filter((d) => d.id !== descId) }))

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <p className="label">Wybierz style do wygenerowania</p>
        <div className="flex flex-wrap gap-2">
          {DESCRIPTION_STYLES.map((s) => (
            <button
              key={s.id}
              onClick={() => toggle(s.id)}
              title={s.hint}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition',
                selected.includes(s.id)
                  ? 'bg-brand-500 text-white'
                  : 'bg-ink-100 text-ink-600 hover:bg-ink-200',
              )}
            >
              <span>{s.emoji}</span>
              {s.label}
            </button>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button onClick={generate} disabled={busy || regenId !== null}>
            {busy ? <Loader2 size={16} className="animate-spin-slow" /> : <Wand2 size={16} />}
            Generuj opisy
          </Button>
          {progress && <span className="text-sm text-ink-500">{progress}</span>}
        </div>
      </div>

      {/* Kandydaci */}
      {candidates.length > 0 && (
        <div className="space-y-3">
          <p className="label">Propozycje (edytuj i zapisz)</p>
          {candidates.map((c) => (
            <div key={c.styleId} className="card p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="chip">{styleById(c.styleId)?.emoji} {c.styleLabel}</span>
                <div className="flex gap-1">
                  <button
                    className="btn-ghost btn-sm"
                    onClick={() => regenerate(c.styleId)}
                    disabled={busy || regenId !== null}
                    title="Generuj ten styl ponownie"
                  >
                    {regenId === c.styleId ? (
                      <Loader2 size={14} className="animate-spin-slow" />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    Ponów
                  </button>
                  <button className="btn-ghost btn-sm" onClick={() => copy(c.text)}>
                    <Copy size={14} /> Kopiuj
                  </button>
                  <button className="btn-primary btn-sm" onClick={() => saveCandidate(c)}>
                    <Check size={14} /> Zapisz
                  </button>
                  <button
                    className="btn-ghost btn-sm text-red-500"
                    onClick={() => discardCandidate(c.styleId)}
                    title="Odrzuć propozycję"
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
              <TextArea rows={5} value={c.text} onChange={(e) => editCandidate(c, e.target.value)} />
            </div>
          ))}
        </div>
      )}

      {/* Zapisane */}
      <div className="space-y-3">
        <p className="label">Zapisane opisy ({draft.descriptions.length})</p>
        {draft.descriptions.length === 0 ? (
          <p className="rounded-xl bg-ink-50 px-4 py-6 text-center text-sm text-ink-400">
            Brak zapisanych opisów. Wygeneruj propozycje powyżej i zapisz te, które Ci pasują.
          </p>
        ) : (
          draft.descriptions.map((d) => (
            <div
              key={d.id}
              className={clsx('card p-4', d.active && 'ring-2 ring-brand-400')}
            >
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="chip">{styleById(d.styleId)?.emoji} {d.styleLabel}</span>
                  {d.active && <span className="badge bg-brand-100 text-brand-700">Aktywny</span>}
                </div>
                <div className="flex gap-1">
                  {!d.active && (
                    <button className="btn-ghost btn-sm" onClick={() => setActive(d.id)}>
                      <Star size={14} /> Ustaw aktywny
                    </button>
                  )}
                  <button className="btn-ghost btn-sm" onClick={() => copy(d.text)}>
                    <Copy size={14} />
                  </button>
                  <button className="btn-ghost btn-sm text-red-500" onClick={() => removeDesc(d.id)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <p className="whitespace-pre-wrap text-sm text-ink-700">{d.text}</p>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

