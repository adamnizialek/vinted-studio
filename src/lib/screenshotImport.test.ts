import { describe, it, expect } from 'vitest'
import {
  parseExtractionResponse,
  parseExtractionResult,
  extractedToStockDrafts,
  allocateLandedCosts,
  landedFactor,
  rowFlags,
  parsePriceLoose,
  EXTRACTION_SCHEMA,
  type ExtractedItem,
} from '@/lib/screenshotImport'

const item = (over: Partial<ExtractedItem> = {}): ExtractedItem => ({
  name: 'Koszulka',
  quantity: 1,
  bundle: false,
  confidence: 'high',
  ...over,
})

/** Suma kosztów landed (cena za sztukę × ilość) — do sprawdzenia, że rozkład trafia w sumę. */
const sumLineTotals = (items: ExtractedItem[]) =>
  items.reduce((n, i) => n + (i.unitPrice ?? 0) * i.quantity, 0)

describe('parseExtractionResponse', () => {
  it('parses a clean {items:[...]} object', () => {
    const text = JSON.stringify({
      items: [
        { name: 'Bluza zebra', color: 'Czarny', size: 'XL', quantity: 2, unitPrice: 42.92, currency: 'PLN', bundle: false, confidence: 'high' },
      ],
    })
    const items = parseExtractionResponse(text)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ name: 'Bluza zebra', color: 'Czarny', size: 'XL', quantity: 2, unitPrice: 42.92, currency: 'PLN' })
  })

  it('accepts a bare top-level array too', () => {
    const text = JSON.stringify([{ name: 'Czapka', quantity: 1, unitPrice: 10, bundle: false, confidence: 'medium' }])
    const items = parseExtractionResponse(text)
    expect(items).toHaveLength(1)
    expect(items[0].name).toBe('Czapka')
  })

  it('strips a ```json markdown fence before parsing', () => {
    const text = '```json\n{"items":[{"name":"Spodnie","quantity":1,"unitPrice":30,"bundle":false,"confidence":"high"}]}\n```'
    expect(parseExtractionResponse(text)).toHaveLength(1)
  })

  it('recovers JSON embedded in surrounding prose (substring fallback)', () => {
    const text = 'Oto wynik: {"items":[{"name":"Szalik","quantity":1,"bundle":false,"confidence":"low"}]} koniec.'
    const items = parseExtractionResponse(text)
    expect(items).toHaveLength(1)
    expect(items[0].name).toBe('Szalik')
  })

  it('never throws on malformed JSON — returns []', () => {
    expect(parseExtractionResponse('not json at all')).toEqual([])
    expect(parseExtractionResponse('{"items": [')).toEqual([])
    expect(parseExtractionResponse('')).toEqual([])
  })

  it('returns [] when the model reports no items', () => {
    expect(parseExtractionResponse('{"items":[]}')).toEqual([])
  })

  it('drops rows without a usable name', () => {
    const text = JSON.stringify({ items: [{ name: '', quantity: 1 }, { name: '   ', quantity: 1 }, { quantity: 1 }] })
    expect(parseExtractionResponse(text)).toEqual([])
  })

  it('defaults quantity to 1 and clamps to a sane range', () => {
    const text = JSON.stringify({
      items: [
        { name: 'A' },
        { name: 'B', quantity: 0 },
        { name: 'C', quantity: -3 },
        { name: 'D', quantity: 2.9 },
        { name: 'E', quantity: 100000 },
      ],
    })
    const items = parseExtractionResponse(text)
    expect(items.map((i) => i.quantity)).toEqual([1, 1, 1, 2, 999])
  })

  it('coerces garbage prices to undefined and keeps valid positive numbers', () => {
    const text = JSON.stringify({
      items: [
        { name: 'A', unitPrice: 'abc' },
        { name: 'B', unitPrice: 0 },
        { name: 'C', unitPrice: -5 },
        { name: 'D', unitPrice: 12.5 },
      ],
    })
    const items = parseExtractionResponse(text)
    expect(items.map((i) => i.unitPrice)).toEqual([undefined, undefined, undefined, 12.5])
  })

  it('parses a numeric unitPrice delivered as a string', () => {
    const text = JSON.stringify({ items: [{ name: 'A', unitPrice: '20,73' }, { name: 'B', unitPrice: '$4.99' }] })
    const items = parseExtractionResponse(text)
    expect(items[0].unitPrice).toBe(20.73)
    expect(items[1].unitPrice).toBe(4.99)
  })

  it('defaults bundle=false and confidence=low on missing/garbage', () => {
    const text = JSON.stringify({ items: [{ name: 'A' }, { name: 'B', confidence: 'nonsense', bundle: 'yes' }] })
    const items = parseExtractionResponse(text)
    expect(items[0]).toMatchObject({ bundle: false, confidence: 'low' })
    expect(items[1].confidence).toBe('low')
    expect(items[1].bundle).toBe(true) // truthy non-empty string -> coerced to true
  })

  it('trims and drops empty optional strings', () => {
    const text = JSON.stringify({ items: [{ name: '  Bluza  ', brand: '  ', color: ' Czarny ', currency: ' usd ' }] })
    const [it] = parseExtractionResponse(text)
    expect(it.name).toBe('Bluza')
    expect(it.brand).toBeUndefined()
    expect(it.color).toBe('Czarny')
    expect(it.currency).toBe('USD')
  })
})

