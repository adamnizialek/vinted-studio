# Promotion-cost (expenses) tracking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture Vinted promotion fees (podbicia/ekspozycja) as a synced `expenses` ledger so net profit/margin are correct, and surface purchase cost in the import preview.

**Architecture:** New `Expense` entity in its own Dexie table (schema v3) + matching D1 envelope table, fully synced via the existing generic `SYNC_TABLES` machinery. The sales importer extracts fee rows (already classified `excluded`/`fee`) into expense drafts imported idempotently. `aggregateProfit` gains an optional `expenses` arg folded into costs; Sales page + Dashboard pass account/period-filtered expenses.

**Tech Stack:** React 18 + TypeScript, Dexie 4 (+dexie-react-hooks), Zustand, Tailwind, date-fns, vitest + fake-indexeddb, Cloudflare D1 (sync server).

**Commands:** typecheck `npm run typecheck` · tests `npm test` · single file `npx vitest run <path>` · build `npm run build`.

**Branch:** `feat/promotion-expenses` (already created; spec committed).

---

## File Structure

- `src/db/types.ts` — add `ExpenseKind`, `Expense` (Task 1).
- `src/lib/constants.ts` — add `EXPENSE_KIND_LABELS` (Task 1).
- `src/lib/salesImport.ts` — add `DraftExpense`, `expenseKindOf`, `parseExpenseDrafts`, `expenseImportKey` (Task 1).
- `src/lib/format.ts` — `aggregateProfit(sales, expenses?)` (Task 2).
- `src/sync/core.ts` + `src/sync/core.test.ts` — register `'expenses'` (Task 3).
- `migrations/0002_expenses.sql` — D1 envelope table (Task 3).
- `src/db/db.ts` — Dexie v3, `EntityMap`, `importExpenses`, export/import/clear (Task 3).
- `src/db/importExpenses.test.ts` — NEW (Task 3).
- `src/components/ImportSalesModal.tsx` — expenses bucket + import + purchase preview (Task 4).
- `src/pages/Sales.tsx` — net stats + "Koszty promocji" section + CRUD modal (Task 5).
- `src/pages/Dashboard.tsx` — net profit (Task 6).

---

## Task 1: Expense type, labels, and pure import helpers

**Files:**
- Modify: `src/db/types.ts` (after the `Sale` interface, ~line 190)
- Modify: `src/lib/constants.ts:1` (import) and after `SALE_STATUS_LABELS` (~line 43)
- Modify: `src/lib/salesImport.ts` (top import + end of file)
- Test: `src/lib/salesImport.test.ts`

- [ ] **Step 1: Add the `Expense` type.** In `src/db/types.ts`, immediately after the `Sale` interface (before `AppSettings`):

```ts
export type ExpenseKind = 'boost' | 'exposure' | 'other' // podbicie / ekspozycja / inne

/** Koszt promocji (podbicie/ekspozycja) lub inny koszt nie-towarowy. */
export interface Expense {
  id: ID
  /** Konto, którego dotyczy koszt (z importu = wybrane konto; ręczny = opcjonalny). */
  accountId?: ID
  kind: ExpenseKind
  /** Oryginalna nazwa z arkusza ("Podbicia", "Ekspozycja", "Podbicia main"). */
  description: string
  /** Kwota kosztu (zł). */
  amount: number
  currency: string
  /** Data poniesienia (ms, lokalne południe — spójnie ze sprzedażą). */
  incurredAt: number
  notes?: string
  createdAt: number
  updatedAt: number
  /** Klucz treści wiersza — do idempotentnego re-importu. */
  importKey?: string
}
```

- [ ] **Step 2: Add the label map.** In `src/lib/constants.ts`, extend the type import on line 1 and add the map after `SALE_STATUS_LABELS`:

```ts
// line 1 — add ExpenseKind:
import type { Condition, ExpenseKind, ImageResolution, ProductStatus, SaleStatus } from '@/db/types'
```

```ts
// after SALE_STATUS_LABELS (~line 43):
export const EXPENSE_KIND_LABELS: Record<ExpenseKind, string> = {
  boost: 'Podbicie',
  exposure: 'Ekspozycja',
  other: 'Inne',
}
```

