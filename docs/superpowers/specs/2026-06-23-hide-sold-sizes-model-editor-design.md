# Hide sold sizes in the model editor

**Date:** 2026-06-23
**Status:** Approved (design), pending implementation plan
**Scope:** `src/pages/ProductEditor.tsx` (`DesignEditor`), `src/lib/designs.ts`, `src/lib/designs.test.ts`

## Problem

When a single size of a model (a `Design` grouping several per-size `Product` rows) is
sold, it still appears in the model editor's size bar — and the editor even
auto-selects it as the active size. In the reported case, a 6-size jacket whose first
`M` was sold opened straight onto that sold `M`.

The original request also asked that a sold size not appear "in the magazine" and that
photos be "moved off" a sold primary size. Reading the code established that both are
already handled and need no work:

- **Magazine grid** (`src/pages/Inventory.tsx` + `src/lib/inventoryFilter.ts`):
  `passesInventoryFilter` already drops sold sizes from the default view; a model's
  card count/price/summary reflect only the non-sold members, and a fully-sold model is
  hidden until the **Sprzedane** filter is chosen.
- **Photos** belong to the `Design`, not to any individual size. They are shared across
  all members via `resolveProduct`, and `deleteProductCascade` keeps a member's photos
  on the model. There is no per-size "primary holds the photos" state after grouping, so
  nothing is ever lost or needs moving when a size sells.

The only real gap is the **model editor** (`DesignEditor`), which renders the raw
`members` live query with no status awareness.

## Decision

In the model editor's size bar, **hide sold sizes**. If *every* size is sold, fall back
to showing them so the editor is never empty. This mirrors the magazine's existing
"sold items leave working stock" philosophy and adds no new UI.

(Alternatives considered and rejected: a reveal toggle for sold sizes — more UI than
needed since un-selling happens in Sprzedaż, not here; greyed-out chips — contradicts
the "shouldn't be visible" goal; permanent deletion — breaks refunds/accounting.)

## Design

### 1. Pure helper — `visibleSizes`

Add to `src/lib/designs.ts` (alongside `resolveProduct` / `SHARED_FIELDS`, matching the
"pure, no Dexie/React, unit-tested" pattern of `inventoryFilter.ts`):

```ts
/**
 * Sizes shown in the model editor's size bar. Sold sizes drop out — once sold they
 * live in Sprzedaż and are no longer working stock — UNLESS every size is sold, in
 * which case we show them so the editor is never empty (e.g. opening a fully-sold
 * model from the "Sprzedane" filter).
 */
export function visibleSizes(members: Product[]): Product[] {
  const active = members.filter((m) => m.status !== 'sold')
  return active.length ? active : members
}
```

Input order is preserved (the editor sorts members by `createdAt` upstream).

### 2. Wire into `DesignEditor`

- **Size bar** (`ProductEditor.tsx` ~line 358): map over `visibleSizes(members ?? [])`
  instead of raw `members`. The "Dodaj rozmiar" (+) button is unaffected.
- **Active-size selection** (the existing effect at ~line 248): select from the visible
  set — if the current `activeId` is not in `visibleSizes(members)`, set it to the first
  visible size. This single change covers:
  - Opening a model whose first member is sold → lands on an available size.
  - Marking the **active** size sold from inside the editor → it leaves the bar and the
    editor jumps to the next available size (the live query drives the re-render).

### 3. Behaviors that fall out for free

- **Fully-sold model** stays openable: `visibleSizes` returns the sold members, so the
  bar and editor still render.
- **Un-selling** is unchanged: a refund/return in Sprzedaż restores the product to
  `in_stock`; the `members` live query re-renders and the size reappears automatically.

## Out of scope

- Magazine grid filtering (already correct).
- Photo ownership / "moving" photos (photos live on the `Design`; nothing to move).
- Deleting sold sizes (would break refunds and Sprzedane history).
- The pre-existing quirk that the editor's status `<Select>` sets `sold` directly while
  the dedicated "Sprzedane" button routes through `SoldModal` — untouched here.

## Testing

TDD the pure helper in `src/lib/designs.test.ts` (Vitest):

1. Mixed statuses → only non-sold members returned, in original order.
2. All members sold → returns all members (fallback).
3. Empty input → returns empty.
4. No sold members → returns all members unchanged.

The `DesignEditor` wiring is then a mechanical swap from `members` to
`visibleSizes(members)` in the two spots above.
