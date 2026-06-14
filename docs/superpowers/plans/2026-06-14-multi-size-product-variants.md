# Multi-Size Product Variants (Model + rozmiary) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the same garment in multiple sizes share one set of photos, AI on-model shots, descriptions, and identity, while each size stays its own listing/sale unit.

**Architecture:** A new synced `Design` entity owns the shared content; each `Product` gains `designId?` and keeps only per-size fields. A pure `resolveProduct()` overlays shared fields so existing prompt/price code is untouched. Inventory shows one card per design, the editor gets a shared-block + size-switcher mode, and PhotoStudio saves generated photos to the design. Sync adds a `designs` table exactly like `expenses` did (Dexie v4 + D1 `0003`).

**Tech Stack:** Vite + React + TypeScript + Tailwind, Dexie (IndexedDB), Zustand, Vitest + fake-indexeddb, Cloudflare Pages Functions + D1 (sync backend).

**Spec:** `docs/superpowers/specs/2026-06-14-multi-size-product-variants-design.md`

**Conventions for every task:**
- Run a single test file with: `npx vitest run <path>` (e.g. `npx vitest run src/lib/designs.test.ts`). Full suite: `npm test`. Types: `npm run typecheck`. Build: `npm run build`.
- There is **no React Testing Library** in this project — UI tasks are verified by `npm run typecheck` + `npm run build` + manual steps, not automated component tests. All logic/DB tasks are TDD.
- **Every** `git commit` message must end with this trailer (shown in Task 1, omitted for brevity afterwards — always include it):

  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```

---

## File Structure

**New files:**
- `src/lib/designs.ts` — pure `resolveProduct()` + `SHARED_FIELDS` (no Dexie/React).
- `src/lib/designs.test.ts` — resolver unit tests.
- `src/db/designs.test.ts` — DB-level tests for grouping/dissolve/cascade.
- `migrations/0003_designs.sql` — D1 envelope table for `designs`.

**Modified files:**
- `src/db/types.ts` — `Design` interface; `Product.designId?`; `ImageRecord.designId?`.
- `src/db/db.ts` — Dexie v4 (`designs` store + `designId` index on products), `EntityMap`, `SCHEMA_VERSION`, export/import/clear, `groupProducts`/`addSizeToDesign`/`dissolveDesign`/`deleteDesignCascade`, `deleteProductCascade` grouped path.
- `src/sync/core.ts` — add `'designs'` to `SYNC_TABLES`.
- `src/sync/core.test.ts` — expected table list.
- `src/App.tsx` — route `magazyn/model/:designId`.
- `src/pages/Inventory.tsx` — group-by-design, one-card render, filter-any-match, "Połącz" selection mode + group modal.
- `src/pages/ProductEditor.tsx` — design mode (size switcher, shared/per-size split, shared tabs, add size, dissolve, delete, sold-with-size-name).
- `src/pages/PhotoStudio.tsx` — design-aware subject + save generated photos to the design.

---

## Phase 1 — Data model & resolver

### Task 1: Domain types for designs

**Files:**
- Modify: `src/db/types.ts`

- [ ] **Step 1: Add the `Design` interface and the two optional backrefs**

In `src/db/types.ts`, add `designId?: ID` to `ImageRecord` (next to the existing `productId?`/`modelId?` backrefs):

```ts
  productId?: ID
  modelId?: ID
  /** Backref dla porzadkow/kaskad, gdy obraz nalezy do modelu (wspoldzielony). */
  designId?: ID
```

Add `designId?: ID` to `Product` (after `accountId?: ID`):

```ts
  accountId?: ID
  /** Gdy ustawione: produkt jest rozmiarem nalezacym do modelu; pola wspolne
   *  (nazwa, marka, zdjecia, opisy) czyta z Design, a wlasne sa wyczyszczone. */
  designId?: ID
```

Add the new `Design` interface immediately after the `Product` interface:

```ts
/** Wspolny fason ("Model" w UI) — wspoldzielony przez warianty rozmiarowe.
 *  Trzyma to, co identyczne miedzy rozmiarami: tozsamosc, zdjecia, opisy. */
export interface Design {
  id: ID
  name: string
  brand?: string
  color?: string
  material?: string
  category?: string
  tags: string[]
  /** Oryginalne zdjecia produktu — wspoldzielone przez wszystkie rozmiary. */
  photoIds: ID[]
  /** Zdjecia na modelce AI — wspoldzielone. */
  generatedPhotoIds: ID[]
  /** Zapisane opisy (jeden active) — wspoldzielone. */
  descriptions: SavedDescription[]
  createdAt: number
  updatedAt: number
}
```

- [ ] **Step 2: Verify types compile**

Run: `npm run typecheck`
Expected: PASS (no usages yet; purely additive).

- [ ] **Step 3: Commit**

```bash
git add src/db/types.ts
git commit -m "feat(designs): add Design type and designId backrefs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `resolveProduct` overlay (pure, TDD)

**Files:**
- Create: `src/lib/designs.ts`
- Test: `src/lib/designs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/designs.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveProduct, SHARED_FIELDS } from './designs'
import type { Design, Product } from '@/db/types'

const design = (over: Partial<Design> = {}): Design => ({
  id: 'd1',
  name: 'Kurtka NYC',
  brand: 'NF',
  color: 'czarny',
  material: 'poliester',
  category: 'Kobiety / Kurtki',
  tags: ['vintage'],
  photoIds: ['ph1'],
  generatedPhotoIds: ['g1'],
  descriptions: [{ id: 'x', styleId: 's', styleLabel: 'S', text: 't', active: true, createdAt: 1 }],
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

const product = (over: Partial<Product> = {}): Product => ({
  id: 'p1',
  name: '',
  condition: 'dobry',
  currency: 'PLN',
  quantity: 1,
  status: 'in_stock',
  photoIds: [],
  generatedPhotoIds: [],
  descriptions: [],
  tags: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

describe('resolveProduct', () => {
  it('returns the product unchanged when it has no designId', () => {
    const p = product({ name: 'Solo', brand: 'Zara', photoIds: ['own'] })
    expect(resolveProduct(p, new Map())).toBe(p)
  })

  it('overlays shared fields from the design, keeps per-size fields', () => {
    const d = design()
    const p = product({
      designId: 'd1',
      sizeLabel: 'M',
      listingPrice: 89,
      condition: 'bardzo_dobry',
      accountId: 'acc1',
    })
    const r = resolveProduct(p, new Map([['d1', d]]))
    expect(r.name).toBe('Kurtka NYC')
    expect(r.brand).toBe('NF')
    expect(r.photoIds).toEqual(['ph1'])
    expect(r.generatedPhotoIds).toEqual(['g1'])
    expect(r.descriptions).toHaveLength(1)
    // per-size preserved
    expect(r.sizeLabel).toBe('M')
    expect(r.listingPrice).toBe(89)
    expect(r.condition).toBe('bardzo_dobry')
    expect(r.accountId).toBe('acc1')
  })

  it('falls back to the bare product when the design is missing (e.g. mid-sync)', () => {
    const p = product({ designId: 'gone' })
    const r = resolveProduct(p, new Map())
    expect(r.name).toBe('')
    expect(r.photoIds).toEqual([])
  })

  it('SHARED_FIELDS lists exactly the design-owned fields', () => {
    expect([...SHARED_FIELDS]).toEqual([
      'name', 'brand', 'color', 'material', 'category', 'tags',
      'photoIds', 'generatedPhotoIds', 'descriptions',
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/designs.test.ts`
Expected: FAIL — `Cannot find module './designs'`.