describe('parsePriceLoose', () => {
  it('keeps plain decimals (PL comma, US dot, currency symbols stripped)', () => {
    expect(parsePriceLoose('20,73')).toBe(20.73)
    expect(parsePriceLoose('$4.99')).toBe(4.99)
    expect(parsePriceLoose('20,73 zł')).toBe(20.73)
    expect(parsePriceLoose('35')).toBe(35)
  })
  it('handles thousands separators without truncating (the parsePlNumber bug)', () => {
    expect(parsePriceLoose('$1,234.56')).toBe(1234.56)
    expect(parsePriceLoose('$1,000')).toBe(1000)
    expect(parsePriceLoose('10,000')).toBe(10000)
    expect(parsePriceLoose('1,299')).toBe(1299) // 3 digits after sep -> thousands, not 1.299
    expect(parsePriceLoose('1.299,00')).toBe(1299) // EU format
    expect(parsePriceLoose('1 234,56 zł')).toBe(1234.56)
  })
  it('returns undefined when there is no number', () => {
    expect(parsePriceLoose('abc')).toBeUndefined()
    expect(parsePriceLoose('')).toBeUndefined()
  })
})

describe('extractedToStockDrafts', () => {
  it('expands quantity into N drafts (each garment is its own Vinted listing)', () => {
    const drafts = extractedToStockDrafts([item({ name: 'Messi', quantity: 3, unitPrice: 35 })])
    expect(drafts).toHaveLength(3)
    expect(drafts.every((d) => d.name === 'Messi' && d.purchaseCost === 35)).toBe(true)
  })

  it('maps unitPrice -> purchaseCost and variant -> brand/color/sizeLabel', () => {
    const [d] = extractedToStockDrafts([item({ name: 'Bluza', unitPrice: 42, brand: 'Nike', color: 'Czarny', size: 'XL' })])
    expect(d).toEqual({ name: 'Bluza', purchaseCost: 42, brand: 'Nike', color: 'Czarny', sizeLabel: 'XL' })
  })

  it('omits purchaseCost when no price was read', () => {
    const [d] = extractedToStockDrafts([item({ name: 'X', unitPrice: undefined })])
    expect(d.purchaseCost).toBeUndefined()
    expect('purchaseCost' in d).toBe(false)
  })

  it('applies a landed-cost override to purchaseCost while keying dedup on the RAW read price', () => {
    const [d] = extractedToStockDrafts([item({ name: 'Buty', unitPrice: 63.99 })], [95.42])
    expect(d.purchaseCost).toBe(95.42) // koszt landed (z dostawą) trafia do magazynu
    expect(d.keyCost).toBe(63.99) // identyczność (dedup) oparta na cenie ODCZYTANEJ, nie na sumie
  })

  it('omits keyCost on the CSV path (no landed override) so dedup is unchanged', () => {
    const [d] = extractedToStockDrafts([item({ name: 'X', unitPrice: 42 })])
    expect('keyCost' in d).toBe(false)
    expect(d.purchaseCost).toBe(42)
  })

  it('omits keyCost when the landed cost equals the raw price (no shipping to spread)', () => {
    const [d] = extractedToStockDrafts([item({ name: 'X', unitPrice: 42 })], [42])
    expect('keyCost' in d).toBe(false)
    expect(d.purchaseCost).toBe(42)
  })

  it('flattens multiple items preserving order', () => {
    const drafts = extractedToStockDrafts([
      item({ name: 'A', quantity: 2, unitPrice: 1 }),
      item({ name: 'B', quantity: 1, unitPrice: 2 }),
    ])
    expect(drafts.map((d) => d.name)).toEqual(['A', 'A', 'B'])
  })
})

