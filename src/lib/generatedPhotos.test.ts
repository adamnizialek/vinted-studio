import { describe, it, expect, beforeEach, vi } from 'vitest'
import { db, putEntity } from '@/db/db'
import type { Design, GeneratedImageMeta, ImageRecord, Product } from '@/db/types'

// addGeneratedImage runs createImageBitmap/canvas (DOM) — out of scope here. We stub it
// to insert a minimal image row and return it, so we test ONLY the design-vs-product
// routing + id insertion (the orphan-on-shared-design risk the critique flagged).
vi.mock('@/lib/images', () => ({
  addGeneratedImage: vi.fn(
    async (
      base64: string,
      mime: string,
      meta: GeneratedImageMeta,
      links?: { productId?: string },
    ): Promise<ImageRecord> => {
      const rec: ImageRecord = {
        id: 'gen-new',
        mime,
        width: 2048,
        height: 2731,
        thumb: 'data:image/jpeg;base64,xx',
        kind: 'generated',
        productId: links?.productId,
        modelId: meta.modelId,
        meta,
        createdAt: 1,
        updatedAt: 1,
      }
      await putEntity('images', rec)
      return rec
    },
  ),
}))

import { insertAfterId, saveGeneratedToTarget } from '@/lib/generatedPhotos'

const meta = (over: Partial<GeneratedImageMeta> = {}): GeneratedImageMeta => ({
  prompt: 'p',
  imageModel: 'gemini-3-pro-image',
  sourceImageIds: [],
  ...over,
})

const product = (over: Partial<Product>): Product => ({
  id: 'p1',
  name: 'P',
  condition: 'dobry',
  currency: 'PLN',
  quantity: 1,
  status: 'in_stock',
  photoIds: [],
  generatedPhotoIds: [],
  descriptions: [],
  tags: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

beforeEach(async () => {
  await Promise.all([db.products.clear(), db.designs.clear(), db.images.clear(), db.outbox.clear()])
})

describe('insertAfterId', () => {
  it('inserts immediately after the anchor id', () => {
    expect(insertAfterId(['a', 'b', 'c'], 'x', 'b')).toEqual(['a', 'b', 'x', 'c'])
  })
  it('prepends when no anchor is given', () => {
    expect(insertAfterId(['a', 'b'], 'x')).toEqual(['x', 'a', 'b'])
  })
  it('prepends when the anchor id is not present', () => {
    expect(insertAfterId(['a', 'b'], 'x', 'zzz')).toEqual(['x', 'a', 'b'])
  })
})

describe('saveGeneratedToTarget — product (non-design)', () => {
  it('inserts the new id after the source and keeps productId on the image', async () => {
    await putEntity('products', product({ id: 'p1', generatedPhotoIds: ['src', 'other'] }))
    const rec = await saveGeneratedToTarget(
      product({ id: 'p1', generatedPhotoIds: ['src', 'other'] }),
      { base64: 'AAAA', mime: 'image/png' },
      meta({ editedFromId: 'src' }),
      { insertAfter: 'src' },
    )
    const fresh = await db.products.get('p1')
    expect(fresh?.generatedPhotoIds).toEqual(['src', 'gen-new', 'other'])
    expect((await db.images.get(rec.id))?.productId).toBe('p1')
  })
})

describe('saveGeneratedToTarget — shared design (the orphan guard)', () => {
  it('lands in design.generatedPhotoIds and clears productId on the image', async () => {
    const design: Design = {
      id: 'd1',
      name: 'D',
      tags: [],
      photoIds: [],
      generatedPhotoIds: ['src'],
      descriptions: [],
      createdAt: 1,
      updatedAt: 1,
    }
    await putEntity('designs', design)
    await putEntity('products', product({ id: 'p1', designId: 'd1' }))

    const rec = await saveGeneratedToTarget(
      product({ id: 'p1', designId: 'd1' }),
      { base64: 'AAAA', mime: 'image/png' },
      meta({ editedFromId: 'src' }),
      { insertAfter: 'src' },
    )

    const d = await db.designs.get('d1')
    expect(d?.generatedPhotoIds).toEqual(['src', 'gen-new'])
    const img = await db.images.get(rec.id)
    expect(img?.designId).toBe('d1')
    expect(img?.productId).toBeUndefined()
  })
})
