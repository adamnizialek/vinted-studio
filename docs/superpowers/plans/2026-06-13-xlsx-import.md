# XLSX Import Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or
> superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let both importers (magazyn + sprzedaż) read XLSX workbooks directly, with a tab picker
for multi-sheet files, while leaving the CSV path unchanged.

**Architecture:** A new pure module `src/lib/spreadsheet.ts` turns a `File` (CSV or XLSX) into a
`Workbook` exposing `sheetNames` + `tableOf(name) → string[][]`. XLSX is read with lazy-loaded
SheetJS; dates and numbers are coerced to strings under our control. The two parsers gain
table-accepting entry points (`parseStockTable`, `parseSalesTable`) that the CSV wrappers and the
modals both call.

**Tech Stack:** Vite 5, React 18, TypeScript, SheetJS (`xlsx`, patched CDN build, lazy), date-fns,
Dexie, vitest.

---

### Task 1: Install SheetJS (patched CDN build)

**Files:** `package.json`, `package-lock.json`

- [ ] **Step 1:** `npm install --save-exact https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`
- [ ] **Step 2:** Confirm `package.json` lists `"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"` and lockfile updated.
- [ ] **Step 3:** Commit `chore: add SheetJS (patched build) for XLSX import`.

---

### Task 2: `spreadsheet.ts` — File → Workbook

**Files:** Create `src/lib/spreadsheet.ts`, Test `src/lib/spreadsheet.test.ts`

- [ ] **Step 1: Failing test** (`src/lib/spreadsheet.test.ts`)

```ts
import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { readWorkbook, isSpreadsheet, cellToString } from '@/lib/spreadsheet'

function xlsxFile(sheets: Record<string, unknown[][]>, name = 'wb.xlsx'): File {
  const wb = XLSX.utils.book_new()
  for (const [sheet, aoa] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheet)
  }
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return new File([buf], name, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

describe('isSpreadsheet', () => {
  it('accepts csv and xlsx, rejects images', () => {
    expect(isSpreadsheet(new File([''], 'a.csv'))).toBe(true)
    expect(isSpreadsheet(new File([''], 'a.xlsx'))).toBe(true)
    expect(isSpreadsheet(new File([''], 'a.png', { type: 'image/png' }))).toBe(false)
  })
})

describe('cellToString', () => {
  it('formats dates as dd.MM.yyyy, numbers with dot, passes strings', () => {
    expect(cellToString(new Date(2024, 2, 15))).toBe('15.03.2024')
    expect(cellToString(22.4)).toBe('22.4')
    expect(cellToString('Koszulka')).toBe('Koszulka')
    expect(cellToString(null)).toBe('')
  })
})

describe('readWorkbook', () => {
  it('reads a CSV file as a single sheet named after the file', async () => {
    const f = new File(['Nazwa,Cena\nFoo,"22,4"\n'], 'items.csv', { type: 'text/csv' })
    const wb = await readWorkbook(f)
    expect(wb.sheetNames).toEqual(['items.csv'])
    expect(wb.tableOf('items.csv')).toEqual([['Nazwa', 'Cena'], ['Foo', '22,4']])
  })

  it('reads XLSX sheets, coercing numbers to dot-strings', async () => {
    const f = xlsxFile({
      finessin: [['Nazwa', 'Cena zakupu', 'Cena sprzedazy'], ['Foo', 22.4, '']],
      Main: [['Data', 'Nazwa'], ['x', 'y']],
    })
    const wb = await readWorkbook(f)
    expect(wb.sheetNames).toEqual(['finessin', 'Main'])
    expect(wb.tableOf('finessin')[1][1]).toBe('22.4')
    expect(wb.tableOf('Main')[0]).toEqual(['Data', 'Nazwa'])
    expect(wb.tableOf('missing')).toEqual([])
  })
})
```

