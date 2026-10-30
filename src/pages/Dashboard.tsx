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
import { AlertTriangle, Camera, Clock, ExternalLink, Package, Percent, Plus, Shirt, TrendingUp, Wallet } from 'lucide-react'
import { db } from '@/db/db'
import { useSettings } from '@/state/settings'
import { aggregateProfit, countsAsInventoryCost, countsAsRevenue, dateShort, money, percent, pluralPl } from '@/lib/format'
import { resolveProduct } from '@/lib/designs'
import {
  STALE_LISTING_DAYS,
  daysToSellStats,
  listingHref,
  sellThrough,
  staleListings,
} from '@/lib/listing'
import { StatCard } from '@/components/ui'
import { useChartColors } from '@/lib/hooks'

const STALE_VISIBLE = 8

export function Dashboard() {
  const settings = useSettings((s) => s.settings)
  const products = useLiveQuery(() => db.products.toArray(), [])
  const sales = useLiveQuery(() => db.sales.toArray(), [])
  const expenses = useLiveQuery(() => db.expenses.toArray(), [])
  const accounts = useLiveQuery(() => db.accounts.toArray(), [])
  const designs = useLiveQuery(() => db.designs.toArray(), [])
  const designsById = useMemo(() => new Map((designs ?? []).map((d) => [d.id, d])), [designs])
  const currency = settings?.currency ?? 'PLN'
  const chartColors = useChartColors()

  const active = (products ?? []).filter((p) => countsAsInventoryCost(p.status))
  const inventoryValue = active.reduce((s, p) => s + (p.listingPrice ?? 0) * (p.quantity || 1), 0)
  const inventoryCost = active.reduce((s, p) => s + (p.purchasePrice ?? 0) * (p.quantity || 1), 0)
  const toList = active.filter((p) => p.status === 'in_stock' || p.status === 'draft').length

  const monthStart = startOfMonth(new Date()).getTime()
  const monthSales = (sales ?? []).filter((s) => s.soldAt >= monthStart)
  const monthExpenses = (expenses ?? []).filter((e) => e.incurredAt >= monthStart)
  const monthAgg = useMemo(() => aggregateProfit(monthSales, monthExpenses), [monthSales, monthExpenses])
  const totalAgg = useMemo(() => aggregateProfit(sales ?? [], expenses ?? [], products ?? []), [sales, expenses, products])

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
      if (!countsAsRevenue(s.status)) continue // spójnie z aggregateProfit (bez anulowanych i zwrotów)
      const b = buckets.find((x) => s.soldAt >= x.from && s.soldAt < x.to)
      if (b) b.value += s.salePrice * (s.quantity || 1)
    }
    return buckets
  }, [sales])

  const perAccount = useMemo(() => {
    return (accounts ?? []).map((a) => {
      const accSales = (sales ?? []).filter((s) => s.accountId === a.id)
      const accExpenses = (expenses ?? []).filter((e) => e.accountId === a.id)
      return { account: a, agg: aggregateProfit(accSales, accExpenses), count: accSales.length }
    })
  }, [accounts, sales, expenses])

  const recent = useMemo(
    () => [...(sales ?? [])].sort((a, b) => b.soldAt - a.soldAt).slice(0, 5),
    [sales],
  )

  // Cykl życia ofert: sprzedawalność, mediana czasu sprzedaży (częściowe pokrycie),
  // i kolejka zaległych ofert (wystawione > STALE_LISTING_DAYS, niesprzedane).
  const lifecycle = useMemo(() => {
    const all = products ?? []
    const dts = daysToSellStats(all)
    return {
      sell: sellThrough(all),
      dts,
      stale: staleListings(all, Date.now()),
      // Mediana jako liczba całkowita w UI (median może być X.5 dla parzystej próbki).
      medianDays: dts.medianDays == null ? null : Math.round(dts.medianDays),
    }
  }, [products])

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
        <StatCard label="Wartość magazynu" value={money(inventoryValue, currency)} icon={<Package size={16} />} sub={`${active.length} aktywnych · koszt ${money(inventoryCost, currency)}`} />
        <StatCard label="Sprzedaż (mies.)" value={money(monthAgg.revenue, currency)} tone="brand" icon={<Wallet size={16} />} sub={`${monthSales.length} transakcji`} />
        <StatCard label="Zysk (mies.)" value={money(monthAgg.profit, currency)} tone={monthAgg.profit >= 0 ? 'good' : 'bad'} icon={<TrendingUp size={16} />} />
        <StatCard label="Zysk łącznie" value={money(totalAgg.profit, currency)} tone={totalAgg.profit >= 0 ? 'good' : 'bad'} sub={`${(sales ?? []).length} sprzedaży`} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Wykres */}
        <div className="card p-5 lg:col-span-2">
          <h3 className="mb-4 font-bold text-ink-900">Przychód — ostatnie 6 miesięcy</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={chartColors.grid} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} stroke={chartColors.axis} />
                <YAxis tickLine={false} axisLine={false} fontSize={12} stroke={chartColors.axis} width={56} />
                <Tooltip
                  cursor={{ fill: chartColors.cursor }}
                  formatter={(v: number) => [money(v, currency), 'Przychód']}
                  contentStyle={{
                    borderRadius: 12,
                    border: `1px solid ${chartColors.tooltipBorder}`,
                    background: chartColors.tooltipBg,
                    color: chartColors.tooltipText,
                    fontSize: 13,
                  }}
                />
                <Bar dataKey="value" fill={chartColors.bar} radius={[6, 6, 0, 0]} maxBarSize={48} />
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
            <p className="mt-3 rounded-xl bg-brand-50 px-3 py-2 text-xs text-brand-700 dark:bg-brand-950/40 dark:text-brand-300">
              💡 Najwięcej kupujących jest wieczorem — wystawiaj między 18:00 a 22:00.
            </p>
            <Link to="/magazyn" className="btn-ghost btn-sm mt-3 w-full">
              Przejdź do magazynu
            </Link>
          </div>

          {accounts && accounts.length === 0 && (
            <Link to="/modelki" className="card flex items-center gap-3 p-4 transition hover:shadow-pop">
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-950/40 dark:text-brand-300">
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

      {/* Cykl życia ofert */}
      <div className="space-y-3">
        <h2 className="font-bold text-ink-900">Cykl życia ofert</h2>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-1">
            <StatCard
              label="Sprzedawalność"
              icon={<Percent size={16} />}
              value={lifecycle.sell.rate == null ? '—' : percent(lifecycle.sell.rate)}
              sub={
                lifecycle.sell.rate == null
                  ? 'brak ofert na rynku'
                  : `${lifecycle.sell.sold} / ${lifecycle.sell.sold + lifecycle.sell.listed} sprzedane + wystawione`
              }
            />
            <StatCard
              label="Mediana czasu sprzedaży"
              icon={<Clock size={16} />}
              value={
                lifecycle.medianDays == null
                  ? '—'
                  : `${lifecycle.medianDays} ${pluralPl(lifecycle.medianDays, 'dzień', 'dni', 'dni')}`
              }
              sub={
                lifecycle.dts.totalSold === 0
                  ? 'brak sprzedaży'
                  : `z ${lifecycle.dts.covered}/${lifecycle.dts.totalSold} sprzedanych (częściowe pokrycie)`
              }
            />
          </div>

          {/* Wymaga uwagi — zaległe oferty */}
          <div className="card p-5 lg:col-span-2">
            <div className="flex items-center gap-2 text-ink-900">
              <AlertTriangle size={18} className="text-amber-500" />
              <h3 className="font-bold">Wymaga uwagi</h3>
              {lifecycle.stale.length > 0 && (
                <span className="badge bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                  {lifecycle.stale.length}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-ink-400">
              Wystawione co najmniej {STALE_LISTING_DAYS} dni temu i wciąż niesprzedane.
            </p>
            {lifecycle.stale.length === 0 ? (
              <p className="py-6 text-center text-sm text-ink-400">Nic nie zalega — świetnie! 🎉</p>
            ) : (
              <div className="mt-3 space-y-1">
                {lifecycle.stale.slice(0, STALE_VISIBLE).map(({ product, days, units }) => {
                  const href = listingHref(product.listingUrl)
                  // Rozmiary modelu trzymają nazwę na Design — rozwiąż przez resolveProduct
                  // (spójnie z edytorem) i dopnij rozmiar, by nie pokazać „Bez nazwy”.
                  const resolved = resolveProduct(product, designsById)
                  // Kilka zalegających sztuk modelu to jedno ogłoszenie: bez rozmiaru, z licznikiem.
                  const name = product.designId
                    ? units > 1
                      ? `${resolved.name || 'Model'} · ${units} szt.`
                      : [resolved.name, product.sizeLabel].filter(Boolean).join(' — ') || 'Model'
                    : resolved.name || 'Bez nazwy'
                  const to = product.designId
                    ? `/magazyn/model/${product.designId}`
                    : `/magazyn/${product.id}`
                  return (
                    <div
                      key={product.id}
                      className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-ink-50"
                    >
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400">
                        <Clock size={15} />
                      </span>
                      <Link to={to} className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-ink-900">{name}</p>
                        <p
                          className="text-xs text-amber-600"
                          title={product.listedAtApprox ? 'Data wystawienia przybliżona' : undefined}
                        >
                          wystawione od {product.listedAtApprox ? '≈' : ''}
                          {days} {pluralPl(days, 'dnia', 'dni', 'dni')}
                        </p>
                      </Link>
                      <p className="shrink-0 text-sm font-bold text-ink-900">
                        {product.listingPrice ? money(product.listingPrice, product.currency) : '—'}
                      </p>
                      {href && (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shrink-0 text-ink-400 transition hover:text-brand-600"
                          title="Otwórz ogłoszenie"
                          aria-label="Otwórz ogłoszenie na Vinted"
                        >
                          <ExternalLink size={15} />
                        </a>
                      )}
                    </div>
                  )
                })}
                {lifecycle.stale.length > STALE_VISIBLE && (
                  <Link
                    to="/magazyn"
                    className="block px-2 py-2 text-sm font-semibold text-brand-600"
                  >
                    i {lifecycle.stale.length - STALE_VISIBLE} więcej w magazynie →
                  </Link>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Per-konto + ostatnie sprzedaże */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {perAccount.length > 0 && (
          <div className="card p-5">
            <h3 className="mb-3 font-bold text-ink-900">Sprzedaż wg kont</h3>
            <div className="space-y-2">
              {perAccount.map(({ account, agg, count }) => (
                <div key={account.id} className="flex items-center justify-between gap-3 rounded-xl bg-ink-50 px-3 py-2.5">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: account.color }} />
                    <span className="truncate font-medium text-ink-800">{account.name}</span>
                    <span className="shrink-0 text-xs text-ink-400">({count})</span>
                  </div>
                  <div className="shrink-0 text-right">
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
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">
                    <Wallet size={15} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink-900">{s.productName}</p>
                    <p className="text-xs text-ink-400">{dateShort(s.soldAt)}</p>
                  </div>
                  <p className="shrink-0 text-sm font-bold text-emerald-600">{money(s.salePrice, s.currency)}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
