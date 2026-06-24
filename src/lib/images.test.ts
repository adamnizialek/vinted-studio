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
  prepareScreenshotForVision,
  resolutionForEdit,
  screenshotTargetSize,
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
  // Node nie ma FileReader (używanego przez blobToBase64) — minimalny stub przez arrayBuffer.
  vi.stubGlobal(
    'FileReader',
    class {
      result: string | null = null
      onload: (() => void) | null = null
      onerror: ((e: unknown) => void) | null = null
      readAsDataURL(blob: Blob) {
        blob
          .arrayBuffer()
          .then((buf) => {
            let bin = ''
            for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b)
            this.result = `data:${blob.type};base64,${btoa(bin)}`
            this.onload?.()
          })
          .catch((e) => this.onerror?.(e))
      }
    },
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

describe('resolutionForEdit (preserve the source tier, never below 2K)', () => {
  it('keeps a 4K-class source at 4K', () => {
    expect(resolutionForEdit(4096, 3072)).toBe('4K')
    expect(resolutionForEdit(3528, 4704)).toBe('4K')
  })
  it('keeps a 2K-class source at 2K (no spurious upgrade)', () => {
    expect(resolutionForEdit(2048, 2731)).toBe('2K')
    expect(resolutionForEdit(2048, 1536)).toBe('2K')
  })
  it('floors a 1K-class source up to 2K (Vinted >=2K rule)', () => {
    expect(resolutionForEdit(1024, 1152)).toBe('2K')
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

describe('screenshotTargetSize', () => {
  it('caps the width (and scales height proportionally) for a wide desktop screenshot', () => {
    expect(screenshotTargetSize(2560, 1440)).toEqual({ width: 1200, height: 675 })
  })
  it('leaves a typical phone-width screenshot at full pixel size (re-encode does the work)', () => {
    expect(screenshotTargetSize(1080, 3000)).toEqual({ width: 1080, height: 3000 })
  })
  it('never upscales a small image', () => {
    expect(screenshotTargetSize(400, 800)).toEqual({ width: 400, height: 800 })
  })
  it('applies the height safety cap for an extremely tall page', () => {
    const { width, height } = screenshotTargetSize(1080, 12000)
    expect(height).toBe(8192)
    expect(width).toBe(737) // 1080 * (8192/12000)
  })
})

describe('prepareScreenshotForVision', () => {
  it('re-encodes the screenshot to JPEG and routes the bytes through the canvas', async () => {
    bitmapDims = { width: 1080, height: 3000 }
    const source = new Blob([new Uint8Array(5000)], { type: 'image/png' })

    const out = await prepareScreenshotForVision(source)

    expect(out.mime).toBe('image/jpeg')
    // Canvas stub koduje do 64 B — dowód, że nie wysłano surowych 5000 B oryginału.
    expect(base64ToBlob(out.base64, out.mime).size).toBe(64)
    expect(closeSpy).toHaveBeenCalled()
  })

  it('falls back to the original bytes when the image cannot be decoded', async () => {
    const good = globalThis.createImageBitmap
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new Error('decode failed')
      }),
    )
    try {
      const source = new Blob([new Uint8Array(5000)], { type: 'image/png' })
      const out = await prepareScreenshotForVision(source)
      expect(out.mime).toBe('image/png')
      expect(base64ToBlob(out.base64, out.mime).size).toBe(5000)
    } finally {
      vi.stubGlobal('createImageBitmap', good)
    }
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
