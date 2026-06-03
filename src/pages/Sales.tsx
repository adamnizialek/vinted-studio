import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { startOfMonth, startOfYear } from 'date-fns'
import { Download, Pencil, Plus, Trash2, Wallet } from 'lucide-react'
import clsx from 'clsx'
import { db } from '@/db/db'
import type { Sale, SaleStatus } from '@/db/types'
import { uid } from '@/lib/id'
import { useSettings } from '@/state/settings'
import { toast } from '@/state/toast'
import { SALE_STATUS_LABELS } from '@/lib/constants'
import { aggregateProfit, dateInputValue, dateShort, money, percent, profitOf } from '@/lib/format'
import { toCsv, downloadText } from '@/lib/csv'
import { Button, EmptyState, Field, Modal, Select, StatCard, TextArea, TextInput, SectionTitle } from '@/components/ui'

type Period = 'all' | 'month' | 'year'

export function Sales() {
  const settings = useSettings((s) => s.settings)
  const sales = useLiveQuery(() => db.sales.orderBy('soldAt').reverse().toArray(), [])
  const accounts = useLiveQuery(() => db.accounts.toArray(), [])

  const [view, setView] = useState<string>('all') // 'all' = wspólna, lub accountId
  const [period, setPeriod] = useState<Period>('all')
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Sale | null>(null)

  const filtered = useMemo(() => {
    let list = sales ?? []
    if (view !== 'all') list = list.filter((s) => s.accountId === view)
    if (period !== 'all') {
      const from = period === 'month' ? startOfMonth(new Date()) : startOfYear(new Date())
      list = list.filter((s) => s.soldAt >= from.getTime())
    }
    return list
  }, [sales, view, period])

  const stats = useMemo(() => aggregateProfit(filtered), [filtered])
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
    })
    setOpen(true)
  }

  const remove = async (id: string) => {
    if (!window.confirm('Usunąć ten wpis sprzedaży?')) return
    await db.sales.delete(id)
    toast.success('Usunięto wpis.')
  }

  const exportCsv = () => {
    const rows = filtered.map((s) => {
      const p = profitOf(s)
      return {
        Data: dateShort(s.soldAt),
        Produkt: s.productName,
        Marka: s.brand ?? '',
        Konto: accName(s.accountId),
        Cena: s.salePrice,
        Ilość: s.quantity,
        'Koszt zakupu': s.purchaseCost ?? 0,
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

      <SaleModal open={open} onClose={() => setOpen(false)} sale={editing} accounts={accounts ?? []} />
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
    await db.sales.put(form)
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
            onChange={(e) => set('soldAt', e.target.value ? new Date(e.target.value).getTime() : form.soldAt)}
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
