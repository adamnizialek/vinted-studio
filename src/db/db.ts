import Dexie, { type Table } from 'dexie'
import type {
  Account,
  AiModel,
  AppSettings,
  ImageRecord,
  Product,
  Sale,
} from './types'
import { DEFAULT_IMAGE_MODEL, DEFAULT_TEXT_MODEL } from '@/lib/constants'
import { type SyncTable } from '@/sync/core'

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

export class VintedStudioDB extends Dexie {
  products!: Table<Product, string>
  models!: Table<AiModel, string>
  accounts!: Table<Account, string>
  sales!: Table<Sale, string>
  images!: Table<ImageRecord, string>
  settings!: Table<AppSettings, string>
  outbox!: Table<OutboxEntry, [SyncTable, string]>
  sync_meta!: Table<SyncMeta, string>

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
  }
}

export const db = new VintedStudioDB()

export const SCHEMA_VERSION = 2

export const DEFAULT_SETTINGS: AppSettings = {
  id: 'app',
  geminiApiKey: '',
  textModel: DEFAULT_TEXT_MODEL,
  imageModel: DEFAULT_IMAGE_MODEL,
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
  models: AiModel
  accounts: Account
  sales: Sale
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

/** Odczyt ustawien z domyslnymi wartosciami (uzupelnia brakujace pola). */
export async function getSettings(): Promise<AppSettings> {
  const row = await db.settings.get('app')
  return { ...DEFAULT_SETTINGS, ...(row ?? {}), id: 'app' }
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
  const [products, models, accounts, sales, settings, images] = await Promise.all([
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
      dataUrl: img.blob ? await blobToDataUrl(img.blob) : null,
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
  const models = (data.models ?? []).map(withUpdatedAt)
  const accounts = (data.accounts ?? []).map(withUpdatedAt)
  const sales = (data.sales ?? []).map(withUpdatedAt)

  await db.transaction(
    'rw',
    [db.products, db.models, db.accounts, db.sales, db.images, db.settings, db.outbox],
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
    [db.products, db.models, db.accounts, db.sales, db.images, db.outbox],
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
      await tombstoneAll('models', db.models as Table<{ id: string }, string>)
      await tombstoneAll('accounts', db.accounts as Table<{ id: string }, string>)
      await tombstoneAll('sales', db.sales as Table<{ id: string }, string>)
      await tombstoneAll('images', db.images as Table<{ id: string }, string>)
    },
  )
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}
