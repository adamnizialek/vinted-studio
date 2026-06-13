import { describe, it, expect } from 'vitest'
import { parsePlNumber, parsePlDate } from '@/lib/salesImport'

describe('parsePlNumber', () => {
  it('parses comma decimals', () => {
    expect(parsePlNumber('22,4')).toBe(22.4)
    expect(parsePlNumber('350,56')).toBe(350.56)
  })

  it('parses plain integers', () => {
    expect(parsePlNumber('83')).toBe(83)
  })

  it('returns undefined for empty / non-numeric', () => {
    expect(parsePlNumber('')).toBeUndefined()
    expect(parsePlNumber(undefined)).toBeUndefined()
    expect(parsePlNumber('—')).toBeUndefined()
  })

  it('extracts the number from a noisy cell', () => {
    expect(parsePlNumber('0 (zwrot)')).toBe(0)
  })
})

describe('parsePlDate', () => {
  it('parses DD.MM.YYYY at local noon', () => {
    const ts = parsePlDate('13.01.2026')
    expect(ts).not.toBeNull()
    const d = new Date(ts as number)
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(0)
    expect(d.getDate()).toBe(13)
    expect(d.getHours()).toBe(12)
  })

  it('rejects malformed or out-of-range dates', () => {
    expect(parsePlDate('25.01.22026')).toBeNull()
    expect(parsePlDate('')).toBeNull()
    expect(parsePlDate('foo')).toBeNull()
    expect(parsePlDate('13.13.2026')).toBeNull()
    expect(parsePlDate('30.02.2026')).toBeNull()
  })
})

import { parseSalesCsv, parseSalesTable } from '@/lib/salesImport'

const MAIN_FIXTURE = [
  'Data sprzedaży,Nazwa,Cena zaukupu ,Cena Sprzedaży,Kolumna nr 1,Przychód,Dochód,,Wydatki',
  '14.01.2026,Szalik kości,"22,4",55,,"12742,16","8923,13",,"3819,03"',
  '13.01.2026,Szare spodnie narsiarskie XXXL,"59,39","350,56",Q2,"2359,25",,,',
  '30.01.2026,Ekspozycja,"18,1",,,,,,',
  '25.01.2026,Podbicia,"21,81",,,,,,',
  '01.02.2024,Czarne spodnie narsiarskie XXXL,83,"278,34",,,,,',
  ',,,,,,,,',
].join('\n')

describe('parseSalesCsv', () => {
  const sheet = parseSalesCsv(MAIN_FIXTURE)

  it('detects headers and skips the blank separator row', () => {
    expect(sheet.headerDetected).toBe(true)
    expect(sheet.rows).toHaveLength(5) // blank row dropped
  })

  it('maps a clean row and ignores aggregate columns', () => {
    const r = sheet.rows[0]
    expect(r.productName).toBe('Szalik kości')
    expect(r.purchaseCost).toBe(22.4)
    expect(r.salePrice).toBe(55)
    expect(r.bucket).toBe('ready')
    expect(r.dateTs).not.toBeNull()
  })

  it('parses quoted comma decimals in both price columns', () => {
    const r = sheet.rows[1]
    expect(r.purchaseCost).toBe(59.39)
    expect(r.salePrice).toBe(350.56)
    expect(r.bucket).toBe('ready')
  })

  it('excludes boost/expense rows (Ekspozycja, Podbicia)', () => {
    const excluded = sheet.rows.filter((r) => r.bucket === 'excluded')
    expect(excluded.map((r) => r.productName).sort()).toEqual(['Ekspozycja', 'Podbicia'])
    expect(excluded.every((r) => r.excludedReason === 'fee')).toBe(true)
  })

  it('keeps a 2024-dated row as ready (no false "suspicious year")', () => {
    const r = sheet.rows.find((x) => x.productName.startsWith('Czarne'))!
    expect(r.bucket).toBe('ready')
    expect(r.salePrice).toBe(278.34)
  })

  it('falls back to positional columns when headers are unknown', () => {
    const csv = '1,2,3,4\n10.01.2026,Czapka,30,80'
    const s = parseSalesCsv(csv)
    expect(s.headerDetected).toBe(false)
    expect(s.rows[0]).toMatchObject({ productName: 'Czapka', purchaseCost: 30, salePrice: 80, bucket: 'ready' })
  })

  it('parseSalesTable classifies a pre-tokenized table directly (XLSX path)', () => {
    const { rows, headerDetected } = parseSalesTable([
      ['Data sprzedaży', 'Nazwa', 'Cena zakupu', 'Cena Sprzedaży'],
      ['15.03.2024', 'Foo', '10', '40'],
    ])
    expect(headerDetected).toBe(true)
    expect(rows).toHaveLength(1)
    expect(rows[0].bucket).toBe('ready')
    expect(rows[0].salePrice).toBe(40)
  })
})

