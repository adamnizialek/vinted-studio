import Dexie, { type Table } from 'dexie'
import type {
  Account,
  AiModel,
  AppSettings,
  ImageRecord,
  Product,
  Sale,
} from './types'
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_RESOLUTION,
  DEFAULT_TEXT_MODEL,
} from '@/lib/constants'
import { uid } from '@/lib/id'
import {
  saleImportKey,
  dedupKeyed,
  type DraftSale,
  type KeyedDraft,
} from '@/lib/salesImport'
import {
  stockImportKey,
  dedupKeyedStock,
  type ResolvedStockDraft,
  type KeyedStockDraft,
} from '@/lib/stockImport'

export class VintedStudioDB extends Dexie {
  products!: Table<Product, string>
  models!: Table<AiModel, string>
  accounts!: Table<Account, string>
  sales!: Table<Sale, string>
  images!: Table<ImageRecord, string>
  settings!: Table<AppSettings, string>

  constructor() {
    super('vinted-studio')
    this.version(1).stores({
      products:
        'id, status, accountId, brand, category, createdAt, updatedAt, soldAt, *tags',
      models: 'id, createdAt, updatedAt',
      accounts: 'id, createdAt',
      sales: 'id, accountId, productId, soldAt, status, createdAt',
      images: 'id, kind, productId, modelId, createdAt',
      settings: 'id',
    })
  }
}

export const db = new VintedStudioDB()

export const SCHEMA_VERSION = 2

export const DEFAULT_SETTINGS: AppSettings = {
  id: 'app',
  geminiApiKey: '',
  textModel: DEFAULT_TEXT_MODEL,
  imageModel: DEFAULT_IMAGE_MODEL,
  imageResolution: DEFAULT_IMAGE_RESOLUTION,
  currency: 'PLN',
  appendSignature: false,
  signature: 'Wysyłka w 24h 📦 Pytaj śmiało, łączę przesyłki! 💌',
  imagesGenerated: 0,
  imageVariants: 1,
  schemaVersion: SCHEMA_VERSION,
}

/**
 * Migracje ustawien miedzy wersjami schematu. Czysta funkcja (idempotentna) —
 * wynik jest stabilny przy ponownym wywolaniu i nie zalezy od IndexedDB.
 */
export function migrateSettings(row: AppSettings): AppSettings {
  let next = row
  if ((next.schemaVersion ?? 1) < 2) {
    // v2: domyslny model obrazow -> gemini-3.1-flash-image @ 2K (wyzsza rozdzielczosc
    // dla Vinted). Migrujemy tylko uzytkownikow ze starego domyslnego 2.5-flash-image,
    // by nie nadpisac swiadomego wyboru innego modelu.
    next = {
      ...next,
      imageModel:
        next.imageModel === 'gemini-2.5-flash-image'
          ? 'gemini-3.1-flash-image'
          : next.imageModel,
      imageResolution: next.imageResolution ?? DEFAULT_IMAGE_RESOLUTION,
      schemaVersion: 2,
    }
  }
  return next
}

/** Odczyt ustawien z domyslnymi wartosciami (uzupelnia brakujace pola + migracje). */
export async function getSettings(): Promise<AppSettings> {
  const row = await db.settings.get('app')
  return migrateSettings({ ...DEFAULT_SETTINGS, ...(row ?? {}), id: 'app' })
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings()
  const next: AppSettings = { ...current, ...patch, id: 'app' }
  await db.settings.put(next)
  return next
}

/**
 * Usuwa produkt wraz z powiazanymi obrazami (kaskada).
 * Nie usuwa wpisow sprzedazy — tam zostaje zdenormalizowana nazwa produktu.
 */
export async function deleteProductCascade(productId: string): Promise<void> {
  const product = await db.products.get(productId)
  if (!product) return
  const imageIds = [...product.photoIds, ...product.generatedPhotoIds]
  await db.transaction('rw', db.products, db.images, async () => {
    if (imageIds.length) await db.images.bulkDelete(imageIds)
    await db.products.delete(productId)
  })
}

/** Usuwa modelke wraz z jej zdjeciami referencyjnymi. */
export async function deleteModelCascade(modelId: string): Promise<void> {
  const model = await db.models.get(modelId)
  if (!model) return
  await db.transaction('rw', db.models, db.images, async () => {
    if (model.referenceImageIds.length)
      await db.images.bulkDelete(model.referenceImageIds)
    await db.models.delete(modelId)
  })
}

/** Pelny eksport bazy do obiektu JSON (obrazy jako data URL). */
export async function exportAll() {
  const [products, models, accounts, sales, settings, images] =
    await Promise.all([
      db.products.toArray(),
      db.models.toArray(),
      db.accounts.toArray(),
      db.sales.toArray(),
      getSettings(),
      db.images.toArray(),
    ])

  // Konwersja blobow na data URL, by JSON byl samowystarczalny.
  const imagesSerialized = await Promise.all(
    images.map(async (img) => ({
      ...img,
      blob: undefined,
      dataUrl: await blobToDataUrl(img.blob),
    })),
  )

  return {
    app: 'vinted-studio',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: Date.now(),
    products,
    models,
    accounts,
    sales,
    settings: { ...settings, geminiApiKey: '' }, // klucz API NIE jest eksportowany
    images: imagesSerialized,
  }
}

