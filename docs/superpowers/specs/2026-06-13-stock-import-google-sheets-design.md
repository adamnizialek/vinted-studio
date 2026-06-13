# Import stanu magazynu z Google Sheets (CSV) — Design

**Date:** 2026-06-13
**Status:** Approved (brainstorm) — pending spec review
**Author:** Adam + Claude

## Problem

The sold-items importer (see `2026-06-13-sales-import-google-sheets-design.md`) brings
**sold** rows from the per-account sheets (**Main**, **Zoos**) into the app's sales ledger.
It does **not** bring in items that are still **in stock** (unsold).

Adam wants unsold items in the app's **magazyn** (inventory) too, so the warehouse view
reflects real stock — not just whatever was added by hand. The only sheet that records
unsold items is **`finessin`** (the "all items" master log covering both accounts), and
`finessin` has **no account column**. So the core challenge is: bring in the unsold rows
and attribute each to the right account, even though the source can't say which account
owns it.

Decision reached during brainstorming: **auto-match each unsold item to an account by
cross-referencing the sales already imported into the app**, and hand the uncertain tail
to the user for a manual pick.

## Decisions locked during brainstorming

1. **Source of unsold stock:** the **`finessin`** sheet only. The per-account sheets are
   sold-only and unchanged. `finessin`'s *sold* rows are **ignored** by this importer
   (they are already Sales from Main/Zoos — importing them here would double-count).
2. **Account model:** **auto-match** each unsold item to an account.
3. **Match source:** the **sales already in the app** (`db.sales`, which carry `accountId`
   from the existing sold import). The user imports Main/Zoos first, then `finessin` for
   stock. No extra upload, no re-parsing the sold sheets.
4. **Ambiguity → review bucket:** items whose normalized name was sold on **exactly one**
   account are auto-assigned; items matching **two+** accounts or **none** go to a review
   bucket where the user picks the account (candidate accounts highlighted) before import.
5. **Destination:** magazyn (`db.products`), `status: 'in_stock'`.
6. **Idempotent re-import:** add `importKey?: string` to `Product` (additive, un-indexed,
   no Dexie migration). Re-importing `finessin` inserts only genuinely new stock via the
   same in-memory multiset dedup the sold importer uses; it won't clobber items the user
   has since edited or reassigned.
7. **One product per row** (not collapsed by quantity). Five `Koszulka Messi` unsold rows
   → five products with `quantity: 1`. Consistent with the sold importer (one row = one
   record) and faithful to genuinely-duplicated stock. (Collapsing into one product with
   `quantity = N` was considered and rejected: it conflicts with per-item review/account
   assignment and risks clobbering manual edits on re-import.)
8. **Default `condition`:** `'dobry'` — the sheet has no condition; this matches the
   existing "Dodaj produkt" default in `Inventory.tsx`.

## Real data shape (verified from the actual sheet)

`finessin` header:
`Data sprzedaży, Miesiąc, Nazwa przedmiotu, Cena zakupu, Cena sprzedaży, Zysk, Zysk z poprzedniego arkusza, Aktualny zysk`

Genuinely useful per-row columns: **name** (col C), **purchase cost** (col D),
**sale price** (col E). Everything else (month tag, aggregate profit columns) is ignored.

**Unsold vs sold, by example:**

| Row | Reading | Bucket |
|-----|---------|--------|
| `rrrr-12,Koszulka Messi,35,-35` | no date, no sale price, profit `-35` = −purchase | **unsold → stock** |
| `rrrr-12,Naszyjnik … CC1731433,6,-6` | no sale price | **unsold → stock** |
| `rrrr-12,Bluza zebra AX10247937,42,92,-42,92` | purchase `42,92`, no sale price | **unsold → stock** |
| `14.1.2026,rrrr-01,Szalik kości MD175497,22,4,55,…` | real date + sale price `55` | **sold → ignored** |
| `rrrr-12,Buty mrg,152,59,333,46,180,87` | sale price `333,46` present | **sold → ignored** |
| `31.01.2026,…,Podbicia main,34,39,-34,39` | boost keyword | **excluded** |
| `rrrr-12,0` / blank | no usable name | **skipped** |

**Decisive signal for "unsold stock":** the row has a name and a purchase cost, has **no
sale price**, and is **not** a boost/fee. The `rrrr-12` month tag is *not* a reliable
signal on its own (some `rrrr-12` rows are sold) — absence of a sale price is.

Data-quality quirks the importer must tolerate (same engine as the sold importer):
- Google Sheets CSV export quotes any cell containing a comma, so `"42,92"` (= 42.92) is
  recoverable despite the Polish comma-decimal.
