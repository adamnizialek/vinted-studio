// „Do wystawienia”: towar z magazynu bez ogłoszenia → gotowe szkice (zdjęcia AI, tytuł,
// opis, cena). Aplikacja przygotowuje wszystko do ostatniego kliknięcia; wystawia
// właściciel ręcznie na Vinted (żadnej automatyzacji Vinted — ryzyko bana).

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import clsx from 'clsx'
import {
  AlertTriangle,
  Check,
  ClipboardList,
  Copy,
  Download,
  ImagePlus,
  Megaphone,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { db } from '@/db/db'
import type { Account, AiModel, ListingDraft } from '@/db/types'
import { useSettings } from '@/state/settings'
import { toast } from '@/state/toast'
import { useLocalStorageState } from '@/lib/hooks'
import { estimateImageCostUsd, DEFAULT_IMAGE_RESOLUTION, USD_PLN } from '@/lib/constants'
import { GeminiError } from '@/lib/gemini'
import { getImageBlob } from '@/lib/images'
import { copyText, shareOrDownload } from '@/lib/share'
import { pluralPl } from '@/lib/format'
import { listProductOn, setDesignListings } from '@/lib/productActions'
import { listingsFor, toggleListing } from '@/lib/listing'
import {
  AI_PHOTOS_REMINDER,
  DRAFT_CONDITION_LABEL,
  draftQueue,
  pasteBlock,
  PRICE_BASIS_LABELS,
  sizeOf,
  titleForSize,
  unitSizes,
  type DraftQueueItem,
} from '@/lib/listingDraft'
import { needsPhotos, patchDraft, photosPerItem, prepareDraft, saveDraft } from '@/lib/draftGenerator'
import { Button, EmptyState, Modal, NumberInput, SectionTitle, Select, TextArea, TextInput } from '@/components/ui'
import { Thumb } from '@/components/ImageView'
import { AccountDot } from '@/components/ListingPicker'

const copy = (text: string, what: string) => copyText(text, `${what} ✓`)

/** Zapis pełnych zdjęć szkicu (telefon: arkusz udostępniania → Zdjęcia). */
async function savePhotos(ids: string[], name: string) {
  try {
    const files: File[] = []
    for (const [i, id] of ids.entries()) {
      const blob = await getImageBlob(id)
      if (!blob) continue
      const ext = blob.type === 'image/png' ? 'png' : 'jpg'
      files.push(new File([blob], `${name.slice(0, 30) || 'zdjecie'}-${i + 1}.${ext}`, { type: blob.type || 'image/jpeg' }))
    }
    if (!files.length) return toast.error('Nie udało się pobrać zdjęć. Sprawdź połączenie.')
    if (!(await shareOrDownload(files))) toast.info('Zdjęcia gotowe: stuknij „Zapisz zdjęcia” jeszcze raz.')
  } catch {
    toast.error('Nie udało się pobrać zdjęć. Sprawdź połączenie.')
  }
}

/**
 * Zdjęcia szkicu, które nadal istnieją (zdjęcie usunięte w Studio/edytorze znika też
 * ze szkicu), i czy są wśród nich wygenerowane przez AI (przypomnienie o polu na Vinted).
 */
function useDraftPhotos(ids: string[]): { ids: string[]; hasAi: boolean } {
  const recs = useLiveQuery(() => db.images.bulkGet(ids), [ids.join(',')])
  if (!recs) return { ids, hasAi: false }
  const live = recs.filter((r): r is NonNullable<typeof r> => !!r)
  return { ids: live.map((r) => r.id), hasAi: live.some((r) => r.kind === 'generated' || r.kind === 'model') }
}

interface RunState {
  label: string
  done: number
  total: number
  controller: AbortController
}

export function Drafts() {
  const { settings, bumpImageCount } = useSettings()
  const products = useLiveQuery(() => db.products.toArray(), [])
  const designs = useLiveQuery(() => db.designs.toArray(), [])
  const sales = useLiveQuery(() => db.sales.toArray(), [])
  const accounts = useLiveQuery(() => db.accounts.orderBy('createdAt').toArray(), [])
  const models = useLiveQuery(() => db.models.orderBy('createdAt').toArray(), [])
  const [includeIncoming, setIncludeIncoming] = useLocalStorageState('drafts-include-incoming', false)
  const [modelId, setModelId] = useLocalStorageState('drafts-model-id', '')
  const [run, setRun] = useState<RunState | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const queue = useMemo(
    () => draftQueue(products ?? [], designs ?? [], { includeIncoming }),
    [products, designs, includeIncoming],
  )
  const usableModels = (models ?? []).filter((m) => m.referenceImageIds.length > 0)
  const model = usableModels.find((m) => m.id === modelId)
  const pending = queue.filter((it) => !it.draft)
  const photoCount = pending.filter(needsPhotos).reduce((n, it) => n + photosPerItem(it, model?.id), 0)
  const perImagePln =
    estimateImageCostUsd(settings?.imageModel ?? '', settings?.imageResolution ?? DEFAULT_IMAGE_RESOLUTION) * USD_PLN

  /** Przygotowuje szkice po kolei. Brak płatności przerywa całość; inne błędy — tylko ten przedmiot. */
  const runItems = async (items: DraftQueueItem[], mode: { text?: boolean; photos?: 'missing' | 'always' }) => {
    if (!settings?.geminiApiKey) return toast.error('Dodaj klucz API Gemini w Ustawieniach.')
    if (run) return
    const controller = new AbortController()
    const failed: string[] = []
    let done = 0
    setRun({ label: 'Start…', done, total: items.length, controller })
    try {
      for (const item of items) {
        if (controller.signal.aborted) break
        const name = item.product.name.slice(0, 40)
        try {
          await prepareDraft(item, {
            settings,
            modelId: model?.id,
            text: mode.text ?? true,
            photos: mode.photos === 'always' || (mode.photos === 'missing' && needsPhotos(item)),
            sales: sales ?? [],
            signal: controller.signal,
            bumpImageCount,
            onStep: (step) => setRun((r) => r && { ...r, label: `${name}: ${step}` }),
          })
        } catch (e) {
          if (controller.signal.aborted) break
          if (e instanceof GeminiError && (e.code === 'billing' || e.status === 400 || e.status === 403)) throw e
          failed.push(`${name}: ${e instanceof Error ? e.message : 'błąd'}`)
        }
        done++
        setRun((r) => r && { ...r, done })
      }
      if (controller.signal.aborted) toast.info(`Zatrzymano. Gotowe: ${done}.`)
      else if (failed.length) toast.error(`Nie wyszło ${failed.length}: ${failed[0]}`)
      else if (items.length > 1) toast.success(`Szkice gotowe: ${done} ✨`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Błąd generowania.')
    } finally {
      setRun(null)
    }
  }

  // Ceny liczą się z historii sprzedaży — bez niej batch zapisałby cenę z ceny zakupu.
  if (!products || !designs || !accounts || !sales) return null

  return (
    <div>
      <SectionTitle
        subtitle="Towar z magazynu bez ogłoszenia. Wystawiasz ręcznie na Vinted."
        title="Do wystawienia"
        right={
          pending.length > 0 && (
            <div className="flex gap-2">
              <Button onClick={() => setConfirmOpen(true)} disabled={!!run}>
                <Sparkles size={16} /> Przygotuj szkice ({pending.length})
              </Button>
            </div>
          )
        }
      />

      <div className="card mb-4 flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
          <span className="shrink-0 text-ink-500">Zdjęcie na modelce:</span>
          <Select value={model?.id ?? ''} onChange={(e) => setModelId(e.target.value)} className="!py-1.5">
            <option value="">bez modelki (tylko zdjęcie produktu)</option>
            {usableModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-600">
          <input type="checkbox" checked={includeIncoming} onChange={(e) => setIncludeIncoming(e.target.checked)} />
          też zamówione (w drodze)
        </label>
      </div>

      {run && (
        <div className="card mb-4 flex items-center gap-3 p-4 text-sm">
          <RefreshCw size={16} className="shrink-0 animate-spin text-brand-500" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-ink-900">{run.label}</p>
            <p className="text-xs text-ink-500">
              {run.done}/{run.total}
            </p>
          </div>
          <Button variant="ghost" className="btn-sm" onClick={() => run.controller.abort()}>
            Zatrzymaj
          </Button>
        </div>
      )}

      {queue.length === 0 ? (
        <EmptyState
          icon={<ClipboardList size={36} />}
          title="Wszystko wystawione"
          description="Gdy w magazynie pojawi się sztuka bez ogłoszenia, tu będzie na nią szkic."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {queue.map((item) => (
            <DraftCard
              key={item.key}
              item={item}
              accounts={accounts}
              model={model}
              busy={!!run}
              onPrepare={(mode) => void runItems([item], mode)}
            />
          ))}
        </div>
      )}

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Przygotować szkice?"
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              Anuluj
            </Button>
            <Button
              onClick={() => {
                setConfirmOpen(false)
                void runItems(pending, { text: true, photos: 'missing' })
              }}
            >
              <Sparkles size={16} /> Przygotuj
            </Button>
          </div>
        }
      >
        <div className="space-y-2 text-sm text-ink-700">
          <p>
            {pending.length} {pluralPl(pending.length, 'szkic', 'szkice', 'szkiców')}: tytuł, opis i cena z Gemini.
          </p>
          <p>
            Nowe zdjęcia AI tylko tam, gdzie ich jeszcze nie ma: {photoCount}{' '}
            {pluralPl(photoCount, 'zdjęcie', 'zdjęcia', 'zdjęć')}
            {model ? ` (produkt + na modelce ${model.name})` : ' (zdjęcie produktu)'}, około{' '}
            {(photoCount * perImagePln).toFixed(2).replace('.', ',')} zł.
          </p>
          <p className="text-xs text-ink-500">Na Vinted nic nie trafia samo: każde ogłoszenie dodajesz ręcznie.</p>
        </div>
      </Modal>
    </div>
  )
}

function DraftCard({
  item,
  accounts,
  model,
  busy,
  onPrepare,
}: {
  item: DraftQueueItem
  accounts: Account[]
  model?: AiModel
  busy: boolean
  onPrepare: (mode: { text?: boolean; photos?: 'missing' | 'always' }) => void
}) {
  const { draft, product } = item
  const sizes = unitSizes(item.units)
  const [size, setSize] = useState(sizes[0]?.[0] ?? '')
  const current = sizes.some(([s]) => s === size) ? size : (sizes[0]?.[0] ?? '')
  const editorHref = item.kind === 'design' ? `/magazyn/model/${item.key}` : `/magazyn/${item.key}`
  const cover = product.photoIds[0] ?? draft?.photoIds[0] ?? product.generatedPhotoIds[0]

  return (
    <div className="card flex flex-col gap-3 p-4">
      <div className="flex gap-3">
        <Link to={editorHref} className="shrink-0">
          <Thumb imageId={cover} className="h-16 w-16 rounded-xl object-cover" />
        </Link>
        <div className="min-w-0 flex-1">
          <Link to={editorHref} className="line-clamp-2 text-sm font-semibold text-ink-900 hover:underline">
            {product.name || 'Bez nazwy'}
          </Link>
          <div className="mt-1 flex flex-wrap gap-1">
            {sizes.map(([s, n]) => (
              <button
                key={s || '?'}
                type="button"
                onClick={() => setSize(s)}
                className={clsx(
                  'rounded-full px-2 py-0.5 text-[11px] font-medium ring-1',
                  s === current ? 'bg-brand-500 text-white ring-brand-500' : 'text-ink-600 ring-ink-200',
                )}
              >
                {s || 'bez rozmiaru'} × {n}
              </button>
            ))}
            {draft && (
              <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[11px] text-ink-500">
                {draft.source === 'lister' ? 'Lister' : draft.source === 'manual' ? 'ręcznie' : 'Gemini'}
                {draft.edited ? ' · poprawiony' : ''}
              </span>
            )}
          </div>
        </div>
      </div>

      {!draft ? (
        <div className="flex flex-wrap gap-2">
          <Button className="btn-sm" disabled={busy} onClick={() => onPrepare({ text: true, photos: 'missing' })}>
            <Sparkles size={14} /> Przygotuj szkic
          </Button>
          {!product.photoIds.length && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Brak zdjęcia: <Link to={editorHref} className="underline">dodaj je w magazynie</Link>, inaczej będzie sam tekst.
            </p>
          )}
        </div>
      ) : (
        <DraftBody
          item={item}
          draft={draft}
          size={current}
          accounts={accounts}
          model={model}
          busy={busy}
          onPrepare={onPrepare}
        />
      )}
    </div>
  )
}

function DraftBody({
  item,
  draft,
  size,
  accounts,
  model,
  busy,
  onPrepare,
}: {
  item: DraftQueueItem
  draft: ListingDraft
  size: string
  accounts: Account[]
  model?: AiModel
  busy: boolean
  onPrepare: (mode: { text?: boolean; photos?: 'missing' | 'always' }) => void
}) {
  const { ids: photoIds, hasAi } = useDraftPhotos(draft.photoIds)
  const [title, setTitle] = useState(draft.title)
  const [description, setDescription] = useState(draft.description)
  // Szkic zmieniony z zewnątrz (nowy tekst z Gemini, Lister przez sync) — pokaż nowy.
  const [seen, setSeen] = useState(draft.updatedAt)
  if (seen !== draft.updatedAt) {
    setSeen(draft.updatedAt)
    setTitle(draft.title)
    setDescription(draft.description)
  }
  const fullTitle = titleForSize(title, size)
  const unit = item.units.find((u) => sizeOf(u) === size) ?? item.units[0]

  const saveText = () => {
    if (title.trim() === draft.title && description.trim() === draft.description) return
    if (!title.trim() || !description.trim()) return
    void patchDraft(item, { title: title.trim(), description: description.trim(), edited: true })
  }

  const markListed = async (account: Account) => {
    try {
      // Tylko włącza (nigdy nie zdejmuje): podwójne stuknięcie nie może cofnąć wystawienia.
      if (item.kind === 'design')
        await setDesignListings(item.key, (cur, members) =>
          listingsFor(cur, unit).some((l) => l.accountId === account.id)
            ? cur
            : toggleListing(cur, account.id, Date.now(), unit, members),
        )
      else await listProductOn(unit.id, account.id, Date.now())
      toast.success(`Wystawione na ${account.name}${size ? ` (rozm. ${size})` : ''} ✓`)
    } catch {
      toast.error('Nie udało się zapisać.')
    }
  }

  return (
    <>
      {hasAi && (
        <div className="flex gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle size={16} className="shrink-0" />
          <span>{AI_PHOTOS_REMINDER}</span>
        </div>
      )}

      {photoIds.length > 0 && (
        <div>
          <div className="no-scrollbar flex gap-2 overflow-x-auto">
            {photoIds.map((id, i) => (
              <div key={id} className="relative shrink-0">
                <Thumb imageId={id} className="h-28 w-[84px] rounded-lg object-cover" />
                <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white">{i + 1}</span>
                <button
                  type="button"
                  aria-label="Usuń ze szkicu"
                  disabled={busy}
                  onClick={() => void patchDraft(item, { photoIds: photoIds.filter((x) => x !== id) })}
                  className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
          <Button variant="soft" className="btn-sm mt-2" onClick={() => void savePhotos(photoIds, fullTitle)}>
            <Download size={14} /> Zapisz zdjęcia ({photoIds.length})
          </Button>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between gap-2">
          <span className="label !mb-0">Tytuł</span>
          <span className="text-[11px] text-ink-400">{fullTitle.length} zn.</span>
        </div>
        <div className="mt-1 flex gap-2">
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} onBlur={saveText} />
          <Button variant="ghost" className="btn-sm shrink-0" onClick={() => void copy(fullTitle, 'Tytuł skopiowany')}>
            <Copy size={14} />
          </Button>
        </div>
        {fullTitle !== title.trim() && <p className="mt-1 text-xs text-ink-500">Na Vinted: {fullTitle}</p>}
      </div>

      <div>
        <div className="flex items-center justify-between">
          <span className="label !mb-0">Opis</span>
          <Button variant="ghost" className="btn-sm" onClick={() => void copy(description, 'Opis skopiowany')}>
            <Copy size={14} /> Kopiuj
          </Button>
        </div>
        <TextArea rows={6} value={description} onChange={(e) => setDescription(e.target.value)} onBlur={saveText} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-ink-500">
          Cena (zł)
          <NumberInput
            disabled={busy}
            value={draft.price}
            onValueChange={(v) => void patchDraft(item, { price: v, priceBasis: 'manual' })}
          />
        </label>
        <label className="text-xs text-ink-500">
          Najniższa oferta (zł)
          <NumberInput
            disabled={busy}
            value={draft.minPrice}
            onValueChange={(v) => void patchDraft(item, { minPrice: v, priceBasis: 'manual' })}
          />
        </label>
        {draft.priceBasis && (
          <p className="col-span-2 text-[11px] text-ink-400">Cena: {PRICE_BASIS_LABELS[draft.priceBasis]}</p>
        )}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {size && (
          <>
            <dt className="text-ink-400">Rozmiar</dt>
            <dd className="text-ink-800">{size}</dd>
          </>
        )}
        <dt className="text-ink-400">Stan</dt>
        <dd className="text-ink-800">{DRAFT_CONDITION_LABEL}</dd>
        {draft.category && (
          <>
            <dt className="text-ink-400">Kategoria</dt>
            <dd className="text-ink-800">{draft.category}</dd>
          </>
        )}
        {draft.color && (
          <>
            <dt className="text-ink-400">Kolor</dt>
            <dd className="text-ink-800">{draft.color}</dd>
          </>
        )}
        {draft.material && (
          <>
            <dt className="text-ink-400">Materiał</dt>
            <dd className="text-ink-800">{draft.material}</dd>
          </>
        )}
      </dl>

      {draft.warnings?.length ? (
        <ul className="space-y-0.5 text-xs text-amber-700 dark:text-amber-300">
          {draft.warnings.map((w) => (
            <li key={w}>• {w}</li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button variant="soft" className="btn-sm" onClick={() => void copy(pasteBlock({ ...draft, title, description, photoIds }, size, hasAi), 'Szkic skopiowany')}>
          <Copy size={14} /> Kopiuj wszystko
        </Button>
        <Button variant="ghost" className="btn-sm" disabled={busy} onClick={() => onPrepare({ text: true })}>
          <RefreshCw size={14} /> Nowy tekst
        </Button>
        <Button
          variant="ghost"
          className="btn-sm"
          disabled={busy || !item.product.photoIds.length}
          title={model ? `Produkt + na modelce ${model.name}` : 'Zdjęcie produktu'}
          onClick={() => onPrepare({ text: false, photos: 'always' })}
        >
          <ImagePlus size={14} /> Nowe zdjęcia
        </Button>
        <Button
          variant="ghost"
          className="btn-sm text-ink-400"
          disabled={busy}
          onClick={() => {
            if (confirm('Usunąć szkic? Zdjęcia zostają w magazynie.')) void saveDraft(item, undefined)
          }}
        >
          <Trash2 size={14} />
        </Button>
      </div>

      {accounts.length > 0 && (
        <div className="border-t border-ink-100 pt-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs text-ink-500">
            <Megaphone size={13} /> Dodane na Vinted? Zaznacz konto{size ? ` (1 szt., rozm. ${size})` : ' (1 szt.)'}:
          </p>
          <div className="flex flex-wrap gap-2">
            {accounts.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => void markListed(a)}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-ink-200 hover:bg-ink-100"
              >
                <AccountDot account={a} /> {a.name} <Check size={12} className="text-ink-400" />
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
