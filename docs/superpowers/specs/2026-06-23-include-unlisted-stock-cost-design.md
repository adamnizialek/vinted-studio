# Include unlisted-stock cost in totals — Design

**Date:** 2026-06-23
**Status:** Approved (design), pending implementation plan
**Surfaces:** Sales page (`Sprzedaż`), Dashboard (`Pulpit`)

## Problem

The "Koszty" (cost) total only reflects money spent on items that have **sold**. When
the user adds a product to the warehouse (`magazyn`), the cost total does not move —
even though real money was spent buying that stock.

Root cause: the cost total is computed by `aggregateProfit` (`src/lib/format.ts`), which
reads **only** `Sale` records (status `completed`/`pending`) plus `Expense` records.
Unsold inventory lives in a separate `products` table (`status` ∈ {`draft`, `in_stock`,
`listed`, `reserved`}, cost in `product.purchasePrice`). That table is never consulted by
the cost calculation, and `Sales.tsx` does not even load it. There is no "exclusion
filter" to flip — the function simply never looks at inventory.

## Confirmed decisions

1. **Cash view.** Unsold-stock cost folds into the existing `costs`, so
   `profit = revenue − costs` and `margin` reflect it. Profit/margin can go negative
   while holding stock (and recover as items sell). This is intentional.
2. **Which products count:** all not-yet-sold — `draft`, `in_stock`, `listed`,
   `reserved`. `sold` and `archived` are **excluded** (a sold item's cost is already
   carried by its `Sale`, so counting the product too would double-count).
3. **Filters:** inventory cost is counted **regardless of the period filter** (it is
   money tied up *now*, not a periodic flow). Shown in the "Wspólna/all" account view;
   under a specific account, only stock assigned to that account is counted. Account-less
   imported stock therefore appears only under "Wspólna/all".

## Design

### Data model — no change

No new fields, no schema migration. Inventory cost is **purely derived** at read time
from existing fields: `Product.purchasePrice` (`types.ts:141`, "Cena zakupu (koszt)") and
`Product.quantity` (`types.ts:148`), gated by `Product.status` (`types.ts:149`).

### 1. `src/lib/format.ts` — the calculation engine

**a. New predicate (single source of truth for "not yet sold"):**

```ts
import type { Product, ProductStatus } from '@/db/types'

/** Czy produkt liczy się jako koszt magazynowy (kupiony, jeszcze niesprzedany). */
export function countsAsInventoryCost(status: ProductStatus): boolean {
  return (
    status === 'draft' ||
    status === 'in_stock' ||
    status === 'listed' ||
    status === 'reserved'
  )
}
```

Mirrors the existing `countsAsRevenue` pattern. Dashboard's local
`ACTIVE_STATUSES` set (`Dashboard.tsx:32`) is removed in favor of this predicate.

**b. Extend `aggregateProfit` with an optional third argument:**

