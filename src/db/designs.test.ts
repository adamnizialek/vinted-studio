import { beforeEach, describe, it, expect } from 'vitest'
import { db, putEntity, exportAll, importAll, clearAllData, groupProducts, attachProductsToDesign, addSizeToDesign, dissolveDesign, deleteDesignCascade, deleteProductCascade } from './db'
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

describe('attachProductsToDesign', () => {
  it('attaches standalone products to an existing model and merges shared content', async () => {
    await db.images.bulkPut([
      { id: 'shared', mime: 'image/jpeg', width: 1, height: 1, thumb: 't', kind: 'product', designId: 'd1', createdAt: 1, updatedAt: 1 },
      { id: 'inew', mime: 'image/jpeg', width: 1, height: 1, thumb: 't', kind: 'product', productId: 'pNew', createdAt: 1, updatedAt: 1 },
    ])
    await db.designs.put({ ...sampleDesign(), brand: 'NF', tags: ['x'], photoIds: ['shared'],
      descriptions: [{ id: 'dShared', styleId: 's', styleLabel: 'S', text: 't', active: true, createdAt: 1 }] })
    await db.products.bulkPut([
      sampleProduct('pS', { designId: 'd1', name: '', sizeLabel: 'S' }),
      sampleProduct('pNew', { name: 'Kurtka NYC', brand: 'NF', sizeLabel: 'L', listingPrice: 80,
        photoIds: ['inew'], coverImageId: 'inew', tags: ['y'],
        descriptions: [{ id: 'dNew', styleId: 's', styleLabel: 'S', text: 'n', active: true, createdAt: 1 }] }),
    ])
    await db.outbox.clear()

    const updated = await attachProductsToDesign('d1', ['pNew'])

    // Shared content merged (design's first, then incoming; dedup by id).
    expect(updated.photoIds).toEqual(['shared', 'inew'])
    expect(updated.tags.sort()).toEqual(['x', 'y'])
    expect(updated.descriptions.map((d) => d.id)).toEqual(['dShared', 'dNew'])
    // The model's active description is preserved; the incoming one is demoted.
    expect(updated.descriptions.filter((d) => d.active).map((d) => d.id)).toEqual(['dShared'])

    // The attached product becomes a size variant: designId set, shared fields cleared,
    // per-size fields (size, price) kept, cover cleared.
    const pNew = await db.products.get('pNew')
    expect(pNew?.designId).toBe('d1')
    expect(pNew?.name).toBe('')
    expect(pNew?.photoIds).toEqual([])
    expect(pNew?.coverImageId).toBeUndefined()
    expect(pNew?.sizeLabel).toBe('L')
    expect(pNew?.listingPrice).toBe(80)

    // Its image is re-parented to the model.
    expect((await db.images.get('inew'))?.designId).toBe('d1')
    expect((await db.images.get('inew'))?.productId).toBeUndefined()

    // Outbox entries for design, product and re-parented image.
    expect((await db.outbox.get(['designs', 'd1']))?.deleted).toBe(0)
    expect(await db.outbox.get(['products', 'pNew'])).toBeTruthy()
    expect(await db.outbox.get(['images', 'inew'])).toBeTruthy()
    // Pre-existing member untouched (still belongs to the model).
    expect((await db.products.get('pS'))?.designId).toBe('d1')
  })

  it('skips products already in a model and throws when none remain standalone', async () => {
    await db.designs.put(sampleDesign('d1'))
    await db.designs.put(sampleDesign('dOther'))
    await db.products.put(sampleProduct('pOther', { designId: 'dOther', name: '' }))
    await expect(attachProductsToDesign('d1', ['pOther'])).rejects.toThrow()
    // Untouched: still belongs to its original model.
    expect((await db.products.get('pOther'))?.designId).toBe('dOther')
  })

  it('attaches only the standalone products when the selection is mixed', async () => {
    await db.designs.put(sampleDesign('d1'))
    await db.designs.put(sampleDesign('dOther'))
    await db.products.bulkPut([
      sampleProduct('pStand', { name: 'NYC', sizeLabel: 'M' }),
      sampleProduct('pGrouped', { designId: 'dOther', name: '' }),
    ])
    await attachProductsToDesign('d1', ['pStand', 'pGrouped'])
    expect((await db.products.get('pStand'))?.designId).toBe('d1')
    expect((await db.products.get('pGrouped'))?.designId).toBe('dOther') // unchanged
  })

  it('throws when the target model does not exist', async () => {
    await db.products.put(sampleProduct('pStand', { name: 'NYC' }))
    await expect(attachProductsToDesign('missing', ['pStand'])).rejects.toThrow()
  })

  it('activates the first description when the model had none active', async () => {
    await db.designs.put({ ...sampleDesign(), descriptions: [] })
    await db.products.put(sampleProduct('pNew', { name: 'NYC',
      descriptions: [{ id: 'dN', styleId: 's', styleLabel: 'S', text: 'n', active: false, createdAt: 1 }] }))
    const updated = await attachProductsToDesign('d1', ['pNew'])
    expect(updated.descriptions.filter((d) => d.active).map((d) => d.id)).toEqual(['dN'])
  })
})

