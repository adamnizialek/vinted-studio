# Magazyn — Inline Status & Account Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users change a product's status and assign an account directly from its card in the Magazyn grid — no navigation into the editor.

**Architecture:** Each card's status pill and account chip become *triggers* that open a small picker. On desktop the picker is a portaled, viewport-clamped anchored popover (escapes the card's `overflow-hidden`); on mobile it reuses the existing `Modal` bottom-sheet. Writes go through `patchEntity` optimistically (Dexie live-query recolors instantly — no success toast; `toast.error` only on failure). The card's navigate action is preserved as a real stretched `<button>` so keyboard/focus semantics don't regress. Picking `sold` opens the extracted `SoldModal` so a real `Sale` is still recorded.

**Tech Stack:** React 18, TypeScript, Dexie (IndexedDB) + `useLiveQuery`, Tailwind, lucide-react, Vitest + fake-indexeddb (Node env, no jsdom). No new runtime dependencies.

---

## Context the implementer must know

- **Tests run in Node, no jsdom/RTL** (`vitest.config.ts`: `environment: 'node'`, include `src/**/*.test.ts` — **not** `.test.tsx`). So **only pure logic + Dexie writers are unit-tested**; all popover/sheet/card interaction is verified **manually in the browser** (`npm run dev`). Do not add `.test.tsx` files — they won't run.
- **`patchEntity('products', id, changes)`** (`src/db/db.ts:167`) is the write primitive: merges changes, bumps `updatedAt`, queues one outbox row keyed `[table+id]` (rapid patches to the same product collapse to one row). It **silently no-ops if the row is gone** (`if (!existing) return`). Already used in `PhotoStudio.tsx:146`.
- **`.card` is `overflow-hidden`** (`src/index.css:54-56`, applied at `Inventory.tsx:142`). An in-card `absolute` popover is clipped → the desktop popover **must portal to `document.body`**.
- **`product.soldAt` / `product.listedAt` are write-only dead fields** — grepped: Dashboard/Sales/CSV all read the **`Sale`** entity's `soldAt`, never the product's. Do **not** write them from the grid picker.
- **`SoldModal`** is currently private inside `ProductEditor.tsx:673-755`. It `putEntity('sales', …)` and then the *caller* flips `status:'sold'` + `soldAt` via the `onSold` callback. It must be **extracted** to be reusable from the grid; keep that contract.
- **Design tokens:** `.badge`, `.card`, `.chip`, `.btn-*`, `.input`; `STATUS_LABELS`, `STATUS_TONE`, `STATUS_OPTIONS` (`src/lib/constants.ts`); accounts have `{ id, name, color }`.
- **Existing `Modal`** (`src/components/ui.tsx:120`) already renders as a bottom sheet on mobile (`items-end … sm:items-center`), with Escape + backdrop + scroll-lock + `fixed inset-0` (immune to `overflow-hidden`). Reuse it for the mobile picker surface.

## File Structure

**Create:**
- `src/lib/productActions.ts` — pure helpers + Dexie writers: `requiresSaleModal(status)`, `applyStatusChange(id, status)`, `assignAccount(id, accountId?)`.
- `src/lib/productActions.test.ts` — Vitest tests for the above.
- `src/lib/useMediaQuery.ts` — tiny `matchMedia` hook (SSR/no-matchMedia safe).
- `src/components/SoldModal.tsx` — extracted from `ProductEditor`, unchanged behavior.
- `src/components/Popover.tsx` — `useDismiss` glue + `PopoverPanel` (portaled, anchored, viewport-clamped, vertical-flip, close-on-scroll/resize/outside/Escape) + `ResponsivePicker` (desktop popover ⇆ mobile `Modal`).
- `src/components/StatusPicker.tsx` — status pill trigger + status option list + `SoldModal` wiring.
- `src/components/AccountPicker.tsx` — account chip trigger + account option list + "Bez konta".

**Modify:**
- `src/pages/ProductEditor.tsx` — delete the inline `SoldModal`, import the extracted one. No behavior change.
- `src/pages/Inventory.tsx` — restructure the card (stretched nav `<button>` + `pointer-events-none` content + sibling pickers), render `StatusPicker`/`AccountPicker`, change grid sort `updatedAt → createdAt`.

