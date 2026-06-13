# Per-account sales import + imported-data repair — Design

**Date:** 2026-06-13
**Status:** Approved (brainstorm) — pending spec review
**Author:** Adam + Claude

## Problem

All sold products ended up assigned to a single account (`zoos07`); the other
account (`pangea`, whose note is "main") shows 0 sales and 0 stock. The Accounts
page (`src/pages/Accounts.tsx`) sums sales and counts stock per `accountId`, so a
mis-assigned `accountId` is faithfully reflected as "everything on one account".

### Root cause (confirmed, not a logic bug)

The sales import is **manual, one-source-one-account by design** (see the original
spec `2026-06-13-sales-import-google-sheets-design.md`). `importSales(drafts, accountId)`
in `src/db/db.ts` writes **every** row of the chosen sheet to the **single** account
picked in the dropdown. `accountId` flows correctly from selection to storage — there
is no misrouting bug.

The mis-assignment came from feeding the wrong file into the sales importer. Adam keeps
**three** XLSX files:

1. Account 1's sales only.
2. Account 2's sales only.
3. **All items across both accounts, including unsold** — the `finessin` / "all items"
   file (its distinguishing column is **`Miesiąc`**). This is the **stock** source.

File 3's sold rows parse cleanly as sales (date / name / `Cena zakupu` / `Cena sprzedaży`
are all present), so importing File 3 into the **sales** importer with one account selected
dumps **both** accounts' sold rows onto that one account. The unsold rows then auto-matched
to that same account in the stock importer (`matchAccounts` keys off existing sales), so the
stock count is a **downstream cascade** of the bad sales — not a second bug.

Contributing UX traps in `ImportSalesModal`:
- The sheet selector and account selector are independent; switching sheets never changes the account.
- The chosen account **persists** across imports (`close()` keeps it for "the next import").
- A multi-sheet workbook imports **one** sheet per click; there is no "map each sheet to its
  account and import all" path, and no guard against importing the all-items file as sales.

## Decisions locked during brainstorming

1. **Repair path:** corrected re-import. Wipe the imported data, then re-import each source to
   the right place.
2. **Clear mechanism:** a single **"Clear all imported data"** action that removes everything
   carrying an `importKey` (CSV/XLSX-imported sales, promotion costs, stock items), preserving
   manually-entered rows, accounts, settings, and any product the user has added photos to.
3. **Prevention:** redesign the sales importer to **bind each source (file/sheet) to an
   account** (auto-suggested by name), import **all sources in one pass**, and **detect and
   block** the all-items file from being imported as sales.