describe('addSizeToDesign', () => {
  it('creates a draft product linked to the design with per-size seed', async () => {
    await putEntity('designs', sampleDesign())
    await db.outbox.clear()
    const p = await addSizeToDesign('d1', { sizeLabel: 'L', listingPrice: 95 })
    const row = await db.products.get(p.id)
    expect(row?.designId).toBe('d1')
    expect(row?.status).toBe('draft')
    expect(row?.sizeLabel).toBe('L')
    expect(row?.listingPrice).toBe(95)
    expect(row?.name).toBe('')
    // Towar przychodzi nowy — nowy rozmiar startuje jako „Nowy bez metki”.
    expect(row?.condition).toBe('nowy_bez_metki')
    expect((await db.outbox.get(['products', p.id]))?.deleted).toBe(0)
  })

  it('puts a new size of a listed model straight into its listing', async () => {
    await putEntity('designs', { ...sampleDesign(), listings: [{ accountId: 'acc1', since: 123 }] })
    const p = await addSizeToDesign('d1', { sizeLabel: 'L' })
    expect(await db.products.get(p.id)).toMatchObject({ status: 'listed', listedAt: 123, accountId: 'acc1' })
  })
})

describe('listings when grouping and attaching', () => {
  const listed = (id: string, accountId: string, listedAt: number): Product => ({
    id, name: id, condition: 'dobry', currency: 'PLN', quantity: 1, status: 'listed', accountId,
    listedAt, photoIds: [], generatedPhotoIds: [], descriptions: [], tags: [], createdAt: 1, updatedAt: 1,
  })

  it('grouping listed items keeps them listed and gives the model their listings', async () => {
    await putEntity('products', listed('x1', 'acc1', 100))
    await putEntity('products', listed('x2', 'acc1', 50))
    const d = await groupProducts(['x1', 'x2'], 'x1')
    expect(d.listings).toEqual([{ accountId: 'acc1', since: 50, size: '' }])
    expect(await db.products.get('x1')).toMatchObject({ status: 'listed', accountId: 'acc1', listedAt: 50 })
  })

  it('attaching a listed item to an unmarked model keeps it listed and lists the model', async () => {
    await putEntity('designs', sampleDesign())
    await putEntity('products', {
      ...listed('m1', 'acc1', 1), status: 'in_stock', accountId: undefined, listedAt: undefined,
      designId: 'd1', name: '',
    })
    await putEntity('products', listed('x1', 'acc2', 70))
    const d = await attachProductsToDesign('d1', ['x1'])
    expect(d.listings).toEqual([{ accountId: 'acc2', since: 70, size: '' }])
    expect(await db.products.get('x1')).toMatchObject({ status: 'listed', accountId: 'acc2', listedAt: 70 })
    expect(await db.products.get('m1')).toMatchObject({ status: 'listed', accountId: 'acc2', listedAt: 70 })
  })

  it('attaching an in-stock item to an unmarked model changes nothing about listings', async () => {
    await putEntity('designs', sampleDesign())
    await putEntity('products', {
      ...listed('x1', 'acc2', 70), status: 'in_stock', accountId: undefined, listedAt: undefined,
    })
    const d = await attachProductsToDesign('d1', ['x1'])
    expect(d.listings).toBeUndefined()
    expect(await db.products.get('x1')).toMatchObject({ status: 'in_stock' })
  })
})

