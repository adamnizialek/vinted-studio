# XLSX Import Support — Design

**Date:** 2026-06-13
**Status:** Approved

## Problem

Both importers (stock → magazyn, sales → sprzedaż) read **CSV**. A Google Sheet downloaded
from Google Drive arrives as a single **XLSX workbook containing all tabs** (e.g. `finessin`
plus the per-account sold sheets). The user cannot feed that file to the app without first
re-exporting each tab as CSV by hand. We add native XLSX reading so a Drive workbook can be
dropped straight in, with a tab picker for multi-sheet files.

## Decisions

- **Source library:** SheetJS, installed from the vendor's **patched CDN tarball** (`xlsx@0.20.x`)
  rather than the npm-registry `0.18.5`, which carries two known CVEs (prototype pollution
  CVE-2023-30533, ReDoS CVE-2024-22363). Lazy-loaded via dynamic `import('xlsx')`, so it lands in
  a separate Vite chunk fetched only when a spreadsheet is actually read — main bundle and app
  startup are unaffected.
- **Scope:** both importers (stock + sales). No DB or schema changes.
- **No regression to the CSV path:** existing CSV files and single-sheet files behave exactly as
  before (no sheet picker shown).

## Architecture

### New module `src/lib/spreadsheet.ts` (pure; no React, no Dexie)

```ts
isSpreadsheet(file: File): boolean        // .csv | .xlsx | .xls, by extension or MIME
readWorkbook(file: File): Promise<Workbook>

interface Workbook {
  sheetNames: string[]                    // CSV → [file.name] (one implicit sheet)
  tableOf(sheetName: string): string[][]  // rows as string cells
}
```

- **CSV path:** `parseCsv(await file.text())` — unchanged tokenizer, unchanged behavior.
- **XLSX path:** `const XLSX = await import('xlsx')`; `XLSX.read(buf, { type: 'array', cellDates: true })`.
  Each cell is coerced to a string under our control, **not** Excel's locale formatting:
  - `Date` → `format(d, 'dd.MM.yyyy')` (date-fns, already a dependency) → matches `parsePlDate`.
  - `number` → `String(n)` (e.g. `22.4` → `"22.4"`) → already accepted by `parsePlNumber`.
  - everything else → the string (empty string for null/blank).

### Cell-format compatibility (why this is safe)

- **Numbers:** `parsePlNumber` already matches dot-decimals (`"22.4"` → 22.4) and comma-decimals
  (`"22,4"` → 22.4). XLSX real numbers stringify with a dot, which parses correctly. No change.
- **Dates:** `parsePlDate` is strict `DD.MM.YYYY`. XLSX stores real dates as serial numbers, so we
  coerce date cells to that exact string during extraction. (Only the sales importer parses dates;
  the stock importer ignores them.)

### Parser refactor (small, non-breaking)

Split a table entry point out of each text entry point:

- `parseStockTable(table: string[][]): ParsedStockRow[]` — `parseStockCsv(text)` becomes
  `parseStockTable(parseCsv(text))`.
- `parseSalesTable(table: string[][]): ParsedSheet` — `parseSalesCsv(text)` becomes
  `parseSalesTable(parseCsv(text))`.

The existing `parseStockCsv` / `parseSalesCsv` keep their signatures and behavior, so existing
tests pass untouched. The modals switch to the table entry points (fed from `readWorkbook`).

### Modal changes (stock + sales)

`onFiles` becomes:

1. `const wb = await readWorkbook(file)`.
2. If `wb.sheetNames.length <= 1` → parse `wb.tableOf(sheetNames[0])` immediately (current flow,
   no picker).
3. If multiple → stash the workbook + names in state and render a sheet `<Select>`. Parse the
   selected sheet's table on selection.

Default sheet selection:

- **Stock importer:** pre-pick the first sheet whose name matches `/finessin|all|wszystk|magazyn|stan/i`;
  fall back to the first sheet.
- **Sales importer:** default to the first sheet.

The user can always change the selection. `FileDrop` `accept` / `filter` widen to include
`.xlsx` / `.xls` via the shared `isSpreadsheet` predicate.

## Testing

- `parseStockTable` / `parseSalesTable`: table-in fixtures mirroring the existing CSV tests.
- `readWorkbook`:
  - CSV file → single sheet named after the file, correct table.
  - XLSX generated in-test (`XLSX.utils.aoa_to_sheet` + `book_new` + `write({type:'array'})` →
    `File`): asserts `number → "22.4"`, `Date → "15.03.2024"`, and a multi-sheet `sheetNames` /
    `tableOf` round-trip.
- Full existing suite stays green (CSV wrappers unchanged).

## Out of scope

- Writing/exporting XLSX (export stays CSV).
- Auto-detecting which account a sales tab belongs to (user still picks the account, as today).
