import { beforeEach, describe, it, expect } from 'vitest'
import { db, putEntity } from '@/db/db'
import { requiresSaleModal, applyStatusChange, assignAccount, listProductOn, unlistProduct, setDesignListings, toggleDesignListing, shouldRestockOnSave, restockOnRefund, deleteSaleAndRestock, listedAtOnTransition, statusChangePatch } from './productActions'
import type { Design, Product, Sale } from '@/db/types'

const sampleProduct = (id = 'p1'): Product => ({
  id,
  name: 'P',
  condition: 'dobry',
  currency: 'PLN',
  quantity: 1,
  status: 'in_stock',
  accountId: 'a1',
  photoIds: [],
  generatedPhotoIds: [],
  descriptions: [],
  tags: [],
  createdAt: 1,
  updatedAt: 1,
})

beforeEach(async () => {
  await Promise.all([db.products.clear(), db.designs.clear(), db.outbox.clear()])
})

describe('requiresSaleModal', () => {
  it('is true only for sold', () => {
    expect(requiresSaleModal('sold')).toBe(true)
    for (const s of ['draft', 'in_stock', 'listed', 'reserved', 'archived'] as const)
      expect(requiresSaleModal(s)).toBe(false)
  })
})

describe('listedAtOnTransition', () => {
  it('stamps now when entering listed from a non-listed status', () => {
    expect(listedAtOnTransition('in_stock', 'listed', 1234)).toBe(1234)
    expect(listedAtOnTransition('draft', 'listed', 1234)).toBe(1234)
    expect(listedAtOnTransition('reserved', 'listed', 1234)).toBe(1234)
  })
  it('returns null when already listed (no re-stamp on a non-transition)', () => {
    expect(listedAtOnTransition('listed', 'listed', 1234)).toBe(null)
  })
  it('returns null for transitions that do not enter listed', () => {
    expect(listedAtOnTransition('listed', 'sold', 1234)).toBe(null)
    expect(listedAtOnTransition('in_stock', 'sold', 1234)).toBe(null)
    expect(listedAtOnTransition('in_stock', 'reserved', 1234)).toBe(null)
  })
})

describe('statusChangePatch', () => {
  it('stamps an exact listedAt and clears the approximate flag when entering listed', () => {
    expect(statusChangePatch('in_stock', 'listed', 1234)).toEqual({
      status: 'listed',
      listedAt: 1234,
      listedAtApprox: undefined,
    })
  })
  it('only sets status for transitions that do not enter listed', () => {
    expect(statusChangePatch('in_stock', 'reserved', 1234)).toEqual({ status: 'reserved' })
    expect(statusChangePatch('listed', 'listed', 1234)).toEqual({ status: 'listed' })
  })
})

describe('applyStatusChange', () => {
  it('stamps listedAt when transitioning into listed, bumps updatedAt, queues outbox', async () => {
    await putEntity('products', sampleProduct())
    await db.outbox.clear()
    await applyStatusChange('p1', 'listed')
    const row = await db.products.get('p1')
    expect(row?.status).toBe('listed')
    expect(row?.listedAt).toBeGreaterThan(1)
    expect(row?.soldAt).toBeUndefined()
    expect(row!.updatedAt).toBeGreaterThan(1)
    expect((await db.outbox.get(['products', 'p1']))?.deleted).toBe(0)
  })

  it('does not write listedAt for a non-listed transition', async () => {
    await putEntity('products', sampleProduct())
    await applyStatusChange('p1', 'reserved')
    const row = await db.products.get('p1')
    expect(row?.status).toBe('reserved')
    expect(row?.listedAt).toBeUndefined()
    expect(row?.soldAt).toBeUndefined()
  })

  it('preserves an existing listedAt when re-applying listed (no re-stamp)', async () => {
    await putEntity('products', { ...sampleProduct(), status: 'listed', listedAt: 42 })
    await applyStatusChange('p1', 'listed')
    expect((await db.products.get('p1'))?.listedAt).toBe(42)
  })

  it('clears the approximate flag when stamping a fresh (exact) listedAt', async () => {
    await putEntity('products', { ...sampleProduct(), status: 'in_stock', listedAtApprox: true })
    await applyStatusChange('p1', 'listed')
    const row = await db.products.get('p1')
    expect(row?.listedAt).toBeGreaterThan(1)
    expect(row?.listedAtApprox).toBeUndefined()
  })

  it('is a no-op when the product does not exist', async () => {
    await applyStatusChange('missing', 'listed')
    expect(await db.products.get('missing')).toBeUndefined()
  })
})