- [ ] **Step 3: Implement `src/lib/designs.ts`**

```ts
// Czyste funkcje warstwy modeli — bez Dexie/React, w pelni testowalne.
import type { Design, ID, Product } from '@/db/types'

/** Pola, ktore dla zgrupowanego produktu pochodza z Design (nie z Product). */
export const SHARED_FIELDS = [
  'name', 'brand', 'color', 'material', 'category', 'tags',
  'photoIds', 'generatedPhotoIds', 'descriptions',
] as const

/**
 * Zwraca obiekt w ksztalcie Product: dla zgrupowanego (designId ustawione) naklada
 * pola wspolne z modelu, zachowujac pola per-size; dla samodzielnego zwraca produkt
 * bez zmian. Gdy model nie dotarl (sync) — bezpieczny fallback do golego produktu.
 */
export function resolveProduct(product: Product, designsById: Map<ID, Design>): Product {
  if (!product.designId) return product
  const d = designsById.get(product.designId)
  if (!d) return product
  return {
    ...product,
    name: d.name,
    brand: d.brand,
    color: d.color,
    material: d.material,
    category: d.category,
    tags: d.tags,
    photoIds: d.photoIds,
    generatedPhotoIds: d.generatedPhotoIds,
    descriptions: d.descriptions,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/designs.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/designs.ts src/lib/designs.test.ts
git commit -m "feat(designs): resolveProduct overlay + SHARED_FIELDS"
```

---

## Phase 2 — DB layer

### Task 3: Dexie v4 — `designs` store, `designId` index, EntityMap

**Files:**
- Modify: `src/db/db.ts`
- Test: `src/db/designs.test.ts` (created here, grown in later tasks)

- [ ] **Step 1: Write the failing test**

Create `src/db/designs.test.ts`:

```ts
import { beforeEach, describe, it, expect } from 'vitest'
import { db, putEntity } from './db'
import type { Design } from './types'

async function clearAll() {
  await Promise.all([
    db.products.clear(), db.designs.clear(), db.models.clear(),
    db.accounts.clear(), db.sales.clear(), db.expenses.clear(),
    db.images.clear(), db.settings.clear(), db.outbox.clear(),
    db.sync_meta.clear(), db.blob_outbox.clear(),
  ])
}
beforeEach(clearAll)

const sampleDesign = (id = 'd1'): Design => ({
  id, name: 'Kurtka NYC', tags: [], photoIds: [], generatedPhotoIds: [],
  descriptions: [], createdAt: 1, updatedAt: 1,
})

describe('designs table', () => {
  it('persists a design and queues an outbox entry', async () => {
    await putEntity('designs', sampleDesign())
    expect((await db.designs.get('d1'))?.name).toBe('Kurtka NYC')
    expect((await db.outbox.get(['designs', 'd1']))?.deleted).toBe(0)
  })

  it('can query products by designId index', async () => {
    await db.products.bulkPut([
      { id: 'p1', designId: 'd1', name: '', condition: 'dobry', currency: 'PLN', quantity: 1,
        status: 'in_stock', photoIds: [], generatedPhotoIds: [], descriptions: [], tags: [],
        createdAt: 1, updatedAt: 1 },
      { id: 'p2', name: 'solo', condition: 'dobry', currency: 'PLN', quantity: 1,
        status: 'in_stock', photoIds: [], generatedPhotoIds: [], descriptions: [], tags: [],
        createdAt: 1, updatedAt: 1 },
    ])
    const grouped = await db.products.where('designId').equals('d1').toArray()
    expect(grouped.map((p) => p.id)).toEqual(['p1'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/designs.test.ts`
Expected: FAIL — `db.designs` is undefined / `KeyPath designId on object store products is not indexed`.

- [ ] **Step 3: Implement the schema bump**

In `src/db/db.ts`:

Add the import and table declaration:

```ts
import type {
  Account, AiModel, AppSettings, Design, Expense, ImageRecord, Product, Sale,
} from './types'
```

```ts
export class VintedStudioDB extends Dexie {
  products!: Table<Product, string>
  designs!: Table<Design, string>
  // …rest unchanged…
```

Append the v4 version after the existing `this.version(3)` block. Re-declaring `products` adds the `designId` index (additive):

```ts
    // v4: model wspoldzielony (Design) + indeks designId na products. Czysto
    // addytywne — nowa pusta tabela i nowy indeks, brak migracji danych.
    this.version(4).stores({
      designs: 'id, createdAt, updatedAt',
      products:
        'id, status, accountId, brand, category, createdAt, updatedAt, soldAt, designId, *tags',
    })
```

Bump the constant:

```ts
export const SCHEMA_VERSION = 4
```

Add `designs` to `EntityMap`:

```ts
interface EntityMap {
  products: Product
  designs: Design
  models: AiModel
  // …rest unchanged…
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/db/designs.test.ts`
Expected: PASS (2 tests).

> Note: `SCHEMA_VERSION` also drives `migrateSettings` — bumping to 4 with no new settings migration is fine (the function only acts when `schemaVersion < 2`). Confirm `npx vitest run src/db/settingsMigration.test.ts` still PASSES.

- [ ] **Step 5: Commit**

```bash
git add src/db/db.ts src/db/designs.test.ts
git commit -m "feat(designs): Dexie v4 designs store + designId index"
```

---

### Task 4: Include `designs` in export / import / clear

**Files:**
- Modify: `src/db/db.ts`
- Test: `src/db/designs.test.ts`

- [ ] **Step 1: Add the failing test** (append to `src/db/designs.test.ts`)

```ts
import { exportAll, importAll, clearAllData } from './db'

describe('designs in export/import/clear', () => {
  it('round-trips a design through exportAll/importAll', async () => {
    await putEntity('designs', sampleDesign())
    const dump = await exportAll()
    expect(dump.designs.map((d) => d.id)).toEqual(['d1'])
    await db.designs.clear()
    await importAll(dump)
    expect((await db.designs.get('d1'))?.name).toBe('Kurtka NYC')
  })

  it('clearAllData tombstones designs', async () => {
    await putEntity('designs', sampleDesign())
    await db.outbox.clear()
    await clearAllData()
    expect(await db.designs.get('d1')).toBeUndefined()
    expect((await db.outbox.get(['designs', 'd1']))?.deleted).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/designs.test.ts`
