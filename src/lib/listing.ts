// Czyste funkcje cyklu życia oferty (wystawienie → sprzedaż). Bez Dexie/React,
// w pełni testowalne. Czas wszędzie jako epoch-ms (spójnie z resztą bazy).
import type { ID, Product } from '@/db/types'

export const DAY_MS = 86_400_000

/** Po ilu dniach wystawiona oferta trafia do kolejki „Wymaga uwagi”. */
export const STALE_LISTING_DAYS = 30

/** Pełne dni (w dół) między dwoma znacznikami epoch-ms; może być ujemne. */
export function daysBetween(from: number, to: number): number {
  return Math.floor((to - from) / DAY_MS)
}

/** Mediana listy liczb (null dla pustej). Nie mutuje wejścia. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** Normalizuje wklejony link do bezpiecznego href (dokleja https:// gdy brak schematu). */
export function listingHref(url: string | undefined): string | undefined {
  const u = url?.trim()
  if (!u) return undefined
  return /^https?:\/\//i.test(u) ? u : `https://${u}`
}

/** Okładka przedmiotu: jawne coverImageId, inaczej pierwsze zdjęcie (orig → AI). */
export function coverImageIdOf(
  product: Pick<Product, 'coverImageId' | 'photoIds' | 'generatedPhotoIds'>,
): ID | undefined {
  return product.coverImageId ?? product.photoIds[0] ?? product.generatedPhotoIds[0]
}

/** Ile dni przedmiot jest wystawiony; null jeśli nie jest 'listed' lub brak listedAt. */
export function daysListed(product: Product, now: number): number | null {
  if (product.status !== 'listed' || product.listedAt == null) return null
  return Math.max(0, daysBetween(product.listedAt, now))
}

export interface StaleListing {
  product: Product
  days: number
}

/** Wystawione przedmioty starsze niż próg (włącznie), od najstarszych. */
export function staleListings(
  products: Product[],
  now: number,
  thresholdDays: number = STALE_LISTING_DAYS,
): StaleListing[] {
  const out: StaleListing[] = []
  for (const product of products) {
    const days = daysListed(product, now)
    if (days != null && days >= thresholdDays) out.push({ product, days })
  }
  return out.sort((a, b) => b.days - a.days)
}

export interface SellThrough {
  sold: number
  listed: number
  /** sprzedane / (sprzedane + wystawione); null gdy nic nie trafiło na rynek. */
  rate: number | null
}

/** Sprzedawalność wśród przedmiotów, które trafiły na rynek (wystawione + sprzedane). */
export function sellThrough(products: Product[]): SellThrough {
  let sold = 0
  let listed = 0
  for (const p of products) {
    if (p.status === 'sold') sold++
    else if (p.status === 'listed') listed++
  }
  const denom = sold + listed
  return { sold, listed, rate: denom > 0 ? sold / denom : null }
}

export interface DaysToSellStats {
  /** Mediana dni od wystawienia do sprzedaży; null gdy brak pokrycia. */
  medianDays: number | null
  /** Ile sprzedanych przedmiotów ma datę wystawienia (i da się policzyć). */
  covered: number
  /** Wszystkie sprzedane przedmioty (mianownik pokrycia). */
  totalSold: number
}

/**
 * Mediana czasu sprzedaży liczona z Product.listedAt → Product.soldAt. Pokrycie
 * jest częściowe: importowane sprzedaże nie mają productId, a przedmioty
 * sprzedane przed wdrożeniem nie mają listedAt — stąd osobne `covered`/`totalSold`.
 */
export function daysToSellStats(products: Product[]): DaysToSellStats {
  const sold = products.filter((p) => p.status === 'sold')
  const durations: number[] = []
  for (const p of sold) {
    if (p.listedAt != null && p.soldAt != null && p.soldAt >= p.listedAt) {
      durations.push(daysBetween(p.listedAt, p.soldAt))
    }
  }
  return { medianDays: median(durations), covered: durations.length, totalSold: sold.length }
}
