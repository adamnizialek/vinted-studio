# Google Sheets Sales Import (CSV) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Adam import his Google Sheets sales history (Main, Zoos) into Vinted Studio via CSV upload, with parsing, cleanup/review, and idempotent re-import.

**Architecture:** A pure parsing/classification engine (`salesImport.ts`) on top of a generic CSV tokenizer (`parseCsv` in `csv.ts`), a thin Dexie write helper (`importSales` with in-memory multiset dedup), and one UI modal (`ImportSalesModal`) opened from the Sales page. No backend, no Google OAuth — the user downloads the sheet as `.csv` and drops it in.

**Tech Stack:** React 18 + TypeScript, Vite, Dexie (IndexedDB), Tailwind. Tests via **vitest** (added in Task 1).

**Spec:** `docs/superpowers/specs/2026-06-13-sales-import-google-sheets-design.md`

**Deviation from spec (noted):** The spec mentions auto-flagging "suspicious years" like 2024/2023. Those are plausible real past years and flagging them produces false positives, so `parsePlDate` only rejects *structurally invalid* dates (e.g. the 5-digit `25.01.22026`). Genuinely wrong dates are still fixable via the inline editor in the review bucket. Valid years are constrained to 2020–2030.

---

## File Structure

- `src/lib/csv.ts` — **modify**: add `parseCsv(text)` tokenizer next to existing export helpers.
- `src/lib/salesImport.ts` — **create**: pure parse → classify → key/dedup logic. No React/Dexie imports.
- `src/db/types.ts` — **modify**: add optional `importKey?: string` to `Sale`.
- `src/db/db.ts` — **modify**: add `importSales(drafts, accountId)`.
- `src/components/FileDrop.tsx` — **modify**: add `accept` + `filter` props (default to current image behavior).
- `src/components/ImportSalesModal.tsx` — **create**: the import UI.
- `src/pages/Sales.tsx` — **modify**: add "Import" button + render the modal.
- `vite.config.ts`, `package.json` — **modify**: add vitest.
- `src/lib/csv.test.ts`, `src/lib/salesImport.test.ts` — **create**: unit tests.

---

## Task 1: Add vitest test runner

**Files:**
- Modify: `package.json`
- Modify: `vite.config.ts`

- [ ] **Step 1: Install vitest**

Run: `npm install -D vitest@^2`
Expected: adds `vitest` to `devDependencies`, exits 0.

- [ ] **Step 2: Add the `test` script to `package.json`**

In the `"scripts"` block, add a `test` line so it reads:

```json
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "typecheck": "tsc -b --noEmit",
    "test": "vitest run"
  },
```

- [ ] **Step 3: Enable vitest in `vite.config.ts`**

Add a triple-slash reference on line 1 and a `test` block. Full file:

```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// PWA jest realizowane recznie (public/manifest.webmanifest + public/sw.js),
// bez dodatkowych wtyczek — mniej zaleznosci, mniej niespodzianek przy buildzie.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // Wzgledna sciezka bazowa => aplikacja dziala tez gdy jest serwowana z podkatalogu
  // (np. GitHub Pages / dowolny hosting statyczny).
  base: './',
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
```

- [ ] **Step 4: Verify the runner works (no tests yet)**

Run: `npx vitest run --passWithNoTests`
Expected: exits 0, prints "No test files found" (or runs 0 tests). The vitest config is valid.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vite.config.ts
git commit -m "build: add vitest test runner"
```

---

## Task 2: CSV tokenizer (`parseCsv`)

**Files:**
- Modify: `src/lib/csv.ts`
- Test: `src/lib/csv.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/csv.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseCsv } from '@/lib/csv'

