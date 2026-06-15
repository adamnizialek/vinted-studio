import { beforeEach, describe, it, expect } from 'vitest'
import { db, putEntity } from '@/db/db'
import { requiresSaleModal, applyStatusChange, assignAccount, shouldRestockOnSave, restockOnRefund } from './productActions'
import type { Product } from '@/db/types'

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

describe('applyStatusChange', () => {
  it('patches status, bumps updatedAt, queues outbox, and never writes soldAt/listedAt', async () => {
    await putEntity('products', sampleProduct())
    await db.outbox.clear()
    await applyStatusChange('p1', 'listed')
    const row = await db.products.get('p1')
    expect(row?.status).toBe('listed')
    expect(row?.soldAt).toBeUndefined()
    expect(row?.listedAt).toBeUndefined()
    expect(row!.updatedAt).toBeGreaterThan(1)
    expect((await db.outbox.get(['products', 'p1']))?.deleted).toBe(0)
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
