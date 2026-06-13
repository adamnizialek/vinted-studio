# Stock Import from Google Sheets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import unsold items from the `finessin` "all items" sheet into the magazyn (products) table, auto-matching each to an account against the sales already in the app, with a manual review bucket for the ambiguous tail.

**Architecture:** A pure parse/transform/match engine (`src/lib/stockImport.ts`), a thin DB write helper (`importStock` in `src/db/db.ts`) doing in-memory multiset dedup in one `rw` transaction, and one UI modal (`ImportStockModal.tsx`) wired to a button on the Inventory page. Reuses the sold-importer primitives (`parseCsv`, `parsePlNumber`, the boost/fee regex, `FileDrop`).

**Tech Stack:** Vite + React 18 + TypeScript, Dexie 4 (IndexedDB) with `dexie-react-hooks` `useLiveQuery`, vitest 2 + `fake-indexeddb`, Tailwind, lucide-react.

**Spec:** `docs/superpowers/specs/2026-06-13-stock-import-google-sheets-design.md`

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/db/types.ts` | Domain types | **Modify** — add `Product.importKey?: string` |
| `src/lib/salesImport.ts` | Sold-import pure logic | **Modify** — `export` the boost/fee regex for reuse |
| `src/lib/stockImport.ts` | Stock-import pure logic (parse, classify, normalize, match, key, dedup) | **Create** |
| `src/lib/stockImport.test.ts` | Unit tests for the pure logic | **Create** |
| `src/db/db.ts` | Dexie + write helpers | **Modify** — add `importStock` |
| `src/db/importStock.test.ts` | `fake-indexeddb` e2e for `importStock` | **Create** |
| `src/components/ImportStockModal.tsx` | Import UI (file drop, buckets, review, commit) | **Create** |
| `src/pages/Inventory.tsx` | Magazyn page | **Modify** — "Importuj stan" button + modal |

Run a single test file with `npx vitest run <path>`; the whole suite with `npm test`; typecheck + bundle with `npm run build`.

---

### Task 1: Schema/types prep

Add the additive `importKey` field to `Product` (un-indexed — Dexie needs no migration) and export the boost/fee regex from the sold importer so the stock importer shares one source of truth.

**Files:**
- Modify: `src/db/types.ts:106-139` (the `Product` interface)
- Modify: `src/lib/salesImport.ts:80` (the `FEE_RE` constant)

- [ ] **Step 1: Add `importKey` to `Product`**

In `src/db/types.ts`, inside the `Product` interface, add the field right after `soldAt?: number` (the last field before the closing brace):

```ts
  createdAt: number
  updatedAt: number
  listedAt?: number
  soldAt?: number
  /** Klucz treści wiersza ze źródłowego importu CSV — do idempotentnego ponownego importu. */
  importKey?: string
}
```

- [ ] **Step 2: Export the boost/fee regex**

In `src/lib/salesImport.ts`, change line 80 from:

```ts
const FEE_RE = /podbic|ekspozycj/i
```

to:

```ts
export const FEE_RE = /podbic|ekspozycj/i
```

(Leave everything else in `salesImport.ts` unchanged — the sold importer keeps using `FEE_RE` exactly as before.)

- [ ] **Step 3: Verify it compiles**

Run: `npm run build`
Expected: build succeeds (exit 0). The new optional field and the `export` keyword are additive — no other code breaks.

- [ ] **Step 4: Commit**

```bash
git add src/db/types.ts src/lib/salesImport.ts
git commit -m "feat: add Product.importKey and export FEE_RE for stock import"
```

---

### Task 2: `stockImport.ts` — parse & classify

Create the pure module's parsing half: types, column detection (header + positional fallback for `finessin`), and per-row classification into `stock` / `sold` / `excluded`. The decisive signal for **stock** is "has a real name + no sale price + not a boost/fee".

**Files:**
- Create: `src/lib/stockImport.ts`
- Test: `src/lib/stockImport.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/stockImport.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseStockCsv } from '@/lib/stockImport'

// Realny kształt eksportu z arkusza `finessin` (8 kolumn; komórki z przecinkiem w cudzysłowie).
// Wiersze niesprzedane mają pustą datę, znacznik `rrrr-12` w kolumnie Miesiąc i PUSTĄ cenę sprzedaży.
const FINESSIN = [
  'Data sprzedaży,Miesiąc,Nazwa przedmiotu,Cena zakupu,Cena sprzedaży,Zysk,Zysk z poprzedniego arkusza,Aktualny zysk',
  '14.01.2026,rrrr-01,Szalik kości MD175497,"22,4",55,"32,6","1 700zł","11077,78"', // sprzedane
  ',rrrr-12,Koszulka Messi,35,,-35,,', // magazyn
  ',rrrr-12,Koszulka Messi,35,,-35,,', // magazyn (duplikat)
  ',rrrr-12,Bluza zebra AX10247937,"42,92",,"-42,92",,', // magazyn
  '25.01.2026,rrrr-01,Bluza zebra AX10247937,"42,92",140,"97,08",,', // sprzedane
  '31.01.2026,rrrr-01,Podbicia main,"34,39",,"-34,39",,', // opłata
  ',rrrr-12,Czarne spodnie narsiarskie XXXL,83,,-83,,', // magazyn
  ',rrrr-12,0,,,,,', // śmieć (nazwa bez liter) → pominięte
].join('\n')