describe('dissolveDesign', () => {
  it('clones shared content to each member and deletes the design', async () => {
    await db.images.put({ id: 'i1', blob: new Blob(['x']), mime: 'image/jpeg', width: 1, height: 1, thumb: 't', kind: 'product', designId: 'd1', createdAt: 1, updatedAt: 1 })
    await db.designs.put({ ...sampleDesign(), brand: 'NF', photoIds: ['i1'],
      descriptions: [{ id: 'dx', styleId: 's', styleLabel: 'S', text: 't', active: true, createdAt: 1 }] })
    await db.products.bulkPut([
      sampleProduct('pS', { designId: 'd1', name: '', sizeLabel: 'S' }),
      sampleProduct('pM', { designId: 'd1', name: '', sizeLabel: 'M' }),
    ])
    await db.outbox.clear()

    await dissolveDesign('d1')

    expect(await db.designs.get('d1')).toBeUndefined()
    expect(await db.images.get('i1')).toBeUndefined()
    const pS = await db.products.get('pS')
    expect(pS?.designId).toBeUndefined()
    expect(pS?.name).toBe('Kurtka NYC')
    expect(pS?.brand).toBe('NF')
    expect(pS?.photoIds).toHaveLength(1)
    expect(pS?.photoIds[0]).not.toBe('i1')
    expect(pS?.descriptions).toHaveLength(1)
    const pM = await db.products.get('pM')
    expect(pM?.photoIds[0]).not.toBe(pS?.photoIds[0])
    expect(await db.blob_outbox.get(pS!.photoIds[0])).toBeTruthy()
    expect((await db.outbox.get(['images', 'i1']))?.deleted).toBe(1)
  })
})

describe('coverImageId lifecycle through group/dissolve', () => {
  it('clears a per-product cover on grouping (cover is standalone-only)', async () => {
    await db.images.bulkPut([
      { id: 'i1', mime: 'image/jpeg', width: 1, height: 1, thumb: 't', kind: 'product', createdAt: 1, updatedAt: 1 },
      { id: 'i2', mime: 'image/jpeg', width: 1, height: 1, thumb: 't', kind: 'product', createdAt: 1, updatedAt: 1 },
    ])
    await db.products.bulkPut([
      sampleProduct('pS', { name: 'Kurtka', sizeLabel: 'S', photoIds: ['i1'], coverImageId: 'i1' }),
      sampleProduct('pM', { name: 'Kurtka', sizeLabel: 'M', photoIds: ['i2'] }),
    ])
    await groupProducts(['pS', 'pM'], 'pS')
    expect((await db.products.get('pS'))?.coverImageId).toBeUndefined()
  })

  it('does not leave a dangling cover after group then dissolve', async () => {
    await db.images.bulkPut([
      { id: 'i1', mime: 'image/jpeg', width: 1, height: 1, thumb: 't', kind: 'product', createdAt: 1, updatedAt: 1 },
      { id: 'i2', mime: 'image/jpeg', width: 1, height: 1, thumb: 't', kind: 'product', createdAt: 1, updatedAt: 1 },
    ])
    await db.products.bulkPut([
      sampleProduct('pS', { name: 'Kurtka', sizeLabel: 'S', photoIds: ['i1'], coverImageId: 'i1' }),
      sampleProduct('pM', { name: 'Kurtka', sizeLabel: 'M', photoIds: ['i2'] }),
    ])
    const design = await groupProducts(['pS', 'pM'], 'pS')
    await dissolveDesign(design.id)
    const pS = await db.products.get('pS')
    // cover must be empty (so coverImageIdOf falls back to a real, freshly-cloned photo)
    expect(pS?.coverImageId).toBeUndefined()
    expect(await db.images.get('i1')).toBeUndefined() // original shared image gone
  })

  it('clears a stale cover on dissolve even for legacy grouped rows (independent of group)', async () => {
    // Simulate a grouped member written by pre-fix code: carries a coverImageId
    // that points at the now-shared image. dissolveDesign must still clear it.
    await db.images.put({ id: 'shared', blob: new Blob(['x']), mime: 'image/jpeg', width: 1, height: 1, thumb: 't', kind: 'product', designId: 'd1', createdAt: 1, updatedAt: 1 })
    await db.designs.put({ ...sampleDesign(), photoIds: ['shared'] })
    await db.products.put(sampleProduct('pS', { designId: 'd1', name: '', sizeLabel: 'S', coverImageId: 'shared' }))

    await dissolveDesign('d1')

    const pS = await db.products.get('pS')
    expect(pS?.coverImageId).toBeUndefined()
    expect(pS?.photoIds[0]).not.toBe('shared') // points at a freshly cloned photo
  })
})