```ts
export function aggregateProfit(
  sales: Sale[],
  expenses: Expense[] = [],
  products: Product[] = [],
): ProfitBreakdown {
  const base = sales
    .filter((s) => countsAsRevenue(s.status))
    .reduce(/* …unchanged: revenue + sale costs… */)
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

The status filter lives **inside** the function (like `countsAsRevenue` for sales), so
the double-count guard holds no matter what the caller passes. **Backward compatible:**
the `products` argument defaults to `[]`, so every existing caller that does not pass
products gets identical results (`inventoryCost === 0`).

**c. `ProfitBreakdown` gains an optional field** (`types.ts:294`):

```ts
inventoryCost?: number // koszt niesprzedanego magazynu (część `costs`)
```

`profitOf` (per-sale) leaves it undefined; `aggregateProfit` sets it. UI reads
`stats.inventoryCost ?? 0`.

### 2. `src/pages/Sales.tsx` — primary surface ("Koszty" card)

- Load products: `const products = useLiveQuery(() => db.products.toArray(), [])`.
- New `filteredProducts` memo filtered by **account only** (NOT period):
  - `view === 'all'` → all products.
  - `view === <accountId>` → only `p.accountId === view` (account-less stock excluded
    from specific-account views; appears only under "Wspólna").
- `stats = aggregateProfit(filtered, filteredExpenses, filteredProducts)`.
- "Koszty" `StatCard` gains a sub-line when `stats.inventoryCost > 0`:
  `w tym magazyn: <money(stats.inventoryCost)>`.
- "Zysk" `StatCard` tone becomes conditional: `good` when `profit >= 0`, `bad` (red)
  when negative — matching how the sales-table rows already color negative profit
  (`Sales.tsx:249`).

### 3. `src/pages/Dashboard.tsx` — consistency

- **"Zysk łącznie" (all-time):** include inventory → `aggregateProfit(sales, expenses, products)`.
  This makes the headline all-time net position match the Sales page "Cały okres" view.
  Tone made conditional (`good`/`bad`) like the Sales "Zysk" card.
- **"Zysk (mies.)" (monthly) and the 6-month revenue chart:** unchanged — they remain
  realized/flow metrics. Injecting the whole standing inventory into a single month
  would misrepresent a balance as a monthly flow.
- **"Wartość magazynu" card:** add a sub-line `koszt: <money(inventoryCostTotal)>` so the
  user sees inventory at *cost* alongside the existing value at *listing price*. Compute
  via `aggregateProfit([], [], products).inventoryCost` (or the shared reduce).
- **Per-account cards:** unchanged (realized). Account-less imported stock has no account
  to attribute to; per-account remains a realized-profit view.
- Replace local `ACTIVE_STATUSES` with `countsAsInventoryCost` from `format.ts` (the
  `active`/`inventoryValue`/`toList` derivations keep the same status set).

### 4. `src/components/ui.tsx` — `StatCard`

Add a `bad` tone (loss color), reused by the Sales and Dashboard "Zysk" cards:

```ts
tone?: 'default' | 'good' | 'warn' | 'brand' | 'bad'
// toneCls: bad: 'text-red-500'
```

## Worked example

Period view with: 1 sold item (salePrice 100, purchaseCost 30); ad spend 10;
2 unsold stock items (purchasePrice 40 each, qty 1) → inventory cost 80.

| | Before | After (cash view) |
|---|---|---|
| Przychód | 100 | 100 |
| Koszty | 40 | **120** (sub: `w tym magazyn: 80 zł`) |
| Zysk | 60 | **−20** (red) |

## Edge cases & guards

- **Double-count guard:** `sold`/`archived` excluded from inventory; their cost flows via
  the `Sale`. A returned sale (status `returned`, excluded from costs) restocks the product
  to `in_stock` (counted as inventory) — consistent, no double count.
- **Account-less stock** (`accountId === undefined`): matches only the "Wspólna/all"
  view; never appears under a specific account. Expected per decision 3.
- **Imported sales without `productId`:** no product record → no inventory entry; cost
  comes from the `Sale`. Fine.
- **Sold product whose `Sale` is `cancelled`:** the item is counted in neither bucket
  (product is `sold`, sale excluded by `countsAsRevenue`). Rare data state; not specially
  handled.
- **Missing `purchasePrice`:** treated as 0 (item adds nothing to inventory cost).

## Out of scope

- No schema change / migration.
- No change to how products are created or imported.
- Per-account Dashboard cards stay realized.
- Monthly Dashboard card and revenue chart stay realized/flow.

## Testing

`format.ts` is pure → unit-test the engine:
- `countsAsInventoryCost`: true for the four not-yet-sold statuses, false for `sold`/`archived`.
- `aggregateProfit` with products: adds `purchasePrice × quantity`; honors the status
  filter (sold/archived ignored); `inventoryCost` reported; defaults to prior behavior
  when `products` omitted; missing `purchasePrice`/`quantity` handled.

## Files touched

- `src/lib/format.ts` — `countsAsInventoryCost`, extend `aggregateProfit`.
- `src/db/types.ts` — `ProfitBreakdown.inventoryCost?`.
- `src/pages/Sales.tsx` — load products, `filteredProducts`, pass to `aggregateProfit`,
  Koszty sub-line, conditional Zysk tone.
- `src/pages/Dashboard.tsx` — all-time profit includes inventory, Wartość magazynu cost
  sub-line, use shared predicate, conditional tone.
- `src/components/ui.tsx` — `StatCard` `bad` tone.
