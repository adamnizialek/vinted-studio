import type { Product, ProductStatus } from '@/db/types'

export interface InventoryFilter {
  status: ProductStatus | 'all'
  accountId: string | 'all'
}

/**
 * Whether a product (or a single size of a model) should appear in the Magazyn
 * under the given filter.
 *
 * KEY RULE: the default "all" view hides SOLD items — once sold, an item lives in
 * Sprzedaż and is no longer part of the working stock. It stays reachable in the
 * Magazyn only by explicitly choosing the "Sprzedane" status filter (so you can
 * still open it, view its photos/data, or un-sell it).
 *
 * Pure — no Dexie/React — so it can be unit-tested and reused for both standalone
 * cards and per-size members of a model.
 */
export function passesInventoryFilter(p: Product, f: InventoryFilter): boolean {
  if (f.status === 'all') {
    if (p.status === 'sold') return false
  } else if (p.status !== f.status) {
    return false
  }
  if (f.accountId !== 'all' && p.accountId !== f.accountId) return false
  return true
}
