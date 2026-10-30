import { describe, it, expect } from 'vitest'
import type { AppSettings, Product } from '@/db/types'
import {
  buildDescriptionPrompt,
  buildEditPrompt,
  buildPhotoPrompt,
  buildProductFacts,
  buildSeoTitle,
  DESCRIPTION_STYLES,
  EDIT_PRESETS,
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
    const words = Array.from({ length: 15 }, (_, i) => `w${i}aaaaaa`) // wiele słów, łączna długość > 70
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

describe('buildPhotoPrompt — footwear true-to-size scale', () => {
  const tryOn = (over: Partial<Product>) =>
    buildPhotoPrompt({ mode: 'tryOn', product: product(over), sceneId: 'studio' })

  it('adds a footwear-scale clause for shoes (category "Buty") anchored to the size label', () => {
    const prompt = tryOn({ name: 'baleriny', category: 'Kobiety / Buty', sizeLabel: '37' })
    expect(prompt).toContain('footwear scale')
    expect(prompt).toContain('size 37')
    expect(prompt).toContain('true-to-size')
    // Positive framing only — image models have no negative-prompt channel and
    // fixate on vivid nouns ("oversized"/"too-big"), which can backfire.
    expect(prompt).toContain('hug the foot')
  })

  it('detects footwear from the insole measurement (footLength) even without a category keyword', () => {
    const prompt = tryOn({ name: 'mokasyny', measurements: { footLength: 24 }, sizeLabel: '38' })
    expect(prompt).toContain('footwear scale')
    expect(prompt).toContain('size 38')
  })

  it('detects footwear from English category words ("Shoes")', () => {
    const prompt = tryOn({ name: 'sneakers', category: 'Women / Shoes', sizeLabel: '40' })
    expect(prompt).toContain('footwear scale')
  })

  it('does NOT add the footwear clause for clothing', () => {
    const prompt = tryOn({ name: 'sukienka', category: 'Kobiety / Ubrania', sizeLabel: 'M' })
    expect(prompt).not.toContain('footwear scale')
    expect(prompt).not.toContain('true-to-size')
  })

  it('does NOT treat bootcut trousers as footwear (false-positive guard)', () => {
    // "bootcut" zawiera "boot", ale to spodnie — kategoria decyduje, nie nazwa.
    const prompt = tryOn({ name: 'spodnie bootcut', category: 'Kobiety / Ubrania' })
    expect(prompt).not.toContain('footwear scale')
  })

  it('does NOT trip on "boot" even when it is a substring of a free-text category', () => {
    // Kategoria to pole dowolne — token-aware detekcja: "bootcut"/"bootleg" to NIE buty.
    expect(tryOn({ name: 'spodnie', category: 'Spodnie bootcut' })).not.toContain('footwear scale')
    expect(tryOn({ name: 'jeansy', category: 'Bootleg jeans' })).not.toContain('footwear scale')
  })

  it('still detects the English boot family as a whole word', () => {
    expect(tryOn({ name: 'kozaki', category: 'Boots' })).toContain('footwear scale')
  })

  it('falls back to the name and variant colour when the category is empty', () => {
    // Import ze zrzutu nie ustawia kategorii — realne nazwy z magazynu właściciela.
    expect(tryOn({ name: 'Damskie botki, prawdziwa skóra', sizeLabel: '37' })).toContain('size 37')
    expect(tryOn({ name: 'Plisowane kowbojki damskie do połowy łydki' })).toContain('footwear scale')
    expect(tryOn({ name: 'Japońskie buty Tabi Ninja damskie' })).toContain('footwear scale')
    expect(tryOn({ name: 'Tabi1', sizeLabel: '39' })).toContain('footwear scale')
    expect(tryOn({ name: 'Ręcznie robione', color: 'Black Men Boots' })).toContain('footwear scale')
    expect(tryOn({ name: 'Klapki basenowe' })).toContain('footwear scale')
    expect(tryOn({ name: 'Sneakersy białe' })).toContain('footwear scale')
  })

  it('does NOT read clothing names as footwear in the name fallback', () => {
    for (const name of [
      'Bluza Adidas',
      'Kapelusz kowbojski',
      'Spodnie bootcut',
      'Kurtka NY M',
      'Szare spodnie narciarskie XXL',
      'Czapka z czaszką',
      'Waist Trainer gorset',
      'Torebka listonoszka z klapką',
      'Skarpetki do sneakersów',
    ]) {
      expect(tryOn({ name }), name).not.toContain('footwear scale')
    }
  })

  it('lets a filled non-footwear category win over a shoe word in the name', () => {
    expect(tryOn({ name: 'Torba na buty', category: 'Torby' })).not.toContain('footwear scale')
  })

  it('detects standalone Polish footwear leaf categories (kozaczki, klapki, adidasy)', () => {
    expect(tryOn({ name: 'kozaczki', category: 'Kozaczki' })).toContain('footwear scale')
    expect(tryOn({ name: 'klapki', category: 'Klapki' })).toContain('footwear scale')
    expect(tryOn({ name: 'adidasy', category: 'Adidasy' })).toContain('footwear scale')
  })

  it('still constrains scale for footwear without a size label (no "size undefined")', () => {
    const prompt = tryOn({ name: 'buty', category: 'Buty' })
    expect(prompt).toContain('footwear scale')
    expect(prompt).not.toContain('undefined')
    expect(prompt).toContain('true-to-size')
  })

  it('does not add the footwear clause in enhance mode (no model, product-only)', () => {
    const prompt = buildPhotoPrompt({
      mode: 'enhance',
      product: product({ name: 'buty', category: 'Buty', sizeLabel: '37' }),
      sceneId: 'studio',
    })
    expect(prompt).not.toContain('footwear scale')
  })
})

describe('buildEditPrompt — positive 5-slot edit template', () => {
  it('anchors to the provided photo and includes the verbatim instruction', () => {
    const p = buildEditPrompt({ instruction: 'zmień tło na jasne studio', isTryOn: false })
    expect(p).toContain('Using the provided photo,')
    expect(p).toContain('zmień tło na jasne studio')
  })

  it('carries an integration clause and a keep-everything-else preserve-list', () => {
    const p = buildEditPrompt({ instruction: 'rozjaśnij', isTryOn: false })
    expect(p).toMatch(/match the current lighting/i)
    expect(p).toMatch(/keep everything else in the image exactly the same/i)
  })

  it('locks model identity ONLY when the source was a try-on (has a person)', () => {
    const tryOn = buildEditPrompt({ instruction: 'x', isTryOn: true })
    const enhance = buildEditPrompt({ instruction: 'x', isTryOn: false })
    expect(tryOn).toContain('the same person')
    expect(enhance).not.toContain('the same person')
    expect(enhance).toContain('the garment exactly') // garment fidelity always locked
  })

  it('does not emit a double period when the instruction already ends with one', () => {
    const p = buildEditPrompt({ instruction: 'zmień tło.', isTryOn: false })
    expect(p).not.toContain('tło..')
    expect(p).toContain('tło.')
  })

  it('strips other trailing terminators (? ! …) so the appended period stays clean', () => {
    expect(buildEditPrompt({ instruction: 'rozjaśnij?', isTryOn: false })).not.toContain('?.')
    expect(buildEditPrompt({ instruction: 'zmień tło!', isTryOn: false })).not.toContain('!.')
    expect(buildEditPrompt({ instruction: 'zmień tło…', isTryOn: false })).not.toContain('….')
  })

  it("exposes positive, uniquely-id'd Polish presets that pre-fill the box", () => {
    expect(EDIT_PRESETS.length).toBeGreaterThanOrEqual(2)
    const ids = EDIT_PRESETS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const c of EDIT_PRESETS) {
      expect(c.label.trim()).not.toBe('')
      expect(c.instruction.trim()).not.toBe('')
      // App-authored scaffolding must be positive — never a naked negation.
      expect(c.instruction.toLowerCase()).not.toMatch(/\b(nie|bez)\b/)
    }
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
