// Czyste funkcje galerii modelek — grupowanie wygenerowanych zdjec wg modelki
// oraz budowa archiwum ZIP do pobrania (pelna rozdzielczosc). Bez Dexie/React,
// w pelni testowalne; pobieranie blobow wstrzykiwane przez `fetchBlob`.

import type { AiModel, ID, ImageKind } from '@/db/types'
import { createZipFromBlobs, type ZipBlobEntry } from './zip'

/** Lekki opis obrazu galerii (bez bloba — blob doczytujemy dopiero przy pobieraniu). */
export interface GalleryImage {
  id: ID
  kind: ImageKind
  modelId?: ID
  mime: string
  createdAt: number
}

/** Grupa zdjec jednej modelki (model === null → modelka usunieta). */
export interface GalleryGroup {
  model: AiModel | null
  key: string // modelId lub ORPHAN_KEY
  label: string
  images: GalleryImage[]
}

const ORPHAN_KEY = '__orphan__'
const ORPHAN_LABEL = 'Usunięte modelki'

/** Rozszerzenie pliku wg MIME — wyjscie modelu bywa PNG, reszta JPEG (jak w Studio). */
export function extForMime(mime: string): string {
  return mime === 'image/png' ? 'png' : 'jpg'
}

/** Bezpieczna nazwa pliku/katalogu: bez diakrytyków, małe litery, '-' zamiast reszty. */
export function slugifyForFile(name: string | undefined): string {
  const slug = (name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // laczace znaki diakrytyczne (NFD)
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L') // 'ł' nie ma rozkładu NFD — mapujemy ręcznie
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'modelka'
}

/**
 * Grupuje wygenerowane zdjecia (kind:'generated' z modelId) wg modelki. Pomija
 * portrety samej modelki (kind:'model'), referencje (kind:'reference') i zdjecia
 * "czyść tło" (bez modelId). Modelki bez zdjec sa pomijane; zdjecia modelek
 * nieobecnych na liscie (usuniete) trafiaja do jednej grupy osieroconej na koncu.
 * W obrebie grupy: od najnowszych.
 */
export function groupGeneratedByModel(images: GalleryImage[], models: AiModel[]): GalleryGroup[] {
  const byModel = new Map<string, GalleryImage[]>()
  for (const i of images) {
    if (i.kind !== 'generated' || i.modelId == null) continue
    const list = byModel.get(i.modelId)
    if (list) list.push(i)
    else byModel.set(i.modelId, [i])
  }

  const newestFirst = (xs: GalleryImage[]) => [...xs].sort((a, b) => b.createdAt - a.createdAt)

  const groups: GalleryGroup[] = []
  const known = new Set<string>()
  for (const m of models) {
    known.add(m.id)
    const imgs = byModel.get(m.id)
    if (imgs?.length) groups.push({ model: m, key: m.id, label: m.name, images: newestFirst(imgs) })
  }

  const orphan: GalleryImage[] = []
  for (const [key, imgs] of byModel) if (!known.has(key)) orphan.push(...imgs)
  if (orphan.length)
    groups.push({ model: null, key: ORPHAN_KEY, label: ORPHAN_LABEL, images: newestFirst(orphan) })

  return groups
}

/** Unikalne nazwy katalogów per grupa (różnicuje modelki o tej samej nazwie). */
function uniqueFolderSlugs(groups: GalleryGroup[]): string[] {
  const used = new Set<string>()
  return groups.map((g) => {
    const base = slugifyForFile(g.label)
    let candidate = base
    let n = 2
    while (used.has(candidate)) candidate = `${base}-${n++}`
    used.add(candidate)
    return candidate
  })
}

/** Indeks 1-based dopełniony zerami do szerokości liczby `total` (min. 2 cyfry). */
function padIndex(index1: number, total: number): string {
  return String(index1).padStart(Math.max(2, String(total).length), '0')
}

/** Łączna liczba zdjęć we wszystkich grupach. */
export function countImages(groups: GalleryGroup[]): number {
  return groups.reduce((s, g) => s + g.images.length, 0)
}

export interface ZipGalleryOptions {
  groups: GalleryGroup[]
  /** Pobiera pełny blob obrazu (np. `getImageBlob`); `undefined` gdy niedostępny (offline). */
  fetchBlob: (id: ID) => Promise<Blob | undefined>
  onProgress?: (done: number, total: number) => void
}

export interface ZipGalleryResult {
  blob: Blob
  included: number
  skipped: number
}

/**
 * Buduje archiwum ZIP ze zdjec grup. Pliki: `<slug-modelki>/<NN>.<ext>`. Pobiera
 * bloby sekwencyjnie (raportuje postep); pomija te, ktorych nie da sie pobrac.
 * Trzymamy referencje na Bloby (nie bajty), a `createZipFromBlobs` czyta je po
 * jednym — szczytowe zuzycie pamieci ~ jeden obraz, nie cala galeria.
 */
export async function zipGalleryImages(opts: ZipGalleryOptions): Promise<ZipGalleryResult> {
  const { groups, fetchBlob, onProgress } = opts
  const folders = uniqueFolderSlugs(groups)
  const total = countImages(groups)

  const entries: ZipBlobEntry[] = []
  let done = 0
  let skipped = 0
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi]
    const folder = folders[gi]
    const count = group.images.length
    for (let i = 0; i < count; i++) {
      const image = group.images[i]
      const blob = await fetchBlob(image.id)
      done++
      if (blob) {
        entries.push({ name: `${folder}/${padIndex(i + 1, count)}.${extForMime(image.mime)}`, blob })
      } else {
        skipped++
      }
      onProgress?.(done, total)
    }
  }

  return { blob: await createZipFromBlobs(entries), included: entries.length, skipped }
}
