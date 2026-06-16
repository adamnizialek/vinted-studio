import { putEntity } from '@/db/db'
import type { GeneratedImageMeta, ImageKind, ImageRecord } from '@/db/types'
import { uid } from './id'
import { enqueueBlobUpload, getBlob } from '@/sync/blobSync'
import { currentRemote } from '@/sync/config'

const MAX_DIM = 1600 // maks. dluzszy bok PRZESKALOWANEGO zdjecia zrodlowego (px)
const THUMB_DIM = 320 // dluzszy bok miniatury (px)
const JPEG_QUALITY = 0.92
const THUMB_QUALITY = 0.72

/**
 * Rodzaje obrazow bedacych PLATNYM wyjsciem modelu (Gemini): zapisujemy je w
 * pelnej rozdzielczosci, bez przeskalowania i bez ponownej kompresji — inaczej
 * zniszczylibysmy 2K/4K, za ktore uzytkownik zaplacil (i zlamali regule >=2K
 * wymuszona przez ban Vinted na zdjeciach niskiej rozdzielczosci). Zdjecia
 * zrodlowe (upload uzytkownika) wciaz skalujemy, by ograniczyc rozmiar bazy.
 */
const RESOLUTION_PRESERVING_KINDS: ReadonlySet<ImageKind> = new Set<ImageKind>([
  'generated',
  'model',
])

export function preservesResolution(kind: ImageKind): boolean {
  return RESOLUTION_PRESERVING_KINDS.has(kind)
}

/** Skaluje (wylacznie w dol) dluzszy bok do `maxDim`, zachowujac proporcje. */
export function fitWithin(
  width: number,
  height: number,
  maxDim: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxDim / Math.max(width, height))
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

interface ProcessedImage {
  blob: Blob
  mime: string
  width: number
  height: number
  thumb: string
}

/**
 * Wczytuje plik/blob, obraca wg EXIF i tworzy miniature.
 *
 * Domyslnie skaluje glowny obraz do `MAX_DIM` i koduje go ponownie (oszczedza
 * miejsce dla zdjec zrodlowych). Gdy `preserveResolution` = true, zapisuje
 * ORYGINALNE bajty bez zmian — pelna rozdzielczosc i zero strat jakosci dla
 * platnego wyjscia modelu; tworzy wtedy wylacznie osobna miniature.
 */
export async function processImage(
  source: Blob,
  opts: { preserveResolution?: boolean } = {},
): Promise<ProcessedImage> {
  const bitmap = await createImageBitmap(source, {
    imageOrientation: 'from-image',
  }).catch(() => createImageBitmap(source))

  try {
    const thumb = makeThumb(bitmap)

    if (opts.preserveResolution) {
      // Nie dotykamy bajtow — przechowujemy dokladnie to, co zwrocil model.
      // INWARIANT: tej sciezki uzywamy tylko dla wyjscia modelu (generated/model),
      // ktore nie ma orientacji EXIF. width/height bierzemy z bitmapy (z orientacja),
      // wiec dla zdjecia z EXIF orientation byloby zamienione osiami — nie dotyczy
      // wyjscia Gemini. Uploady uzytkownika ida zawsze sciezka downscale ponizej.
      return {
        blob: source,
        mime: source.type || 'image/png',
        width: bitmap.width,
        height: bitmap.height,
        thumb,
      }
    }

    const { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_DIM)
    const main = drawToCanvas(bitmap, width, height)
    const hasAlpha = source.type === 'image/png'
    const mime = hasAlpha ? 'image/png' : 'image/jpeg'
    const blob = await canvasToBlob(main, mime, JPEG_QUALITY)
    return { blob, mime, width, height, thumb }
  } finally {
    bitmap.close()
  }
}

/** Buduje mala miniature (zawsze JPEG) z pelnej bitmapy. */
function makeThumb(bitmap: ImageBitmap): string {
  const { width, height } = fitWithin(bitmap.width, bitmap.height, THUMB_DIM)
  const canvas = drawToCanvas(bitmap, Math.max(1, width), Math.max(1, height))
  return canvas.toDataURL('image/jpeg', THUMB_QUALITY)
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
  links?: { productId?: string; modelId?: string; designId?: string },
): Promise<ImageRecord> {
  const p = await processImage(file, { preserveResolution: preservesResolution(kind) })
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
    designId: links?.designId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const saved = await putEntity('images', rec)
  await enqueueBlobUpload(saved.id)
  return saved
}

/** Zapisuje obraz wygenerowany przez Gemini (base64). */
export async function addGeneratedImage(
  base64: string,
  mime: string,
  meta: GeneratedImageMeta,
  links?: { productId?: string },
): Promise<ImageRecord> {
  const raw = base64ToBlob(base64, mime)
  // Wyjscie modelu jest platne — zapisujemy je w pelnej rozdzielczosci, bez strat.
  const p = await processImage(raw, { preserveResolution: true })
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
    updatedAt: Date.now(),
  }
  const saved = await putEntity('images', rec)
  await enqueueBlobUpload(saved.id)
  return saved
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

/**
 * Pelny blob obrazu. Jesli nie ma go lokalnie (rekord przyszedl z synchronizacji),
 * doczytuje go leniwie z R2 i buforuje. Zwraca undefined, gdy nie da sie pobrac.
 */
export async function getImageBlob(id: string): Promise<Blob | undefined> {
  return getBlob(id, currentRemote())
}
