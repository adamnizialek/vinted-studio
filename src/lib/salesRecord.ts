// Okresy ewidencji sprzedaży + uproszczona ewidencja sprzedaży (art. 109 ust. 1 ustawy
// o VAT: sprzedaż za każdy dzień, najpóźniej przed pierwszą sprzedażą dnia następnego).
// Czyste funkcje (bez Dexie/React). Czas jako epoch-ms, kalendarz LOKALNY.
import { startOfMonth, startOfQuarter, startOfYear, subMonths, subQuarters } from 'date-fns'
import type { Sale } from '@/db/types'
import { countsAsRevenue, dateInputValue, profitOf } from '@/lib/format'

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
  for (const [date, { ts, amount: raw }] of days) {
    const y = new Date(ts).getFullYear()
    if (y !== year) {
      year = y
      cumYear = 0
    }
    // Sumujemy już zaokrąglone kwoty dzienne — kolumna narastająca zgadza się co do grosza
    // z sumą wierszy.
    const amount = round2(raw)
    cumYear = round2(cumYear + amount)
    if (!inRange(ts, range ?? {})) continue
    rows.push({ date, amount, cumulativeYear: cumYear })
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

/** Zakres [from, to) dla okresu (kalendarz lokalny); `all` → brak granic. */
export function periodRange(period: SalesPeriod, now: number): { from?: number; to?: number } {
  switch (period) {
    case 'all':
      return {}
    case 'month':
      return { from: startOfMonth(now).getTime() }
    case 'lastMonth':
      return { from: startOfMonth(subMonths(now, 1)).getTime(), to: startOfMonth(now).getTime() }
    case 'quarter':
      return { from: startOfQuarter(now).getTime() }
    case 'lastQuarter':
      return {
        from: startOfQuarter(subQuarters(now, 1)).getTime(),
        to: startOfQuarter(now).getTime(),
      }
    case 'year':
      return { from: startOfYear(now).getTime() }
  }
}

export function inRange(ts: number, range: { from?: number; to?: number }): boolean {
  return (range.from == null || ts >= range.from) && (range.to == null || ts < range.to)
}
