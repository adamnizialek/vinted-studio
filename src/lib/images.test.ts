import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

// Izolujemy moduł od IndexedDB i synchronizacji: chcemy sprawdzić wyłącznie
// logikę przetwarzania obrazu i kształt zapisywanego rekordu.
vi.mock('@/db/db', () => ({
  putEntity: vi.fn(async (_table: string, rec: unknown) => rec),
}))
vi.mock('@/sync/blobSync', () => ({
  enqueueBlobUpload: vi.fn(async () => {}),
  getBlob: vi.fn(async () => undefined),
}))
vi.mock('@/sync/config', () => ({
  currentRemote: vi.fn(() => null),
}))

import {
  addGeneratedImage,
  addImageFromFile,
  base64ToBlob,
  fitWithin,
  preservesResolution,
} from '@/lib/images'

// Środowisko testów to Node (bez DOM) — podstawiamy minimalne createImageBitmap
// i canvas, sterując rozdzielczością zdekodowanej bitmapy per-test.
let bitmapDims = { width: 0, height: 0 }
const closeSpy = vi.fn()

beforeAll(() => {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: bitmapDims.width, height: bitmapDims.height, close: closeSpy })),
  )
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`unexpected element <${tag}>`)
      let w = 0
      let h = 0
      return {
        get width() {
          return w
        },
        set width(v: number) {
          w = v
        },
        get height() {
          return h
        },
        set height(v: number) {
          h = v
        },
        getContext: () => ({ imageSmoothingQuality: 'low', drawImage: () => {} }),
        // Miniatura/re-enkodowanie: zwracamy maleńki blob, więc gdyby główny obraz
        // przeszedł przez canvas, jego rozmiar dramatycznie by spadł (wykrywamy to).
        toBlob: (cb: (b: Blob | null) => void, mime: string) =>
          cb(new Blob([new Uint8Array(64)], { type: mime })),
        toDataURL: (mime: string) => `data:${mime};base64,dGh1bWI=`,
      }
    },
  })
})

afterAll(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  closeSpy.mockClear()
})

describe('preservesResolution', () => {
  it('preserves full resolution for paid model output (generated, model)', () => {
    expect(preservesResolution('generated')).toBe(true)
    expect(preservesResolution('model')).toBe(true)
  })
  it('downscales user-uploaded source kinds (product, reference)', () => {
    expect(preservesResolution('product')).toBe(false)
    expect(preservesResolution('reference')).toBe(false)
  })
})

describe('fitWithin', () => {
  it('clamps the longer side to the max, preserving aspect ratio (landscape)', () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 })
  })
  it('clamps by the taller side for portrait images', () => {
    expect(fitWithin(1536, 2048, 1600)).toEqual({ width: 1200, height: 1600 })
  })
  it('never upscales an image already smaller than the max', () => {
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 })
  })
})

describe('base64ToBlob', () => {
  it('decodes base64 to byte-exact output (no recompression)', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 250, 128, 0, 255])
    const b64 = Buffer.from(bytes).toString('base64')
    const blob = base64ToBlob(b64, 'image/png')
    expect(blob.type).toBe('image/png')
    expect(blob.size).toBe(bytes.length)
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual(Array.from(bytes))
  })
  it('strips a leading data-URL prefix if present', () => {
    const b64 = Buffer.from(new Uint8Array([9, 8, 7])).toString('base64')
    expect(base64ToBlob(`data:image/png;base64,${b64}`, 'image/png').size).toBe(3)
  })
})

describe('addGeneratedImage (paid model output)', () => {
  it('stores the raw 2K bytes unchanged — no downscale, no JPEG re-encode', async () => {
    bitmapDims = { width: 2048, height: 2731 } // realistyczny portret 2K z Gemini
    const payload = new Uint8Array(5000).fill(7) // udajemy bajty PNG
    const b64 = Buffer.from(payload).toString('base64')

    const rec = await addGeneratedImage(b64, 'image/png', {
      prompt: 'try-on',
      imageModel: 'gemini-3-pro-image',
      sourceImageIds: [],
    })

    // Rozdzielczość zachowana — co najmniej żądane 2K (2048 px).
    expect(rec.width).toBe(2048)
    expect(rec.height).toBe(2731)
    expect(Math.max(rec.width, rec.height)).toBeGreaterThanOrEqual(2048)
    // Dokładnie oryginalne bajty (rozmiar == wejście ⇒ brak ponownej kompresji canvas).
    expect(rec.blob).toBeInstanceOf(Blob)
    expect(rec.blob!.size).toBe(payload.length)
    expect(rec.mime).toBe('image/png')
    // Miniatura nadal tworzona osobno (mała, JPEG).
    expect(rec.thumb).toMatch(/^data:image\/jpeg/)
    expect(rec.kind).toBe('generated')
    expect(closeSpy).toHaveBeenCalled() // bitmapa zwolniona
  })
})

describe('addImageFromFile', () => {
  it('downscales + re-encodes user product uploads to bound storage', async () => {
    bitmapDims = { width: 4000, height: 3000 }
    const file = new Blob([new Uint8Array(9000)], { type: 'image/jpeg' })

    const rec = await addImageFromFile(file, 'product', { productId: 'p1' })

    expect(rec.width).toBe(1600)
    expect(rec.height).toBe(1200)
    expect(rec.blob).not.toBe(file) // przeskalowane/re-enkodowane, nie oryginał
    expect(rec.kind).toBe('product')
  })

  it('preserves full resolution for generated model reference photos (kind: model)', async () => {
    bitmapDims = { width: 2048, height: 2731 }
    const file = new Blob([new Uint8Array(7000)], { type: 'image/png' })

    const rec = await addImageFromFile(file, 'model', { modelId: 'm1' })

    expect(rec.width).toBe(2048)
    expect(rec.height).toBe(2731)
    expect(rec.blob).toBe(file) // zapisany bez zmian
    expect(rec.blob!.size).toBe(7000)
  })
})