describe('assignAccount', () => {
  it('sets a new accountId', async () => {
    await putEntity('products', sampleProduct())
    await assignAccount('p1', 'a2')
    expect((await db.products.get('p1'))?.accountId).toBe('a2')
  })
  it('clears accountId when passed undefined', async () => {
    await putEntity('products', sampleProduct())
    await assignAccount('p1', undefined)
    expect((await db.products.get('p1'))?.accountId).toBeUndefined()
  })
})

describe('shouldRestockOnSave', () => {
  it('is true when transitioning into returned with a linked product', () => {
    expect(shouldRestockOnSave('completed', 'returned', true)).toBe(true)
    expect(shouldRestockOnSave('pending', 'returned', true)).toBe(true)
    expect(shouldRestockOnSave('cancelled', 'returned', true)).toBe(true)
  })
  it('is false without a linked product', () => {
    expect(shouldRestockOnSave('completed', 'returned', false)).toBe(false)
  })
  it('is false when the new status is not returned', () => {
    expect(shouldRestockOnSave('completed', 'cancelled', true)).toBe(false)
    expect(shouldRestockOnSave('completed', 'completed', true)).toBe(false)
  })
  it('is false when already returned (not a transition)', () => {
    expect(shouldRestockOnSave('returned', 'returned', true)).toBe(false)
  })
})

describe('restockOnRefund', () => {
  it('moves a sold product back to in_stock, bumps updatedAt, queues outbox, returns true', async () => {
    await putEntity('products', { ...sampleProduct(), status: 'sold' })
    await db.outbox.clear()
    const did = await restockOnRefund('p1')
    expect(did).toBe(true)
    const row = await db.products.get('p1')
    expect(row?.status).toBe('in_stock')
    expect(row!.updatedAt).toBeGreaterThan(1)
    expect((await db.outbox.get(['products', 'p1']))?.deleted).toBe(0)
  })
  it('is a no-op returning false when the product is not sold', async () => {
    await putEntity('products', sampleProduct()) // status: 'in_stock'
    await db.outbox.clear()
    const did = await restockOnRefund('p1')
    expect(did).toBe(false)
    expect((await db.products.get('p1'))?.status).toBe('in_stock')
    expect(await db.outbox.count()).toBe(0) // guard prevented any write
  })
  it('is a no-op returning false when the product does not exist', async () => {
    const did = await restockOnRefund('missing')
    expect(did).toBe(false)
  })
})

describe('deleteSaleAndRestock', () => {
  const sale = (id: string, over: Partial<Sale> = {}): Sale => ({
    id,
    productId: 'p1',
    productName: 'P',
    salePrice: 10,
    currency: 'PLN',
    quantity: 1,
    status: 'completed',
    soldAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  })

  beforeEach(async () => {
    await db.sales.clear()
  })

  it('deletes the sale and moves its sold product back to in_stock', async () => {
    await putEntity('products', { ...sampleProduct(), status: 'sold' })
    await putEntity('sales', sale('s1'))
    const did = await deleteSaleAndRestock('s1')
    expect(did).toBe(true)
    expect(await db.sales.get('s1')).toBeUndefined()
    expect((await db.products.get('p1'))?.status).toBe('in_stock')
  })
  it('deletes a sale without a linked product and returns false', async () => {
    await putEntity('sales', sale('s1', { productId: undefined }))
    expect(await deleteSaleAndRestock('s1')).toBe(false)
    expect(await db.sales.get('s1')).toBeUndefined()
  })
  it('keeps the product sold when another active sale still references it', async () => {
    await putEntity('products', { ...sampleProduct(), status: 'sold' })
    await putEntity('sales', sale('s1', { status: 'returned' }))
    await putEntity('sales', sale('s2'))
    expect(await deleteSaleAndRestock('s1')).toBe(false)
    expect((await db.products.get('p1'))?.status).toBe('sold')
  })
  it('does not touch a product the user already moved elsewhere', async () => {
    await putEntity('products', { ...sampleProduct(), status: 'listed' })
    await putEntity('sales', sale('s1'))
    expect(await deleteSaleAndRestock('s1')).toBe(false)
    expect((await db.products.get('p1'))?.status).toBe('listed')
  })
})

