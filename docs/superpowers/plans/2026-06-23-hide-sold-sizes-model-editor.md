# Hide Sold Sizes in the Model Editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the model editor, hide sold sizes from the size bar (and never auto-select one), falling back to showing them only when every size is sold.

**Architecture:** Add one pure, unit-tested helper `visibleSizes(members)` to `src/lib/designs.ts`, then wire it into `DesignEditor` in two places — the size-bar render and the active-size selection effect. No data-model, magazine, or photo changes (those already behave correctly).

**Tech Stack:** React + TypeScript, Vite, Dexie (IndexedDB) via `dexie-react-hooks` `useLiveQuery`, Vitest for tests.

## Global Constraints

- Pure helpers in `src/lib/*` must have **no Dexie/React imports** (mirrors `src/lib/inventoryFilter.ts` / `src/lib/designs.ts`), so they stay unit-testable.
- "Sold" is the status string literal `'sold'` from `ProductStatus` (`src/db/types.ts`). Do not introduce a new flag.
- Polish-language UI/comments are the codebase convention; keep new comments consistent with surrounding style.
- Preserve member order (the editor sorts members by `createdAt` upstream via `.sortBy('createdAt')`).

---

### Task 1: `visibleSizes` pure helper (TDD)

**Files:**
- Modify: `src/lib/designs.ts` (append a new exported function after `resolveProduct`, ~line 33)
- Test: `src/lib/designs.test.ts` (append a new `describe` block after the existing `resolveProduct` block, ~line 87)

