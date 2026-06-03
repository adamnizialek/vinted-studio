import { db } from '@/db/db'
import type { GeneratedImageMeta, ImageKind, ImageRecord } from '@/db/types'
import { uid } from './id'

const MAX_DIM = 1600 // maks. dluzszy bok zapisywanego zdjecia (px)
const THUMB_DIM = 320 // dluzszy bok miniatury (px)
const JPEG_QUALITY = 0.92
const THUMB_QUALITY = 0.72

interface ProcessedImage {
  blob: Blob
  mime: string
  width: number
  height: number
  thumb: string
}

/** Wczytuje plik/blob, obraca wg EXIF, skaluje i tworzy miniature. */
export async function processImage(source: Blob): Promise<ProcessedImage> {
  const bitmap = await createImageBitmap(source, {
    imageOrientation: 'from-image',
  }).catch(() => createImageBitmap(source))

  const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height))
  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)

  const main = drawToCanvas(bitmap, w, h)
  const hasAlpha = source.type === 'image/png'
  const mime = hasAlpha ? 'image/png' : 'image/jpeg'
  const blob = await canvasToBlob(main, mime, JPEG_QUALITY)

  // Miniatura zawsze JPEG (mniejsza).
  const tScale = Math.min(1, THUMB_DIM / Math.max(w, h))
  const tw = Math.max(1, Math.round(w * tScale))
  const th = Math.max(1, Math.round(h * tScale))
  const thumbCanvas = drawToCanvas(bitmap, tw, th)
  const thumb = thumbCanvas.toDataURL('image/jpeg', THUMB_QUALITY)

  bitmap.close()
  return { blob, mime, width: w, height: h, thumb }
}

function drawToCanvas(bitmap: ImageBitmap, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, w, h)
  return canvas
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Nie udało się zakodować obrazu'))),
      mime,
      quality,
    )
  })
}

/** Zapisuje przetworzony plik do bazy i zwraca rekord. */
export async function addImageFromFile(
  file: Blob,
  kind: ImageKind,
  links?: { productId?: string; modelId?: string },
): Promise<ImageRecord> {
  const p = await processImage(file)
  const rec: ImageRecord = {
    id: uid(),
    blob: p.blob,
    mime: p.mime,
    width: p.width,
    height: p.height,
    thumb: p.thumb,
    kind,
    productId: links?.productId,
    modelId: links?.modelId,
    createdAt: Date.now(),
  }
  await db.images.add(rec)
  return rec
}

/** Zapisuje obraz wygenerowany przez Gemini (base64). */
export async function addGeneratedImage(
  base64: string,
  mime: string,
  meta: GeneratedImageMeta,
  links?: { productId?: string },
): Promise<ImageRecord> {
  const raw = base64ToBlob(base64, mime)
  const p = await processImage(raw)
  const rec: ImageRecord = {
    id: uid(),
    blob: p.blob,
    mime: p.mime,
    width: p.width,
    height: p.height,
    thumb: p.thumb,
    kind: 'generated',
    productId: links?.productId,
    modelId: meta.modelId,
    meta,
    createdAt: Date.now(),
  }
  await db.images.add(rec)
  return rec
}

export function base64ToBlob(base64: string, mime: string): Blob {
  const clean = base64.includes(',') ? base64.split(',')[1] : base64
  const bytes = atob(clean)
  const arr = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
  return new Blob([arr], { type: mime })
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve(result.split(',')[1] ?? '')
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

export async function getImageBlob(id: string): Promise<Blob | undefined> {
  const rec = await db.images.get(id)
  return rec?.blob
}