- [ ] **Step 3: Write failing tests** for the pure helpers. Append to `src/lib/salesImport.test.ts`:

```ts
import {
  expenseKindOf,
  parseExpenseDrafts,
  expenseImportKey,
} from '@/lib/salesImport'

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
    expect(drafts.find((d) => d.description === 'Podbicia' && d.amount == null)).toBeUndefined()
  })
})

describe('expenseImportKey', () => {
  it('is stable under whitespace/case in the description', () => {
    const a = expenseImportKey('acc', 1769000000000, 'exposure', 'Ekspozycja ', 18.1)
    const b = expenseImportKey('acc', 1769000000000, 'exposure', 'ekspozycja', 18.1)
    expect(a).toBe(b)
  })
})
```

`parseSalesCsv` is already imported at the top of the test file.

- [ ] **Step 4: Run the tests to confirm they fail.**

Run: `npx vitest run src/lib/salesImport.test.ts`
Expected: FAIL — `expenseKindOf`/`parseExpenseDrafts`/`expenseImportKey` are not exported.

- [ ] **Step 5: Implement the helpers.** At the top of `src/lib/salesImport.ts` add the type import, and append the helpers at the end of the file:

```ts
// top of file, after `import { parseCsv } from '@/lib/csv'`:
import type { ExpenseKind } from '@/db/types'
```

```ts
// end of file:
/** Szkic kosztu promocji gotowy do zapisu. `incurredAt` null → wymaga uzupełnienia daty. */
export interface DraftExpense {
  incurredAt: number | null
  description: string
  amount: number
  kind: ExpenseKind
}

/** Mapuje nazwę opłaty na rodzaj kosztu (spójnie z FEE_RE). */
export function expenseKindOf(name: string): ExpenseKind {
  if (/podbic/i.test(name)) return 'boost'
  if (/ekspozycj/i.test(name)) return 'exposure'
  return 'other'
}

/**
 * Z już sklasyfikowanych wierszy wyłuskuje opłaty (bucket 'excluded', reason 'fee')
 * jako szkice kosztów. Kwota = `purchaseCost` (opłata siedzi w kolumnie „Cena zakupu").
 * Wiersze bez kwoty są pomijane (nie tworzymy kosztu „0").
 */
export function parseExpenseDrafts(rows: ParsedRow[]): DraftExpense[] {
  const out: DraftExpense[] = []
  for (const r of rows) {
    if (r.bucket !== 'excluded' || r.excludedReason !== 'fee') continue
    if (r.purchaseCost == null || r.purchaseCost <= 0) continue
    out.push({
      incurredAt: r.dateTs,
      description: r.productName,
      amount: r.purchaseCost,
      kind: expenseKindOf(r.productName),
    })
  }
  return out
}

/** Deterministyczny klucz treści kosztu — do idempotentnego re-importu. */
export function expenseImportKey(
  accountId: string,
  incurredAt: number | null,
  kind: ExpenseKind,
  description: string,
  amount: number,
): string {
  const day = incurredAt === null ? 'nodate' : new Date(incurredAt).toISOString().slice(0, 10)
  const d = description.trim().toLowerCase().replace(/\s+/g, ' ')
  return [accountId, day, kind, d, amount].join('|')
}
```

- [ ] **Step 6: Run the tests to confirm they pass.**

Run: `npx vitest run src/lib/salesImport.test.ts`
Expected: PASS (all, including the pre-existing sales tests).

- [ ] **Step 7: Commit.**

```bash
git add src/db/types.ts src/lib/constants.ts src/lib/salesImport.ts src/lib/salesImport.test.ts
git commit -m "feat(expenses): Expense type + pure fee-extraction helpers"
```

---

## Task 2: Fold expenses into `aggregateProfit`

**Files:**
- Modify: `src/lib/format.ts:3` (import) and `aggregateProfit` (~line 78)
- Test: `src/lib/format.test.ts` (NEW)

