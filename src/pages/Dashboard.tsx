import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { format, startOfMonth, subMonths } from 'date-fns'
import { pl } from 'date-fns/locale'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Camera, Clock, Package, Plus, Shirt, TrendingUp, Wallet } from 'lucide-react'
import { db } from '@/db/db'
import { useSettings } from '@/state/settings'
import { aggregateProfit, dateShort, money } from '@/lib/format'
import { StatCard } from '@/components/ui'

const ACTIVE_STATUSES = new Set(['draft', 'in_stock', 'listed', 'reserved'])

export function Dashboard() {
  const settings = useSettings((s) => s.settings)
  const products = useLiveQuery(() => db.products.toArray(), [])
  const sales = useLiveQuery(() => db.sales.toArray(), [])
  const accounts = useLiveQuery(() => db.accounts.toArray(), [])
  const currency = settings?.currency ?? 'PLN'

  const active = (products ?? []).filter((p) => ACTIVE_STATUSES.has(p.status))
  const inventoryValue = active.reduce((s, p) => s + (p.listingPrice ?? 0) * (p.quantity || 1), 0)
  const toList = active.filter((p) => p.status === 'in_stock' || p.status === 'draft').length

  const monthStart = startOfMonth(new Date()).getTime()
  const monthSales = (sales ?? []).filter((s) => s.soldAt >= monthStart)
  const monthAgg = useMemo(() => aggregateProfit(monthSales), [monthSales])
  const totalAgg = useMemo(() => aggregateProfit(sales ?? []), [sales])

  // Wykres: przychód w ostatnich 6 miesiącach.
  const chart = useMemo(() => {
    const buckets: { key: string; label: string; from: number; to: number; value: number }[] = []
    for (let i = 5; i >= 0; i--) {
      const d = subMonths(new Date(), i)
      const from = startOfMonth(d).getTime()
      const to = startOfMonth(subMonths(d, -1)).getTime()
      buckets.push({ key: format(d, 'yyyy-MM'), label: format(d, 'LLL', { locale: pl }), from, to, value: 0 })
    }
    for (const s of sales ?? []) {
      if (s.status === 'cancelled') continue
      const b = buckets.find((x) => s.soldAt >= x.from && s.soldAt < x.to)
      if (b) b.value += s.salePrice * (s.quantity || 1)
    }
    return buckets
  }, [sales])

  const perAccount = useMemo(() => {
    return (accounts ?? []).map((a) => {
      const accSales = (sales ?? []).filter((s) => s.accountId === a.id)
      return { account: a, agg: aggregateProfit(accSales), count: accSales.length }
    })
  }, [accounts, sales])

  const recent = useMemo(
    () => [...(sales ?? [])].sort((a, b) => b.soldAt - a.soldAt).slice(0, 5),
    [sales],
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-ink-900">Pulpit</h1>
          <p className="text-sm text-ink-500">Przegląd magazynu i sprzedaży.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/magazyn" className="btn-primary">
            <Plus size={16} /> Dodaj produkt
          </Link>
          <Link to="/studio" className="btn-ghost">
            <Camera size={16} /> Studio
          </Link>
        </div>
      </div>

      {/* Statystyki */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Wartość magazynu" value={money(inventoryValue, currency)} icon={<Package size={16} />} sub={`${active.length} aktywnych`} />
        <StatCard label="Sprzedaż (mies.)" value={money(monthAgg.revenue, currency)} tone="brand" icon={<Wallet size={16} />} sub={`${monthSales.length} transakcji`} />
        <StatCard label="Zysk (mies.)" value={money(monthAgg.profit, currency)} tone="good" icon={<TrendingUp size={16} />} />
        <StatCard label="Zysk łącznie" value={money(totalAgg.profit, currency)} tone="good" sub={`${(sales ?? []).length} sprzedaży`} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Wykres */}
        <div className="card p-5 lg:col-span-2">
          <h3 className="mb-4 font-bold text-ink-900">Przychód — ostatnie 6 miesięcy</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eceef2" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} stroke="#8290a5" />
                <YAxis tickLine={false} axisLine={false} fontSize={12} stroke="#8290a5" width={56} />
                <Tooltip
                  cursor={{ fill: '#f6f7f9' }}
                  formatter={(v: number) => [money(v, currency), 'Przychód']}
                  contentStyle={{ borderRadius: 12, border: '1px solid #eceef2', fontSize: 13 }}
                />
                <Bar dataKey="value" fill="#0b9b82" radius={[6, 6, 0, 0]} maxBarSize={48} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Do wystawienia + wskazówki */}
        <div className="space-y-4">
          <div className="card p-5">
            <div className="flex items-center gap-2 text-ink-900">
              <Clock size={18} className="text-brand-500" />
              <h3 className="font-bold">Do wystawienia</h3>
            </div>
            <p className="mt-2 text-3xl font-extrabold text-ink-900">{toList}</p>
            <p className="text-sm text-ink-500">przedmiotów gotowych / szkiców</p>
            <p className="mt-3 rounded-xl bg-brand-50 px-3 py-2 text-xs text-brand-700">
              💡 Najwięcej kupujących jest wieczorem — wystawiaj między 18:00 a 22:00.
            </p>
            <Link to="/magazyn" className="btn-ghost btn-sm mt-3 w-full">
              Przejdź do magazynu
            </Link>
          </div>

          {accounts && accounts.length === 0 && (
            <Link to="/modelki" className="card flex items-center gap-3 p-4 transition hover:shadow-pop">
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-brand-50 text-brand-600">
                <Shirt size={18} />
              </div>
              <div>
                <p className="font-semibold text-ink-900">Stwórz modelkę AI</p>
                <p className="text-xs text-ink-400">Zacznij od stworzenia modelki do przymierzania</p>
              </div>
            </Link>
          )}
        </div>
      </div>

      {/* Per-konto + ostatnie sprzedaże */}
      <div className="grid gap-6 lg:grid-cols-2">
        {perAccount.length > 0 && (
          <div className="card p-5">
            <h3 className="mb-3 font-bold text-ink-900">Sprzedaż wg kont</h3>
            <div className="space-y-2">
              {perAccount.map(({ account, agg, count }) => (
                <div key={account.id} className="flex items-center justify-between rounded-xl bg-ink-50 px-3 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <span className="h-3 w-3 rounded-full" style={{ background: account.color }} />
                    <span className="font-medium text-ink-800">{account.name}</span>
                    <span className="text-xs text-ink-400">({count})</span>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-ink-900">{money(agg.revenue, currency)}</p>
                    <p className="text-xs text-emerald-600">zysk {money(agg.profit, currency)}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="card p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-bold text-ink-900">Ostatnie sprzedaże</h3>
            <Link to="/sprzedaz" className="text-sm font-semibold text-brand-600">
              Wszystkie →
            </Link>
          </div>
          {recent.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-400">Brak sprzedaży.</p>
          ) : (
            <div className="space-y-1">
              {recent.map((s) => (
                <div key={s.id} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-ink-50">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-emerald-50 text-emerald-600">
                    <Wallet size={15} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink-900">{s.productName}</p>
                    <p className="text-xs text-ink-400">{dateShort(s.soldAt)}</p>
                  </div>
                  <p className="text-sm font-bold text-emerald-600">{money(s.salePrice, s.currency)}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