- Names embed SKU-like codes (`Bluza zebra AX10247937`, `Naszyjnik … CC1731433`) — kept
  verbatim in `name`, stripped only when normalizing for the match.
- Boost/fee rows (`Podbicia`, `Ekspozycja`, `podbica`, `Podbicia main`) look unsold (no
  sale price) and **must** be excluded by the same keyword filter the sold importer uses.

## Architecture

Mirrors the sold-import feature: a pure parse/transform/match engine, a thin DB write
helper, one UI modal. Reuses the existing generic primitives (`parseCsv`,
`parsePlNumber`, `parsePlDate`, `FileDrop`).

```
finessin.csv ─▶ parseCsv (csv.ts) ─▶ parseStockCsv / classify (stockImport.ts)
                                              │  unsold | sold(ignored) | excluded | skipped
                                              ▼
                                   StockDraft[] (unsold only)
                                              │
                       matchAccounts(drafts, existingSales)  (stockImport.ts, pure)
                                              │  → { assigned[], review[] }
                                              ▼
              (user resolves review rows / toggles in ImportStockModal)
                                              │
                              importStock(resolvedDrafts)  (db.ts)
                                              │  multiset dedup, rw transaction
                                              ▼
                                       Dexie `products` table
```

### Units

**`src/lib/csv.ts`** — unchanged. Reuse existing `parseCsv(text): string[][]`.

**`src/lib/salesImport.ts`** — reuse exported `parsePlNumber`, `parsePlDate`, and the
boost/fee keyword test. If the boost regex is currently inlined, export it (e.g.
`isBoostRow(name)` or `BOOST_RE`) so `stockImport.ts` shares one source of truth. No
behavioural change to the sold importer.

**`src/lib/stockImport.ts`** — **NEW**, pure (no React/Dexie):
- Types: `StockBucket = 'stock' | 'sold' | 'excluded'`; `ParsedStockRow`;
  `StockDraft` (name, purchaseCost?, sourceLabel); `KeyedStockDraft`;
  `ResolvedStockDraft = StockDraft & { accountId?: ID }` (what the modal hands to
  `importStock` after auto-match + manual review);
  `AccountMatch = { draft: StockDraft, accountId?: ID, candidates: string[], confidence: 'single' | 'ambiguous' | 'none' }`.
- `parseStockCsv(text): ParsedStockRow[]` — tokenize via `parseCsv`, detect columns by
  fuzzy header match (`nazwa`, `cena zakupu`/`zaukupu`, `cena sprzedaży`) with positional
  fallback, classify each row into a bucket. Never throws.
- `normalizeForMatch(name): string` — lowercase, trim, collapse internal whitespace,
  strip trailing SKU-like token(s). SKU token = a trailing word of length ≥ 5 mixing
  letters and digits, or a long digit run (e.g. `AX10247937`, `MD175497`, `CC1731433`,
  `sj2306109140799009`). Size tokens (`XXXL`, `XXL`, `M`, `L`, `S`) are pure-letter and
  **kept**.
- `buildAccountIndex(sales): Map<string, Set<accountId>>` — normalized sale name →
  accounts that have sold it. Sales with no `accountId` contribute nothing.
- `matchAccounts(stockDrafts, sales): AccountMatch[]` — per draft: candidates =
  `index.get(normalizeForMatch(name))`. Exactly one → `confidence:'single'`, `accountId`
  set. Two+ → `'ambiguous'`. Zero → `'none'`. Ambiguous/none have `accountId` undefined
  until the user assigns.
- `stockImportKey(name, purchaseCost): string` — content key, `[normalizeForMatch(name),
  purchaseCost ?? ''].join('|')`. **Account is intentionally NOT in the key** (the source
  has no account; this keeps re-import stable across manual reassignments).
- `dedupKeyedStock(existingCounts, keyed): { toInsert, skipped }` — multiset diff, same
  shape as the sold importer's `dedupKeyed`.

**`src/db/types.ts`** — add `importKey?: string` to `Product` (additive, un-indexed).