---

### Task 1: Pure product-action helpers (`productActions.ts`) — TDD

**Files:**
- Create: `src/lib/productActions.ts`
- Test: `src/lib/productActions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/productActions.test.ts
import { beforeEach, describe, it, expect } from 'vitest'
import { db, putEntity } from '@/db/db'
import { requiresSaleModal, applyStatusChange, assignAccount } from './productActions'
import type { Product } from '@/db/types'

const sampleProduct = (id = 'p1'): Product => ({
  id, name: 'P', condition: 'dobry', currency: 'PLN', quantity: 1,
  status: 'in_stock', accountId: 'a1', photoIds: [], generatedPhotoIds: [],
  descriptions: [], tags: [], createdAt: 1, updatedAt: 1,
})

beforeEach(async () => {
  await Promise.all([db.products.clear(), db.outbox.clear()])
})

describe('requiresSaleModal', () => {
  it('is true only for sold', () => {
    expect(requiresSaleModal('sold')).toBe(true)
    for (const s of ['draft', 'in_stock', 'listed', 'reserved', 'archived'] as const)
      expect(requiresSaleModal(s)).toBe(false)
  })
})

describe('applyStatusChange', () => {
  it('patches status, bumps updatedAt, queues outbox, and never writes soldAt/listedAt', async () => {
    await putEntity('products', sampleProduct())
    await db.outbox.clear()
    await applyStatusChange('p1', 'listed')
    const row = await db.products.get('p1')
    expect(row?.status).toBe('listed')
    expect(row?.soldAt).toBeUndefined()
    expect(row?.listedAt).toBeUndefined()
    expect(row!.updatedAt).toBeGreaterThan(1)
    expect((await db.outbox.get(['products', 'p1']))?.deleted).toBe(0)
  })
})

describe('assignAccount', () => {
  it('sets a new accountId', async () => {
    await putEntity('products', sampleProduct())
    await assignAccount('p1', 'a2')
    expect((await db.products.get('p1'))?.accountId).toBe('a2')
  })
  it('clears accountId when passed undefined', async () => {
    await putEntity('products', sampleProduct())
    await assignAccount('p1', undefined)
    expect((await db.products.get('p1'))?.accountId).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- productActions`
Expected: FAIL — `Cannot find module './productActions'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/productActions.ts
import { patchEntity } from '@/db/db'
import type { ID, ProductStatus } from '@/db/types'

/**
 * Statuses that carry a side-effect (recording a Sale) and therefore must NOT be
 * flipped silently from the grid — they route through SoldModal instead.
 */
export function requiresSaleModal(status: ProductStatus): boolean {
  return status === 'sold'
}

/**
 * Quick status change from the grid. Deliberately does NOT touch soldAt/listedAt:
 * nothing reads product.soldAt/listedAt (the Sale entity is the source of truth),
 * so writing them here would be dead writes. `sold` must go through SoldModal and
 * never reaches this function in normal flow.
 */
export async function applyStatusChange(id: ID, status: ProductStatus): Promise<void> {
  await patchEntity('products', id, { status })
}

/** Assign or clear (undefined) the account of a product. */
export async function assignAccount(id: ID, accountId: ID | undefined): Promise<void> {
  await patchEntity('products', id, { accountId })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- productActions`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/productActions.ts src/lib/productActions.test.ts
git commit -m "feat(magazyn): pure product-action helpers for inline status/account edits"
```

---

### Task 2: `useMediaQuery` hook

**Files:**
- Create: `src/lib/useMediaQuery.ts`

> No unit test: `matchMedia` does not exist in the Node test env, and the hook is trivial. Verified via the browser when the pickers are wired up (Task 7).

- [ ] **Step 1: Implement**

```ts
// src/lib/useMediaQuery.ts
import { useEffect, useState } from 'react'

