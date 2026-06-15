import Dexie, { type Table } from 'dexie'
import type {
  Account,
  AiModel,
  AppSettings,
  Design,
  Expense,
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
import { type SyncTable } from '@/sync/core'
import {
  saleImportKey,
  dedupKeyed,
  expenseImportKey,
  type DraftSale,
  type DraftExpense,
  type KeyedDraft,
} from '@/lib/salesImport'
import {
  stockImportKey,
  dedupKeyedStock,
  type ResolvedStockDraft,
  type KeyedStockDraft,
} from '@/lib/stockImport'

/** Wpis kolejki wychodzacej — wiersz zmieniony lokalnie i czekajacy na push. */
export interface OutboxEntry {
  table: SyncTable
  id: string
  /** 0 = upsert, 1 = tombstone (usuniecie). */
  deleted: 0 | 1
  /** Czas zmiany (ms) — uzywany przy budowaniu pushu, zwlaszcza dla tombstone'ow. */
  updatedAt: number
}

/** Pojedyncza wartosc metadanych synchronizacji (np. kursor, id urzadzenia). */
export interface SyncMeta {
  key: string
  value: unknown
}

/** Lokalny (niesynchronizowany) znacznik: blob obrazu czeka na upload do R2. */
export interface BlobUpload {
  id: string
}

export class VintedStudioDB extends Dexie {
  products!: Table<Product, string>
  designs!: Table<Design, string>
  models!: Table<AiModel, string>
  accounts!: Table<Account, string>
  sales!: Table<Sale, string>
  expenses!: Table<Expense, string>
  images!: Table<ImageRecord, string>
  settings!: Table<AppSettings, string>
  outbox!: Table<OutboxEntry, [SyncTable, string]>
  sync_meta!: Table<SyncMeta, string>
  blob_outbox!: Table<BlobUpload, string>

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
    // v2: dodaje kolejke synchronizacji (outbox) + metadane (kursor), oraz
    // uzupelnia `updatedAt` na encjach, ktore wczesniej go nie mialy.
    this.version(2)
      .stores({
        outbox: '[table+id], table',
        sync_meta: 'key',
        blob_outbox: 'id',
      })
      .upgrade(async (tx) => {
        const backfill = (r: { createdAt?: number; updatedAt?: number }) => {
          if (r.updatedAt == null) r.updatedAt = r.createdAt ?? Date.now()
        }
        await tx.table('accounts').toCollection().modify(backfill)
        await tx.table('sales').toCollection().modify(backfill)
        await tx.table('images').toCollection().modify(backfill)
        await tx
          .table('settings')
          .toCollection()
          .modify((s: { updatedAt?: number }) => {
            if (s.updatedAt == null) s.updatedAt = Date.now()
          })
      })
    // v3: dodaje tabelę kosztów promocji (podbicia/ekspozycja). Czysto addytywne —
    // nowa pusta tabela, brak migracji danych.
    this.version(3).stores({
      expenses: 'id, accountId, incurredAt, createdAt',
    })
    // v4: model wspoldzielony (Design) + indeks designId na products. Czysto
    // addytywne — nowa pusta tabela i nowy indeks, brak migracji danych.
    this.version(4).stores({
      designs: 'id, createdAt, updatedAt',
      products:
        'id, status, accountId, brand, category, createdAt, updatedAt, soldAt, designId, *tags',
    })
  }
}

export const db = new VintedStudioDB()

export const SCHEMA_VERSION = 4

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
  updatedAt: 0,
}

// ---------------------------------------------------------------------------
// Mapowanie nazwa tabeli -> typ encji. Wszystkie encje maja `id` i `updatedAt`.
// ---------------------------------------------------------------------------
interface EntityMap {
  products: Product
  designs: Design
  models: AiModel
  accounts: Account
  sales: Sale
  expenses: Expense
  images: ImageRecord
  settings: AppSettings
}

function tableOf<K extends SyncTable>(table: K): Table<EntityMap[K], string> {
  return db.table(table) as unknown as Table<EntityMap[K], string>
}

