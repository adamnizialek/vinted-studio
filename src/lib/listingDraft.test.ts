import { describe, it, expect } from 'vitest'
import type { Design, ListingDraft, Product, Sale } from '@/db/types'
import {
  OFFER_LINE,
  TITLE_MAX,
  buildDraftPrompt,
  draftQueue,
  ensureOfferLine,
  parseDraftResponse,
  pasteBlock,
  roundPrice,
  tidyDescription,
  suggestDraftPrice,
  titleForSize,
  unitSizes,
} from './listingDraft'

const product = (over: Partial<Product> = {}): Product => ({
  id: over.id ?? 'p',
  name: 'Kowbojki',
  condition: 'nowy_bez_metki',
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

const design = (over: Partial<Design> = {}): Design => ({
  id: over.id ?? 'd',
  name: 'Plisowane kowbojki damskie',
  tags: [],
  photoIds: ['img1'],
  generatedPhotoIds: [],
  descriptions: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

const sale = (over: Partial<Sale> = {}): Sale => ({
  id: over.id ?? 's',
  productName: 'x',
  salePrice: 100,
  currency: 'PLN',
  quantity: 1,
  status: 'completed',
  soldAt: 1,
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

const draft = (over: Partial<ListingDraft> = {}): ListingDraft => ({
  title: 'kowbojki plisowane czarne damskie',
  description: `${OFFER_LINE}\n\nNowe.`,
  photoIds: [],
  source: 'gemini',
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

describe('draftQueue', () => {
  it('groups unlisted units of a model and overlays its shared fields', () => {
    const d = design()
    const q = draftQueue(
      [
        product({ id: 'a', designId: 'd', sizeLabel: '38' }),
        product({ id: 'b', designId: 'd', sizeLabel: '38', status: 'listed' }),
        product({ id: 'c', designId: 'd', sizeLabel: '37' }),
      ],
      [d],
    )
    expect(q).toHaveLength(1)
    expect(q[0].kind).toBe('design')
    expect(q[0].units.map((u) => u.id)).toEqual(['a', 'c'])
    expect(q[0].members).toHaveLength(3)
    expect(q[0].product.name).toBe(d.name)
    expect(q[0].product.photoIds).toEqual(['img1'])
  })

  it('skips models with nothing waiting and singles that are listed or sold', () => {
    const q = draftQueue(
      [
        product({ id: 'a', designId: 'd', status: 'listed' }),
        product({ id: 'b', status: 'sold' }),
        product({ id: 'c', status: 'listed' }),
        product({ id: 'e' }),
      ],
      [design()],
    )
    expect(q.map((i) => i.key)).toEqual(['e'])
  })

  it('includes ordered units only when asked', () => {
    const products = [product({ id: 'a', status: 'incoming' })]
    expect(draftQueue(products, [])).toHaveLength(0)
    expect(draftQueue(products, [], { includeIncoming: true })).toHaveLength(1)
  })

  it('treats a product whose model is missing (not synced yet) as a single', () => {
    const q = draftQueue([product({ id: 'a', designId: 'gone' })], [])
    expect(q[0].kind).toBe('single')
  })

  it('puts items without a draft first, then the newest', () => {
    const q = draftQueue(
      [
        product({ id: 'old', createdAt: 1 }),
        product({ id: 'new', createdAt: 5 }),
        product({ id: 'done', createdAt: 9, listingDraft: draft() }),
      ],
      [],
    )
    expect(q.map((i) => i.key)).toEqual(['new', 'old', 'done'])
    expect(q[2].draft?.title).toBeTruthy()
  })

  it('reads the draft of a model from the Design', () => {
    const q = draftQueue([product({ designId: 'd' })], [design({ listingDraft: draft({ title: 'z modelu' }) })])
    expect(q[0].draft?.title).toBe('z modelu')
  })
})

describe('unitSizes', () => {
  it('counts sizes in order and blanks the unknown "?"', () => {
    expect(
      unitSizes([product({ sizeLabel: '38' }), product({ sizeLabel: '37' }), product({ sizeLabel: '38' }), product({ sizeLabel: '?' })]),
    ).toEqual([
      ['38', 2],
      ['37', 1],
      ['', 1],
    ])
  })
})

describe('titleForSize', () => {
  it('appends the size once', () => {
    expect(titleForSize('kowbojki czarne', '38')).toBe('kowbojki czarne 38')
    expect(titleForSize('kowbojki czarne 38', '38')).toBe('kowbojki czarne 38')
    expect(titleForSize('kurtka', 'm')).toBe('kurtka m')
    expect(titleForSize('kurtka', '')).toBe('kurtka')
  })

  it('cuts a long base at a word and keeps the size at the end', () => {
    const long = 'spodnie snowboardowe narciarskie damskie męskie wodoodporne ciepłe szerokie'
    const t = titleForSize(long, 'XXXL')
    expect(t.length).toBeLessThanOrEqual(TITLE_MAX)
    expect(t.endsWith(' XXXL')).toBe(true)
    expect(long.startsWith(t.slice(0, -' XXXL'.length))).toBe(true)
  })
})

describe('suggestDraftPrice', () => {
  it('prefers the listing price the owner set', () => {
    expect(suggestDraftPrice([product({ listingPrice: 300, purchasePrice: 100 })], [])).toEqual({
      price: 300,
      minPrice: 255,
      basis: 'listing',
    })
  })

  it('ignores the listing price of sold units', () => {
    const r = suggestDraftPrice([product({ status: 'sold', listingPrice: 999, purchasePrice: 100 })], [])
    expect(r?.basis).toBe('purchase')
  })

  it('uses the median of own completed sales of the model + 12%', () => {
    const members = [product({ id: 'a' }), product({ id: 'b' }), product({ id: 'c' })]
    const sales = [
      sale({ productId: 'a', salePrice: 250 }),
      sale({ productId: 'b', salePrice: 300 }),
      sale({ productId: 'c', salePrice: 320 }),
      sale({ productId: 'c', salePrice: 9999, status: 'cancelled' }),
      sale({ productId: 'other', salePrice: 1 }),
    ]
    expect(suggestDraftPrice(members, sales)).toEqual({ price: 335, minPrice: 300, basis: 'sold' })
  })

  it('falls back to purchase cost × 2.5', () => {
    expect(suggestDraftPrice([product({ purchasePrice: 130.6 })], [])).toEqual({
      price: 325,
      minPrice: 260,
      basis: 'purchase',
    })
  })

  it('returns null with no data', () => {
    expect(suggestDraftPrice([product()], [])).toBeNull()
  })
})

describe('roundPrice', () => {
  it('rounds to 5 from 100 up, to whole złoty below', () => {
    expect(roundPrice(332)).toBe(330)
    expect(roundPrice(333)).toBe(335)
    expect(roundPrice(47.6)).toBe(48)
  })
})

describe('ensureOfferLine', () => {
  it('keeps a description that already invites offers', () => {
    expect(ensureOfferLine('Proponujcie cenę śmiało!\nNowe')).toBe('Proponujcie cenę śmiało!\nNowe')
    expect(ensureOfferLine('Czekam na oferty 🙂 Nowe')).toBe('Czekam na oferty 🙂 Nowe')
  })
  it('prepends the offer line otherwise', () => {
    expect(ensureOfferLine('Nowe kowbojki.')).toBe(`${OFFER_LINE}\n\nNowe kowbojki.`)
  })
})

describe('parseDraftResponse', () => {
  it('parses fenced JSON and normalises fields', () => {
    const r = parseDraftResponse(
      '```json\n{"title":"kowbojki  plisowane","description":"Nowe.","color":" czarny ","material":"","warnings":["kolor?",""]}\n```',
    )
    expect(r).toEqual({
      title: 'kowbojki plisowane',
      description: `${OFFER_LINE}\n\nNowe.`,
      category: undefined,
      color: 'czarny',
      material: undefined,
      warnings: ['kolor?'],
    })
  })

  it('throws a readable error on missing title or bad JSON', () => {
    expect(() => parseDraftResponse('{"description":"x"}')).toThrow(/tytułu/)
    expect(() => parseDraftResponse('nie json')).toThrow(/JSON/)
  })
})

describe('buildDraftPrompt', () => {
  it('lists only filled facts and asks for an offer line', () => {
    const prompt = buildDraftPrompt(
      { product: product({ name: 'Plisowane kowbojki', color: 'black' }), units: [product({ sizeLabel: '38' })] },
      true,
    )
    expect(prompt).toContain('Nazwa ze sklepu: Plisowane kowbojki')
    expect(prompt).toContain('Rozmiary na stanie: 38')
    expect(prompt).toContain(OFFER_LINE)
    expect(prompt).not.toContain('Marka:')
    expect(prompt).not.toContain('brak zdjęcia')
  })

  it('tells the model when there is no photo', () => {
    expect(buildDraftPrompt({ product: product(), units: [product()] }, false)).toContain('brak zdjęcia')
  })
})

describe('pasteBlock', () => {
  it('builds a ready-to-paste block with size, price and the AI reminder', () => {
    const text = pasteBlock(draft({ price: 330, minPrice: 300, category: 'Kobiety > Buty' }), '38', true)
    expect(text).toContain('Tytuł: kowbojki plisowane czarne damskie 38')
    expect(text).toContain('Cena: 330 zł (najniższa oferta: 300 zł)')
    expect(text).toContain('Rozmiar: 38')
    expect(text).toContain('Stan: Nowy bez metki')
    expect(text).toContain('wygenerowane przez AI')
  })
  it('leaves the AI reminder out for real photos', () => {
    expect(pasteBlock(draft(), '', false)).not.toContain('AI')
  })
})

describe('tidyDescription', () => {
  it('splits a one-line answer into offer line, body and hashtags', () => {
    expect(tidyDescription(`${OFFER_LINE} Mam nowe kowbojki. #kowbojki #czarne`)).toBe(
      `${OFFER_LINE}\n\nMam nowe kowbojki.\n\n#kowbojki #czarne`,
    )
  })
  it('leaves an already tidy description alone', () => {
    const d = `${OFFER_LINE}\n\nNowe.\n\n#a #b`
    expect(tidyDescription(d)).toBe(d)
  })
})
