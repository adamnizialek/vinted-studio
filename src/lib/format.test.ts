import { describe, it, expect } from 'vitest'
import { aggregateProfit, countsAsInventoryCost, parseDecimal } from '@/lib/format'
import type { Expense, Product, Sale } from '@/db/types'

const sale = (over: Partial<Sale>): Sale => ({
  id: 'x', productName: 'p', salePrice: 100, currency: 'PLN', quantity: 1,
  status: 'completed', soldAt: 0, createdAt: 0, updatedAt: 0, ...over,
})
const expense = (amount: number): Expense => ({
  id: 'e', kind: 'boost', description: 'Podbicia', amount, currency: 'PLN',
  incurredAt: 0, createdAt: 0, updatedAt: 0,
})
const product = (over: Partial<Product>): Product => ({
  id: 'p1', name: 'prod', condition: 'dobry', currency: 'PLN', quantity: 1,
  status: 'in_stock', photoIds: [], generatedPhotoIds: [], descriptions: [],
  tags: [], createdAt: 0, updatedAt: 0, ...over,
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

describe('countsAsInventoryCost', () => {
  it('counts not-yet-sold statuses, excludes sold and archived', () => {
    expect(countsAsInventoryCost('draft')).toBe(true)
    expect(countsAsInventoryCost('in_stock')).toBe(true)
    expect(countsAsInventoryCost('listed')).toBe(true)
    expect(countsAsInventoryCost('reserved')).toBe(true)
    expect(countsAsInventoryCost('sold')).toBe(false)
    expect(countsAsInventoryCost('archived')).toBe(false)
  })
})

describe('aggregateProfit with products (inventory cost)', () => {
  it('adds unsold-stock purchase cost to costs + inventoryCost, reducing profit', () => {
    const sales = [sale({ salePrice: 100, purchaseCost: 30 })]
    const products = [
      product({ purchasePrice: 40, quantity: 1 }),
      product({ id: 'p2', purchasePrice: 40, quantity: 1 }),
    ]
    const agg = aggregateProfit(sales, [expense(10)], products)
    expect(agg.inventoryCost).toBe(80)
    expect(agg.costs).toBe(120) // 30 COGS + 10 ad + 80 stock
    expect(agg.profit).toBe(-20) // 100 - 120
  })

  it('multiplies purchasePrice by quantity', () => {
    const products = [product({ purchasePrice: 25, quantity: 3 })]
    expect(aggregateProfit([], [], products).inventoryCost).toBe(75)
  })

  it('excludes sold and archived products (no double-count vs sales)', () => {
    const products = [
      product({ id: 'a', status: 'sold', purchasePrice: 99 }),
      product({ id: 'b', status: 'archived', purchasePrice: 99 }),
      product({ id: 'c', status: 'in_stock', purchasePrice: 10 }),
    ]
    expect(aggregateProfit([], [], products).inventoryCost).toBe(10)
  })

  it('treats missing purchasePrice as 0', () => {
    const products = [
      product({ purchasePrice: undefined }),
      product({ id: 'p2', purchasePrice: 12 }),
    ]
    expect(aggregateProfit([], [], products).inventoryCost).toBe(12)
  })

  it('reports inventoryCost 0 and stays unchanged when products omitted (back-compat)', () => {
    const sales = [sale({ salePrice: 100, purchaseCost: 40 })]
    expect(aggregateProfit(sales, []).inventoryCost).toBe(0)
    expect(aggregateProfit(sales, [])).toEqual(aggregateProfit(sales, [], []))
  })
})

describe('parseDecimal', () => {
  it('accepts a comma decimal separator (PL mobile keyboard)', () => {
    expect(parseDecimal('12,50')).toBe(12.5)
    expect(parseDecimal('0,99')).toBe(0.99)
    expect(parseDecimal(',5')).toBe(0.5)
  })

  it('still accepts a dot decimal separator', () => {
    expect(parseDecimal('12.50')).toBe(12.5)
    expect(parseDecimal('199')).toBe(199)
  })

  it('treats blank / partial input as undefined', () => {
    expect(parseDecimal('')).toBeUndefined()
    expect(parseDecimal('   ')).toBeUndefined()
    expect(parseDecimal(',')).toBeUndefined()
    expect(parseDecimal('.')).toBeUndefined()
    expect(parseDecimal('-')).toBeUndefined()
    expect(parseDecimal('abc')).toBeUndefined()
  })

  it('keeps a trailing separator usable mid-typing (parses the integer part)', () => {
    expect(parseDecimal('12,')).toBe(12)
    expect(parseDecimal('12.')).toBe(12)
  })

  it('ignores surrounding whitespace', () => {
    expect(parseDecimal(' 12,50 ')).toBe(12.5)
  })

  it('parses integers when integer=true', () => {
    expect(parseDecimal('3', true)).toBe(3)
    expect(parseDecimal('2,9', true)).toBe(2)
    expect(parseDecimal('', true)).toBeUndefined()
  })

  it('rejects non-finite results', () => {
    expect(parseDecimal('NaN')).toBeUndefined()
    expect(parseDecimal('Infinity')).toBeUndefined()
  })
})