- [ ] **Step 2:** Run `npx vitest run src/lib/spreadsheet.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** (`src/lib/spreadsheet.ts`)

```ts
// Wczytywanie arkuszy z pliku (CSV lub XLSX) do tabeli string[][] — bez React i bez Dexie.
// XLSX czytamy LENIWIE (dynamiczny import SheetJS), więc biblioteka trafia do osobnego chunku
// ładowanego dopiero przy realnym imporcie — bundle startowy pozostaje nietknięty.
import { format } from 'date-fns'
import { parseCsv } from '@/lib/csv'

const XLSX_RE = /\.xlsx?$/i
const CSV_RE = /\.csv$/i

/** Czy plik wygląda na arkusz, który umiemy wczytać (CSV/XLSX/XLS) — po rozszerzeniu lub MIME. */
export function isSpreadsheet(file: File): boolean {
  return (
    XLSX_RE.test(file.name) ||
    CSV_RE.test(file.name) ||
    file.type.includes('csv') ||
    file.type === 'text/plain' ||
    file.type.includes('spreadsheetml') || // .xlsx
    file.type.includes('ms-excel') // .xls
  )
}

function looksXlsx(file: File): boolean {
  return (
    XLSX_RE.test(file.name) ||
    file.type.includes('spreadsheetml') ||
    file.type.includes('ms-excel')
  )
}

/** Konwertuje komórkę SheetJS na tekst — daty i liczby pod naszą kontrolą (nie wg locale Excela). */
export function cellToString(v: unknown): string {
  if (v == null) return ''
  if (v instanceof Date) return format(v, 'dd.MM.yyyy')
  return String(v)
}

export interface Workbook {
  /** Nazwy arkuszy. CSV → pojedynczy wpis (nazwa pliku). */
  sheetNames: string[]
  /** Wiersze danego arkusza jako tabela komórek tekstowych. Nieznana nazwa → []. */
  tableOf(sheetName: string): string[][]
}

/** Wczytuje plik (CSV lub XLSX) i udostępnia jego arkusze jako tabele string[][]. */
export async function readWorkbook(file: File): Promise<Workbook> {
  if (looksXlsx(file)) {
    const XLSX = await import('xlsx')
    const data = new Uint8Array(await file.arrayBuffer())
    const wb = XLSX.read(data, { type: 'array', cellDates: true })
    return {
      sheetNames: [...wb.SheetNames],
      tableOf(sheetName) {
        const ws = wb.Sheets[sheetName]
        if (!ws) return []
        const aoa = XLSX.utils.sheet_to_json(ws, {
          header: 1,
          raw: true,
          blankrows: false,
          defval: '',
        }) as unknown[][]
        return aoa.map((row) => row.map(cellToString))
      },
    }
  }
  const text = await file.text()
  const table = parseCsv(text)
  return { sheetNames: [file.name], tableOf: () => table }
}
```

- [ ] **Step 4:** Run the test → PASS.
- [ ] **Step 5:** Commit `feat: spreadsheet reader (CSV + lazy XLSX) → Workbook`.

---

### Task 3: Table entry points for both parsers

**Files:** Modify `src/lib/stockImport.ts`, `src/lib/salesImport.ts`; extend their `.test.ts`.

- [ ] **Step 1: Failing tests** — add to `src/lib/stockImport.test.ts`:

```ts
it('parseStockTable classifies a table directly', () => {
  const rows = parseStockTable([
    ['Data', 'Miesiac', 'Nazwa', 'Cena zakupu', 'Cena sprzedazy'],
    ['', '', 'Koszulka AX10247937', '20', ''],
  ])
  expect(rows).toHaveLength(1)
  expect(rows[0].bucket).toBe('stock')
  expect(rows[0].purchaseCost).toBe(20)
})
```

and to `src/lib/salesImport.test.ts`:

```ts
it('parseSalesTable classifies a table directly', () => {
  const { rows } = parseSalesTable([
    ['Data', 'Nazwa', 'Cena zakupu', 'Cena sprzedazy'],
    ['15.03.2024', 'Foo', '10', '40'],
  ])
  expect(rows).toHaveLength(1)
  expect(rows[0].bucket).toBe('ready')
})
```

(Add `parseStockTable` / `parseSalesTable` to the respective imports in each test file.)

- [ ] **Step 2:** Run both test files → FAIL (not exported).

- [ ] **Step 3: Implement** — in `stockImport.ts`, replace the body of `parseStockCsv`:

```ts
/** Klasyfikuje gotową tabelę (string[][]) ze źródła `finessin`. */
export function parseStockTable(table: string[][]): ParsedStockRow[] {
  if (table.length === 0) return []
  const detected = detectStockColumns(table[0])
  // Fallback pozycyjny dla `finessin`: A=Data, B=Miesiąc, C=Nazwa, D=Cena zakupu, E=Cena sprzedaży.
  const col: StockColumnMap = detected ?? { name: 2, purchase: 3, sale: 4 }
  const rows: ParsedStockRow[] = []
  for (let i = 1; i < table.length; i++) {
    const r = classifyStockRow(table[i], col, i)
    if (r) rows.push(r)
  }
  return rows
}

