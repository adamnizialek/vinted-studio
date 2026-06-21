import { describe, it, expect } from 'vitest'
import {
  parsePromotionResponse,
  promotionFlags,
  labelToKind,
  normalizeDuration,
  PROMOTION_SCHEMA,
  PROMOTION_PROMPT,
  type PromotionDraft,
} from '@/lib/promotionScreenshot'

const draft = (over: Partial<PromotionDraft> = {}): PromotionDraft => ({
  label: 'PODBICIE',
  kind: 'boost',
  amount: 5,
  currency: 'PLN',
  durationDays: 3,
  confidence: 0.9,
  ...over,
})

describe('labelToKind', () => {
  it('maps each Vinted label to an ExpenseKind', () => {
    expect(labelToKind('PODBICIE')).toBe('boost')
    expect(labelToKind('EKSPOZYCJA_SZAFY')).toBe('exposure')
    expect(labelToKind('UNKNOWN')).toBe('other')
  })
})

describe('normalizeDuration', () => {
  it('keeps 3 or 7 for promotion kinds', () => {
    expect(normalizeDuration('boost', 3)).toBe(3)
    expect(normalizeDuration('boost', 7)).toBe(7)
    expect(normalizeDuration('exposure', 7)).toBe(7)
  })

  it('drops odd durations (OCR noise) for promotion kinds', () => {
    expect(normalizeDuration('boost', 5)).toBeUndefined()
    expect(normalizeDuration('exposure', 1)).toBeUndefined()
  })

  it('drops any duration for the non-promotion kind', () => {
    expect(normalizeDuration('other', 3)).toBeUndefined()
    expect(normalizeDuration('other', 7)).toBeUndefined()
  })

  it('passes through undefined', () => {
    expect(normalizeDuration('boost', undefined)).toBeUndefined()
  })
})

describe('parsePromotionResponse', () => {
  it('parses a bump (podbicie) receipt', () => {
    const r = parsePromotionResponse(
      JSON.stringify({ label: 'PODBICIE', amount: 5, rawAmountText: '5,00 zł', currency: 'PLN', durationDays: 3, confidence: 0.9 }),
    )
    expect(r).toMatchObject({ label: 'PODBICIE', kind: 'boost', amount: 5, currency: 'PLN', durationDays: 3, confidence: 0.9 })
    expect(r.rawAmountText).toBe('5,00 zł')
  })

  it('parses a wardrobe (ekspozycja szafy) receipt', () => {
    const r = parsePromotionResponse(
      JSON.stringify({ label: 'EKSPOZYCJA_SZAFY', amount: 14.95, rawAmountText: '14,95 zł', durationDays: 7, confidence: 0.8 }),
    )
    expect(r).toMatchObject({ label: 'EKSPOZYCJA_SZAFY', kind: 'exposure', amount: 14.95, durationDays: 7 })
  })

  it('prefers the verbatim rawAmountText over the model numeric amount', () => {
    const r = parsePromotionResponse(JSON.stringify({ label: 'EKSPOZYCJA_SZAFY', amount: 1495, rawAmountText: '14,95 zł', confidence: 0.7 }))
    expect(r.amount).toBe(14.95)
  })

  it('falls back to numeric amount when rawAmountText is absent', () => {
    const r = parsePromotionResponse(JSON.stringify({ label: 'PODBICIE', amount: 4.5, confidence: 0.7 }))
    expect(r.amount).toBe(4.5)
  })

  it('parses a fenced ```json block', () => {
    const r = parsePromotionResponse('```json\n{"label":"PODBICIE","rawAmountText":"6,00 zł","confidence":0.6}\n```')
    expect(r.amount).toBe(6)
    expect(r.kind).toBe('boost')
  })

  it('handles Polish thousands-space + comma decimal', () => {
    const r = parsePromotionResponse(JSON.stringify({ label: 'EKSPOZYCJA_SZAFY', rawAmountText: '1 234,56 zł', confidence: 0.5 }))
    expect(r.amount).toBe(1234.56)
  })

  it('treats zero / negative amounts as missing', () => {
    expect(parsePromotionResponse(JSON.stringify({ label: 'PODBICIE', rawAmountText: '0,00 zł', confidence: 0.9 })).amount).toBeUndefined()
    expect(parsePromotionResponse(JSON.stringify({ label: 'PODBICIE', amount: -5, confidence: 0.9 })).amount).toBeUndefined()
  })

  it('coerces durationDays to a positive integer or undefined', () => {
    expect(parsePromotionResponse(JSON.stringify({ label: 'PODBICIE', durationDays: '7', confidence: 0.9 })).durationDays).toBe(7)
    expect(parsePromotionResponse(JSON.stringify({ label: 'PODBICIE', durationDays: 'siedem', confidence: 0.9 })).durationDays).toBeUndefined()
    expect(parsePromotionResponse(JSON.stringify({ label: 'PODBICIE', durationDays: 0, confidence: 0.9 })).durationDays).toBeUndefined()
  })

  it('clamps confidence to [0,1] and defaults to 0', () => {
    expect(parsePromotionResponse(JSON.stringify({ label: 'PODBICIE', confidence: 1.5 })).confidence).toBe(1)
    expect(parsePromotionResponse(JSON.stringify({ label: 'PODBICIE', confidence: -0.2 })).confidence).toBe(0)
    expect(parsePromotionResponse(JSON.stringify({ label: 'PODBICIE', confidence: 'abc' })).confidence).toBe(0)
    expect(parsePromotionResponse(JSON.stringify({ label: 'PODBICIE' })).confidence).toBe(0)
  })

  it('coerces the label (case-insensitive) and falls back to UNKNOWN', () => {
    expect(parsePromotionResponse(JSON.stringify({ label: 'podbicie', confidence: 0.9 })).label).toBe('PODBICIE')
    expect(parsePromotionResponse(JSON.stringify({ label: 'wardrobe', confidence: 0.9 })).label).toBe('UNKNOWN')
    expect(parsePromotionResponse(JSON.stringify({ amount: 5, confidence: 0.9 })).label).toBe('UNKNOWN')
    expect(parsePromotionResponse(JSON.stringify({ label: 'wardrobe', confidence: 0.9 })).kind).toBe('other')
  })

  it('upper-cases the currency', () => {
    expect(parsePromotionResponse(JSON.stringify({ label: 'PODBICIE', currency: 'pln', confidence: 0.9 })).currency).toBe('PLN')
    expect(parsePromotionResponse(JSON.stringify({ label: 'PODBICIE', currency: 'usd', confidence: 0.9 })).currency).toBe('USD')
  })

  it('returns a safe default for garbage / non-object input and never throws', () => {
    for (const junk of ['', '   ', 'lol not json', '[1,2,3]', '{', 'null', '42']) {
      expect(() => parsePromotionResponse(junk)).not.toThrow()
      const r = parsePromotionResponse(junk)
      expect(r.label).toBe('UNKNOWN')
      expect(r.kind).toBe('other')
      expect(r.amount).toBeUndefined()
      expect(r.confidence).toBe(0)
    }
  })
})

