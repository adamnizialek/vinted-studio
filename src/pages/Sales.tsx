import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { startOfMonth, startOfYear } from 'date-fns'
import { ChevronDown, Download, Loader2, Pencil, Plus, Trash2, Upload, Wallet } from 'lucide-react'
import clsx from 'clsx'
import { db, deleteEntity, putEntity } from '@/db/db'
import type { Expense, Sale, SaleStatus } from '@/db/types'
import { uid } from '@/lib/id'
import { useSettings } from '@/state/settings'
import { toast } from '@/state/toast'
import { EXPENSE_KIND_LABELS, SALE_STATUS_LABELS } from '@/lib/constants'
import { aggregateProfit, dateFromInput, dateInputValue, dateShort, money, percent, profitOf } from '@/lib/format'
import { restockOnRefund, shouldRestockOnSave } from '@/lib/productActions'
import { toCsv, downloadText } from '@/lib/csv'
import { addImageFromFile, getImageBlob } from '@/lib/images'
import { useLocalStorageState } from '@/lib/hooks'
import { PromotionScreenshotField, type PromotionReadResult } from '@/components/PromotionScreenshotField'
import { normalizeDuration, PROMO_DURATIONS, type PromotionFlags } from '@/lib/promotionScreenshot'
import { Button, EmptyState, Field, Modal, NumberInput, Select, StatCard, TextArea, TextInput, SectionTitle } from '@/components/ui'
import { ImportSalesModal } from '@/components/ImportSalesModal'

type Period = 'all' | 'month' | 'year'

