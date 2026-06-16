import { describe, it, expect } from 'vitest'
import type { AppSettings, Product } from '@/db/types'
import {
  buildDescriptionPrompt,
  buildProductFacts,
  buildSeoTitle,
  DESCRIPTION_STYLES,
  styleById,
} from '@/lib/prompts'

const product = (over: Partial<Product>): Product => ({
  id: 'p',
  name: '',
  condition: 'dobry',
  currency: 'PLN',
  quantity: 1,
  status: 'in_stock',
  photoIds: [],
  generatedPhotoIds: [],
  descriptions: [],
  tags: [],
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

const settings = (over: Partial<AppSettings> = {}): AppSettings => ({
  id: 'app',
  geminiApiKey: '',
  textModel: 'gemini-3-flash',
  imageModel: 'gemini-3-pro-image',
  imageResolution: '2K',
  currency: 'PLN',
  appendSignature: false,
  imagesGenerated: 0,
  imageVariants: 1,
  schemaVersion: 4,
  updatedAt: 0,
  ...over,
})

describe('buildSeoTitle — brand dedup (word-boundary aware)', () => {
  it('does not repeat the brand when the name already starts with it', () => {
    // Regresja: "Zara" + "Zara sukienka" dawało "Zara Zara sukienka".
    expect(buildSeoTitle(product({ brand: 'Zara', name: 'Zara sukienka' }))).toBe('Zara sukienka')
  })

  it('drops the brand when it appears as a whole word anywhere in the name', () => {
    expect(buildSeoTitle(product({ brand: 'Nike', name: 'bluza Nike oversize' }))).toBe(
      'bluza Nike oversize',
    )
  })

  it('is case-insensitive when matching the brand against the name', () => {
    expect(buildSeoTitle(product({ brand: 'zara', name: 'Zara sukienka' }))).toBe('Zara sukienka')
  })

  it('keeps the brand when the name does not contain it', () => {
    expect(buildSeoTitle(product({ brand: 'Zara', name: 'sukienka letnia' }))).toBe(
      'Zara sukienka letnia',
    )
  })

  it('does NOT drop the brand when it is only a substring of a different word', () => {
    // "Mango" jest podciągiem "mangowa", ale to inne słowo — marka musi zostać.
    expect(buildSeoTitle(product({ brand: 'Mango', name: 'mangowa sukienka' }))).toBe(
      'Mango mangowa sukienka',
    )
  })
})

describe('buildSeoTitle — assembly & truncation', () => {
  it('assembles brand, name, color, material and size in SEO order', () => {
    const t = buildSeoTitle(
      product({
        brand: 'Reserved',
        name: 'koszula',
        color: 'biała',
        material: 'len',
        sizeLabel: 'M',
      }),
    )
    expect(t).toBe('Reserved koszula biała len rozm. M')
  })

  it('does not duplicate a colour already present as a word in the name', () => {
    expect(buildSeoTitle(product({ name: 'czarna sukienka', color: 'czarna' }))).toBe(
      'czarna sukienka',
    )
  })

  it('returns an empty string for an empty product', () => {
    expect(buildSeoTitle(product({ name: '' }))).toBe('')
  })

  it('truncates to <=70 chars at a word boundary (never mid-word)', () => {
    const words = Array.from({ length: 15 }, (_, i) => `w${i}aaaaaa`) // każde 8 znaków
    const name = words.join(' ')
    const title = buildSeoTitle(product({ name }))

    expect(title.length).toBeLessThanOrEqual(70)
    expect(title.endsWith('…')).toBe(true)
    const body = title.slice(0, -1).trim()
    for (const w of body.split(' ')) {
      expect(words).toContain(w) // każde zachowane słowo jest kompletne
    }
  })

  it('hard-truncates a single over-long word so the title still fits', () => {
    const title = buildSeoTitle(product({ name: 'x'.repeat(100) }))
    expect(title.length).toBeLessThanOrEqual(70)
    expect(title.endsWith('…')).toBe(true)
  })
})

describe('styleById', () => {
  it('resolves a known style id', () => {
    expect(styleById('zwiezly')?.label).toBe('Zwięzły')
  })
  it('returns undefined for an unknown id', () => {
    expect(styleById('nope')).toBeUndefined()
  })
  it('exposes a unique id per defined style', () => {
    const ids = DESCRIPTION_STYLES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('buildProductFacts', () => {
  it('lists provided fields and omits empty ones', () => {
    const facts = buildProductFacts(product({ name: 'sukienka', brand: 'Zara', color: 'czarna' }))
    expect(facts).toContain('Marka: Zara')
    expect(facts).toContain('Kolor: czarna')
    expect(facts).not.toContain('Materiał') // nie podano
  })

  it('formats measurements into a single line', () => {
    const facts = buildProductFacts(
      product({ name: 'spódnica', measurements: { waist: 38, length: 60 } }),
    )
    expect(facts).toMatch(/Wymiary:.*pas 38 cm/)
    expect(facts).toMatch(/Wymiary:.*długość 60 cm/)
  })
})

describe('buildDescriptionPrompt', () => {
  it('includes the style instruction and the product facts', () => {
    const style = styleById('zwiezly')!
    const prompt = buildDescriptionPrompt(product({ name: 'sukienka', brand: 'Zara' }), style, settings())
    expect(prompt).toContain(style.instruction)
    expect(prompt).toContain('Marka: Zara')
  })

  it('appends the signature verbatim only when enabled', () => {
    const style = styleById('zwiezly')!
    const p = product({ name: 'sukienka' })
    const withSig = buildDescriptionPrompt(p, style, settings({ appendSignature: true, signature: 'Wysyłka 24h' }))
    const without = buildDescriptionPrompt(p, style, settings({ appendSignature: false, signature: 'Wysyłka 24h' }))
    expect(withSig).toContain('Wysyłka 24h')
    expect(without).not.toContain('Wysyłka 24h')
  })
})