/** Reactive media-query match. Safe when matchMedia is unavailable (returns false). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npm run typecheck`
Expected: PASS (no new errors).

- [ ] **Step 3: Commit**

```bash
git add src/lib/useMediaQuery.ts
git commit -m "feat(ui): useMediaQuery hook (matchMedia-safe)"
```

---

### Task 3: Extract `SoldModal` to its own component

**Files:**
- Create: `src/components/SoldModal.tsx`
- Modify: `src/pages/ProductEditor.tsx` (remove inline def lines 672-755, add import, drop now-unused imports)

- [ ] **Step 1: Create the extracted component (verbatim move + explicit imports)**

```tsx
// src/components/SoldModal.tsx
import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Check } from 'lucide-react'
import { db, putEntity } from '@/db/db'
import type { Product } from '@/db/types'
import { uid } from '@/lib/id'
import { toast } from '@/state/toast'
import { Button, Field, Modal, Select, TextInput } from '@/components/ui'

/**
 * Records a real Sale for the product, then calls onSold so the caller can flip
 * the product's status to 'sold'. Shared by ProductEditor (header button) and the
 * Magazyn grid status picker (selecting "Sprzedane").
 */
export function SoldModal({
  open,
  onClose,
  product,
  onSold,
}: {
  open: boolean
  onClose: () => void
  product: Product
  onSold: () => void
}) {
  const accounts = useLiveQuery(() => db.accounts.toArray(), [])
  const [price, setPrice] = useState('')
  const [accountId, setAccountId] = useState('')
  const [buyer, setBuyer] = useState('')

  useEffect(() => {
    if (open) {
      setPrice(product.listingPrice ? String(product.listingPrice) : '')
      setAccountId(product.accountId ?? '')
      setBuyer('')
    }
  }, [open, product])

  const confirm = async () => {
    const salePrice = Number(price)
    if (!salePrice || salePrice <= 0) return toast.error('Podaj cenę sprzedaży.')
    await putEntity('sales', {
      id: uid(),
      productId: product.id,
      productName: product.name || 'Bez nazwy',
      brand: product.brand,
      accountId: accountId || undefined,
      salePrice,
      currency: product.currency,
      purchaseCost: product.purchasePrice,
      quantity: 1,
      buyer: buyer || undefined,
      status: 'completed',
      soldAt: Date.now(),
      createdAt: Date.now(),
    })
    toast.success('Dodano do ewidencji sprzedaży 💸')
    onSold()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Oznacz jako sprzedane"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Anuluj
          </Button>
          <Button onClick={confirm}>
            <Check size={16} /> Zapisz sprzedaż
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label={`Cena sprzedaży (${product.currency})`}>
          <TextInput type="number" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} autoFocus />
        </Field>
        <Field label="Konto">
          <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">— brak —</option>
            {accounts?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Kupujący (opcjonalnie)">
          <TextInput value={buyer} onChange={(e) => setBuyer(e.target.value)} placeholder="nick z Vinted" />
        </Field>
      </div>
    </Modal>
  )
}
```

- [ ] **Step 2: Update `ProductEditor.tsx` — delete the inline `SoldModal` function (lines ~672-755) and import the extracted one**

Add to the import block near the other component imports:

```tsx
import { SoldModal } from '@/components/SoldModal'
```

Delete the entire `// ── Modal sprzedaży ──` section and the `function SoldModal({...}) {...}` definition at the bottom of the file. Then prune imports that are now unused **only if** no longer referenced elsewhere in the file — check before removing: `Modal`, `Field`, `Select` may still be used by other tabs (they are: `Select` is used in DetailsTab; `Field` is used widely; `Modal` is **only** used by SoldModal → remove `Modal` from the `@/components/ui` import). Leave `useEffect`, `useLiveQuery` (still used at top), `uid`, `putEntity` (used elsewhere). After editing, the typecheck in Step 3 will flag any over-removal.

- [ ] **Step 3: Verify build + existing tests still pass**

Run: `npm run typecheck && npm test`
Expected: typecheck PASS (fix any "unused import" / "not found" by adjusting the import line per Step 2), tests PASS (116 existing).

- [ ] **Step 4: Manually verify ProductEditor "Sprzedane" flow is unchanged**

Run: `npm run dev`, open a product, click **Sprzedane**, enter a price, save. Expect: toast "Dodano do ewidencji sprzedaży", product status becomes **Sprzedane**, a row appears in Sprzedaż. (Same as before extraction.)

