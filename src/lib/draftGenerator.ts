// Przygotowanie szkicu ogłoszenia w aplikacji (Gemini): tekst ze zdjęcia + faktów, zdjęcia
// (czyste zdjęcie produktu i opcjonalnie na modelce AI), cena z historii. Zapis w
// Design/Product.listingDraft — synchronizuje się jak reszta modelu. Wystawia właściciel ręcznie.

import { db, patchEntity } from '@/db/db'
import type { AppSettings, ID, ListingDraft, Product, Sale } from '@/db/types'
import { DEFAULT_IMAGE_RESOLUTION, DEFAULT_TEXT_MODEL } from './constants'
import { extractFromImages, generateImage, type InlineImage } from './gemini'
import { blobToBase64, getImageBlob } from './images'
import { saveGeneratedToTarget } from './generatedPhotos'
import { buildPhotoPrompt } from './prompts'
import {
  buildDraftPrompt,
  DRAFT_RESPONSE_SCHEMA,
  parseDraftResponse,
  suggestDraftPrice,
  type DraftQueueItem,
  type DraftText,
} from './listingDraft'

/** Proporcje zdjęć szkicu — pionowe 3:4, jak siatka Vinted. */
const DRAFT_ASPECT = '3:4'
const DRAFT_ASPECT_HINT = 'vertical 3:4 portrait orientation'

/** Zdjęcia idą do prawdziwego ogłoszenia — pozytywnie (bez negacji, patrz buildEditPrompt). */
const TRUE_TO_ITEM_NOTE =
  'This photo goes into a real sale listing: show the item exactly as it is, with the same colour, shape, proportions, materials and details as in the product photo.'

export interface DraftRunOptions {
  settings: AppSettings
  /** Modelka AI do zdjęcia „na modelce”; brak = tylko czyste zdjęcie produktu. */
  modelId?: ID
  /** Napisz tytuł/opis od nowa (inaczej zostaje obecny tekst szkicu). */
  text: boolean
  /** Wygeneruj nowe zdjęcia (inaczej szkic bierze już istniejące zdjęcia AI). */
  photos: boolean
  sales: Sale[]
  signal?: AbortSignal
  onStep?: (msg: string) => void
  /** Licznik obrazów do kosztorysu (useSettings.bumpImageCount). */
  bumpImageCount?: (n: number) => Promise<void>
}

async function toInline(imageId: ID): Promise<InlineImage | undefined> {
  const rec = await db.images.get(imageId)
  const blob = rec && (await getImageBlob(imageId))
  return rec && blob ? { mime: rec.mime, base64: await blobToBase64(blob) } : undefined
}

async function inlines(ids: ID[]): Promise<InlineImage[]> {
  const out: InlineImage[] = []
  for (const id of ids) {
    const inl = await toInline(id)
    if (inl) out.push(inl)
  }
  return out
}

/** Ile obrazów (płatnych) wygeneruje przygotowanie zdjęć dla przedmiotu. */
export function photosPerItem(item: DraftQueueItem, modelId?: ID): number {
  return item.product.photoIds.length ? 1 + (modelId ? 1 : 0) : 0
}

/** Czy szkic wymaga nowych zdjęć: przedmiot ma oryginał, a nie ma żadnego zdjęcia AI. */
export function needsPhotos(item: DraftQueueItem): boolean {
  return item.product.photoIds.length > 0 && item.product.generatedPhotoIds.length === 0
}

/** Surowa sztuka do zapisu zdjęć: dla modelu dowolna sztuka z designId (zdjęcia są wspólne). */
function rawTarget(item: DraftQueueItem): Product {
  return item.units[0]
}

