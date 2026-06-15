import { db, patchEntity } from '@/db/db'
import type { ID, ProductStatus, SaleStatus } from '@/db/types'

/**
 * Statuses that carry a side-effect (recording a Sale) and therefore must NOT be
 * flipped silently from the grid — they route through SoldModal instead.
 */
export function requiresSaleModal(status: ProductStatus): boolean {
  return status === 'sold'
}

/**
 * Quick status change from the grid. Deliberately does NOT touch soldAt/listedAt:
 * nothing reads product.soldAt/listedAt (the Sale entity is the source of truth),
 * so writing them here would be dead writes. `sold` must go through SoldModal and
 * never reaches this function in normal flow.
 */
export async function applyStatusChange(id: ID, status: ProductStatus): Promise<void> {
  await patchEntity('products', id, { status })
}

/** Assign or clear (undefined) the account of a product. */
export async function assignAccount(id: ID, accountId: ID | undefined): Promise<void> {
  await patchEntity('products', id, { accountId })
}

/**
 * Czysta reguła decyzyjna: czy zapis wpisu sprzedaży ma cofnąć przedmiot do
 * magazynu. Prawda wyłącznie przy realnym przejściu w 'returned' z powiązanym
 * przedmiotem — by edycja innych pól zwróconego wpisu nie ruszała magazynu.
 */
export function shouldRestockOnSave(
  prevStatus: SaleStatus,
  nextStatus: SaleStatus,
  hasProduct: boolean,
): boolean {
  return hasProduct && nextStatus === 'returned' && prevStatus !== 'returned'
}

/**
 * Cofa przedmiot do magazynu po zwrocie. Przestawia status na 'in_stock'
 * WYŁĄCZNIE gdy przedmiot istnieje i jest aktualnie 'sold' (nie nadpisuje
 * przedmiotu, który użytkownik już przeniósł). Zwraca, czy faktycznie cofnięto.
 */
export async function restockOnRefund(productId: ID): Promise<boolean> {
  const product = await db.products.get(productId)
  if (!product || product.status !== 'sold') return false
  await patchEntity('products', productId, { status: 'in_stock' })
  return true
}