**Interfaces:**
- Consumes: `Product` type from `@/db/types` (already imported in `designs.ts`).
- Produces: `export function visibleSizes(members: Product[]): Product[]` — returns non-sold members in original order; if none are non-sold, returns `members` unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/designs.test.ts`. The file already imports `{ describe, it, expect }` from `vitest` and defines a `product(over)` factory — reuse them. Add `visibleSizes` to the existing import on line 2.

Change line 2 from:

```ts
import { resolveProduct, SHARED_FIELDS } from './designs'
```

to:

```ts
import { resolveProduct, SHARED_FIELDS, visibleSizes } from './designs'
```

Then append at the end of the file (after the closing `})` of the `resolveProduct` describe block):

```ts
describe('visibleSizes', () => {
  it('returns an empty array for no members', () => {
    expect(visibleSizes([])).toEqual([])
  })

  it('returns all members unchanged when none are sold', () => {
    const a = product({ id: 'a', status: 'in_stock' })
    const b = product({ id: 'b', status: 'listed' })
    expect(visibleSizes([a, b])).toEqual([a, b])
  })

  it('drops sold members, preserving order of the rest', () => {
    const a = product({ id: 'a', status: 'in_stock' })
    const sold = product({ id: 's', status: 'sold' })
    const c = product({ id: 'c', status: 'listed' })
    expect(visibleSizes([a, sold, c])).toEqual([a, c])
  })

  it('falls back to all members when every size is sold', () => {
    const a = product({ id: 'a', status: 'sold' })
    const b = product({ id: 'b', status: 'sold' })
    expect(visibleSizes([a, b])).toEqual([a, b])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/designs.test.ts -t visibleSizes`
Expected: FAIL — `visibleSizes is not a function` / import has no exported member `visibleSizes`.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/lib/designs.ts` after `resolveProduct` (after line 33):

```ts
/**
 * Rozmiary pokazywane w pasku rozmiarow edytora modelu. Sprzedane rozmiary znikaja
 * — po sprzedazy zyja w Sprzedazy i nie sa juz stanem roboczym — CHYBA ze sprzedane
 * sa wszystkie; wtedy zwracamy je, by edytor nigdy nie byl pusty (np. otwarcie w pelni
 * sprzedanego modelu z filtra „Sprzedane"). Kolejnosc wejscia zachowana.
 */
export function visibleSizes(members: Product[]): Product[] {
  const active = members.filter((m) => m.status !== 'sold')
  return active.length ? active : members
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/designs.test.ts -t visibleSizes`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/designs.ts src/lib/designs.test.ts
git commit -m "feat(designs): add visibleSizes helper to hide sold sizes"
```

---

### Task 2: Wire `visibleSizes` into `DesignEditor`

**Files:**
- Modify: `src/pages/ProductEditor.tsx`
  - Import (line 44)
  - Add a `shownSizes` memo inside `DesignEditor` (after the `members` live query, ~line 236)
  - Active-size selection effect (~lines 247–252)
  - Size-bar render (~lines 357–371)

**Interfaces:**
- Consumes: `visibleSizes(members: Product[]): Product[]` from Task 1.
- Produces: no new exports — internal wiring only.

- [ ] **Step 1: Import the helper**

Change line 44 from:

```ts
import { resolveProduct, SHARED_FIELDS } from '@/lib/designs'
```

to:

```ts
import { resolveProduct, SHARED_FIELDS, visibleSizes } from '@/lib/designs'
```

- [ ] **Step 2: Add the `shownSizes` memo**

`useMemo` is already imported from `react` (line 1). In `DesignEditor`, immediately after the `members` live query (the block ending at ~line 236):

```ts
  const members = useLiveQuery(
    () => db.products.where('designId').equals(designId).sortBy('createdAt'),
    [designId],
  )
```

add:

```ts
  // Pasek rozmiarow pomija sprzedane rozmiary (wracaja do widoku tylko, gdy WSZYSTKIE
  // sa sprzedane — by edytor nie byl pusty). Patrz visibleSizes w lib/designs.
  const shownSizes = useMemo(() => visibleSizes(members ?? []), [members])
```

- [ ] **Step 3: Select the active size from the visible set**

Replace the existing effect (~lines 247–252):

```ts
  // Wybierz aktywny rozmiar, gdy lista czlonkow sie zmieni a biezacy zniknal.
  useEffect(() => {
    if (members && members.length && !members.some((m) => m.id === activeId)) {
      setActiveId(members[0].id)
    }
  }, [members, activeId])
```

with:

```ts
  // Trzymaj aktywny rozmiar wsrod widocznych (niesprzedanych). Gdy biezacy wypadnie
  // z widocznych — otwarcie modelu, ktorego pierwszy rozmiar jest sprzedany, albo
  // oznaczenie biezacego jako sprzedane — przeskocz na pierwszy widoczny.
  useEffect(() => {
    if (shownSizes.length && !shownSizes.some((m) => m.id === activeId)) {
      setActiveId(shownSizes[0].id)
    }
  }, [shownSizes, activeId])
```

- [ ] **Step 4: Render the visible sizes in the size bar**

In the size-bar block (~lines 357–371), change the iterated collection from `members?.map` to `shownSizes.map`. Replace:

```tsx
        {members?.map((m) => (
          <button
            key={m.id}
            onClick={() => setActiveId(m.id)}
            className={clsx(
              'rounded-full px-3 py-1.5 text-sm font-medium transition',
              m.id === activeId
                ? 'bg-brand-500 text-white'
                : 'bg-ink-100 text-ink-600 hover:bg-ink-200',
            )}
          >
            {m.sizeLabel || 'rozmiar'}
          </button>
        ))}
```

with:

```tsx
        {shownSizes.map((m) => (
          <button
            key={m.id}
            onClick={() => setActiveId(m.id)}
            className={clsx(
              'rounded-full px-3 py-1.5 text-sm font-medium transition',
              m.id === activeId
                ? 'bg-brand-500 text-white'
                : 'bg-ink-100 text-ink-600 hover:bg-ink-200',
            )}
          >
            {m.sizeLabel || 'rozmiar'}
          </button>
        ))}
```

(The `+ Dodaj rozmiar` button immediately below stays unchanged.)

- [ ] **Step 5: Typecheck and run the full test suite**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx vitest run`
Expected: all tests pass (including Task 1's `visibleSizes` tests).

- [ ] **Step 6: Manual verification in the running app**

Start the app (`npm run dev`) and confirm:
1. Open a model that has a sold first size (e.g. the screenshot's "Kurtka NY M") → the size bar shows only the available sizes, and the editor lands on an available size, not the sold one.
2. With the editor on an available size, set its status to **Sprzedane** → that chip disappears from the bar and the editor jumps to the next available size.
3. Mark every size sold → the model still opens (from the magazine's **Sprzedane** filter) and the bar shows the sold sizes instead of being empty.
4. Refund/return that sale from **Sprzedaż** → the size reappears in the bar.

- [ ] **Step 7: Commit**

```bash
git add src/pages/ProductEditor.tsx
git commit -m "feat(model): hide sold sizes from the model editor size bar"
```

---

## Self-Review

**1. Spec coverage:**
- Spec §"Pure helper `visibleSizes`" → Task 1. ✓
- Spec §"Wire into DesignEditor" (size bar + active-size selection) → Task 2 Steps 2–4. ✓
- Spec §"Fully-sold model stays openable" → covered by the fallback in `visibleSizes` (Task 1) + verified in Task 2 Step 6.3. ✓
- Spec §"Un-selling unchanged" → no code; verified in Task 2 Step 6.4. ✓
- Spec §"Out of scope" (magazine, photos, deletion, status-select quirk) → no tasks touch them. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"write tests for the above" — every step has concrete code or commands. ✓

**3. Type consistency:** `visibleSizes(members: Product[]): Product[]` is defined identically in Task 1 (impl), Task 1 (test import), and consumed in Task 2 (import + `shownSizes` memo). `shownSizes` is referenced consistently in Steps 2, 3, 4. ✓