async function generatePhotos(item: DraftQueueItem, opts: DraftRunOptions): Promise<ID[]> {
  const { settings } = opts
  const product = item.product
  const sourceIds = product.photoIds.slice(0, 2)
  const productInputs = await inlines(sourceIds)
  if (!productInputs.length) return []
  const model = opts.modelId ? await db.models.get(opts.modelId) : undefined
  const imageOpts = {
    apiKey: settings.geminiApiKey,
    model: settings.imageModel,
    resolution: settings.imageResolution ?? DEFAULT_IMAGE_RESOLUTION,
    aspectRatio: DRAFT_ASPECT,
    signal: opts.signal,
    // Płatne: timeout nie jest ponawiany (ryzyko podwójnego naliczenia, patrz callGenerate).
    retryTimeout: false,
  }
  const saved: ID[] = []

  if (model && model.referenceImageIds.length) {
    opts.onStep?.('zdjęcie na modelce')
    const cover = model.coverImageId ?? model.referenceImageIds[0]
    const refIds = [cover, ...model.referenceImageIds.filter((x) => x !== cover)].slice(0, 2)
    const prompt = buildPhotoPrompt({
      mode: 'tryOn',
      product,
      model,
      sceneId: 'studio',
      aspectHint: DRAFT_ASPECT_HINT,
      customNotes: TRUE_TO_ITEM_NOTE,
    })
    const { images } = await generateImage(prompt, [...(await inlines(refIds)), ...productInputs], imageOpts)
    await opts.bumpImageCount?.(images.length)
    for (const img of images.slice(0, 1)) {
      const rec = await saveGeneratedToTarget(rawTarget(item), img, {
        modelId: model.id,
        prompt,
        imageModel: settings.imageModel,
        sourceImageIds: [...refIds, ...sourceIds],
      })
      saved.push(rec.id)
    }
  }

  opts.onStep?.('zdjęcie produktu')
  const prompt = buildPhotoPrompt({
    mode: 'enhance',
    product,
    sceneId: 'studio',
    aspectHint: DRAFT_ASPECT_HINT,
    customNotes: TRUE_TO_ITEM_NOTE,
  })
  const { images } = await generateImage(prompt, productInputs, imageOpts)
  await opts.bumpImageCount?.(images.length)
  for (const img of images.slice(0, 1)) {
    const rec = await saveGeneratedToTarget(rawTarget(item), img, {
      prompt,
      imageModel: settings.imageModel,
      sourceImageIds: sourceIds,
    })
    saved.push(rec.id)
  }
  return saved
}

type DraftTarget = Pick<DraftQueueItem, 'kind' | 'key'>

/** Bieżący szkic z bazy (nie z propsów) — batch i karta mogły go właśnie zmienić. */
async function currentDraft(item: DraftTarget): Promise<ListingDraft | undefined> {
  return item.kind === 'design'
    ? (await db.designs.get(item.key))?.listingDraft
    : (await db.products.get(item.key))?.listingDraft
}

/** Zapisuje szkic (całość) na modelu albo produkcie. */
export async function saveDraft(item: DraftTarget, draft: ListingDraft | undefined): Promise<void> {
  if (item.kind === 'design') await patchEntity('designs', item.key, { listingDraft: draft })
  else await patchEntity('products', item.key, { listingDraft: draft })
}

/**
 * Odczyt + zapis szkicu w JEDNEJ transakcji: `next` dostaje świeży szkic, więc dwie szybkie
 * zmiany (blur tytułu i stuknięcie zdjęcia) albo edycja w trakcie generowania się nie gubią.
 */
async function updateDraft(
  item: DraftTarget,
  next: (cur: ListingDraft | undefined) => ListingDraft | undefined | null,
): Promise<void> {
  const table = item.kind === 'design' ? db.designs : db.products
  await db.transaction('rw', table, db.outbox, async () => {
    const draft = next(await currentDraft(item))
    if (draft !== null) await saveDraft(item, draft)
  })
}

/** Zmienia pola szkicu (edycja właściciela w karcie). */
export async function patchDraft(item: DraftTarget, changes: Partial<ListingDraft>): Promise<void> {
  await updateDraft(item, (cur) => (cur ? { ...cur, ...changes, updatedAt: Date.now() } : null))
}

const NO_PHOTO_WARNING =
  'Brak zdjęcia przedmiotu: dodaj zdjęcie w magazynie, żeby wygenerować zdjęcia do ogłoszenia.'
