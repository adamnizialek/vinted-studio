// Czyste funkcje warstwy modeli — bez Dexie/React, w pelni testowalne.
import type { Design, ID, Product } from '@/db/types'

/** Pola, ktore dla zgrupowanego produktu pochodza z Design (nie z Product). */
export const SHARED_FIELDS = [
  'name', 'brand', 'color', 'material', 'category', 'tags',
  'photoIds', 'generatedPhotoIds', 'descriptions',
] as const satisfies ReadonlyArray<keyof Design>

/**
 * Zwraca obiekt w ksztalcie Product: dla zgrupowanego (designId ustawione) naklada
 * pola wspolne z modelu, zachowujac pola per-size; dla samodzielnego zwraca produkt
 * bez zmian. Gdy model nie dotarl (sync) — bezpieczny fallback do golego produktu.
 */
export function resolveProduct(product: Product, designsById: Map<ID, Design>): Product {
  if (!product.designId) return product
  const d = designsById.get(product.designId)
  if (!d) return product
  // UWAGA: pola tablicowe (tags, photoIds, …) zwracamy przez referencje do Design —
  // konsument NIE moze mutowac wyniku (overlay jest tylko do odczytu).
  return {
    ...product,
    name: d.name,
    brand: d.brand,
    color: d.color,
    material: d.material,
    category: d.category,
    tags: d.tags,
    photoIds: d.photoIds,
    generatedPhotoIds: d.generatedPhotoIds,
    descriptions: d.descriptions,
  }
}

/**
 * Rozmiary pokazywane w pasku rozmiarow edytora modelu. Sprzedane rozmiary znikaja
 * — po sprzedazy zyja w Sprzedazy i nie sa juz stanem roboczym — CHYBA ze sprzedane
 * sa wszystkie; wtedy zwracamy je, by edytor nigdy nie byl pusty (np. otwarcie w pelni
 * sprzedanego modelu z filtra „Sprzedane"). Kolejnosc wejscia zachowana.
 */
export function visibleSizes(members: Product[]): Product[] {
  const active = members.filter((m) => m.status !== 'sold')
  return active.length ? active : members
}

/**
 * Krótki stan modelu na karcie: ile sztuk każdego rozmiaru jest jeszcze w sprzedaży
 * i ile sprzedano, np. „M 5 · S 4 · sprzedane 5”. Zarchiwizowane pomijamy.
 */
export function sizeStockSummary(members: Product[]): string {
  const left = new Map<string, number>()
  let sold = 0
  for (const m of members) {
    if (m.status === 'sold') sold++
    else if (m.status !== 'archived') {
      const size = m.sizeLabel?.trim() || '?'
      left.set(size, (left.get(size) ?? 0) + 1)
    }
  }
  const parts = [...left].map(([size, n]) => `${size} ${n}`)
  if (sold) parts.push(`sprzedane ${sold}`)
  return parts.join(' · ')
}