- [ ] **Step 1: Write the failing test.** Create `src/lib/format.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { aggregateProfit } from '@/lib/format'
import type { Expense, Sale } from '@/db/types'

const sale = (over: Partial<Sale>): Sale => ({
  id: 'x', productName: 'p', salePrice: 100, currency: 'PLN', quantity: 1,
  status: 'completed', soldAt: 0, createdAt: 0, updatedAt: 0, ...over,
})
const expense = (amount: number): Expense => ({
  id: 'e', kind: 'boost', description: 'Podbicia', amount, currency: 'PLN',
  incurredAt: 0, createdAt: 0, updatedAt: 0,
})

describe('aggregateProfit with expenses', () => {
  it('adds ad-spend to costs and nets profit + margin', () => {
    const sales = [sale({ salePrice: 100, purchaseCost: 40 })]
    expect(aggregateProfit(sales).profit).toBe(60)
    const agg = aggregateProfit(sales, [expense(10)])
    expect(agg.costs).toBe(50)
    expect(agg.profit).toBe(50)
    expect(agg.margin).toBeCloseTo(0.5)
  })

  it('is unchanged when the expenses list is empty (back-compat)', () => {
    const sales = [sale({ salePrice: 100, purchaseCost: 40 })]
    expect(aggregateProfit(sales, [])).toEqual(aggregateProfit(sales))
  })
})
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `npx vitest run src/lib/format.test.ts`
Expected: FAIL — `aggregateProfit` takes one arg / TS arity error.

- [ ] **Step 3: Implement.** In `src/lib/format.ts`, extend the type import on line 3 and replace `aggregateProfit`:

```ts
// line 3:
import type { Expense, ProfitBreakdown, Sale } from '@/db/types'
```

```ts
/** Agreguje zysk z listy sprzedazy (pomija anulowane i zwroty) minus koszty promocji. */
export function aggregateProfit(sales: Sale[], expenses: Expense[] = []): ProfitBreakdown {
  const base = sales
    .filter((s) => countsAsRevenue(s.status))
    .reduce(
      (acc, s) => {
        const p = profitOf(s)
        return { revenue: acc.revenue + p.revenue, costs: acc.costs + p.costs }
      },
      { revenue: 0, costs: 0 },
    )
  const adSpend = expenses.reduce((sum, e) => sum + (e.amount || 0), 0)
  const costs = base.costs + adSpend
  const profit = base.revenue - costs
  return { revenue: base.revenue, costs, profit, margin: base.revenue > 0 ? profit / base.revenue : 0 }
}
```

- [ ] **Step 4: Run tests to confirm pass.**

Run: `npx vitest run src/lib/format.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/format.ts src/lib/format.test.ts
git commit -m "feat(expenses): aggregateProfit nets out promotion costs"
```

---

## Task 3: Expense table — Dexie v3, sync registration, D1 migration, importExpenses

This task keeps typecheck green by landing the interdependent `SYNC_TABLES`/`EntityMap`/Dexie changes together.

**Files:**
- Modify: `src/sync/core.ts:6` and `src/sync/core.test.ts:35`
- Create: `migrations/0002_expenses.sql`
- Modify: `src/db/db.ts` (imports, class, EntityMap, exportAll/importAll/clearAllData, new `importExpenses`)
- Test: `src/db/importExpenses.test.ts` (NEW)

- [ ] **Step 1: Register the sync table.** In `src/sync/core.ts`, add `'expenses'` after `'sales'`:

```ts
export const SYNC_TABLES = [
  'products',
  'models',
  'accounts',
  'sales',
  'expenses',
  'images',
  'settings',
] as const
```

- [ ] **Step 2: Update the sync-tables test.** In `src/sync/core.test.ts`, change the description and expected array:

```ts
describe('SYNC_TABLES', () => {
  it('lists exactly the seven entity tables', () => {
    expect([...SYNC_TABLES].sort()).toEqual([
      'accounts',
      'expenses',
      'images',
      'models',
      'products',
      'sales',
      'settings',
    ])
  })
})
```

- [ ] **Step 3: Create the D1 migration.** New file `migrations/0002_expenses.sql`:

```sql
-- 0002_expenses.sql — sync envelope table for promotion/expense tracking.
-- Same shape as the other entity tables (see 0001_init.sql).