describe('parseSalesCsv classification edge cases', () => {
  const HEADER = 'Data sprzedaży,Nazwa,Cena zaukupu,Cena Sprzedaży'

  it('routes a row with no sale price to review', () => {
    const r = parseSalesCsv(`${HEADER}\n10.01.2026,Czapka,30,`).rows[0]
    expect(r.bucket).toBe('review')
    expect(r.issues).toContain('Brak ceny sprzedaży')
  })

  it('routes a row with no name to review', () => {
    const r = parseSalesCsv(`${HEADER}\n10.01.2026,,30,80`).rows[0]
    expect(r.bucket).toBe('review')
    expect(r.issues).toContain('Brak nazwy')
  })

  it('routes a row with a missing date to review', () => {
    const r = parseSalesCsv(`${HEADER}\n,Czapka,30,80`).rows[0]
    expect(r.bucket).toBe('review')
    expect(r.issues).toContain('Brak lub niepoprawna data')
  })

  it('marks a (zwrot) row as returned while still ready', () => {
    const r = parseSalesCsv(`${HEADER}\n10.01.2026,Kurtka (zwrot),30,80`).rows[0]
    expect(r.bucket).toBe('ready')
    expect(r.status).toBe('returned')
  })
})

import { saleImportKey, dedupKeyed, type KeyedDraft } from '@/lib/salesImport'

describe('saleImportKey', () => {
  it('is stable and normalizes name + date to the day', () => {
    const ts = parsePlDate('13.01.2026') as number
    const a = saleImportKey('acc1', ts, '  Szalik  Kości ', 55, 22.4)
    const b = saleImportKey('acc1', ts, 'szalik kości', 55, 22.4)
    expect(a).toBe(b)
  })

  it('differs when account, price or name differ', () => {
    const ts = parsePlDate('13.01.2026') as number
    expect(saleImportKey('acc1', ts, 'x', 55, 1)).not.toBe(saleImportKey('acc2', ts, 'x', 55, 1))
    expect(saleImportKey('acc1', ts, 'x', 55, 1)).not.toBe(saleImportKey('acc1', ts, 'x', 56, 1))
  })
})

describe('dedupKeyed (multiset diff)', () => {
  const mk = (key: string): KeyedDraft => ({
    key,
    draft: { soldAt: 0, productName: key, salePrice: 1, status: 'completed' },
  })

  it('inserts only the difference over existing counts', () => {
    const existing = new Map<string, number>([['A', 1]])
    const { toInsert, skipped } = dedupKeyed(existing, [mk('A'), mk('A'), mk('B')])
    expect(toInsert.map((k) => k.key)).toEqual(['A', 'B']) // one A absorbed by existing
    expect(skipped).toBe(1)
  })

  it('inserts everything when nothing exists', () => {
    const { toInsert, skipped } = dedupKeyed(new Map(), [mk('A'), mk('A')])
    expect(toInsert).toHaveLength(2)
    expect(skipped).toBe(0)
  })
})

import { expenseKindOf, parseExpenseDrafts, expenseImportKey } from '@/lib/salesImport'

describe('expenseKindOf', () => {
  it('maps boost/exposure names, else other', () => {
    expect(expenseKindOf('Podbicia')).toBe('boost')
    expect(expenseKindOf('Podbicia main')).toBe('boost')
    expect(expenseKindOf('podbica')).toBe('boost')
    expect(expenseKindOf('Ekspozycja')).toBe('exposure')
    expect(expenseKindOf('Pakowanie')).toBe('other')
  })
})

