import { describe, it, expect } from 'vitest'
import type { Sale } from '@/db/types'
import { dailySalesRecord, inRange, periodRange } from './salesRecord'

/** Lokalne południe danego dnia — spójnie z dateFromInput w aplikacji. */
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime()

const sale = (over: Partial<Sale> = {}): Sale => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  productName: 'Spodnie',
  salePrice: 100,
  currency: 'PLN',
  quantity: 1,
  status: 'completed',
  soldAt: at(2026, 10, 10),
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

describe('dailySalesRecord', () => {
  it('groups by local day, sorts ascending, skips returns and keeps a running year total', () => {
    const rows = dailySalesRecord([
      sale({ salePrice: 100, soldAt: at(2026, 10, 2, 9) }),
      sale({ salePrice: 50.555, soldAt: at(2026, 10, 2, 22) }),
      sale({ salePrice: 200, soldAt: at(2026, 9, 30) }),
      sale({ salePrice: 70, soldAt: at(2026, 10, 3), status: 'returned' }),
      sale({ salePrice: 70, soldAt: at(2026, 10, 3), status: 'cancelled' }),
    ])
    expect(rows).toEqual([
      { date: '2026-09-30', amount: 200, cumulativeYear: 200 },
      { date: '2026-10-02', amount: 150.56, cumulativeYear: 350.56 },
    ])
  })

  it('counts quantity and shipping charged to the buyer', () => {
    const rows = dailySalesRecord([sale({ salePrice: 100, quantity: 2, shippingCharged: 15 })])
    expect(rows[0].amount).toBe(215)
  })

  it('accumulates the rounded daily amounts so the columns add up to the grosz', () => {
    const rows = dailySalesRecord([
      sale({ salePrice: 10.005, soldAt: at(2026, 10, 1) }),
      sale({ salePrice: 10.005, soldAt: at(2026, 10, 2) }),
    ])
    const sumOfRows = rows.reduce((n, r) => n + r.amount, 0)
    expect(rows[1].cumulativeYear).toBeCloseTo(sumOfRows, 10)
  })

  it('resets the year total on 1 January', () => {
    const rows = dailySalesRecord([
      sale({ salePrice: 100, soldAt: at(2026, 12, 31) }),
      sale({ salePrice: 40, soldAt: at(2027, 1, 1) }),
    ])
    expect(rows[1]).toEqual({ date: '2027-01-01', amount: 40, cumulativeYear: 40 })
  })

  it('keeps the full running total when only a range is printed', () => {
    const rows = dailySalesRecord(
      [
        sale({ salePrice: 100, soldAt: at(2026, 2, 1) }),
        sale({ salePrice: 30, soldAt: at(2026, 10, 1) }),
        sale({ salePrice: 20, soldAt: at(2026, 10, 2) }),
      ],
      periodRange('quarter', at(2026, 10, 24)),
    )
    expect(rows.map((r) => [r.date, r.cumulativeYear])).toEqual([
      ['2026-10-01', 130],
      ['2026-10-02', 150],
    ])
  })
})

describe('periodRange', () => {
  const now = at(2026, 1, 15)
  it('builds month, quarter and year ranges, including the previous ones', () => {
    expect(periodRange('all', now)).toEqual({})
    expect(periodRange('month', now)).toEqual({ from: new Date(2026, 0, 1).getTime() })
    expect(periodRange('lastMonth', now)).toEqual({
      from: new Date(2025, 11, 1).getTime(),
      to: new Date(2026, 0, 1).getTime(),
    })
    expect(periodRange('quarter', now)).toEqual({ from: new Date(2026, 0, 1).getTime() })
    expect(periodRange('lastQuarter', now)).toEqual({
      from: new Date(2025, 9, 1).getTime(),
      to: new Date(2026, 0, 1).getTime(),
    })
    expect(periodRange('year', now)).toEqual({ from: new Date(2026, 0, 1).getTime() })
  })
  it('steps back across a year boundary for the previous quarter', () => {
    expect(periodRange('lastQuarter', at(2027, 2, 1))).toEqual({
      from: new Date(2026, 9, 1).getTime(),
      to: new Date(2027, 0, 1).getTime(),
    })
  })
  it('treats the upper bound as exclusive', () => {
    const r = periodRange('lastMonth', now)
    expect(inRange(new Date(2025, 11, 31, 23, 59).getTime(), r)).toBe(true)
    expect(inRange(new Date(2026, 0, 1).getTime(), r)).toBe(false)
  })
})