export function Sales() {
  const settings = useSettings((s) => s.settings)
  const sales = useLiveQuery(() => db.sales.orderBy('soldAt').reverse().toArray(), [])
  const expenses = useLiveQuery(() => db.expenses.orderBy('incurredAt').reverse().toArray(), [])
  const accounts = useLiveQuery(() => db.accounts.toArray(), [])

  const [view, setView] = useState<string>('all') // 'all' = wspólna, lub accountId
  const [period, setPeriod] = useState<Period>('all')
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Sale | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [expOpen, setExpOpen] = useState(false)
  const [editingExp, setEditingExp] = useState<Expense | null>(null)
  const [expIsNew, setExpIsNew] = useState(false) // nowy wpis → pokaż wczytywanie ze zrzutu
  // Zwinięcie tabeli sprzedaży — domyślnie zwinięta, by od razu mieć dostęp do kosztów
  // bez przewijania całej listy. Wybór użytkownika jest pamiętany per urządzenie.
  const [salesCollapsed, setSalesCollapsed] = useLocalStorageState('vinted-studio-sales-collapsed', true)

  const filtered = useMemo(() => {
    let list = sales ?? []
    if (view !== 'all') list = list.filter((s) => s.accountId === view)
    if (period !== 'all') {
      const from = period === 'month' ? startOfMonth(new Date()) : startOfYear(new Date())
      list = list.filter((s) => s.soldAt >= from.getTime())
    }
    return list
  }, [sales, view, period])

  // Koszty promocji w tym samym widoku (konto + okres) — wg daty poniesienia.
  const filteredExpenses = useMemo(() => {
    let list = expenses ?? []
    if (view !== 'all') list = list.filter((e) => e.accountId === view)
    if (period !== 'all') {
      const from = period === 'month' ? startOfMonth(new Date()) : startOfYear(new Date())
      list = list.filter((e) => e.incurredAt >= from.getTime())
    }
    return list
  }, [expenses, view, period])

  const stats = useMemo(
    () => aggregateProfit(filtered, filteredExpenses),
    [filtered, filteredExpenses],
  )
  const accName = (id?: string) => accounts?.find((a) => a.id === id)?.name ?? '—'
  const currency = settings?.currency ?? 'PLN'

  const startNew = () => {
    setEditing({
      id: uid(),
      productName: '',
      accountId: view !== 'all' ? view : settings?.defaultAccountId,
      salePrice: 0,
      currency,
      quantity: 1,
      status: 'completed',
      soldAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    setOpen(true)
  }

  const remove = async (id: string) => {
    if (!window.confirm('Usunąć ten wpis sprzedaży?')) return
    await deleteEntity('sales', id)
    toast.success('Usunięto wpis.')
  }

  const startNewExpense = () => {
    setEditingExp({
      id: uid(),
      accountId: view !== 'all' ? view : settings?.defaultAccountId,
      kind: 'boost',
      description: 'Podbicie',
      amount: 0,
      currency,
      incurredAt: Date.now(),
      source: 'manual',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    setExpIsNew(true)
    setExpOpen(true)
  }

  const removeExpense = async (id: string) => {
    if (!window.confirm('Usunąć ten koszt?')) return
    await deleteEntity('expenses', id)
    toast.success('Usunięto koszt.')
  }

  const exportCsv = () => {
    const rows = filtered.map((s) => {
      const p = profitOf(s)
      return {
        Data: dateShort(s.soldAt),
        Produkt: s.productName,
        Marka: s.brand ?? '',
        Konto: accName(s.accountId),
        'Cena jedn.': s.salePrice,
        Ilość: s.quantity,
        'Koszt zakupu jedn.': s.purchaseCost ?? 0,
        Wysyłka: s.shippingCost ?? 0,
        Prowizja: s.platformFee ?? 0,
        Inne: s.otherCosts ?? 0,
        Przychód: p.revenue,
        Zysk: p.profit,
        Status: SALE_STATUS_LABELS[s.status],
        Kupujący: s.buyer ?? '',
        Notatki: s.notes ?? '',
      }
    })
    const label = view === 'all' ? 'wspolna' : accName(view)
    downloadText(`sprzedaz-${label}-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows))
    toast.success('Wyeksportowano CSV.')
  }

  return (
    <div>
      <SectionTitle
        title="Ewidencja sprzedaży"
        subtitle="Przełączaj między ewidencją wspólną a poszczególnymi kontami."
        right={
          <div className="flex flex-wrap gap-2">
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
      />

      {/* Przełącznik widoku konta */}
      <div className="mb-4 flex flex-wrap gap-2">
        <ViewChip active={view === 'all'} onClick={() => setView('all')} label="Wspólna" />
        {accounts?.map((a) => (
          <ViewChip
            key={a.id}
            active={view === a.id}
            onClick={() => setView(a.id)}
            label={a.name}
            color={a.color}
          />
        ))}
        <Select value={period} onChange={(e) => setPeriod(e.target.value as Period)} className="ml-auto w-40">
          <option value="all">Cały okres</option>
          <option value="month">Ten miesiąc</option>
          <option value="year">Ten rok</option>
        </Select>
      </div>

      {/* Statystyki */}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Przychód" value={money(stats.revenue, currency)} tone="brand" />
        <StatCard label="Koszty" value={money(stats.costs, currency)} />
        <StatCard label="Zysk" value={money(stats.profit, currency)} tone="good" />
        <StatCard label="Marża" value={percent(stats.margin)} sub={`${filtered.length} transakcji`} />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Wallet size={40} />}
          title="Brak sprzedaży w tym widoku"
          description="Oznacz produkt jako sprzedany w magazynie albo dodaj wpis ręcznie."
          action={
            <Button onClick={startNew}>
              <Plus size={16} /> Dodaj sprzedaż
            </Button>
          }
        />
      ) : (
        <div className="card overflow-hidden">
          <button
            type="button"
            onClick={() => setSalesCollapsed((v) => !v)}
            aria-expanded={!salesCollapsed}
            aria-controls="sales-table-panel"
            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-ink-50/50"
          >
            <span className="flex items-center gap-2 text-sm font-semibold text-ink-800">
              <ChevronDown
                size={16}
                className={clsx('text-ink-400 transition-transform', salesCollapsed && '-rotate-90')}
              />
              Sprzedaże
              <span className="rounded-full bg-ink-100 px-2 py-0.5 text-xs font-medium tabular-nums text-ink-500">
                {filtered.length}
              </span>
            </span>
            <span className="text-xs font-medium text-ink-400">{salesCollapsed ? 'Pokaż' : 'Ukryj'}</span>
          </button>
          <div
            id="sales-table-panel"
            hidden={salesCollapsed}
            className="overflow-x-auto border-t border-ink-100"
          >
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-400">
                  <th className="px-4 py-3 font-semibold">Data</th>
                  <th className="px-4 py-3 font-semibold">Produkt</th>
                  <th className="px-4 py-3 font-semibold">Konto</th>
                  <th className="px-4 py-3 text-right font-semibold">Cena</th>
                  <th className="px-4 py-3 text-right font-semibold">Zysk</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => {
                  const p = profitOf(s)
                  return (
                    <tr key={s.id} className="border-b border-ink-50 last:border-0 hover:bg-ink-50/50">
                      <td className="whitespace-nowrap px-4 py-3 text-ink-500">{dateShort(s.soldAt)}</td>
                      <td className="px-4 py-3">
                        <p className="font-medium text-ink-900">{s.productName}</p>
                        {s.brand && <p className="text-xs text-ink-400">{s.brand}</p>}
                      </td>
                      <td className="px-4 py-3 text-ink-500">{accName(s.accountId)}</td>
                      <td className="px-4 py-3 text-right font-medium tabular-nums">{money(s.salePrice, s.currency)}</td>
                      <td className={clsx('px-4 py-3 text-right font-semibold tabular-nums', p.profit >= 0 ? 'text-emerald-600' : 'text-red-500')}>
                        {money(p.profit, s.currency)}
                      </td>
                      <td className="px-4 py-3">
                        <span className="chip">{SALE_STATUS_LABELS[s.status]}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <button onClick={() => { setEditing(s); setOpen(true) }} className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700">
                            <Pencil size={14} />
                          </button>
                          <button onClick={() => remove(s.id)} className="rounded-lg p-1.5 text-ink-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mt-8">
        <SectionTitle
          title="Koszty promocji"
          subtitle="Podbicia i ekspozycje — pomniejszają zysk netto."
          right={
            <Button variant="ghost" onClick={startNewExpense}>
              <Plus size={16} /> Dodaj koszt
            </Button>
          }
        />
        {filteredExpenses.length === 0 ? (
          <p className="card px-4 py-6 text-center text-sm text-ink-400">
            Brak kosztów w tym widoku. Zaimportuj arkusz lub dodaj ręcznie.
          </p>
        ) : (
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {filteredExpenses.map((e) => (
                    <tr key={e.id} className="border-b border-ink-50 last:border-0 hover:bg-ink-50/50">
                      <td className="whitespace-nowrap px-4 py-2.5 text-ink-500">{dateShort(e.incurredAt)}</td>
                      <td className="px-4 py-2.5">
                        <span className="font-medium text-ink-900">{e.description}</span>
                        <span className="ml-2 chip">{EXPENSE_KIND_LABELS[e.kind]}</span>
                      </td>
                      <td className="px-4 py-2.5 text-ink-500">{accName(e.accountId)}</td>
                      <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-amber-700 dark:text-amber-400">
                        −{money(e.amount, e.currency)}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex justify-end gap-1">
                          <button onClick={() => { setEditingExp(e); setExpIsNew(false); setExpOpen(true) }} className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700">
                            <Pencil size={14} />
                          </button>
                          <button onClick={() => removeExpense(e.id)} className="rounded-lg p-1.5 text-ink-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <SaleModal open={open} onClose={() => setOpen(false)} sale={editing} accounts={accounts ?? []} />
      <ExpenseModal open={expOpen} onClose={() => setExpOpen(false)} expense={editingExp} accounts={accounts ?? []} allowScreenshot={expIsNew} />
      <ImportSalesModal open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  )
}

function ViewChip({
  active,
  onClick,
  label,
  color,
}: {
  active: boolean
  onClick: () => void
  label: string
  color?: string
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-semibold transition',
        active ? 'bg-ink-900 text-ink-50' : 'bg-surface text-ink-600 ring-1 ring-ink-200 hover:bg-ink-50',
      )}
    >
      {color && <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />}
      {label}
    </button>
  )
}

function SaleModal({
  open,
  onClose,
  sale,
  accounts,
}: {
  open: boolean
  onClose: () => void
  sale: Sale | null
  accounts: { id: string; name: string }[]
}) {
  const [form, setForm] = useState<Sale | null>(sale)
  useEffect(() => setForm(sale), [sale])
  if (!form) return null

  const set = <K extends keyof Sale>(k: K, v: Sale[K]) => setForm({ ...form, [k]: v })

  const save = async () => {
    if (!form.productName.trim()) return toast.error('Podaj nazwę produktu.')
    if (!form.salePrice || form.salePrice <= 0) return toast.error('Podaj cenę sprzedaży.')
    await putEntity('sales', form)
    let restocked = false
    if (sale && shouldRestockOnSave(sale.status, form.status, !!form.productId)) {
      restocked = await restockOnRefund(form.productId!) // helper gwarantuje productId
    }
    onClose()
    toast.success(
      restocked ? 'Zwrot zapisany — przedmiot wrócił do magazynu 📦' : 'Zapisano sprzedaż.',
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Wpis sprzedaży"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Anuluj</Button>
          <Button onClick={save}>Zapisz</Button>
        </div>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Produkt" className="sm:col-span-2">
          <TextInput value={form.productName} onChange={(e) => set('productName', e.target.value)} autoFocus />
        </Field>
        <Field label="Marka">
          <TextInput value={form.brand ?? ''} onChange={(e) => set('brand', e.target.value)} />
        </Field>
        <Field label="Konto">
          <Select value={form.accountId ?? ''} onChange={(e) => set('accountId', e.target.value || undefined)}>
            <option value="">— brak —</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </Select>
        </Field>
        <Field label={`Cena sprzedaży (${form.currency})`}>
          <NumberInput value={form.salePrice} onValueChange={(n) => set('salePrice', n ?? 0)} />
        </Field>
        <Field label="Ilość">
          <NumberInput integer value={form.quantity} onValueChange={(n) => set('quantity', Math.max(1, n ?? 1))} />
        </Field>
        <Field label="Koszt zakupu">
          <NumberInput value={form.purchaseCost} onValueChange={(n) => set('purchaseCost', n)} />
        </Field>
        <Field label="Koszt wysyłki (Twój)">
          <NumberInput value={form.shippingCost} onValueChange={(n) => set('shippingCost', n)} />
        </Field>
        <Field label="Prowizja / opłaty">
          <NumberInput value={form.platformFee} onValueChange={(n) => set('platformFee', n)} />
        </Field>
        <Field label="Inne koszty">
          <NumberInput value={form.otherCosts} onValueChange={(n) => set('otherCosts', n)} />
        </Field>
        <Field label="Data sprzedaży">
          <TextInput
            type="date"
            value={dateInputValue(form.soldAt)}
            onChange={(e) => set('soldAt', dateFromInput(e.target.value, form.soldAt))}
          />
        </Field>
        {/* Podpowiedź optymistyczna: sam restock i tak strzeże warunku 'sold'
            w restockOnRefund, więc dla ręcznie przeniesionego przedmiotu efekt
            może nie nastąpić mimo podpowiedzi (rzadki przypadek). */}
        <Field
          label="Status"
          hint={
            form.status === 'returned' && form.productId && sale?.status !== 'returned'
              ? 'Po zapisaniu przedmiot wróci do magazynu.'
              : undefined
          }
        >
          <Select value={form.status} onChange={(e) => set('status', e.target.value as SaleStatus)}>
            {Object.entries(SALE_STATUS_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </Select>
        </Field>
        <Field label="Kupujący">
          <TextInput value={form.buyer ?? ''} onChange={(e) => set('buyer', e.target.value)} />
        </Field>
        <Field label="Notatki" className="sm:col-span-2">
          <TextArea rows={2} value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

/** Etykiety flag „sprawdź odczyt" (kolejność = priorytet wyświetlania). */
const PROMO_FLAG_LABELS: Record<keyof PromotionFlags, string> = {
  unknownType: 'nie rozpoznano rodzaju — wybierz ręcznie',
  noAmount: 'nie odczytano kwoty — wpisz ręcznie',
  labelAmountMismatch: 'sprawdź rodzaj i kwotę',
  amountOutOfRange: 'kwota nietypowa',
  nonPln: 'waluta inna niż zł — sprawdź kwotę',
  durationOdd: 'nietypowy czas trwania — pominięto',
  lowConfidence: 'niepewny odczyt',
}

function ExpenseModal({
  open,
  onClose,
  expense,
  accounts,
  allowScreenshot,
}: {
  open: boolean
  onClose: () => void
  expense: Expense | null
  accounts: { id: string; name: string }[]
  allowScreenshot: boolean
}) {
  const [form, setForm] = useState<Expense | null>(expense)
  const [shotFile, setShotFile] = useState<File | null>(null) // zrzut do zapisania przy zapisie kosztu
  const [shotUrl, setShotUrl] = useState<string | null>(null) // podgląd (obiekt URL)
  const [flags, setFlags] = useState<PromotionFlags | null>(null)
  const [busy, setBusy] = useState(false)
  const urlRef = useRef<string | null>(null)

  // Ustawia podgląd zwalniając poprzedni obiekt URL (zapobiega wyciekom pamięci).
  const setPreview = (url: string | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = url
    setShotUrl(url)
  }

  // Reset stanu pomocniczego, gdy zmienia się edytowany koszt.
  useEffect(() => {
    setForm(expense)
    setShotFile(null)
    setFlags(null)
    setPreview(null)
  }, [expense])

  // Podgląd wcześniej zapisanego zrzutu (tryb edycji) — leniwie z IndexedDB/R2.
  // Zależność od `open` sprawia, że zamknięcie przed rozwiązaniem (wolne R2) unieważnia
  // odczyt (cleanup → alive=false), więc nie tworzymy obiektu URL do zamkniętego modala.
  useEffect(() => {
    let alive = true
    if (open && expense?.screenshotImageId) {
      getImageBlob(expense.screenshotImageId).then((b) => {
        if (alive && b && !urlRef.current) setPreview(URL.createObjectURL(b))
      })
    }
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, expense?.screenshotImageId])

  // Zwolnij obiekt URL podglądu przy odmontowaniu.
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    },
    [],
  )

  // Zwolnij podgląd po zamknięciu modala — Modal odmontowuje dzieci, ale ten komponent trwa
  // (renderowany bezwarunkowo na stronie), więc sprzątanie na unmount tu nie wystarcza.
  useEffect(() => {
    if (!open) setPreview(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!form) return null
  const set = <K extends keyof Expense>(k: K, v: Expense[K]) => setForm({ ...form, [k]: v })

  // Wynik odczytu ze zrzutu → wstrzyknij do formularza (człowiek sprawdza i zapisuje).
  const onRead = ({ draft, flags: f, file }: PromotionReadResult) => {
    setForm((prev) => {
      if (!prev) return prev
      // Nie nadpisuj opisu wpisanego ręcznie — etykietą rodzaju zastępujemy tylko pusty/domyślny.
      const keepDescription = prev.description.trim() && !Object.values(EXPENSE_KIND_LABELS).includes(prev.description)
      return {
        ...prev,
        kind: draft.kind,
        amount: draft.amount ?? prev.amount,
        // Pokaż dokładnie to, co zostanie zapisane (flaga durationOdd osobno ostrzega o nietypowym odczycie).
        durationDays: normalizeDuration(draft.kind, draft.durationDays),
        currency: 'PLN', // Vinted PL rozlicza w zł; obca waluta → flaga nonPln do sprawdzenia
        description: keepDescription ? prev.description : EXPENSE_KIND_LABELS[draft.kind],
        source: 'screenshot',
        ocrConfidence: draft.confidence,
        screenshotImageId: undefined, // obraz zapiszemy dopiero przy zapisie kosztu
      }
    })
    setShotFile(file)
    setPreview(URL.createObjectURL(file))
    setFlags(f)
    toast.success(f.unknownType || f.noAmount ? 'Nie rozpoznano w pełni — uzupełnij ręcznie.' : 'Odczytano. Sprawdź dane przed zapisem.')
  }

  const save = async () => {
    if (!form.description.trim()) return toast.error('Podaj opis kosztu.')
    if (!form.amount || form.amount <= 0) return toast.error('Podaj kwotę.')
    setBusy(true)
    try {
      // Egzekwuj regułę czasu trwania w jednym miejscu (np. po ręcznej zmianie rodzaju na „Inne").
      let toSave: Expense = { ...form, durationDays: normalizeDuration(form.kind, form.durationDays) }
      // Zrzut zapisujemy jako obraz-dowód dopiero teraz — przy anulowaniu nie zostaje sierota.
      if (shotFile && !toSave.screenshotImageId) {
        try {
          const img = await addImageFromFile(shotFile, 'reference')
          toSave = { ...toSave, screenshotImageId: img.id }
        } catch {
          // Obraz to tylko dowód — gdy zapis się nie uda, i tak zapisujemy sam koszt.
        }
      }
      await putEntity('expenses', toSave)
      onClose()
      toast.success('Zapisano koszt.')
    } finally {
      setBusy(false)
    }
  }

  // Podczas zapisu (addImageFromFile/putEntity nie są przerywalne) blokujemy zamknięcie,
  // żeby „Anuluj"/Esc/tło nie sugerowały anulowania, które i tak dokończy zapis w tle.
  const requestClose = () => {
    if (!busy) onClose()
  }

  const activeFlags = flags ? (Object.keys(PROMO_FLAG_LABELS) as (keyof PromotionFlags)[]).filter((k) => flags[k]) : []

  return (
    <Modal
      open={open}
      onClose={requestClose}
      size="lg"
      title="Koszt promocji"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={requestClose} disabled={busy}>Anuluj</Button>
          <Button onClick={save} disabled={busy}>
            {busy ? <Loader2 size={16} className="animate-spin-slow" /> : 'Zapisz'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {allowScreenshot && <PromotionScreenshotField onResult={onRead} disabled={busy} />}

        {shotUrl && (
          <div className="flex gap-3 rounded-xl bg-ink-50 p-3 ring-1 ring-ink-100 dark:bg-ink-900/40 dark:ring-ink-800">
            <img src={shotUrl} alt="Zrzut ekranu" className="h-20 w-20 shrink-0 rounded-lg object-cover ring-1 ring-ink-100" />
            <div className="min-w-0 space-y-1.5">
              <p className="text-xs text-ink-500">{flags ? 'Sprawdź odczyt przed zapisem.' : 'Zrzut ekranu (dowód).'}</p>
              {activeFlags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {activeFlags.map((k) => (
                    <span
                      key={k}
                      className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                    >
                      {PROMO_FLAG_LABELS[k]}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Opis" className="sm:col-span-2">
            <TextInput value={form.description} onChange={(e) => set('description', e.target.value)} autoFocus />
          </Field>
          <Field label="Rodzaj">
            <Select value={form.kind} onChange={(e) => set('kind', e.target.value as Expense['kind'])}>
              {Object.entries(EXPENSE_KIND_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </Select>
          </Field>
          <Field label={`Kwota (${form.currency})`}>
            <NumberInput value={form.amount} onValueChange={(n) => set('amount', n ?? 0)} />
          </Field>
          {form.kind !== 'other' && (
            <Field label="Czas trwania">
              <Select
                value={form.durationDays ?? ''}
                onChange={(e) => set('durationDays', e.target.value ? Number(e.target.value) : undefined)}
              >
                <option value="">— nie podano —</option>
                {PROMO_DURATIONS.map((d) => (
                  <option key={d} value={d}>{d} dni</option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Konto">
            <Select value={form.accountId ?? ''} onChange={(e) => set('accountId', e.target.value || undefined)}>
              <option value="">— brak —</option>
              {accounts.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
            </Select>
          </Field>
          <Field label="Data">
            <TextInput type="date" value={dateInputValue(form.incurredAt)} onChange={(e) => set('incurredAt', dateFromInput(e.target.value, form.incurredAt))} />
          </Field>
          <Field label="Notatki" className="sm:col-span-2">
            <TextArea rows={2} value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  )
}