describe('parseExpenseDrafts', () => {
  const CSV = [
    'Data sprzedaży,Nazwa,Cena zaukupu,Cena Sprzedaży',
    '14.01.2026,Szalik kości,"22,4",55', // sprzedaż — nie koszt
    '30.01.2026,Ekspozycja,"18,1",', // koszt 18.10 (ekspozycja)
    '31.01.2026,Podbicia main,"34,39",', // koszt 34.39 (boost)
    ',Podbicia,,', // bez kwoty → pominięte
  ].join('\n')

  it('extracts fee rows that have an amount, deriving kind + date', () => {
    const { rows } = parseSalesCsv(CSV)
    const drafts = parseExpenseDrafts(rows)
    expect(drafts).toHaveLength(2)
    expect(drafts[0]).toMatchObject({ kind: 'exposure', amount: 18.1, description: 'Ekspozycja' })
    expect(drafts[1]).toMatchObject({ kind: 'boost', amount: 34.39 })
    expect(drafts[0].incurredAt).not.toBeNull()
  })

  it('skips fee rows with no amount', () => {
    const { rows } = parseSalesCsv(CSV)
    const drafts = parseExpenseDrafts(rows)
    expect(drafts.find((d) => d.description === 'Podbicia')).toBeUndefined()
  })
})

describe('expenseImportKey', () => {
  it('is stable under whitespace/case in the description', () => {
    const a = expenseImportKey('acc', 1769000000000, 'exposure', 'Ekspozycja ', 18.1)
    const b = expenseImportKey('acc', 1769000000000, 'exposure', 'ekspozycja', 18.1)
    expect(a).toBe(b)
  })
})

import { suggestAccountForSheet, looksLikeStockSheet } from '@/lib/salesImport'

describe('suggestAccountForSheet', () => {
  const accounts = [
    { id: 'acc-pangea', name: 'pangea', notes: 'main' },
    { id: 'acc-zoos', name: 'zoos07' },
  ]

  it('matches a file named "Main" to the account whose note is "main"', () => {
    expect(suggestAccountForSheet('Main.xlsx', accounts)).toBe('acc-pangea')
  })

  it('matches "Zoos" / "zoos07 …" to "zoos07" by substring', () => {
    expect(suggestAccountForSheet('Zoos.xlsx', accounts)).toBe('acc-zoos')
    expect(suggestAccountForSheet('zoos07 sprzedaż.csv', accounts)).toBe('acc-zoos')
  })

  it('returns undefined when two accounts match the same word', () => {
    const ambiguous = [
      { id: 'a', name: 'sklep ania' },
      { id: 'b', name: 'sklep zosia' },
    ]
    expect(suggestAccountForSheet('sklep.xlsx', ambiguous)).toBeUndefined()
  })

  it('returns undefined when nothing matches', () => {
    expect(suggestAccountForSheet('raport-2026.xlsx', accounts)).toBeUndefined()
  })

  it('ignores tiny words and the file extension', () => {
    expect(suggestAccountForSheet('a.csv', accounts)).toBeUndefined()
  })

  it('matches when a file word contains a short account field (reverse substring)', () => {
    expect(suggestAccountForSheet('pangea-raport.xlsx', [{ id: 'p', name: 'pan' }])).toBe('p')
  })
})

describe('looksLikeStockSheet', () => {
  it('is true when a header has a "Miesiąc" column (finessin)', () => {
    expect(
      looksLikeStockSheet(['Data sprzedaży', 'Miesiąc', 'Nazwa przedmiotu', 'Cena zakupu', 'Cena sprzedaży']),
    ).toBe(true)
  })

  it('is diacritic-insensitive', () => {
    expect(looksLikeStockSheet(['data', 'miesiac', 'nazwa'])).toBe(true)
  })

  it('is false for the Main/Zoos sales header', () => {
    expect(looksLikeStockSheet(['Data sprzedaży', 'Nazwa', 'Cena zaukupu', 'Cena Sprzedaży'])).toBe(false)
  })
})