/** Parsuje cały plik CSV `finessin`. Nigdy nie rzuca. */
export function parseStockCsv(text: string): ParsedStockRow[] {
  return parseStockTable(parseCsv(text))
}
```

In `salesImport.ts`, replace the body of `parseSalesCsv`:

```ts
/** Klasyfikuje gotową tabelę (string[][]) sprzedaży. */
export function parseSalesTable(table: string[][]): ParsedSheet {
  if (table.length === 0) return { rows: [], headerDetected: false }
  const detected = detectColumns(table[0])
  const col: ColumnMap = detected ?? { date: 0, name: 1, purchase: 2, sale: 3 }
  const rows: ParsedRow[] = []
  for (let i = 1; i < table.length; i++) {
    const r = classifyRow(table[i], col, i)
    if (r) rows.push(r)
  }
  return { rows, headerDetected: detected !== null }
}

/** Parsuje cały plik CSV sprzedaży. */
export function parseSalesCsv(text: string): ParsedSheet {
  return parseSalesTable(parseCsv(text))
}
```

(`parseCsv` import stays — used by the wrappers.)

- [ ] **Step 4:** Run both test files → PASS (new + existing).
- [ ] **Step 5:** Commit `refactor: table entry points for stock/sales parsers`.

---

### Task 4: Wire XLSX + sheet picker into ImportStockModal

**Files:** Modify `src/components/ImportStockModal.tsx`

- [ ] **Step 1:** Replace imports: drop the local `isCsv`; import
  `readWorkbook, isSpreadsheet, type Workbook` from `@/lib/spreadsheet`; swap `parseStockCsv` →
  `parseStockTable` from `@/lib/stockImport`.

- [ ] **Step 2:** Add state + helpers:

```ts
const [workbook, setWorkbook] = useState<{ wb: Workbook; names: string[]; sheet: string } | null>(null)

const STOCK_SHEET_RE = /finessin|all|wszystk|magazyn|stan/i
const pickStockSheet = (names: string[]) => names.find((n) => STOCK_SHEET_RE.test(n)) ?? names[0]

const processStock = (table: string[][], sheet: string) => {
  const salesForMatch = (sales ?? []).map((s) => ({ productName: s.productName, accountId: s.accountId }))
  const parsed = parseStockTable(table)
  const stock = parsed.filter((r) => r.bucket === 'stock')
  const matches = matchAccounts(stock, salesForMatch)
  const byRow = new Map(stock.map((r, i) => [r.rowIndex, matches[i]]))
  const next: EditRow[] = parsed.map((r) => {
    const m = byRow.get(r.rowIndex)
    const confidence = m?.confidence ?? 'none'
    return {
      key: `${sheet}#${r.rowIndex}`, rowIndex: r.rowIndex, bucket: r.bucket, name: r.name,
      purchaseCost: r.purchaseCost, salePrice: r.salePrice, issues: r.issues,
      accountId: m?.accountId, candidates: m?.candidates ?? [], confidence,
      include: r.bucket === 'stock' && confidence === 'single',
    }
  })
  if (!next.some((r) => r.bucket === 'stock')) {
    toast.error('Nie znaleziono przedmiotów w magazynie w tym arkuszu.')
    setRows([])
    return
  }
  setRows(next)
}

