import { beforeEach, describe, it, expect } from 'vitest'
import { db, putEntity } from '@/db/db'
import { requiresSaleModal, applyStatusChange, assignAccount, shouldRestockOnSave, restockOnRefund, deleteSaleAndRestock, listedAtOnTransition, statusChangePatch } from './productActions'
import type { Product, Sale } from '@/db/types'

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
  await Promise.all([db.products.clear(), db.outbox.clear()])
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