describe('rowFlags', () => {
  it('flags a non-PLN currency', () => {
    expect(rowFlags(item({ currency: 'USD', unitPrice: 5 })).nonPln).toBe(true)
    expect(rowFlags(item({ currency: 'PLN', unitPrice: 5 })).nonPln).toBe(false)
    expect(rowFlags(item({ currency: undefined, unitPrice: 5 })).nonPln).toBe(false) // unknown -> assume PLN, no noise
  })

  it('flags bundles, low confidence and missing price', () => {
    expect(rowFlags(item({ bundle: true })).bundle).toBe(true)
    expect(rowFlags(item({ confidence: 'low' })).lowConfidence).toBe(true)
    expect(rowFlags(item({ confidence: 'high' })).lowConfidence).toBe(false)
    expect(rowFlags(item({ unitPrice: undefined })).noPrice).toBe(true)
    expect(rowFlags(item({ unitPrice: 10 })).noPrice).toBe(false)
  })
})

describe('EXTRACTION_SCHEMA', () => {
  it('uses an OBJECT root with an items ARRAY and UPPERCASE Gemini types', () => {
    expect(EXTRACTION_SCHEMA.type).toBe('OBJECT')
    expect(EXTRACTION_SCHEMA.properties.items.type).toBe('ARRAY')
    expect(EXTRACTION_SCHEMA.properties.items.items.type).toBe('OBJECT')
    // required item fields present
    expect(EXTRACTION_SCHEMA.properties.items.items.required).toContain('name')
  })

  it('exposes order-level money totals at the root (NUMBER, nullable) without making them required', () => {
    const p = EXTRACTION_SCHEMA.properties as Record<string, { type: string; nullable?: boolean }>
    expect(p.orderTotal.type).toBe('NUMBER')
    expect(p.orderTotal.nullable).toBe(true)
    expect(p.orderSubtotal.type).toBe('NUMBER')
    expect(p.orderShipping.type).toBe('NUMBER')
    expect(p.orderCurrency.type).toBe('STRING')
    expect(EXTRACTION_SCHEMA.required).toEqual(['items']) // totals stay optional
  })
})

describe('parseExtractionResult — order totals', () => {
  it('reads the grand total, subtotal, shipping and currency from root fields', () => {
    const text = JSON.stringify({
      items: [{ name: 'Buty', quantity: 1, unitPrice: 63.99, bundle: false, confidence: 'high' }],
      orderTotal: 190.84,
      orderSubtotal: 127.98,
      orderShipping: 62.86,
      orderCurrency: 'pln',
    })
    const { items, order } = parseExtractionResult(text)
    expect(items).toHaveLength(1)
    expect(order).toEqual({ orderTotal: 190.84, subtotal: 127.98, shipping: 62.86, currency: 'PLN' })
  })

  it('tolerates totals delivered as on-screen strings (PL comma + currency symbol)', () => {
    const text = JSON.stringify({
      items: [{ name: 'X', quantity: 1, bundle: false, confidence: 'low' }],
      orderTotal: '190,84 zł',
    })
    expect(parseExtractionResult(text).order.orderTotal).toBe(190.84)
  })

  it('leaves every order total undefined when none are shown', () => {
    const text = JSON.stringify({ items: [{ name: 'X', quantity: 1, bundle: false, confidence: 'low' }] })
    expect(parseExtractionResult(text).order).toEqual({})
  })

  it('never throws on malformed JSON — empty items and empty order', () => {
    expect(parseExtractionResult('not json')).toEqual({ items: [], order: {} })
  })
})

describe('landedFactor', () => {
  it('returns orderTotal / items subtotal, weighting each line by quantity', () => {
    const items = [item({ unitPrice: 10, quantity: 2 }), item({ unitPrice: 20, quantity: 1 })] // subtotal 40
    expect(landedFactor(items, 60)).toBeCloseTo(1.5, 10)
  })
  it('is undefined when there is no usable order total', () => {
    expect(landedFactor([item({ unitPrice: 10 })], undefined)).toBeUndefined()
    expect(landedFactor([item({ unitPrice: 10 })], 0)).toBeUndefined()
  })
  it('is undefined when any item lacks a price (subtotal is unknowable)', () => {
    expect(landedFactor([item({ unitPrice: 10 }), item({ unitPrice: undefined })], 50)).toBeUndefined()
  })
  it('is undefined when a non-PLN currency is present (cannot mix with a zł total)', () => {
    expect(landedFactor([item({ unitPrice: 10, currency: 'USD' })], 50)).toBeUndefined()
  })
  it('is undefined for an empty list', () => {
    expect(landedFactor([], 50)).toBeUndefined()
  })
})

