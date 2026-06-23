import { describe, it, expect, vi } from 'vitest'
import type { AiModel, ImageKind } from '@/db/types'
import {
  slugifyForFile,
  extForMime,
  groupGeneratedByModel,
  zipGalleryImages,
  type GalleryImage,
} from './modelGallery'

const model = (id: string, name: string): AiModel => ({
  id,
  name,
  referenceImageIds: [],
  createdAt: 1,
  updatedAt: 1,
})

const img = (
  id: string,
  over: Partial<GalleryImage> & { kind?: ImageKind } = {},
): GalleryImage => ({
  id,
  kind: 'generated',
  modelId: 'm1',
  mime: 'image/jpeg',
  createdAt: 1,
  ...over,
})

// Wyciaga nazwy plikow z central directory archiwum ZIP.
async function namesFromZip(blob: Blob): Promise<string[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const dv = new DataView(bytes.buffer)
  const eocd = bytes.length - 22
  const total = dv.getUint16(eocd + 10, true)
  const names: string[] = []
  let p = dv.getUint32(eocd + 16, true)
  for (let i = 0; i < total; i++) {
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    names.push(new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen)))
    p += 46 + nameLen + extraLen + commentLen
  }
  return names
}

describe('extForMime', () => {
  it('maps png to png and everything else to jpg', () => {
    expect(extForMime('image/png')).toBe('png')
    expect(extForMime('image/jpeg')).toBe('jpg')
    expect(extForMime('image/webp')).toBe('jpg')
    expect(extForMime('')).toBe('jpg')
  })
})

describe('slugifyForFile', () => {
  it('lowercases, strips diacritics and replaces unsafe chars', () => {
    expect(slugifyForFile('Ania Kowalska')).toBe('ania-kowalska')
    expect(slugifyForFile('Zażółć Gęślą')).toBe('zazolc-gesla')
    expect(slugifyForFile('a/b\\c:d*e')).toBe('a-b-c-d-e')
  })

  it('falls back to "modelka" for empty/blank input', () => {
    expect(slugifyForFile('')).toBe('modelka')
    expect(slugifyForFile('   ')).toBe('modelka')
    expect(slugifyForFile(undefined)).toBe('modelka')
  })
})

describe('groupGeneratedByModel', () => {
  const models = [model('m1', 'Ania'), model('m2', 'Beata')]

  it('keeps only generated images that have a modelId', () => {
    const images = [
      img('g1', { modelId: 'm1' }),
      img('p1', { kind: 'model', modelId: 'm1' }), // portret modelki — pomijany
      img('r1', { kind: 'reference', modelId: 'm1' }), // referencja — pomijana
      img('e1', { modelId: undefined }), // "czyść tło" — bez modelki, pomijany
    ]
    const groups = groupGeneratedByModel(images, models)
    expect(groups).toHaveLength(1)
    expect(groups[0].images.map((i) => i.id)).toEqual(['g1'])
  })

  it('groups by model in model-list order, newest first within a group', () => {
    const images = [
      img('a1', { modelId: 'm1', createdAt: 100 }),
      img('b1', { modelId: 'm2', createdAt: 50 }),
      img('a2', { modelId: 'm1', createdAt: 200 }),
    ]
    const groups = groupGeneratedByModel(images, models)
    expect(groups.map((g) => g.key)).toEqual(['m1', 'm2'])
    expect(groups[0].model?.name).toBe('Ania')
    expect(groups[0].images.map((i) => i.id)).toEqual(['a2', 'a1']) // newest first
  })

  it('omits models that have no generated images', () => {
    const groups = groupGeneratedByModel([img('a1', { modelId: 'm1' })], models)
    expect(groups.map((g) => g.key)).toEqual(['m1'])
  })

  it('collects images of deleted/unknown models into a trailing orphan group', () => {
    const images = [img('a1', { modelId: 'm1' }), img('x1', { modelId: 'gone' })]
    const groups = groupGeneratedByModel(images, models)
    expect(groups.map((g) => g.key)).toEqual(['m1', '__orphan__'])
    const orphan = groups[1]
    expect(orphan.model).toBeNull()
    expect(orphan.images.map((i) => i.id)).toEqual(['x1'])
  })
})

describe('zipGalleryImages', () => {
  const fakeBlob = (id: string) => new Blob([`bytes-of-${id}`], { type: 'image/jpeg' })

  it('builds a zip with <slug>/<NN>.<ext> names and reports counts', async () => {
    const groups = groupGeneratedByModel(
      [
        img('a1', { modelId: 'm1', createdAt: 200, mime: 'image/png' }),
        img('a2', { modelId: 'm1', createdAt: 100 }),
      ],
      [model('m1', 'Ania')],
    )
    const onProgress = vi.fn()
    const res = await zipGalleryImages({ groups, fetchBlob: async (id) => fakeBlob(id), onProgress })

    expect(res.included).toBe(2)
    expect(res.skipped).toBe(0)
    expect(await namesFromZip(res.blob)).toEqual(['ania/01.png', 'ania/02.jpg'])
    expect(onProgress).toHaveBeenLastCalledWith(2, 2)
  })

  it('skips images whose blob cannot be fetched and counts them', async () => {
    const groups = groupGeneratedByModel(
      [img('a1', { modelId: 'm1', createdAt: 2 }), img('a2', { modelId: 'm1', createdAt: 1 })],
      [model('m1', 'Ania')],
    )
    const res = await zipGalleryImages({
      groups,
      fetchBlob: async (id) => (id === 'a1' ? fakeBlob(id) : undefined),
    })
    expect(res.included).toBe(1)
    expect(res.skipped).toBe(1)
    expect(await namesFromZip(res.blob)).toEqual(['ania/01.jpg'])
  })

  it('disambiguates duplicate folder slugs across same-named models', async () => {
    const groups = groupGeneratedByModel(
      [img('a1', { modelId: 'm1' }), img('b1', { modelId: 'm2' })],
      [model('m1', 'Ania'), model('m2', 'Ania')],
    )
    const res = await zipGalleryImages({ groups, fetchBlob: async (id) => fakeBlob(id) })
    expect(await namesFromZip(res.blob)).toEqual(['ania/01.jpg', 'ania-2/01.jpg'])
  })

  it('keeps folder slugs unique even against a colliding suffix name', async () => {
    const groups = groupGeneratedByModel(
      [img('a1', { modelId: 'm1' }), img('b1', { modelId: 'm2' }), img('c1', { modelId: 'm3' })],
      [model('m1', 'Ania'), model('m2', 'Ania'), model('m3', 'ania-2')],
    )
    const res = await zipGalleryImages({ groups, fetchBlob: async (id) => fakeBlob(id) })
    const folders = (await namesFromZip(res.blob)).map((n) => n.split('/')[0])
    expect(new Set(folders).size).toBe(3) // wszystkie katalogi rozne
  })

  it('pads the index to the digit-width of the group size', async () => {
    const images = Array.from({ length: 12 }, (_, i) => img(`a${i}`, { modelId: 'm1', createdAt: i }))
    const groups = groupGeneratedByModel(images, [model('m1', 'Ania')])
    const res = await zipGalleryImages({ groups, fetchBlob: async (id) => fakeBlob(id) })
    const names = await namesFromZip(res.blob)
    expect(names[0]).toBe('ania/01.jpg')
    expect(names).toContain('ania/12.jpg')
  })
})