4. **Import-modal density:** show the **full** ready/review/excluded buckets per source
   (preserve today's inline date/price fixing), grouped by file.
5. **No schema change.** Everything is additive or filtered; no Dexie version bump.
6. **Stock importer logic is unchanged.** Once sales are correct, `matchAccounts` splits stock
   correctly on the next import of File 3.

## Real data shape (verified)

- Sales files (Main / Zoos): headers `Data sprzedaży, Nazwa, Cena zaukupu, Cena Sprzedaży`
  (+ aggregate columns). No `Miesiąc` column.
- All-items file (`finessin`): headers `Data sprzedaży, Miesiąc, Nazwa przedmiotu, Cena zakupu,
  Cena sprzedaży, Zysk, …`. The **`Miesiąc`** column is the reliable discriminator; unsold rows
  have an empty sale price.

## Architecture

Three small, independently testable units plus a modal rewrite that composes them. The DB write
helpers (`importSales`, `importExpenses`, `importStock`) and the stock importer are reused
unchanged.

```
Files ─▶ readWorkbook (spreadsheet.ts) ─▶ per (file,sheet) "source"
            │
            ├─ looksLikeStockSheet(header)      → guardrail banner, excluded from sales
            ├─ suggestAccountForSheet(name, …)  → default account per source
            └─ parseSalesTable(table)           → ready/review/excluded buckets
                                                      │
                          (user maps account + reviews per source)
                                                      │
                                                      ▼
                       for each source: importSales(drafts, accountId)
                                        importExpenses(expenseDrafts, accountId)
```

### Unit A — `clearImportedData()` (`src/db/db.ts`)

A new function mirroring `clearAllData`, but filtered:

- `sales`: delete every row where `importKey` is set.
- `expenses`: delete every row where `importKey` is set.
- `products`: delete every row where `importKey` is set **and** `photoIds.length === 0`
  **and** `generatedPhotoIds.length === 0` (an imported item later given photos in Studio
  survives).
- Each delete queues a tombstone (`db.outbox.put({ table, id, deleted: 1, updatedAt: now })`)
  inside the same `rw` transaction, so the deletions propagate to D1 and other devices.
- Returns `{ sales: number; expenses: number; products: number }`.

`importKey` is set **only** by the import helpers (`importSales` / `importExpenses` /
`importStock`); user-created rows never have one — so the filter is exact.

### Unit B — pure helpers (`src/lib/salesImport.ts`)

```ts
/** Unikalne dopasowanie nazwy pliku/arkusza do konta (po name/notes/vintedUsername). */
export function suggestAccountForSheet(
  sheetName: string,
  accounts: { id: string; name: string; notes?: string; vintedUsername?: string }[],
): string | undefined
```
- Matching rule (case-insensitive, diacritics-folded): split the file/sheet name into words,
  keep words of **≥ 3 chars**, and drop the `.xlsx/.csv` extension. A source matches an account
  when one of those words is a substring of — or contains — any of the account's `name`,
  `notes`, or `vintedUsername` fields. Examples: word "main" ↔ pangea's note "main" (equal);
  word "zoos" ↔ account name "zoos07" (substring). The ≥3-char floor avoids spurious matches on
  tiny tokens. Returns the account id **only when exactly one** account matches; otherwise
  `undefined` (the dropdown stays empty for the user to choose). Best-effort — the dropdown is
  always the authority.

```ts
/** Czy nagłówek wygląda na plik „wszystkie przedmioty" (finessin) — kolumna „Miesiąc". */
export function looksLikeStockSheet(header: string[]): boolean
```
- `true` when any header cell normalizes to contain `miesiąc`. This is the guardrail that
  prevents re-importing the all-items file as sales.

Both are pure (no React/Dexie) and unit-tested.

### Unit C — redesigned `ImportSalesModal` (`src/components/ImportSalesModal.tsx`)

- `FileDrop` becomes `multiple`. On drop, for each file `readWorkbook(file)`; for each sheet
  build a **source**:
  `{ id: `${fileName}::${sheetName}`, fileName, sheetName, header, isStock, accountId, rows: EditRow[] }`
  where `rows = parseSalesTable(table).rows` mapped to `EditRow` (existing shape), `isStock =
  looksLikeStockSheet(header)`, and `accountId` defaulted from `suggestAccountForSheet`.
- Per source, render a section:
  - File/sheet title + an **account `Select`** (existing accounts + inline "Nowe konto",
    reusing today's create flow).
  - If `isStock`: an amber banner *"To wygląda na plik 'wszystkie przedmioty' (finessin) —
    zaimportuj go w Magazynie, nie tutaj."* The section's rows are not importable as sales.
  - The existing **ready / do sprawdzenia / już zaimportowane / koszty promocji** buckets,
    scoped to that source, reusing `RowLine` / `ReviewLine` and the per-source duplicate preview.
- Footer: total count across sources + one **"Zaimportuj N"** button.
- `doImport`: for each non-stock source that has an assigned account, call
  `importSales(sourceDrafts, accountId)` then `importExpenses(sourceExpenseDrafts, accountId)`;
  sum the results into one toast (`Zaimportowano: X sprzedaży, Y kosztów. Pominięto duplikaty: Z.`).
- Guards: block import (toast) if any source has includable rows but **no** account assigned;
  ignore stock-flagged sources.
- Duplicate-preview / dedup is computed per source against its assigned account; `importSales`
  remains the single dedup authority and the modal only previews counts (same contract as today,
  generalized from one account to one-per-source).

### Unit D — Settings button (`src/pages/Settings.tsx`)

In the existing "Kopia zapasowa danych" card, add a `Button variant="ghost"` **"Wyczyść
zaimportowane dane"** next to Export / Import / Wyczyść dane. It confirms with the counts and
preserves note, e.g.:

> *"Usunąć 28 sprzedaży, 5 kosztów i 13 przedmiotów pochodzących z importu? Ręczne wpisy oraz
> produkty ze zdjęciami zostaną zachowane. Tej operacji nie można cofnąć."*

The prompt's counts come from a quick pre-count (count rows with `importKey` before asking) so
the user sees numbers before deciding. On confirm: `await clearImportedData()`, then toast the
returned totals.

## Field mapping

No new fields. `clearImportedData` reads existing `importKey`, `photoIds`, `generatedPhotoIds`.
The modal continues to map rows to `DraftSale` / `DraftExpense` exactly as today.

## Error handling

- Unreadable file → toast, that file is skipped; other dropped files still load.
- A workbook with zero sales-shaped sources → explanatory empty state (existing behavior per file).
- `clearImportedData` runs in one transaction; failure rolls back and toasts.
- Each source imports in its own transaction (`importSales` then `importExpenses`). The sources
  run sequentially; if one throws, the loop stops and the error is toasted (never silent), while
  sources already imported stay committed. The combined success toast reports totals across the
  sources that completed.

## Testing

Pure-logic via **vitest** (matches the repo's existing test culture; modals are covered by build
+ manual smoke, not unit tests):

- `suggestAccountForSheet`: unique match by name; match via `notes` ("main" → pangea); ambiguous
  (two accounts share a token) → `undefined`; none → `undefined`.
- `looksLikeStockSheet`: `true` for the `finessin` header, `false` for the Main/Zoos header,
  diacritic-insensitive on "Miesiąc/miesiac".
- `clearImportedData` (fake-indexeddb): seed imported + manual `sales`, imported + manual
  `expenses`, and three products (imported-no-photo, imported-with-photo, Studio-no-importKey).
  Assert: imported sales/expenses and the imported-no-photo product are deleted; manual rows,
  the imported-with-photo product, and the Studio product survive; one outbox tombstone per
  deleted row.

Manual smoke test: drop File 1 + File 2 → two sections, accounts auto-suggested, import both;
drop File 3 → stock banner, not importable as sales; Settings → clear imported data restores a
clean slate.

## Out of scope (explicit)

- Changes to the **stock importer** logic (works once sales are correct).
- A "replace this account" toggle in the importer (the global clear covers the repair — YAGNI).
- Auto-importing the all-items file's stock from inside the sales modal (kept in Magazyn).
- Any Dexie schema/version change.
- Two-way Google Sheets sync (already out of scope in the original spec).