describe('promotionFlags', () => {
  it('flags an unknown type', () => {
    expect(promotionFlags(draft({ label: 'UNKNOWN', kind: 'other' })).unknownType).toBe(true)
    expect(promotionFlags(draft()).unknownType).toBe(false)
  })

  it('flags a missing amount', () => {
    expect(promotionFlags(draft({ amount: undefined })).noAmount).toBe(true)
    expect(promotionFlags(draft({ amount: 5 })).noAmount).toBe(false)
  })

  it('flags low confidence below 0.6', () => {
    expect(promotionFlags(draft({ confidence: 0.5 })).lowConfidence).toBe(true)
    expect(promotionFlags(draft({ confidence: 0.6 })).lowConfidence).toBe(false)
  })

  it('flags an implausible amount for the recognized type', () => {
    expect(promotionFlags(draft({ kind: 'boost', amount: 35 })).amountOutOfRange).toBe(true)
    expect(promotionFlags(draft({ kind: 'boost', amount: 5 })).amountOutOfRange).toBe(false)
    expect(promotionFlags(draft({ kind: 'exposure', amount: 150 })).amountOutOfRange).toBe(true)
    expect(promotionFlags(draft({ kind: 'exposure', amount: 2 })).amountOutOfRange).toBe(true)
    expect(promotionFlags(draft({ kind: 'exposure', amount: 14.95 })).amountOutOfRange).toBe(false)
    expect(promotionFlags(draft({ kind: 'other', amount: 999 })).amountOutOfRange).toBe(false)
  })

  it('flags an odd duration (not 3 or 7 days)', () => {
    expect(promotionFlags(draft({ durationDays: 5 })).durationOdd).toBe(true)
    expect(promotionFlags(draft({ durationDays: 3 })).durationOdd).toBe(false)
    expect(promotionFlags(draft({ durationDays: 7 })).durationOdd).toBe(false)
    expect(promotionFlags(draft({ durationDays: undefined })).durationOdd).toBe(false)
  })

  it('flags a label/amount mismatch', () => {
    // ~15 zł reads like a wardrobe spotlight, not a bump
    expect(promotionFlags(draft({ kind: 'boost', amount: 14.95 })).labelAmountMismatch).toBe(true)
    expect(promotionFlags(draft({ kind: 'boost', amount: 5 })).labelAmountMismatch).toBe(false)
    // ~5 zł reads like a bump, not a wardrobe spotlight
    expect(promotionFlags(draft({ kind: 'exposure', amount: 5 })).labelAmountMismatch).toBe(true)
    expect(promotionFlags(draft({ kind: 'exposure', amount: 14.95 })).labelAmountMismatch).toBe(false)
  })

  it('flags a non-PLN currency', () => {
    expect(promotionFlags(draft({ currency: 'USD' })).nonPln).toBe(true)
    expect(promotionFlags(draft({ currency: 'PLN' })).nonPln).toBe(false)
    expect(promotionFlags(draft({ currency: undefined })).nonPln).toBe(false)
  })
})

describe('schema + prompt sanity', () => {
  it('exposes an OBJECT response schema with the enum label', () => {
    expect((PROMOTION_SCHEMA as { type: string }).type).toBe('OBJECT')
    const label = (PROMOTION_SCHEMA as { properties: { label: { enum: string[] } } }).properties.label
    expect(label.enum).toEqual(['PODBICIE', 'EKSPOZYCJA_SZAFY', 'UNKNOWN'])
  })

  it('exposes a non-empty prompt mentioning the Vinted promotion cues', () => {
    expect(typeof PROMOTION_PROMPT).toBe('string')
    expect(PROMOTION_PROMPT.length).toBeGreaterThan(100)
    expect(PROMOTION_PROMPT).toMatch(/szaf/i)
    expect(PROMOTION_PROMPT).toMatch(/podbicie|podbij/i)
  })
})
