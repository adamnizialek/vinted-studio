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
  earliestListing,
  toggleListing,
  memberListingPatch,
  suggestedSaleAccount,
  soldPatch,
  listingsFromProducts,
  effectiveListings,
  mergeListings,
  isOnAccount,
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
  it('collapses stale units of one model into a single row with a unit count', () => {
    const a = base({ id: 'a', designId: 'd1', status: 'listed', listedAt: NOW - 40 * DAY_MS })
    const b = base({ id: 'b', designId: 'd1', status: 'listed', listedAt: NOW - 50 * DAY_MS })
    const solo = base({ id: 's', status: 'listed', listedAt: NOW - 45 * DAY_MS })
    const out = staleListings([a, b, solo], NOW)
    expect(out.map((r) => [r.product.id, r.days, r.units])).toEqual([
      ['b', 50, 2],
      ['s', 45, 1],
    ])
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
  it('skips backfilled (approximate) listing dates', () => {
    const out = daysToSellStats([
      base({ id: 'a', status: 'sold', listedAt: NOW - 10 * DAY_MS, soldAt: NOW }),
      base({ id: 'b', status: 'sold', listedAt: NOW - 90 * DAY_MS, listedAtApprox: true, soldAt: NOW }),
    ])
    expect(out).toEqual({ medianDays: 10, covered: 1, totalSold: 2 })
  })
  it('reports null median with zero coverage when no sold product has listedAt', () => {
    const out = daysToSellStats([base({ status: 'sold', soldAt: NOW })])
    expect(out).toEqual({ medianDays: null, covered: 0, totalSold: 1 })
  })
})

describe('design listings', () => {
  const L = (accountId: string, since: number) => ({ accountId, since })

  it('earliestListing is the oldest since, null when not listed anywhere', () => {
    expect(earliestListing(undefined)).toBe(null)
    expect(earliestListing([])).toBe(null)
    expect(earliestListing([L('a', 300), L('b', 100)])).toBe(100)
  })

  it('toggleListing adds a missing account and removes a present one', () => {
    const one = toggleListing(undefined, 'main', 5)
    expect(one).toEqual([L('main', 5)])
    const two = toggleListing(one, 'zoosia', 9)
    expect(two).toEqual([L('main', 5), L('zoosia', 9)])
    expect(toggleListing(two, 'main', 99)).toEqual([L('zoosia', 9)])
  })

  it('lists unsold units from the earliest listing, on the account when there is just one', () => {
    const unit = base({ status: 'in_stock' })
    expect(memberListingPatch(unit, [L('main', 100)])).toEqual({
      status: 'listed', listedAt: 100, listedAtApprox: undefined, accountId: 'main',
    })
    // Dwa konta: konto rozstrzyga dopiero sprzedaż.
    expect(memberListingPatch(unit, [L('main', 100), L('zoosia', 50)])).toEqual({
      status: 'listed', listedAt: 50, listedAtApprox: undefined, accountId: undefined,
    })
  })

  it('replaces a backfilled date and returns null when nothing changes', () => {
    const approx = base({ status: 'listed', listedAt: 100, listedAtApprox: true, accountId: 'main' })
    expect(memberListingPatch(approx, [L('main', 100)])).toMatchObject({ listedAtApprox: undefined })
    const same = base({ status: 'listed', listedAt: 100, accountId: 'main' })
    expect(memberListingPatch(same, [L('main', 100)])).toBe(null)
  })

  it('takes listed units back to stock when the model is unlisted everywhere', () => {
    expect(memberListingPatch(base({ status: 'listed', accountId: 'main' }), [])).toEqual({
      status: 'in_stock', accountId: undefined,
    })
    expect(memberListingPatch(base({ status: 'in_stock' }), [])).toBe(null)
  })

  it('leaves sold, reserved and archived units alone', () => {
    for (const status of ['sold', 'reserved', 'archived'] as const)
      expect(memberListingPatch(base({ status }), [L('main', 1)])).toBe(null)
  })

  it('suggests the unit account, else the only listing account', () => {
    expect(suggestedSaleAccount(base({ accountId: 'x' }), [L('main', 1)])).toBe('x')
    expect(suggestedSaleAccount(base(), [L('main', 1)])).toBe('main')
    expect(suggestedSaleAccount(base(), [L('main', 1), L('zoosia', 2)])).toBe(undefined)
  })

  it('soldPatch keeps the sale account and fills the listing date from that account', () => {
    const unit = base({ status: 'listed' })
    expect(soldPatch(unit, 1000, 'zoosia', [L('main', 100), L('zoosia', 300)])).toEqual({
      status: 'sold', soldAt: 1000, accountId: 'zoosia', listedAt: 300,
    })
    // Bez konta: najwcześniejsze ogłoszenie.
    expect(soldPatch(unit, 1000, undefined, [L('main', 100), L('zoosia', 300)])).toEqual({
      status: 'sold', soldAt: 1000, listedAt: 100,
    })
  })

  it('soldPatch keeps an existing listedAt and never sets one after the sale', () => {
    expect(soldPatch(base({ listedAt: 50 }), 1000, 'main', [L('main', 100)])).toEqual({
      status: 'sold', soldAt: 1000, accountId: 'main',
    })
    expect(soldPatch(base(), 1000, 'main', [L('main', 2000)])).toEqual({
      status: 'sold', soldAt: 1000, accountId: 'main',
    })
  })
})