- [ ] **Step 5: Commit**

```bash
git add src/components/SoldModal.tsx src/pages/ProductEditor.tsx
git commit -m "refactor(magazyn): extract SoldModal into a shared component"
```

---

### Task 4: `Popover` primitive — portaled anchored panel + responsive wrapper

**Files:**
- Create: `src/components/Popover.tsx`

> Pure-DOM interaction; verified manually (Task 7). No `.test.tsx` (no jsdom in this repo).

- [ ] **Step 1: Implement `PopoverPanel` + `ResponsivePicker`**

```tsx
// src/components/Popover.tsx
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { Modal } from '@/components/ui'
import { useMediaQuery } from '@/lib/useMediaQuery'

const GAP = 6 // px between trigger and panel
const MARGIN = 8 // px min distance from viewport edge

/**
 * Anchored popover rendered in a portal on document.body so it escapes the card's
 * `overflow-hidden`. Positioned with fixed coords from the trigger's rect; clamps
 * horizontally to the viewport and flips above the trigger when there isn't room
 * below. Closes on outside-pointerdown, Escape (restoring focus to the trigger),
 * and any scroll/resize (so it never orphans). Desktop only — mobile uses Modal.
 */
function PopoverPanel({
  anchorRef,
  onClose,
  children,
  ariaLabel,
}: {
  anchorRef: RefObject<HTMLElement>
  onClose: () => void
  children: ReactNode
  ariaLabel: string
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const panel = panelRef.current
    if (!anchor || !panel) return
    const a = anchor.getBoundingClientRect()
    const pw = panel.offsetWidth
    const ph = panel.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    // Vertical: prefer below; flip above if it would overflow the bottom.
    let top = a.bottom + GAP
    if (top + ph > vh - MARGIN && a.top - GAP - ph >= MARGIN) top = a.top - GAP - ph
    top = Math.max(MARGIN, Math.min(top, vh - ph - MARGIN))
    // Horizontal: align left edges, clamp into the viewport.
    let left = a.left
    left = Math.max(MARGIN, Math.min(left, vw - pw - MARGIN))
    setPos({ top, left })
  }, [anchorRef])

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!panelRef.current?.contains(t) && !anchorRef.current?.contains(t)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        anchorRef.current?.focus()
      }
    }
    const onScrollOrResize = () => onClose()
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    // capture:true so we also catch scrolls inside any nested scroll container.
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [anchorRef, onClose])

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={ariaLabel}
      style={{
        position: 'fixed',
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        visibility: pos ? 'visible' : 'hidden',
      }}
      className="z-[70] min-w-[11rem] max-w-[80vw] rounded-xl bg-white p-1 shadow-pop ring-1 ring-ink-100"
    >
      {children}
    </div>,
    document.body,
  )
}

/**
 * Picker shell: renders `trigger` (which must spread `triggerProps` onto a button
 * and attach `ref`), then — when open — shows `children` in an anchored popover on
 * desktop (>=640px) or the existing Modal bottom-sheet on mobile. `children` is a
 * render-prop receiving `close` so options can dismiss after selecting.
 */
export interface PickerTriggerProps {
  ref: RefObject<HTMLButtonElement>
  open: boolean
  toggle: () => void
  /** Spread directly onto the trigger button. */
  aria: { 'aria-haspopup': 'dialog'; 'aria-expanded': boolean }
}

export function ResponsivePicker({
  title,
  trigger,
  children,
}: {
  title: string
  trigger: (p: PickerTriggerProps) => ReactNode
  children: (close: () => void) => ReactNode
}) {
  const isDesktop = useMediaQuery('(min-width: 640px)')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const close = () => setOpen(false)

  return (
    <>
      {trigger({
        ref,
        open,
        toggle: () => setOpen((v) => !v),
        aria: { 'aria-haspopup': 'dialog', 'aria-expanded': open },
      })}
      {open &&
        (isDesktop ? (
          <PopoverPanel anchorRef={ref} onClose={close} ariaLabel={title}>
            {children(close)}
          </PopoverPanel>
        ) : (
          <Modal open onClose={close} title={title} size="sm">
            <div className="-m-1">{children(close)}</div>
          </Modal>
        ))}
    </>
  )
}

/** Shared option-row look for both pickers. */
export function OptionRow({
  selected,
  onClick,
  children,
}: {
  selected?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={clsx(
        'flex min-h-[44px] w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition hover:bg-ink-50',
        selected && 'bg-ink-50',
      )}
    >
      {children}
    </button>
  )
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/Popover.tsx
git commit -m "feat(ui): portaled anchored Popover + responsive picker shell"
```

