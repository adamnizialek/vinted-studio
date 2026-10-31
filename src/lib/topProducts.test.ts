import { describe, expect, it } from 'vitest'
import type { Sale } from '@/db/types'
import { splitSize, topProducts } from './topProducts'

const sale = (over: Partial<Sale>): Sale => ({
  id: Math.random().toString(36),
  productName: 'X',
  salePrice: 100,
  currency: 'PLN',
  quantity: 1,
  status: 'completed',
  soldAt: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

describe('splitSize', () => {
  it('odcina rozmiar po myślniku', () => {
    expect(splitSize('Kowbojki skórzane — 42')).toEqual({ name: 'Kowbojki skórzane', size: '42' })
  })
  it('zostawia nazwę bez rozmiaru', () => {
    expect(splitSize('Koszula deutchland')).toEqual({ name: 'Koszula deutchland' })
  })
})

describe('topProducts', () => {
  it('łączy rozmiary modelu i sortuje po zysku', () => {
    const res = topProducts(
      [
        sale({ productName: 'Kowbojki — 42', salePrice: 300, purchaseCost: 140 }),
        sale({ productName: 'Kowbojki — 43', salePrice: 320, purchaseCost: 140 }),
        sale({ productName: 'kowbojki — 42', salePrice: 250, purchaseCost: 140 }),
        sale({ productName: 'Koszula', salePrice: 50, purchaseCost: 20 }),
        sale({ productName: 'Koszula', salePrice: 999, status: 'returned' }),
      ],
    )
    expect(res.map((r) => r.name)).toEqual(['Kowbojki', 'Koszula'])
    expect(res[0]).toMatchObject({ units: 3, profit: 450, sizes: ['42', '43'] })
    expect(res[1]).toMatchObject({ units: 1, profit: 30 })
  })
})
