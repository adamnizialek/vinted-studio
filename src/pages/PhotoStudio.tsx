import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { Camera, Download, Loader2, Shirt, Sparkles, Trash2, Wand2, X } from 'lucide-react'
import clsx from 'clsx'
import { db, deleteEntity, patchEntity, putEntity } from '@/db/db'
import { useSettings } from '@/state/settings'
import { toast } from '@/state/toast'
import { DEFAULT_IMAGE_MODEL, DEFAULT_IMAGE_RESOLUTION, estimateImageCostUsd } from '@/lib/constants'
import { SCENE_PRESETS, buildPhotoPrompt, type PhotoMode } from '@/lib/prompts'
import { generateImage, type InlineImage } from '@/lib/gemini'
import { addGeneratedImage, blobToBase64, getImageBlob } from '@/lib/images'
import { resolveProduct } from '@/lib/designs'
import { downloadBlob } from '@/lib/csv'
import { Button, EmptyState, Field, Select, TextArea, SectionTitle } from '@/components/ui'
import { FullImage, Thumb } from '@/components/ImageView'

const ASPECTS: { value: string; label: string; hint: string }[] = [
  { value: '3:4', label: 'Pionowo 3:4', hint: 'vertical 3:4 portrait orientation' },
  { value: '4:5', label: 'Pionowo 4:5', hint: 'vertical 4:5 portrait orientation' },
  { value: '1:1', label: 'Kwadrat 1:1', hint: 'square 1:1 orientation' },
]

async function toInline(imageId: string): Promise<InlineImage | undefined> {
  const rec = await db.images.get(imageId)
  if (!rec) return undefined
  const blob = await getImageBlob(imageId)
  if (!blob) return undefined
  return { mime: rec.mime, base64: await blobToBase64(blob) }
}