/** Encja zapisywana przez uzytkownika — `updatedAt` jest opcjonalne (i tak je nadpiszemy). */
type Writable<T> = Omit<T, 'updatedAt'> & { updatedAt?: number }

// ---------------------------------------------------------------------------
// Zapisy uzytkownika — bumpuja `updatedAt` i ZAWSZE dodaja wpis do outboxu.
// (sciezka synchronizacji uzywa applyRemote*, ktora outboxu NIE rusza.)
// ---------------------------------------------------------------------------

/** Zapis/aktualizacja calej encji przez uzytkownika. */
export async function putEntity<K extends SyncTable>(
  table: K,
  rec: Writable<EntityMap[K]>,
): Promise<EntityMap[K]> {
  const now = Date.now()
  const stamped = { ...rec, updatedAt: now } as EntityMap[K]
  const id = (stamped as { id: string }).id
  await db.transaction('rw', tableOf(table), db.outbox, async () => {
    await tableOf(table).put(stamped)
    await db.outbox.put({ table, id, deleted: 0, updatedAt: now })
  })
  return stamped
}

/** Czesciowa aktualizacja istniejacej encji (scala zmiany). */
export async function patchEntity<K extends SyncTable>(
  table: K,
  id: string,
  changes: Partial<EntityMap[K]>,
): Promise<void> {
  const now = Date.now()
  await db.transaction('rw', tableOf(table), db.outbox, async () => {
    const existing = await tableOf(table).get(id)
    if (!existing) return
    const next = { ...existing, ...changes, updatedAt: now } as EntityMap[K]
    await tableOf(table).put(next)
    await db.outbox.put({ table, id, deleted: 0, updatedAt: now })
  })
}

/** Usuniecie przez uzytkownika — kasuje wiersz lokalnie i kolejkuje tombstone. */
export async function deleteEntity(table: SyncTable, id: string): Promise<void> {
  const now = Date.now()
  await db.transaction('rw', tableOf(table), db.outbox, async () => {
    await tableOf(table).delete(id)
    await db.outbox.put({ table, id, deleted: 1, updatedAt: now })
  })
}

// ---------------------------------------------------------------------------
// Sciezka synchronizacji — zapis danych przyslanych ze zdalnego zrodla.
// NIE dodaje wpisow do outboxu (inaczej powstalaby petla pull->push).
// ---------------------------------------------------------------------------

/** Zastosowanie zdalnego upsertu. Zachowuje lokalny blob obrazu i klucz API. */
export async function applyRemoteUpsert<K extends SyncTable>(
  table: K,
  rec: EntityMap[K],
): Promise<void> {
  if (table === 'images') {
    const incoming = rec as ImageRecord
    const existing = await db.images.get(incoming.id)
    // Zdalny wiersz nie niesie bloba — nie kasuj lokalnie zbuforowanego.
    await db.images.put({ ...incoming, blob: incoming.blob ?? existing?.blob })
    return
  }
  if (table === 'settings') {
    const incoming = rec as AppSettings
    const existing = await db.settings.get('app')
    // Klucz API jest lokalny — nigdy nie nadpisuj go (pustym) zdalnym.
    await db.settings.put({
      ...incoming,
      id: 'app',
      geminiApiKey: existing?.geminiApiKey ?? '',
    })
    return
  }
  await tableOf(table).put(rec)
}

/** Zastosowanie zdalnego usuniecia (tombstone). */
export async function applyRemoteDelete(table: SyncTable, id: string): Promise<void> {
  await tableOf(table).delete(id)
}

// ---------------------------------------------------------------------------
// Ustawienia
// ---------------------------------------------------------------------------

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
  return putEntity('settings', next)
}

// ---------------------------------------------------------------------------
// Kaskadowe usuwanie (soft — propaguje sie przez tombstone'y w outboxie)
// ---------------------------------------------------------------------------

/**
 * Usuwa produkt wraz z powiazanymi obrazami (kaskada).
 * Nie usuwa wpisow sprzedazy — tam zostaje zdenormalizowana nazwa produktu.
 */
