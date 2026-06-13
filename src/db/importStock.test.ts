import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db, importStock } from '@/db/db'
import type { ResolvedStockDraft } from '@/lib/stockImport'

const DRAFTS: ResolvedStockDraft[] = [
  { name: 'Koszulka Messi', purchaseCost: 35 },
  { name: 'Koszulka Messi', purchaseCost: 35 },
  { name: 'Bluza zebra AX10247937', purchaseCost: 42.92, accountId: 'acc-main' },
]

describe('importStock end-to-end (fake-indexeddb)', () => {
  beforeEach(async () => {
    await db.products.clear()
  })

  it('inserts in_stock products and is idempotent on re-import', async () => {
    const first = await importStock(DRAFTS)
    expect(first.inserted).toBe(3)
    expect(first.skippedDuplicates).toBe(0)
    expect(await db.products.count()).toBe(3)

    const second = await importStock(DRAFTS)
    expect(second.inserted).toBe(0)
    expect(second.skippedDuplicates).toBe(3)
    expect(await db.products.count()).toBe(3)
  })

  it('persists the resolved account and the default product shape', async () => {
    await importStock(DRAFTS)
    const all = await db.products.toArray()
    const bluza = all.find((p) => p.name === 'Bluza zebra AX10247937')!
    expect(bluza.accountId).toBe('acc-main')
    expect(bluza.status).toBe('in_stock')
    expect(bluza.condition).toBe('dobry')
    expect(bluza.currency).toBe('PLN')
    expect(bluza.quantity).toBe(1)
    expect(bluza.purchasePrice).toBe(42.92)
    expect(bluza.importKey).toBeTruthy()
    // Konto niedopasowane zostaje puste.
    const messi = all.filter((p) => p.name === 'Koszulka Messi')
    expect(messi).toHaveLength(2)
    expect(messi.every((p) => p.accountId === undefined)).toBe(true)
  })

  it('multiset: re-import with extra copies inserts only the surplus', async () => {
    await importStock([{ name: 'Koszulka Messi', purchaseCost: 35 }, { name: 'Koszulka Messi', purchaseCost: 35 }])
    expect(await db.products.count()).toBe(2)

    const five = Array.from({ length: 5 }, () => ({ name: 'Koszulka Messi', purchaseCost: 35 }))
    const res = await importStock(five)
    expect(res.inserted).toBe(3) // 5 - 2 już istniejące
    expect(res.skippedDuplicates).toBe(2)
    expect(await db.products.count()).toBe(5)
  })
})
