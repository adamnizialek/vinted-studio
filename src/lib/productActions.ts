import { db, deleteEntity, patchEntity } from '@/db/db'
import type { ID, Product, ProductStatus, SaleStatus } from '@/db/types'

/**
 * Statuses that carry a side-effect (recording a Sale) and therefore must NOT be
 * flipped silently from the grid — they route through SoldModal instead.
 */
export function requiresSaleModal(status: ProductStatus): boolean {
  return status === 'sold'
}

/**
 * Czysta reguła: znacznik wystawienia (listedAt) do zapisania przy zmianie statusu.
 * Stempluje `now` przy KAŻDYM wejściu w 'listed' z innego stanu (ponowne wystawienie
 * resetuje wiek — zgodnie z radarem zaległych ofert); w pozostałych przypadkach null,
 * więc istniejący listedAt (np. z backfillu) zostaje nietknięty.
 */
export function listedAtOnTransition(
  prevStatus: ProductStatus,
  nextStatus: ProductStatus,
  now: number,
): number | null {
  return nextStatus === 'listed' && prevStatus !== 'listed' ? now : null
}

/**
 * Patch zmiany statusu — jedno źródło prawdy dla obu ścieżek edycji (siatka i edytor).
 * Przy wejściu w 'listed' stempluje listedAt i czyści flagę przybliżenia z backfillu
 * (świeży stempel jest dokładny). `soldAt` NIE jest tu ruszane — 'sold' idzie przez SoldModal.
 */
export function statusChangePatch(
  prevStatus: ProductStatus,
  nextStatus: ProductStatus,
  now: number,
): Partial<Product> {
  const listedAt = listedAtOnTransition(prevStatus, nextStatus, now)
  return listedAt != null
    ? { status: nextStatus, listedAt, listedAtApprox: undefined }
    : { status: nextStatus }
}

/** Szybka zmiana statusu z siatki (np. StatusPicker) — patrz statusChangePatch. */
export async function applyStatusChange(id: ID, status: ProductStatus): Promise<void> {
  const product = await db.products.get(id)
  if (!product) return
  await patchEntity('products', id, statusChangePatch(product.status, status, Date.now()))
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

/**
 * Usuwa wpis sprzedaży i cofa powiązany przedmiot do magazynu — sprzedaż, której
 * nie ma, nie może trzymać przedmiotu jako 'sold'. Nie cofa, gdy przedmiot ma
 * jeszcze inną aktywną sprzedaż (nie zwróconą/anulowaną). Zwraca, czy cofnięto.
 */
export async function deleteSaleAndRestock(saleId: ID): Promise<boolean> {
  const sale = await db.sales.get(saleId)
  await deleteEntity('sales', saleId)
  if (!sale?.productId) return false
  const stillSold = await db.sales
    .where('productId')
    .equals(sale.productId)
    .filter((s) => s.status !== 'returned' && s.status !== 'cancelled')
    .count()
  if (stillSold > 0) return false
  return restockOnRefund(sale.productId)
}