export async function deleteProductCascade(productId: string): Promise<void> {
  const product = await db.products.get(productId)
  if (!product) return
  const imageIds = [...product.photoIds, ...product.generatedPhotoIds]
  const now = Date.now()
  await db.transaction('rw', db.products, db.images, db.outbox, async () => {
    for (const imgId of imageIds) {
      await db.images.delete(imgId)
      await db.outbox.put({ table: 'images', id: imgId, deleted: 1, updatedAt: now })
    }
    await db.products.delete(productId)
    await db.outbox.put({ table: 'products', id: productId, deleted: 1, updatedAt: now })
  })
}

/** Usuwa modelke wraz z jej zdjeciami referencyjnymi. */
export async function deleteModelCascade(modelId: string): Promise<void> {
  const model = await db.models.get(modelId)
  if (!model) return
  const now = Date.now()
  await db.transaction('rw', db.models, db.images, db.outbox, async () => {
    for (const imgId of model.referenceImageIds) {
      await db.images.delete(imgId)
      await db.outbox.put({ table: 'images', id: imgId, deleted: 1, updatedAt: now })
    }
    await db.models.delete(modelId)
    await db.outbox.put({ table: 'models', id: modelId, deleted: 1, updatedAt: now })
  })
}

// ---------------------------------------------------------------------------
// Eksport / import / czyszczenie
// ---------------------------------------------------------------------------

/** Pelny eksport bazy do obiektu JSON (obrazy jako data URL). */
export async function exportAll() {
  const [products, designs, models, accounts, sales, expenses, settings, images] = await Promise.all([
    db.products.toArray(),
    db.designs.toArray(),
    db.models.toArray(),
    db.accounts.toArray(),
    db.sales.toArray(),
    db.expenses.toArray(),
    getSettings(),
    db.images.toArray(),
  ])

  // Konwersja blobow na data URL, by JSON byl samowystarczalny.
  const imagesSerialized = await Promise.all(
    images.map(async (img) => ({
      ...img,
      blob: undefined,
      dataUrl: img.blob ? await blobToDataUrl(img.blob) : null,
    })),
  )

  return {
    app: 'vinted-studio',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: Date.now(),
    products,
    designs,
    models,
    accounts,
    sales,
    expenses,
    settings: { ...settings, geminiApiKey: '' }, // klucz API NIE jest eksportowany
    images: imagesSerialized,
  }
}

function withUpdatedAt<T extends { createdAt?: number; updatedAt?: number }>(r: T): T {
  return r.updatedAt != null ? r : { ...r, updatedAt: r.createdAt ?? Date.now() }
}

/** Import/odtworzenie z obiektu JSON (z exportAll). Scala dane po id i kolejkuje do synchronizacji. */
export async function importAll(data: any): Promise<void> {
  if (!data || data.app !== 'vinted-studio')
    throw new Error('Nieprawidłowy plik kopii zapasowej.')

  const images: ImageRecord[] = await Promise.all(
    (data.images ?? []).map(async (img: any) => {
      const blob =
        img.dataUrl != null ? await (await fetch(img.dataUrl)).blob() : img.blob
      const { dataUrl, ...rest } = img
      void dataUrl
      return withUpdatedAt({ ...rest, blob })
    }),
  )

  const products = (data.products ?? []).map(withUpdatedAt)
  const designs = (data.designs ?? []).map(withUpdatedAt)
  const models = (data.models ?? []).map(withUpdatedAt)
  const accounts = (data.accounts ?? []).map(withUpdatedAt)
  const sales = (data.sales ?? []).map(withUpdatedAt)
  const expenses = (data.expenses ?? []).map(withUpdatedAt)

  await db.transaction(
    'rw',
    [db.products, db.designs, db.models, db.accounts, db.sales, db.expenses, db.images, db.settings, db.outbox],
    async () => {
      const queue = (table: SyncTable, rows: { id: string; updatedAt: number }[]) =>
        Promise.all(
          rows.map((r) =>
            db.outbox.put({ table, id: r.id, deleted: 0, updatedAt: r.updatedAt }),
          ),
        )

      if (products.length) {
        await db.products.bulkPut(products)
        await queue('products', products)
      }
      if (designs.length) {
        await db.designs.bulkPut(designs)
        await queue('designs', designs)
      }
      if (models.length) {
        await db.models.bulkPut(models)
        await queue('models', models)
      }
      if (accounts.length) {
        await db.accounts.bulkPut(accounts)
        await queue('accounts', accounts)
      }
      if (sales.length) {
        await db.sales.bulkPut(sales)
        await queue('sales', sales)
      }
      if (expenses.length) {
        await db.expenses.bulkPut(expenses)
        await queue('expenses', expenses)
      }
      if (images.length) {
        await db.images.bulkPut(images)
        await queue('images', images as { id: string; updatedAt: number }[])
      }
      if (data.settings) {
        const current = await getSettings()
        // Zachowaj istniejacy klucz API, jesli w imporcie go nie ma.
        const apiKey = data.settings.geminiApiKey || current.geminiApiKey
        const next: AppSettings = {
          ...current,
          ...data.settings,
          geminiApiKey: apiKey,
          id: 'app',
          updatedAt: Date.now(),
        }
        await db.settings.put(next)
        await db.outbox.put({
          table: 'settings',
          id: 'app',
          deleted: 0,
          updatedAt: next.updatedAt,
        })
      }
    },
  )
}

