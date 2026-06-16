# YOLO Plan — Listing-lifecycle foundation ("Wystawiono" capture + stale-listing radar)

> Source: `research/next-feature.md` Option **A** (the prompt's "Option C" label is a typo
> carried from the brief's hand-off; the description + all constraints describe Option A).
> Branch: `worktree-yolo+listing-lifecycle`. Worktree:
> `C:\Users\adam-\vinted-studio\.claude\worktrees\yolo+listing-lifecycle`.

## Objective

Give the app the listing-lifecycle data it is currently blind to. Start **writing
`Product.listedAt`** on every transition into `listed` (all entry points), **backfill**
existing `listed` items from `updatedAt`, surface a **"wklej link" + optional cover** capture
on ProductEditor, and add Dashboard analytics: **sell-through %**, **median days-to-sell**
(labelled partial-coverage), and a **"Wymaga uwagi"** stale-listing radar (listed > 30 days,
unsold).

**Constraints (from brief):** local-first only — no Gemini, no Vinted API, **no new D1 table**
(new optional fields ride free under blob sync; only a local Dexie v5 upgrade for the backfill).
**Do NOT build:** own-sales comparables pricing, DAC7 threshold traffic-lights, desktop
copy/download "kit".

## Key facts established in tactical research

- `Product` already declares `listingUrl?: string` (types.ts:153) and `listedAt?: number`
  (types.ts:156). **`coverImageId` does NOT exist on Product** — must be added (precedent:
  `AiModel.coverImageId`). Cover today is implicit `photoIds[0] ?? generatedPhotoIds[0]`.
- `listedAt` is currently a **dead write** — never written; comment in `productActions.ts:12-16`
  + a pinning test (`productActions.test.ts`) assert it stays `undefined`. **We change this.**
- Status-change entry points: (1) `applyStatusChange(id,status)` [Inventory grid + StatusPicker],
  (2) ProductEditor `<Select>` → `update({status})` → `putEntity`, (3) DesignEditor `<Select>`
  → `update` (per-size routing), (4) the new "Oznacz jako wystawione" button. **All four must
  stamp listedAt.** `sold` is set via SoldModal (`soldAt`); listedAt persists through it.
- Writes go through `putEntity`/`patchEntity` (auto-stamp `updatedAt`, enqueue outbox). Sync
  serializes whole-entity JSON blobs → a new optional field needs **zero D1 migration**.
- DesignEditor `update` routes fields in `SHARED_FIELDS` (designs.ts) → Design, others → active
  product. `listingUrl`/`listedAt`/`coverImageId` are **NOT shared** → correctly route per-size.
- `format.ts` has `money`, `percent` (expects a fraction), `dateShort`, `relative`, `pluralPl`.
  **No** days-between / median helper exists → add in a new `src/lib/listing.ts`.
- Dashboard uses `StatCard` (tones default/good/warn/brand), recharts, `aggregateProfit`.
  Row pattern to reuse for the radar: "Ostatnie sprzedaże" (`flex items-center gap-3 rounded-xl
  px-2 py-2 hover:bg-ink-50`).
- Cover-picker UX precedent: `Models.tsx:226-243` (Star button, `bg-amber-500` when selected).
- Tests: vitest, node env, `*.test.ts` only, `@`→`src`, `fake-indexeddb/auto`. Template:
  `productActions.test.ts`. Baseline: **206 tests pass, typecheck clean.**
- `SCHEMA_VERSION` const (db.ts:119) is kept equal to the Dexie version; `migrateSettings`
  only gates on `< 2`, so bumping the const 4→5 is a harmless stamp.

## Build sequence (TDD: test → red → implement → green after each)

### Stream 1 — Data/logic layer (pure, fully testable)

1. **`src/lib/listing.ts`** (NEW) — pure helpers:
   - `DAY_MS`, `STALE_LISTING_DAYS = 30`
   - `daysBetween(from, to)` → `Math.floor((to-from)/DAY_MS)` (clamped ≥0 in callers)
   - `median(values: number[]): number | null`
   - `coverImageIdOf(p): string | undefined` → `p.coverImageId ?? p.photoIds[0] ?? p.generatedPhotoIds[0]`
   - `daysListed(p, now): number | null` → null unless `status==='listed' && listedAt!=null`
   - `staleListings(products, now, threshold=STALE_LISTING_DAYS): {product,days}[]` oldest-first
   - `sellThrough(products): {sold, listed, rate|null}` → `sold/(sold+listed)`
   - `daysToSellStats(products): {medianDays|null, covered, totalSold}` over sold products with
     `listedAt!=null && soldAt!=null && soldAt>=listedAt`
   - **DoD:** new `src/lib/listing.test.ts` covers each (incl. empty/odd/even median, partial
     coverage, re-list edge). `npm test` green.

2. **`src/lib/productActions.ts`** — add pure `listedAtOnTransition(prev, next, now): number | null`
   → `next==='listed' && prev!=='listed' ? now : null` (re-stamps on re-list; null otherwise).
   Rewrite `applyStatusChange` to load product, compute, and patch `{status}` (+`listedAt` when
   non-null). Update the "dead write" comment to reflect listedAt is now live.
   - **DoD:** update `productActions.test.ts` (listed transition now stamps listedAt; non-listed
     transitions and already-listed don't; soldAt still untouched). Add `listedAtOnTransition`
     unit tests. `npm test` green.

3. **`src/db/db.ts`** — add `this.version(5).stores({}).upgrade(tx => …)` backfilling
   `listedAt = updatedAt ?? createdAt` for products where `status==='listed' && listedAt==null`
   (mirror v2's `toCollection().modify`). Bump `SCHEMA_VERSION` 4→5.
   - **DoD:** new test in `src/db/upgrade.test.ts` (or a new `listedAtBackfill.test.ts`) proving
     a pre-existing `listed` product without `listedAt` gets one after open; non-listed untouched;
     existing `listedAt` preserved. All `src/db/*` + settings-migration tests still green.

### Stream 2 — Product type + editor capture UI

4. **`src/db/types.ts`** — add `coverImageId?: ID` to `Product` (doc comment). Update `listedAt`
   comment (now written on `listed` transition / backfilled).

5. **`src/pages/ProductEditor.tsx`**:
   - Both `<Select>` onChange (Standalone + Design) → stamp via `listedAtOnTransition`.
   - New **`ListingCard`** in `DetailsTab` sidebar (near SEO card): listing-URL `TextInput`
     (live-saved `listingUrl`), "Otwórz ogłoszenie ↗" link when set (normalized href,
     `target=_blank rel="noopener noreferrer"`), "Wystawione {relative(listedAt)}" line when
     listed, and a primary **"Oznacz jako wystawione"** button when status ∉ {listed, sold,
     archived} → `update({status:'listed', listedAt})`.
   - **`PhotoCell`**: add `isCover` + `onSetCover` → Star button bottom-left (amber when cover),
     mirroring `Models.tsx`. `PhotosTab` computes `coverImageIdOf(draft)` and wires set-cover via
     `update({ coverImageId: id })`.
   - **DoD:** typecheck clean; manual browser check (Stream 4).

6. **`src/pages/Inventory.tsx`** — replace product cover `p.photoIds[0] ?? p.generatedPhotoIds[0]`
   at lines ~257 and ~399 with `coverImageIdOf(p)`. (Leave line 58 = design card, and
   `PhotoStudio.tsx` original-reference thumb, unchanged.)

### Stream 3 — Dashboard analytics

7. **`src/pages/Dashboard.tsx`** — new **"Cykl życia ofert"** section after the chart row:
   - Two `StatCard`s: **sell-through %** (`percent(rate)`, sub `"{sold} / {sold+listed}"`),
     **median days-to-sell** (`tone` neutral; sub `"{covered} z {totalSold} sprzedanych"` +
     partial-coverage hint; show "—" when no data).
   - **"Wymaga uwagi"** card (AlertTriangle, amber): `staleListings(products, Date.now())`,
     oldest-first, amber icon-tile rows (no thumb → avoids design-photo resolution), name +
     "{days} dni" (`pluralPl`), `money(listingPrice)`, row links to editor
     (`p.designId ? /magazyn/model/:designId : /magazyn/:id`), external-link icon to `listingUrl`
     when present. Empty state: positive message. Cap visible rows (e.g. 8) and **surface the
     remaining count** ("i N więcej") — no silent truncation.
   - `Date.now()` memoized once per render (stable for the pass).
   - **DoD:** typecheck clean; manual browser check.

### Stream 4 — Verification

8. `npm run typecheck` (exit 0), `npm test` (all green incl. new). Run `npm run dev`, exercise:
   list an item (button + grid + editor select) → listedAt stamped + URL saved + appears listed;
   set a cover → reflects in Inventory; Dashboard shows sell-through/median/stale radar; mark a
   listed item sold → days-to-sell coverage increments. Check dark mode + no regression in
   Inventory/Sales/Models.

## 10/10 quality bar

1. `listedAt` stamped on **every** non-listed→listed path; never spuriously re-written.
2. Idempotent, deterministic backfill; new items get real timestamps.
3. Dead-write comment + pinning test updated — no misleading code left behind.
4. listingUrl capture + "Oznacz jako wystawione" + cover picker all work in **both** editors
   (standalone + grouped/design), per-size routing correct.
5. Dashboard metrics honest: partial coverage labelled with an explicit "X z Y" count; no
   silent caps in the radar.
6. All pure logic unit-tested; typecheck + full suite green; feature exercised in browser.
7. Polish copy consistent (Wystawione/Wystawiono/Wymaga uwagi); dark-mode-correct Tailwind.
8. No new D1 table, no Gemini/Vinted API. Excluded: comparables, DAC7 lights, copy/download kit.

## Risks & mitigations

- **Dexie upgrade-only version** (`version(5)` with no index change): verify `.stores({})`
  inherits schema and the upgrade fires — covered by the backfill test (TDD red-first).
- **SCHEMA_VERSION bump** could ripple to settings/export tests → migrateSettings only gates
  `<2`; run the full `src/db` suite to confirm.
- **Grouped products** (designId): photos live on Design; the radar deliberately uses an icon
  tile (not a thumb) to avoid loading designs/resolveProduct in Dashboard.
- **Partial coverage** for days-to-sell is inherent (imported sales lack productId; pre-feature
  sales lack listedAt) → surfaced via the "X z Y" coverage label, not hidden.
- **Re-list semantics:** listedAt re-stamps on each entry into `listed` (age reflects current
  listing) — intentional for the staleness radar; documented on `listedAtOnTransition`.

## Progress log

- [x] Phase 0 worktree + baseline (206 tests, typecheck clean)
- [x] Phase 1 tactical research + synthesis + scope lock
- [x] Phase 2 plan written
- [x] Stream 1 (listing.ts + listingHref, productActions.listedAtOnTransition, db v5 backfill) — TDD
- [x] Stream 2 (types coverImageId, ProductEditor ListingCard + cover picker + Select stamping, Inventory cover)
- [x] Stream 3 (Dashboard "Cykl życia ofert": sell-through, median days-to-sell, "Wymaga uwagi" radar)
- [x] typecheck clean, 244 tests pass, production build green
- [x] Stream 4 verification (dev server boots HTTP 200; build green; Dexie v5 upgrade exercised in
      fake-indexeddb. No browser-automation tool in this env → no click-through; covered by tests + build)
- [x] Phase 4a review (bugs + spec, 2 opus agents) → added listedAtApprox flag + UI "≈" hint; fixes
- [x] Phase 4b simplify (4 agents) → statusChangePatch helper; cover picker standalone-only (removed
      sibling-sweep); resolveProduct for radar names; medianDays into memo; rate==null check
- [x] Phase 4b fresh second-opinion (opus) → fixed group→dissolve dangling cover (clear coverImageId
      in groupProducts + dissolveDesign) + regression tests; radar price guard; aria-labels
- [x] Phase 4b confirmation pass (opus) → "correct and complete, ready to merge"; added independent
      dissolve-legacy regression test

## Status: COMPLETE — ready for review/merge. typecheck clean, 244 tests pass, build green.
