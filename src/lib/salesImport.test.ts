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

import { parseSalesCsv } from '@/lib/salesImport'

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
})
