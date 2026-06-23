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
  SavedDescription,
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
  draftImportKey,
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
    // v5: cykl życia oferty. listedAt/listedAtApprox/coverImageId to pola
    // NIEINDEKSOWANE (jadą za darmo w blobie sync — brak zmiany stores, brak
    // migracji D1). Backfill: istniejące przedmioty 'listed' bez listedAt
    // dostają przybliżoną datę z updatedAt i flagę listedAtApprox (UI sygnalizuje
    // przybliżenie). Nie rusza updatedAt ani outboxu — wartość jest deterministyczna
    // (z synchronizowanego updatedAt), więc każde urządzenie policzy ją tak samo.
    this.version(5).upgrade(async (tx) => {
      await tx
        .table('products')
        .toCollection()
        .modify(
          (p: {
            status?: string
            listedAt?: number
            listedAtApprox?: boolean
            updatedAt?: number
            createdAt?: number
          }) => {
            if (p.status === 'listed' && p.listedAt == null) {
              p.listedAt = p.updatedAt ?? p.createdAt ?? Date.now()
              p.listedAtApprox = true
            }
          },
        )
    })
  }
}

export const db = new VintedStudioDB()

export const SCHEMA_VERSION = 5

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
  // Rozmiar nalezacy do modelu: nie ma wlasnych obrazow (sa wspolne na modelu).
  if (product.designId) {
    const designId = product.designId
    await db.transaction(
      'rw',
      [db.products, db.designs, db.images, db.outbox, db.blob_outbox],
      async () => {
        const siblings = await db.products.where('designId').equals(designId).count()
        if (siblings <= 1) {
          await deleteDesignCascade(designId) // ostatni rozmiar -> usun model (nested, reuses tx)
        } else {
          await deleteEntity('products', productId) // nested, reuses tx
        }
      },
    )
    return
  }
  // --- istniejaca sciezka samodzielna (BEZ ZMIAN) ---
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
      key: draftImportKey(d),
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

/**
 * Laczy >=2 SAMODZIELNE produkty w nowy model. `primaryId` zasiewa tozsamosc;
 * zdjecia/opisy/tagi WSZYSTKICH czlonkow sa scalane do modelu (dedup po id,
 * kolejnosc: primary pierwszy), co najwyzej jeden opis `active`. Kazdy czlonek:
 * designId = model.id, pola wspolne wyczyszczone; obrazy dostaja designId.
 */
export async function groupProducts(
  productIds: string[],
  primaryId: string,
): Promise<Design> {
  const uniqueIds = [...new Set(productIds)]
  if (uniqueIds.length < 2) throw new Error('Zaznacz co najmniej dwa produkty.')
  if (!uniqueIds.includes(primaryId)) throw new Error('Produkt glowny musi byc zaznaczony.')
  const now = Date.now()
  const designId = uid()
  return db.transaction('rw', db.products, db.designs, db.images, db.outbox, async () => {
    const loaded = await Promise.all(uniqueIds.map((id) => db.products.get(id)))
    const products = loaded.filter((p): p is Product => !!p && !p.designId)
    if (products.length < 2)
      throw new Error('Potrzebne co najmniej dwa samodzielne produkty (pozostale sa juz w modelu).')
    const primary = products.find((p) => p.id === primaryId)
    if (!primary) throw new Error('Nie znaleziono produktu glownego (lub jest juz w modelu).')
    const ordered = [primary, ...products.filter((p) => p.id !== primaryId)]

    const dedup = (xs: string[]) => [...new Set(xs)]
    const photoIds = dedup(ordered.flatMap((p) => p.photoIds))
    const generatedPhotoIds = dedup(ordered.flatMap((p) => p.generatedPhotoIds))
    const tags = dedup(ordered.flatMap((p) => p.tags))

    const seen = new Set<string>()
    const merged: SavedDescription[] = []
    for (const p of ordered)
      for (const d of p.descriptions)
        if (!seen.has(d.id)) { seen.add(d.id); merged.push({ ...d }) }
    const primaryActiveId = primary.descriptions.find((d) => d.active)?.id
    const descriptions = merged.map((d, i) => ({
      ...d,
      active: primaryActiveId ? d.id === primaryActiveId : i === 0,
    }))

    const design: Design = {
      id: designId,
      name: primary.name,
      brand: primary.brand,
      color: primary.color,
      material: primary.material,
      category: primary.category,
      tags,
      photoIds,
      generatedPhotoIds,
      descriptions,
      createdAt: now,
      updatedAt: now,
    }
    await db.designs.put(design)
    await db.outbox.put({ table: 'designs', id: designId, deleted: 0, updatedAt: now })

    for (const imgId of [...photoIds, ...generatedPhotoIds]) {
      const img = await db.images.get(imgId)
      if (!img) continue
      await db.images.put({ ...img, designId, productId: undefined, updatedAt: now })
      await db.outbox.put({ table: 'images', id: imgId, deleted: 0, updatedAt: now })
    }

    for (const p of ordered) {
      const next: Product = {
        ...p,
        designId,
        name: '',
        brand: undefined,
        color: undefined,
        material: undefined,
        category: undefined,
        tags: [],
        photoIds: [],
        generatedPhotoIds: [],
        // Okładka jest per-produkt i wskazuje własne zdjęcie — w modelu zdjęcia
        // są wspólne, więc czyścimy (inaczej zostałby wiszący wskaźnik po rozłączeniu).
        coverImageId: undefined,
        descriptions: [],
        updatedAt: now,
      }
      await db.products.put(next)
      await db.outbox.put({ table: 'products', id: p.id, deleted: 0, updatedAt: now })
    }
    return design
  })
}