const onFiles = async (files: File[]) => {
  try {
    const wb = await readWorkbook(files[0])
    const sheet = pickStockSheet(wb.sheetNames)
    setWorkbook({ wb, names: wb.sheetNames, sheet })
    processStock(wb.tableOf(sheet), sheet)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'Nie udało się odczytać pliku.')
  }
}

const onSheet = (sheet: string) => {
  if (!workbook) return
  setWorkbook({ ...workbook, sheet })
  processStock(workbook.wb.tableOf(sheet), sheet)
}
```

- [ ] **Step 3:** `close()` also clears the workbook: add `setWorkbook(null)`.

- [ ] **Step 4:** `FileDrop` → `accept=".csv,.xlsx,.xls,text/csv"`, `filter={isSpreadsheet}`; update the
  hint text to "plik CSV lub XLSX (finessin)". Render the sheet picker when multi-sheet, just under
  `FileDrop`:

```tsx
{workbook && workbook.names.length > 1 && (
  <Field label="Arkusz do zaimportowania">
    <Select value={workbook.sheet} onChange={(e) => onSheet(e.target.value)}>
      {workbook.names.map((n) => (
        <option key={n} value={n}>{n}</option>
      ))}
    </Select>
  </Field>
)}
```

(Import `Field` from `@/components/ui`.)

- [ ] **Step 5:** `npm run typecheck` → clean. Commit `feat: XLSX + sheet picker in stock import`.

---

### Task 5: Wire XLSX + sheet picker into ImportSalesModal

**Files:** Modify `src/components/ImportSalesModal.tsx`

- [ ] **Step 1:** Drop local `isCsv`; import `readWorkbook, isSpreadsheet, type Workbook`; swap
  `parseSalesCsv` → `parseSalesTable`.

- [ ] **Step 2:** Add state + helpers:

```ts
const [workbook, setWorkbook] = useState<{ wb: Workbook; names: string[]; sheet: string } | null>(null)

const processSales = (table: string[][], sheet: string) => {
  const { rows: parsed } = parseSalesTable(table)
  const next: EditRow[] = parsed.map((r) => ({
    ...r, key: `${sheet}#${r.rowIndex}`, include: r.bucket === 'ready',
  }))
  if (!next.length) {
    toast.error('Nie znaleziono wierszy w tym arkuszu.')
    setRows([])
    return
  }
  setRows(next)
}

const onFiles = async (files: File[]) => {
  try {
    const wb = await readWorkbook(files[0])
    const sheet = wb.sheetNames[0]
    setWorkbook({ wb, names: wb.sheetNames, sheet })
    processSales(wb.tableOf(sheet), sheet)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'Nie udało się odczytać pliku.')
  }
}

const onSheet = (sheet: string) => {
  if (!workbook) return
  setWorkbook({ ...workbook, sheet })
  processSales(workbook.wb.tableOf(sheet), sheet)
}
```

- [ ] **Step 3:** `reset()` also clears the workbook: add `setWorkbook(null)`.

- [ ] **Step 4:** `FileDrop` → `accept=".csv,.xlsx,.xls,text/csv"`, `filter={isSpreadsheet}`; update hint
  to "plik CSV lub XLSX". Render the same sheet picker (multi-sheet only) under `FileDrop`
  (`Field` is already imported here).

- [ ] **Step 5:** `npm run typecheck` → clean. Commit `feat: XLSX + sheet picker in sales import`.

---

### Task 6: Full verification

- [ ] **Step 1:** `npm test` → all green.
- [ ] **Step 2:** `npm run typecheck` → clean.
- [ ] **Step 3:** `npm run build` → succeeds; confirm `xlsx` lands in a **separate** lazy chunk
  (not the entry chunk).
- [ ] **Step 4:** Commit any final touch-ups.