---

### Task 5: `StatusPicker` component

**Files:**
- Create: `src/components/StatusPicker.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/components/StatusPicker.tsx
import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import clsx from 'clsx'
import type { Product, ProductStatus } from '@/db/types'
import { STATUS_LABELS, STATUS_OPTIONS, STATUS_TONE } from '@/lib/constants'
import { applyStatusChange, requiresSaleModal } from '@/lib/productActions'
import { patchEntity } from '@/db/db'
import { toast } from '@/state/toast'
import { ResponsivePicker, OptionRow } from '@/components/Popover'
import { SoldModal } from '@/components/SoldModal'

/**
 * Status pill that doubles as the trigger for an in-place status picker.
 * 5 statuses flip instantly via patchEntity; 'sold' opens SoldModal (records a Sale).
 */
export function StatusPicker({ product, className }: { product: Product; className?: string }) {
  const [soldOpen, setSoldOpen] = useState(false)

  const pick = async (status: ProductStatus, close: () => void) => {
    close()
    if (status === product.status && status !== 'sold') return
    if (requiresSaleModal(status)) {
      setSoldOpen(true)
      return
    }
    try {
      await applyStatusChange(product.id, status)
    } catch {
      toast.error('Nie udało się zmienić statusu.')
    }
  }

  return (
    <>
      <ResponsivePicker
        title="Zmień status"
        trigger={({ ref, toggle, aria }) => (
          <button
            ref={ref}
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              toggle()
            }}
            className={clsx('badge shadow-sm', STATUS_TONE[product.status], className)}
            {...aria}
          >
            {STATUS_LABELS[product.status]}
            <ChevronDown size={12} className="-mr-0.5 opacity-70" />
          </button>
        )}
      >
        {(close) => (
          <div role="listbox" aria-label="Status">
            {STATUS_OPTIONS.map((o) => {
              const selected = o.value === product.status
              return (
                <OptionRow key={o.value} selected={selected} onClick={() => pick(o.value, close)}>
                  <span className={clsx('badge', STATUS_TONE[o.value])}>{o.label}</span>
                  {selected && <Check size={15} className="ml-auto text-ink-500" />}
                </OptionRow>
              )
            })}
          </div>
        )}
      </ResponsivePicker>

      <SoldModal
        open={soldOpen}
        onClose={() => setSoldOpen(false)}
        product={product}
        onSold={() => {
          void patchEntity('products', product.id, { status: 'sold', soldAt: Date.now() })
          setSoldOpen(false)
        }}
      />
    </>
  )
}
```

> Note: `onSold` sets `soldAt` here purely to mirror the editor's existing contract (harmless — nothing reads it). The `Sale` record created inside `SoldModal` is the real source of truth.

- [ ] **Step 2: Verify it type-checks**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/StatusPicker.tsx
git commit -m "feat(magazyn): StatusPicker — inline status change from the card"
```

---

### Task 6: `AccountPicker` component

**Files:**
- Create: `src/components/AccountPicker.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/components/AccountPicker.tsx
import { Check, ChevronDown, UserPlus, X } from 'lucide-react'
import clsx from 'clsx'
import type { Account, Product } from '@/db/types'
import { assignAccount } from '@/lib/productActions'
import { toast } from '@/state/toast'
import { ResponsivePicker, OptionRow } from '@/components/Popover'

/**
 * Account chip that doubles as the trigger for an in-place account picker.
 * Shows the current account (color dot + name) or a subtle "Przypisz konto" affordance
 * when none is set. Includes a "Bez konta" row to clear the assignment.
 */
