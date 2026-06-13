import { describe, it, expect } from 'vitest'
import { parseStockCsv, normalizeForMatch, matchAccounts } from '@/lib/stockImport'

// Realny kształt eksportu z arkusza `finessin` (8 kolumn; komórki z przecinkiem w cudzysłowie).
// Wiersze niesprzedane mają pustą datę, znacznik `rrrr-12` w kolumnie Miesiąc i PUSTĄ cenę sprzedaży.
const FINESSIN = [
  'Data sprzedaży,Miesiąc,Nazwa przedmiotu,Cena zakupu,Cena sprzedaży,Zysk,Zysk z poprzedniego arkusza,Aktualny zysk',
  '14.01.2026,rrrr-01,Szalik kości MD175497,"22,4",55,"32,6","1 700zł","11077,78"', // sprzedane
  ',rrrr-12,Koszulka Messi,35,,-35,,', // magazyn
  ',rrrr-12,Koszulka Messi,35,,-35,,', // magazyn (duplikat)
  ',rrrr-12,Bluza zebra AX10247937,"42,92",,"-42,92",,', // magazyn
  '25.01.2026,rrrr-01,Bluza zebra AX10247937,"42,92",140,"97,08",,', // sprzedane
  '31.01.2026,rrrr-01,Podbicia main,"34,39",,"-34,39",,', // opłata
  ',rrrr-12,Czarne spodnie narsiarskie XXXL,83,,-83,,', // magazyn
  ',rrrr-12,0,,,,,', // śmieć (nazwa bez liter) → pominięte
].join('\n')

describe('parseStockCsv', () => {
  it('classifies finessin rows into stock / sold / excluded and skips junk', () => {
    const rows = parseStockCsv(FINESSIN)
    expect(rows.filter((r) => r.bucket === 'stock')).toHaveLength(4)
    expect(rows.filter((r) => r.bucket === 'sold')).toHaveLength(2)
    expect(rows.filter((r) => r.bucket === 'excluded')).toHaveLength(1)
    expect(rows).toHaveLength(7) // wiersz "0" pominięty (null)
  })

  it('reads name + purchase and leaves sale price empty for an unsold row', () => {
    const rows = parseStockCsv(FINESSIN)
    const messi = rows.find((r) => r.name === 'Koszulka Messi')!
    expect(messi.bucket).toBe('stock')
    expect(messi.purchaseCost).toBe(35)
    expect(messi.salePrice).toBeUndefined()
  })

  it('falls back to finessin column positions when headers are unrecognizable', () => {
    const noHeader = [
      'x,y,z,a,b,c,d,e',
      ',rrrr-12,Naszyjnik kościotrup XA20749,"4,38",,"-4,38",,',
    ].join('\n')
    const rows = parseStockCsv(noHeader)
    expect(rows).toHaveLength(1)
    expect(rows[0].bucket).toBe('stock')
    expect(rows[0].name).toBe('Naszyjnik kościotrup XA20749')
  })
})

describe('normalizeForMatch', () => {
  it('strips SKU-like codes but keeps size tokens and words', () => {
    expect(normalizeForMatch('Bluza zebra AX10247937')).toBe('bluza zebra')
    expect(normalizeForMatch('Szalik kości MD175497')).toBe('szalik kości')
    expect(normalizeForMatch('Zegarek damski róż sj2306109140799009')).toBe('zegarek damski róż')
    expect(normalizeForMatch('Czarne spodnie narsiarskie XXXL')).toBe('czarne spodnie narsiarskie xxxl')
    expect(normalizeForMatch('  Koszulka   Messi ')).toBe('koszulka messi')
  })
})

describe('matchAccounts', () => {
  const sales = [
    { productName: 'Bluza zebra AX10247937', accountId: 'acc-main' },
    { productName: 'Czarne spodnie narsiarskie XXXL', accountId: 'acc-main' },
    { productName: 'Czarne spodnie narsiarskie XXXL', accountId: 'acc-zoos' },
  ]

  it('assigns when exactly one account sold the name', () => {
    const [m] = matchAccounts([{ name: 'Bluza zebra AX10247937' }], sales)
    expect(m.confidence).toBe('single')
    expect(m.accountId).toBe('acc-main')
  })

  it('flags ambiguous when two accounts sold the name', () => {
    const [m] = matchAccounts([{ name: 'Czarne spodnie narsiarskie XXXL' }], sales)
    expect(m.confidence).toBe('ambiguous')
    expect(m.accountId).toBeUndefined()
    expect(m.candidates).toHaveLength(2)
    expect(m.candidates).toContain('acc-main')
    expect(m.candidates).toContain('acc-zoos')
  })

  it('flags none when no account sold the name', () => {
    const [m] = matchAccounts([{ name: 'Koszulka Messi' }], sales)
    expect(m.confidence).toBe('none')
    expect(m.accountId).toBeUndefined()
    expect(m.candidates).toHaveLength(0)
  })

  it('ignores sales with no accountId when building the index', () => {
    const [m] = matchAccounts([{ name: 'Top free' }], [{ productName: 'Top free', accountId: undefined }])
    expect(m.confidence).toBe('none')
  })
})