describe('listProductOn / unlistProduct', () => {
  it('writes status, account and listing date in one go', async () => {
    await putEntity('products', { ...sampleProduct(), accountId: undefined })
    await listProductOn('p1', 'a2', 500)
    expect(await db.products.get('p1')).toMatchObject({ status: 'listed', accountId: 'a2', listedAt: 500 })
  })
  it('keeps the date when re-picking the same account, restarts it on another account', async () => {
    await putEntity('products', { ...sampleProduct(), status: 'listed', accountId: 'a1', listedAt: 100 })
    await listProductOn('p1', 'a1', 900)
    expect((await db.products.get('p1'))?.listedAt).toBe(100)
    await listProductOn('p1', 'a2', 900)
    expect(await db.products.get('p1')).toMatchObject({ accountId: 'a2', listedAt: 900 })
  })
  it('unlisting returns the item to stock without an account', async () => {
    await putEntity('products', { ...sampleProduct(), status: 'listed', accountId: 'a1', listedAt: 100 })
    await unlistProduct('p1')
    const p = await db.products.get('p1')
    expect(p).toMatchObject({ status: 'in_stock', listedAt: 100 })
    expect(p?.accountId).toBeUndefined()
  })
})

describe('setDesignListings', () => {
  const design: Design = {
    id: 'd1', name: 'Bluza', tags: [], photoIds: [], generatedPhotoIds: [], descriptions: [],
    createdAt: 1, updatedAt: 1,
  }
  it('saves the listings on the model and moves its unsold units along', async () => {
    await putEntity('designs', design)
    await putEntity('products', { ...sampleProduct('u1'), designId: 'd1', accountId: undefined })
    await putEntity('products', { ...sampleProduct('u2'), designId: 'd1', status: 'sold', soldAt: 50 })
    await setDesignListings('d1', [{ accountId: 'a1', since: 200 }])
    expect((await db.designs.get('d1'))?.listings).toEqual([{ accountId: 'a1', since: 200 }])
    expect(await db.products.get('u1')).toMatchObject({ status: 'listed', listedAt: 200, accountId: 'a1' })
    expect(await db.products.get('u2')).toMatchObject({ status: 'sold', soldAt: 50 })
    // Wszystko trafia do outboxu (synchronizacja).
    const queued = (await db.outbox.toArray()).map((o) => `${o.table}:${o.id}`)
    expect(queued).toEqual(expect.arrayContaining(['designs:d1', 'products:u1']))

    await setDesignListings('d1', [])
    expect(await db.products.get('u1')).toMatchObject({ status: 'in_stock' })
  })
})

describe('listing fixes from review', () => {
  const design: Design = {
    id: 'd1', name: 'Bluza', tags: [], photoIds: [], generatedPhotoIds: [], descriptions: [],
    createdAt: 1, updatedAt: 1,
  }

  it('adding an account to an item listed without one keeps its real date', async () => {
    await putEntity('products', { ...sampleProduct(), status: 'listed', accountId: undefined, listedAt: 100 })
    await listProductOn('p1', 'a2', 900)
    expect(await db.products.get('p1')).toMatchObject({ accountId: 'a2', listedAt: 100 })
  })

  it('first toggle on an older model keeps the dates its units already had', async () => {
    await putEntity('designs', design) // brak pola listings
    await putEntity('products', {
      ...sampleProduct('u1'), designId: 'd1', status: 'listed', accountId: 'a1', listedAt: 100,
    })
    await putEntity('products', { ...sampleProduct('u2'), designId: 'd1', accountId: undefined })
    await toggleDesignListing('d1', 'a2', 900)
    expect((await db.designs.get('d1'))?.listings).toEqual([
      { accountId: 'a1', since: 100 },
      { accountId: 'a2', since: 900 },
    ])
    for (const id of ['u1', 'u2'])
      expect(await db.products.get(id)).toMatchObject({ status: 'listed', listedAt: 100, accountId: undefined })
  })

  it('two quick toggles both land (state read inside the transaction)', async () => {
    await putEntity('designs', { ...design, listings: [] })
    await Promise.all([toggleDesignListing('d1', 'a1', 5), toggleDesignListing('d1', 'a2', 6)])
    expect((await db.designs.get('d1'))?.listings?.map((l) => l.accountId).sort()).toEqual(['a1', 'a2'])
  })
})
