// Czyste funkcje warstwy modeli — bez Dexie/React, w pelni testowalne.
import type { Design, ID, Product } from '@/db/types'

/** Pola, ktore dla zgrupowanego produktu pochodza z Design (nie z Product). */
export const SHARED_FIELDS = [
  'name', 'brand', 'color', 'material', 'category', 'tags',
  'photoIds', 'generatedPhotoIds', 'descriptions',
] as const

/**
 * Zwraca obiekt w ksztalcie Product: dla zgrupowanego (designId ustawione) naklada
 * pola wspolne z modelu, zachowujac pola per-size; dla samodzielnego zwraca produkt
 * bez zmian. Gdy model nie dotarl (sync) — bezpieczny fallback do golego produktu.
 */
export function resolveProduct(product: Product, designsById: Map<ID, Design>): Product {
  if (!product.designId) return product
  const d = designsById.get(product.designId)
  if (!d) return product
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
