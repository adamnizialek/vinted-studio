# Import sprzedaży z Google Sheets (CSV) — Design

**Date:** 2026-06-13
**Status:** Approved (brainstorm) — pending spec review
**Author:** Adam + Claude

## Problem

Adam keeps historical sales records in several Google Sheets, maintained by hand:

- **Main** — main account, sold items only.
- **Zoos** — Zosia's account, sold items only.
- **finessin** — all products for both accounts including unsold (this is really *inventory*, not sales — out of scope).
- (**HAU** — an older Zosia sheet, same shape as Zoos; treated like any other CSV if imported.)

He wants those sales inside Vinted Studio so the app's dashboards and profit math cover the real history. After discussion, the chosen model is: **import the sheets' history into the app (one-time and occasionally re-pulled); from then on the app is the single clean source of truth.** New sales are recorded in the app, not the sheets.

## Decisions locked during brainstorming

1. **Source format:** Google Sheets (structured tables).
2. **Direction / source of truth:** one-way **Sheets → app**, re-runnable. The app owns the data afterwards. No write-back into the legacy sheets.
   - *Rationale for rejecting two-way sync into the legacy sheets:* no per-row IDs, item names repeat heavily (`Podbicia`, `Czarne spodnie narsiarskie XXXL`, …), aggregate/formula cells live in the same grid, expense rows are mixed with sales, and the app has no backend (a static PWA gets only a 1-hour Google token, no background refresh). Automated write-back would be unreliable and could corrupt the user's totals.
3. **Mechanism:** **CSV upload.** User does `File → Download → .csv` in Google Sheets and drops the file into the app. No Google OAuth, no Google Cloud project, no infra — preserves the app's "100% local, nothing leaves your browser" property. (Live Google OAuth pull is an explicit Phase-2 upgrade on the same engine; out of scope here.)
4. **Boost/expense rows** (`Podbicia`, `Ekspozycja`, `podbica`, `Podbicia main`): **excluded from the sales import by default**, shown in a separate "Excluded" bucket with a toggle to include. They are Vinted boost/spotlight fees, not sales. Trade-off accepted: in-app profit will read slightly higher than the sheet's net (boost costs not captured). Account-level expense tracking is a possible separate future feature.
5. **Returns** (cells containing `(zwrot)`): imported with status **`returned`** (the app already excludes returned/cancelled from revenue via `countsAsRevenue`).

## Real data shape (verified from the actual sheets)

Google Sheets CSV export **quotes** any cell containing a comma, so column boundaries are recoverable even though Polish uses the comma as the decimal separator.

**Main** columns (Zoos is the same shape with differently-named aggregate columns):

| Col | Header | Meaning | Per-row? |
|-----|--------|---------|----------|
| A | `Data sprzedaży` | Sale date `DD.MM.YYYY` | yes (sometimes blank) |
| B | `Nazwa` | Item name | yes |
| C | `Cena zaukupu` (sic) | Purchase cost — `"22,4"` = 22.40 | yes (sometimes blank) |
| D | `Cena Sprzedaży` | Sale price — `"350,56"` = 350.56 | yes |
| E | `Kolumna nr 1` | junk — `Q1`/`Q2` quarter tags, mostly empty | no |
| F–I | `Przychód` / `Dochód` / `Wydatki` (Zoos: `Przychody` / `Dochody` / `Koszty`) | **aggregate totals**, only filled on the first data row | no |

Genuinely useful per-row data: **date, name, purchase cost, sale price.** Everything else is ignored. Profit is derived by the app.

Known data-quality quirks the importer must tolerate:
- Blank separator rows (all cells empty) → skipped silently.
- Wrong/typo years (`01.02.2024`, `06.03.2023`, `25.01.22026`) → flagged for review, not auto-corrected.
- Missing dates or missing sale prices → "Needs review" bucket.
- Missing purchase price → imported anyway (`purchaseCost` is optional; profit = sale price).
- `0 (zwrot)` and similar return markers → status `returned`.
- Item names that embed SKU-like codes (`Szalik kości MD175497`) → kept verbatim as the product name.

## Architecture

A pure parsing/transform engine, a thin DB write helper, and one UI modal. Each unit is independently understandable and testable.

```
CSV file ──▶ parseCsv (csv.ts) ──▶ parseSalesCsv / classify (salesImport.ts)
                                          │
                                          ▼
                              ParsedRow[] grouped into buckets
                                          │
                       (user reviews/edits/toggles in ImportSalesModal)
                                          │
                                          ▼
                          importSales(rows, accountId)  (db.ts)
                                          │
                                          ▼
                                  Dexie `sales` table
```

### Units

**`src/lib/csv.ts` — add `parseCsv(text: string): string[][]`**
A correct CSV tokenizer (handles quoted fields, embedded commas, `""` escapes, CRLF, leading BOM). Lives next to the existing export helpers (`toCsv`, `downloadText`). Generic — no sales knowledge.