export function AccountPicker({
  product,
  accounts,
  className,
}: {
  product: Product
  accounts: Account[]
  className?: string
}) {
  const current = accounts.find((a) => a.id === product.accountId)

  const pick = async (accountId: string | undefined, close: () => void) => {
    close()
    if (accountId === product.accountId) return
    try {
      await assignAccount(product.id, accountId)
    } catch {
      toast.error('Nie udało się przypisać konta.')
    }
  }

  // No accounts exist at all → nothing to assign; render nothing.
  if (accounts.length === 0) return null

  return (
    <ResponsivePicker
      title="Przypisz konto"
      trigger={({ ref, toggle, aria }) => (
        <button
          ref={ref}
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            toggle()
          }}
          className={clsx(
            'inline-flex items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[11px] transition hover:bg-ink-100',
            current ? 'text-ink-500' : 'text-ink-400 ring-1 ring-dashed ring-ink-200',
            className,
          )}
          {...aria}
        >
          {current ? (
            <>
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: current.color }} />
              <span className="max-w-[8rem] truncate">{current.name}</span>
            </>
          ) : (
            <>
              <UserPlus size={12} /> Przypisz konto
            </>
          )}
          <ChevronDown size={11} className="opacity-70" />
        </button>
      )}
    >
      {(close) => (
        <div role="listbox" aria-label="Konto">
          {accounts.map((a) => {
            const selected = a.id === product.accountId
            return (
              <OptionRow key={a.id} selected={selected} onClick={() => pick(a.id, close)}>
                <span className="h-3 w-3 rounded-full" style={{ background: a.color }} />
                <span className="truncate">{a.name}</span>
                {selected && <Check size={15} className="ml-auto text-ink-500" />}
              </OptionRow>
            )
          })}
          <OptionRow selected={!product.accountId} onClick={() => pick(undefined, close)}>
            <X size={14} className="text-ink-400" />
            <span className="text-ink-500">Bez konta</span>
          </OptionRow>
        </div>
      )}
    </ResponsivePicker>
  )
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/AccountPicker.tsx
git commit -m "feat(magazyn): AccountPicker — inline account assignment from the card"
```

---

### Task 7: Wire pickers into the Magazyn card + fix grid sort

**Files:**
- Modify: `src/pages/Inventory.tsx`

- [ ] **Step 1: Change the grid sort `updatedAt → createdAt`**

At `src/pages/Inventory.tsx:19`, replace:

```tsx
const products = useLiveQuery(() => db.products.orderBy('updatedAt').reverse().toArray(), [])
```

with:

```tsx
// Sort by createdAt (stable) — NOT updatedAt — so an in-place status/account change
// doesn't yank the just-edited card to the top mid-burst.
const products = useLiveQuery(() => db.products.orderBy('createdAt').reverse().toArray(), [])
```

- [ ] **Step 2: Add imports**

Add near the existing imports:

```tsx
import { StatusPicker } from '@/components/StatusPicker'
import { AccountPicker } from '@/components/AccountPicker'
```

Remove now-unused imports from `Inventory.tsx`: `STATUS_LABELS` and `STATUS_TONE` are no longer referenced after the card change (the pill moves into `StatusPicker`); keep `STATUS_OPTIONS` (still used by the filter `<Select>`). `clsx` may become unused — check and remove if so. The Step 5 typecheck will confirm.

- [ ] **Step 3: Restructure the card (the `filtered.map(...)` block, lines ~135-177)**

Replace the entire `<button …>…</button>` card with this layered structure (stretched nav button at the back via `pointer-events`, pickers as interactive siblings):

```tsx
{filtered.map((p) => {
  const cover = p.photoIds[0] ?? p.generatedPhotoIds[0]
  return (
    <div key={p.id} className="card group relative overflow-hidden transition hover:shadow-pop">
      {/* Stretched navigate hit-area — a real <button> (keyboard + focus-ring intact).
          Sits BEHIND content; content is pointer-events-none so clicks fall through,
          except the pickers which re-enable pointer-events. */}
      <button
        type="button"
        aria-label={`Otwórz ${p.name || 'produkt'}`}
        onClick={() => nav(`/magazyn/${p.id}`)}
        className="absolute inset-0 z-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
      />
      <div className="pointer-events-none relative z-10">
        <div className="relative aspect-square w-full bg-ink-100">
          <Thumb imageId={cover} className="h-full w-full object-cover" alt={p.name} />
          <StatusPicker product={p} className="pointer-events-auto absolute left-2 top-2" />
          {p.generatedPhotoIds.length > 0 && (
            <span className="badge absolute right-2 top-2 bg-brand-500 text-white shadow-sm">
              AI {p.generatedPhotoIds.length}
            </span>
          )}
        </div>
        <div className="p-3">
          <p className="truncate font-semibold text-ink-900">{p.name || 'Bez nazwy'}</p>
          <div className="mt-0.5 flex items-center justify-between">
            <p className="truncate text-xs text-ink-400">{p.brand || '—'}</p>
            <p className="shrink-0 text-sm font-bold text-brand-600">
              {p.listingPrice ? money(p.listingPrice, p.currency) : '—'}
            </p>
          </div>
          <div className="mt-2">
            <AccountPicker product={p} accounts={accounts ?? []} className="pointer-events-auto" />
          </div>
        </div>
      </div>
    </div>
  )
})}
```

Notes:
- The `StatusPicker`/`AccountPicker` trigger buttons add `pointer-events-auto` (via the passed `className`) so they capture their own clicks while the rest of the content stays click-through to the nav button.
- `accName`/`acc` local is no longer needed here (AccountPicker resolves the account itself). Remove the now-dead `const accName = …` helper at line ~63 **only if** unused elsewhere — it's only used in this map, so remove it.
- The portaled popover/Modal both render at `z-[70]`/`z-50`, above the card's `z-10` content and `z-0` nav button.

- [ ] **Step 4: Remove the dead `accName` helper**

Delete `const accName = (id?: string) => accounts?.find((a) => a.id === id)` (line ~63) — now unused.

- [ ] **Step 5: Typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: typecheck PASS (resolve any unused-import errors flagged for `clsx`/`STATUS_LABELS`/`STATUS_TONE`/`Thumb` usage), tests PASS (116 + 4 new = 120).

- [ ] **Step 6: Commit**

```bash
git add src/pages/Inventory.tsx
git commit -m "feat(magazyn): inline status + account editing on cards; stable createdAt sort"
```

---

### Task 8: Manual browser verification (the DoD gate)

**Files:** none (verification only).

Run `npm run dev`, go to **Magazyn**. Verify each item; fix and re-verify on any failure.

**Golden path**
- [ ] Click a card's **status pill** → picker opens anchored under it (desktop) showing 6 colored statuses with the current one checked.
- [ ] Pick a non-sold status → pill recolors **instantly**, picker closes, no toast, no navigation.
- [ ] Click the **account chip** → picker lists accounts (color dot + name) + "Bez konta"; pick one → chip updates instantly. Pick **Bez konta** → chip becomes the dashed "Przypisz konto" affordance.
- [ ] A card with **no account** shows the dashed "Przypisz konto" chip; assigning works.
- [ ] Click anywhere else on the card (thumbnail/name/price) → navigates to the editor.

**`sold` special case**
- [ ] Pick **Sprzedane** in the status picker → `SoldModal` opens (not a silent flip). Enter price → save → status becomes Sprzedane, a row appears in **Sprzedaż**. Cancel instead → status unchanged.

**Burst editing (the core use case)**
- [ ] Change statuses on 5 different cards in a row → **no card jumps position** between edits (createdAt sort holds).

**Popover robustness (desktop)**
- [ ] Open the status picker on a **right-column** card → panel is fully visible, clamped inside the viewport (not cut off on the right).
- [ ] Open the picker on a **bottom-row** card → panel flips **above** the trigger when there's no room below.
- [ ] Open a picker, then **scroll** the page → picker closes (no orphaned floating menu).
- [ ] Open a picker, press **Escape** → closes and focus returns to the pill.
- [ ] Open a picker, click **outside** → closes.

**Mobile (DevTools responsive ≤640px)**
- [ ] Tap status pill → opens as a **bottom sheet** (`Modal`) with large (≥44px) rows; tap a status → writes + closes.
- [ ] Tap account chip → bottom-sheet account picker works; "Bez konta" clears.
- [ ] Tapping the card body still navigates.

**Keyboard / a11y**
- [ ] Tab to a card → the nav button focuses (visible ring); **Enter AND Space** both navigate.
- [ ] No `<button>` nested in `<button>` (inspect DOM); pills have `aria-haspopup="dialog"` + `aria-expanded`.

**Regression**
- [ ] Filters (status / account / search) still work and combine.
- [ ] ProductEditor "Sprzedane" button still records a sale (Task 3 regression).
- [ ] `npm run build` succeeds.

- [ ] **Commit** any fixes made during verification with descriptive messages.

---

## 10/10 Definition of Done

- [ ] Status changeable in-place from the card; account assignable in-place — both with no navigation. *(user's explicit ask)*
- [ ] `sold` routes through `SoldModal` (Sale recorded); other 5 flip instantly.
- [ ] No `product.soldAt`/`listedAt` dead-writes from the grid picker.
- [ ] Grid sort is stable during a burst (no reorder-on-edit).
- [ ] Card nav is a real `<button>`: Enter+Space navigate, focus ring visible, **no nested interactive elements**.
- [ ] Popover never clipped (portaled), never orphaned (close-on-scroll), never off-screen (clamp + flip) — verified on corner cards + mobile.
- [ ] Optimistic recolor is the confirmation; `toast.error` only on write failure (no success-toast spam).
- [ ] `npm run typecheck`, `npm test` (120 tests), `npm run build` all green.
- [ ] Scope held: only status + account inline editing (no bulk-select, drag, listed-date, or new color tokens).

## Outcome & deviations (post-implementation)

Implemented across 7 commits (`5e6ec88..3dae1c4`). The task code blocks above capture the
initial design; two review rounds refined the following — see commit history for the exact diffs:

- **ARIA model changed `dialog`/`listbox` → `menu`.** The panels are native buttons without a
  roving-tabindex keyboard model, so `role="dialog"`+`role="listbox"`/`option` was a lying
  contract. Final: trigger `aria-haspopup="menu"`, panel content `role="menu"` with
  `role="menuitemradio"` + `aria-checked` rows (Tab + Enter/Space, no custom keyboard code).
- **`Modal` is now portaled to `document.body`** (`ui.tsx`). Required: the grid card's
  `pointer-events-none` content layer made the inline SoldModal / mobile sheet unclickable.
  Caught by the live browser test.
- **Desktop/mobile split gated on `pointer: fine`** (not width alone) so touch tablets ≥640px
  use the scroll-locked sheet instead of the close-on-scroll popover.
- **Popover** caps height to the viewport + scrolls internally (ignoring its own scroll in the
  close handler); closes on breakpoint change; restores focus to the trigger on close.
- **44px mobile tap targets** via a `.tap-target` utility in `index.css`.
- **`StatusPicker` re-pick guard**: re-selecting `sold` on an already-sold item is a no-op
  (was opening SoldModal again → duplicate `Sale`). HIGH-severity fix.
- **`SoldModal` seeds on the rising edge of `open`**, not on `product` identity — in the grid
  `product` comes from `useLiveQuery` and re-emits on any products write/sync pull, which wiped
  typed input mid-entry. MEDIUM fix; proven with a two-page cross-tab regression test.
- **Lazy-mount SoldModal per card**; `.tap-target` extraction; dead `open` prop dropped;
  `ProductEditor` reuses `requiresSaleModal()`.

**Verification:** `npm run typecheck` clean, `npm test` 120 pass, `npm run build` green, plus a
headless-Chrome smoke (18/18 checks, 0 console errors) and a cross-tab regression test
(`scripts/verify-*.mjs` — uncommitted; need `npm i playwright-core` to re-run).

## Out of scope (explicitly deferred)
- Desktop right-click context menu & keyboard hotkeys (Linear-style power-user redundancy).
- Multi-select / bulk status changes.
- Drag-to-column / Kanban board view.
- Type-to-filter inside pickers (unnecessary at 6 statuses / 2-4 accounts).