CREATE TABLE IF NOT EXISTS expenses (
  id                 TEXT    PRIMARY KEY,
  sync_stamp         INTEGER NOT NULL,
  content_updated_at INTEGER NOT NULL,
  deleted            INTEGER NOT NULL DEFAULT 0,
  data               TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_sync ON expenses(sync_stamp);
```

- [ ] **Step 4: Write the failing DB test.** Create `src/db/importExpenses.test.ts`:

```ts
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
```

- [ ] **Step 5: Run it to confirm it fails.**

Run: `npx vitest run src/db/importExpenses.test.ts`
Expected: FAIL — `importExpenses` / `db.expenses` do not exist.

- [ ] **Step 6: Wire up `db.ts`.** Apply all of the following edits:

(a) Imports — add `Expense` to the types import and `DraftExpense, expenseImportKey` to the salesImport import:

```ts
import type {
  Account, AiModel, AppSettings, Expense, ImageRecord, Product, Sale,
} from './types'
```
```ts
import {
  saleImportKey, dedupKeyed, expenseImportKey,
  type DraftSale, type DraftExpense, type KeyedDraft,
} from '@/lib/salesImport'
```

(b) Class field + schema v3. Add the field next to the other tables and a `version(3)` block after the `version(2)` block; bump `SCHEMA_VERSION`:

```ts
// class field (next to `sales!`):
expenses!: Table<Expense, string>
```
```ts
// after the .version(2)...upgrade(...) chain, inside the constructor:
this.version(3).stores({
  expenses: 'id, accountId, incurredAt, createdAt',
})
```
```ts
export const SCHEMA_VERSION = 3
```

(c) `EntityMap` — add the key:

```ts
interface EntityMap {
  products: Product
  models: AiModel
  accounts: Account
  sales: Sale
  expenses: Expense
  images: ImageRecord
  settings: AppSettings
}
```

(d) `exportAll` — add expenses to the parallel read and the returned object:

```ts
const [products, models, accounts, sales, expenses, settings, images] = await Promise.all([
  db.products.toArray(),
  db.models.toArray(),
  db.accounts.toArray(),
  db.sales.toArray(),
  db.expenses.toArray(),
  getSettings(),
  db.images.toArray(),
])
```
```ts
// in the returned object, after `sales,`:
    sales,
    expenses,
```

(e) `importAll` — map + persist expenses. After `const sales = (data.sales ?? []).map(withUpdatedAt)`:

```ts
const expenses = (data.expenses ?? []).map(withUpdatedAt)
```
Add `db.expenses` to the transaction's table array, and after the `if (sales.length) {...}` block:

```ts
if (expenses.length) {
  await db.expenses.bulkPut(expenses)
  await queue('expenses', expenses)
}
```

(f) `clearAllData` — add `db.expenses` to the transaction array and a tombstone call:

```ts
await tombstoneAll('expenses', db.expenses as Table<{ id: string }, string>)
```

(g) New `importExpenses` (place after `importSales`):

```ts
/**
 * Importuje koszty promocji do wybranego konta. Idempotentny względem wcześniej
 * zaimportowanych kosztów (różnica multizbiorów po `importKey`). Pomija szkice bez daty.
 */
export async function importExpenses(
  drafts: DraftExpense[],
  accountId: string,
): Promise<{ inserted: number; skippedDuplicates: number }> {
  return db.transaction('rw', db.expenses, db.outbox, async () => {
    const existing = await db.expenses.where('accountId').equals(accountId).toArray()
    const counts = new Map<string, number>()
    for (const e of existing) {
      if (e.importKey) counts.set(e.importKey, (counts.get(e.importKey) ?? 0) + 1)
    }

    const keyed = drafts
      .filter((d) => d.incurredAt !== null)
      .map((d) => ({
        key: expenseImportKey(accountId, d.incurredAt, d.kind, d.description, d.amount),
        draft: d,
      }))

    const seen = new Map(counts)
    const toInsert: typeof keyed = []
    let skipped = 0
    for (const item of keyed) {
      const c = seen.get(item.key) ?? 0
      if (c > 0) {
        seen.set(item.key, c - 1)
        skipped++
      } else {
        toInsert.push(item)
      }
    }

    const now = Date.now()
    const expenses: Expense[] = toInsert.map(({ key, draft }) => ({
      id: uid(),
      accountId,
      kind: draft.kind,
      description: draft.description,
      amount: draft.amount,
      currency: 'PLN',
      incurredAt: draft.incurredAt as number,
      createdAt: now,
      updatedAt: now,
      importKey: key,
    }))

    if (expenses.length) {
      await db.expenses.bulkAdd(expenses)
      await db.outbox.bulkPut(
        expenses.map((e) => ({ table: 'expenses' as const, id: e.id, deleted: 0 as const, updatedAt: now })),
      )
    }
    return { inserted: expenses.length, skippedDuplicates: skipped }
  })
}
```

`KeyedDraft` is imported but only used by `importSales`; leave it. (If lint flags the unused `dedupKeyed`/`KeyedDraft`, they are still used by `importSales` — no change.)

- [ ] **Step 7: Run the DB test + sync test.**

Run: `npx vitest run src/db/importExpenses.test.ts src/sync/core.test.ts`
Expected: PASS both.

- [ ] **Step 8: Typecheck the whole project (catches EntityMap/SyncTable fallout).**

Run: `npm run typecheck`
Expected: clean (no errors).

- [ ] **Step 9: Commit.**

```bash
git add src/sync/core.ts src/sync/core.test.ts migrations/0002_expenses.sql src/db/db.ts src/db/importExpenses.test.ts
git commit -m "feat(expenses): synced expenses table (Dexie v3 + D1 0002) + importExpenses"
```

---

## Task 4: Import modal — expenses bucket, import wiring, purchase-cost preview

**Files:**
- Modify: `src/components/ImportSalesModal.tsx`

No unit test (the repo has no component-test harness); verified by typecheck + build + manual smoke. All extracted logic is already unit-tested in Task 1.

- [ ] **Step 1: Extend imports.** Add to the existing imports:

```ts
import { db, importSales, importExpenses, putEntity } from '@/db/db'
import {
  parseSalesTable, parseExpenseDrafts, saleImportKey,
  type ParsedRow, type DraftSale, type DraftExpense,
} from '@/lib/salesImport'
import { money } from '@/lib/format' // already imported via format — verify it's present
```

`dateShort`, `money` are already imported from `@/lib/format` (line 10). Add `parseExpenseDrafts`, `importExpenses`, `DraftExpense` only.

- [ ] **Step 2: Build expense drafts from the current rows.** Add next to the `drafts` memo (~line 142):

```ts
// Wiersze opłat (bucket 'excluded'/'fee') → szkice kosztów promocji, domyślnie importowane.
const expenseDrafts = useMemo<DraftExpense[]>(
  () => parseExpenseDrafts(rows.filter((r) => r.include)),
  [rows],
)
```

The excluded rows must be includable+checked by default. Update `processSales` so fee rows start checked:

```ts
const next: EditRow[] = parsed.map((r) => ({
  ...r,
  key: `${sheet}#${r.rowIndex}`,
  include: r.bucket === 'ready' || r.bucket === 'excluded', // koszty promocji domyślnie zaznaczone
}))
```

- [ ] **Step 3: Import expenses alongside sales.** In `doImport`, after `const res = await importSales(drafts, accountId)`:

```ts
const expRes = await importExpenses(expenseDrafts, accountId)
toast.success(
  `Zaimportowano: ${res.inserted} sprzedaży, ${expRes.inserted} kosztów. ` +
    `Pominięto duplikaty: ${res.skippedDuplicates + expRes.skippedDuplicates}.`,
)
close()
```

Remove the old single-line success toast. Also update the disabled guard / footer count to allow importing when only expenses are selected:

```ts
// footer button: enable if there is anything to import
<Button onClick={doImport} disabled={busy || !accountId || (newCount === 0 && expenseDrafts.length === 0)}>
```
And the `if (!drafts.length)` guard in `doImport` becomes:
```ts
if (!drafts.length && !expenseDrafts.length) return toast.error('Brak wierszy do importu.')
```

- [ ] **Step 4: Rename the excluded bucket to "Koszty promocji" with checkboxes + amount.** Replace the `excluded` bucket block (~line 293) with a checkbox list showing the cost (`purchaseCost`):

```tsx
{excluded.length > 0 && (
  <Bucket title={`Koszty promocji (${excluded.length})`} tone="warn">
    {excluded.map((r) => (
      <label
        key={r.key}
        className="flex items-center gap-3 px-4 py-2 text-sm"
      >
        <input
          type="checkbox"
          checked={r.include}
          onChange={(e) => setRow(r.key, { include: e.target.checked })}
          className="h-4 w-4 rounded border-ink-300 text-brand-500 focus:ring-brand-400"
        />
        <span className="flex-1 truncate text-ink-800">{r.productName}</span>
        <span className="text-ink-400">{r.dateTs ? dateShort(r.dateTs) : '—'}</span>
        <span className="w-20 text-right font-medium tabular-nums text-amber-700">
          {r.purchaseCost != null ? `−${money(r.purchaseCost)}` : '—'}
        </span>
      </label>
    ))}
  </Bucket>
)}
```

- [ ] **Step 5: Show purchase cost + profit in the ready rows.** In `RowLine`, after the sale-price span, add a compact cost→profit hint:

```tsx
<span className="w-20 text-right font-medium tabular-nums">
  {r.salePrice != null ? money(r.salePrice) : '—'}
</span>
{r.purchaseCost != null && r.salePrice != null && (
  <span className="hidden w-28 text-right text-xs tabular-nums text-ink-400 sm:inline">
    koszt {money(r.purchaseCost)} · zysk{' '}
    <span className={r.salePrice - r.purchaseCost >= 0 ? 'text-emerald-600' : 'text-red-500'}>
      {money(r.salePrice - r.purchaseCost)}
    </span>
  </span>
)}
```

(`RowLine` already receives the full `EditRow r`, which includes `purchaseCost`.)

- [ ] **Step 6: Typecheck + build.**

Run: `npm run typecheck && npm run build`
Expected: clean typecheck, successful build.

- [ ] **Step 7: Manual smoke (describe in commit, do not block on it).**
  - Open Sprzedaż → Import, pick an account, drop `Main.xlsx`.
  - Confirm a "Koszty promocji (17)" bucket appears, checked, showing amounts like `−18,10 zł`.
  - Ready rows show `koszt … · zysk …`.
  - Import → toast reads "Zaimportowano: N sprzedaży, 17 kosztów".

- [ ] **Step 8: Commit.**

```bash
git add src/components/ImportSalesModal.tsx
git commit -m "feat(expenses): import promotion costs + show purchase/profit in preview"
```

---

## Task 5: Sales page — net stats, "Koszty promocji" section, expense CRUD

**Files:**
- Modify: `src/pages/Sales.tsx`

- [ ] **Step 1: Load + filter expenses.** Add imports and live queries:

```ts
import type { Expense, Sale, SaleStatus } from '@/db/types'
import { EXPENSE_KIND_LABELS } from '@/lib/constants'
```
```ts
const expenses = useLiveQuery(() => db.expenses.orderBy('incurredAt').reverse().toArray(), [])
```
After the `filtered` memo, add the parallel expense filter (same view + period rules, using `incurredAt`):

```ts
const filteredExpenses = useMemo(() => {
  let list = expenses ?? []
  if (view !== 'all') list = list.filter((e) => e.accountId === view)
  if (period !== 'all') {
    const from = period === 'month' ? startOfMonth(new Date()) : startOfYear(new Date())
    list = list.filter((e) => e.incurredAt >= from.getTime())
  }
  return list
}, [expenses, view, period])
```

- [ ] **Step 2: Net out the stats.** Change the stats memo to pass expenses:

```ts
const stats = useMemo(() => aggregateProfit(filtered, filteredExpenses), [filtered, filteredExpenses])
```

- [ ] **Step 3: Add expense editor state + handlers.** Near the other `useState`s:

```ts
const [expOpen, setExpOpen] = useState(false)
const [editingExp, setEditingExp] = useState<Expense | null>(null)

const startNewExpense = () => {
  setEditingExp({
    id: uid(),
    accountId: view !== 'all' ? view : settings?.defaultAccountId,
    kind: 'boost',
    description: 'Podbicie',
    amount: 0,
    currency,
    incurredAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  setExpOpen(true)
}

const removeExpense = async (id: string) => {
  if (!window.confirm('Usunąć ten koszt?')) return
  await deleteEntity('expenses', id)
  toast.success('Usunięto koszt.')
}
```

- [ ] **Step 4: Render the "Koszty promocji" section** below the sales table (before the closing `</div>` that wraps the page, after the sales `card`):

```tsx
<div className="mt-6">
  <SectionTitle
    title="Koszty promocji"
    subtitle="Podbicia i ekspozycje — pomniejszają zysk netto."
    right={
      <Button variant="ghost" onClick={startNewExpense}>
        <Plus size={16} /> Dodaj koszt
      </Button>
    }
  />
  {filteredExpenses.length === 0 ? (
    <p className="card px-4 py-6 text-center text-sm text-ink-400">
      Brak kosztów w tym widoku. Zaimportuj arkusz lub dodaj ręcznie.
    </p>
  ) : (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <tbody>
          {filteredExpenses.map((e) => (
            <tr key={e.id} className="border-b border-ink-50 last:border-0 hover:bg-ink-50/50">
              <td className="whitespace-nowrap px-4 py-2.5 text-ink-500">{dateShort(e.incurredAt)}</td>
              <td className="px-4 py-2.5">
                <span className="font-medium text-ink-900">{e.description}</span>
                <span className="ml-2 chip">{EXPENSE_KIND_LABELS[e.kind]}</span>
              </td>
              <td className="px-4 py-2.5 text-ink-500">{accName(e.accountId)}</td>
              <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-amber-700">
                −{money(e.amount, e.currency)}
              </td>
              <td className="px-4 py-2.5">
                <div className="flex justify-end gap-1">
                  <button onClick={() => { setEditingExp(e); setExpOpen(true) }} className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700">
                    <Pencil size={14} />
                  </button>
                  <button onClick={() => removeExpense(e.id)} className="rounded-lg p-1.5 text-ink-400 hover:bg-red-50 hover:text-red-600">
                    <Trash2 size={14} />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )}
</div>
```

- [ ] **Step 5: Add the `ExpenseModal`** (place beside `<SaleModal .../>` in the render, and define the component at the bottom of the file, mirroring `SaleModal`):

```tsx
<ExpenseModal open={expOpen} onClose={() => setExpOpen(false)} expense={editingExp} accounts={accounts ?? []} />
```

```tsx
function ExpenseModal({
  open, onClose, expense, accounts,
}: {
  open: boolean
  onClose: () => void
  expense: Expense | null
  accounts: { id: string; name: string }[]
}) {
  const [form, setForm] = useState<Expense | null>(expense)
  useEffect(() => setForm(expense), [expense])
  if (!form) return null
  const set = <K extends keyof Expense>(k: K, v: Expense[K]) => setForm({ ...form, [k]: v })

  const save = async () => {
    if (!form.description.trim()) return toast.error('Podaj opis kosztu.')
    if (!form.amount || form.amount <= 0) return toast.error('Podaj kwotę.')
    await putEntity('expenses', form)
    onClose()
    toast.success('Zapisano koszt.')
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Koszt promocji"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Anuluj</Button>
          <Button onClick={save}>Zapisz</Button>
        </div>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Opis" className="sm:col-span-2">
          <TextInput value={form.description} onChange={(e) => set('description', e.target.value)} autoFocus />
        </Field>
        <Field label="Rodzaj">
          <Select value={form.kind} onChange={(e) => set('kind', e.target.value as Expense['kind'])}>
            {Object.entries(EXPENSE_KIND_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </Select>
        </Field>
        <Field label={`Kwota (${form.currency})`}>
          <TextInput type="number" inputMode="decimal" value={form.amount || ''} onChange={(e) => set('amount', Number(e.target.value) || 0)} />
        </Field>
        <Field label="Konto">
          <Select value={form.accountId ?? ''} onChange={(e) => set('accountId', e.target.value || undefined)}>
            <option value="">— brak —</option>
            {accounts.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
          </Select>
        </Field>
        <Field label="Data">
          <TextInput type="date" value={dateInputValue(form.incurredAt)} onChange={(e) => set('incurredAt', dateFromInput(e.target.value, form.incurredAt))} />
        </Field>
        <Field label="Notatki" className="sm:col-span-2">
          <TextArea rows={2} value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
```

`uid`, `deleteEntity`, `dateInputValue`, `dateFromInput`, `Modal`, `Field`, `Select`, `TextInput`, `TextArea`, `Button`, `SectionTitle`, `Pencil`, `Trash2`, `Plus`, `useEffect`, `useMemo`, `useState` are all already imported in this file.

- [ ] **Step 6: Typecheck + build.**

Run: `npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 7: Commit.**

```bash
git add src/pages/Sales.tsx
git commit -m "feat(expenses): Sales page nets ad-spend + Koszty promocji CRUD section"
```

---

## Task 6: Dashboard — net profit with expenses

**Files:**
- Modify: `src/pages/Dashboard.tsx`

- [ ] **Step 1: Load expenses + thread into the aggregates.** Add:

```ts
const expenses = useLiveQuery(() => db.expenses.toArray(), [])
```
```ts
const monthExpenses = (expenses ?? []).filter((e) => e.incurredAt >= monthStart)
const monthAgg = useMemo(() => aggregateProfit(monthSales, monthExpenses), [monthSales, monthExpenses])
const totalAgg = useMemo(() => aggregateProfit(sales ?? [], expenses ?? []), [sales, expenses])
```
And per-account:
```ts
const perAccount = useMemo(() => {
  return (accounts ?? []).map((a) => {
    const accSales = (sales ?? []).filter((s) => s.accountId === a.id)
    const accExpenses = (expenses ?? []).filter((e) => e.accountId === a.id)
    return { account: a, agg: aggregateProfit(accSales, accExpenses), count: accSales.length }
  })
}, [accounts, sales, expenses])
```

(The 6-month revenue chart stays sales-only — it shows Przychód, not net profit.)

- [ ] **Step 2: Typecheck + build.**

Run: `npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 3: Commit.**

```bash
git add src/pages/Dashboard.tsx
git commit -m "feat(expenses): Dashboard profit reflects promotion costs"
```

---

## Task 7: Full verification + deploy note

- [ ] **Step 1: Run the entire suite.**

Run: `npm test`
Expected: all green (previous 107 + the new expense/format/import tests).

- [ ] **Step 2: Typecheck + production build.**

Run: `npm run typecheck && npm run build`
Expected: clean typecheck; build succeeds; `xlsx` still in its own lazy chunk.

- [ ] **Step 3: Confirm the lazy bundle didn't regress.** Check the build output lists a separate `xlsx` chunk and no unexpected size jump in the main chunk.

- [ ] **Step 4: Deploy note for the owner (Cloudflare sync path).** Record in the final report — do not run wrangler from agent tools:
  - Run **`npm run db:migrate`** (applies `0002_expenses.sql` to remote D1) **before** **`npm run cf:deploy`**. Reversed order makes `maxStamp()` query a missing `expenses` table and breaks all sync until migrated.
  - On Vercel (current host) `/api/sync` is absent, so expenses stay local until the Cloudflare backend is deployed — expected.

- [ ] **Step 5: Finish.** Use superpowers:finishing-a-development-branch to merge/PR.

---

## Self-Review notes

- **Spec coverage:** Expense model (T1/T3), import + idempotent dedup (T1/T3/T4), profit math (T2, used in T5/T6), UI section + purchase-cost preview (T4/T5), full sync + D1 migration + deploy ordering (T3/T7). All spec sections mapped.
- **Type consistency:** `DraftExpense` (incurredAt `number | null`) is filtered to non-null inside `importExpenses` before assigning `incurredAt: number`. `expenseImportKey` signature identical across T1 (def), T3 (use). `aggregateProfit(sales, expenses?)` arity matches all call-sites (Sales T5, Dashboard T6, tests T2).
- **Green-per-commit:** `SYNC_TABLES` + `EntityMap` + Dexie field land together in T3, so typecheck never breaks between commits.
- **No placeholders:** every code step is complete and copy-pasteable.