**`src/lib/salesImport.ts` — NEW, pure functions**
- `parseSalesCsv(text: string): ParsedSheet` — orchestrates: tokenizes via `parseCsv`, detects columns by fuzzy header match (`Data sprzedaży`, `Nazwa`, `Cena zakupu`/`zaukupu`, `Cena Sprzedaży`), falls back to positional A–D if headers are unrecognizable, ignores all other columns.
- Number parser: `parsePlNumber("350,56") -> 350.56`; tolerates plain integers and whitespace; non-numeric → `undefined`.
- Date parser: `parsePlDate("13.01.2026") -> timestamp` at local noon (consistent with `dateFromInput`); invalid → `null`; flags out-of-range years.
- Classifier: each row → `{ bucket, sale?: DraftSale, issues: string[] }` where `bucket ∈ 'ready' | 'review' | 'excluded'`. Boost/expense detection via keyword regex (`/podbic|ekspozycj/i`) + empty sale price. Return detection via `/\(zwrot\)/i`.
- Content key: `saleImportKey(accountId, dateTs, name, salePrice, purchaseCost) -> string` — stable, normalized (trim + lowercase name, day-granularity date).

No imports from React or Dexie. Fully unit-testable.

**`src/db/db.ts` — add `importSales(rows: DraftSale[], accountId: string): Promise<ImportResult>`**
- Computes `importKey` for each draft row.
- **Multiset dedup:** reads existing `sales` into memory, builds a count map keyed by `importKey`, counts incoming per key, inserts only `(incoming − existing)` for each key. Preserves genuine repeat sales; makes re-import idempotent. Dedup is done in memory (sales volume is in the hundreds), so **no Dexie index on `importKey` and no schema version bump are needed**.
- Single Dexie `rw` transaction; returns `{ inserted, skippedDuplicates }`.
- Add optional field `importKey?: string` to the `Sale` interface in `src/db/types.ts`. This is purely additive — Dexie tolerates new optional fields with no migration, and the field is left un-indexed.

**`src/components/FileDrop.tsx` — generalize**
Currently hard-codes `accept="image/*"` and filters to `image/*`. Add optional props: `accept?: string` (default `"image/*"`) and `filter?: (f: File) => boolean` (default image filter). Existing image call-sites keep working unchanged. The import modal passes `accept=".csv,text/csv"` and a csv filter.

**`src/components/ImportSalesModal.tsx` — NEW**
- File drop (one or more CSVs) using the generalized `FileDrop`.
- **Account selector**: existing accounts (with colour dots) + inline "Utwórz nowe konto". If no accounts exist, the modal nudges the user to create one (reuses Account model + `ACCOUNT_COLORS`).
- **Bucketed preview** (collapsible sections with counts):
  - ✅ *Gotowe do importu* (ready, minus already-imported)
  - 🔁 *Już zaimportowane / duplikaty* (skipped)
  - ⚠️ *Do sprawdzenia* (review) — inline-editable date/price; includable after fixing
  - 🚫 *Pominięte — nie sprzedaż* (excluded boosts/fees) — toggle to include
- Summary line + **Zaimportuj** button → calls `importSales`, toasts result (`Zaimportowano N, pominięto M`), closes.

**`src/pages/Sales.tsx` — wire-up**
Add an "Importuj" button in the header next to the existing CSV export, opening `ImportSalesModal`. The page's existing `useLiveQuery` on `db.sales` makes the new rows appear automatically.

## Field mapping → `Sale`

| `Sale` field | Source |
|--------------|--------|
| `id` | `uid()` |
| `soldAt` | parsed date |
| `productName` | name (verbatim) |
| `purchaseCost` | `Cena zakupu` (optional) |
| `salePrice` | `Cena sprzedaży` |
| `accountId` | selected account |
| `currency` | `PLN` |
| `quantity` | `1` |
| `status` | `completed` (or `returned` for `(zwrot)`) |
| `importKey` | content hash |
| `createdAt` | `Date.now()` at import |

`brand`, `buyer`, costs other than purchase, etc. are left empty — not present in the sheets.

## Error handling

- Non-CSV / unreadable file → toast error, no state change.
- Unrecognizable headers → positional fallback; if even that yields zero usable rows, show an explanatory empty state in the preview.
- Parse never throws to the UI: malformed rows degrade into the "review" bucket with an `issues` explanation.
- Import runs in a transaction; failure rolls back and toasts.

## Testing

Add **`vitest`** (no test runner currently in the repo) and a `test` script. Unit tests for `src/lib/salesImport.ts` and the new `parseCsv`, using **real rows sampled from Main/Zoos** as fixtures:
- comma-decimal parsing (`"22,4"`, `"350,56"`, `83`, `"364,5"`)
- quoted cells with embedded commas
- header typo (`Cena zaukupu`) and positional fallback
- aggregate columns ignored (first Main row keeps only date/name/purchase/sale)
- classification: boost/fee → excluded, `(zwrot)` → returned, missing date/price → review, blank → skipped
- `importKey` stability and multiset dedup (3 identical incoming + 1 existing → 2 inserted)

## Out of scope (explicit)

- Live Google OAuth / Sheets API pull (clean Phase-2 on this engine).
- Writing back to Google Sheets.
- Importing `finessin` (inventory, separate concern).
- Account-level / standalone expense tracking (would let boost costs be captured for true net profit).
- Paste-the-rows import (declined; could be added cheaply later on the same parser).
