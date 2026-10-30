import { describe, it, expect } from 'vitest'
import { productExtras, saleExtras } from './extraFields'
import type { Product, Sale } from '@/db/types'

const product = (over: Partial<Product> = {}): Product => ({
  id: 'p1',
  name: 'Kowbojki',
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

const sale = (over: Partial<Sale> = {}): Sale => ({
  id: 's1',
  productName: 'Kowbojki',
  salePrice: 120,
  currency: 'PLN',
  quantity: 1,
  status: 'completed',
  soldAt: 1,
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

describe('productExtras', () => {
  it('is empty for a typical imported item (only size and prices filled)', () => {
    expect(productExtras(product({ sizeLabel: '43', purchasePrice: 60, listingPrice: 150 }))).toEqual([])
  })

  it('surfaces a colour written by the screenshot import so it is not hidden silently', () => {
    expect(productExtras(product({ color: 'Black Men Boots' }))).toEqual(['Kolor: Black Men Boots'])
  })

  it('ignores blank strings, empty measurements and default quantity/currency', () => {
    expect(
      productExtras(product({ brand: '  ', notes: '', measurements: { chest: undefined } })),
    ).toEqual([])
  })

  it('lists every filled hidden field in form order', () => {
    expect(
      productExtras(
        product({
          color: 'czarny',
          brand: 'Zara',
          category: 'Buty',
          material: 'skóra',
          tags: ['vintage', 'western'],
          notes: 'rysa na czubku',
          measurements: { footLength: 27 },
          quantity: 2,
          currency: 'EUR',
          retailPrice: 50,
        }),
      ).map((s) => s.split(':')[0]),
    ).toEqual([
      'Kolor',
      'Marka',
      'Kategoria',
      'Materiał',
      'Tagi',
      'Notatki',
      'Wymiary',
      'Ilość',
      'Waluta',
      'Cena detaliczna',
    ])
  })
})

describe('saleExtras', () => {
  it('is empty for a plain sale', () => {
    expect(saleExtras(sale({ accountId: 'a1', purchaseCost: 40 }))).toEqual([])
  })

  it('lists filled cost/buyer fields', () => {
    const out = saleExtras(sale({ brand: 'Zara', shippingCost: 5, buyer: 'ania_92', notes: 'zwrot?' }))
    expect(out[0]).toBe('Marka: Zara')
    expect(out[1]).toMatch(/^Wysyłka: 5/)
    expect(out.slice(2)).toEqual(['Kupujący: ania_92', 'Notatki'])
  })
})