/**
 * Czysci wszystkie dane (bez ustawien) i propaguje usuniecie przez tombstone'y,
 * tak by "wyczysc wszystko" objelo rowniez chmure i pozostale urzadzenia.
 */
export async function clearAllData(): Promise<void> {
  const now = Date.now()
  await db.transaction(
    'rw',
    [db.products, db.designs, db.models, db.accounts, db.sales, db.expenses, db.images, db.outbox],
    async () => {
      const tombstoneAll = async (table: SyncTable, tbl: Table<{ id: string }, string>) => {
        const ids = await tbl.toCollection().primaryKeys()
        await tbl.clear()
        await Promise.all(
          (ids as string[]).map((id) =>
            db.outbox.put({ table, id, deleted: 1, updatedAt: now }),
          ),
        )
      }
      await tombstoneAll('products', db.products as Table<{ id: string }, string>)
      await tombstoneAll('designs', db.designs as Table<{ id: string }, string>)
      await tombstoneAll('models', db.models as Table<{ id: string }, string>)
      await tombstoneAll('accounts', db.accounts as Table<{ id: string }, string>)
      await tombstoneAll('sales', db.sales as Table<{ id: string }, string>)
      await tombstoneAll('expenses', db.expenses as Table<{ id: string }, string>)
      await tombstoneAll('images', db.images as Table<{ id: string }, string>)
    },
  )
}

/** Przedmiot z importu, którego usunięcie jest bezpieczne (brak własnej pracy: zdjęć). */
const isImportedProduct = (p: Product) =>
  p.importKey != null && (p.photoIds?.length ?? 0) === 0 && (p.generatedPhotoIds?.length ?? 0) === 0

/** Liczy wiersze pochodzące z importu (z `importKey`), które usunąłby `clearImportedData`. */
export async function countImportedData(): Promise<{ sales: number; expenses: number; products: number }> {
  const [sales, expenses, products] = await Promise.all([
    db.sales.filter((s) => s.importKey != null).count(),
    db.expenses.filter((e) => e.importKey != null).count(),
    db.products.filter(isImportedProduct).count(),
  ])
  return { sales, expenses, products }
}

/**
 * Usuwa WYŁĄCZNIE dane pochodzące z importu CSV/XLSX (z `importKey`): sprzedaże, koszty
 * promocji oraz przedmioty z magazynu BEZ zdjęć. Ręczne wpisy, konta, ustawienia i produkty,
 * nad którymi pracowano w Studio (mają zdjęcia), zostają nietknięte. Propaguje usunięcia przez
 * tombstone'y (jak `clearAllData`), więc czyszczenie obejmuje też chmurę i pozostałe urządzenia.
 */
