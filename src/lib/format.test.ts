import { describe, it, expect } from 'vitest'
import { aggregateProfit, parseDecimal } from '@/lib/format'
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