describe('parseCsv', () => {
  it('parses simple rows', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ])
  })

  it('keeps quoted commas as one field (Polish decimals)', () => {
    expect(parseCsv('x,"22,4",55')).toEqual([['x', '22,4', '55']])
  })

  it('unescapes doubled quotes', () => {
    expect(parseCsv('"he said ""hi""",b')).toEqual([['he said "hi"', 'b']])
  })

  it('handles CRLF and a trailing newline without an empty row', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('strips a leading BOM', () => {
    expect(parseCsv('﻿a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/csv.test.ts`
Expected: FAIL — `parseCsv` is not exported from `@/lib/csv`.

- [ ] **Step 3: Implement `parseCsv`**

Add to `src/lib/csv.ts` (at the top, after any existing imports — the file currently starts with `export function toCsv`; place `parseCsv` above it):

```ts
/**
 * Tokenizuje CSV do tablicy wierszy (string[][]). Obsługuje pola w cudzysłowach
 * z przecinkami (polskie liczby "22,4"), zdublowane cudzysłowy "", CRLF i BOM.
 * Pusty końcowy wiersz (po końcowym \n) jest pomijany.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0 // pomiń BOM

  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    rows.push(row)
    row = []
  }

  for (; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      pushField()
    } else if (c === '\n') {
      pushField()
      pushRow()
    } else if (c === '\r') {
      // pomijamy — koniec wiersza obsługuje \n
    } else {
      field += c
    }
  }
  // Domknij ostatni wiersz, o ile coś w nim jest.
  if (field !== '' || row.length > 0) {
    pushField()
    pushRow()
  }
  return rows
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/csv.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/csv.ts src/lib/csv.test.ts
git commit -m "feat: add parseCsv tokenizer"
```

---

## Task 3: Polish number & date parsers

**Files:**
- Create: `src/lib/salesImport.ts`
- Test: `src/lib/salesImport.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/salesImport.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parsePlNumber, parsePlDate } from '@/lib/salesImport'

describe('parsePlNumber', () => {
  it('parses comma decimals', () => {
    expect(parsePlNumber('22,4')).toBe(22.4)
    expect(parsePlNumber('350,56')).toBe(350.56)
  })

  it('parses plain integers', () => {
    expect(parsePlNumber('83')).toBe(83)
  })

  it('returns undefined for empty / non-numeric', () => {
    expect(parsePlNumber('')).toBeUndefined()
    expect(parsePlNumber(undefined)).toBeUndefined()
    expect(parsePlNumber('—')).toBeUndefined()
  })

  it('extracts the number from a noisy cell', () => {
    expect(parsePlNumber('0 (zwrot)')).toBe(0)
  })
})

describe('parsePlDate', () => {
  it('parses DD.MM.YYYY at local noon', () => {
    const ts = parsePlDate('13.01.2026')
    expect(ts).not.toBeNull()
    const d = new Date(ts as number)
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(0)
    expect(d.getDate()).toBe(13)
    expect(d.getHours()).toBe(12)
  })

  it('rejects malformed or out-of-range dates', () => {
    expect(parsePlDate('25.01.22026')).toBeNull()
    expect(parsePlDate('')).toBeNull()
    expect(parsePlDate('foo')).toBeNull()
    expect(parsePlDate('13.13.2026')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/salesImport.test.ts`
Expected: FAIL — module `@/lib/salesImport` does not exist.

- [ ] **Step 3: Implement the parsers**

Create `src/lib/salesImport.ts`:

```ts
// Czysta logika importu sprzedaży z CSV (Arkusze Google) — bez React i bez Dexie.
import { parseCsv } from '@/lib/csv'

/** Parsuje liczbę w formacie PL (przecinek dziesiętny). Zwraca undefined, gdy brak liczby. */
export function parsePlNumber(raw: string | undefined): number | undefined {
  if (raw == null) return undefined
  const cleaned = raw.replace(/\s/g, '').replace(/zł/gi, '').replace(',', '.')
  const m = cleaned.match(/-?\d+(\.\d+)?/)
  if (!m) return undefined
  const n = Number(m[0])
  return Number.isFinite(n) ? n : undefined
}

/** Parsuje datę "DD.MM.YYYY" jako południe lokalne. Zwraca null dla błędnych/poza zakresem. */
export function parsePlDate(raw: string | undefined): number | null {
  if (!raw) return null
  const m = raw.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/)
  if (!m) return null
  const day = Number(m[1])
  const mon = Number(m[2])
  const year = Number(m[3])
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return null
  if (year < 2020 || year > 2030) return null
  return new Date(year, mon - 1, day, 12, 0, 0, 0).getTime()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/salesImport.test.ts`
Expected: PASS (number + date suites).

- [ ] **Step 5: Commit**

```bash
git add src/lib/salesImport.ts src/lib/salesImport.test.ts
git commit -m "feat: add Polish number/date parsers for sales import"
```

---

## Task 4: Column detection + row classification (`parseSalesCsv`)

**Files:**
- Modify: `src/lib/salesImport.ts`
- Test: `src/lib/salesImport.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/salesImport.test.ts`:

```ts
import { parseSalesCsv } from '@/lib/salesImport'

const MAIN_FIXTURE = [
  'Data sprzedaży,Nazwa,Cena zaukupu ,Cena Sprzedaży,Kolumna nr 1,Przychód,Dochód,,Wydatki',
  '14.01.2026,Szalik kości,"22,4",55,,"12742,16","8923,13",,"3819,03"',
  '13.01.2026,Szare spodnie narsiarskie XXXL,"59,39","350,56",Q2,"2359,25",,,',
  '30.01.2026,Ekspozycja,"18,1",,,,,,',
  '25.01.2026,Podbicia,"21,81",,,,,,',
  '01.02.2024,Czarne spodnie narsiarskie XXXL,83,"278,34",,,,,',
  ',,,,,,,,',
].join('\n')

describe('parseSalesCsv', () => {
  const sheet = parseSalesCsv(MAIN_FIXTURE)

  it('detects headers and skips the blank separator row', () => {
    expect(sheet.headerDetected).toBe(true)
    expect(sheet.rows).toHaveLength(5) // blank row dropped
  })

  it('maps a clean row and ignores aggregate columns', () => {
    const r = sheet.rows[0]
    expect(r.productName).toBe('Szalik kości')
    expect(r.purchaseCost).toBe(22.4)
    expect(r.salePrice).toBe(55)
    expect(r.bucket).toBe('ready')
    expect(r.dateTs).not.toBeNull()
  })

  it('parses quoted comma decimals in both price columns', () => {
    const r = sheet.rows[1]
    expect(r.purchaseCost).toBe(59.39)
    expect(r.salePrice).toBe(350.56)
    expect(r.bucket).toBe('ready')
  })

  it('excludes boost/expense rows (Ekspozycja, Podbicia)', () => {
    const excluded = sheet.rows.filter((r) => r.bucket === 'excluded')
    expect(excluded.map((r) => r.productName).sort()).toEqual(['Ekspozycja', 'Podbicia'])
    expect(excluded.every((r) => r.excludedReason === 'fee')).toBe(true)
  })

  it('keeps a 2024-dated row as ready (no false "suspicious year")', () => {
    const r = sheet.rows.find((x) => x.productName.startsWith('Czarne'))!
    expect(r.bucket).toBe('ready')
    expect(r.salePrice).toBe(278.34)
  })

  it('falls back to positional columns when headers are unknown', () => {
    const csv = '1,2,3,4\n10.01.2026,Czapka,30,80'
    const s = parseSalesCsv(csv)
    expect(s.headerDetected).toBe(false)
    expect(s.rows[0]).toMatchObject({ productName: 'Czapka', purchaseCost: 30, salePrice: 80, bucket: 'ready' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/salesImport.test.ts`
Expected: FAIL — `parseSalesCsv` not exported.

- [ ] **Step 3: Implement types + classification + `parseSalesCsv`**

Append to `src/lib/salesImport.ts`:

```ts
export type ImportBucket = 'ready' | 'review' | 'excluded'

export interface ParsedRow {
  /** 1-based indeks wiersza danych w pliku (nagłówek = 0). */
  rowIndex: number
  bucket: ImportBucket
  /** Powody (PL) — dla kubełków review/excluded. */
  issues: string[]
  productName: string
  dateTs: number | null
  salePrice?: number
  purchaseCost?: number
  status: 'completed' | 'returned'
  excludedReason?: 'fee'
}

export interface ParsedSheet {
  rows: ParsedRow[]
  /** false → nie rozpoznano nagłówków, użyto kolumn A–D. */
  headerDetected: boolean
}

/** Czarnowy szkic sprzedaży gotowy do zapisu (bez pól nadawanych przez DB). */
export interface DraftSale {
  soldAt: number
  productName: string
  salePrice: number
  purchaseCost?: number
  status: 'completed' | 'returned'
}

interface ColumnMap {
  date: number
  name: number
  purchase: number
  sale: number
}

/** Rozpoznaje kolumny po nagłówkach (z tolerancją na literówkę "zaukupu"). null → brak dopasowania. */
function detectColumns(header: string[]): ColumnMap | null {
  const norm = header.map((h) => h.trim().toLowerCase())
  const find = (pred: (h: string) => boolean) => norm.findIndex(pred)
  const date = find((h) => h.includes('data'))
  const name = find((h) => h.includes('nazwa'))
  const purchase = find((h) => h.includes('zakup') || h.includes('zaukup'))
  // "Cena Sprzedaży" — odróżniamy od "Data sprzedaży" wymagając też "cena".
  const sale = find((h) => h.includes('sprzeda') && h.includes('cena'))
  if (date < 0 || name < 0 || purchase < 0 || sale < 0) return null
  return { date, name, purchase, sale }
}

const FEE_RE = /podbic|ekspozycj/i
const RETURN_RE = /\(zwrot\)/i

function classifyRow(cells: string[], col: ColumnMap, rowIndex: number): ParsedRow | null {
  const cell = (i: number) => (cells[i] ?? '').trim()
  const name = cell(col.name)
  const rawDate = cell(col.date)
  const rawSale = cell(col.sale)
  const rawPurchase = cell(col.purchase)

  if (!name && !rawDate && !rawSale && !rawPurchase) return null // pusty wiersz separujący

  const salePrice = parsePlNumber(rawSale)
  const purchaseCost = parsePlNumber(rawPurchase)
  const dateTs = parsePlDate(rawDate)
  const isReturn = RETURN_RE.test(name) || RETURN_RE.test(rawSale) || RETURN_RE.test(rawPurchase)
  const status: 'completed' | 'returned' = isReturn ? 'returned' : 'completed'

  const issues: string[] = []
  const isFee = FEE_RE.test(name) && (salePrice === undefined || salePrice <= 0)

  let bucket: ImportBucket
  let excludedReason: ParsedRow['excludedReason']
  if (isFee) {
    bucket = 'excluded'
    excludedReason = 'fee'
    issues.push('Opłata (podbicie/ekspozycja) — nie sprzedaż')
  } else if (!name) {
    bucket = 'review'
    issues.push('Brak nazwy')
  } else if (salePrice === undefined || salePrice <= 0) {
    bucket = 'review'
    issues.push('Brak ceny sprzedaży')
  } else if (dateTs === null) {
    bucket = 'review'
    issues.push('Brak lub niepoprawna data')
  } else {
    bucket = 'ready'
  }

  return { rowIndex, bucket, issues, productName: name, dateTs, salePrice, purchaseCost, status, excludedReason }
}

/** Parsuje cały plik CSV sprzedaży: wykrywa kolumny, klasyfikuje wiersze. */
export function parseSalesCsv(text: string): ParsedSheet {
  const table = parseCsv(text)
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/salesImport.test.ts`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add src/lib/salesImport.ts src/lib/salesImport.test.ts
git commit -m "feat: parse & classify sales rows from CSV"
```

---

## Task 5: Import key + multiset dedup

**Files:**
- Modify: `src/lib/salesImport.ts`
- Test: `src/lib/salesImport.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/salesImport.test.ts`:

```ts
import { saleImportKey, dedupKeyed, type KeyedDraft } from '@/lib/salesImport'

describe('saleImportKey', () => {
  it('is stable and normalizes name + date to the day', () => {
    const ts = parsePlDate('13.01.2026') as number
    const a = saleImportKey('acc1', ts, '  Szalik  Kości ', 55, 22.4)
    const b = saleImportKey('acc1', ts, 'szalik kości', 55, 22.4)
    expect(a).toBe(b)
  })

  it('differs when account, price or name differ', () => {
    const ts = parsePlDate('13.01.2026') as number
    expect(saleImportKey('acc1', ts, 'x', 55, 1)).not.toBe(saleImportKey('acc2', ts, 'x', 55, 1))
    expect(saleImportKey('acc1', ts, 'x', 55, 1)).not.toBe(saleImportKey('acc1', ts, 'x', 56, 1))
  })
})

describe('dedupKeyed (multiset diff)', () => {
  const mk = (key: string): KeyedDraft => ({
    key,
    draft: { soldAt: 0, productName: key, salePrice: 1, status: 'completed' },
  })

  it('inserts only the difference over existing counts', () => {
    const existing = new Map<string, number>([['A', 1]])
    const { toInsert, skipped } = dedupKeyed(existing, [mk('A'), mk('A'), mk('B')])
    expect(toInsert.map((k) => k.key)).toEqual(['A', 'B']) // one A absorbed by existing
    expect(skipped).toBe(1)
  })

  it('inserts everything when nothing exists', () => {
    const { toInsert, skipped } = dedupKeyed(new Map(), [mk('A'), mk('A')])
    expect(toInsert).toHaveLength(2)
    expect(skipped).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/salesImport.test.ts`
Expected: FAIL — `saleImportKey` / `dedupKeyed` not exported.

- [ ] **Step 3: Implement key + dedup**

Append to `src/lib/salesImport.ts`:

```ts
export interface KeyedDraft {
  key: string
  draft: DraftSale
}

/** Deterministyczny klucz treści wiersza — do wykrywania duplikatów przy ponownym imporcie. */
export function saleImportKey(
  accountId: string,
  dateTs: number | null,
  name: string,
  salePrice: number,
  purchaseCost?: number,
): string {
  const day = dateTs === null ? 'nodate' : new Date(dateTs).toISOString().slice(0, 10)
  const n = name.trim().toLowerCase().replace(/\s+/g, ' ')
  return [accountId, day, n, salePrice, purchaseCost ?? ''].join('|')
}

/**
 * Różnica multizbiorów: dla każdego klucza wstawia tylko nadmiar ponad już istniejące.
 * Zachowuje prawdziwe powtórki, a ponowny import tych samych wierszy jest idempotentny.
 */
export function dedupKeyed(
  existingCounts: Map<string, number>,
  keyed: KeyedDraft[],
): { toInsert: KeyedDraft[]; skipped: number } {
  const seen = new Map(existingCounts)
  const toInsert: KeyedDraft[] = []
  let skipped = 0
  for (const item of keyed) {
    const c = seen.get(item.key) ?? 0
    if (c > 0) {
      seen.set(item.key, c - 1)
      skipped++
    } else {
      toInsert.push(item)
    }
  }
  return { toInsert, skipped }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/salesImport.test.ts`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add src/lib/salesImport.ts src/lib/salesImport.test.ts
git commit -m "feat: add import key + multiset dedup"
```

---

## Task 6: `Sale.importKey` field + `importSales` DB helper

**Files:**
- Modify: `src/db/types.ts:144-171` (the `Sale` interface)
- Modify: `src/db/db.ts`

- [ ] **Step 1: Add the optional field to `Sale`**

In `src/db/types.ts`, inside the `Sale` interface, add after the `createdAt: number` line:

```ts
  createdAt: number
  /** Klucz treści wiersza ze źródłowego importu CSV — do idempotentnego ponownego importu. */
  importKey?: string
}
```

(The field is additive and un-indexed — Dexie needs no migration.)

- [ ] **Step 2: Add `importSales` to `src/db/db.ts`**

Add imports at the top of `src/db/db.ts` (next to the existing imports):

```ts
import { uid } from '@/lib/id'
import {
  saleImportKey,
  dedupKeyed,
  type DraftSale,
  type KeyedDraft,
} from '@/lib/salesImport'
```

Then add this function (e.g. after `clearAllData`):

```ts
/**
 * Importuje wiersze sprzedaży do wybranego konta. Liczy klucze treści, odrzuca duplikaty
 * względem wcześniej zaimportowanych wierszy (różnica multizbiorów) i wstawia resztę.
 */
export async function importSales(
  drafts: DraftSale[],
  accountId: string,
): Promise<{ inserted: number; skippedDuplicates: number }> {
  const existing = await db.sales.where('accountId').equals(accountId).toArray()
  const counts = new Map<string, number>()
  for (const s of existing) {
    if (s.importKey) counts.set(s.importKey, (counts.get(s.importKey) ?? 0) + 1)
  }

  const keyed: KeyedDraft[] = drafts.map((d) => ({
    key: saleImportKey(accountId, d.soldAt, d.productName, d.salePrice, d.purchaseCost),
    draft: d,
  }))
  const { toInsert, skipped } = dedupKeyed(counts, keyed)

  const now = Date.now()
  const sales: Sale[] = toInsert.map(({ key, draft }) => ({
    id: uid(),
    productName: draft.productName,
    accountId,
    salePrice: draft.salePrice,
    currency: 'PLN',
    quantity: 1,
    status: draft.status,
    purchaseCost: draft.purchaseCost,
    soldAt: draft.soldAt,
    createdAt: now,
    importKey: key,
  }))

  if (sales.length) await db.sales.bulkAdd(sales)
  return { inserted: sales.length, skippedDuplicates: skipped }
}
```

- [ ] **Step 3: Verify it type-checks**

Run: `npm run typecheck`
Expected: exits 0 (no type errors). `Sale` already imported in `db.ts`; the new `importKey` is optional so existing call-sites are unaffected.

- [ ] **Step 4: Commit**

```bash
git add src/db/types.ts src/db/db.ts
git commit -m "feat: add importSales DB helper with dedup"
```

---

## Task 7: Generalize `FileDrop` to accept CSV

**Files:**
- Modify: `src/components/FileDrop.tsx`

- [ ] **Step 1: Add `accept` + `filter` props (default = current image behavior)**

Replace the whole `src/components/FileDrop.tsx` with:

```tsx
import { useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { UploadCloud } from 'lucide-react'

/** Pole do wgrywania plików — klik lub przeciągnij i upuść. Domyślnie obrazy. */
export function FileDrop({
  onFiles,
  multiple = true,
  disabled,
  children,
  className,
  accept = 'image/*',
  filter,
}: {
  onFiles: (files: File[]) => void
  multiple?: boolean
  disabled?: boolean
  children?: ReactNode
  className?: string
  accept?: string
  filter?: (f: File) => boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const test = filter ?? ((f: File) => f.type.startsWith('image/'))

  const handle = (list: FileList | null) => {
    if (!list) return
    const files = Array.from(list).filter(test)
    if (files.length) onFiles(multiple ? files : files.slice(0, 1))
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        handle(e.dataTransfer.files)
      }}
      className={clsx(
        'flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-4 py-8 text-center transition',
        over ? 'border-brand-400 bg-brand-50' : 'border-ink-200 bg-ink-50/60 hover:border-brand-300 hover:bg-brand-50/40',
        disabled && 'pointer-events-none opacity-50',
        className,
      )}
    >
      {children ?? (
        <>
          <UploadCloud className="text-brand-500" />
          <span className="text-sm font-semibold text-ink-700">
            Przeciągnij zdjęcia lub kliknij, aby wybrać
          </span>
          <span className="text-xs text-ink-400">JPG / PNG · wiele plików naraz</span>
        </>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(e) => {
          handle(e.target.files)
          e.target.value = ''
        }}
      />
    </button>
  )
}
```

- [ ] **Step 2: Verify existing image usages still type-check**

Run: `npm run typecheck`
Expected: exits 0. `accept`/`filter` are optional with image defaults, so `PhotoStudio`/other callers are unchanged.

- [ ] **Step 3: Commit**

```bash
git add src/components/FileDrop.tsx
git commit -m "feat: FileDrop accepts custom accept/filter (CSV-ready)"
```

---

## Task 8: `ImportSalesModal` component

**Files:**
- Create: `src/components/ImportSalesModal.tsx`

- [ ] **Step 1: Create the modal**

Create `src/components/ImportSalesModal.tsx`:

```tsx
import { useMemo, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import clsx from 'clsx'
import { FileUp, Loader2, Plus } from 'lucide-react'
import { db, importSales } from '@/db/db'
import { parseSalesCsv, type ParsedRow, type DraftSale } from '@/lib/salesImport'
import { uid } from '@/lib/id'
import { ACCOUNT_COLORS } from '@/lib/constants'
import { dateFromInput, dateInputValue, dateShort, money } from '@/lib/format'
import { toast } from '@/state/toast'
import { FileDrop } from '@/components/FileDrop'
import { Button, Field, Modal, Select, TextInput } from '@/components/ui'

interface EditRow extends ParsedRow {
  /** Stabilny klucz Reacta: `${plik}#${rowIndex}`. */
  key: string
  sourceFile: string
  include: boolean
}

const isCsv = (f: File) =>
  /\.csv$/i.test(f.name) || f.type.includes('csv') || f.type === 'text/plain'

export function ImportSalesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const accounts = useLiveQuery(() => db.accounts.orderBy('createdAt').toArray(), [])
  const [accountId, setAccountId] = useState('')
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [rows, setRows] = useState<EditRow[]>([])
  const [busy, setBusy] = useState(false)

  const reset = () => {
    setRows([])
    setNewName('')
    setCreating(false)
  }

  const onFiles = async (files: File[]) => {
    const next: EditRow[] = []
    for (const f of files) {
      const text = await f.text()
      const { rows: parsed } = parseSalesCsv(text)
      for (const r of parsed) {
        next.push({
          ...r,
          key: `${f.name}#${r.rowIndex}`,
          sourceFile: f.name,
          include: r.bucket === 'ready',
        })
      }
    }
    if (!next.length) {
      toast.error('Nie znaleziono wierszy w pliku CSV.')
      return
    }
    setRows(next)
  }

  const setRow = (key: string, patch: Partial<EditRow>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  const drafts = useMemo<DraftSale[]>(
    () =>
      rows
        .filter((r) => r.include && r.salePrice != null && r.salePrice > 0 && r.dateTs != null)
        .map((r) => ({
          soldAt: r.dateTs as number,
          productName: r.productName,
          salePrice: r.salePrice as number,
          purchaseCost: r.purchaseCost,
          status: r.status,
        })),
    [rows],
  )

  const createAccount = async () => {
    if (!newName.trim()) return toast.error('Podaj nazwę konta.')
    const id = uid()
    await db.accounts.put({
      id,
      name: newName.trim(),
      color: ACCOUNT_COLORS[(accounts?.length ?? 0) % ACCOUNT_COLORS.length],
      createdAt: Date.now(),
    })
    setAccountId(id)
    setNewName('')
    setCreating(false)
    toast.success('Utworzono konto.')
  }

  const doImport = async () => {
    if (!accountId) return toast.error('Wybierz konto.')
    if (!drafts.length) return toast.error('Brak wierszy do importu.')
    setBusy(true)
    try {
      const res = await importSales(drafts, accountId)
      toast.success(`Zaimportowano ${res.inserted}, pominięto duplikaty: ${res.skippedDuplicates}.`)
      reset()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Błąd importu.')
    } finally {
      setBusy(false)
    }
  }

  const ready = rows.filter((r) => r.bucket === 'ready')
  const review = rows.filter((r) => r.bucket === 'review')
  const excluded = rows.filter((r) => r.bucket === 'excluded')

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title="Import sprzedaży z CSV"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-ink-500">{drafts.length} do importu</span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Anuluj
            </Button>
            <Button onClick={doImport} disabled={busy || !accountId || drafts.length === 0}>
              {busy ? <Loader2 size={16} className="animate-spin-slow" /> : <>Zaimportuj {drafts.length}</>}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        <Field label="Konto, do którego przypisać sprzedaż">
          {creating ? (
            <div className="flex gap-2">
              <TextInput
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="np. Main / Zosia"
                autoFocus
              />
              <Button onClick={createAccount}>Utwórz</Button>
              <Button variant="ghost" onClick={() => setCreating(false)}>
                Anuluj
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="flex-1">
                <option value="">— wybierz —</option>
                {accounts?.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
              <Button variant="ghost" onClick={() => setCreating(true)}>
                <Plus size={16} /> Nowe
              </Button>
            </div>
          )}
        </Field>

        <FileDrop onFiles={onFiles} accept=".csv,text/csv" filter={isCsv} multiple>
          <FileUp className="text-brand-500" />
          <span className="text-sm font-semibold text-ink-700">
            Przeciągnij plik CSV (Arkusze: Plik → Pobierz → .csv) lub kliknij
          </span>
          <span className="text-xs text-ink-400">Jeden plik = jedno konto (Main, Zoos…)</span>
        </FileDrop>

        {rows.length > 0 && (
          <div className="space-y-4">
            <Bucket title={`Gotowe do importu (${ready.length})`} tone="good">
              {ready.map((r) => (
                <RowLine key={r.key} r={r} onToggle={(v) => setRow(r.key, { include: v })} />
              ))}
            </Bucket>

            {review.length > 0 && (
              <Bucket title={`Do sprawdzenia (${review.length})`} tone="warn">
                {review.map((r) => (
                  <ReviewLine key={r.key} r={r} onChange={(patch) => setRow(r.key, patch)} />
                ))}
              </Bucket>
            )}

            {excluded.length > 0 && (
              <Bucket title={`Pominięte — nie sprzedaż (${excluded.length})`} tone="muted">
                {excluded.map((r) => (
                  <RowLine key={r.key} r={r} onToggle={(v) => setRow(r.key, { include: v })} />
                ))}
              </Bucket>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

function Bucket({
  title,
  tone,
  children,
}: {
  title: string
  tone: 'good' | 'warn' | 'muted'
  children: ReactNode
}) {
  const dot = { good: 'bg-emerald-500', warn: 'bg-amber-500', muted: 'bg-ink-300' }[tone]
  return (
    <div className="rounded-xl border border-ink-100">
      <div className="flex items-center gap-2 border-b border-ink-100 px-4 py-2 text-sm font-semibold text-ink-700">
        <span className={clsx('h-2 w-2 rounded-full', dot)} /> {title}
      </div>
      <div className="divide-y divide-ink-50">{children}</div>
    </div>
  )
}

function RowLine({ r, onToggle }: { r: EditRow; onToggle: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-3 px-4 py-2 text-sm">
      <input
        type="checkbox"
        checked={r.include}
        onChange={(e) => onToggle(e.target.checked)}
        className="h-4 w-4 rounded border-ink-300 text-brand-500 focus:ring-brand-400"
      />
      <span className="flex-1 truncate text-ink-800">
        {r.productName || <em className="text-ink-400">bez nazwy</em>}
      </span>
      <span className="text-ink-400">{r.dateTs ? dateShort(r.dateTs) : '—'}</span>
      <span className="w-20 text-right font-medium tabular-nums">
        {r.salePrice != null ? money(r.salePrice) : '—'}
      </span>
    </label>
  )
}

function ReviewLine({ r, onChange }: { r: EditRow; onChange: (patch: Partial<EditRow>) => void }) {
  const valid = r.salePrice != null && r.salePrice > 0 && r.dateTs != null
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
      <input
        type="checkbox"
        checked={r.include}
        disabled={!valid}
        onChange={(e) => onChange({ include: e.target.checked })}
        className="h-4 w-4 rounded border-ink-300 text-brand-500 focus:ring-brand-400 disabled:opacity-40"
      />
      <span className="min-w-[8rem] flex-1 truncate text-ink-800">
        {r.productName || <em className="text-ink-400">bez nazwy</em>}
      </span>
      <TextInput
        type="date"
        className="w-36"
        value={r.dateTs ? dateInputValue(r.dateTs) : ''}
        onChange={(e) =>
          onChange({ dateTs: e.target.value ? dateFromInput(e.target.value, Date.now()) : null })
        }
      />
      <TextInput
        type="number"
        inputMode="decimal"
        className="w-24"
        placeholder="cena"
        value={r.salePrice ?? ''}
        onChange={(e) => onChange({ salePrice: e.target.value === '' ? undefined : Number(e.target.value) })}
      />
      <span className="w-full text-xs text-amber-600 sm:w-auto">{r.issues.join('; ')}</span>
    </div>
  )
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npm run typecheck`
Expected: exits 0. (If `noUnusedLocals` flags an import, remove the unused one — every import above is used.)

- [ ] **Step 3: Commit**

```bash
git add src/components/ImportSalesModal.tsx
git commit -m "feat: add ImportSalesModal (preview/review/dedup UI)"
```

---

## Task 9: Wire the "Import" button into the Sales page

**Files:**
- Modify: `src/pages/Sales.tsx`

- [ ] **Step 1: Import the modal, an icon, and add state**

In `src/pages/Sales.tsx`:

1. Add `Upload` to the existing lucide import:

```ts
import { Download, Pencil, Plus, Trash2, Upload, Wallet } from 'lucide-react'
```

2. Add the modal import near the other component imports:

```ts
import { ImportSalesModal } from '@/components/ImportSalesModal'
```

3. Inside `export function Sales()`, add state next to the existing `useState` hooks:

```ts
  const [importOpen, setImportOpen] = useState(false)
```

- [ ] **Step 2: Add the button to the header**

In the `SectionTitle`'s `right` prop, add an Import button before the export "CSV" button so the cluster reads:

```tsx
        right={
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setImportOpen(true)}>
              <Upload size={16} /> Import
            </Button>
            <Button variant="ghost" onClick={exportCsv} disabled={filtered.length === 0}>
              <Download size={16} /> CSV
            </Button>
            <Button onClick={startNew}>
              <Plus size={16} /> Dodaj sprzedaż
            </Button>
          </div>
        }
```

- [ ] **Step 3: Render the modal**

Just before the closing `</div>` of the component's returned JSX (next to the existing `<SaleModal ... />`), add:

```tsx
      <ImportSalesModal open={importOpen} onClose={() => setImportOpen(false)} />
```

- [ ] **Step 4: Verify it type-checks**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Sales.tsx
git commit -m "feat: add Import button to Sales page"
```

---

## Task 10: Full verification + manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: PASS — all `csv.test.ts` and `salesImport.test.ts` suites green.

- [ ] **Step 2: Type-check + production build**

Run: `npm run build`
Expected: `tsc -b` passes and `vite build` completes with no errors.

- [ ] **Step 3: Manual smoke test in the browser**

Run: `npm run dev`, open the app, go to **Sprzedaż** (Sales).

Create a file `sample-main.csv` with this content and import it (assign to a new account "Main"):

```
Data sprzedaży,Nazwa,Cena zaukupu ,Cena Sprzedaży,Kolumna nr 1,Przychód,Dochód,,Wydatki
14.01.2026,Szalik kości,"22,4",55,,"12742,16","8923,13",,"3819,03"
13.01.2026,Szare spodnie narsiarskie XXXL,"59,39","350,56",Q2,"2359,25",,,
30.01.2026,Ekspozycja,"18,1",,,,,,
,Czarne spodnie narsiarskie XXL,"62,29",,,,,,
26.04.2026,Tabi 3,"163,58",400,,,,,
```

Verify:
- **Gotowe do importu** shows `Szalik kości` (55 zł), `Szare spodnie narsiarskie XXXL` (350,56 zł), `Tabi 3` (400 zł).
- **Do sprawdzenia** shows the dateless `Czarne spodnie narsiarskie XXL` (no price) — editable.
- **Pominięte — nie sprzedaż** shows `Ekspozycja`.
- Click **Zaimportuj 3** → toast "Zaimportowano 3…"; the three rows appear in the table with correct profit (sale − purchase).
- Re-import the **same file** → toast reports "Zaimportowano 0, pominięto duplikaty: 3" and **no duplicate rows** are added. (Confirms idempotency.)

- [ ] **Step 4: Commit any fixes**

If the smoke test surfaced issues, fix them, re-run `npm test` and `npm run build`, then:

```bash
git add -A
git commit -m "fix: address sales-import smoke test findings"
```

---

## Self-Review notes

- **Spec coverage:** CSV upload (Tasks 7–9) · header/column detection ignoring aggregates (Task 4) · Polish comma-decimal + DD.MM.YYYY parsing (Task 3) · three buckets ready/review/excluded with inline edit + exclude toggle (Tasks 4, 8) · boost/expense exclusion by default + `(zwrot)`→returned (Task 4) · multiset dedup + `importKey` field, no migration (Tasks 5–6) · account mapping with inline create (Task 8) · field mapping to `Sale` (Task 6) · vitest with real fixtures (Tasks 1–5). Out-of-scope items (OAuth, write-back, finessin, expenses, paste) are not implemented — as intended.
- **Type consistency:** `DraftSale`, `ParsedRow`, `ParsedSheet`, `KeyedDraft`, `ImportBucket` defined in Task 4/5 and consumed unchanged in Tasks 6 and 8. `importSales(drafts, accountId)` signature matches its call in Task 8.
- **Deviation:** "suspicious year" auto-flag narrowed to structural date validation (see header) to avoid false positives.