export function PhotoStudio() {
  const { productId } = useParams()
  const { settings, bumpImageCount } = useSettings()
  const products = useLiveQuery(() => db.products.orderBy('updatedAt').reverse().toArray(), [])
  const models = useLiveQuery(() => db.models.orderBy('createdAt').reverse().toArray(), [])

  const [selProductId, setSelProductId] = useState(productId ?? '')
  const [selModelId, setSelModelId] = useState('')
  const [mode, setMode] = useState<PhotoMode>('tryOn')
  const [sceneId, setSceneId] = useState('studio')
  const [aspect, setAspect] = useState('3:4')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [controller, setController] = useState<AbortController | null>(null)

  const designs = useLiveQuery(() => db.designs.toArray(), [])
  const designsById = useMemo(() => new Map((designs ?? []).map((d) => [d.id, d])), [designs])
  const rawProduct = useLiveQuery(
    async () => (selProductId ? await db.products.get(selProductId) : undefined),
    [selProductId],
  )
  const product = useMemo(
    () => (rawProduct ? resolveProduct(rawProduct, designsById) : undefined),
    [rawProduct, designsById],
  )
  const model = models?.find((m) => m.id === selModelId)

  // Domyslny wybor modelki / produktu.
  useEffect(() => {
    if (!selModelId && models && models.length) setSelModelId(models[0].id)
  }, [models, selModelId])
  useEffect(() => {
    if (productId) setSelProductId(productId)
  }, [productId])

  const variants = settings?.imageVariants ?? 1
  const perImageCost = estimateImageCostUsd(
    settings?.imageModel ?? DEFAULT_IMAGE_MODEL,
    settings?.imageResolution ?? DEFAULT_IMAGE_RESOLUTION,
  )
  const estCost = (variants * perImageCost).toFixed(3)

  const noModels = models && models.length === 0
  const canGenerate =
    !!product &&
    product.photoIds.length > 0 &&
    (mode === 'enhance' || (!!model && model.referenceImageIds.length > 0))

  const generate = async () => {
    if (!settings?.geminiApiKey) return toast.error('Dodaj klucz API w Ustawieniach.')
    if (!product) return toast.error('Wybierz produkt.')
    if (product.photoIds.length === 0)
      return toast.error('Ten produkt nie ma zdjęcia. Dodaj zdjęcie produktu w zakładce Zdjęcia.')
    if (mode === 'tryOn' && (!model || model.referenceImageIds.length === 0))
      return toast.error('Wybierz modelkę z co najmniej jednym zdjęciem.')

    const ac = new AbortController()
    setController(ac)
    setBusy(true)
    let saved = 0
    try {
      // Wyznacz dokładnie te id, które wyślemy (okładka modelki na początku),
      // i użyj ich zarówno do wejścia API, jak i do zapisu provenance.
      const cover = model?.coverImageId ?? model?.referenceImageIds[0]
      const modelRefIds =
        mode === 'tryOn' && model
          ? [cover!, ...model.referenceImageIds.filter((x) => x !== cover)].slice(0, 2)
          : []
      const productIds = product.photoIds.slice(0, 2)
      const sourceIds = [...modelRefIds, ...productIds]

      // Zbierz obrazy wejsciowe w tej samej kolejnosci.
      const inputs: InlineImage[] = []
      for (const sid of sourceIds) {
        const inl = await toInline(sid)
        if (inl) inputs.push(inl)
      }

      const prompt = buildPhotoPrompt({
        mode,
        product,
        model,
        sceneId,
        aspectHint: ASPECTS.find((a) => a.value === aspect)?.hint,
        customNotes: notes,
      })
      for (let i = 0; i < variants; i++) {
        setProgress(`Generuję wariant ${i + 1}/${variants}…`)
        const { images } = await generateImage(prompt, inputs, {
          apiKey: settings.geminiApiKey,
          model: settings.imageModel,
          resolution: settings.imageResolution ?? DEFAULT_IMAGE_RESOLUTION,
          aspectRatio: aspect,
          signal: ac.signal,
        })
        await bumpImageCount(images.length)
        for (const img of images) {
          const rec = await addGeneratedImage(
            img.base64,
            img.mime,
            { modelId: mode === 'tryOn' ? selModelId : undefined, prompt, imageModel: settings.imageModel, sourceImageIds: sourceIds },
            rawProduct?.designId ? {} : { productId: product.id },
          )
          if (rawProduct?.designId) {
            const d = await db.designs.get(rawProduct.designId)
            if (d)
              await patchEntity('designs', d.id, {
                generatedPhotoIds: [rec.id, ...d.generatedPhotoIds],
              })
            await patchEntity('images', rec.id, { designId: rawProduct.designId, productId: undefined })
          } else {
            const fresh = await db.products.get(product.id)
            if (fresh)
              await putEntity('products', { ...fresh, generatedPhotoIds: [rec.id, ...fresh.generatedPhotoIds] })
          }
          saved++
        }
      }
      toast.success(`Wygenerowano ${saved} zdjęć ✨ Zapisano do produktu.`)
    } catch (e) {
      // Anulowanie przez użytkownika to nie błąd. Zapisane warianty zostają.
      if (ac.signal.aborted)
        toast.info(saved > 0 ? `Anulowano — zapisano ${saved} zdjęć.` : 'Anulowano generowanie.')
      else toast.error(e instanceof Error ? e.message : 'Błąd generowania.')
    } finally {
      setBusy(false)
      setProgress('')
      setController(null)
    }
  }

  const removeGenerated = async (imageId: string) => {
    if (!rawProduct) return
    await deleteEntity('images', imageId)
    if (rawProduct.designId) {
      const d = await db.designs.get(rawProduct.designId)
      if (d)
        await patchEntity('designs', d.id, {
          generatedPhotoIds: d.generatedPhotoIds.filter((x) => x !== imageId),
        })
    } else {
      await patchEntity('products', rawProduct.id, {
        generatedPhotoIds: rawProduct.generatedPhotoIds.filter((x) => x !== imageId),
      })
    }
  }

  const download = async (imageId: string) => {
    const blob = await getImageBlob(imageId)
    if (!blob) return
    // Zachowane wyjscie modelu bywa PNG — pobieraj z poprawnym rozszerzeniem.
    const ext = blob.type === 'image/png' ? 'png' : 'jpg'
    downloadBlob(`vinted-${product?.name || 'zdjecie'}-${imageId.slice(0, 6)}.${ext}`, blob)
  }

  return (
    <div>
      <SectionTitle
        title="Studio zdjęć AI"
        subtitle="Ubierz produkt na modelce AI (wirtualna przymierzalnia) lub wyczyść tło zdjęcia."
      />

      {noModels && mode === 'tryOn' && (
        <div className="mb-4 flex items-center justify-between rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <span>Nie masz jeszcze modelki AI — utwórz ją, aby przymierzać ubrania.</span>
          <Link to="/modelki" className="btn-soft btn-sm">
            <Shirt size={14} /> Modelki
          </Link>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
        {/* Panel konfiguracji */}
        <div className="card space-y-4 self-start p-5">
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setMode('tryOn')}
              className={clsx('rounded-xl px-3 py-2 text-sm font-semibold', mode === 'tryOn' ? 'bg-brand-500 text-white' : 'bg-ink-100 text-ink-600')}
            >
              Na modelce
            </button>
            <button
              onClick={() => setMode('enhance')}
              className={clsx('rounded-xl px-3 py-2 text-sm font-semibold', mode === 'enhance' ? 'bg-brand-500 text-white' : 'bg-ink-100 text-ink-600')}
            >
              Czyść tło
            </button>
          </div>

          <Field label="Produkt">
            <Select value={selProductId} onChange={(e) => setSelProductId(e.target.value)}>
              <option value="">— wybierz produkt —</option>
              {products?.map((p) => {
                const r = resolveProduct(p, designsById)
                return (
                  <option key={p.id} value={p.id}>
                    {r.name || 'Bez nazwy'}{p.sizeLabel ? ` (${p.sizeLabel})` : ''} {r.photoIds.length === 0 ? '· brak zdjęcia' : ''}
                  </option>
                )
              })}
            </Select>
          </Field>

          {mode === 'tryOn' && (
            <Field label="Modelka">
              <Select value={selModelId} onChange={(e) => setSelModelId(e.target.value)}>
                <option value="">— wybierz modelkę —</option>
                {models?.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.referenceImageIds.length} zdj.)
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field label="Sceneria">
            <div className="grid grid-cols-2 gap-2">
              {SCENE_PRESETS.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSceneId(s.id)}
                  className={clsx(
                    'rounded-xl px-3 py-2 text-left text-sm font-medium transition',
                    sceneId === s.id
                      ? 'bg-brand-50 text-brand-700 ring-2 ring-brand-300 dark:bg-brand-950/40 dark:text-brand-300'
                      : 'bg-ink-50 text-ink-600 hover:bg-ink-100',
                  )}
                >
                  <span className="mr-1">{s.emoji}</span>
                  {s.label}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Format">
            <Select value={aspect} onChange={(e) => setAspect(e.target.value)}>
              {ASPECTS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Dodatkowe wskazówki (opcjonalnie)">
            <TextArea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="np. modelka uśmiechnięta, ciepłe światło"
            />
          </Field>

          <div>
            <Button onClick={generate} disabled={busy || !canGenerate} className="w-full">
              {busy ? <Loader2 size={16} className="animate-spin-slow" /> : <Wand2 size={16} />}
              Generuj {variants > 1 ? `${variants} warianty` : ''}
            </Button>
            {busy && (
              <Button variant="ghost" onClick={() => controller?.abort()} className="mt-2 w-full">
                <X size={16} /> Anuluj
              </Button>
            )}
            <p className="mt-2 text-center text-xs text-ink-400">
              {progress || `Szacowany koszt ≈ $${estCost} • płatne API`}
            </p>
          </div>
        </div>

        {/* Podgląd / wyniki */}
        <div className="space-y-4">
          {product && (
            <div className="card flex items-center gap-3 p-3">
              <Thumb imageId={product.photoIds[0]} className="h-16 w-16 rounded-xl object-cover" />
              <div className="min-w-0">
                <p className="truncate font-semibold text-ink-900">{product.name || 'Bez nazwy'}</p>
                <p className="text-xs text-ink-400">
                  {product.photoIds.length} zdjęć produktu · {product.generatedPhotoIds.length} na modelce
                </p>
              </div>
              {mode === 'tryOn' && model && (
                <div className="ml-auto flex items-center gap-2">
                  <Thumb imageId={model.coverImageId ?? model.referenceImageIds[0]} className="h-16 w-12 rounded-lg object-cover" />
                  <span className="text-xs text-ink-400">{model.name}</span>
                </div>
              )}
            </div>
          )}

          {!product ? (
            <EmptyState
              icon={<Camera size={40} />}
              title="Wybierz produkt"
              description="Wskaż produkt ze zdjęciem oraz modelkę, a następnie wygeneruj zdjęcia."
            />
          ) : product.generatedPhotoIds.length === 0 ? (
            <EmptyState
              icon={<Sparkles size={40} />}
              title="Brak wygenerowanych zdjęć"
              description={
                product.photoIds.length === 0
                  ? 'Ten produkt nie ma zdjęcia źródłowego. Dodaj je w edytorze produktu.'
                  : 'Skonfiguruj scenerię po lewej i kliknij „Generuj”.'
              }
              action={
                product.photoIds.length === 0 ? (
                  <Link to={`/magazyn/${product.id}`} className="btn-ghost">
                    Dodaj zdjęcie produktu
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {product.generatedPhotoIds.map((id) => (
                <div key={id} className="group relative overflow-hidden rounded-2xl bg-ink-100 ring-1 ring-ink-100">
                  <FullImage imageId={id} className="aspect-[3/4] w-full object-cover" />
                  <div className="absolute inset-x-0 bottom-0 flex justify-end gap-1 bg-gradient-to-t from-black/60 to-transparent p-2 opacity-0 transition group-hover:opacity-100">
                    <button onClick={() => download(id)} className="rounded-lg bg-surface/90 p-1.5 text-ink-700 hover:bg-surface" title="Pobierz">
                      <Download size={15} />
                    </button>
                    <button onClick={() => removeGenerated(id)} className="rounded-lg bg-surface/90 p-1.5 text-red-600 hover:bg-surface" title="Usuń">
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