describe('parseStockCsv', () => {
  it('classifies finessin rows into stock / sold / excluded and skips junk', () => {
    const rows = parseStockCsv(FINESSIN)
    expect(rows.filter((r) => r.bucket === 'stock')).toHaveLength(4)
    expect(rows.filter((r) => r.bucket === 'sold')).toHaveLength(2)
    expect(rows.filter((r) => r.bucket === 'excluded')).toHaveLength(1)
    expect(rows).toHaveLength(7) // wiersz "0" pominięty (null)
  })

  it('reads name + purchase and leaves sale price empty for an unsold row', () => {
    const rows = parseStockCsv(FINESSIN)
    const messi = rows.find((r) => r.name === 'Koszulka Messi')!
    expect(messi.bucket).toBe('stock')
    expect(messi.purchaseCost).toBe(35)
    expect(messi.salePrice).toBeUndefined()
  })

  it('falls back to finessin column positions when headers are unrecognizable', () => {
    const noHeader = [
      'x,y,z,a,b,c,d,e',
      ',rrrr-12,Naszyjnik kościotrup XA20749,"4,38",,"-4,38",,',
    ].join('\n')
    const rows = parseStockCsv(noHeader)
    expect(rows).toHaveLength(1)
    expect(rows[0].bucket).toBe('stock')
    expect(rows[0].name).toBe('Naszyjnik kościotrup XA20749')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/stockImport.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/stockImport"` / `parseStockCsv is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/stockImport.ts`:

```ts
// Czysta logika importu STANU MAGAZYNU z CSV (arkusz `finessin`) — bez React i bez Dexie.
// Importujemy tylko wiersze NIESPRZEDANE; wiersze sprzedane należą do importu sprzedaży.
import type { ID } from '@/db/types'
import { parseCsv } from '@/lib/csv'
import { parsePlNumber, FEE_RE } from '@/lib/salesImport'

export type StockBucket = 'stock' | 'sold' | 'excluded'

export interface ParsedStockRow {
  /** 1-based indeks wiersza danych w pliku (nagłówek = 0). */
  rowIndex: number
  bucket: StockBucket
  /** Powody (PL) — dla kubełków sold/excluded. */
  issues: string[]
  name: string
  purchaseCost?: number
  salePrice?: number
}

/** Szkic przedmiotu z magazynu (bez konta — to dokłada dopasowanie/recenzja). */
export interface StockDraft {
  name: string
  purchaseCost?: number
}

/** Szkic gotowy do zapisu — po auto-dopasowaniu i ręcznej recenzji. */
export type ResolvedStockDraft = StockDraft & { accountId?: ID }

interface StockColumnMap {
  name: number
  purchase: number
  sale: number
}

/** Rozpoznaje kolumny po nagłówkach (toleruje literówkę "zaukupu"). null → brak dopasowania. */
function detectStockColumns(header: string[]): StockColumnMap | null {
  const norm = header.map((h) => h.trim().toLowerCase())
  const find = (pred: (h: string) => boolean) => norm.findIndex(pred)
  const name = find((h) => h.includes('nazwa'))
  const purchase = find((h) => h.includes('zakup') || h.includes('zaukup'))
  // "Cena sprzedaży" — odróżniamy od "Data sprzedaży" wymagając też "cena".
  const sale = find((h) => h.includes('sprzeda') && h.includes('cena'))
  if (name < 0 || purchase < 0 || sale < 0) return null
  return { name, purchase, sale }
}

function classifyStockRow(
  cells: string[],
  col: StockColumnMap,
  rowIndex: number,
): ParsedStockRow | null {
  const cell = (i: number) => (cells[i] ?? '').trim()
  const name = cell(col.name)
  // Wiersz bez prawdziwej nazwy (pusty / sama liczba jak "0" / separator) — pomijamy.
  if (!name || !/[a-z]/i.test(name)) return null

  const salePrice = parsePlNumber(cell(col.sale))
  const purchaseCost = parsePlNumber(cell(col.purchase))

  if (FEE_RE.test(name)) {
    return {
      rowIndex,
      bucket: 'excluded',
      issues: ['Opłata (podbicie/ekspozycja) — nie magazyn'],
      name,
      purchaseCost,
      salePrice,
    }
  }
  if (salePrice !== undefined && salePrice > 0) {
    return {
      rowIndex,
      bucket: 'sold',
      issues: ['Sprzedane — pomijane (należy do sprzedaży)'],
      name,
      purchaseCost,
      salePrice,
    }
  }
  // Brak ceny sprzedaży → przedmiot wciąż w magazynie.
  return { rowIndex, bucket: 'stock', issues: [], name, purchaseCost, salePrice }
}

/** Parsuje cały plik CSV `finessin`: wykrywa kolumny i klasyfikuje wiersze. Nigdy nie rzuca. */
export function parseStockCsv(text: string): ParsedStockRow[] {
  const table = parseCsv(text)
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/stockImport.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/stockImport.ts src/lib/stockImport.test.ts
git commit -m "feat: parseStockCsv — classify finessin rows into stock/sold/excluded"
```

---

### Task 3: `stockImport.ts` — normalize & account match

Add name normalization (strip SKU codes, keep size tokens), the account index built from existing sales, and the matcher that returns single / ambiguous / none.

**Files:**
- Modify: `src/lib/stockImport.ts` (append)
- Test: `src/lib/stockImport.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/lib/stockImport.test.ts`:

```ts
import { normalizeForMatch, matchAccounts } from '@/lib/stockImport'

describe('normalizeForMatch', () => {
  it('strips SKU-like codes but keeps size tokens and words', () => {
    expect(normalizeForMatch('Bluza zebra AX10247937')).toBe('bluza zebra')
    expect(normalizeForMatch('Szalik kości MD175497')).toBe('szalik kości')
    expect(normalizeForMatch('Zegarek damski róż sj2306109140799009')).toBe('zegarek damski róż')
    expect(normalizeForMatch('Czarne spodnie narsiarskie XXXL')).toBe('czarne spodnie narsiarskie xxxl')
    expect(normalizeForMatch('  Koszulka   Messi ')).toBe('koszulka messi')
  })
})

describe('matchAccounts', () => {
  const sales = [
    { productName: 'Bluza zebra AX10247937', accountId: 'acc-main' },
    { productName: 'Czarne spodnie narsiarskie XXXL', accountId: 'acc-main' },
    { productName: 'Czarne spodnie narsiarskie XXXL', accountId: 'acc-zoos' },
  ]

  it('assigns when exactly one account sold the name', () => {
    const [m] = matchAccounts([{ name: 'Bluza zebra AX10247937' }], sales)
    expect(m.confidence).toBe('single')
    expect(m.accountId).toBe('acc-main')
  })

  it('flags ambiguous when two accounts sold the name', () => {
    const [m] = matchAccounts([{ name: 'Czarne spodnie narsiarskie XXXL' }], sales)
    expect(m.confidence).toBe('ambiguous')
    expect(m.accountId).toBeUndefined()
    expect(m.candidates).toHaveLength(2)
    expect(m.candidates).toContain('acc-main')
    expect(m.candidates).toContain('acc-zoos')
  })

  it('flags none when no account sold the name', () => {
    const [m] = matchAccounts([{ name: 'Koszulka Messi' }], sales)
    expect(m.confidence).toBe('none')
    expect(m.accountId).toBeUndefined()
    expect(m.candidates).toHaveLength(0)
  })

  it('ignores sales with no accountId when building the index', () => {
    const [m] = matchAccounts([{ name: 'Top free' }], [{ productName: 'Top free', accountId: undefined }])
    expect(m.confidence).toBe('none')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/stockImport.test.ts`
Expected: FAIL — `normalizeForMatch is not a function` / `matchAccounts is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/lib/stockImport.ts`:

```ts
export interface AccountMatch {
  draft: StockDraft
  /** Ustawione tylko gdy confidence === 'single'. */
  accountId?: ID
  /** Konta, które sprzedały tę (znormalizowaną) nazwę. */
  candidates: ID[]
  confidence: 'single' | 'ambiguous' | 'none'
}

/**
 * Normalizuje nazwę do dopasowania: małe litery, zwinięte spacje, BEZ kodów SKU.
 * Kody SKU (np. "AX10247937", "MD175497", "sj2306109140799009") są usuwane;
 * tokeny rozmiaru ("XXXL", "M") to czyste litery i ZOSTAJĄ.
 */
export function normalizeForMatch(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b[a-z]{1,3}\d{4,}\b/gi, ' ') // kody typu "ax10247937" / "md175497"
    .replace(/\b\d{6,}\b/g, ' ') // długie kody czysto cyfrowe
    .replace(/\s+/g, ' ')
    .trim()
}

/** Buduje indeks: znormalizowana nazwa sprzedaży → zbiór kont, które ją sprzedały. */
export function buildAccountIndex(
  sales: { productName: string; accountId?: ID }[],
): Map<string, Set<ID>> {
  const idx = new Map<string, Set<ID>>()
  for (const s of sales) {
    if (!s.accountId) continue
    const key = normalizeForMatch(s.productName)
    if (!key) continue
    let set = idx.get(key)
    if (!set) {
      set = new Set<ID>()
      idx.set(key, set)
    }
    set.add(s.accountId)
  }
  return idx
}

/** Dopasowuje każdy szkic do konta na podstawie sprzedaży już w aplikacji. */
export function matchAccounts(
  drafts: StockDraft[],
  sales: { productName: string; accountId?: ID }[],
): AccountMatch[] {
  const idx = buildAccountIndex(sales)
  return drafts.map((draft) => {
    const candidates = [...(idx.get(normalizeForMatch(draft.name)) ?? [])]
    if (candidates.length === 1) {
      return { draft, accountId: candidates[0], candidates, confidence: 'single' }
    }
    if (candidates.length >= 2) {
      return { draft, accountId: undefined, candidates, confidence: 'ambiguous' }
    }
    return { draft, accountId: undefined, candidates, confidence: 'none' }
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/stockImport.test.ts`
Expected: PASS (all `parseStockCsv` + `normalizeForMatch` + `matchAccounts` tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/stockImport.ts src/lib/stockImport.test.ts
git commit -m "feat: normalizeForMatch + matchAccounts (single/ambiguous/none)"
```

---

### Task 4: `stockImport.ts` — content key & multiset dedup

Add the content key (account-independent, so re-import is stable across manual reassignments) and the multiset diff used by `importStock`.

**Files:**
- Modify: `src/lib/stockImport.ts` (append)
- Test: `src/lib/stockImport.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/lib/stockImport.test.ts`:

```ts
import { stockImportKey, dedupKeyedStock, type KeyedStockDraft } from '@/lib/stockImport'

describe('stockImportKey', () => {
  it('is stable under whitespace/case/SKU differences and includes purchase cost', () => {
    expect(stockImportKey('Koszulka  Messi', 35)).toBe(stockImportKey('koszulka messi', 35))
    expect(stockImportKey('Bluza zebra AX10247937', 42.92)).toBe('bluza zebra|42.92')
    expect(stockImportKey('Koszulka Messi')).toBe('koszulka messi|')
  })
})

describe('dedupKeyedStock', () => {
  const keyed = (n: number): KeyedStockDraft[] =>
    Array.from({ length: n }, () => ({ key: 'k', draft: { name: 'x' } }))

  it('inserts everything when nothing exists', () => {
    const { toInsert, skipped } = dedupKeyedStock(new Map(), keyed(5))
    expect(toInsert).toHaveLength(5)
    expect(skipped).toBe(0)
  })

  it('skips exactly the already-present count (multiset)', () => {
    const { toInsert, skipped } = dedupKeyedStock(new Map([['k', 2]]), keyed(5))
    expect(toInsert).toHaveLength(3)
    expect(skipped).toBe(2)
  })

  it('is idempotent when counts already cover the incoming rows', () => {
    const { toInsert, skipped } = dedupKeyedStock(new Map([['k', 5]]), keyed(5))
    expect(toInsert).toHaveLength(0)
    expect(skipped).toBe(5)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/stockImport.test.ts`
Expected: FAIL — `stockImportKey is not a function` / `dedupKeyedStock is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/lib/stockImport.ts`:

```ts
export interface KeyedStockDraft {
  key: string
  draft: ResolvedStockDraft
}

/**
 * Deterministyczny klucz treści przedmiotu — do wykrywania duplikatów przy ponownym imporcie.
 * Konto CELOWO nie wchodzi do klucza (źródło `finessin` nie zna konta), więc ponowny import
 * jest stabilny nawet po ręcznym przypisaniu konta w magazynie.
 */
export function stockImportKey(name: string, purchaseCost?: number): string {
  return [normalizeForMatch(name), purchaseCost ?? ''].join('|')
}

/**
 * Różnica multizbiorów: dla każdego klucza wstawia tylko nadmiar ponad już istniejące.
 * Zachowuje prawdziwe powtórki (np. 5× ta sama koszulka), a ponowny import jest idempotentny.
 */
export function dedupKeyedStock(
  existingCounts: Map<string, number>,
  keyed: KeyedStockDraft[],
): { toInsert: KeyedStockDraft[]; skipped: number } {
  const seen = new Map(existingCounts)
  const toInsert: KeyedStockDraft[] = []
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/stockImport.test.ts`
Expected: PASS (all stockImport unit tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/stockImport.ts src/lib/stockImport.test.ts
git commit -m "feat: stockImportKey + dedupKeyedStock (multiset, account-independent)"
```

---

### Task 5: `importStock` DB helper

Write the Dexie helper: read existing products' keys, multiset-dedup the incoming resolved drafts, and `bulkAdd` the surplus as `in_stock` products in one `rw` transaction.

**Files:**
- Modify: `src/db/db.ts:14-20` (imports) and append `importStock` after `importSales` (around `:221`)
- Test: `src/db/importStock.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/db/importStock.test.ts`:

```ts
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db, importStock } from '@/db/db'
import type { ResolvedStockDraft } from '@/lib/stockImport'

const DRAFTS: ResolvedStockDraft[] = [
  { name: 'Koszulka Messi', purchaseCost: 35 },
  { name: 'Koszulka Messi', purchaseCost: 35 },
  { name: 'Bluza zebra AX10247937', purchaseCost: 42.92, accountId: 'acc-main' },
]

describe('importStock end-to-end (fake-indexeddb)', () => {
  beforeEach(async () => {
    await db.products.clear()
  })

  it('inserts in_stock products and is idempotent on re-import', async () => {
    const first = await importStock(DRAFTS)
    expect(first.inserted).toBe(3)
    expect(first.skippedDuplicates).toBe(0)
    expect(await db.products.count()).toBe(3)

    const second = await importStock(DRAFTS)
    expect(second.inserted).toBe(0)
    expect(second.skippedDuplicates).toBe(3)
    expect(await db.products.count()).toBe(3)
  })

  it('persists the resolved account and the default product shape', async () => {
    await importStock(DRAFTS)
    const all = await db.products.toArray()
    const bluza = all.find((p) => p.name === 'Bluza zebra AX10247937')!
    expect(bluza.accountId).toBe('acc-main')
    expect(bluza.status).toBe('in_stock')
    expect(bluza.condition).toBe('dobry')
    expect(bluza.currency).toBe('PLN')
    expect(bluza.quantity).toBe(1)
    expect(bluza.purchasePrice).toBe(42.92)
    expect(bluza.importKey).toBeTruthy()
    // Konto niedopasowane zostaje puste.
    const messi = all.filter((p) => p.name === 'Koszulka Messi')
    expect(messi).toHaveLength(2)
    expect(messi.every((p) => p.accountId === undefined)).toBe(true)
  })

  it('multiset: re-import with extra copies inserts only the surplus', async () => {
    await importStock([{ name: 'Koszulka Messi', purchaseCost: 35 }, { name: 'Koszulka Messi', purchaseCost: 35 }])
    expect(await db.products.count()).toBe(2)

    const five = Array.from({ length: 5 }, () => ({ name: 'Koszulka Messi', purchaseCost: 35 }))
    const res = await importStock(five)
    expect(res.inserted).toBe(3) // 5 - 2 już istniejące
    expect(res.skippedDuplicates).toBe(2)
    expect(await db.products.count()).toBe(5)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/db/importStock.test.ts`
Expected: FAIL — `importStock is not a function` (not exported from `@/db/db`).

- [ ] **Step 3: Write the minimal implementation**

In `src/db/db.ts`, extend the `salesImport` import block (currently lines 15-20) to also pull the stock helpers — add a second import block right under it:

```ts
import {
  saleImportKey,
  dedupKeyed,
  type DraftSale,
  type KeyedDraft,
} from '@/lib/salesImport'
import {
  stockImportKey,
  dedupKeyedStock,
  type ResolvedStockDraft,
  type KeyedStockDraft,
} from '@/lib/stockImport'
```

Then append `importStock` immediately after the `importSales` function (after its closing brace near line 221):

```ts
/**
 * Importuje NIESPRZEDANE przedmioty do magazynu (tabela `products`) jako `in_stock`.
 * Konto bierze z auto-dopasowania / recenzji (może być puste). Deduplikacja multizbiorów
 * względem wcześniej zaimportowanych przedmiotów (po `importKey`) czyni ponowny import idempotentnym.
 */
export async function importStock(
  drafts: ResolvedStockDraft[],
): Promise<{ inserted: number; skippedDuplicates: number }> {
  return db.transaction('rw', db.products, async () => {
    const existing = await db.products.toArray()
    const counts = new Map<string, number>()
    for (const p of existing) {
      if (p.importKey) counts.set(p.importKey, (counts.get(p.importKey) ?? 0) + 1)
    }

    const keyed: KeyedStockDraft[] = drafts.map((d) => ({
      key: stockImportKey(d.name, d.purchaseCost),
      draft: d,
    }))
    const { toInsert, skipped } = dedupKeyedStock(counts, keyed)

    const now = Date.now()
    const products: Product[] = toInsert.map(({ key, draft }) => ({
      id: uid(),
      name: draft.name,
      condition: 'dobry',
      purchasePrice: draft.purchaseCost,
      currency: 'PLN',
      quantity: 1,
      status: 'in_stock',
      accountId: draft.accountId,
      photoIds: [],
      generatedPhotoIds: [],
      descriptions: [],
      tags: [],
      importKey: key,
      createdAt: now,
      updatedAt: now,
    }))

    if (products.length) await db.products.bulkAdd(products)
    return { inserted: products.length, skippedDuplicates: skipped }
  })
}
```

(`Product` is already imported at the top of `db.ts`; `uid` too.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/db/importStock.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the whole suite + build**

Run: `npm test` then `npm run build`
Expected: all tests pass; build exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/db/db.ts src/db/importStock.test.ts
git commit -m "feat: importStock — multiset-deduped in_stock products in a transaction"
```

---

### Task 6: `ImportStockModal` component

Build the UI: a single-CSV drop, run `parseStockCsv` + `matchAccounts` against live `db.sales`, show buckets (auto-matched / review with per-row account picker / already-in-magazyn / excluded), and commit via `importStock`. Auto-matched rows are checked by default; review rows become checked when you assign an account.

**Files:**
- Create: `src/components/ImportStockModal.tsx`

- [ ] **Step 1: Write the component**

Create `src/components/ImportStockModal.tsx`:

```tsx
import { useMemo, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import clsx from 'clsx'
import { FileUp, Loader2 } from 'lucide-react'
import { db, importStock } from '@/db/db'
import {
  parseStockCsv,
  matchAccounts,
  stockImportKey,
  type StockBucket,
  type ResolvedStockDraft,
} from '@/lib/stockImport'
import type { Account } from '@/db/types'
import { money } from '@/lib/format'
import { toast } from '@/state/toast'
import { FileDrop } from '@/components/FileDrop'
import { Button, Field, Modal, Select } from '@/components/ui'

interface EditRow {
  /** Stabilny klucz Reacta: `${plik}#${rowIndex}`. */
  key: string
  rowIndex: number
  bucket: StockBucket
  name: string
  purchaseCost?: number
  salePrice?: number
  issues: string[]
  /** Dopasowanie (tylko dla bucket === 'stock'). */
  accountId?: string
  candidates: string[]
  confidence: 'single' | 'ambiguous' | 'none'
  include: boolean
}

const isCsv = (f: File) =>
  /\.csv$/i.test(f.name) || f.type.includes('csv') || f.type === 'text/plain'

export function ImportStockModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const accounts = useLiveQuery(() => db.accounts.orderBy('createdAt').toArray(), [])
  const sales = useLiveQuery(() => db.sales.toArray(), [])
  const [rows, setRows] = useState<EditRow[]>([])
  const [busy, setBusy] = useState(false)

  // Klucze treści przedmiotów już w magazynie (multizbiór) — TYLKO do podglądu licznika.
  // Faktyczną deduplikację robi importStock.
  const existingCounts = useLiveQuery(async () => {
    const products = await db.products.toArray()
    const m = new Map<string, number>()
    for (const p of products) if (p.importKey) m.set(p.importKey, (m.get(p.importKey) ?? 0) + 1)
    return m
  }, [])

  const close = () => {
    setRows([])
    onClose()
  }

  const onFiles = async (files: File[]) => {
    try {
      const salesForMatch = (sales ?? []).map((s) => ({
        productName: s.productName,
        accountId: s.accountId,
      }))
      const next: EditRow[] = []
      for (const f of files) {
        const text = await f.text()
        const parsed = parseStockCsv(text)
        const stock = parsed.filter((r) => r.bucket === 'stock')
        const matches = matchAccounts(stock, salesForMatch)
        const byRow = new Map(stock.map((r, i) => [r.rowIndex, matches[i]]))
        for (const r of parsed) {
          const m = byRow.get(r.rowIndex)
          const confidence = m?.confidence ?? 'none'
          next.push({
            key: `${f.name}#${r.rowIndex}`,
            rowIndex: r.rowIndex,
            bucket: r.bucket,
            name: r.name,
            purchaseCost: r.purchaseCost,
            salePrice: r.salePrice,
            issues: r.issues,
            accountId: m?.accountId,
            candidates: m?.candidates ?? [],
            confidence,
            // Pewne dopasowania zaznaczone domyślnie; reszta czeka na ręczne przypisanie.
            include: r.bucket === 'stock' && confidence === 'single',
          })
        }
      }
      if (!next.some((r) => r.bucket === 'stock')) {
        toast.error('Nie znaleziono przedmiotów w magazynie w tym pliku.')
        return
      }
      setRows(next)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Nie udało się odczytać pliku.')
    }
  }

  // Wybór konta w recenzji: ustaw konto i automatycznie zaznacz wiersz do importu.
  const assignAccount = (key: string, accountId: string) =>
    setRows((rs) =>
      rs.map((r) =>
        r.key === key ? { ...r, accountId: accountId || undefined, include: accountId ? true : r.include } : r,
      ),
    )

  const toggleInclude = (key: string, include: boolean) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, include } : r)))

  // Wiersze, które trafią do importu. importStock sam zdeduplikuje.
  const includable = useMemo(
    () => rows.filter((r) => r.bucket === 'stock' && r.include),
    [rows],
  )

  // Które z włączanych wierszy już są w magazynie (multizbiór) — TYLKO do podglądu/licznika.
  const dupKeys = useMemo(() => {
    const counts = new Map(existingCounts ?? [])
    const dup = new Set<string>()
    for (const r of includable) {
      const k = stockImportKey(r.name, r.purchaseCost)
      const c = counts.get(k) ?? 0
      if (c > 0) {
        counts.set(k, c - 1)
        dup.add(r.key)
      }
    }
    return dup
  }, [includable, existingCounts])

  const newCount = includable.length - dupKeys.size

  const drafts = useMemo<ResolvedStockDraft[]>(
    () => includable.map((r) => ({ name: r.name, purchaseCost: r.purchaseCost, accountId: r.accountId })),
    [includable],
  )

  const doImport = async () => {
    if (!drafts.length) return toast.error('Brak przedmiotów do importu.')
    setBusy(true)
    try {
      const res = await importStock(drafts)
      toast.success(`Dodano do magazynu: ${res.inserted}, pominięto duplikaty: ${res.skippedDuplicates}.`)
      close()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Błąd importu.')
    } finally {
      setBusy(false)
    }
  }

  const autoMatched = rows.filter(
    (r) => r.bucket === 'stock' && r.confidence === 'single' && !dupKeys.has(r.key),
  )
  const alreadyIn = rows.filter(
    (r) => r.bucket === 'stock' && r.confidence === 'single' && dupKeys.has(r.key),
  )
  const review = rows.filter((r) => r.bucket === 'stock' && r.confidence !== 'single')
  const excluded = rows.filter((r) => r.bucket === 'excluded')
  const soldCount = rows.filter((r) => r.bucket === 'sold').length

  return (
    <Modal
      open={open}
      onClose={close}
      size="xl"
      title="Import stanu magazynu z CSV"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-ink-500">{newCount} do dodania</span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={close}>
              Anuluj
            </Button>
            <Button onClick={doImport} disabled={busy || newCount === 0}>
              {busy ? <Loader2 size={16} className="animate-spin-slow" /> : <>Dodaj {newCount} do magazynu</>}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        <FileDrop onFiles={onFiles} accept=".csv,text/csv" filter={isCsv} multiple={false}>
          <FileUp className="text-brand-500" />
          <span className="text-sm font-semibold text-ink-700">
            Przeciągnij plik „all items" (finessin) lub kliknij
          </span>
          <span className="text-xs text-ink-400">
            Importują się tylko niesprzedane przedmioty — konto dobierane z Twojej sprzedaży.
          </span>
        </FileDrop>

        {(!sales || sales.length === 0) && (
          <p className="rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-700 ring-1 ring-amber-200">
            Brak sprzedaży w aplikacji — nie ma do czego dopasowywać kont. Zaimportuj najpierw
            sprzedaż (Main, Zoos), a potem stan magazynu, żeby konta dobrały się automatycznie.
          </p>
        )}

        {rows.length > 0 && (
          <div className="space-y-4">
            <Bucket title={`Dopasowane automatycznie (${autoMatched.length})`} tone="good">
              {autoMatched.map((r) => (
                <StockRowLine
                  key={r.key}
                  r={r}
                  account={accounts?.find((a) => a.id === r.accountId)}
                  onToggle={(v) => toggleInclude(r.key, v)}
                />
              ))}
            </Bucket>

            {review.length > 0 && (
              <Bucket title={`Do przypisania konta (${review.length})`} tone="warn">
                {review.map((r) => (
                  <ReviewStockLine
                    key={r.key}
                    r={r}
                    accounts={accounts ?? []}
                    onAssign={(id) => assignAccount(r.key, id)}
                    onToggle={(v) => toggleInclude(r.key, v)}
                  />
                ))}
              </Bucket>
            )}

            {alreadyIn.length > 0 && (
              <Bucket title={`Już w magazynie (${alreadyIn.length})`} tone="muted">
                {alreadyIn.map((r) => (
                  <StockRowLine key={r.key} r={r} account={accounts?.find((a) => a.id === r.accountId)} onToggle={() => {}} disabled />
                ))}
              </Bucket>
            )}

            {excluded.length > 0 && (
              <Bucket title={`Pominięte — nie magazyn (${excluded.length})`} tone="muted">
                {excluded.map((r) => (
                  <StockRowLine key={r.key} r={r} onToggle={() => {}} disabled />
                ))}
              </Bucket>
            )}

            {soldCount > 0 && (
              <p className="px-1 text-xs text-ink-400">
                Pominięto {soldCount} sprzedanych wierszy (należą do importu sprzedaży).
              </p>
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

function StockRowLine({
  r,
  account,
  onToggle,
  disabled,
}: {
  r: EditRow
  account?: Account
  onToggle: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <label className={clsx('flex items-center gap-3 px-4 py-2 text-sm', disabled && 'opacity-60')}>
      <input
        type="checkbox"
        checked={r.include}
        disabled={disabled}
        onChange={(e) => onToggle(e.target.checked)}
        className="h-4 w-4 rounded border-ink-300 text-brand-500 focus:ring-brand-400 disabled:opacity-40"
      />
      <span className="flex-1 truncate text-ink-800">
        {r.name || <em className="text-ink-400">bez nazwy</em>}
      </span>
      {account && (
        <span className="flex items-center gap-1.5 text-xs text-ink-400">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: account.color }} />
          {account.name}
        </span>
      )}
      <span className="w-20 text-right font-medium tabular-nums">
        {r.purchaseCost != null ? money(r.purchaseCost) : '—'}
      </span>
    </label>
  )
}

function ReviewStockLine({
  r,
  accounts,
  onAssign,
  onToggle,
}: {
  r: EditRow
  accounts: Account[]
  onAssign: (accountId: string) => void
  onToggle: (v: boolean) => void
}) {
  // Kandydaci (konta, które sprzedały tę nazwę) na górze listy.
  const ordered = [
    ...accounts.filter((a) => r.candidates.includes(a.id)),
    ...accounts.filter((a) => !r.candidates.includes(a.id)),
  ]
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
      <input
        type="checkbox"
        aria-label="Dodaj ten przedmiot"
        checked={r.include}
        onChange={(e) => onToggle(e.target.checked)}
        className="h-4 w-4 rounded border-ink-300 text-brand-500 focus:ring-brand-400"
      />
      <span className="min-w-[8rem] flex-1 truncate text-ink-800">
        {r.name || <em className="text-ink-400">bez nazwy</em>}
      </span>
      <Select
        value={r.accountId ?? ''}
        onChange={(e) => onAssign(e.target.value)}
        className="w-44"
        aria-label="Konto dla przedmiotu"
      >
        <option value="">— brak konta —</option>
        {ordered.map((a) => (
          <option key={a.id} value={a.id}>
            {r.candidates.includes(a.id) ? `• ${a.name}` : a.name}
          </option>
        ))}
      </Select>
      <span className="w-20 text-right font-medium tabular-nums">
        {r.purchaseCost != null ? money(r.purchaseCost) : '—'}
      </span>
      <span className="w-full text-xs text-amber-600">
        {r.confidence === 'ambiguous'
          ? 'Sprzedawane na kilku kontach — wybierz właściwe.'
          : 'Brak dopasowania — wybierz konto lub zostaw bez.'}
      </span>
    </div>
  )
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build`
Expected: build succeeds (exit 0). If `Modal` rejects `size="xl"` or `Select` rejects `aria-label`, open `src/components/ui.tsx` and confirm the prop names — the sold-import modal (`ImportSalesModal.tsx`) uses `Modal size="xl"` and `Select`, so they are supported; match its usage exactly.

- [ ] **Step 3: Commit**

```bash
git add src/components/ImportStockModal.tsx
git commit -m "feat: ImportStockModal — bucketed preview with per-row account review"
```

---

### Task 7: Wire the button into the Inventory page

Add an "Importuj stan" button next to "Dodaj produkt" and render the modal.

**Files:**
- Modify: `src/pages/Inventory.tsx:1-13` (imports + state) and `:70-78` (header) and near `:173` (render modal)

- [ ] **Step 1: Add imports and state**

In `src/pages/Inventory.tsx`, add `Upload` to the lucide import (line 3) and import the modal. Change:

```ts
import { Package, Plus, Search } from 'lucide-react'
```
to:
```ts
import { Package, Plus, Search, Upload } from 'lucide-react'
```

Add this import alongside the other component imports (after the `Thumb` import, line 13):

```ts
import { ImportStockModal } from '@/components/ImportStockModal'
```

Add modal state next to the existing `useState` hooks (after line 23, `const [accountId, setAccountId] = useState<string>('all')`):

```ts
  const [importOpen, setImportOpen] = useState(false)
```

- [ ] **Step 2: Add the button to the header**

Replace the `SectionTitle`'s `right` prop (currently a single `Button`, lines 73-77):

```tsx
        right={
          <Button onClick={createProduct}>
            <Plus size={16} /> Dodaj produkt
          </Button>
        }
```
with:
```tsx
        right={
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setImportOpen(true)}>
              <Upload size={16} /> Importuj stan
            </Button>
            <Button onClick={createProduct}>
              <Plus size={16} /> Dodaj produkt
            </Button>
          </div>
        }
```

- [ ] **Step 3: Render the modal**

Just before the final closing `</div>` of the component's returned JSX (after the products grid block, around line 172), add:

```tsx
      <ImportStockModal open={importOpen} onClose={() => setImportOpen(false)} />
```

- [ ] **Step 4: Verify build + full test suite**

Run: `npm run build` then `npm test`
Expected: build exits 0; all tests pass.

- [ ] **Step 5: Manual smoke test (optional but recommended)**

Run: `npm run dev`, open the app, go to **Magazyn**, click **Importuj stan**, drop a `finessin` CSV (Google Sheets: Plik → Pobierz → .csv). Confirm: unsold items appear under "Dopasowane automatycznie" / "Do przypisania konta"; sold and boost rows are excluded; clicking **Dodaj … do magazynu** creates `in_stock` products; re-importing the same file adds nothing.

- [ ] **Step 6: Commit**

```bash
git add src/pages/Inventory.tsx
git commit -m "feat: wire ImportStockModal into the Magazyn page"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Source = finessin, unsold = no sale price → Task 2 (`classifyStockRow`). ✓
- Sold rows ignored, boost excluded → Task 2 buckets `sold`/`excluded`. ✓
- Auto-match against `db.sales`; single → assigned, two+/none → review → Task 3 (`matchAccounts`) + Task 6 (review bucket). ✓
- SKU strip / size-token keep → Task 3 (`normalizeForMatch`). ✓
- Destination `in_stock` products, default `condition: 'dobry'`, one-per-row → Task 5 (`importStock`). ✓
- Idempotent re-import, additive un-indexed `importKey`, multiset dedup → Task 1 + Task 4 + Task 5. ✓
- UI: file drop, buckets, per-row account picker, "import sold first" nudge → Task 6. ✓
- Inventory wiring → Task 7. ✓
- Tests (unit + fake-indexeddb e2e) → Tasks 2-5. ✓

**Placeholder scan:** none — every code step is complete.

**Type consistency:** `StockDraft`, `ResolvedStockDraft`, `ParsedStockRow`, `StockBucket`, `AccountMatch`, `KeyedStockDraft` are defined in Task 2/3/4 and consumed with the same names/shapes in Tasks 5-6. `parseStockCsv`, `matchAccounts`, `normalizeForMatch`, `stockImportKey`, `dedupKeyedStock`, `importStock` keep one signature throughout. `FEE_RE` exported in Task 1, imported in Task 2. ✓
