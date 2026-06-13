# Per-account sales import + imported-data repair — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the sales importer from dumping every sheet onto one account, and give the user a surgical "clear imported data" action so the current mess can be re-imported correctly.

**Architecture:** Two new pure helpers (`suggestAccountForSheet`, `looksLikeStockSheet`) and one new filtered DB op (`clearImportedData` / `countImportedData`) are added with TDD. The `ImportSalesModal` is rewritten to treat each dropped file/sheet as a "source" with its own account dropdown (auto-suggested), importing all sources in one pass while blocking the all-items (`finessin`) file. A Settings button wires the clear op. No Dexie schema change; the existing `importSales`/`importExpenses`/stock importer are reused unchanged.

**Tech Stack:** React 18 + TypeScript, Vite, Dexie (IndexedDB), Tailwind. Tests via **vitest** + `fake-indexeddb`.

**Spec:** `docs/superpowers/specs/2026-06-13-sales-import-per-account-and-repair-design.md`

---

## File Structure

- `src/lib/salesImport.ts` — **modify**: add pure `suggestAccountForSheet` + `looksLikeStockSheet` (and a private `fold` helper). No React/Dexie.
- `src/lib/salesImport.test.ts` — **modify**: add suites for the two new helpers.
- `src/db/db.ts` — **modify**: add `countImportedData` + `clearImportedData` (+ private `isImportedProduct` predicate).
- `src/db/clearImportedData.test.ts` — **create**: fake-indexeddb tests for clear/count.
- `src/components/ImportSalesModal.tsx` — **rewrite**: single-account → multi-source/per-account.
- `src/pages/Settings.tsx` — **modify**: add "Wyczyść zaimportowane dane" button to the backup card.

---

## Task 1: Pure helpers — `suggestAccountForSheet` + `looksLikeStockSheet`

**Files:**
- Modify: `src/lib/salesImport.ts`
- Test: `src/lib/salesImport.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/salesImport.test.ts`:

```ts
import { suggestAccountForSheet, looksLikeStockSheet } from '@/lib/salesImport'

describe('suggestAccountForSheet', () => {
  const accounts = [
    { id: 'acc-pangea', name: 'pangea', notes: 'main' },
    { id: 'acc-zoos', name: 'zoos07' },
  ]

  it('matches a file named "Main" to the account whose note is "main"', () => {
    expect(suggestAccountForSheet('Main.xlsx', accounts)).toBe('acc-pangea')
  })

  it('matches "Zoos" / "zoos07 …" to "zoos07" by substring', () => {
    expect(suggestAccountForSheet('Zoos.xlsx', accounts)).toBe('acc-zoos')
    expect(suggestAccountForSheet('zoos07 sprzedaż.csv', accounts)).toBe('acc-zoos')
  })

  it('returns undefined when two accounts match the same word', () => {
    const ambiguous = [
      { id: 'a', name: 'sklep ania' },
      { id: 'b', name: 'sklep zosia' },
    ]
    expect(suggestAccountForSheet('sklep.xlsx', ambiguous)).toBeUndefined()
  })

  it('returns undefined when nothing matches', () => {
    expect(suggestAccountForSheet('raport-2026.xlsx', accounts)).toBeUndefined()
  })

  it('ignores tiny words and the file extension', () => {
    expect(suggestAccountForSheet('a.csv', accounts)).toBeUndefined()
  })
})

describe('looksLikeStockSheet', () => {
  it('is true when a header has a "Miesiąc" column (finessin)', () => {
    expect(
      looksLikeStockSheet(['Data sprzedaży', 'Miesiąc', 'Nazwa przedmiotu', 'Cena zakupu', 'Cena sprzedaży']),
    ).toBe(true)
  })

  it('is diacritic-insensitive', () => {
    expect(looksLikeStockSheet(['data', 'miesiac', 'nazwa'])).toBe(true)
  })

  it('is false for the Main/Zoos sales header', () => {
    expect(looksLikeStockSheet(['Data sprzedaży', 'Nazwa', 'Cena zaukupu', 'Cena Sprzedaży'])).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/salesImport.test.ts`
Expected: FAIL — `suggestAccountForSheet` / `looksLikeStockSheet` are not exported.

- [ ] **Step 3: Implement the helpers**

Append to `src/lib/salesImport.ts`:

```ts
// ---------------------------------------------------------------------------
// Dopasowanie pliku/arkusza do konta + wykrycie pliku „wszystkie przedmioty".
// ---------------------------------------------------------------------------

/** Składa tekst do porównań: małe litery, bez polskich znaków diakrytycznych. */
function fold(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

const NAME_STOPWORDS = new Set(['xlsx', 'xls', 'csv', 'sheet', 'arkusz'])

/**
 * Najlepsze (jednoznaczne) dopasowanie nazwy pliku/arkusza do konta — po name/notes/vintedUsername.
 * Słowa krótsze niż 3 znaki oraz rozszerzenia plików są ignorowane. Dopasowanie jest dwukierunkowym
 * podciągiem (np. słowo „zoos" pasuje do konta „zoos07"). Zwraca id konta tylko gdy pasuje DOKŁADNIE jedno.
 */
export function suggestAccountForSheet(
  sheetName: string,
  accounts: { id: string; name: string; notes?: string; vintedUsername?: string }[],
): string | undefined {
  const base = sheetName.replace(/\.(xlsx|xls|csv)$/i, '')
  const words = fold(base)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !NAME_STOPWORDS.has(w))
  if (!words.length) return undefined
  const matches = accounts.filter((a) => {
    const fields = [a.name, a.notes ?? '', a.vintedUsername ?? ''].map(fold).filter(Boolean)
    return words.some((w) => fields.some((f) => f.includes(w) || (f.length >= 3 && w.includes(f))))
  })
  return matches.length === 1 ? matches[0].id : undefined
}

/** Czy nagłówek wygląda na plik „wszystkie przedmioty" (finessin) — sygnaturą jest kolumna „Miesiąc". */
export function looksLikeStockSheet(header: string[]): boolean {
  return header.some((h) => fold(h).includes('miesiac'))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/salesImport.test.ts`
Expected: PASS — all existing suites plus the two new ones.

- [ ] **Step 5: Commit**

```bash
git add src/lib/salesImport.ts src/lib/salesImport.test.ts
git commit -m "feat(import): sheet→account suggestion + finessin detection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `clearImportedData` + `countImportedData` (filtered, tombstoned)

**Files:**
- Modify: `src/db/db.ts`
- Test: `src/db/clearImportedData.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/db/clearImportedData.test.ts`:

```ts
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db, clearImportedData, countImportedData } from '@/db/db'

beforeEach(async () => {
  await db.sales.clear()
  await db.expenses.clear()
  await db.products.clear()
  await db.outbox.clear()
})

