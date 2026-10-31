import type { Sale } from '@/db/types'
import { countsAsRevenue, profitOf } from '@/lib/format'

export interface TopProduct {
  key: string
  name: string
  /** Sprzedane sztuki (z uwzględnieniem ilości we wpisie). */
  units: number
  revenue: number
  profit: number
  /** Rozmiary, które się sprzedały — od najczęstszego. */
  sizes: string[]
}

/** Sprzedaż rozmiaru zapisuje się jako „Nazwa modelu — 42" — odcinamy rozmiar. */
const SIZE_SUFFIX = /\s+—\s+([^—]{1,8})$/

export function splitSize(productName: string): { name: string; size?: string } {
  const m = productName.match(SIZE_SUFFIX)
  return m ? { name: productName.slice(0, m.index).trim(), size: m[1].trim() } : { name: productName.trim() }
}

/**
 * Ranking najlepiej prosperujących produktów: rozmiary jednego modelu łączymy po nazwie
 * bez rozmiaru (importowane sprzedaże często nie mają powiązania z produktem, więc
 * designId by je rozdzielał), liczymy tylko sprzedaże wliczane do przychodu.
 * Kolejność: łączny zysk, potem liczba sztuk.
 */
export function topProducts(sales: Sale[]): TopProduct[] {
  const groups = new Map<string, TopProduct & { sizeCounts: Map<string, number> }>()

  for (const s of sales) {
    if (!countsAsRevenue(s.status)) continue
    const { name, size } = splitSize(s.productName)
    const key = name.toLowerCase()
    const qty = s.quantity || 1
    const p = profitOf(s)
    let g = groups.get(key)
    if (!g) {
      g = { key, name, units: 0, revenue: 0, profit: 0, sizes: [], sizeCounts: new Map() }
      groups.set(key, g)
    }
    g.units += qty
    g.revenue += p.revenue
    g.profit += p.profit
    if (size) g.sizeCounts.set(size, (g.sizeCounts.get(size) ?? 0) + qty)
  }

  return [...groups.values()]
    .map(({ sizeCounts, ...g }) => ({
      ...g,
      sizes: [...sizeCounts.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s),
    }))
    .sort((a, b) => b.profit - a.profit || b.units - a.units)
}