describe('listings read from units (older models, grouping)', () => {
  it('takes the earliest date per account from listed units with an account', () => {
    const units = [
      base({ id: '1', status: 'listed', accountId: 'main', listedAt: 300 }),
      base({ id: '2', status: 'listed', accountId: 'main', listedAt: 100 }),
      base({ id: '3', status: 'listed', accountId: 'zoosia', listedAt: 200 }),
      base({ id: '4', status: 'listed', listedAt: 50 }), // bez konta — pominięty
      base({ id: '5', status: 'in_stock', accountId: 'main', listedAt: 10 }), // nie wystawiony
    ]
    expect(listingsFromProducts(units)).toEqual([
      { accountId: 'main', since: 100 },
      { accountId: 'zoosia', since: 200 },
    ])
  })
  it('effectiveListings prefers the stored field, even when empty', () => {
    const units = [base({ status: 'listed', accountId: 'main', listedAt: 100 })]
    expect(effectiveListings(undefined, units)).toEqual([{ accountId: 'main', since: 100 }])
    expect(effectiveListings([], units)).toEqual([])
  })
  it('mergeListings keeps the earlier date per account', () => {
    expect(
      mergeListings(
        [{ accountId: 'a', since: 5 }],
        [{ accountId: 'a', since: 3 }, { accountId: 'b', since: 9 }],
      ),
    ).toEqual([{ accountId: 'a', since: 3 }, { accountId: 'b', since: 9 }])
  })
})

describe('isOnAccount', () => {
  const both = [{ accountId: 'main', since: 1 }, { accountId: 'zoosia', since: 2 }]
  it('matches the unit account', () => {
    expect(isOnAccount(base({ accountId: 'main' }), 'main', undefined)).toBe(true)
    expect(isOnAccount(base({ accountId: 'main' }), 'zoosia', both)).toBe(false)
  })
  it('counts a listed unit of a model on two accounts under each of them', () => {
    const unit = base({ status: 'listed' })
    expect(isOnAccount(unit, 'main', both)).toBe(true)
    expect(isOnAccount(unit, 'zoosia', both)).toBe(true)
    expect(isOnAccount(base({ status: 'in_stock' }), 'main', both)).toBe(false)
  })
})

describe('approximate (backfilled) dates stay approximate', () => {
  it('listingsFromProducts and memberListingPatch carry the flag', () => {
    const units = [base({ status: 'listed', accountId: 'main', listedAt: 100, listedAtApprox: true })]
    const listings = listingsFromProducts(units)
    expect(listings).toEqual([{ accountId: 'main', since: 100, approx: true }])
    const withB = [...listings, { accountId: 'zoosia', since: 900 }]
    expect(memberListingPatch(units[0], withB)).toEqual({
      status: 'listed', listedAt: 100, listedAtApprox: true, accountId: undefined,
    })
    expect(memberListingPatch(base({ status: 'in_stock' }), withB)).toMatchObject({ listedAtApprox: true })
  })
  it('soldPatch keeps the flag when the date comes from an approximate listing', () => {
    expect(soldPatch(base(), 1000, 'main', [{ accountId: 'main', since: 100, approx: true }])).toEqual({
      status: 'sold', soldAt: 1000, accountId: 'main', listedAt: 100, listedAtApprox: true,
    })
  })
})

describe('soldPatch on a model listed on two accounts', () => {
  it('measures from the listing on the account that sold it', () => {
    const listings = [{ accountId: 'main', since: 100 }, { accountId: 'zoosia', since: 800 }]
    const unit = base({ status: 'listed', listedAt: 100 }) // data najwcześniejszego ogłoszenia
    expect(soldPatch(unit, 1000, 'zoosia', listings)).toEqual({
      status: 'sold', soldAt: 1000, accountId: 'zoosia', listedAt: 800,
    })
    expect(soldPatch(unit, 1000, 'main', listings)).toEqual({
      status: 'sold', soldAt: 1000, accountId: 'main',
    })
  })
})
