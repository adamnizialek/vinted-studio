import { describe, it, expect } from 'vitest'
import { resolveProduct, SHARED_FIELDS } from './designs'
import type { Design, Product } from '@/db/types'

const design = (over: Partial<Design> = {}): Design => ({
  id: 'd1',
  name: 'Kurtka NYC',
  brand: 'NF',
  color: 'czarny',
  material: 'poliester',
  category: 'Kobiety / Kurtki',
  tags: ['vintage'],
  photoIds: ['ph1'],
  generatedPhotoIds: ['g1'],
  descriptions: [{ id: 'x', styleId: 's', styleLabel: 'S', text: 't', active: true, createdAt: 1 }],
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

const product = (over: Partial<Product> = {}): Product => ({
  id: 'p1',
  name: '',
  condition: 'dobry',
  currency: 'PLN',
  quantity: 1,
  status: 'in_stock',
  photoIds: [],
  generatedPhotoIds: [],
  descriptions: [],
  tags: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

describe('resolveProduct', () => {
  it('returns the product unchanged when it has no designId', () => {
    const p = product({ name: 'Solo', brand: 'Zara', photoIds: ['own'] })
    expect(resolveProduct(p, new Map())).toBe(p)
  })

  it('overlays shared fields from the design, keeps per-size fields', () => {
    const d = design()
    const p = product({
      designId: 'd1',
      sizeLabel: 'M',
      listingPrice: 89,
      condition: 'bardzo_dobry',
      accountId: 'acc1',
    })
    const r = resolveProduct(p, new Map([['d1', d]]))
    expect(r.name).toBe('Kurtka NYC')
    expect(r.brand).toBe('NF')
    expect(r.photoIds).toEqual(['ph1'])
    expect(r.generatedPhotoIds).toEqual(['g1'])
    expect(r.descriptions).toHaveLength(1)
    // per-size preserved
    expect(r.sizeLabel).toBe('M')
    expect(r.listingPrice).toBe(89)
    expect(r.condition).toBe('bardzo_dobry')
    expect(r.accountId).toBe('acc1')
  })

  it('falls back to the bare product when the design is missing (e.g. mid-sync)', () => {
    const p = product({ designId: 'gone' })
    const r = resolveProduct(p, new Map())
    expect(r.name).toBe('')
    expect(r.photoIds).toEqual([])
  })

  it('SHARED_FIELDS lists exactly the design-owned fields', () => {
    expect([...SHARED_FIELDS]).toEqual([
      'name', 'brand', 'color', 'material', 'category', 'tags',
      'photoIds', 'generatedPhotoIds', 'descriptions',
    ])
  })

  it('overlays exactly the SHARED_FIELDS from the design, nothing else', () => {
    const d = design()
    const p = product({ designId: 'd1' })
    const r = resolveProduct(p, new Map([['d1', d]]))
    for (const key of SHARED_FIELDS) {
      expect(r[key]).toStrictEqual(d[key])
    }
  })
})
