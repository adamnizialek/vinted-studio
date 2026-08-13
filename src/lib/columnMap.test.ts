import { describe, it, expect } from 'vitest'
import {
  detectColumnMap,
  normalizeHeader,
  scoreHeader,
  looksLikeHeaderRow,
  applyOverride,
  type ImportField,
} from '@/lib/columnMap'

const ALL: readonly ImportField[] = ['date', 'name', 'purchase', 'sale']

describe('normalizeHeader', () => {
  it('folds case, diacritics and punctuation', () => {
    expect(normalizeHeader('Cena Sprzedaży')).toBe('cena sprzedazy')
    expect(normalizeHeader('CENA_ZAKUPU')).toBe('cena zakupu')
    expect(normalizeHeader('  Nazwa   ')).toBe('nazwa')
  })

  it('folds the Polish ł, which NFD does not decompose', () => {
    expect(normalizeHeader('Kupiłem')).toBe('kupilem')
  })
})

describe('scoreHeader', () => {
  it('treats "Data sprzedaży" as a date, not a sale price', () => {
    expect(scoreHeader('Data sprzedaży', 'date')).toBeGreaterThan(
      scoreHeader('Data sprzedaży', 'sale'),
    )
  })

  it('treats "Cena sprzedaży" as a sale price despite no date word', () => {
    expect(scoreHeader('Cena sprzedaży', 'sale')).toBeGreaterThan(
      scoreHeader('Cena sprzedaży', 'date'),
    )
  })

  it('scores unrelated headers at zero', () => {
    expect(scoreHeader('Kolumna nr 1', 'sale')).toBe(0)
    expect(scoreHeader('', 'name')).toBe(0)
  })
})

describe('detectColumnMap', () => {
  it('maps the original Polish sheet', () => {
    const header = ['Data sprzedaży', 'Nazwa', 'Cena zaukupu ', 'Cena Sprzedaży']
    expect(detectColumnMap(header, ALL)).toEqual({ date: 0, name: 1, purchase: 2, sale: 3 })
  })

  it('maps the same fields in a DIFFERENT order', () => {
    const header = ['Cena zakupu', 'Nazwa', 'Cena sprzedaży', 'Data']
    expect(detectColumnMap(header, ALL)).toEqual({ purchase: 0, name: 1, sale: 2, date: 3 })
  })

  it('maps English headers', () => {
    const header = ['Date', 'Item', 'Buy price', 'Sell price']
    expect(detectColumnMap(header, ALL)).toEqual({ date: 0, name: 1, purchase: 2, sale: 3 })
  })

  it('never assigns one column to two fields (regression: unsplit header row)', () => {
    // A semicolon file read with the wrong delimiter collapses to ONE cell that
    // contains every keyword. The old detector "recognised" all four fields in it.
    const header = ['Data;Nazwa;Cena zakupu;Cena sprzedaży']
    const map = detectColumnMap(header, ALL)
    const used = Object.values(map)
    expect(new Set(used).size).toBe(used.length)
    expect(used.length).toBe(1)
  })

  it('omits fields the sheet simply does not have', () => {
    const map = detectColumnMap(['Nazwa', 'Cena zakupu'], ALL)
    expect(map.name).toBe(0)
    expect(map.purchase).toBe(1)
    expect(map.sale).toBeUndefined()
    expect(map.date).toBeUndefined()
  })

  it('returns an empty map for headers it cannot read', () => {
    expect(detectColumnMap(['aaa', 'bbb', 'ccc'], ALL)).toEqual({})
  })

  it('only considers the fields it was asked for', () => {
    const map = detectColumnMap(['Data', 'Nazwa', 'Cena zakupu'], ['name', 'purchase'])
    expect(map).toEqual({ name: 1, purchase: 2 })
  })
})

describe('looksLikeHeaderRow', () => {
  it('accepts a row of words', () => {
    expect(looksLikeHeaderRow(['Data', 'Nazwa', 'Cena zakupu'])).toBe(true)
  })

  it('rejects a row that already carries data', () => {
    expect(looksLikeHeaderRow(['01.02.2026', 'Bluza Nike', '35,00'])).toBe(false)
    expect(looksLikeHeaderRow(['Bluza Nike', '35'])).toBe(false)
    expect(looksLikeHeaderRow(['1', '2', '3', '4'])).toBe(false)
  })

  it('rejects an empty row', () => {
    expect(looksLikeHeaderRow([])).toBe(false)
    expect(looksLikeHeaderRow(['', '  '])).toBe(false)
  })

  it('rejects a lone word — too weak to cost the user a real row', () => {
    expect(looksLikeHeaderRow(['Bluza Nike', '', ''])).toBe(false)
  })

  it('accepts unrecognised but word-like headers', () => {
    expect(looksLikeHeaderRow(['kol_a', 'kol_b', 'kol_c'])).toBe(true)
    expect(looksLikeHeaderRow(['x', 'y', 'z', 'a'])).toBe(true)
  })
})

describe('applyOverride', () => {
  it('lets the user win over the detector', () => {
    expect(applyOverride({ name: 0, sale: 1 }, { name: 3 })).toEqual({ name: 3, sale: 1 })
  })

  it('treats -1 as "this column is not in my file"', () => {
    expect(applyOverride({ name: 0, sale: 1 }, { sale: -1 })).toEqual({ name: 0 })
  })

  it('returns the detection untouched when there is no override', () => {
    expect(applyOverride({ name: 0 })).toEqual({ name: 0 })
  })
})
