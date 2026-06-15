import { beforeEach, describe, it, expect } from 'vitest'
import { db, putEntity, exportAll, importAll, clearAllData, groupProducts } from './db'
import type { Design, Product } from './types'

const sampleProduct = (id: string, over: Partial<Product> = {}): Product => ({
  id, name: 'X', condition: 'dobry', currency: 'PLN', quantity: 1, status: 'in_stock',
  photoIds: [], generatedPhotoIds: [], descriptions: [], tags: [], createdAt: 1, updatedAt: 1,
  ...over,
})

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

describe('groupProducts', () => {
  it('creates a design, moves shared content, clears members, queues outbox', async () => {
    await db.images.bulkPut([
      { id: 'i1', mime: 'image/jpeg', width: 1, height: 1, thumb: 't', kind: 'product', createdAt: 1, updatedAt: 1 },
      { id: 'i2', mime: 'image/jpeg', width: 1, height: 1, thumb: 't', kind: 'product', createdAt: 1, updatedAt: 1 },
    ])
    await db.products.bulkPut([
      sampleProduct('pS', { name: 'Kurtka NYC', brand: 'NF', sizeLabel: 'S', photoIds: ['i1'],
        tags: ['a'], descriptions: [{ id: 'dx', styleId: 's', styleLabel: 'S', text: 't', active: true, createdAt: 1 }] }),
      sampleProduct('pM', { name: 'Kurtka NYC', brand: 'NF', sizeLabel: 'M', photoIds: ['i2'], tags: ['b'] }),
    ])
    await db.outbox.clear()

    const design = await groupProducts(['pS', 'pM'], 'pS')

    expect(design.name).toBe('Kurtka NYC')
    expect(design.photoIds).toEqual(['i1', 'i2'])
    expect(design.tags.sort()).toEqual(['a', 'b'])
    expect(design.descriptions.filter((d) => d.active)).toHaveLength(1)

    const pM = await db.products.get('pM')
    expect(pM?.designId).toBe(design.id)
    expect(pM?.name).toBe('')
    expect(pM?.photoIds).toEqual([])
    expect(pM?.sizeLabel).toBe('M')

    expect((await db.images.get('i1'))?.designId).toBe(design.id)
    expect((await db.images.get('i1'))?.productId).toBeUndefined()

    expect((await db.outbox.get(['designs', design.id]))?.deleted).toBe(0)
    expect(await db.outbox.get(['products', 'pM'])).toBeTruthy()
    expect(await db.outbox.get(['images', 'i1'])).toBeTruthy()
  })

  it('rejects fewer than two products', async () => {
    await expect(groupProducts(['pS'], 'pS')).rejects.toThrow()
  })

  it('activates the first merged description when the primary has none', async () => {
    await db.products.bulkPut([
      sampleProduct('pA', { name: 'NYC', descriptions: [
        { id: 'da', styleId: 's', styleLabel: 'S', text: 'a', active: false, createdAt: 1 }] }),
      sampleProduct('pB', { name: 'NYC', descriptions: [
        { id: 'db', styleId: 's', styleLabel: 'S', text: 'b', active: false, createdAt: 1 }] }),
    ])
    const design = await groupProducts(['pA', 'pB'], 'pA')
    const active = design.descriptions.filter((d) => d.active)
    expect(active).toHaveLength(1)
    expect(active[0].id).toBe('da') // first merged (primary first)
  })

  it('throws when fewer than two standalone products survive (others already grouped)', async () => {
    await db.designs.put(sampleDesign('dX'))
    await db.products.bulkPut([
      sampleProduct('pStand', { designId: undefined }),
      sampleProduct('pGrouped', { designId: 'dX' }),
    ])
    await expect(groupProducts(['pStand', 'pGrouped'], 'pStand')).rejects.toThrow()
  })

  it('deduplicates repeated ids in the input', async () => {
    await db.products.bulkPut([
      sampleProduct('p1', { name: 'NYC' }),
      sampleProduct('p2', { name: 'NYC' }),
    ])
    // duplicate 'p1' must not break the merge or double-write
    const design = await groupProducts(['p1', 'p1', 'p2'], 'p1')
    const members = await db.products.where('designId').equals(design.id).toArray()
    expect(members.map((m) => m.id).sort()).toEqual(['p1', 'p2'])
  })
})