**`src/db/db.ts`** — add `importStock(drafts: ResolvedStockDraft[]): Promise<{ inserted, skippedDuplicates }>`:
- Compute `importKey` per draft; read existing `products` into memory; build count map
  keyed by `importKey` from existing products that carry one (hand-added items have no
  `importKey`, so they don't suppress imports — same rule as the sold importer); call
  `dedupKeyedStock` to insert only the surplus.
- Map each inserted draft → `Product`: `id: uid()`, `name` verbatim, `purchasePrice`,
  `condition: 'dobry'`, `currency: 'PLN'`, `quantity: 1`, `status: 'in_stock'`,
  `accountId` (resolved, may be undefined), `photoIds: []`, `generatedPhotoIds: []`,
  `descriptions: []`, `tags: []`, `importKey`, `createdAt`/`updatedAt: Date.now()`.
- Single `db.transaction('rw', db.products, …)`. Returns `{ inserted, skippedDuplicates }`.

**`src/components/ImportStockModal.tsx`** — **NEW**:
- `FileDrop` (single CSV, csv filter) — same generalized component the sold importer uses.
- Loads accounts and `db.sales` via `useLiveQuery`; runs `parseStockCsv` + `matchAccounts`
  on the uploaded file.
- **Bucketed preview** (collapsible, with counts):
  - ✅ *Dopasowane automatycznie* — auto-assigned stock, grouped by account (colour dots).
  - ⚠️ *Do przypisania* — review rows; each has an account `<select>` (candidate accounts
    listed first / highlighted, plus "— brak —"). A row becomes includable once assigned;
    "none"-confidence rows may also be imported unassigned if the user chooses.
  - 🔁 *Już w magazynie / duplikaty* — dedup count (display-only; `importStock` is the
    single dedup authority).
  - 🚫 *Pominięte — nie magazyn* — boost/fee rows; toggle to include (off by default).
  - (Sold rows are silently ignored — surfaced only as a small "pominięto N sprzedanych".)
- **Summary line** + **Importuj do magazynu** button → `importStock(resolved)` →
  toast `Dodano N do magazynu, pominięto M`. Errors are caught → toast, no state change.
  Resets rows on close/cancel.

**`src/pages/Inventory.tsx`** — add an **"Importuj stan"** button (with `Upload` icon)
next to "Dodaj produkt", opening `ImportStockModal`. The page's existing
`useLiveQuery(db.products…)` makes new stock appear automatically.

## Field mapping → `Product`

| `Product` field | Source / value |
|-----------------|----------------|
| `id` | `uid()` |
| `name` | name verbatim (SKU kept) |
| `purchasePrice` | `Cena zakupu` (optional) |
| `condition` | `'dobry'` (default) |
| `currency` | `'PLN'` |
| `quantity` | `1` (one product per row) |
| `status` | `'in_stock'` |
| `accountId` | auto-matched / review-assigned (may be `undefined`) |
| `photoIds` / `generatedPhotoIds` / `descriptions` / `tags` | empty |
| `importKey` | `stockImportKey(name, purchaseCost)` |
| `createdAt` / `updatedAt` | `Date.now()` at import |

`sku`, `brand`, `listingPrice`, `measurements`, etc. are left empty — not present in the
sheet.

## Error handling

- Non-CSV / unreadable file → toast error, no state change.
- Unrecognizable headers → positional fallback; if even that yields zero usable rows, an
  explanatory empty state in the preview.
- Parse never throws to the UI: malformed rows degrade into `skipped`/`excluded` with an
  `issues` explanation.
- No accounts and/or no imported sales yet → every stock row lands in the review bucket
  (nothing to match against); modal nudges the user to import the sold sheets first.
- Import runs in a transaction; failure rolls back and toasts.

## Testing

Unit tests for `src/lib/stockImport.ts` using **real `finessin` rows** as fixtures:
- unsold detection (no sale price → stock; sale price present → sold/ignored)
- boost/fee exclusion (`Podbicia`, `Ekspozycja`, `podbica`, `Podbicia main`)
- `normalizeForMatch`: SKU strip (`Bluza zebra AX10247937` → `bluza zebra`) while keeping
  size tokens (`Czarne spodnie narsiarskie XXXL` keeps `xxxl`)
- `matchAccounts`: single-account name → assigned; two-account name → ambiguous; unknown
  name → none
- `stockImportKey` stability; multiset dedup (5 identical `Koszulka Messi` incoming + 0
  existing → 5 inserted; re-run → 0 inserted)

Plus a `fake-indexeddb` e2e for `importStock`:
- idempotent re-import (insert N → re-insert 0)
- a review-assigned `accountId` is persisted on the created `Product`
- multiset surplus (existing 2 + 5 incoming for one key → insert only 3)

## Out of scope (explicit)

- Importing `finessin`'s **sold** rows as Sales (Main/Zoos own those).
- Splitting the SKU code into `Product.sku` (kept inside `name` for now).
- Collapsing identical unsold rows into one product with `quantity = N`.
- Listing price / condition inference (defaults only).
- Live Google OAuth / Sheets API pull; writing back to Google Sheets.
