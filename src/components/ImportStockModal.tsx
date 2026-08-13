import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import clsx from 'clsx'
import { FileUp, Loader2 } from 'lucide-react'
import { db, importStock } from '@/db/db'
import {
  parseStockSheet,
  matchAccounts,
  stockImportKey,
  STOCK_FIELDS,
  type StockBucket,
  type ResolvedStockDraft,
} from '@/lib/stockImport'
import type { ColumnMap } from '@/lib/columnMap'
import { ColumnMapper } from '@/components/ColumnMapper'
import { readWorkbook, isSpreadsheet, type Workbook } from '@/lib/spreadsheet'
import type { Account } from '@/db/types'
import { money } from '@/lib/format'
import { toast } from '@/state/toast'
import { FileDrop } from '@/components/FileDrop'
import { Button, Field, Modal, Select } from '@/components/ui'

interface EditRow {
  /** Stabilny klucz Reacta: `${arkusz}#${rowIndex}` (arkusz = nazwa zakładki XLSX lub pliku CSV). */
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

// Domyślny arkusz dla magazynu: preferuj „all items" (finessin), w razie czego pierwszy.
const STOCK_SHEET_RE = /finessin|all|wszystk|magazyn|stan/i
const pickStockSheet = (names: string[]) => names.find((n) => STOCK_SHEET_RE.test(n)) ?? names[0]

export function ImportStockModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const accounts = useLiveQuery(() => db.accounts.orderBy('createdAt').toArray(), [])
  const sales = useLiveQuery(() => db.sales.toArray(), [])
  const [rows, setRows] = useState<EditRow[]>([])
  const [busy, setBusy] = useState(false)
  // Wczytany skoroszyt (CSV → 1 arkusz; XLSX → wiele). `sheet` = aktualnie wybrany arkusz.
  const [workbook, setWorkbook] = useState<{ wb: Workbook; names: string[]; sheet: string } | null>(
    null,
  )
  // Surowa tabela bieżącego arkusza + użyte przypisanie kolumn. Trzymamy tabelę, bo zmiana
  // przypisania w ColumnMapperze wymaga przeparsowania tych samych danych od nowa.
  const [sheetState, setSheetState] = useState<{
    table: string[][]
    columns: ColumnMap
    headerDetected: boolean
    hasHeaderRow: boolean
  } | null>(null)

  // Klucze treści przedmiotów już w magazynie (multizbiór) — TYLKO do podglądu licznika.
  // Faktyczną deduplikację robi importStock.
  const existingCounts = useLiveQuery(async () => {
    const products = await db.products.toArray()
    const m = new Map<string, number>()
    for (const p of products) if (p.importKey) m.set(p.importKey, (m.get(p.importKey) ?? 0) + 1)
    return m
  }, [])

  // Zapamiętane edycje per arkusz — zmiana zakładki nie kasuje recenzji poprzedniej.
  const sheetCache = useRef<Map<string, EditRow[]>>(new Map())

  const close = () => {
    setRows([])
    setWorkbook(null)
    setSheetState(null)
    sheetCache.current.clear()
    onClose()
  }

  // Klasyfikuje wybrany arkusz i auto-dopasowuje konta do niesprzedanych przedmiotów.
  // `override` = ręczne przypisanie kolumn z ColumnMappera (gdy automat się pomylił).
  const processStock = (table: string[][], sheet: string, override?: ColumnMap) => {
    const salesForMatch = (sales ?? []).map((s) => ({
      productName: s.productName,
      accountId: s.accountId,
    }))
    const sheetParse = parseStockSheet(table, override)
    setSheetState({
      table,
      columns: sheetParse.columns,
      headerDetected: sheetParse.headerDetected,
      hasHeaderRow: sheetParse.hasHeaderRow,
    })
    const parsed = sheetParse.rows
    const stock = parsed.filter((r) => r.bucket === 'stock')
    const matches = matchAccounts(stock, salesForMatch)
    const byRow = new Map(stock.map((r, i) => [r.rowIndex, matches[i]]))
    const next: EditRow[] = parsed.map((r) => {
      const m = byRow.get(r.rowIndex)
      return {
        key: `${sheet}#${r.rowIndex}`,
        rowIndex: r.rowIndex,
        bucket: r.bucket,
        name: r.name,
        purchaseCost: r.purchaseCost,
        salePrice: r.salePrice,
        issues: r.issues,
        // Niesprzedane przedmioty importujemy BEZ konta — przypisuje się je ręcznie w Magazynie,
        // gdy zostaną wystawione. `candidates` zostają tylko jako podpowiedź w opcjonalnym wyborze.
        accountId: undefined,
        candidates: m?.candidates ?? [],
        confidence: m?.confidence ?? 'none',
        // Domyślnie zaznaczamy WSZYSTKIE niesprzedane przedmioty (cały stan magazynu).
        include: r.bucket === 'stock',
      }
    })
    // Zero przedmiotów NIE kasuje podglądu — arkusz zostaje wczytany, a użytkownik może
    // poprawić przypisanie kolumn w ColumnMapperze. Wcześniej kończyło się to komunikatem
    // „nie znaleziono przedmiotów" bez żadnej drogi wyjścia.
    if (!next.some((r) => r.bucket === 'stock')) {
      toast.error('Nie znaleziono przedmiotów w tym arkuszu — sprawdź przypisanie kolumn poniżej.')
    }
    setRows(next)
  }