describe('Dexie v4 schema (additive upgrade)', () => {
  it('keeps pre-existing products (without designId) fully usable', async () => {
    // A product created before the feature has no designId — must still read/write/query.
    await db.products.put(sampleProduct('legacy', { name: 'Stary produkt', sizeLabel: 'M' }))
    const row = await db.products.get('legacy')
    expect(row?.name).toBe('Stary produkt')
    expect(row?.designId).toBeUndefined()
    // The new designId index must not break a normal status query on legacy rows.
    const inStock = await db.products.where('status').equals('in_stock').toArray()
    expect(inStock.map((p) => p.id)).toContain('legacy')
  })
})

describe('deleteDesignCascade', () => {
  it('removes the design, its shared images, and all members', async () => {
    await db.images.put({ id: 'i1', mime: 'image/jpeg', width: 1, height: 1, thumb: 't', kind: 'product', designId: 'd1', createdAt: 1, updatedAt: 1 })
    await db.designs.put({ ...sampleDesign(), photoIds: ['i1'] })
    await db.products.put(sampleProduct('pS', { designId: 'd1' }))
    await db.outbox.clear()
    await deleteDesignCascade('d1')
    expect(await db.designs.get('d1')).toBeUndefined()
    expect(await db.images.get('i1')).toBeUndefined()
    expect(await db.products.get('pS')).toBeUndefined()
    expect((await db.outbox.get(['designs', 'd1']))?.deleted).toBe(1)
    expect((await db.outbox.get(['products', 'pS']))?.deleted).toBe(1)
  })
})

describe('deleteProductCascade on grouped members', () => {
  it('deletes only the member while siblings remain', async () => {
    await db.designs.put(sampleDesign())
    await db.products.bulkPut([
      sampleProduct('pS', { designId: 'd1' }),
      sampleProduct('pM', { designId: 'd1' }),
    ])
    await deleteProductCascade('pS')
    expect(await db.products.get('pS')).toBeUndefined()
    expect(await db.products.get('pM')).toBeTruthy()
    expect(await db.designs.get('d1')).toBeTruthy()
  })

  it('removes the design too when the last member goes', async () => {
    await db.designs.put(sampleDesign())
    await db.products.put(sampleProduct('pS', { designId: 'd1' }))
    await deleteProductCascade('pS')
    expect(await db.products.get('pS')).toBeUndefined()
    expect(await db.designs.get('d1')).toBeUndefined()
  })
})