Expected: FAIL — `dump.designs` is undefined; `clearAllData` leaves the design.

- [ ] **Step 3: Wire `designs` into the three functions**

In `exportAll`, add `db.designs.toArray()` to the `Promise.all` (place `designs` right after `products`), destructure it, and include `designs` in the returned object:

```ts
  const [products, designs, models, accounts, sales, expenses, settings, images] =
    await Promise.all([
      db.products.toArray(),
      db.designs.toArray(),
      db.models.toArray(),
      db.accounts.toArray(),
      db.sales.toArray(),
      db.expenses.toArray(),
      getSettings(),
      db.images.toArray(),
    ])
  // …
  return {
    app: 'vinted-studio',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: Date.now(),
    products,
    designs,
    models,
    // …rest unchanged…
  }
```

In `importAll`: add `const designs = (data.designs ?? []).map(withUpdatedAt)`, add `db.designs` to the transaction's table array, and add a bulk-put + queue block mirroring `products`:

```ts
      if (designs.length) {
        await db.designs.bulkPut(designs)
        await queue('designs', designs)
      }
```

In `clearAllData`: add `db.designs` to the transaction's table array and add a `tombstoneAll` call:

```ts
      await tombstoneAll('designs', db.designs as Table<{ id: string }, string>)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/db/designs.test.ts`
