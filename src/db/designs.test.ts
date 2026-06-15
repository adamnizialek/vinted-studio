import { beforeEach, describe, it, expect } from 'vitest'
import { db, putEntity, exportAll, importAll, clearAllData } from './db'
import type { Design } from './types'

async function clearAll() {
  await Promise.all([
    db.products.clear(), db.designs.clear(), db.models.clear(),
    db.accounts.clear(), db.sales.clear(), db.expenses.clear(),
    db.images.clear(), db.settings.clear(), db.outbox.clear(),
    db.sync_meta.clear(), db.blob_outbox.clear(),
  ])
}
beforeEach(clearAll)

const sampleDesign = (id = 'd1'): Design => ({
  id, name: 'Kurtka NYC', tags: [], photoIds: [], generatedPhotoIds: [],
  descriptions: [], createdAt: 1, updatedAt: 1,
})

describe('designs table', () => {
  it('persists a design and queues an outbox entry', async () => {
    await putEntity('designs', sampleDesign())
    expect((await db.designs.get('d1'))?.name).toBe('Kurtka NYC')
    expect((await db.outbox.get(['designs', 'd1']))?.deleted).toBe(0)
  })

  it('can query products by designId index', async () => {
    await db.products.bulkPut([
      { id: 'p1', designId: 'd1', name: '', condition: 'dobry', currency: 'PLN', quantity: 1,
        status: 'in_stock', photoIds: [], generatedPhotoIds: [], descriptions: [], tags: [],
        createdAt: 1, updatedAt: 1 },
      { id: 'p2', name: 'solo', condition: 'dobry', currency: 'PLN', quantity: 1,
        status: 'in_stock', photoIds: [], generatedPhotoIds: [], descriptions: [], tags: [],
        createdAt: 1, updatedAt: 1 },
    ])
    const grouped = await db.products.where('designId').equals('d1').toArray()
    expect(grouped.map((p) => p.id)).toEqual(['p1'])
  })
})

describe('designs in export/import/clear', () => {
  it('round-trips a design through exportAll/importAll', async () => {
    await putEntity('designs', sampleDesign())
    const dump = await exportAll()
    expect(dump.designs.map((d) => d.id)).toEqual(['d1'])
    await db.designs.clear()
    await importAll(dump)
    expect((await db.designs.get('d1'))?.name).toBe('Kurtka NYC')
  })

  it('clearAllData tombstones designs', async () => {
    await putEntity('designs', sampleDesign())
    await db.outbox.clear()
    await clearAllData()
    expect(await db.designs.get('d1')).toBeUndefined()
    expect((await db.outbox.get(['designs', 'd1']))?.deleted).toBe(1)
  })
})
