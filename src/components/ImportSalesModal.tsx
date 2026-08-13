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
  SALES_FIELDS,
  type ParsedRow,
  type DraftSale,
  type DraftExpense,
} from '@/lib/salesImport'
import type { ColumnMap } from '@/lib/columnMap'
import { ColumnMapper } from '@/components/ColumnMapper'
import { readWorkbook, isSpreadsheet } from '@/lib/spreadsheet'
import { uid } from '@/lib/id'
import { ACCOUNT_COLORS } from '@/lib/constants'
import { dateFromInput, dateInputValue, dateShort, money } from '@/lib/format'
import type { Account } from '@/db/types'
import { toast } from '@/state/toast'
import { FileDrop } from '@/components/FileDrop'
import { Button, Field, Modal, NumberInput, Select, TextInput } from '@/components/ui'

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
  /** Surowa tabela — potrzebna, by przeparsować arkusz po zmianie przypisania kolumn. */
  table: string[][]
  /** Użyte przypisanie kolumn + czy wyszło z rozpoznanych nagłówków. */
  columns: ColumnMap
  headerDetected: boolean
  hasHeaderRow: boolean
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

  /** Buduje źródło z surowej tabeli — wspólne dla wczytania pliku i zmiany przypisania kolumn. */
  const buildSource = (
    id: string,
    fileName: string,
    sheetName: string,
    table: string[][],
    accountId: string,
    override?: ColumnMap,
  ): Source => {
    const parsed = parseSalesTable(table, override)
    const isStock = looksLikeStockSheet(table[0] ?? [])
    return {
      id,
      fileName,
      sheetName,
      table,
      columns: parsed.columns,
      headerDetected: parsed.headerDetected,
      hasHeaderRow: parsed.hasHeaderRow,
      isStock,
      accountId,
      rows: parsed.rows.map((r) => ({
        ...r,
        key: `${id}#${r.rowIndex}`,
        // Stock-plik nic nie zaznacza; reszta: gotowe sprzedaże + koszty promocji.
        include: !isStock && (r.bucket === 'ready' || r.bucket === 'excluded'),
      })),
    }
  }

  const onFiles = async (files: File[]) => {
    const next: Source[] = []
    for (const f of files) {
      try {
        const wb = await readWorkbook(f)
        for (const sheetName of wb.sheetNames) {
          const table = wb.tableOf(sheetName)
          // Arkusz z danymi zostaje NAWET gdy nic z niego nie sparsowaliśmy — inaczej zły
          // odczyt kolumn kończył się komunikatem „nie znaleziono wierszy" bez drogi wyjścia.
          // Dopiero pusty arkusz pomijamy.
          if (table.length < 2) continue
          const id = `${f.name}::${sheetName}`
          const accountId = looksLikeStockSheet(table[0] ?? [])
            ? ''
            : suggestAccountForSheet(`${f.name} ${sheetName}`, accounts ?? []) ?? ''
          next.push(buildSource(id, f.name, sheetName, table, accountId))
        }
      } catch (e) {
        toast.error(`${f.name}: ${e instanceof Error ? e.message : 'Nie udało się odczytać pliku.'}`)
      }
    }
    if (!next.length) {
      toast.error('Nie znaleziono wierszy sprzedaży w wybranych plikach.')
      return
    }
    if (next.every((s) => !s.rows.length))
      toast.error('Nie odczytaliśmy wierszy — sprawdź przypisanie kolumn przy pliku.')
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

  // Ręczna zmiana przypisania kolumn: te same dane, inne znaczenie kolumn → wiersze
  // powstają od nowa (poprzednie zaznaczenia dotyczyły innego odczytu tego arkusza).
  const setSourceColumns = (sourceId: string, columns: ColumnMap) =>
    setSources((ss) =>
      ss.map((s) =>
        s.id !== sourceId
          ? s
          : buildSource(s.id, s.fileName, s.sheetName, s.table, s.accountId, columns),
      ),
    )

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
            Kolumny mogą być w dowolnej kolejności, po polsku lub angielsku (rozdzielone
            przecinkiem, średnikiem lub tabulatorem) — jeśli nie zgadniemy, wskażesz je sam.
            Każdy plik/arkusz przypiszesz do konta poniżej.
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
            onColumns={(columns) => setSourceColumns(c.source.id, columns)}
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
  onColumns,
}: {
  c: Computed
  accounts: Account[]
  onAccount: (accountId: string) => void
  onRemove: () => void
  onToggle: (key: string, include: boolean) => void
  onReview: (key: string, patch: Partial<EditRow>) => void
  onColumns: (columns: ColumnMap) => void
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

          <ColumnMapper
            header={s.hasHeaderRow ? (s.table[0] ?? []) : []}
            sampleRows={s.table.slice(s.hasHeaderRow ? 1 : 0, 4)}
            fields={SALES_FIELDS}
            requiredFields={['name', 'sale']}
            value={s.columns}
            onChange={onColumns}
            headerDetected={s.headerDetected}
          />

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
                  <span className="w-20 text-right font-medium tabular-nums text-amber-700 dark:text-amber-400">
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
      <NumberInput
        className="w-24"
        placeholder="cena"
        value={r.salePrice}
        onValueChange={(n) => onChange({ salePrice: n })}
      />
      <span className="w-full text-xs text-amber-600 sm:w-auto">{r.issues.join('; ')}</span>
    </div>
  )
}