Expected: PASS (all design tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/db.ts src/db/designs.test.ts
git commit -m "feat(designs): include designs in export/import/clear"
```

---

### Task 5: `groupProducts` (bottom-up grouping, TDD)

**Files:**
- Modify: `src/db/db.ts`
- Test: `src/db/designs.test.ts`

- [ ] **Step 1: Add the failing test**

First add a `sampleProduct` helper near the top of `src/db/designs.test.ts` (after `sampleDesign`):

```ts
import type { Product } from './types'
const sampleProduct = (id: string, over: Partial<Product> = {}): Product => ({
  id, name: 'X', condition: 'dobry', currency: 'PLN', quantity: 1, status: 'in_stock',
  photoIds: [], generatedPhotoIds: [], descriptions: [], tags: [], createdAt: 1, updatedAt: 1,
  ...over,
})
```

Then the test:

```ts
import { groupProducts } from './db'

describe('groupProducts', () => {
  it('creates a design, moves shared content, clears members, queues outbox', async () => {
    await db.images.bulkPut([
      { id: 'i1', mime: 'image/jpeg', width: 1, height: 1, thumb: 't', kind: 'product', createdAt: 1, updatedAt: 1 },
      { id: 'i2', mime: 'image/jpeg', width: 1, height: 1, thumb: 't', kind: 'product', createdAt: 1, updatedAt: 1 },
    ])
    await db.products.bulkPut([
      sampleProduct('pS', { name: 'Kurtka NYC', brand: 'NF', sizeLabel: 'S', photoIds: ['i1'],
        tags: ['a'], descriptions: [{ id: 'dx', styleId: 's', styleLabel: 'S', text: 't', active: true, createdAt: 1 }] }),
      sampleProduct('pM', { name: 'Kurtka NYC', brand: 'NF', sizeLabel: 'M', photoIds: ['i2'], tags: ['b'] }),
    ])
    await db.outbox.clear()

    const design = await groupProducts(['pS', 'pM'], 'pS')

    // design seeded from primary + merged galleries/tags/descriptions
    expect(design.name).toBe('Kurtka NYC')
    expect(design.photoIds).toEqual(['i1', 'i2'])
    expect(design.tags.sort()).toEqual(['a', 'b'])
    expect(design.descriptions.filter((d) => d.active)).toHaveLength(1)

    // members point at the design and have shared fields cleared, per-size kept
    const pM = await db.products.get('pM')
    expect(pM?.designId).toBe(design.id)
    expect(pM?.name).toBe('')
    expect(pM?.photoIds).toEqual([])
    expect(pM?.sizeLabel).toBe('M')

    // images reassigned to the design
    expect((await db.images.get('i1'))?.designId).toBe(design.id)
    expect((await db.images.get('i1'))?.productId).toBeUndefined()

    // outbox queued for design + both products + both images
    expect((await db.outbox.get(['designs', design.id]))?.deleted).toBe(0)
    expect(await db.outbox.get(['products', 'pM'])).toBeTruthy()
    expect(await db.outbox.get(['images', 'i1'])).toBeTruthy()
  })

  it('rejects fewer than two products', async () => {
    await expect(groupProducts(['pS'], 'pS')).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/designs.test.ts`
Expected: FAIL — `groupProducts` is not exported.

- [ ] **Step 3: Implement `groupProducts` in `src/db/db.ts`**

Add `Design`, `SavedDescription` to the type imports if not present, then:

```ts
/**
 * Laczy >=2 SAMODZIELNE produkty w nowy model. `primaryId` zasiewa tozsamosc;
 * zdjecia/opisy/tagi WSZYSTKICH czlonkow sa scalane do modelu (dedup po id,
 * kolejnosc: primary pierwszy), dokladnie jeden opis `active`. Kazdy czlonek:
 * designId = model.id, pola wspolne wyczyszczone; obrazy dostaja designId.
 */
export async function groupProducts(
  productIds: string[],
  primaryId: string,
): Promise<Design> {
  if (productIds.length < 2) throw new Error('Zaznacz co najmniej dwa produkty.')
  if (!productIds.includes(primaryId)) throw new Error('Produkt glowny musi byc zaznaczony.')
  const now = Date.now()
  const designId = uid()
  return db.transaction('rw', db.products, db.designs, db.images, db.outbox, async () => {
    const loaded = await Promise.all(productIds.map((id) => db.products.get(id)))
    const products = loaded.filter((p): p is Product => !!p && !p.designId)
    const primary = products.find((p) => p.id === primaryId)
    if (!primary) throw new Error('Nie znaleziono produktu glownego (lub jest juz w modelu).')
    const ordered = [primary, ...products.filter((p) => p.id !== primaryId)]

    const dedup = (xs: string[]) => [...new Set(xs)]
    const photoIds = dedup(ordered.flatMap((p) => p.photoIds))
    const generatedPhotoIds = dedup(ordered.flatMap((p) => p.generatedPhotoIds))
    const tags = dedup(ordered.flatMap((p) => p.tags))

    const seen = new Set<string>()
    const merged: SavedDescription[] = []
    for (const p of ordered)
      for (const d of p.descriptions)
        if (!seen.has(d.id)) { seen.add(d.id); merged.push({ ...d }) }
    const primaryActiveId = primary.descriptions.find((d) => d.active)?.id
    const descriptions = merged.map((d, i) => ({
      ...d,
      active: primaryActiveId ? d.id === primaryActiveId : i === 0,
    }))

    const design: Design = {
      id: designId,
      name: primary.name,
      brand: primary.brand,
      color: primary.color,
      material: primary.material,
      category: primary.category,
      tags,
      photoIds,
      generatedPhotoIds,
      descriptions,
      createdAt: now,
      updatedAt: now,
    }
    await db.designs.put(design)
    await db.outbox.put({ table: 'designs', id: designId, deleted: 0, updatedAt: now })

    for (const imgId of [...photoIds, ...generatedPhotoIds]) {
      const img = await db.images.get(imgId)
      if (!img) continue
      await db.images.put({ ...img, designId, productId: undefined, updatedAt: now })
      await db.outbox.put({ table: 'images', id: imgId, deleted: 0, updatedAt: now })
    }

    for (const p of ordered) {
      const next: Product = {
        ...p,
        designId,
        name: '',
        brand: undefined,
        color: undefined,
        material: undefined,
        category: undefined,
        tags: [],
        photoIds: [],
        generatedPhotoIds: [],
        descriptions: [],
        updatedAt: now,
      }
      await db.products.put(next)
      await db.outbox.put({ table: 'products', id: p.id, deleted: 0, updatedAt: now })
    }
    return design
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/db/designs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/db.ts src/db/designs.test.ts
git commit -m "feat(designs): groupProducts bottom-up grouping"
```

---

### Task 6: `addSizeToDesign` (top-down, TDD)

**Files:**
- Modify: `src/db/db.ts`
- Test: `src/db/designs.test.ts`

- [ ] **Step 1: Add the failing test**

```ts
import { addSizeToDesign } from './db'

describe('addSizeToDesign', () => {
  it('creates a draft product linked to the design with per-size seed', async () => {
    await putEntity('designs', sampleDesign())
    await db.outbox.clear()
    const p = await addSizeToDesign('d1', { sizeLabel: 'L', listingPrice: 95 })
    const row = await db.products.get(p.id)
    expect(row?.designId).toBe('d1')
    expect(row?.status).toBe('draft')
    expect(row?.sizeLabel).toBe('L')
    expect(row?.listingPrice).toBe(95)
    expect(row?.name).toBe('')
    expect((await db.outbox.get(['products', p.id]))?.deleted).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/designs.test.ts`
Expected: FAIL — `addSizeToDesign` is not exported.

- [ ] **Step 3: Implement in `src/db/db.ts`**

```ts
/** Dodaje nowy, pusty rozmiar do modelu (odgornie). Pola per-size z `seed`. */
export async function addSizeToDesign(
  designId: string,
  seed: Partial<Product> = {},
): Promise<Product> {
  const product: Product = {
    id: uid(),
    designId,
    name: '',
    condition: seed.condition ?? 'dobry',
    currency: seed.currency ?? 'PLN',
    quantity: seed.quantity ?? 1,
    status: 'draft',
    photoIds: [],
    generatedPhotoIds: [],
    descriptions: [],
    tags: [],
    sizeLabel: seed.sizeLabel,
    accountId: seed.accountId,
    listingPrice: seed.listingPrice,
    purchasePrice: seed.purchasePrice,
    measurements: seed.measurements,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  return putEntity('products', product)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/db/designs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/db.ts src/db/designs.test.ts
git commit -m "feat(designs): addSizeToDesign top-down size creation"
```

---

### Task 7: `dissolveDesign` + cascade deletes (TDD)

**Files:**
- Modify: `src/db/db.ts`
- Test: `src/db/designs.test.ts`

- [ ] **Step 1: Add the failing test**

```ts
import { dissolveDesign, deleteDesignCascade, deleteProductCascade } from './db'

describe('dissolveDesign', () => {
  it('clones shared content to each member and deletes the design', async () => {
    await db.images.put({ id: 'i1', blob: new Blob(['x']), mime: 'image/jpeg', width: 1, height: 1, thumb: 't', kind: 'product', designId: 'd1', createdAt: 1, updatedAt: 1 })
    await db.designs.put({ ...sampleDesign(), brand: 'NF', photoIds: ['i1'],
      descriptions: [{ id: 'dx', styleId: 's', styleLabel: 'S', text: 't', active: true, createdAt: 1 }] })
    await db.products.bulkPut([
      sampleProduct('pS', { designId: 'd1', name: '', sizeLabel: 'S' }),
      sampleProduct('pM', { designId: 'd1', name: '', sizeLabel: 'M' }),
    ])
    await db.outbox.clear()

    await dissolveDesign('d1')

    expect(await db.designs.get('d1')).toBeUndefined()
    expect(await db.images.get('i1')).toBeUndefined() // shared image removed
    const pS = await db.products.get('pS')
    expect(pS?.designId).toBeUndefined()
    expect(pS?.name).toBe('Kurtka NYC')   // identity copied back
    expect(pS?.brand).toBe('NF')
    expect(pS?.photoIds).toHaveLength(1)  // image cloned
    expect(pS?.photoIds[0]).not.toBe('i1') // a fresh clone id
    expect(pS?.descriptions).toHaveLength(1)
    // both members got independent clones
    const pM = await db.products.get('pM')
    expect(pM?.photoIds[0]).not.toBe(pS?.photoIds[0])
  })
})

describe('deleteDesignCascade', () => {
  it('removes the design, its shared images, and all members', async () => {
    await db.images.put({ id: 'i1', mime: 'image/jpeg', width: 1, height: 1, thumb: 't', kind: 'product', designId: 'd1', createdAt: 1, updatedAt: 1 })
    await db.designs.put({ ...sampleDesign(), photoIds: ['i1'] })
    await db.products.put(sampleProduct('pS', { designId: 'd1' }))
    await db.outbox.clear()
    await deleteDesignCascade('d1')
    expect(await db.designs.get('d1')).toBeUndefined()
    expect(await db.images.get('i1')).toBeUndefined()
    expect(await db.products.get('pS')).toBeUndefined()
    expect((await db.outbox.get(['designs', 'd1']))?.deleted).toBe(1)
  })
})

describe('deleteProductCascade on grouped members', () => {
  it('deletes only the member while siblings remain', async () => {
    await db.designs.put(sampleDesign())
    await db.products.bulkPut([
      sampleProduct('pS', { designId: 'd1' }),
      sampleProduct('pM', { designId: 'd1' }),
    ])
    await deleteProductCascade('pS')
    expect(await db.products.get('pS')).toBeUndefined()
    expect(await db.products.get('pM')).toBeTruthy()
    expect(await db.designs.get('d1')).toBeTruthy()
  })

  it('removes the design too when the last member goes', async () => {
    await db.designs.put(sampleDesign())
    await db.products.put(sampleProduct('pS', { designId: 'd1' }))
    await deleteProductCascade('pS')
    expect(await db.products.get('pS')).toBeUndefined()
    expect(await db.designs.get('d1')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/designs.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement in `src/db/db.ts`**

Add a private clone helper and the two cascade functions, and rewrite `deleteProductCascade` to branch on `designId`:

```ts
/** Klonuje wiersz obrazu na wlasnosc produktu (nowy id, ten sam blob). */
async function cloneImageRow(
  id: string,
  productId: string | undefined,
  now: number,
): Promise<string | null> {
  const img = await db.images.get(id)
  if (!img) return null
  const newId = uid()
  await db.images.put({ ...img, id: newId, productId, designId: undefined, createdAt: now, updatedAt: now })
  await db.outbox.put({ table: 'images', id: newId, deleted: 0, updatedAt: now })
  if (img.blob) await db.blob_outbox.put({ id: newId })
  return newId
}

/**
 * Rozlacza CALY model: kazdy czlonek dostaje KOPIE tozsamosci, KOPIE obrazow
 * (klon bloba -> nowy ImageRecord) i kopie opisow; nastepnie model i jego
 * wspoldzielone obrazy sa usuwane. Bezstratne (poza obrazami tylko w R2 — patrz spec).
 */
export async function dissolveDesign(designId: string): Promise<void> {
  const now = Date.now()
  await db.transaction(
    'rw', db.products, db.designs, db.images, db.outbox, db.blob_outbox,
    async () => {
      const design = await db.designs.get(designId)
      if (!design) return
      const members = await db.products.where('designId').equals(designId).toArray()
      for (const m of members) {
        const photoIds: string[] = []
        for (const imgId of design.photoIds) {
          const nid = await cloneImageRow(imgId, m.id, now)
          if (nid) photoIds.push(nid)
        }
        const generatedPhotoIds: string[] = []
        for (const imgId of design.generatedPhotoIds) {
          const nid = await cloneImageRow(imgId, m.id, now)
          if (nid) generatedPhotoIds.push(nid)
        }
        const next: Product = {
          ...m,
          designId: undefined,
          name: design.name,
          brand: design.brand,
          color: design.color,
          material: design.material,
          category: design.category,
          tags: [...design.tags],
          photoIds,
          generatedPhotoIds,
          descriptions: design.descriptions.map((d) => ({ ...d })),
          updatedAt: now,
        }
        await db.products.put(next)
        await db.outbox.put({ table: 'products', id: m.id, deleted: 0, updatedAt: now })
      }
      for (const imgId of [...design.photoIds, ...design.generatedPhotoIds]) {
        await db.images.delete(imgId)
        await db.outbox.put({ table: 'images', id: imgId, deleted: 1, updatedAt: now })
        await db.blob_outbox.delete(imgId)
      }
      await db.designs.delete(designId)
      await db.outbox.put({ table: 'designs', id: designId, deleted: 1, updatedAt: now })
    },
  )
}

/** Kaskadowe usuniecie modelu: model + wspoldzielone obrazy + WSZYSCY czlonkowie. */
export async function deleteDesignCascade(designId: string): Promise<void> {
  const now = Date.now()
  await db.transaction(
    'rw', db.products, db.designs, db.images, db.outbox, db.blob_outbox,
    async () => {
      const design = await db.designs.get(designId)
      if (!design) return
      for (const imgId of [...design.photoIds, ...design.generatedPhotoIds]) {
        await db.images.delete(imgId)
        await db.outbox.put({ table: 'images', id: imgId, deleted: 1, updatedAt: now })
        await db.blob_outbox.delete(imgId)
      }
      const members = await db.products.where('designId').equals(designId).toArray()
      for (const m of members) {
        await db.products.delete(m.id)
        await db.outbox.put({ table: 'products', id: m.id, deleted: 1, updatedAt: now })
      }
      await db.designs.delete(designId)
      await db.outbox.put({ table: 'designs', id: designId, deleted: 1, updatedAt: now })
    },
  )
}
```

Rewrite the existing `deleteProductCascade` to handle grouped members first (keep the standalone path exactly as it was):

```ts
export async function deleteProductCascade(productId: string): Promise<void> {
  const product = await db.products.get(productId)
  if (!product) return
  // Rozmiar nalezacy do modelu: nie ma wlasnych obrazow (sa wspolne na modelu).
  if (product.designId) {
    const siblings = await db.products.where('designId').equals(product.designId).count()
    if (siblings <= 1) {
      await deleteDesignCascade(product.designId) // ostatni rozmiar -> usun model
    } else {
      await deleteEntity('products', productId)
    }
    return
  }
  // --- istniejaca sciezka samodzielna (bez zmian) ---
  const imageIds = [...product.photoIds, ...product.generatedPhotoIds]
  const now = Date.now()
  await db.transaction('rw', db.products, db.images, db.outbox, async () => {
    for (const imgId of imageIds) {
      await db.images.delete(imgId)
      await db.outbox.put({ table: 'images', id: imgId, deleted: 1, updatedAt: now })
    }
    await db.products.delete(productId)
    await db.outbox.put({ table: 'products', id: productId, deleted: 1, updatedAt: now })
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/db/designs.test.ts`
Then the existing cascade test still passes: `npx vitest run src/db/writes.test.ts`
Expected: PASS for both.

- [ ] **Step 5: Commit**

```bash
git add src/db/db.ts src/db/designs.test.ts
git commit -m "feat(designs): dissolveDesign + cascade deletes for groups"
```

---

## Phase 3 — Sync

### Task 8: Register `designs` as a synced table + D1 migration

**Files:**
- Modify: `src/sync/core.ts`, `src/sync/core.test.ts`
- Create: `migrations/0003_designs.sql`

- [ ] **Step 1: Update the failing test**

In `src/sync/core.test.ts`, find the assertion listing `SYNC_TABLES` and add `'designs'` right after `'products'`. If the file has no such test yet, add:

```ts
import { SYNC_TABLES } from './core'
it('SYNC_TABLES includes designs', () => {
  expect(SYNC_TABLES).toContain('designs')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sync/core.test.ts`
Expected: FAIL — `designs` not in `SYNC_TABLES`.

- [ ] **Step 3: Add `'designs'` to `SYNC_TABLES`**

In `src/sync/core.ts`:

```ts
export const SYNC_TABLES = [
  'products',
  'designs',
  'models',
  'accounts',
  'sales',
  'expenses',
  'images',
  'settings',
] as const
```

`serialize.ts`, `syncEngine.ts`, `protocol.ts`, and `functions/api/sync.ts` need **no changes** — they iterate `SYNC_TABLES` generically and the server degrades gracefully when the table is missing.

- [ ] **Step 4: Create the D1 migration**

Create `migrations/0003_designs.sql`:

```sql
-- 0003_designs.sql — koperta sync dla modeli (Design): wspoldzielony fason w wielu rozmiarach.
CREATE TABLE IF NOT EXISTS designs (
  id                 TEXT    PRIMARY KEY,
  sync_stamp         INTEGER NOT NULL,
  content_updated_at INTEGER NOT NULL,
  deleted            INTEGER NOT NULL DEFAULT 0,
  data               TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_designs_sync ON designs(sync_stamp);
```

- [ ] **Step 5: Run test + typecheck**

Run: `npx vitest run src/sync/core.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sync/core.ts src/sync/core.test.ts migrations/0003_designs.sql
git commit -m "feat(designs): sync designs table + D1 migration 0003"
```

> **Deploy note (for the owner, when the Cloudflare backend is live):** apply the D1 migration **before** deploying the client — `npm run db:migrate` then `npm run cf:deploy`. The reverse order makes the server query a non-existent `designs` table.

---

## Phase 4 — UI (no automated component tests; verify via typecheck + build + manual)

### Task 9: Inventory — group by design, one card per model, filter-any-match

**Files:**
- Modify: `src/pages/Inventory.tsx`

- [ ] **Step 1: Load designs and build display items**

Add the designs query and a memo that splits products into design-groups + standalones. Replace the `products` query area and `filtered` memo:

```ts
import type { Design, Product, ProductStatus } from '@/db/types'
import { resolveProduct } from '@/lib/designs'
// …
const designs = useLiveQuery(() => db.designs.toArray(), [])
const designsById = useMemo(
  () => new Map((designs ?? []).map((d) => [d.id, d])),
  [designs],
)

type DisplayItem =
  | { kind: 'single'; product: Product }
  | { kind: 'design'; design: Design; members: Product[]; cover?: string }

const items = useMemo<DisplayItem[]>(() => {
  const list = products ?? []
  const groups = new Map<string, Product[]>()
  const singles: Product[] = []
  for (const p of list) {
    if (p.designId && designsById.has(p.designId)) {
      ;(groups.get(p.designId) ?? groups.set(p.designId, []).get(p.designId)!).push(p)
    } else {
      singles.push(p)
    }
  }
  const out: DisplayItem[] = singles.map((product) => ({ kind: 'single', product }))
  for (const [designId, members] of groups) {
    const design = designsById.get(designId)!
    out.push({ kind: 'design', design, members, cover: design.photoIds[0] ?? design.generatedPhotoIds[0] })
  }
  // stabilne sortowanie po createdAt malejaco (model: createdAt modelu)
  return out.sort((a, b) => {
    const ca = a.kind === 'single' ? a.product.createdAt : a.design.createdAt
    const cb = b.kind === 'single' ? b.product.createdAt : b.design.createdAt
    return cb - ca
  })
}, [products, designsById])
```

- [ ] **Step 2: Apply filters with any-member-matches semantics**

```ts
const filtered = useMemo(() => {
  const needle = q.trim().toLowerCase()
  const matchesText = (p: Product) =>
    [p.name, p.brand, p.category, p.sizeLabel, ...p.tags]
      .filter(Boolean)
      .some((s) => s!.toLowerCase().includes(needle))

  return items.filter((it) => {
    if (it.kind === 'single') {
      const p = it.product
      if (status !== 'all' && p.status !== status) return false
      if (accountId !== 'all' && p.accountId !== accountId) return false
      if (needle && !matchesText(p)) return false
      return true
    }
    const { design, members } = it
    if (status !== 'all' && !members.some((m) => m.status === status)) return false
    if (accountId !== 'all' && !members.some((m) => m.accountId === accountId)) return false
    if (needle) {
      const resolved = resolveProduct(members[0], designsById)
      const designText = [design.name, design.brand, design.category, ...design.tags]
        .filter(Boolean).some((s) => s!.toLowerCase().includes(needle))
      void resolved
      if (!designText && !members.some((m) => (m.sizeLabel ?? '').toLowerCase().includes(needle))) return false
    }
    return true
  })
}, [items, status, accountId, q, designsById])
```

- [ ] **Step 3: Render both card kinds**

In the grid `.map`, branch on `it.kind`. Keep the existing single-product card exactly as-is for `kind === 'single'` (use `it.product`). Add a design card for `kind === 'design'`:

```tsx
{filtered.map((it) =>
  it.kind === 'single' ? (
    /* …existing single-product <div className="card …"> using it.product… */
  ) : (
    <DesignCard key={it.design.id} design={it.design} members={it.members} cover={it.cover}
      onOpen={() => nav(`/magazyn/model/${it.design.id}`)} />
  ),
)}
```

Add a `DesignCard` component at the bottom of the file (mirrors the single card's visual frame; summarizes sizes/statuses; price range):

```tsx
import { STATUS_OPTIONS } from '@/lib/constants'
const statusLabel = (s: ProductStatus) =>
  STATUS_OPTIONS.find((o) => o.value === s)?.label ?? s

function DesignCard({ design, members, cover, onOpen }: {
  design: Design; members: Product[]; cover?: string; onOpen: () => void
}) {
  const prices = members.map((m) => m.listingPrice).filter((n): n is number => n != null)
  const priceText = prices.length
    ? prices.length > 1 && Math.min(...prices) !== Math.max(...prices)
      ? `${Math.min(...prices)}–${Math.max(...prices)}`
      : String(prices[0])
    : '—'
  return (
    <div className="card group relative overflow-hidden transition hover:shadow-pop">
      <button type="button" aria-label={`Otworz model ${design.name || 'model'}`} onClick={onOpen}
        className="absolute inset-0 z-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400" />
      <div className="pointer-events-none relative z-10">
        <div className="relative aspect-square w-full bg-ink-100">
          <Thumb imageId={cover} className="h-full w-full object-cover" alt={design.name} />
          <span className="badge absolute left-2 top-2 bg-ink-900/80 text-white">
            {members.length} {members.length === 1 ? 'rozmiar' : 'rozmiary'}
          </span>
          {design.generatedPhotoIds.length > 0 && (
            <span className="badge absolute right-2 top-2 bg-brand-500 text-white shadow-sm">
              AI {design.generatedPhotoIds.length}
            </span>
          )}
        </div>
        <div className="p-3">
          <p className="truncate font-semibold text-ink-900">{design.name || 'Bez nazwy'}</p>
          <div className="mt-0.5 flex items-center justify-between">
            <p className="truncate text-xs text-ink-400">{design.brand || '—'}</p>
            <p className="shrink-0 text-sm font-bold text-brand-600">{priceText}</p>
          </div>
          <p className="mt-2 truncate text-xs text-ink-400">
            {members.map((m) => `${m.sizeLabel || '?'} ${statusLabel(m.status)}`).join(' · ')}
          </p>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run build`
Expected: PASS.
Manual: `npm run dev` → Magazyn renders; with no designs yet, behaves exactly as before (all cards are `single`).

- [ ] **Step 5: Commit**

```bash
git add src/pages/Inventory.tsx
git commit -m "feat(designs): inventory shows one card per model"
```

---

### Task 10: Inventory — "Połącz" selection mode + group modal

**Files:**
- Modify: `src/pages/Inventory.tsx`

- [ ] **Step 1: Add selection state + toggle**

```ts
import { groupProducts } from '@/db/db'
import { toast } from '@/state/toast'
// …
const [selecting, setSelecting] = useState(false)
const [selected, setSelected] = useState<Set<string>>(new Set())
const [groupOpen, setGroupOpen] = useState(false)

const toggleSelect = (id: string) =>
  setSelected((s) => {
    const next = new Set(s)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
const exitSelect = () => { setSelecting(false); setSelected(new Set()) }
```

- [ ] **Step 2: Add the toolbar control**

In the header `right=` cluster, before "Dodaj produkt":

```tsx
{selecting ? (
  <>
    <Button variant="ghost" onClick={exitSelect}>Anuluj</Button>
    <Button disabled={selected.size < 2} onClick={() => setGroupOpen(true)}>
      Połącz w model ({selected.size})
    </Button>
  </>
) : (
  <Button variant="ghost" onClick={() => setSelecting(true)}>Połącz</Button>
)}
```

- [ ] **Step 3: Show checkboxes on standalone cards in select mode**

In the `kind === 'single'` card, add a checkbox overlay (only standalone products are selectable — v1). Place it inside the card frame, with `pointer-events-auto`, and when `selecting`, make the stretched nav button inert:

```tsx
{selecting && (
  <label className="pointer-events-auto absolute right-2 top-2 z-20 flex h-7 w-7 items-center justify-center rounded-lg bg-surface/90 ring-1 ring-ink-200">
    <input type="checkbox" checked={selected.has(it.product.id)}
      onChange={() => toggleSelect(it.product.id)} />
  </label>
)}
```

When `selecting`, change the stretched `<button onClick={nav…}>` to instead toggle selection (or add `disabled={selecting}` and let the checkbox handle it). Simplest: `onClick={() => selecting ? toggleSelect(it.product.id) : nav(`/magazyn/${it.product.id}`)}`. Design-group cards are **not** selectable in v1 — skip the checkbox for `kind === 'design'`.

- [ ] **Step 4: Group modal (pick primary)**

Add a `Modal` (reuse `@/components/ui` `Modal`) listing the selected products with a radio to choose the primary; default to the first selected. On confirm:

```ts
const doGroup = async (primaryId: string) => {
  try {
    const ids = [...selected]
    const design = await groupProducts(ids, primaryId)
    toast.success('Połączono w model 🧩')
    setGroupOpen(false); exitSelect()
    nav(`/magazyn/model/${design.id}`)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'Nie udało się połączyć.')
  }
}
```

Modal body: map over `(products ?? []).filter(p => selected.has(p.id))`, each row a `<label>` with `<input type="radio" name="primary">`, a `<Thumb imageId={p.photoIds[0]} />`, and `p.name`. Track chosen primary in local state, default `[...selected][0]`.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run build`
Manual: `npm run dev` → "Połącz" → check two standalone items → "Połącz w model" → pick primary → lands on the model editor; Magazyn now shows one model card; the two originals are gone as separate cards.

- [ ] **Step 6: Commit**

```bash
git add src/pages/Inventory.tsx
git commit -m "feat(designs): group standalone items into a model from inventory"
```

---

### Task 11: Router + ProductEditor design mode

**Files:**
- Modify: `src/App.tsx`, `src/pages/ProductEditor.tsx`

- [ ] **Step 1: Register the route**

In `src/App.tsx`, after the `magazyn/:id` route:

```tsx
<Route path="magazyn/model/:designId" element={<ProductEditor />} />
```

- [ ] **Step 2: Detect design mode in `ProductEditor`**

`ProductEditor` currently reads `useParams().id`. Add `designId` and load accordingly. Introduce design state and the active size:

```ts
import { db, addSizeToDesign, deleteDesignCascade, dissolveDesign, deleteProductCascade, patchEntity, putEntity } from '@/db/db'
import { resolveProduct } from '@/lib/designs'
import type { Design } from '@/db/types'
// …
const { id, designId } = useParams()
const design = useLiveQuery(
  async () => (designId ? await db.designs.get(designId) : undefined),
  [designId],
)
const members = useLiveQuery(
  async () => (designId ? await db.products.where('designId').equals(designId).sortBy('createdAt') : []),
  [designId],
)
const [activeId, setActiveId] = useState<string | null>(null)
useEffect(() => {
  if (designId && members && members.length && !members.some((m) => m.id === activeId)) {
    setActiveId(members[0].id)
  }
}, [designId, members, activeId])
const activeProduct = members?.find((m) => m.id === activeId) ?? null
```

The existing standalone path (`id` set, no `designId`) stays as-is. When `designId` is set, render the design layout below.

- [ ] **Step 3: Split the update function into shared vs per-size**

```ts
const designsById = useMemo(() => (design ? new Map([[design.id, design]]) : new Map()), [design])

// Shared edits go to the Design (design mode) or to the product (standalone).
const updateShared = (patch: Partial<Design>) => {
  if (design) void patchEntity('designs', design.id, patch)
  else update(patch as Partial<Product>) // standalone: existing behavior
}
// Per-size edits always target the active product.
const updateSize = (patch: Partial<Product>) => {
  if (activeProduct) void patchEntity('products', activeProduct.id, patch)
}
```

For the shared-form inputs (brand, category, color, material, tags, name, photos, descriptions) bind value to `design.*` and onChange to `updateShared`. For per-size inputs (sizeLabel, condition, listingPrice, purchasePrice, currency, quantity, accountId, measurements, status, listingUrl) bind to `activeProduct.*` and onChange to `updateSize`.

> Refactor guidance: extract the three tab bodies (`DetailsTab`, `PhotosTab`, `DescriptionsTab`) to accept a `subject` (the resolved object to read from) plus `onShared`/`onSize` callbacks, so both standalone and design modes reuse them. In standalone mode `onShared` and `onSize` both write to the product; in design mode they split. Keep diffs minimal — only the wiring changes, not the JSX of each field.

- [ ] **Step 4: Render the size switcher + model actions (design mode header)**

```tsx
{designId && design && (
  <>
    <div className="mb-3 flex flex-wrap items-center gap-2">
      {members?.map((m) => (
        <button key={m.id} onClick={() => setActiveId(m.id)}
          className={clsx('chip', m.id === activeId ? 'bg-brand-500 text-white' : 'bg-ink-100')}>
          {m.sizeLabel || 'rozmiar'}
        </button>
      ))}
      <button className="chip bg-ink-100" onClick={async () => {
        const p = await addSizeToDesign(design.id); setActiveId(p.id)
      }}>+ Dodaj rozmiar</button>
    </div>
    {/* name input bound to design.name via updateShared */}
  </>
)}
```

Header buttons in design mode: keep the per-size status `Select` + "Sprzedane" + "Usuń" acting on `activeProduct`; add:

```tsx
<Button variant="ghost" onClick={async () => {
  if (!window.confirm('Rozłączyć model? Każdy rozmiar dostanie własną kopię zdjęć i opisów.')) return
  await dissolveDesign(design.id); nav('/magazyn')
}}>Rozłącz model</Button>
<Button variant="danger" onClick={async () => {
  if (!window.confirm('Usunąć cały model wraz ze wszystkimi rozmiarami i zdjęciami?')) return
  await deleteDesignCascade(design.id); nav('/magazyn')
}}>Usuń model</Button>
```

The "Usuń" (single size) button calls `deleteProductCascade(activeProduct.id)` then re-points `activeId` (the `members` live query updates; if it empties, `nav('/magazyn')`).

- [ ] **Step 5: Sold modal records the size-suffixed name**

In design mode, pass a resolved product whose `name` carries the size so the `Sale` is identifiable, and `onSold` writes to the active product:

```tsx
{activeProduct && (
  <SoldModal
    open={soldOpen}
    onClose={() => setSoldOpen(false)}
    product={{
      ...resolveProduct(activeProduct, designsById),
      name: `${design?.name ?? ''}${activeProduct.sizeLabel ? ` — ${activeProduct.sizeLabel}` : ''}`.trim(),
    }}
    onSold={() => { void patchEntity('products', activeProduct.id, { status: 'sold', soldAt: Date.now() }); setSoldOpen(false) }}
  />
)}
```

No change to `SoldModal.tsx` itself — it reads `product.name`/`brand`/`currency`/`purchasePrice`, all correct on the resolved object.

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm run build`
Manual (`npm run dev`):
- Open a model card → size chips show; switch sizes → per-size fields change, shared fields stay.
- Edit brand/description/photo once → switch size → the change is present (shared).
- "Dodaj rozmiar" → new chip; set its size + price.
- Mark one size "Sprzedane" → check Sprzedaż: entry reads `"<name> — <size>"`.
- "Rozłącz model" → back in Magazyn each size is a standalone card **with** photos.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src/pages/ProductEditor.tsx
git commit -m "feat(designs): product editor design mode (shared block + size switcher)"
```

---

### Task 12: PhotoStudio saves generated photos to the model

**Files:**
- Modify: `src/pages/PhotoStudio.tsx`

- [ ] **Step 1: Make the subject design-aware**

Load designs and resolve the selected product so input photos come from the design:

```ts
import { db, deleteEntity, patchEntity } from '@/db/db'
import { resolveProduct } from '@/lib/designs'
// …
const designs = useLiveQuery(() => db.designs.toArray(), [])
const designsById = useMemo(() => new Map((designs ?? []).map((d) => [d.id, d])), [designs])
const rawProduct = useLiveQuery(
  async () => (selProductId ? await db.products.get(selProductId) : undefined),
  [selProductId],
)
const product = useMemo(
  () => (rawProduct ? resolveProduct(rawProduct, designsById) : undefined),
  [rawProduct, designsById],
)
```

The product `<Select>` options can stay per-product, but label grouped sizes with their model name and size, e.g.:

```tsx
{products?.map((p) => {
  const r = resolveProduct(p, designsById)
  return (
    <option key={p.id} value={p.id}>
      {r.name || 'Bez nazwy'}{p.sizeLabel ? ` (${p.sizeLabel})` : ''} {r.photoIds.length === 0 ? '· brak zdjęcia' : ''}
    </option>
  )
})}
```

(`product.photoIds` now resolves to the design's shared photos, so `canGenerate` and the input collection work unchanged.)

- [ ] **Step 2: Route the generated-image write to the design when grouped**

In `generate()`, after `addGeneratedImage`, branch on `rawProduct?.designId`:

```ts
const rec = await addGeneratedImage(
  img.base64, img.mime,
  { modelId: mode === 'tryOn' ? selModelId : undefined, prompt, imageModel: settings.imageModel, sourceImageIds: sourceIds },
  rawProduct?.designId ? {} : { productId: product.id },
)
if (rawProduct?.designId) {
  const d = await db.designs.get(rawProduct.designId)
  if (d) await patchEntity('designs', d.id, {
    generatedPhotoIds: [rec.id, ...d.generatedPhotoIds],
  })
  await patchEntity('images', rec.id, { designId: rawProduct.designId, productId: undefined })
} else {
  const fresh = await db.products.get(product.id)
  if (fresh) await putEntity('products', { ...fresh, generatedPhotoIds: [rec.id, ...fresh.generatedPhotoIds] })
}
```

- [ ] **Step 3: Route delete-generated to the design too**

```ts
const removeGenerated = async (imageId: string) => {
  if (!rawProduct) return
  await deleteEntity('images', imageId)
  if (rawProduct.designId) {
    const d = await db.designs.get(rawProduct.designId)
    if (d) await patchEntity('designs', d.id, {
      generatedPhotoIds: d.generatedPhotoIds.filter((x) => x !== imageId),
    })
  } else {
    await patchEntity('products', rawProduct.id, {
      generatedPhotoIds: rawProduct.generatedPhotoIds.filter((x) => x !== imageId),
    })
  }
}
```

The results grid reads `product.generatedPhotoIds` (resolved) — already correct for both modes.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run build`
Manual (`npm run dev`): open Studio, pick a grouped size, generate one image → open the model in Magazyn, switch to another size → the AI photo is present on every size. Delete it in Studio → gone from all sizes.

- [ ] **Step 5: Commit**

```bash
git add src/pages/PhotoStudio.tsx
git commit -m "feat(designs): studio saves generated photos to the model"
```

---

### Task 13: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS (all existing + new design tests).

- [ ] **Step 2: Types + production build**

Run: `npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 3: Manual smoke (end-to-end)**

`npm run dev`, then walk: import/create two same-name items → group them → add a third size → shoot one AI photo (appears on all) → write one description (shared) → set per-size prices/conditions → mark one size sold (sale shows size suffix) → dissolve a different model and confirm each size keeps its own photos → export JSON in Ustawienia, "wyczyść wszystko", import the JSON back, confirm the model + sizes return intact.

- [ ] **Step 4: Final commit (if any manual fixups were needed)**

```bash
git add -A
git commit -m "chore(designs): verification fixups"
```

---

## Self-Review (completed)

- **Spec coverage:** Design entity + backrefs (T1), resolveProduct (T2), Dexie v4 + index + EntityMap (T3), export/import/clear (T4), groupProducts (T5), addSizeToDesign (T6), dissolveDesign + cascades + grouped deleteProductCascade (T7), SYNC_TABLES + D1 0003 (T8), inventory one-card + filter-any-match (T9), grouping UI (T10), router + editor design mode + sold-with-size-name (T11), PhotoStudio→design (T12), full verify (T13). All spec sections mapped.
- **Deviations from spec (intentional):** cascade/clone helpers live in `db.ts` (not `images.ts`) and write `blob_outbox` directly to avoid a `db.ts`↔`images.ts` import cycle; `SoldModal.tsx` is unchanged (the editor passes a size-suffixed resolved product instead of adding a prop) — both simpler and within scope.
- **Type consistency:** `resolveProduct(product, designsById)`, `groupProducts(ids, primaryId)`, `addSizeToDesign(designId, seed)`, `dissolveDesign(designId)`, `deleteDesignCascade(designId)` are used identically across tasks. `Design` shape matches T1.
- **Known v1 limitation (documented in spec):** `dissolveDesign` clones only locally-cached blobs; an image present only in R2 (synced device, blob not downloaded) clones without a blob. Acceptable for v1.
