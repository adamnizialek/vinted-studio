// Okresy ewidencji sprzedaży + uproszczona ewidencja sprzedaży (art. 109 ust. 1 ustawy
// o VAT: sprzedaż za każdy dzień, najpóźniej przed pierwszą sprzedażą dnia następnego).
// Czyste funkcje (bez Dexie/React). Czas jako epoch-ms, kalendarz LOKALNY.
import type { Sale } from '@/db/types'
import { countsAsRevenue, dateInputValue, profitOf } from '@/lib/format'

export interface Quarter {
  year: number
  /** 1–4 */
  q: number
  /** Początek kwartału (lokalna północ), włącznie. */
  from: number
  /** Początek następnego kwartału, wyłącznie. */
  to: number
}

export function quarterOf(ts: number): Quarter {
  const d = new Date(ts)
  const year = d.getFullYear()
  const q = Math.floor(d.getMonth() / 3) + 1
  return {
    year,
    q,
    from: new Date(year, (q - 1) * 3, 1).getTime(),
    to: new Date(year, q * 3, 1).getTime(),
  }
}

/** Kwartał bezpośrednio przed tym, w którym leży `ts`. */
export function previousQuarter(ts: number): Quarter {
  return quarterOf(quarterOf(ts).from - 1)
}

export interface SalesRecordRow {
  /** Lokalna data 'yyyy-MM-dd'. */
  date: string
  /** Suma sprzedaży danego dnia. */
  amount: number
  /** Narastająco od początku roku (włącznie z tym dniem). */
  cumulativeYear: number
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Uproszczona ewidencja sprzedaży (wzór biznes.gov.pl: data, kwota, narastająco od
 * początku roku): jeden wiersz na dzień ze sprzedażą, rosnąco. Anulowane i zwroty
 * się nie liczą. `range` zawęża tylko wypisywane wiersze — suma narastająca zostaje
 * pełna, więc eksport samego kwartału nadal pokazuje poprawny stan od początku roku.
 */
export function dailySalesRecord(
  sales: Sale[],
  range?: { from?: number; to?: number },
): SalesRecordRow[] {
  const byDay = new Map<string, { ts: number; amount: number }>()
  for (const s of sales) {
    if (!countsAsRevenue(s.status)) continue
    const key = dateInputValue(s.soldAt)
    const amount = profitOf(s).revenue
    const cur = byDay.get(key)
    if (cur) cur.amount += amount
    else byDay.set(key, { ts: s.soldAt, amount })
  }
  const days = [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  const rows: SalesRecordRow[] = []
  let year = NaN
  let cumYear = 0
  for (const [date, { ts, amount }] of days) {
    const y = new Date(ts).getFullYear()
    if (y !== year) {
      year = y
      cumYear = 0
    }
    cumYear += amount
    if (!inRange(ts, range ?? {})) continue
    rows.push({ date, amount: round2(amount), cumulativeYear: round2(cumYear) })
  }
  return rows
}

export type SalesPeriod = 'all' | 'month' | 'lastMonth' | 'quarter' | 'lastQuarter' | 'year'

export const SALES_PERIOD_LABELS: Record<SalesPeriod, string> = {
  all: 'Cały okres',
  month: 'Ten miesiąc',
  lastMonth: 'Poprzedni miesiąc',
  quarter: 'Ten kwartał',
  lastQuarter: 'Poprzedni kwartał',
  year: 'Ten rok',
}

/** Zakres [from, to) dla okresu; `all` → brak granic. */
export function periodRange(period: SalesPeriod, now: number): { from?: number; to?: number } {
  const d = new Date(now)
  switch (period) {
    case 'all':
      return {}
    case 'month':
      return { from: new Date(d.getFullYear(), d.getMonth(), 1).getTime() }
    case 'lastMonth':
      return {
        from: new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(),
        to: new Date(d.getFullYear(), d.getMonth(), 1).getTime(),
      }
    case 'quarter':
      return { from: quarterOf(now).from }
    case 'lastQuarter': {
      const p = previousQuarter(now)
      return { from: p.from, to: p.to }
    }
    case 'year':
      return { from: new Date(d.getFullYear(), 0, 1).getTime() }
  }
}

export function inRange(ts: number, range: { from?: number; to?: number }): boolean {
  return (range.from == null || ts >= range.from) && (range.to == null || ts < range.to)
}