/** Import/odtworzenie z obiektu JSON (z exportAll). Scala dane po id. */
export async function importAll(data: any): Promise<void> {
  if (!data || data.app !== 'vinted-studio')
    throw new Error('Nieprawidłowy plik kopii zapasowej.')

  const images = await Promise.all(
    (data.images ?? []).map(async (img: any) => {
      const blob =
        img.dataUrl != null
          ? await (await fetch(img.dataUrl)).blob()
          : img.blob
      const { dataUrl, ...rest } = img
      void dataUrl
      return { ...rest, blob }
    }),
  )

  await db.transaction(
    'rw',
    [db.products, db.models, db.accounts, db.sales, db.images, db.settings],
    async () => {
      if (data.products?.length) await db.products.bulkPut(data.products)
      if (data.models?.length) await db.models.bulkPut(data.models)
      if (data.accounts?.length) await db.accounts.bulkPut(data.accounts)
      if (data.sales?.length) await db.sales.bulkPut(data.sales)
      if (images.length) await db.images.bulkPut(images)
      if (data.settings) {
        const current = await getSettings()
        // Zachowaj istniejacy klucz API, jesli w imporcie go nie ma.
        const apiKey = data.settings.geminiApiKey || current.geminiApiKey
        await db.settings.put({ ...current, ...data.settings, geminiApiKey: apiKey, id: 'app' })
      }
    },
  )
}

/** Czysci wszystkie dane (bez ustawien). */
export async function clearAllData(): Promise<void> {
  await db.transaction('rw', [db.products, db.models, db.accounts, db.sales, db.images], async () => {
    await Promise.all([
      db.products.clear(),
      db.models.clear(),
      db.accounts.clear(),
      db.sales.clear(),
      db.images.clear(),
    ])
  })
}

/**
 * Importuje wiersze sprzedaży do wybranego konta. Liczy klucze treści, odrzuca duplikaty
 * względem wcześniej zaimportowanych wierszy (różnica multizbiorów) i wstawia resztę.
 */
export async function importSales(
  drafts: DraftSale[],
  accountId: string,
): Promise<{ inserted: number; skippedDuplicates: number }> {
  return db.transaction('rw', db.sales, async () => {
    const existing = await db.sales.where('accountId').equals(accountId).toArray()
    const counts = new Map<string, number>()
    for (const s of existing) {
      if (s.importKey) counts.set(s.importKey, (counts.get(s.importKey) ?? 0) + 1)
    }

    const keyed: KeyedDraft[] = drafts.map((d) => ({
      key: saleImportKey(accountId, d.soldAt, d.productName, d.salePrice, d.purchaseCost),
      draft: d,
    }))
    const { toInsert, skipped } = dedupKeyed(counts, keyed)

    const now = Date.now()
    const sales: Sale[] = toInsert.map(({ key, draft }) => ({
      id: uid(),
      productName: draft.productName,
      accountId,
      salePrice: draft.salePrice,
      currency: 'PLN',
      quantity: 1,
      status: draft.status,
      purchaseCost: draft.purchaseCost,
      soldAt: draft.soldAt,
      createdAt: now,
      importKey: key,
    }))

    if (sales.length) await db.sales.bulkAdd(sales)
    return { inserted: sales.length, skippedDuplicates: skipped }
  })
}

/**
 * Importuje NIESPRZEDANE przedmioty do magazynu (tabela `products`) jako `in_stock`.
 * Konto bierze z auto-dopasowania / recenzji (może być puste). Deduplikacja multizbiorów
 * względem wcześniej zaimportowanych przedmiotów (po `importKey`) czyni ponowny import idempotentnym.
 */
export async function importStock(
  drafts: ResolvedStockDraft[],
): Promise<{ inserted: number; skippedDuplicates: number }> {
  return db.transaction('rw', db.products, async () => {
    const existing = await db.products.toArray()
    const counts = new Map<string, number>()
    for (const p of existing) {
      if (p.importKey) counts.set(p.importKey, (counts.get(p.importKey) ?? 0) + 1)
    }

    const keyed: KeyedStockDraft[] = drafts.map((d) => ({
      key: stockImportKey(d.name, d.purchaseCost),
      draft: d,
    }))
    const { toInsert, skipped } = dedupKeyedStock(counts, keyed)

    const now = Date.now()
    const products: Product[] = toInsert.map(({ key, draft }) => ({
      id: uid(),
      name: draft.name,
      condition: 'dobry',
      purchasePrice: draft.purchaseCost,
      currency: 'PLN',
      quantity: 1,
      status: 'in_stock',
      accountId: draft.accountId,
      photoIds: [],
      generatedPhotoIds: [],
      descriptions: [],
      tags: [],
      importKey: key,
      createdAt: now,
      updatedAt: now,
    }))

    if (products.length) await db.products.bulkAdd(products)
    return { inserted: products.length, skippedDuplicates: skipped }
  })
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}