const NO_PRICE_WARNING = 'Brak ceny: wpisz cenę.'

/**
 * Przygotowuje (albo odświeża) szkic przedmiotu: zdjęcia, tekst, cena — i zapisuje go.
 * Rzuca GeminiError/Error; częściowy wynik (np. zapisane już zdjęcia) zostaje w modelu.
 */
export async function prepareDraft(item: DraftQueueItem, opts: DraftRunOptions): Promise<ListingDraft> {
  const { settings } = opts
  if (!settings.geminiApiKey) throw new Error('Dodaj klucz API Gemini w Ustawieniach.')
  const prev = await currentDraft(item)
  const now = Date.now()
  const warnings: string[] = []

  // Zdjęcia: nowe na żądanie; inaczej te ze szkicu, a bez szkicu — istniejące zdjęcia AI modelu.
  let photoIds = prev?.photoIds ?? item.product.generatedPhotoIds
  if (opts.photos) {
    const fresh = await generatePhotos(item, opts)
    if (fresh.length) photoIds = fresh
  }
  if (!item.product.photoIds.length && !photoIds.length) {
    photoIds = []
    warnings.push(NO_PHOTO_WARNING)
  }

  // Bez nowego tekstu zostają też uwagi modelu do niego (nasze własne liczymy od nowa).
  let text: DraftText | undefined = prev && {
    title: prev.title,
    description: prev.description,
    category: prev.category,
    color: prev.color,
    material: prev.material,
    warnings: (prev.warnings ?? []).filter((w) => w !== NO_PHOTO_WARNING && w !== NO_PRICE_WARNING),
  }
  if (opts.text || !text) {
    opts.onStep?.('tytuł i opis')
    // Tekst czyta ORYGINAŁ (prawdziwy przedmiot), a gdy go brak — pierwsze zdjęcie AI.
    const srcIds = item.product.photoIds.length ? item.product.photoIds.slice(0, 2) : photoIds.slice(0, 1)
    const images = await inlines(srcIds)
    const raw = await extractFromImages(buildDraftPrompt(item, images.length > 0), images, {
      apiKey: settings.geminiApiKey,
      model: settings.textModel || DEFAULT_TEXT_MODEL,
      responseSchema: DRAFT_RESPONSE_SCHEMA,
      temperature: 0.8,
      signal: opts.signal,
    })
    text = parseDraftResponse(raw)
  }
  warnings.push(...text.warnings)

  // Cena wpisana ręcznie zostaje; inaczej liczymy od nowa (sprzedaże mogły dojść).
  const price =
    prev?.priceBasis === 'manual'
      ? { price: prev.price, minPrice: prev.minPrice, priceBasis: prev.priceBasis }
      : (() => {
          const s = suggestDraftPrice(item.members, opts.sales)
          return s ? { price: s.price, minPrice: s.minPrice, priceBasis: s.basis } : {}
        })()
  if (price.price == null) warnings.push(NO_PRICE_WARNING)

  const draft: ListingDraft = {
    title: text.title,
    description: text.description,
    category: text.category,
    color: text.color,
    material: text.material,
    ...price,
    photoIds,
    warnings: warnings.length ? warnings : undefined,
    source: opts.text || !prev ? 'gemini' : prev.source,
    edited: opts.text || !prev ? undefined : prev.edited,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  }
  // Generowanie trwa do minuty — to, co właściciel zmienił w tym czasie w karcie, wygrywa
  // z migawką `prev` we wszystkim, czego ten przebieg nie generował od nowa.
  let saved = draft
  await updateDraft(item, (latest) => {
    if (latest && prev && latest.updatedAt !== prev.updatedAt) {
      saved = {
        ...draft,
        ...(opts.text ? {} : { title: latest.title, description: latest.description, edited: latest.edited }),
        ...(opts.photos ? {} : { photoIds: latest.photoIds }),
        ...(latest.priceBasis === 'manual'
          ? { price: latest.price, minPrice: latest.minPrice, priceBasis: latest.priceBasis }
          : {}),
      }
    }
    return saved
  })
  return saved
}
