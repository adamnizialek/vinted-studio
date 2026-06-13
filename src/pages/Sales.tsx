import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { startOfMonth, startOfYear } from 'date-fns'
import { Download, Pencil, Plus, Trash2, Upload, Wallet } from 'lucide-react'
import clsx from 'clsx'
import { db, deleteEntity, putEntity } from '@/db/db'
import type { Expense, Sale, SaleStatus } from '@/db/types'
import { uid } from '@/lib/id'
import { useSettings } from '@/state/settings'
import { toast } from '@/state/toast'
import { EXPENSE_KIND_LABELS, SALE_STATUS_LABELS } from '@/lib/constants'
import { aggregateProfit, dateFromInput, dateInputValue, dateShort, money, percent, profitOf } from '@/lib/format'
import { toCsv, downloadText } from '@/lib/csv'
import { Button, EmptyState, Field, Modal, Select, StatCard, TextArea, TextInput, SectionTitle } from '@/components/ui'
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
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
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
          <div className="overflow-x-auto">
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
                          <button onClick={() => remove(s.id)} className="rounded-lg p-1.5 text-ink-400 hover:bg-red-50 hover:text-red-600">
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
                      <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-amber-700">
                        −{money(e.amount, e.currency)}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex justify-end gap-1">
                          <button onClick={() => { setEditingExp(e); setExpOpen(true) }} className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700">
                            <Pencil size={14} />
                          </button>
                          <button onClick={() => removeExpense(e.id)} className="rounded-lg p-1.5 text-ink-400 hover:bg-red-50 hover:text-red-600">
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
      <ExpenseModal open={expOpen} onClose={() => setExpOpen(false)} expense={editingExp} accounts={accounts ?? []} />
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
        active ? 'bg-ink-900 text-white' : 'bg-white text-ink-600 ring-1 ring-ink-200 hover:bg-ink-50',
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

  const num = (v: string) => (v === '' ? undefined : Number(v))
  const set = <K extends keyof Sale>(k: K, v: Sale[K]) => setForm({ ...form, [k]: v })

  const save = async () => {
    if (!form.productName.trim()) return toast.error('Podaj nazwę produktu.')
    if (!form.salePrice || form.salePrice <= 0) return toast.error('Podaj cenę sprzedaży.')
    await putEntity('sales', form)
    onClose()
    toast.success('Zapisano sprzedaż.')
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
          <TextInput type="number" inputMode="decimal" value={form.salePrice || ''} onChange={(e) => set('salePrice', Number(e.target.value) || 0)} />
        </Field>
        <Field label="Ilość">
          <TextInput type="number" value={form.quantity} onChange={(e) => set('quantity', Math.max(1, Number(e.target.value) || 1))} />
        </Field>
        <Field label="Koszt zakupu">
          <TextInput type="number" inputMode="decimal" value={form.purchaseCost ?? ''} onChange={(e) => set('purchaseCost', num(e.target.value))} />
        </Field>
        <Field label="Koszt wysyłki (Twój)">
          <TextInput type="number" inputMode="decimal" value={form.shippingCost ?? ''} onChange={(e) => set('shippingCost', num(e.target.value))} />
        </Field>
        <Field label="Prowizja / opłaty">
          <TextInput type="number" inputMode="decimal" value={form.platformFee ?? ''} onChange={(e) => set('platformFee', num(e.target.value))} />
        </Field>
        <Field label="Inne koszty">
          <TextInput type="number" inputMode="decimal" value={form.otherCosts ?? ''} onChange={(e) => set('otherCosts', num(e.target.value))} />
        </Field>
        <Field label="Data sprzedaży">
          <TextInput
            type="date"
            value={dateInputValue(form.soldAt)}
            onChange={(e) => set('soldAt', dateFromInput(e.target.value, form.soldAt))}
          />
        </Field>
        <Field label="Status">
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

function ExpenseModal({
  open,
  onClose,
  expense,
  accounts,
}: {
  open: boolean
  onClose: () => void
  expense: Expense | null
  accounts: { id: string; name: string }[]
}) {
  const [form, setForm] = useState<Expense | null>(expense)
  useEffect(() => setForm(expense), [expense])
  if (!form) return null
  const set = <K extends keyof Expense>(k: K, v: Expense[K]) => setForm({ ...form, [k]: v })

  const save = async () => {
    if (!form.description.trim()) return toast.error('Podaj opis kosztu.')
    if (!form.amount || form.amount <= 0) return toast.error('Podaj kwotę.')
    await putEntity('expenses', form)
    onClose()
    toast.success('Zapisano koszt.')
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Koszt promocji"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Anuluj</Button>
          <Button onClick={save}>Zapisz</Button>
        </div>
      }
    >
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
          <TextInput type="number" inputMode="decimal" value={form.amount || ''} onChange={(e) => set('amount', Number(e.target.value) || 0)} />
        </Field>
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
    </Modal>
  )
}
