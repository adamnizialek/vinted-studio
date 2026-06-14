import { describe, it, expect } from 'vitest'
import {
  parseExtractionResponse,
  extractedToStockDrafts,
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
})
