# Restock on Refund (Zwrot → magazyn) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a sale is edited to status "Zwrot" (returned), automatically move its linked product back to the magazine (`in_stock`), ready to re-list.

**Architecture:** Two small additions to `src/lib/productActions.ts` — a pure decision helper `shouldRestockOnSave` and a DB action `restockOnRefund` — wired into `SaleModal.save()` in `src/pages/Sales.tsx`. No schema/type/migration changes: the `returned` sale status, `in_stock` product status, and `Sale.productId` link already exist. The financial side already works (`countsAsRevenue()` excludes `returned`).

**Tech Stack:** TypeScript, React 18, Dexie (IndexedDB), Vitest + fake-indexeddb. Spec: `docs/superpowers/specs/2026-06-15-restock-on-refund-design.md`.

---

## File Structure

- `src/lib/productActions.ts` (modify) — add `shouldRestockOnSave` (pure) and `restockOnRefund` (DB write). Keeps refund/restock logic next to existing product status actions (`applyStatusChange`, `assignAccount`).
- `src/lib/productActions.test.ts` (modify) — unit tests for both new units, following the existing `beforeEach` / `sampleProduct` pattern.
- `src/pages/Sales.tsx` (modify) — call the helpers from `SaleModal.save()`; add an inline hint under the Status field.

---

### Task 1: `shouldRestockOnSave` decision helper

**Files:**
- Modify: `src/lib/productActions.ts`
- Test: `src/lib/productActions.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/lib/productActions.test.ts`, update the import line to add `shouldRestockOnSave`:

```ts
import { requiresSaleModal, applyStatusChange, assignAccount, shouldRestockOnSave } from './productActions'
```

Append this `describe` block to the end of the file:

```ts
describe('shouldRestockOnSave', () => {
  it('is true only for a real transition into returned with a linked product', () => {
    expect(shouldRestockOnSave('completed', 'returned', true)).toBe(true)
    expect(shouldRestockOnSave('pending', 'returned', true)).toBe(true)
  })
  it('is false without a linked product', () => {
    expect(shouldRestockOnSave('completed', 'returned', false)).toBe(false)
  })
  it('is false when the new status is not returned', () => {
    expect(shouldRestockOnSave('completed', 'cancelled', true)).toBe(false)
    expect(shouldRestockOnSave('completed', 'completed', true)).toBe(false)
  })
  it('is false when already returned (not a transition)', () => {
    expect(shouldRestockOnSave('returned', 'returned', true)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/productActions.test.ts`
Expected: FAIL — `shouldRestockOnSave is not a function` / no matching export.

- [ ] **Step 3: Write the minimal implementation**

In `src/lib/productActions.ts`, change the types import to add `SaleStatus`:

```ts
import type { ID, ProductStatus, SaleStatus } from '@/db/types'
```

Append at the end of the file:

```ts
/**
 * Czysta reguła decyzyjna: czy zapis wpisu sprzedaży ma cofnąć przedmiot do
 * magazynu. Prawda wyłącznie przy realnym przejściu w 'returned' z powiązanym
 * przedmiotem — by edycja innych pól zwróconego wpisu nie ruszała magazynu.
 */
export function shouldRestockOnSave(
  prevStatus: SaleStatus,
  nextStatus: SaleStatus,
  hasProduct: boolean,
): boolean {
  return hasProduct && nextStatus === 'returned' && prevStatus !== 'returned'
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/productActions.test.ts`
Expected: PASS (all `shouldRestockOnSave` cases green, existing tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/productActions.ts src/lib/productActions.test.ts
git commit -m "feat(refund): add shouldRestockOnSave transition rule"
```

---

### Task 2: `restockOnRefund` DB action

**Files:**
- Modify: `src/lib/productActions.ts`
- Test: `src/lib/productActions.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/lib/productActions.test.ts`, add `restockOnRefund` to the import line from `./productActions`:

```ts
import { requiresSaleModal, applyStatusChange, assignAccount, shouldRestockOnSave, restockOnRefund } from './productActions'
```

Append this `describe` block to the end of the file:

```ts
describe('restockOnRefund', () => {
  it('moves a sold product back to in_stock, bumps updatedAt, queues outbox, returns true', async () => {
    await putEntity('products', { ...sampleProduct(), status: 'sold' })
    await db.outbox.clear()
    const did = await restockOnRefund('p1')
    expect(did).toBe(true)
    const row = await db.products.get('p1')
    expect(row?.status).toBe('in_stock')
    expect(row!.updatedAt).toBeGreaterThan(1)
    expect((await db.outbox.get(['products', 'p1']))?.deleted).toBe(0)
  })
  it('is a no-op returning false when the product is not sold', async () => {
    await putEntity('products', sampleProduct()) // status: 'in_stock'
    const did = await restockOnRefund('p1')
    expect(did).toBe(false)
    expect((await db.products.get('p1'))?.status).toBe('in_stock')
  })
  it('is a no-op returning false when the product does not exist', async () => {
    const did = await restockOnRefund('missing')
    expect(did).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/productActions.test.ts`
Expected: FAIL — `restockOnRefund is not a function` / no matching export.

- [ ] **Step 3: Write the minimal implementation**

In `src/lib/productActions.ts`, change the DB import to also import `db`:

```ts
import { db, patchEntity } from '@/db/db'
```

Append at the end of the file:

```ts
/**
 * Cofa przedmiot do magazynu po zwrocie. Przestawia status na 'in_stock'
 * WYŁĄCZNIE gdy przedmiot istnieje i jest aktualnie 'sold' (nie nadpisuje
 * przedmiotu, który użytkownik już przeniósł). Zwraca, czy faktycznie cofnięto.
 */
export async function restockOnRefund(productId: ID): Promise<boolean> {
  const product = await db.products.get(productId)
  if (!product || product.status !== 'sold') return false
  await patchEntity('products', productId, { status: 'in_stock' })
  return true
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/productActions.test.ts`
Expected: PASS (all `restockOnRefund` cases green, plus Task 1 and existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/productActions.ts src/lib/productActions.test.ts
git commit -m "feat(refund): add restockOnRefund (sold -> in_stock)"
```

---

### Task 3: Wire into `SaleModal` + inline hint

**Files:**
- Modify: `src/pages/Sales.tsx`

No component test harness exists for modals in this repo (tests live under `src/lib` and `src/db`), so this task is verified by typecheck, the full test suite, and a manual smoke (see Verification).

- [ ] **Step 1: Import the helpers**

In `src/pages/Sales.tsx`, add this import alongside the existing imports (e.g. after the `@/lib/format` import on line 12):

```ts
import { restockOnRefund, shouldRestockOnSave } from '@/lib/productActions'
```

- [ ] **Step 2: Update `SaleModal.save()`**

Replace the existing `save` function inside `SaleModal` (currently lines ~339-345):

```ts
  const save = async () => {
    if (!form.productName.trim()) return toast.error('Podaj nazwę produktu.')
    if (!form.salePrice || form.salePrice <= 0) return toast.error('Podaj cenę sprzedaży.')
    await putEntity('sales', form)
    onClose()
    toast.success('Zapisano sprzedaż.')
  }
```

with:

```ts
  const save = async () => {
    if (!form.productName.trim()) return toast.error('Podaj nazwę produktu.')
    if (!form.salePrice || form.salePrice <= 0) return toast.error('Podaj cenę sprzedaży.')
    await putEntity('sales', form)
    let restocked = false
    if (sale && shouldRestockOnSave(sale.status, form.status, !!form.productId)) {
      restocked = await restockOnRefund(form.productId!) // helper gwarantuje productId
    }
    onClose()
    toast.success(
      restocked ? 'Zwrot zapisany — przedmiot wrócił do magazynu 📦' : 'Zapisano sprzedaż.',
    )
  }
```

(Here `sale` is the original persisted sale passed as a prop; `sale.status` is the pre-edit status used for transition detection. `form` is the edited copy.)

- [ ] **Step 3: Add the inline hint under the Status field**

Replace the Status `Field` inside `SaleModal` (currently lines ~400-406):

```tsx
        <Field label="Status">
          <Select value={form.status} onChange={(e) => set('status', e.target.value as SaleStatus)}>
            {Object.entries(SALE_STATUS_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </Select>
        </Field>
```

with:

```tsx
        <Field label="Status">
          <Select value={form.status} onChange={(e) => set('status', e.target.value as SaleStatus)}>
            {Object.entries(SALE_STATUS_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </Select>
          {form.status === 'returned' && form.productId && (
            <p className="mt-1 text-xs text-ink-400">Po zapisaniu przedmiot wróci do magazynu.</p>
          )}
        </Field>
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no type errors). In particular `form.productId!` is accepted because `shouldRestockOnSave(..., !!form.productId)` guards it.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS — all existing tests plus the new `productActions` tests stay green (no regressions from the import/UI wiring).

- [ ] **Step 6: Commit**

```bash
git add src/pages/Sales.tsx
git commit -m "feat(refund): restock product when a sale is marked Zwrot"
```

---

## Verification (manual smoke, no commit)

Confirms the end-to-end flow in the running app, since the modal has no automated test.

1. Run: `npm run dev` and open the app.
2. In **Magazyn**, add (or pick) a product, then mark it **Sprzedane** via the status picker → fill the SoldModal → this creates a linked `Sale` and sets the product to `sold`.
3. Go to **Ewidencja sprzedaży**, open that sale (pencil icon). Change **Status → Zwrot**. Confirm the hint *"Po zapisaniu przedmiot wróci do magazynu."* appears. Click **Zapisz**.
4. Expect the toast *"Zwrot zapisany — przedmiot wrócił do magazynu 📦"*.
5. Back in **Magazyn**, confirm the product now shows **W magazynie** and the header count "… w magazynie" increased by one.
6. Negative check: edit a **manual** sale (no linked product) → set Zwrot → save. Expect no hint, the plain *"Zapisano sprzedaż."* toast, and no errors.

---

## Self-Review Notes (author)

- **Spec coverage:** decision rule (Task 1), one-way `sold → in_stock` restock with the "only if currently sold / exists" guard (Task 2), editor-driven trigger + toast + inline hint (Task 3), edge cases (Task 2 tests + manual step 6), no schema/migration (confirmed — no such tasks needed). Financials unchanged (covered by existing `countsAsRevenue`, nothing to do).
- **Type consistency:** `shouldRestockOnSave(prevStatus, nextStatus, hasProduct)` and `restockOnRefund(productId)` signatures are used identically in Task 3's wiring. `SaleStatus` and `db` import additions are explicit.