  const onFiles = async (files: File[]) => {
    try {
      const wb = await readWorkbook(files[0])
      const sheet = pickStockSheet(wb.sheetNames)
      sheetCache.current = new Map()
      setWorkbook({ wb, names: wb.sheetNames, sheet })
      processStock(wb.tableOf(sheet), sheet)
    } catch (e) {
      // Nieudany odczyt (np. uszkodzony XLSX) — wyczyść podgląd, by nie zaimportować starych danych.
      setWorkbook(null)
      setSheetState(null)
      setRows([])
      toast.error(e instanceof Error ? e.message : 'Nie udało się odczytać pliku.')
    }
  }

  // Zmiana arkusza (XLSX z wieloma arkuszami): zachowaj edycje bieżącego, przywróć lub przeparsuj docelowy.
  const onSheet = (sheet: string) => {
    if (!workbook || sheet === workbook.sheet) return
    sheetCache.current.set(workbook.sheet, rows)
    setWorkbook({ ...workbook, sheet })
    const cached = sheetCache.current.get(sheet)
    if (cached) setRows(cached)
    else processStock(workbook.wb.tableOf(sheet), sheet)
  }

  // Ręczna zmiana przypisania kolumn — te same dane, inne znaczenie kolumn. Wiersze
  // powstają od nowa (poprzednie zaznaczenia dotyczyły innego odczytu tego arkusza).
  const onColumns = (columns: ColumnMap) => {
    if (!workbook || !sheetState) return
    sheetCache.current.delete(workbook.sheet)
    processStock(sheetState.table, workbook.sheet, columns)
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

  // Przedmioty już w magazynie (multizbiór, w kolejności wierszy) — niezależnie od zaznaczenia,
  // żeby grupowanie „Już w magazynie" było stabilne. Faktyczną deduplikację robi importStock.
  const dupKeys = useMemo(() => {
    const counts = new Map(existingCounts ?? [])
    const dup = new Set<string>()
    for (const r of rows) {
      if (r.bucket !== 'stock') continue
      const k = stockImportKey(r.name, r.purchaseCost)
      const c = counts.get(k) ?? 0
      if (c > 0) {
        counts.set(k, c - 1)
        dup.add(r.key)
      }
    }
    return dup
  }, [rows, existingCounts])

  // Wiersze, które trafią do importu: niesprzedane, zaznaczone, jeszcze nie w magazynie.
  const includable = useMemo(
    () => rows.filter((r) => r.bucket === 'stock' && r.include && !dupKeys.has(r.key)),
    [rows, dupKeys],
  )

  const newCount = includable.length

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

  const toAdd = rows.filter((r) => r.bucket === 'stock' && !dupKeys.has(r.key))
  const alreadyIn = rows.filter((r) => r.bucket === 'stock' && dupKeys.has(r.key))
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
        <FileDrop
          onFiles={onFiles}
          accept=".csv,.xlsx,.xls,text/csv"
          filter={isSpreadsheet}
          multiple={false}
        >
          <FileUp className="text-brand-500" />
          <span className="text-sm font-semibold text-ink-700">
            Przeciągnij plik z listą przedmiotów — CSV lub XLSX — lub kliknij
          </span>
          <span className="text-xs text-ink-400">
            Kolumny mogą być w dowolnej kolejności, po polsku lub angielsku (rozdzielone
            przecinkiem, średnikiem lub tabulatorem). Jeśli nie zgadniemy — wskażesz je sam poniżej.
            Importują się tylko niesprzedane przedmioty, bez konta.
          </span>
        </FileDrop>

        {workbook && workbook.names.length > 1 && (
          <Field label="Arkusz do zaimportowania">
            <Select value={workbook.sheet} onChange={(e) => onSheet(e.target.value)}>
              {workbook.names.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {sheetState && (
          <ColumnMapper
            header={sheetState.hasHeaderRow ? (sheetState.table[0] ?? []) : []}
            sampleRows={sheetState.table.slice(sheetState.hasHeaderRow ? 1 : 0, 4)}
            fields={STOCK_FIELDS}
            requiredFields={['name']}
            value={sheetState.columns}
            onChange={onColumns}
            headerDetected={sheetState.headerDetected}
          />
        )}

        {rows.length > 0 && (
          <div className="space-y-4">
            <p className="rounded-xl bg-ink-50 px-4 py-3 text-xs text-ink-500 ring-1 ring-ink-100 dark:bg-ink-900/40 dark:text-ink-300 dark:ring-ink-800">
              Przedmioty importują się <strong>bez konta</strong>. Konto przypiszesz w Magazynie,
              gdy wystawisz dany przedmiot. Możesz też wybrać konto już teraz — opcjonalnie.
            </p>

            {toAdd.length > 0 && (
              <Bucket title={`Niesprzedane przedmioty (${toAdd.length})`} tone="good">
                {toAdd.map((r) => (
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
    </div>
  )
}
