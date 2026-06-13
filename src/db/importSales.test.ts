import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db, importSales } from '@/db/db'
import { parseSalesCsv, type DraftSale } from '@/lib/salesImport'

// Realny przykład eksportu z Arkuszy (te same dane co w ręcznym smoke-teście planu).
const SAMPLE = [
  'Data sprzedaży,Nazwa,Cena zaukupu ,Cena Sprzedaży,Kolumna nr 1,Przychód,Dochód,,Wydatki',
  '14.01.2026,Szalik kości,"22,4",55,,"12742,16","8923,13",,"3819,03"',
  '13.01.2026,Szare spodnie narsiarskie XXXL,"59,39","350,56",Q2,"2359,25",,,',
  '30.01.2026,Ekspozycja,"18,1",,,,,,',
  ',Czarne spodnie narsiarskie XXL,"62,29",,,,,,',
  '26.04.2026,Tabi 3,"163,58",400,,,,,',
].join('\n')

/** Buduje szkice z wierszy gotowych — tak jak robi to modal dla domyślnie zaznaczonych wierszy. */
function draftsFromReady(text: string): DraftSale[] {
  return parseSalesCsv(text)
    .rows.filter((r) => r.bucket === 'ready')
    .map((r) => ({
      soldAt: r.dateTs as number,
      productName: r.productName,
      salePrice: r.salePrice as number,
      purchaseCost: r.purchaseCost,
      status: r.status,
    }))
}

describe('importSales end-to-end (fake-indexeddb)', () => {
  beforeEach(async () => {
    await db.sales.clear()
    await db.accounts.clear()
  })

  it('classifies the sample sheet into the expected buckets', () => {
    const sheet = parseSalesCsv(SAMPLE)
    expect(sheet.rows.filter((r) => r.bucket === 'ready')).toHaveLength(3)
    expect(sheet.rows.filter((r) => r.bucket === 'excluded')).toHaveLength(1)
    expect(sheet.rows.filter((r) => r.bucket === 'review')).toHaveLength(1)
  })

  it('imports ready rows and is idempotent on re-import', async () => {
    const drafts = draftsFromReady(SAMPLE)
    const accountId = 'acc-test'

    const first = await importSales(drafts, accountId)
    expect(first.inserted).toBe(3)
    expect(first.skippedDuplicates).toBe(0)
    expect(await db.sales.count()).toBe(3)

    // Ponowny import tego samego pliku nie dodaje duplikatów.
    const second = await importSales(drafts, accountId)
    expect(second.inserted).toBe(0)
    expect(second.skippedDuplicates).toBe(3)
    expect(await db.sales.count()).toBe(3)
  })

  it('keeps imports separate per account', async () => {
    const drafts = draftsFromReady(SAMPLE)
    await importSales(drafts, 'acc-a')
    const other = await importSales(drafts, 'acc-b')
    expect(other.inserted).toBe(3) // inne konto → brak kolizji kluczy
    expect(await db.sales.count()).toBe(6)
  })
})
