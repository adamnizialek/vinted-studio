import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  ArrowLeft,
  Camera,
  Check,
  Copy,
  Loader2,
  Sparkles,
  Star,
  Tag,
  Trash2,
  Wand2,
  X,
} from 'lucide-react'
import clsx from 'clsx'
import { db, deleteProductCascade } from '@/db/db'
import type { Condition, Measurements, Product, SavedDescription } from '@/db/types'
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
import { money } from '@/lib/format'
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
import { Button, Field, Modal, Select, TextArea, TextInput } from '@/components/ui'
import { Thumb } from '@/components/ImageView'
import { FileDrop } from '@/components/FileDrop'

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('Skopiowano do schowka.')
  } catch {
    toast.error('Nie udało się skopiować.')
  }
}

export function ProductEditor() {
  const { id } = useParams()
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

  const update = (patch: Partial<Product>) => {
    setDraft((prev) => {
      if (!prev) return prev
      const next = { ...prev, ...patch, updatedAt: Date.now() }
      void db.products.put(next)
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
            onChange={(e) => update({ status: e.target.value as Product['status'] })}
            className="w-40"
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          {draft.status !== 'sold' && (
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

// ── Szczegóły ───────────────────────────────────────────────────────────────
function DetailsTab({
  draft,
  update,
  accounts,
}: {
  draft: Product
  update: (p: Partial<Product>) => void
  accounts: { id: string; name: string }[]
}) {
  const [retail, setRetail] = useState('')
  const suggestion = useMemo(
    () => suggestPrice(Number(retail), draft.condition),
    [retail, draft.condition],
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
              value={retail}
              onChange={(e) => setRetail(e.target.value)}
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

        <Link to={`/studio/${draft.id}`} className="btn-primary w-full">
          <Camera size={16} /> Zdjęcia na modelce (Studio)
        </Link>
      </div>
    </div>
  )
}

// ── Zdjęcia ──────────────────────────────────────────────────────────────────
function PhotosTab({ draft, update }: { draft: Product; update: (p: Partial<Product>) => void }) {
  const [busy, setBusy] = useState(false)

  const addPhotos = async (files: File[]) => {
    setBusy(true)
    try {
      const ids: string[] = []
      for (const f of files) {
        const rec = await addImageFromFile(f, 'product', { productId: draft.id })
        ids.push(rec.id)
      }
      update({ photoIds: [...draft.photoIds, ...ids] })
    } finally {
      setBusy(false)
    }
  }

  const removePhoto = async (id: string, kind: 'orig' | 'gen') => {
    await db.images.delete(id)
    if (kind === 'orig') update({ photoIds: draft.photoIds.filter((x) => x !== id) })
    else update({ generatedPhotoIds: draft.generatedPhotoIds.filter((x) => x !== id) })
  }

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
              <PhotoCell key={id} id={id} onRemove={() => removePhoto(id, 'orig')} />
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
              <PhotoCell key={id} id={id} ai onRemove={() => removePhoto(id, 'gen')} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function PhotoCell({ id, onRemove, ai }: { id: string; onRemove: () => void; ai?: boolean }) {
  return (
    <div className="group relative overflow-hidden rounded-xl bg-ink-100">
      <Thumb imageId={id} className="aspect-square w-full object-cover" />
      {ai && (
        <span className="badge absolute left-1.5 top-1.5 bg-brand-500 text-white">
          <Sparkles size={11} /> AI
        </span>
      )}
      <button
        onClick={onRemove}
        className="absolute right-1.5 top-1.5 rounded-lg bg-ink-900/50 p-1 text-white opacity-0 transition group-hover:opacity-100"
      >
        <X size={13} />
      </button>
    </div>
  )
}

// ── Opisy ──────────────────────────────────────────────────────────────────
interface Candidate {
  styleId: string
  styleLabel: string
  text: string
}

function DescriptionsTab({ draft, update }: { draft: Product; update: (p: Partial<Product>) => void }) {
  const settings = useSettings((s) => s.settings)
  const [selected, setSelected] = useState<string[]>(['zwiezly', 'casual', 'szczegolowy'])
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')

  const toggle = (idStyle: string) =>
    setSelected((s) => (s.includes(idStyle) ? s.filter((x) => x !== idStyle) : [...s, idStyle]))

  const generate = async () => {
    if (!settings?.geminiApiKey) return toast.error('Dodaj klucz API w Ustawieniach.')
    if (!draft.name.trim()) return toast.error('Najpierw podaj nazwę produktu.')
    if (selected.length === 0) return toast.error('Zaznacz co najmniej jeden styl.')
    setBusy(true)
    setCandidates([])
    try {
      const results: Candidate[] = []
      for (let i = 0; i < selected.length; i++) {
        const style = styleById(selected[i])!
        setProgress(`Generuję: ${style.label} (${i + 1}/${selected.length})…`)
        const text = await generateText(buildDescriptionPrompt(draft, style, settings), {
          apiKey: settings.geminiApiKey,
          model: settings.textModel,
          system: DESCRIPTION_SYSTEM,
          temperature: 1.0,
        })
        results.push({ styleId: style.id, styleLabel: style.label, text })
        setCandidates([...results])
      }
      toast.success('Gotowe! Wybierz i zapisz najlepsze opisy.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Błąd generowania.')
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  const saveCandidate = (c: Candidate) => {
    const desc: SavedDescription = {
      id: uid(),
      styleId: c.styleId,
      styleLabel: c.styleLabel,
      text: c.text,
      active: draft.descriptions.length === 0,
      createdAt: Date.now(),
    }
    update({ descriptions: [...draft.descriptions, desc] })
    setCandidates((cs) => cs.filter((x) => x !== c))
    toast.success('Zapisano opis do produktu.')
  }

  const setActive = (descId: string) =>
    update({
      descriptions: draft.descriptions.map((d) => ({ ...d, active: d.id === descId })),
    })

  const removeDesc = (descId: string) =>
    update({ descriptions: draft.descriptions.filter((d) => d.id !== descId) })

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
          <Button onClick={generate} disabled={busy}>
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
          {candidates.map((c, i) => (
            <div key={i} className="card p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="chip">{styleById(c.styleId)?.emoji} {c.styleLabel}</span>
                <div className="flex gap-1">
                  <button className="btn-ghost btn-sm" onClick={() => copy(c.text)}>
                    <Copy size={14} /> Kopiuj
                  </button>
                  <button className="btn-primary btn-sm" onClick={() => saveCandidate(c)}>
                    <Check size={14} /> Zapisz
                  </button>
                </div>
              </div>
              <TextArea
                rows={5}
                value={c.text}
                onChange={(e) =>
                  setCandidates((cs) => cs.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))
                }
              />
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

// ── Modal sprzedaży ──────────────────────────────────────────────────────────
function SoldModal({
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
    await db.sales.put({
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
          <TextInput type="number" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} autoFocus />
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
