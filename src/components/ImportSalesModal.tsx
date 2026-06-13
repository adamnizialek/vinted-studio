import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import clsx from 'clsx'
import { FileUp, Loader2, Plus } from 'lucide-react'
import { db, importSales, importExpenses, putEntity } from '@/db/db'
import {
  parseSalesTable,
  parseExpenseDrafts,
  saleImportKey,
  type ParsedRow,
  type DraftSale,
  type DraftExpense,
} from '@/lib/salesImport'
import { readWorkbook, isSpreadsheet, type Workbook } from '@/lib/spreadsheet'
import { uid } from '@/lib/id'
import { ACCOUNT_COLORS } from '@/lib/constants'
import { dateFromInput, dateInputValue, dateShort, money } from '@/lib/format'
import { toast } from '@/state/toast'
import { FileDrop } from '@/components/FileDrop'
import { Button, Field, Modal, Select, TextInput } from '@/components/ui'

interface EditRow extends ParsedRow {
  /** Stabilny klucz Reacta: `${arkusz}#${rowIndex}` (arkusz = nazwa zakładki XLSX lub pliku CSV). */
  key: string
  include: boolean
}

const rowValid = (r: { salePrice?: number; dateTs: number | null }) =>
  r.salePrice != null && r.salePrice > 0 && r.dateTs != null