export async function clearImportedData(): Promise<{ sales: number; expenses: number; products: number }> {
  const now = Date.now()
  return db.transaction('rw', [db.sales, db.expenses, db.products, db.outbox], async () => {
    const sales = await db.sales.filter((s) => s.importKey != null).toArray()
    const expenses = await db.expenses.filter((e) => e.importKey != null).toArray()
    const products = await db.products.filter(isImportedProduct).toArray()

    const wipe = async (
      table: SyncTable,
      tbl: Table<{ id: string }, string>,
      rows: { id: string }[],
    ) => {
      for (const r of rows) {
        await tbl.delete(r.id)
        await db.outbox.put({ table, id: r.id, deleted: 1, updatedAt: now })
      }
    }

    await wipe('sales', db.sales as Table<{ id: string }, string>, sales)
    await wipe('expenses', db.expenses as Table<{ id: string }, string>, expenses)
    await wipe('products', db.products as Table<{ id: string }, string>, products)

    return { sales: sales.length, expenses: expenses.length, products: products.length }
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
  return db.transaction('rw', db.sales, db.outbox, async () => {
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
      updatedAt: now,
      importKey: key,
    }))

    if (sales.length) {
      await db.sales.bulkAdd(sales)
      // Zakolejkuj do synchronizacji, by zaimportowane wiersze trafily do chmury.
      await db.outbox.bulkPut(
        sales.map((s) => ({ table: 'sales' as const, id: s.id, deleted: 0 as const, updatedAt: now })),
      )
    }
    return { inserted: sales.length, skippedDuplicates: skipped }
  })
}

/**
 * Importuje koszty promocji do wybranego konta. Idempotentny względem wcześniej
 * zaimportowanych kosztów (różnica multizbiorów po `importKey`). Pomija szkice bez daty.
 */
export async function importExpenses(
  drafts: DraftExpense[],
  accountId: string,
): Promise<{ inserted: number; skippedDuplicates: number }> {
  return db.transaction('rw', db.expenses, db.outbox, async () => {
    const existing = await db.expenses.where('accountId').equals(accountId).toArray()
    const counts = new Map<string, number>()
    for (const e of existing) {
      if (e.importKey) counts.set(e.importKey, (counts.get(e.importKey) ?? 0) + 1)
    }

    const keyed = drafts
      .filter((d) => d.incurredAt !== null)
      .map((d) => ({
        key: expenseImportKey(accountId, d.incurredAt, d.kind, d.description, d.amount),
        draft: d,
      }))

    const seen = new Map(counts)
    const toInsert: typeof keyed = []
    let skipped = 0
    for (const item of keyed) {
      const c = seen.get(item.key) ?? 0
      if (c > 0) {
        seen.set(item.key, c - 1)
        skipped++
      } else {
        toInsert.push(item)
      }
    }

    const now = Date.now()
    const expenses: Expense[] = toInsert.map(({ key, draft }) => ({
      id: uid(),
      accountId,
      kind: draft.kind,
      description: draft.description,
      amount: draft.amount,
      currency: 'PLN',
      incurredAt: draft.incurredAt as number,
      createdAt: now,
      updatedAt: now,
      importKey: key,
    }))

    if (expenses.length) {
      await db.expenses.bulkAdd(expenses)
      await db.outbox.bulkPut(
        expenses.map((e) => ({ table: 'expenses' as const, id: e.id, deleted: 0 as const, updatedAt: now })),
      )
    }
    return { inserted: expenses.length, skippedDuplicates: skipped }
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
  return db.transaction('rw', db.products, db.outbox, async () => {
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
      // Wzbogacenie ze zrzutu ekranu (vision) — opcjonalne; import z CSV ich nie ustawia.
      brand: draft.brand,
      color: draft.color,
      sizeLabel: draft.sizeLabel,
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

    if (products.length) {
      await db.products.bulkAdd(products)
      await db.outbox.bulkPut(
        products.map((p) => ({ table: 'products' as const, id: p.id, deleted: 0 as const, updatedAt: now })),
      )
    }
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
