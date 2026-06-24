import { db, patchEntity } from '@/db/db'
import type { GeneratedImageMeta, ImageRecord, Product } from '@/db/types'
import { addGeneratedImage } from './images'

/** Wstawia `newId` tuz za `afterId`; gdy `afterId` brak/nieznane — na poczatek. */
export function insertAfterId(ids: string[], newId: string, afterId?: string): string[] {
  if (!afterId) return [newId, ...ids]
  const i = ids.indexOf(afterId)
  if (i < 0) return [newId, ...ids]
  return [...ids.slice(0, i + 1), newId, ...ids.slice(i + 1)]
}

/**
 * Zapisuje wygenerowany obraz i podpina go do wlasciwego celu: gdy produkt jest
 * rozmiarem fasonu (`designId`), zdjecie nalezy do Design i jest WSPOLDZIELONE przez
 * warianty rozmiarowe; inaczej nalezy do Product. JEDNO zrodlo prawdy dla generate()
 * i edycji — bez tego galaz design-vs-product rozjezdza sie miedzy sciezkami i powstaje
 * osierocony obraz (zapisany z productId, nigdy niedodany do design.generatedPhotoIds).
 * `opts.insertAfter` wstawia id tuz za wskazanym (np. za zrodlem edycji), by oryginal
 * i edycja sasiadowaly; bez niego — na poczatek (zachowanie generate()).
 */
export async function saveGeneratedToTarget(
  rawProduct: Product,
  img: { base64: string; mime: string },
  meta: GeneratedImageMeta,
  opts: { insertAfter?: string } = {},
): Promise<ImageRecord> {
  const rec = await addGeneratedImage(
    img.base64,
    img.mime,
    meta,
    rawProduct.designId ? {} : { productId: rawProduct.id },
  )
  if (rawProduct.designId) {
    const d = await db.designs.get(rawProduct.designId)
    if (d)
      await patchEntity('designs', d.id, {
        generatedPhotoIds: insertAfterId(d.generatedPhotoIds, rec.id, opts.insertAfter),
      })
    await patchEntity('images', rec.id, { designId: rawProduct.designId, productId: undefined })
  } else {
    const fresh = await db.products.get(rawProduct.id)
    if (fresh)
      // patchEntity (jak gałąź Design powyżej) scala tylko to pole w transakcji —
      // nie nadpisuje równolegle zmienionych pól produktu (status/cena) całym dokumentem.
      await patchEntity('products', rawProduct.id, {
        generatedPhotoIds: insertAfterId(fresh.generatedPhotoIds, rec.id, opts.insertAfter),
      })
  }
  return rec
}
