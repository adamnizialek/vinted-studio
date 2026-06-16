import { describe, it, expect } from 'vitest'
import Dexie from 'dexie'

const DB_NAME = 'vinted-studio'

// v4 schema exactly as the real module produces it (so opening the real db only
// triggers the additive v5 upgrade, not a spurious index migration).
const V4_STORES = {
  products: 'id, status, accountId, brand, category, createdAt, updatedAt, soldAt, designId, *tags',
  designs: 'id, createdAt, updatedAt',
  models: 'id, createdAt, updatedAt',
  accounts: 'id, createdAt',
  sales: 'id, accountId, productId, soldAt, status, createdAt',
  expenses: 'id, accountId, incurredAt, createdAt',
  images: 'id, kind, productId, modelId, createdAt',
  settings: 'id',
  outbox: '[table+id], table',
  sync_meta: 'key',
  blob_outbox: 'id',
}

const product = (over: Record<string, unknown>) => ({
  name: 'P',
  condition: 'dobry',
  currency: 'PLN',
  quantity: 1,
  photoIds: [],
  generatedPhotoIds: [],
  descriptions: [],
  tags: [],
  createdAt: 1,
  ...over,
})

describe('Dexie v4 -> v5 upgrade (listedAt backfill)', () => {
  it('backfills listedAt for listed products lacking it, preserving everything else', async () => {
    const seed = new Dexie(DB_NAME)
    seed.version(4).stores(V4_STORES)
    await seed.open()
    await seed.table('products').bulkPut([
      product({ id: 'listed-noStamp', status: 'listed', updatedAt: 5000 }),
      product({ id: 'listed-hasStamp', status: 'listed', updatedAt: 9999, listedAt: 42 }),
      product({ id: 'in-stock', status: 'in_stock', updatedAt: 7000 }),
      product({ id: 'listed-noUpdatedAt', status: 'listed', createdAt: 333, updatedAt: undefined }),
    ])
    seed.close()

    const { db } = await import('@/db/db')
    await db.open()

    // listed without a stamp -> approximated from updatedAt, flagged approximate
    const noStamp = await db.products.get('listed-noStamp')
    expect(noStamp?.listedAt).toBe(5000)
    expect(noStamp?.listedAtApprox).toBe(true)
    // listed with an existing stamp -> untouched, NOT flagged approximate
    const hasStamp = await db.products.get('listed-hasStamp')
    expect(hasStamp?.listedAt).toBe(42)
    expect(hasStamp?.listedAtApprox).toBeUndefined()
    // not listed -> never stamped
    expect((await db.products.get('in-stock'))?.listedAt).toBeUndefined()
    // listed but missing updatedAt -> falls back to createdAt, flagged approximate
    expect((await db.products.get('listed-noUpdatedAt'))?.listedAt).toBe(333)
    expect((await db.products.get('listed-noUpdatedAt'))?.listedAtApprox).toBe(true)
    // no data loss
    expect((await db.products.get('in-stock'))?.status).toBe('in_stock')
  })
})