describe('allocateLandedCosts', () => {
  it('scales equal-priced items so the line totals sum to the order total (AliExpress shoes case)', () => {
    const items = [item({ name: 'Brown', unitPrice: 63.99 }), item({ name: 'black', unitPrice: 63.99 })]
    const out = allocateLandedCosts(items, 190.84)
    expect(out.map((i) => i.unitPrice)).toEqual([95.42, 95.42])
    expect(sumLineTotals(out)).toBeCloseTo(190.84, 10)
  })

  it('allocates proportionally by price for mixed-price items', () => {
    const items = [item({ name: 'coat', unitPrice: 100 }), item({ name: 'socks', unitPrice: 20 })]
    const out = allocateLandedCosts(items, 150) // 30 shipping spread by value
    expect(out.map((i) => i.unitPrice)).toEqual([125, 25])
    expect(sumLineTotals(out)).toBeCloseTo(150, 10)
  })

  it('weights by quantity (a 2-pack line bears twice the share at equal unit price)', () => {
    const items = [item({ name: 'A', unitPrice: 10, quantity: 2 }), item({ name: 'B', unitPrice: 20, quantity: 1 })]
    const out = allocateLandedCosts(items, 60) // subtotal 40, factor 1.5
    expect(out.map((i) => i.unitPrice)).toEqual([15, 30])
    expect(sumLineTotals(out)).toBeCloseTo(60, 10)
  })

  it('distributes the rounding remainder so the total still matches to the grosz', () => {
    const items = [item({ unitPrice: 10 }), item({ unitPrice: 10 }), item({ unitPrice: 10 })]
    const out = allocateLandedCosts(items, 35) // factor 1.1667 -> 11.67 each = 35.01; last absorbs -0.01
    expect(out.map((i) => i.unitPrice)).toEqual([11.67, 11.67, 11.66])
    expect(sumLineTotals(out)).toBeCloseTo(35, 10)
  })

  it('preserves non-price fields and keeps priceText as the original on-screen read', () => {
    const [out] = allocateLandedCosts([item({ name: 'X', unitPrice: 50, priceText: '50 zł', color: 'red', size: 'M' })], 60)
    expect(out).toMatchObject({ name: 'X', color: 'red', size: 'M', priceText: '50 zł', unitPrice: 60 })
  })

  it('scales costs DOWN when the order total is below the items subtotal (coupon/coins)', () => {
    const items = [item({ unitPrice: 100 }), item({ unitPrice: 100 })] // subtotal 200
    const out = allocateLandedCosts(items, 180) // paid less than the sum of item prices
    expect(out.map((i) => i.unitPrice)).toEqual([90, 90])
    expect(sumLineTotals(out)).toBeCloseTo(180, 10)
  })

  it('returns prices unchanged when allocation cannot apply', () => {
    const ok = [item({ unitPrice: 63.99 }), item({ unitPrice: 63.99 })]
    expect(allocateLandedCosts(ok, undefined).map((i) => i.unitPrice)).toEqual([63.99, 63.99])
    expect(allocateLandedCosts([item({ unitPrice: 10 }), item({ unitPrice: undefined })], 50).map((i) => i.unitPrice)).toEqual([10, undefined])
    expect(allocateLandedCosts([item({ unitPrice: 10, currency: 'USD' })], 50).map((i) => i.unitPrice)).toEqual([10])
  })

  it('reconciles exactly when at least one line has quantity 1, even if another line has quantity > 1', () => {
    const out = allocateLandedCosts([item({ unitPrice: 10, quantity: 1 }), item({ unitPrice: 10, quantity: 2 })], 38)
    expect(sumLineTotals(out)).toBeCloseTo(38, 10) // reszta paruje na pozycji o ilości 1
  })

  it('leaves only a small bounded residual when every line has quantity > 1 (exact hit is impossible)', () => {
    const out = allocateLandedCosts([item({ unitPrice: 10, quantity: 3 })], 35)
    // Jedna cena za sztukę × 3 nie trafi w 35 co do grosza; reszta ograniczona do ~ilość groszy.
    expect(Math.abs(sumLineTotals(out) - 35)).toBeLessThanOrEqual(0.01 * 3)
  })

  it('reconciles to the grosz when a coupon scales costs down with a remainder (positive drift)', () => {
    const out = allocateLandedCosts([item({ unitPrice: 10 }), item({ unitPrice: 10 }), item({ unitPrice: 10 })], 25)
    expect(out.map((i) => i.unitPrice)).toEqual([8.33, 8.33, 8.34])
    expect(sumLineTotals(out)).toBeCloseTo(25, 10)
  })

  it('never produces a negative unit cost (clamps the drift adjustment)', () => {
    const out = allocateLandedCosts(
      [item({ unitPrice: 1 }), item({ unitPrice: 1 }), item({ unitPrice: 1 }), item({ unitPrice: 0.01 })],
      0.02,
    )
    expect(out.every((i) => (i.unitPrice ?? 0) >= 0)).toBe(true)
  })

  it('does not mutate the input items', () => {
    const input = [item({ unitPrice: 63.99 }), item({ unitPrice: 63.99 })]
    allocateLandedCosts(input, 190.84)
    expect(input.map((i) => i.unitPrice)).toEqual([63.99, 63.99])
  })
})