export function ImportSalesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const accounts = useLiveQuery(() => db.accounts.orderBy('createdAt').toArray(), [])
  const [accountId, setAccountId] = useState('')
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [rows, setRows] = useState<EditRow[]>([])
  const [busy, setBusy] = useState(false)
  // Wczytany skoroszyt (CSV → 1 arkusz; XLSX → wiele). `sheet` = aktualnie wybrany arkusz.
  const [workbook, setWorkbook] = useState<{ wb: Workbook; names: string[]; sheet: string } | null>(
    null,
  )

  // Klucze treści sprzedaży już zaimportowanych na wybranym koncie (multizbiór) —
  // wyłącznie do PODGLĄDU (ile wierszy już jest w bazie). Faktyczną deduplikację
  // robi importSales — tu nic nie odfiltrowujemy z importu.
  const existingCounts = useLiveQuery(async () => {
    if (!accountId) return new Map<string, number>()
    const sales = await db.sales.where('accountId').equals(accountId).toArray()
    const m = new Map<string, number>()
    for (const s of sales) if (s.importKey) m.set(s.importKey, (m.get(s.importKey) ?? 0) + 1)
    return m
  }, [accountId])

  // Zapamiętane edycje per arkusz — zmiana zakładki nie kasuje recenzji poprzedniej.
  const sheetCache = useRef<Map<string, EditRow[]>>(new Map())

  const reset = () => {
    setRows([])
    setNewName('')
    setCreating(false)
    setWorkbook(null)
    sheetCache.current.clear()
  }

  // Zamknięcie czyści wczytane wiersze (zachowuje wybrane konto na kolejny import).
  const close = () => {
    reset()
    onClose()
  }

  // Klasyfikuje wybrany arkusz sprzedaży i wstępnie zaznacza gotowe wiersze.
  const processSales = (table: string[][], sheet: string) => {
    const { rows: parsed } = parseSalesTable(table)
    const next: EditRow[] = parsed.map((r) => ({
      ...r,
      key: `${sheet}#${r.rowIndex}`,
      // Sprzedaże gotowe oraz koszty promocji (excluded/fee) domyślnie zaznaczone.
      include: r.bucket === 'ready' || r.bucket === 'excluded',
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
      sheetCache.current = new Map()
      setWorkbook({ wb, names: wb.sheetNames, sheet })
      processSales(wb.tableOf(sheet), sheet)
    } catch (e) {
      // Nieudany odczyt (np. uszkodzony XLSX) — wyczyść podgląd, by nie zaimportować starych danych.
      setWorkbook(null)
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
    else processSales(workbook.wb.tableOf(sheet), sheet)
  }

  const setRow = (key: string, patch: Partial<EditRow>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  // Edycja wiersza „do sprawdzenia": gdy stał się poprawny, automatycznie zaznacz do importu.
  const patchReviewRow = (key: string, patch: Partial<EditRow>) =>
    setRows((rs) =>
      rs.map((r) => {
        if (r.key !== key) return r
        const merged = { ...r, ...patch }
        const include = !rowValid(r) && rowValid(merged) ? true : merged.include
        return { ...merged, include }
      }),
    )

  // Wiersze, które trafią do importu (zaznaczone i poprawne). importSales sam zdeduplikuje.
  const includable = useMemo(() => rows.filter((r) => r.include && rowValid(r)), [rows])

  // Które z włączanych wierszy już istnieją na koncie (multizbiór) — TYLKO do podglądu/licznika.
  const dupKeys = useMemo(() => {
    const counts = new Map(existingCounts ?? [])
    const dup = new Set<string>()
    for (const r of includable) {
      const k = saleImportKey(accountId, r.dateTs as number, r.productName, r.salePrice as number, r.purchaseCost)
      const c = counts.get(k) ?? 0
      if (c > 0) {
        counts.set(k, c - 1)
        dup.add(r.key)
      }
    }
    return dup
  }, [includable, existingCounts, accountId])

  // Ile faktycznie zostanie dodanych (importSales pominie duplikaty).
  const newCount = includable.length - dupKeys.size

  // Do importu przekazujemy WSZYSTKIE włączane wiersze — importSales jest jedynym
  // miejscem deduplikacji (inaczej liczby istniejące odjęłyby się podwójnie).
  const drafts = useMemo<DraftSale[]>(
    () =>
      includable.map((r) => ({
        soldAt: r.dateTs as number,
        productName: r.productName,
        salePrice: r.salePrice as number,
        purchaseCost: r.purchaseCost,
        status: r.status,
      })),
    [includable],
  )

  // Wiersze opłat (bucket 'excluded'/'fee') → szkice kosztów promocji (tylko zaznaczone).
  const expenseDrafts = useMemo<DraftExpense[]>(
    () => parseExpenseDrafts(rows.filter((r) => r.include)),
    [rows],
  )
  // Koszty faktycznie importowalne (z datą) — do licznika w stopce.
  const expenseCount = useMemo(
    () => expenseDrafts.filter((d) => d.incurredAt !== null).length,
    [expenseDrafts],
  )

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
    setAccountId(id)
    setNewName('')
    setCreating(false)
    toast.success('Utworzono konto.')
  }

  const doImport = async () => {
    if (!accountId) return toast.error('Wybierz konto.')
    if (!drafts.length && !expenseDrafts.length) return toast.error('Brak wierszy do importu.')
    setBusy(true)
    try {
      const res = await importSales(drafts, accountId)
      const expRes = await importExpenses(expenseDrafts, accountId)
      toast.success(
        `Zaimportowano: ${res.inserted} sprzedaży, ${expRes.inserted} kosztów. ` +
          `Pominięto duplikaty: ${res.skippedDuplicates + expRes.skippedDuplicates}.`,
      )
      close()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Błąd importu.')
    } finally {
      setBusy(false)
    }
  }

  const ready = rows.filter((r) => r.bucket === 'ready' && !dupKeys.has(r.key))
  const alreadyImported = rows.filter((r) => r.bucket === 'ready' && dupKeys.has(r.key))
  const review = rows.filter((r) => r.bucket === 'review')
  const excluded = rows.filter((r) => r.bucket === 'excluded')

  return (
    <Modal
      open={open}
      onClose={close}
      size="xl"
      title="Import sprzedaży z CSV"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-ink-500">{newCount + expenseCount} do importu</span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={close}>
              Anuluj
            </Button>
            <Button
              onClick={doImport}
              disabled={busy || !accountId || newCount + expenseCount === 0}
            >
              {busy ? (
                <Loader2 size={16} className="animate-spin-slow" />
              ) : (
                <>Zaimportuj {newCount + expenseCount}</>
              )}
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

        <FileDrop
          onFiles={onFiles}
          accept=".csv,.xlsx,.xls,text/csv"
          filter={isSpreadsheet}
          multiple={false}
        >
          <FileUp className="text-brand-500" />
          <span className="text-sm font-semibold text-ink-700">
            Przeciągnij plik CSV lub XLSX (Arkusze: Plik → Pobierz) lub kliknij
          </span>
          <span className="text-xs text-ink-400">
            Jeden arkusz = jedno konto — importuj osobno dla Main, Zoos…
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
                  <ReviewLine key={r.key} r={r} onChange={(patch) => patchReviewRow(r.key, patch)} />
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
                      onChange={(e) => setRow(r.key, { include: e.target.checked })}
                      className="h-4 w-4 rounded border-ink-300 text-brand-500 focus:ring-brand-400"
                    />
                    <span className="flex-1 truncate text-ink-800">{r.productName}</span>
                    <span className="text-ink-400">{r.dateTs ? dateShort(r.dateTs) : '—'}</span>
                    <span className="w-20 text-right font-medium tabular-nums text-amber-700 dark:text-amber-400">
                      {r.purchaseCost != null ? `−${money(r.purchaseCost)}` : '—'}
                    </span>
                  </label>
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
