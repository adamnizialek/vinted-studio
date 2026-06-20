// Image blob sync. Binaries live in R2; metadata + thumbnail live in D1/Dexie.
// - enqueueBlobUpload/flushUploads: push locally-created blobs to R2.
// - getBlob: return the local cached blob, or lazily fetch it from R2 and cache it.

import { db } from '@/db/db'
import type { RemoteClient } from './remote'

/** Mark a freshly-created image's blob as needing upload (device-local queue). */
export async function enqueueBlobUpload(id: string): Promise<void> {
  await db.blob_outbox.put({ id })
}

/** Upload every queued blob to R2; clear the queue entry on success. */
export async function flushUploads(remote: RemoteClient): Promise<void> {
  const pending = await db.blob_outbox.toArray()
  for (const { id } of pending) {
    const rec = await db.images.get(id)
    if (!rec?.blob) {
      // No local blob to upload (already removed / never had one) — drop the entry.
      await db.blob_outbox.delete(id)
      continue
    }
    await remote.putBlob(id, rec.blob)
    await db.blob_outbox.delete(id)
  }
}

/**
 * Full image bytes: the local cached blob if present, otherwise a lazy fetch from R2
 * (cached back into Dexie so the next read is local). Caching does NOT enqueue an upload.
 * Returns undefined when there is no local copy and no remote (offline / sync off).
 */
export async function getBlob(
  id: string,
  remote: RemoteClient | null,
): Promise<Blob | undefined> {
  const rec = await db.images.get(id)
  // Tylko NIEPUSTY lokalny blob jest uzyteczny. Pusty (0 B) bufor — np. zatruty
  // wczesniej degeneracyjna odpowiedzia 200 — traktujemy jak brak, by sprobowac
  // ponownie z R2 zamiast na stale zwracac nierenderowalny obraz.
  if (rec?.blob && rec.blob.size > 0) return rec.blob
  if (!rec || !remote) return undefined
  const blob = await remote.getBlob(id)
  // Nie buforuj i nie zwracaj pustej odpowiedzi — inaczej 0 B utrwaliloby sie
  // lokalnie i blokowalo kazda kolejna probe pobrania (early-return powyzej).
  if (blob && blob.size > 0) {
    await db.images.update(id, { blob }) // cache; bypasses outbox/blob_outbox
    return blob
  }
  return undefined
}