describe('clearImportedData', () => {
  it('removes only imported rows; keeps manual rows and photographed products', async () => {
    await db.sales.bulkPut([
      { id: 's1', productName: 'A', salePrice: 10, currency: 'PLN', quantity: 1, status: 'completed', soldAt: 0, accountId: 'acc', createdAt: 0, updatedAt: 0, importKey: 'acc|2026-01-01|a|10|' },
      { id: 's2', productName: 'B manual', salePrice: 20, currency: 'PLN', quantity: 1, status: 'completed', soldAt: 0, accountId: 'acc', createdAt: 0, updatedAt: 0 },
    ])
    await db.expenses.bulkPut([
      { id: 'e1', kind: 'boost', description: 'Podbicia', amount: 5, currency: 'PLN', incurredAt: 0, accountId: 'acc', createdAt: 0, updatedAt: 0, importKey: 'acc|2026-01-01|boost|podbicia|5' },
      { id: 'e2', kind: 'other', description: 'manual', amount: 9, currency: 'PLN', incurredAt: 0, accountId: 'acc', createdAt: 0, updatedAt: 0 },
    ])
    await db.products.bulkPut([
      // imported, no photos → removed
      { id: 'p1', name: 'Koszulka', condition: 'dobry', currency: 'PLN', quantity: 1, status: 'in_stock', accountId: 'acc', photoIds: [], generatedPhotoIds: [], descriptions: [], tags: [], createdAt: 0, updatedAt: 0, importKey: 'koszulka|35' },
      // imported, but worked on in Studio (has a photo) → kept
      { id: 'p2', name: 'Bluza', condition: 'dobry', currency: 'PLN', quantity: 1, status: 'in_stock', accountId: 'acc', photoIds: ['img1'], generatedPhotoIds: [], descriptions: [], tags: [], createdAt: 0, updatedAt: 0, importKey: 'bluza|40' },
      // hand-made Studio product (no importKey) → kept
      { id: 'p3', name: 'Studio', condition: 'dobry', currency: 'PLN', quantity: 1, status: 'draft', photoIds: ['img2'], generatedPhotoIds: ['g1'], descriptions: [], tags: [], createdAt: 0, updatedAt: 0 },
    ])

    const res = await clearImportedData()
    expect(res).toEqual({ sales: 1, expenses: 1, products: 1 })

    expect((await db.sales.toArray()).map((s) => s.id)).toEqual(['s2'])
    expect((await db.expenses.toArray()).map((e) => e.id)).toEqual(['e2'])
    expect((await db.products.toArray()).map((p) => p.id).sort()).toEqual(['p2', 'p3'])
  })

  it('queues a tombstone in the outbox for each deleted row', async () => {
    await db.sales.put({ id: 's1', productName: 'A', salePrice: 10, currency: 'PLN', quantity: 1, status: 'completed', soldAt: 0, createdAt: 0, updatedAt: 0, importKey: 'k' })
    await clearImportedData()
    const tomb = await db.outbox.get(['sales', 's1'])
    expect(tomb).toMatchObject({ table: 'sales', id: 's1', deleted: 1 })
  })

  it('countImportedData matches what clear would remove', async () => {
    await db.sales.put({ id: 's1', productName: 'A', salePrice: 10, currency: 'PLN', quantity: 1, status: 'completed', soldAt: 0, createdAt: 0, updatedAt: 0, importKey: 'k' })
    await db.products.put({ id: 'p1', name: 'x', condition: 'dobry', currency: 'PLN', quantity: 1, status: 'in_stock', photoIds: [], generatedPhotoIds: [], descriptions: [], tags: [], createdAt: 0, updatedAt: 0, importKey: 'k2' })
    expect(await countImportedData()).toEqual({ sales: 1, expenses: 0, products: 1 })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/db/clearImportedData.test.ts`
Expected: FAIL — `clearImportedData` / `countImportedData` are not exported from `@/db/db`.

- [ ] **Step 3: Implement the functions**

In `src/db/db.ts`, add right after `clearAllData` (it already imports `Table` from dexie, `Product` from `./types`, and `SyncTable` from `@/sync/core`):

```ts
/** Przedmiot z importu, którego usunięcie jest bezpieczne (brak własnej pracy: zdjęć). */
const isImportedProduct = (p: Product) =>
  p.importKey != null && (p.photoIds?.length ?? 0) === 0 && (p.generatedPhotoIds?.length ?? 0) === 0

/** Liczy wiersze pochodzące z importu (z `importKey`), które usunąłby `clearImportedData`. */
export async function countImportedData(): Promise<{ sales: number; expenses: number; products: number }> {
  const [sales, expenses, products] = await Promise.all([
    db.sales.filter((s) => s.importKey != null).count(),
    db.expenses.filter((e) => e.importKey != null).count(),
    db.products.filter(isImportedProduct).count(),
  ])
  return { sales, expenses, products }
}

/**
 * Usuwa WYŁĄCZNIE dane pochodzące z importu CSV/XLSX (z `importKey`): sprzedaże, koszty
 * promocji oraz przedmioty z magazynu BEZ zdjęć. Ręczne wpisy, konta, ustawienia i produkty,
 * nad którymi pracowano w Studio (mają zdjęcia), zostają nietknięte. Propaguje usunięcia przez
 * tombstone'y (jak `clearAllData`), więc czyszczenie obejmuje też chmurę i pozostałe urządzenia.
 */
export async function clearImportedData(): Promise<{ sales: number; expenses: number; products: number }> {
  const now = Date.now()
  return db.transaction('rw', [db.sales, db.expenses, db.products, db.outbox], async () => {
    const sales = await db.sales.filter((s) => s.importKey != null).toArray()
    const expenses = await db.expenses.filter((e) => e.importKey != null).toArray()
    const products = await db.products.filter(isImportedProduct).toArray()

    const wipe = async (
      table: SyncTable,
      tbl: Table<{ id: string }, string>,
      rows: { id: string }[],
    ) => {
      for (const r of rows) {
        await tbl.delete(r.id)
        await db.outbox.put({ table, id: r.id, deleted: 1, updatedAt: now })
      }
    }

    await wipe('sales', db.sales as Table<{ id: string }, string>, sales)
    await wipe('expenses', db.expenses as Table<{ id: string }, string>, expenses)
    await wipe('products', db.products as Table<{ id: string }, string>, products)

    return { sales: sales.length, expenses: expenses.length, products: products.length }
  })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/db/clearImportedData.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Type-check**

Run: `npm run typecheck`
Expected: exits 0. (`Product`, `Table`, `SyncTable` are already imported in `db.ts`; `'sales' | 'expenses' | 'products'` are valid `SyncTable` members — they're used in existing `outbox.put` calls in the same file.)

- [ ] **Step 6: Commit**

```bash
git add src/db/db.ts src/db/clearImportedData.test.ts
git commit -m "feat(db): clearImportedData/countImportedData (importKey-filtered, tombstoned)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Rewrite `ImportSalesModal` to multi-source → per-account

**Files:**
- Modify (full replace): `src/components/ImportSalesModal.tsx`

This modal is verified by `npm run typecheck` + `npm run build` + the manual smoke test in Task 5 (the repo does not unit-test modals; the pure logic it calls is already covered).

- [ ] **Step 1: Replace the file contents**

Replace the entire contents of `src/components/ImportSalesModal.tsx` with:

```tsx
import { useMemo, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import clsx from 'clsx'
import { FileUp, Loader2, Plus, X } from 'lucide-react'
import { db, importSales, importExpenses, putEntity } from '@/db/db'
import {
  parseSalesTable,
  parseExpenseDrafts,
  saleImportKey,
  suggestAccountForSheet,
  looksLikeStockSheet,
  type ParsedRow,
  type DraftSale,
  type DraftExpense,
} from '@/lib/salesImport'
import { readWorkbook, isSpreadsheet } from '@/lib/spreadsheet'
import { uid } from '@/lib/id'
import { ACCOUNT_COLORS } from '@/lib/constants'
import { dateFromInput, dateInputValue, dateShort, money } from '@/lib/format'
import type { Account } from '@/db/types'
import { toast } from '@/state/toast'
import { FileDrop } from '@/components/FileDrop'
import { Button, Field, Modal, Select, TextInput } from '@/components/ui'

const rowValid = (r: { salePrice?: number; dateTs: number | null }) =>
  r.salePrice != null && r.salePrice > 0 && r.dateTs != null

interface EditRow extends ParsedRow {
  /** Stabilny klucz Reacta: `${sourceId}#${rowIndex}`. */
  key: string
  include: boolean
}

/** Jeden plik/arkusz wczytany do importu — z własnym kontem i własnymi wierszami. */
interface Source {
  /** `${nazwaPliku}::${nazwaArkusza}` — unikalne i stabilne. */
  id: string
  fileName: string
  sheetName: string
  header: string[]
  /** Wykryto plik „wszystkie przedmioty" (finessin) — nie importujemy go jako sprzedaży. */
  isStock: boolean
  /** Przypisane konto ('' = jeszcze nie wybrano). */
  accountId: string
  rows: EditRow[]
}

/** Pochodne dla jednego źródła: co wejdzie do importu i co jest duplikatem. */
interface Computed {
  source: Source
  drafts: DraftSale[]
  expenseDrafts: DraftExpense[]
  dup: Set<string>
  newCount: number
  expenseCount: number
}

export function ImportSalesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const accounts = useLiveQuery(() => db.accounts.orderBy('createdAt').toArray(), [])
  const [sources, setSources] = useState<Source[]>([])
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  // Multizbiór importKeyów już w bazie (importKey zawiera accountId), wyłącznie do PODGLĄDU
  // duplikatów. Faktyczną deduplikację robi importSales.
  const existingCounts = useLiveQuery(async () => {
    const sales = await db.sales.toArray()
    const m = new Map<string, number>()
    for (const s of sales) if (s.importKey) m.set(s.importKey, (m.get(s.importKey) ?? 0) + 1)
    return m
  }, [])

  const reset = () => {
    setSources([])
    setCreating(false)
    setNewName('')
  }
  const close = () => {
    reset()
    onClose()
  }

  const onFiles = async (files: File[]) => {
    const next: Source[] = []
    for (const f of files) {
      try {
        const wb = await readWorkbook(f)
        for (const sheetName of wb.sheetNames) {
          const table = wb.tableOf(sheetName)
          const header = table[0] ?? []
          const { rows: parsed } = parseSalesTable(table)
          if (!parsed.length) continue
          const isStock = looksLikeStockSheet(header)
          const id = `${f.name}::${sheetName}`
          const rows: EditRow[] = parsed.map((r) => ({
            ...r,
            key: `${id}#${r.rowIndex}`,
            // Stock-plik nic nie zaznacza; reszta: gotowe sprzedaże + koszty promocji.
            include: !isStock && (r.bucket === 'ready' || r.bucket === 'excluded'),
          }))
          const accountId = isStock
            ? ''
            : suggestAccountForSheet(`${f.name} ${sheetName}`, accounts ?? []) ?? ''
          next.push({ id, fileName: f.name, sheetName, header, isStock, accountId, rows })
        }
      } catch (e) {
        toast.error(`${f.name}: ${e instanceof Error ? e.message : 'Nie udało się odczytać pliku.'}`)
      }
    }
    if (!next.length) {
      toast.error('Nie znaleziono wierszy sprzedaży w wybranych plikach.')
      return
    }
    // Pomiń źródła już wczytane (ten sam plik+arkusz), by ponowny drop nie dublował sekcji.
    setSources((prev) => {
      const have = new Set(prev.map((s) => s.id))
      return [...prev, ...next.filter((s) => !have.has(s.id))]
    })
  }

  const setRow = (sourceId: string, key: string, patch: Partial<EditRow>) =>
    setSources((ss) =>
      ss.map((s) =>
        s.id !== sourceId ? s : { ...s, rows: s.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) },
      ),
    )

  // Edycja wiersza „do sprawdzenia": gdy stał się poprawny, automatycznie zaznacz do importu.
  const patchReviewRow = (sourceId: string, key: string, patch: Partial<EditRow>) =>
    setSources((ss) =>
      ss.map((s) =>
        s.id !== sourceId
          ? s
          : {
              ...s,
              rows: s.rows.map((r) => {
                if (r.key !== key) return r
                const merged = { ...r, ...patch }
                const include = !rowValid(r) && rowValid(merged) ? true : merged.include
                return { ...merged, include }
              }),
            },
      ),
    )

  const setSourceAccount = (sourceId: string, accountId: string) =>
    setSources((ss) => ss.map((s) => (s.id === sourceId ? { ...s, accountId } : s)))

  const removeSource = (sourceId: string) =>
    setSources((ss) => ss.filter((s) => s.id !== sourceId))

  const createAccount = async () => {
    if (!newName.trim()) return toast.error('Podaj nazwę konta.')
    const id = uid()
    await putEntity('accounts', {
      id,
      name: newName.trim(),
      color: ACCOUNT_COLORS[(accounts?.length ?? 0) % ACCOUNT_COLORS.length],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    setNewName('')
    setCreating(false)
    toast.success('Utworzono konto. Wybierz je przy odpowiednim pliku.')
  }

  // Pochodne per źródło: drafty, koszty, duplikaty (każde źródło liczone niezależnie wobec bazy).
  const computed = useMemo<Computed[]>(() => {
    const existing = existingCounts ?? new Map<string, number>()
    return sources.map((s) => {
      const includable = s.isStock ? [] : s.rows.filter((r) => r.include && rowValid(r))
      const counts = new Map(existing)
      const dup = new Set<string>()
      if (s.accountId) {
        for (const r of includable) {
          const k = saleImportKey(s.accountId, r.dateTs as number, r.productName, r.salePrice as number, r.purchaseCost)
          const c = counts.get(k) ?? 0
          if (c > 0) {
            counts.set(k, c - 1)
            dup.add(r.key)
          }
        }
      }
      const drafts: DraftSale[] = includable.map((r) => ({
        soldAt: r.dateTs as number,
        productName: r.productName,
        salePrice: r.salePrice as number,
        purchaseCost: r.purchaseCost,
        status: r.status,
      }))
      const expenseDrafts: DraftExpense[] = s.isStock
        ? []
        : parseExpenseDrafts(s.rows.filter((r) => r.include))
      const expenseCount = expenseDrafts.filter((d) => d.incurredAt !== null).length
      return { source: s, drafts, expenseDrafts, dup, newCount: includable.length - dup.size, expenseCount }
    })
  }, [sources, existingCounts])

  const totalToImport = computed.reduce((n, c) => n + c.newCount + c.expenseCount, 0)
  const unassigned = computed.filter(
    (c) => !c.source.isStock && !c.source.accountId && c.drafts.length + c.expenseDrafts.length > 0,
  )

  const doImport = async () => {
    if (unassigned.length) return toast.error('Przypisz konto do każdego pliku ze sprzedażą.')
    const toRun = computed.filter((c) => c.source.accountId && (c.drafts.length || c.expenseDrafts.length))
    if (!toRun.length) return toast.error('Brak wierszy do importu.')
    setBusy(true)
    try {
      let salesIns = 0
      let expIns = 0
      let dups = 0
      for (const c of toRun) {
        const res = await importSales(c.drafts, c.source.accountId)
        const expRes = await importExpenses(c.expenseDrafts, c.source.accountId)
        salesIns += res.inserted
        expIns += expRes.inserted
        dups += res.skippedDuplicates + expRes.skippedDuplicates
      }
      toast.success(`Zaimportowano: ${salesIns} sprzedaży, ${expIns} kosztów. Pominięto duplikaty: ${dups}.`)
      close()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Błąd importu.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      size="xl"
      title="Import sprzedaży z CSV / XLSX"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-ink-500">{totalToImport} do importu</span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={close}>
              Anuluj
            </Button>
            <Button onClick={doImport} disabled={busy || totalToImport === 0}>
              {busy ? <Loader2 size={16} className="animate-spin-slow" /> : <>Zaimportuj {totalToImport}</>}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        <FileDrop onFiles={onFiles} accept=".csv,.xlsx,.xls,text/csv" filter={isSpreadsheet} multiple>
          <FileUp className="text-brand-500" />
          <span className="text-sm font-semibold text-ink-700">
            Przeciągnij pliki sprzedaży (po jednym na konto) — CSV lub XLSX — lub kliknij
          </span>
          <span className="text-xs text-ink-400">
            Każdy plik/arkusz przypiszesz do konta poniżej. Plik „wszystkie przedmioty" (finessin) zaimportuj w Magazynie.
          </span>
        </FileDrop>

        <div>
          {creating ? (
            <div className="flex gap-2">
              <TextInput value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="np. Main / Zosia" autoFocus />
              <Button onClick={createAccount}>Utwórz</Button>
              <Button variant="ghost" onClick={() => setCreating(false)}>
                Anuluj
              </Button>
            </div>
          ) : (
            <Button variant="ghost" onClick={() => setCreating(true)}>
              <Plus size={16} /> Nowe konto
            </Button>
          )}
        </div>

        {computed.map((c) => (
          <SourceSection
            key={c.source.id}
            c={c}
            accounts={accounts ?? []}
            onAccount={(id) => setSourceAccount(c.source.id, id)}
            onRemove={() => removeSource(c.source.id)}
            onToggle={(key, include) => setRow(c.source.id, key, { include })}
            onReview={(key, patch) => patchReviewRow(c.source.id, key, patch)}
          />
        ))}
      </div>
    </Modal>
  )
}

function SourceSection({
  c,
  accounts,
  onAccount,
  onRemove,
  onToggle,
  onReview,
}: {
  c: Computed
  accounts: Account[]
  onAccount: (accountId: string) => void
  onRemove: () => void
  onToggle: (key: string, include: boolean) => void
  onReview: (key: string, patch: Partial<EditRow>) => void
}) {
  const s = c.source
  const ready = s.rows.filter((r) => r.bucket === 'ready' && !c.dup.has(r.key))
  const alreadyImported = s.rows.filter((r) => r.bucket === 'ready' && c.dup.has(r.key))
  const review = s.rows.filter((r) => r.bucket === 'review')
  const excluded = s.rows.filter((r) => r.bucket === 'excluded')

  return (
    <div className="space-y-4 rounded-2xl border border-ink-200 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold text-ink-900">{s.fileName}</p>
          {s.sheetName !== s.fileName && <p className="truncate text-xs text-ink-400">arkusz: {s.sheetName}</p>}
        </div>
        <button
          onClick={onRemove}
          className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
          aria-label="Usuń plik z importu"
        >
          <X size={16} />
        </button>
      </div>

      {s.isStock ? (
        <div className="rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-700 ring-1 ring-amber-200">
          To wygląda na plik „wszystkie przedmioty" (finessin) z kolumną „Miesiąc". Zaimportuj go w{' '}
          <b>Magazynie</b>, nie tutaj — jako sprzedaż zmieszałby oba konta.
        </div>
      ) : (
        <>
          <Field label="Konto, do którego przypisać tę sprzedaż">
            <Select value={s.accountId} onChange={(e) => onAccount(e.target.value)}>
              <option value="">— wybierz —</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>

          <Bucket title={`Gotowe do importu (${ready.length})`} tone="good">
            {ready.map((r) => (
              <RowLine key={r.key} r={r} onToggle={(v) => onToggle(r.key, v)} />
            ))}
          </Bucket>

          {review.length > 0 && (
            <Bucket title={`Do sprawdzenia (${review.length})`} tone="warn">
              {review.map((r) => (
                <ReviewLine key={r.key} r={r} onChange={(patch) => onReview(r.key, patch)} />
              ))}
            </Bucket>
          )}

          {alreadyImported.length > 0 && (
            <Bucket title={`Już zaimportowane (${alreadyImported.length})`} tone="muted">
              {alreadyImported.map((r) => (
                <RowLine key={r.key} r={r} onToggle={() => {}} disabled />
              ))}
            </Bucket>
          )}

          {excluded.length > 0 && (
            <Bucket title={`Koszty promocji (${excluded.length})`} tone="warn">
              {excluded.map((r) => (
                <label key={r.key} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={r.include}
                    onChange={(e) => onToggle(r.key, e.target.checked)}
                    className="h-4 w-4 rounded border-ink-300 text-brand-500 focus:ring-brand-400"
                  />
                  <span className="flex-1 truncate text-ink-800">{r.productName}</span>
                  <span className="text-ink-400">{r.dateTs ? dateShort(r.dateTs) : '—'}</span>
                  <span className="w-20 text-right font-medium tabular-nums text-amber-700">
                    {r.purchaseCost != null ? `−${money(r.purchaseCost)}` : '—'}
                  </span>
                </label>
              ))}
            </Bucket>
          )}
        </>
      )}
    </div>
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

function RowLine({
  r,
  onToggle,
  disabled,
}: {
  r: EditRow
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
        {r.productName || <em className="text-ink-400">bez nazwy</em>}
      </span>
      <span className="text-ink-400">{r.dateTs ? dateShort(r.dateTs) : '—'}</span>
      {r.purchaseCost != null && r.salePrice != null && (
        <span className="hidden w-32 text-right text-xs tabular-nums text-ink-400 sm:inline">
          koszt {money(r.purchaseCost)} · zysk{' '}
          <span className={r.salePrice - r.purchaseCost >= 0 ? 'text-emerald-600' : 'text-red-500'}>
            {money(r.salePrice - r.purchaseCost)}
          </span>
        </span>
      )}
      <span className="w-20 text-right font-medium tabular-nums">
        {r.salePrice != null ? money(r.salePrice) : '—'}
      </span>
    </label>
  )
}

function ReviewLine({ r, onChange }: { r: EditRow; onChange: (patch: Partial<EditRow>) => void }) {
  const valid = rowValid(r)
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
      <input
        type="checkbox"
        aria-label="Importuj ten wiersz"
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

- [ ] **Step 2: Type-check**

Run: `npm run typecheck`
Expected: exits 0. Every import above is used (`X` for the remove button, `Account` for `SourceSection`, `parseExpenseDrafts`/`saleImportKey`/`suggestAccountForSheet`/`looksLikeStockSheet` in the logic). If `noUnusedLocals` flags anything, remove that single import.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: `tsc -b` passes and `vite build` completes with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/ImportSalesModal.tsx
git commit -m "feat(import): multi-source sales import, one account per file/sheet

Each dropped file/sheet becomes a section with its own account dropdown
(auto-suggested by name); all import in one pass. The finessin all-items
file is detected and blocked from being imported as sales — the bug that
dumped both accounts onto one.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Settings — "Wyczyść zaimportowane dane" button

**Files:**
- Modify: `src/pages/Settings.tsx`

- [ ] **Step 1: Import the new DB ops and an icon**

In `src/pages/Settings.tsx`, change the `clearAllData, exportAll, importAll` import (currently line 30) to also pull the new functions:

```ts
import { clearAllData, clearImportedData, countImportedData, exportAll, importAll } from '@/db/db'
```

And add `Eraser` to the existing `lucide-react` import block (the one starting at line 2):

```ts
import {
  Cloud,
  Database,
  Download,
  Eraser,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
  Upload,
  Trash2,
  Wand2,
  Coins,
} from 'lucide-react'
```

- [ ] **Step 2: Add the handler**

In `SettingsPage`, add this just after the existing `wipe` function (around line 132):

```ts
  const clearImported = async () => {
    const c = await countImportedData()
    const total = c.sales + c.expenses + c.products
    if (total === 0) return toast.success('Brak danych z importu do usunięcia.')
    if (
      !window.confirm(
        `Usunąć ${c.sales} sprzedaży, ${c.expenses} kosztów i ${c.products} przedmiotów pochodzących z importu? ` +
          'Ręczne wpisy oraz produkty ze zdjęciami zostaną zachowane. Tej operacji nie można cofnąć.',
      )
    )
      return
    setBusy(true)
    try {
      const res = await clearImportedData()
      toast.success(
        `Usunięto z importu: ${res.sales} sprzedaży, ${res.expenses} kosztów, ${res.products} przedmiotów.`,
      )
    } finally {
      setBusy(false)
    }
  }
```

- [ ] **Step 3: Add the button to the backup card**

In the "Kopia zapasowa danych" card, inside the `<div className="flex flex-wrap gap-2">` (currently lines 365-386), add this button immediately **before** the existing `variant="danger"` "Wyczyść dane" button:

```tsx
          <Button variant="ghost" onClick={clearImported} disabled={busy}>
            <Eraser size={16} /> Wyczyść zaimportowane
          </Button>
```

- [ ] **Step 4: Type-check + build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Settings.tsx
git commit -m "feat(settings): 'Wyczyść zaimportowane dane' (clear only imported rows)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Full verification + manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: PASS — all existing suites plus the new `salesImport` helper tests and `clearImportedData` tests are green.

- [ ] **Step 2: Type-check + production build**

Run: `npm run build`
Expected: `tsc -b` passes and `vite build` completes with no errors.

- [ ] **Step 3: Manual smoke test in the browser**

Run: `npm run dev`, open the app.

1. **Settings → "Wyczyść zaimportowane dane"** — confirm. Toast reports the removed counts. Go to **Konta**: both accounts now show 0 zł / 0 in stock. Any Studio products (with photos) remain in **Magazyn**.
2. **Sprzedaż → Import** — drop **File 1 + File 2** together. Verify:
   - Two sections appear, one per file, each with an account dropdown **pre-filled** by name (Main→pangea, Zoos→zoos07); fix if needed.
   - Each section shows its ready / do sprawdzenia / koszty promocji buckets; inline date/price edits still work.
   - Click **Zaimportuj N** → one toast with totals. **Konta** now shows sales split across both accounts.
3. **Drop File 3** (`finessin`) into the **Sprzedaż** import — verify it shows the amber "import in Magazyn" banner and contributes **0** to the import count (cannot be imported as sales).
4. **Magazyn → Import** — drop **File 3**. Unsold items auto-match to the correct account (because sales are now correct); ambiguous ones land in the review bucket. Import. **Konta** stock counts now split correctly.
5. **Re-run the Sprzedaż import of File 1 + File 2** → toast reports "Pominięto duplikaty" and no rows are doubled (idempotency holds per account).

- [ ] **Step 4: Commit any fixes**

If the smoke test surfaced issues, fix them, re-run `npm test` and `npm run build`, then:

```bash
git add -A
git commit -m "fix: address sales-import smoke test findings

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review notes

- **Spec coverage:** Unit A `clearImportedData`/`countImportedData` (Task 2) · Unit B `suggestAccountForSheet`/`looksLikeStockSheet` (Task 1) · Unit C multi-source modal with per-source account, full buckets, finessin guardrail, per-source sequential import + combined toast, unassigned guard (Task 3) · Unit D Settings button with pre-count confirm (Task 4) · stock importer unchanged, no schema bump (by omission) · testing of both pure helpers and the clear op (Tasks 1–2) · manual smoke covering repair + re-import + guardrail (Task 5).
- **Type consistency:** `Source`/`EditRow`/`Computed` defined once in Task 3 and used consistently; `clearImportedData`/`countImportedData` return `{ sales; expenses; products }` in Task 2 and consumed with those exact keys in Task 4; `suggestAccountForSheet(name, accounts)` / `looksLikeStockSheet(header)` signatures match between Task 1 definition and Task 3 call-sites.
- **No placeholders:** every code/step block is complete; commands have expected output.
- **Deviation:** none from the spec.
