import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db, importExpenses } from '@/db/db'
import type { DraftExpense } from '@/lib/salesImport'

const drafts: DraftExpense[] = [
  { incurredAt: Date.UTC(2026, 0, 30, 11), description: 'Ekspozycja', amount: 18.1, kind: 'exposure' },
  { incurredAt: Date.UTC(2026, 0, 31, 11), description: 'Podbicia main', amount: 34.39, kind: 'boost' },
  { incurredAt: null, description: 'Podbicia', amount: 12, kind: 'boost' }, // brak daty → pomijane
]

describe('importExpenses (fake-indexeddb)', () => {
  beforeEach(async () => {
    await db.expenses.clear()
    await db.outbox.clear()
  })

  it('inserts dated drafts (skipping undated), with PLN + importKey + outbox', async () => {
    const res = await importExpenses(drafts, 'acc-1')
    expect(res.inserted).toBe(2)
    const rows = await db.expenses.where('accountId').equals('acc-1').toArray()
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.currency === 'PLN' && r.importKey)).toBe(true)
    expect(await db.outbox.where('table').equals('expenses').count()).toBe(2)
  })

  it('is idempotent on re-import (multiset dedup)', async () => {
    await importExpenses(drafts, 'acc-1')
    const second = await importExpenses(drafts, 'acc-1')
    expect(second.inserted).toBe(0)
    expect(second.skippedDuplicates).toBe(2)
    expect(await db.expenses.count()).toBe(2)
  })

  it('keeps imports separate per account', async () => {
    await importExpenses(drafts, 'acc-a')
    const other = await importExpenses(drafts, 'acc-b')
    expect(other.inserted).toBe(2)
    expect(await db.expenses.count()).toBe(4)
  })
})
