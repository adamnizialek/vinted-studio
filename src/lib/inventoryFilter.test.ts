import { describe, it, expect } from 'vitest'
import { passesInventoryFilter } from './inventoryFilter'
import type { Product, ProductStatus } from '@/db/types'

const p = (over: Partial<Product> = {}): Product => ({
  id: 'p1',
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
  ...over,
})

const ALL_STATUSES: ProductStatus[] = [
  'draft', 'in_stock', 'listed', 'reserved', 'sold', 'archived',
]

describe('passesInventoryFilter — default "all" view hides sold', () => {
  it('hides a sold item under the default "all" status', () => {
    expect(passesInventoryFilter(p({ status: 'sold' }), { status: 'all', accountId: 'all' })).toBe(false)
  })

  it('shows every non-sold status under the default "all" status', () => {
    for (const s of ALL_STATUSES.filter((x) => x !== 'sold')) {
      expect(passesInventoryFilter(p({ status: s }), { status: 'all', accountId: 'all' })).toBe(true)
    }
  })
})

describe('passesInventoryFilter — explicit status filter', () => {
  it('the "Sprzedane" filter reveals sold items and hides the rest', () => {
    expect(passesInventoryFilter(p({ status: 'sold' }), { status: 'sold', accountId: 'all' })).toBe(true)
    for (const s of ALL_STATUSES.filter((x) => x !== 'sold')) {
      expect(passesInventoryFilter(p({ status: s }), { status: 'sold', accountId: 'all' })).toBe(false)
    }
  })

  it('a specific non-sold status matches only that status', () => {
    expect(passesInventoryFilter(p({ status: 'listed' }), { status: 'listed', accountId: 'all' })).toBe(true)
    expect(passesInventoryFilter(p({ status: 'in_stock' }), { status: 'listed', accountId: 'all' })).toBe(false)
  })
})

describe('passesInventoryFilter — account filter', () => {
  it('gates by account when an account is selected', () => {
    expect(passesInventoryFilter(p({ accountId: 'a1' }), { status: 'all', accountId: 'a1' })).toBe(true)
    expect(passesInventoryFilter(p({ accountId: 'a2' }), { status: 'all', accountId: 'a1' })).toBe(false)
  })

  it('treats an account-less item as not matching a specific account', () => {
    expect(passesInventoryFilter(p({ accountId: undefined }), { status: 'all', accountId: 'a1' })).toBe(false)
  })

  it('account "all" lets any account through', () => {
    expect(passesInventoryFilter(p({ accountId: undefined }), { status: 'all', accountId: 'all' })).toBe(true)
  })

  it('status and account both apply (sold still hidden even on a matching account)', () => {
    expect(passesInventoryFilter(p({ status: 'sold', accountId: 'a1' }), { status: 'all', accountId: 'a1' })).toBe(false)
  })
})

describe('passesInventoryFilter — model listed on two accounts', () => {
  it('shows its listed units under either account', () => {
    const listings = [{ accountId: 'a1', since: 1 }, { accountId: 'a2', since: 1 }]
    const unit = p({ status: 'listed', accountId: undefined })
    expect(passesInventoryFilter(unit, { status: 'all', accountId: 'a1' }, listings)).toBe(true)
    expect(passesInventoryFilter(unit, { status: 'all', accountId: 'a2' }, listings)).toBe(true)
    expect(passesInventoryFilter(unit, { status: 'all', accountId: 'a3' }, listings)).toBe(false)
  })
})
