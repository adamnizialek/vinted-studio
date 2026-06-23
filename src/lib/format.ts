import { format, formatDistanceToNow } from 'date-fns'
import { pl } from 'date-fns/locale'
import type { Expense, ProfitBreakdown, Sale } from '@/db/types'

export function money(amount: number | undefined | null, currency = 'PLN'): string {
  const value = Number.isFinite(amount as number) ? (amount as number) : 0
  try {
    return new Intl.NumberFormat('pl-PL', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(value)
  } catch {
    return `${value.toFixed(2)} ${currency}`
  }
}

/**
 * Parsuje liczbę wpisaną przez użytkownika, która może używać PRZECINKA jako
 * separatora dziesiętnego. Polskie klawiatury mobilne pokazują „,", a nie „."
 * — a natywny <input type="number"> odrzuca przecinek (zwraca pustą wartość),
 * przez co nie dało się wpisać ceny z groszami na telefonie. Tu normalizujemy
 * przecinek na kropkę i parsujemy bezpiecznie.
 *
 * Zwraca undefined dla pustego/niepełnego/niepoprawnego wejścia (np. samo „,"
 * albo „-" w trakcie pisania), żeby wywołujący sam zdecydował o wartości domyślnej.
 */
export function parseDecimal(raw: string, integer = false): number | undefined {
  const cleaned = raw.replace(/\s/g, '').replace(/,/g, '.')
  if (cleaned === '' || cleaned === '.' || cleaned === '-' || cleaned === '-.') return undefined
  const n = integer ? parseInt(cleaned, 10) : parseFloat(cleaned)
  return Number.isFinite(n) ? n : undefined
}

export function percent(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('pl-PL', {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(value)
}

export function dateShort(ts: number): string {
  return format(ts, 'd MMM yyyy', { locale: pl })
}

export function dateTime(ts: number): string {
  return format(ts, 'd MMM yyyy, HH:mm', { locale: pl })
}

export function dateInputValue(ts: number): string {
  return format(ts, 'yyyy-MM-dd')
}

/**
 * Parsuje wartosc z <input type="date"> ('yyyy-MM-dd') jako czas LOKALNY (południe),
 * spójnie z dateInputValue. Goly `new Date('yyyy-MM-dd')` byłby interpretowany jako
 * UTC i przesuwałby dzień w strefach != UTC. Południe omija krawędzie DST.
 */
export function dateFromInput(value: string, fallback: number): number {
  if (!value) return fallback
  const [y, m, d] = value.split('-').map(Number)
  if (!y || !m || !d) return fallback
  return new Date(y, m - 1, d, 12, 0, 0, 0).getTime()
}

export function relative(ts: number): string {
  return formatDistanceToNow(ts, { locale: pl, addSuffix: true })
}

/** Liczy przychod/koszty/zysk/marze dla pojedynczej sprzedazy. */
export function profitOf(sale: Sale): ProfitBreakdown {
  const qty = sale.quantity || 1
  const revenue = sale.salePrice * qty + (sale.shippingCharged ?? 0)
  const costs =
    (sale.purchaseCost ?? 0) * qty +
    (sale.shippingCost ?? 0) +
    (sale.platformFee ?? 0) +
    (sale.otherCosts ?? 0)
  const profit = revenue - costs
  const margin = revenue > 0 ? profit / revenue : 0
  return { revenue, costs, profit, margin }
}

/**
 * Jednolita reguła "czy sprzedaż liczy się do przychodu".
 * Liczą się 'completed' i 'pending' (oczekiwane); 'cancelled' i 'returned' nie.
 * Używana wszędzie (ewidencja, dashboard, konta), by liczby się zgadzały.
 */
export function countsAsRevenue(status: Sale['status']): boolean {
  return status === 'completed' || status === 'pending'
}

/** Agreguje zysk z listy sprzedazy (pomija anulowane i zwroty) minus koszty promocji. */
export function aggregateProfit(sales: Sale[], expenses: Expense[] = []): ProfitBreakdown {
  const base = sales
    .filter((s) => countsAsRevenue(s.status))
    .reduce(
      (acc, s) => {
        const p = profitOf(s)
        return { revenue: acc.revenue + p.revenue, costs: acc.costs + p.costs }
      },
      { revenue: 0, costs: 0 },
    )
  const adSpend = expenses.reduce((sum, e) => sum + (e.amount || 0), 0)
  const costs = base.costs + adSpend
  const profit = base.revenue - costs
  return { revenue: base.revenue, costs, profit, margin: base.revenue > 0 ? profit / base.revenue : 0 }
}

export function pluralPl(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (n === 1) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
  return many
}