/**
 * Dodaje istniejace, SAMODZIELNE produkty do JUZ istniejacego modelu. Odpowiednik
 * `groupProducts`, ale celem jest gotowy Design — nie tworzy nowego. Zdjecia/opisy/
 * tagi dolaczanych produktow sa scalane do modelu (dedup po id; tresc modelu jest
 * pierwsza i kanoniczna, zachowany dokladnie jeden `active`). Kazdy dolaczony produkt:
 * designId = model.id, pola wspolne wyczyszczone, jego obrazy przejmuje model; pola
 * per-size (rozmiar, cena, stan, konto…) zostaja. Produkty juz bedace w jakims modelu
 * sa pomijane (np. wybrany przez pomylke inny model).
 */
export async function attachProductsToDesign(
  designId: string,
  productIds: string[],
): Promise<Design> {
  const uniqueIds = [...new Set(productIds)]
  const now = Date.now()
  return db.transaction('rw', db.products, db.designs, db.images, db.outbox, async () => {
    const design = await db.designs.get(designId)
    if (!design) throw new Error('Nie znaleziono modelu docelowego.')
    const loaded = await Promise.all(uniqueIds.map((id) => db.products.get(id)))
    const incoming = loaded.filter((p): p is Product => !!p && !p.designId)
    if (incoming.length === 0)
      throw new Error('Zaznacz przynajmniej jeden samodzielny produkt do dodania.')

    const dedup = (xs: string[]) => [...new Set(xs)]
    const photoIds = dedup([...design.photoIds, ...incoming.flatMap((p) => p.photoIds)])
    const generatedPhotoIds = dedup([
      ...design.generatedPhotoIds,
      ...incoming.flatMap((p) => p.generatedPhotoIds),
    ])
    const tags = dedup([...design.tags, ...incoming.flatMap((p) => p.tags)])

    const seen = new Set<string>()
    const merged: SavedDescription[] = []
    for (const d of [...design.descriptions, ...incoming.flatMap((p) => p.descriptions)])
      if (!seen.has(d.id)) { seen.add(d.id); merged.push({ ...d }) }
    // Zachowaj aktywny opis modelu; gdy model go nie mial — pierwszy scalony.
    const keepActiveId = design.descriptions.find((d) => d.active)?.id
    const descriptions = merged.map((d, i) => ({
      ...d,
      active: keepActiveId ? d.id === keepActiveId : i === 0,
    }))

    const updated: Design = {
      ...design,
      tags,
      photoIds,
      generatedPhotoIds,
      descriptions,
      updatedAt: now,
    }
    await db.designs.put(updated)
    await db.outbox.put({ table: 'designs', id: designId, deleted: 0, updatedAt: now })

    // Przejmij obrazy dotad nalezace do dolaczanych produktow (obrazy modelu juz maja designId).
    for (const imgId of dedup(incoming.flatMap((p) => [...p.photoIds, ...p.generatedPhotoIds]))) {
      const img = await db.images.get(imgId)
      if (!img) continue
      await db.images.put({ ...img, designId, productId: undefined, updatedAt: now })
      await db.outbox.put({ table: 'images', id: imgId, deleted: 0, updatedAt: now })
    }

    for (const p of incoming) {
      const next: Product = {
        ...p,
        designId,
        name: '',
        brand: undefined,
        color: undefined,
        material: undefined,
        category: undefined,
        tags: [],
        photoIds: [],
        generatedPhotoIds: [],
        // Okladka jest per-produkt — w modelu zdjecia sa wspolne (patrz groupProducts).
        coverImageId: undefined,
        descriptions: [],
        updatedAt: now,
      }
      await db.products.put(next)
      await db.outbox.put({ table: 'products', id: p.id, deleted: 0, updatedAt: now })
    }
    return updated
  })
}

