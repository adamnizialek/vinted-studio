# Include Unlisted-Stock Cost in Totals — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "Koszty" (cost) total include unsold inventory (`purchasePrice × quantity` of not-yet-sold products), so adding a product to the warehouse moves the cost — a cash-view of profit.

**Architecture:** Inventory cost is purely derived at read time from existing `Product` fields; no schema change. The pure engine (`aggregateProfit` in `src/lib/format.ts`) gains an optional `products` argument and a shared `countsAsInventoryCost` status predicate. The Sales page and Dashboard thread products in; UI shows the inventory portion and colors negative profit.

**Tech Stack:** React 18 + TypeScript, Vite, Dexie (IndexedDB), Vitest. Path alias `@/` → `src/`.

**Spec:** `docs/superpowers/specs/2026-06-23-include-unlisted-stock-cost-design.md`

**Working directory:** the isolated worktree `C:/Users/adam-/vinted-studio/.claude/worktrees/unlisted-stock-cost` (branch `feat/unlisted-stock-cost`). Run all commands from there.

## Global Constraints

- **No schema change / no migration** — inventory cost is derived only.
- **Polish UI copy** — match existing labels (e.g. `Koszty`, `Zysk`, `w tym magazyn`).
- **Currency via `money()`** from `@/lib/format`; never hand-format amounts.
- **Backward compatibility** — `aggregateProfit`'s new arg defaults to `[]`; existing callers (and tests) must stay green.
- **Git hygiene (concurrent sessions active):** commit ONLY the files each task lists. NEVER `git add -A`/`git add .` — other sessions have unrelated WIP in this repo.
- **Status sets:** not-yet-sold = `draft | in_stock | listed | reserved`; `sold` and `archived` are excluded (a sold item's cost is carried by its `Sale`).

## File Structure

- `src/db/types.ts` — add optional `inventoryCost?: number` to `ProfitBreakdown` (output-only field).
- `src/lib/format.ts` — `countsAsInventoryCost(status)` predicate + extend `aggregateProfit(sales, expenses?, products?)`. Single source of truth for the calculation.
- `src/lib/format.test.ts` — unit tests for the predicate and the extended aggregation.
- `src/components/ui.tsx` — add `bad` tone to `StatCard` (loss color), reused by both pages.
- `src/pages/Sales.tsx` — load products, account-filter them, pass to `aggregateProfit`, show inventory sub-line on Koszty, color Zysk by sign.
- `src/pages/Dashboard.tsx` — all-time profit includes inventory; "Wartość magazynu" gains a cost sub-line; replace the local `ACTIVE_STATUSES` set with the shared predicate; color profit by sign.

---

## Task 1: Calculation engine (`format.ts` + `types.ts`)

**Files:**
- Modify: `src/db/types.ts:294-299` (`ProfitBreakdown`)
- Modify: `src/lib/format.ts:3` (imports), `:94-109` (`aggregateProfit`); add `countsAsInventoryCost`
- Test: `src/lib/format.test.ts`

**Interfaces:**
- Consumes: `Product`, `ProductStatus`, `Sale`, `Expense`, `ProfitBreakdown` from `@/db/types`; existing `countsAsRevenue`, `profitOf`.
- Produces:
  - `countsAsInventoryCost(status: ProductStatus): boolean`
  - `aggregateProfit(sales: Sale[], expenses?: Expense[], products?: Product[]): ProfitBreakdown` where the result's `inventoryCost: number` = `Σ (purchasePrice ?? 0) × (quantity || 1)` over products passing `countsAsInventoryCost`.

- [ ] **Step 1: Add `inventoryCost` to `ProfitBreakdown`**

In `src/db/types.ts`, change the interface (lines 294-299) to:

```ts
/** Wynik kalkulacji zysku — uzywany w ewidencji i na dashboardzie. */
export interface ProfitBreakdown {
  revenue: number // salePrice * qty + shippingCharged
  costs: number // purchase + shipping + fee + other (+ magazyn w agregacie)
  profit: number
  margin: number // profit / revenue
  /** Koszt niesprzedanego magazynu zawarty w `costs` (tylko w agregacie). */
  inventoryCost?: number
}
```

- [ ] **Step 2: Write the failing tests**

In `src/lib/format.test.ts`, update the imports at the top:

```ts
import { describe, it, expect } from 'vitest'
import { aggregateProfit, countsAsInventoryCost, parseDecimal } from '@/lib/format'
import type { Expense, Product, Sale } from '@/db/types'
```

Add a `product` factory next to the existing `sale`/`expense` factories:

```ts
const product = (over: Partial<Product>): Product => ({
  id: 'p1', name: 'prod', condition: 'dobry', currency: 'PLN', quantity: 1,
  status: 'in_stock', photoIds: [], generatedPhotoIds: [], descriptions: [],
  tags: [], createdAt: 0, updatedAt: 0, ...over,
})
```

Add these test blocks (after the existing `aggregateProfit with expenses` describe):

```ts
describe('countsAsInventoryCost', () => {
  it('counts not-yet-sold statuses, excludes sold and archived', () => {
    expect(countsAsInventoryCost('draft')).toBe(true)
    expect(countsAsInventoryCost('in_stock')).toBe(true)
    expect(countsAsInventoryCost('listed')).toBe(true)
    expect(countsAsInventoryCost('reserved')).toBe(true)
    expect(countsAsInventoryCost('sold')).toBe(false)
    expect(countsAsInventoryCost('archived')).toBe(false)
  })
})

describe('aggregateProfit with products (inventory cost)', () => {
  it('adds unsold-stock purchase cost to costs + inventoryCost, reducing profit', () => {
    const sales = [sale({ salePrice: 100, purchaseCost: 30 })]
    const products = [
      product({ purchasePrice: 40, quantity: 1 }),
      product({ id: 'p2', purchasePrice: 40, quantity: 1 }),
    ]
    const agg = aggregateProfit(sales, [expense(10)], products)
    expect(agg.inventoryCost).toBe(80)
    expect(agg.costs).toBe(120) // 30 COGS + 10 ad + 80 stock
    expect(agg.profit).toBe(-20) // 100 - 120
  })

  it('multiplies purchasePrice by quantity', () => {
    const products = [product({ purchasePrice: 25, quantity: 3 })]
    expect(aggregateProfit([], [], products).inventoryCost).toBe(75)
  })

  it('excludes sold and archived products (no double-count vs sales)', () => {
    const products = [
      product({ id: 'a', status: 'sold', purchasePrice: 99 }),
      product({ id: 'b', status: 'archived', purchasePrice: 99 }),
      product({ id: 'c', status: 'in_stock', purchasePrice: 10 }),
    ]
    expect(aggregateProfit([], [], products).inventoryCost).toBe(10)
  })

  it('treats missing purchasePrice as 0', () => {
    const products = [
      product({ purchasePrice: undefined }),
      product({ id: 'p2', purchasePrice: 12 }),
    ]
    expect(aggregateProfit([], [], products).inventoryCost).toBe(12)
  })

  it('reports inventoryCost 0 and stays unchanged when products omitted (back-compat)', () => {
    const sales = [sale({ salePrice: 100, purchaseCost: 40 })]
    expect(aggregateProfit(sales, []).inventoryCost).toBe(0)
    expect(aggregateProfit(sales, [])).toEqual(aggregateProfit(sales, [], []))
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/lib/format.test.ts`
Expected: FAIL — `countsAsInventoryCost is not a function` / `inventoryCost` is `undefined` (not `0`/`80`).

- [ ] **Step 4: Implement the engine**

In `src/lib/format.ts`, change the type import (line 3) to:

```ts
import type { Expense, ProfitBreakdown, Product, ProductStatus, Sale } from '@/db/types'
```

Add the predicate immediately after `countsAsRevenue` (after line 92):

```ts
/**
 * Czy produkt liczy się jako koszt magazynowy: kupiony, ale jeszcze niesprzedany.
 * Wyklucza 'sold' i 'archived' — koszt sprzedanego niesie już wpis sprzedaży (Sale),
 * więc liczenie produktu podwajałoby koszt.
 */
export function countsAsInventoryCost(status: ProductStatus): boolean {
  return (
    status === 'draft' ||
    status === 'in_stock' ||
    status === 'listed' ||
    status === 'reserved'
  )
}
```

Replace `aggregateProfit` (lines 94-109) with:

```ts
/**
 * Agreguje zysk: sprzedaże (bez anulowanych i zwrotów) + koszty promocji + koszt
 * niesprzedanego magazynu. Widok kasowy: zysk = przychód − wszystkie koszty.
 * `products` domyślnie [] (zgodność wstecz: wywołania bez magazynu dają inventoryCost 0).
 */
export function aggregateProfit(
  sales: Sale[],
  expenses: Expense[] = [],
  products: Product[] = [],
): ProfitBreakdown {
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
  const inventoryCost = products
    .filter((p) => countsAsInventoryCost(p.status))
    .reduce((sum, p) => sum + (p.purchasePrice ?? 0) * (p.quantity || 1), 0)
  const costs = base.costs + adSpend + inventoryCost
  const profit = base.revenue - costs
  return {
    revenue: base.revenue,
    costs,
    profit,
    inventoryCost,
    margin: base.revenue > 0 ? profit / base.revenue : 0,
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/format.test.ts`
Expected: PASS — all prior tests plus the new `countsAsInventoryCost` and inventory blocks (≥15 tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/db/types.ts src/lib/format.ts src/lib/format.test.ts
git commit -m "feat(cost): include unsold-stock purchase cost in aggregateProfit

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Sales page totals + StatCard loss tone

**Files:**
- Modify: `src/components/ui.tsx:177` (tone union), `:180-185` (toneCls)
- Modify: `src/pages/Sales.tsx:28` (products query), `:42-66` (filteredProducts + stats), `:181-186` (StatCards)

**Interfaces:**
- Consumes: `aggregateProfit` (3-arg form) and `stats.inventoryCost` from Task 1; `db.products`; `useLiveQuery`, `useMemo`, `money`.
- Produces: `StatCard` accepts `tone="bad"`.

- [ ] **Step 1: Add `bad` tone to `StatCard`**

In `src/components/ui.tsx`, change the tone prop type (line 177) to:

```ts
  tone?: 'default' | 'good' | 'warn' | 'brand' | 'bad'
```

And the `toneCls` map (lines 180-185) to:

```ts
  const toneCls = {
    default: 'text-ink-900',
    good: 'text-emerald-600',
    warn: 'text-amber-600',
    brand: 'text-brand-600',
    bad: 'text-red-500',
  }[tone]
```

- [ ] **Step 2: Load products in Sales**

In `src/pages/Sales.tsx`, after the `accounts` query (line 28) add:

```ts
  const products = useLiveQuery(() => db.products.toArray(), [])
```

- [ ] **Step 3: Add account-filtered products and pass to the aggregate**

In `src/pages/Sales.tsx`, after the `filteredExpenses` memo (ends line 61) add:

```ts
  // Koszt magazynu liczymy NIEZALEŻNIE od okresu — to pieniądze zamrożone teraz,
  // nie przepływ z danego miesiąca. Filtrujemy tylko po koncie; stany bez konta
  // (z importu) liczą się wyłącznie w widoku „Wspólna".
  const filteredProducts = useMemo(() => {
    let list = products ?? []
    if (view !== 'all') list = list.filter((p) => p.accountId === view)
    return list
  }, [products, view])
```

Then change the `stats` memo (lines 63-66) to:

```ts
  const stats = useMemo(
    () => aggregateProfit(filtered, filteredExpenses, filteredProducts),
    [filtered, filteredExpenses, filteredProducts],
  )
```

- [ ] **Step 4: Show the inventory portion and color the profit**

In `src/pages/Sales.tsx`, replace the Koszty and Zysk `StatCard`s (lines 183-184) with:

```tsx
        <StatCard
          label="Koszty"
          value={money(stats.costs, currency)}
          sub={stats.inventoryCost ? `w tym magazyn: ${money(stats.inventoryCost, currency)}` : undefined}
        />
        <StatCard label="Zysk" value={money(stats.profit, currency)} tone={stats.profit >= 0 ? 'good' : 'bad'} />
```

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck`
Expected: no errors.
Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/components/ui.tsx src/pages/Sales.tsx
git commit -m "feat(sales): show unsold-stock cost in Koszty and color negative profit

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Dashboard consistency

**Files:**
- Modify: `src/pages/Dashboard.tsx:18` (import), `:32` (remove `ACTIVE_STATUSES`), `:45-46` (active + inventoryCost), `:53` (totalAgg), `:118` (Wartość magazynu card), `:120-121` (profit cards)

**Interfaces:**
- Consumes: `countsAsInventoryCost` and 3-arg `aggregateProfit` from Task 1; `tone="bad"` from Task 2.
- Produces: none (page-level).

- [ ] **Step 1: Import the shared predicate**

In `src/pages/Dashboard.tsx`, change the format import (line 18) to include `countsAsInventoryCost`:

```ts
import { aggregateProfit, countsAsInventoryCost, countsAsRevenue, dateShort, money, percent, pluralPl } from '@/lib/format'
```

- [ ] **Step 2: Replace the local status set with the shared predicate**

In `src/pages/Dashboard.tsx`, delete the module-level constant (line 32):

```ts
const ACTIVE_STATUSES = new Set(['draft', 'in_stock', 'listed', 'reserved'])
```

Then change the `active` derivation and add an inventory-cost sum (lines 45-46) to:

```ts
  const active = (products ?? []).filter((p) => countsAsInventoryCost(p.status))
  const inventoryValue = active.reduce((s, p) => s + (p.listingPrice ?? 0) * (p.quantity || 1), 0)
  const inventoryCost = active.reduce((s, p) => s + (p.purchasePrice ?? 0) * (p.quantity || 1), 0)
```

- [ ] **Step 3: Include inventory in the all-time aggregate**

In `src/pages/Dashboard.tsx`, change `totalAgg` (line 53) to pass products (leave `monthAgg` on line 52 unchanged — monthly stays realized/flow):

```ts
  const totalAgg = useMemo(() => aggregateProfit(sales ?? [], expenses ?? [], products ?? []), [sales, expenses, products])
```

- [ ] **Step 4: Surface inventory cost and color the profit cards**

In `src/pages/Dashboard.tsx`, replace the three affected `StatCard`s (lines 118, 120-121) with:

```tsx
        <StatCard label="Wartość magazynu" value={money(inventoryValue, currency)} icon={<Package size={16} />} sub={`${active.length} aktywnych · koszt ${money(inventoryCost, currency)}`} />
        <StatCard label="Sprzedaż (mies.)" value={money(monthAgg.revenue, currency)} tone="brand" icon={<Wallet size={16} />} sub={`${monthSales.length} transakcji`} />
        <StatCard label="Zysk (mies.)" value={money(monthAgg.profit, currency)} tone={monthAgg.profit >= 0 ? 'good' : 'bad'} icon={<TrendingUp size={16} />} />
        <StatCard label="Zysk łącznie" value={money(totalAgg.profit, currency)} tone={totalAgg.profit >= 0 ? 'good' : 'bad'} sub={`${(sales ?? []).length} sprzedaży`} />
```

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck`
Expected: no errors (in particular, `countsAsRevenue` is still imported and used by the chart; `ACTIVE_STATUSES` is fully removed).
Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/pages/Dashboard.tsx
git commit -m "feat(dashboard): all-time profit nets unsold-stock cost; show stock cost

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Full verification

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: all test files pass (including the extended `format.test.ts`).

- [ ] **Step 2: Typecheck + build once more**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 3: Manual smoke (optional but recommended)**

Run: `npm run dev`, open the app:
- Sales page "Wspólna" view: "Koszty" shows `w tym magazyn: …` and grows when an `in_stock` product is added; "Zysk" turns red if it goes negative.
- Switch to a specific account: only that account's stock is included; account-less imported stock disappears from the inventory portion.
- Dashboard: "Wartość magazynu" shows `· koszt …`; "Zysk łącznie" reflects inventory; the monthly card and 6-month chart are unchanged.

## Self-Review

**Spec coverage:**
- Cash view (cost+profit include stock) → Task 1 engine + Task 2/3 wiring. ✓
- Statuses draft/in_stock/listed/reserved, exclude sold/archived → `countsAsInventoryCost` (Task 1). ✓
- Always count regardless of period → Sales `filteredProducts` ignores period (Task 2); Dashboard all-time (Task 3). ✓
- Account attribution (specific account → only its stock; account-less → only "Wspólna") → Task 2 `filteredProducts`. ✓
- Koszty sub-line + negative-profit color → Task 2; `bad` tone in `ui.tsx` Task 2 Step 1. ✓
- Dashboard all-time includes inventory, monthly/chart stay realized, Wartość magazynu cost sub-line → Task 3. ✓
- Centralize `ACTIVE_STATUSES` → Task 3 Step 2. ✓
- No schema change → confirmed; only `ProfitBreakdown` output field added. ✓

**Placeholder scan:** none — every code/command step is concrete.

**Type consistency:** `countsAsInventoryCost(status: ProductStatus)`, `aggregateProfit(sales, expenses?, products?)`, and `inventoryCost` are used identically across tasks. `tone="bad"` defined in Task 2 Step 1 before use in Tasks 2 & 3.
