import { describe, it, expect } from 'vitest'
import type { Product } from '@/db/types'
import {
  DAY_MS,
  STALE_LISTING_DAYS,
  daysBetween,
  median,
  coverImageIdOf,
  daysListed,
  staleListings,
  sellThrough,
  daysToSellStats,
  listingHref,
} from './listing'

const base = (over: Partial<Product> = {}): Product => ({
  id: over.id ?? 'p',
  name: 'P',
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

const NOW = 1_000 * DAY_MS // a clean day boundary

describe('daysBetween', () => {
  it('floors elapsed whole days', () => {
    expect(daysBetween(0, DAY_MS)).toBe(1)
    expect(daysBetween(0, DAY_MS * 3 + DAY_MS / 2)).toBe(3)
    expect(daysBetween(0, 0)).toBe(0)
  })
  it('can be negative for reversed args', () => {
    expect(daysBetween(DAY_MS, 0)).toBe(-1)
  })
})

describe('median', () => {
  it('returns null for empty', () => {
    expect(median([])).toBe(null)
  })
  it('returns the middle for odd length', () => {
    expect(median([3, 1, 2])).toBe(2)
  })
  it('averages the two middles for even length', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })
  it('does not mutate the input', () => {
    const xs = [3, 1, 2]
    median(xs)
    expect(xs).toEqual([3, 1, 2])
  })
})

describe('coverImageIdOf', () => {
  it('prefers explicit coverImageId', () => {
    expect(coverImageIdOf(base({ coverImageId: 'c', photoIds: ['a'], generatedPhotoIds: ['g'] }))).toBe('c')
  })
  it('falls back to first original photo', () => {
    expect(coverImageIdOf(base({ photoIds: ['a'], generatedPhotoIds: ['g'] }))).toBe('a')
  })
  it('falls back to first generated photo', () => {
    expect(coverImageIdOf(base({ generatedPhotoIds: ['g'] }))).toBe('g')
  })
  it('returns undefined when there are no images', () => {
    expect(coverImageIdOf(base())).toBeUndefined()
  })
})

describe('listingHref', () => {
  it('returns undefined for empty/whitespace', () => {
    expect(listingHref(undefined)).toBeUndefined()
    expect(listingHref('')).toBeUndefined()
    expect(listingHref('   ')).toBeUndefined()
  })
  it('passes through an absolute http(s) url, trimmed', () => {
    expect(listingHref('  https://vinted.pl/items/1 ')).toBe('https://vinted.pl/items/1')
    expect(listingHref('http://vinted.pl/x')).toBe('http://vinted.pl/x')
  })
  it('prepends https:// when no scheme is present', () => {
    expect(listingHref('vinted.pl/items/1')).toBe('https://vinted.pl/items/1')
  })
})

describe('daysListed', () => {
  it('is null unless the product is listed', () => {
    expect(daysListed(base({ status: 'in_stock', listedAt: NOW - 5 * DAY_MS }), NOW)).toBe(null)
    expect(daysListed(base({ status: 'sold', listedAt: NOW - 5 * DAY_MS }), NOW)).toBe(null)
  })
  it('is null when listed but listedAt is missing', () => {
    expect(daysListed(base({ status: 'listed' }), NOW)).toBe(null)
  })
  it('counts days since listedAt for a listed product', () => {
    expect(daysListed(base({ status: 'listed', listedAt: NOW - 7 * DAY_MS }), NOW)).toBe(7)
  })
  it('clamps to 0 for a future listedAt', () => {
    expect(daysListed(base({ status: 'listed', listedAt: NOW + 2 * DAY_MS }), NOW)).toBe(0)
  })
})

describe('staleListings', () => {
  it('keeps only listed items older than the threshold, oldest first', () => {
    const fresh = base({ id: 'fresh', status: 'listed', listedAt: NOW - 5 * DAY_MS })
    const stale1 = base({ id: 'stale1', status: 'listed', listedAt: NOW - 40 * DAY_MS })
    const stale2 = base({ id: 'stale2', status: 'listed', listedAt: NOW - 90 * DAY_MS })
    const soldOld = base({ id: 'sold', status: 'sold', listedAt: NOW - 200 * DAY_MS })
    const out = staleListings([fresh, stale1, stale2, soldOld], NOW)
    expect(out.map((s) => s.product.id)).toEqual(['stale2', 'stale1'])
    expect(out[0].days).toBe(90)
  })
  it('respects a custom threshold and the boundary is inclusive', () => {
    const exactly = base({ id: 'x', status: 'listed', listedAt: NOW - 10 * DAY_MS })
    expect(staleListings([exactly], NOW, 10)).toHaveLength(1)
    expect(staleListings([exactly], NOW, 11)).toHaveLength(0)
  })
  it('uses 30 days as the default threshold', () => {
    expect(STALE_LISTING_DAYS).toBe(30)
  })
})

describe('sellThrough', () => {
  it('is sold / (sold + listed), ignoring other statuses', () => {
    const products = [
      base({ id: '1', status: 'sold' }),
      base({ id: '2', status: 'sold' }),
      base({ id: '3', status: 'sold' }),
      base({ id: '4', status: 'listed' }),
      base({ id: '5', status: 'in_stock' }),
      base({ id: '6', status: 'draft' }),
      base({ id: '7', status: 'archived' }),
    ]
    const out = sellThrough(products)
    expect(out.sold).toBe(3)
    expect(out.listed).toBe(1)
    expect(out.rate).toBe(0.75)
  })
  it('returns null rate when nothing reached the market', () => {
    const out = sellThrough([base({ status: 'in_stock' }), base({ status: 'draft' })])
    expect(out.rate).toBe(null)
  })
})

describe('daysToSellStats', () => {
  it('medians days-to-sell over sold products that have a listedAt, with coverage', () => {
    const products = [
      base({ id: 'a', status: 'sold', listedAt: NOW - 10 * DAY_MS, soldAt: NOW }), // 10
      base({ id: 'b', status: 'sold', listedAt: NOW - 20 * DAY_MS, soldAt: NOW }), // 20
      base({ id: 'c', status: 'sold', soldAt: NOW }), // no listedAt -> excluded
      base({ id: 'd', status: 'listed', listedAt: NOW - 99 * DAY_MS }), // not sold -> excluded
    ]
    const out = daysToSellStats(products)
    expect(out.medianDays).toBe(15)
    expect(out.covered).toBe(2)
    expect(out.totalSold).toBe(3)
  })
  it('excludes inverted timestamps (soldAt before listedAt)', () => {
    const out = daysToSellStats([
      base({ id: 'x', status: 'sold', listedAt: NOW, soldAt: NOW - 5 * DAY_MS }),
    ])
    expect(out.medianDays).toBe(null)
    expect(out.covered).toBe(0)
    expect(out.totalSold).toBe(1)
  })
  it('reports null median with zero coverage when no sold product has listedAt', () => {
    const out = daysToSellStats([base({ status: 'sold', soldAt: NOW })])
    expect(out).toEqual({ medianDays: null, covered: 0, totalSold: 1 })
  })
})