/** Klonuje wiersz obrazu na wlasnosc produktu (nowy id, ten sam blob). */
async function cloneImageRow(
  id: string,
  productId: string | undefined,
  now: number,
): Promise<string | null> {
  const img = await db.images.get(id)
  if (!img) return null
  const newId = uid()
  await db.images.put({ ...img, id: newId, productId, designId: undefined, createdAt: now, updatedAt: now })
  await db.outbox.put({ table: 'images', id: newId, deleted: 0, updatedAt: now })
  if (img.blob) await db.blob_outbox.put({ id: newId })
  return newId
}

/**
 * Rozlacza CALY model: kazdy czlonek dostaje KOPIE tozsamosci, KOPIE obrazow
 * (klon bloba -> nowy ImageRecord) i kopie opisow; nastepnie model i jego
 * wspoldzielone obrazy sa usuwane. Bezstratne (poza obrazami tylko w R2).
 */
export async function dissolveDesign(designId: string): Promise<void> {
  const now = Date.now()
  await db.transaction(
    'rw', [db.products, db.designs, db.images, db.outbox, db.blob_outbox],
    async () => {
      const design = await db.designs.get(designId)
      if (!design) return
      const members = await db.products.where('designId').equals(designId).toArray()
      for (const m of members) {
        const photoIds: string[] = []
        for (const imgId of design.photoIds) {
          const nid = await cloneImageRow(imgId, m.id, now)
          if (nid) photoIds.push(nid)
        }
        const generatedPhotoIds: string[] = []
        for (const imgId of design.generatedPhotoIds) {
          const nid = await cloneImageRow(imgId, m.id, now)
          if (nid) generatedPhotoIds.push(nid)
        }
        const next: Product = {
          ...m,
          designId: undefined,
          name: design.name,
          brand: design.brand,
          color: design.color,
          material: design.material,
          category: design.category,
          tags: [...design.tags],
          photoIds,
          generatedPhotoIds,
          // Zdjęcia są klonowane z nowymi id — ewentualna stara okładka byłaby wisząca.
          coverImageId: undefined,
          descriptions: design.descriptions.map((d) => ({ ...d })),
          updatedAt: now,
        }
        await db.products.put(next)
        await db.outbox.put({ table: 'products', id: m.id, deleted: 0, updatedAt: now })
      }
      for (const imgId of [...design.photoIds, ...design.generatedPhotoIds]) {
        await db.images.delete(imgId)
        await db.outbox.put({ table: 'images', id: imgId, deleted: 1, updatedAt: now })
        await db.blob_outbox.delete(imgId)
      }
      await db.designs.delete(designId)
      await db.outbox.put({ table: 'designs', id: designId, deleted: 1, updatedAt: now })
    },
  )
}

/** Kaskadowe usuniecie modelu: model + wspoldzielone obrazy + WSZYSCY czlonkowie. */
export async function deleteDesignCascade(designId: string): Promise<void> {
  const now = Date.now()
  await db.transaction(
    'rw', [db.products, db.designs, db.images, db.outbox, db.blob_outbox],
    async () => {
      const design = await db.designs.get(designId)
      if (!design) return
      for (const imgId of [...design.photoIds, ...design.generatedPhotoIds]) {
        await db.images.delete(imgId)
        await db.outbox.put({ table: 'images', id: imgId, deleted: 1, updatedAt: now })
        await db.blob_outbox.delete(imgId)
      }
      const members = await db.products.where('designId').equals(designId).toArray()
      for (const m of members) {
        await db.products.delete(m.id)
        await db.outbox.put({ table: 'products', id: m.id, deleted: 1, updatedAt: now })
      }
      await db.designs.delete(designId)
      await db.outbox.put({ table: 'designs', id: designId, deleted: 1, updatedAt: now })
    },
  )
}

/** Dodaje nowy, pusty rozmiar do modelu (odgornie). Pola per-size z `seed`. */
export async function addSizeToDesign(
  designId: string,
  seed: Partial<Product> = {},
): Promise<Product> {
  const now = Date.now()
  const product: Product = {
    id: uid(),
    designId,
    name: '',
    condition: seed.condition ?? 'dobry',
    currency: seed.currency ?? 'PLN',
    quantity: seed.quantity ?? 1,
    status: 'draft',
    photoIds: [],
    generatedPhotoIds: [],
    descriptions: [],
    tags: [],
    sizeLabel: seed.sizeLabel,
    accountId: seed.accountId,
    listingPrice: seed.listingPrice,
    purchasePrice: seed.purchasePrice,
    measurements: seed.measurements,
    createdAt: now,
    updatedAt: now,
  }
  return putEntity('products', product)
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}
