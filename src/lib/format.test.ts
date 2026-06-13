import { describe, it, expect } from 'vitest'
import { aggregateProfit } from '@/lib/format'
import type { Expense, Sale } from '@/db/types'

const sale = (over: Partial<Sale>): Sale => ({
  id: 'x', productName: 'p', salePrice: 100, currency: 'PLN', quantity: 1,
  status: 'completed', soldAt: 0, createdAt: 0, updatedAt: 0, ...over,
})
const expense = (amount: number): Expense => ({
  id: 'e', kind: 'boost', description: 'Podbicia', amount, currency: 'PLN',
  incurredAt: 0, createdAt: 0, updatedAt: 0,
})

describe('aggregateProfit with expenses', () => {
  it('adds ad-spend to costs and nets profit + margin', () => {
    const sales = [sale({ salePrice: 100, purchaseCost: 40 })]
    expect(aggregateProfit(sales).profit).toBe(60)
    const agg = aggregateProfit(sales, [expense(10)])
    expect(agg.costs).toBe(50)
    expect(agg.profit).toBe(50)
    expect(agg.margin).toBeCloseTo(0.5)
  })

  it('is unchanged when the expenses list is empty (back-compat)', () => {
    const sales = [sale({ salePrice: 100, purchaseCost: 40 })]
    expect(aggregateProfit(sales, [])).toEqual(aggregateProfit(sales))
  })
})
