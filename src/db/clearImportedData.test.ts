import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db, clearImportedData, countImportedData } from '@/db/db'

beforeEach(async () => {
  await db.sales.clear()
  await db.expenses.clear()
  await db.products.clear()
  await db.outbox.clear()
})

describe('clearImportedData', () => {
  it('removes only imported rows; keeps manual rows and photographed products', async () => {
    await db.sales.bulkPut([
      { id: 's1', productName: 'A', salePrice: 10, currency: 'PLN', quantity: 1, status: 'completed', soldAt: 0, accountId: 'acc', createdAt: 0, updatedAt: 0, importKey: 'acc|2026-01-01|a|10|' },
      { id: 's2', productName: 'B manual', salePrice: 20, currency: 'PLN', quantity: 1, status: 'completed', soldAt: 0, accountId: 'acc', createdAt: 0, updatedAt: 0 },
    ])
    await db.expenses.bulkPut([
      { id: 'e1', kind: 'boost', description: 'Podbicia', amount: 5, currency: 'PLN', incurredAt: 0, accountId: 'acc', createdAt: 0, updatedAt: 0, importKey: 'acc|2026-01-01|boost|podbicia|5' },
      { id: 'e2', kind: 'other', description: 'manual', amount: 9, currency: 'PLN', incurredAt: 0, accountId: 'acc', createdAt: 0, updatedAt: 0 },
    ])
    await db.products.bulkPut([
      // imported, no photos → removed
      { id: 'p1', name: 'Koszulka', condition: 'dobry', currency: 'PLN', quantity: 1, status: 'in_stock', accountId: 'acc', photoIds: [], generatedPhotoIds: [], descriptions: [], tags: [], createdAt: 0, updatedAt: 0, importKey: 'koszulka|35' },
      // imported, but worked on in Studio (has a photo) → kept
      { id: 'p2', name: 'Bluza', condition: 'dobry', currency: 'PLN', quantity: 1, status: 'in_stock', accountId: 'acc', photoIds: ['img1'], generatedPhotoIds: [], descriptions: [], tags: [], createdAt: 0, updatedAt: 0, importKey: 'bluza|40' },
      // hand-made Studio product (no importKey) → kept
      { id: 'p3', name: 'Studio', condition: 'dobry', currency: 'PLN', quantity: 1, status: 'draft', photoIds: ['img2'], generatedPhotoIds: ['g1'], descriptions: [], tags: [], createdAt: 0, updatedAt: 0 },
      // manual product: no importKey AND no photos → kept (isolates the importKey guard)
      { id: 'p4', name: 'Manual', condition: 'dobry', currency: 'PLN', quantity: 1, status: 'in_stock', accountId: 'acc', photoIds: [], generatedPhotoIds: [], descriptions: [], tags: [], createdAt: 0, updatedAt: 0 },
    ])

    const res = await clearImportedData()
    expect(res).toEqual({ sales: 1, expenses: 1, products: 1 })

    expect((await db.sales.toArray()).map((s) => s.id)).toEqual(['s2'])
    expect((await db.expenses.toArray()).map((e) => e.id)).toEqual(['e2'])
    expect((await db.products.toArray()).map((p) => p.id).sort()).toEqual(['p2', 'p3', 'p4'])
  })

  it('queues a tombstone in the outbox for each deleted row', async () => {
    await db.sales.put({ id: 's1', productName: 'A', salePrice: 10, currency: 'PLN', quantity: 1, status: 'completed', soldAt: 0, createdAt: 0, updatedAt: 0, importKey: 'k' })
    await clearImportedData()
    const tomb = await db.outbox.get(['sales', 's1'])
    expect(tomb).toMatchObject({ table: 'sales', id: 's1', deleted: 1 })
  })

  it('countImportedData matches what clear would remove', async () => {
    await db.sales.put({ id: 's1', productName: 'A', salePrice: 10, currency: 'PLN', quantity: 1, status: 'completed', soldAt: 0, createdAt: 0, updatedAt: 0, importKey: 'k' })
    await db.products.put({ id: 'p1', name: 'x', condition: 'dobry', currency: 'PLN', quantity: 1, status: 'in_stock', photoIds: [], generatedPhotoIds: [], descriptions: [], tags: [], createdAt: 0, updatedAt: 0, importKey: 'k2' })
    expect(await countImportedData()).toEqual({ sales: 1, expenses: 0, products: 1 })
  })
})
