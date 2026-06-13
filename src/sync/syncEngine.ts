// Bidirectional delta sync: push the outbox, pull deltas, apply with client-side
// last-write-wins, clear acked outbox entries, advance the cursor — all in one round
// trip. Depends only on the RemoteClient interface, so it is testable with a fake.

import { applyRemoteDelete, applyRemoteUpsert, db } from '@/db/db'
import { SYNC_TABLES, lwwAccepts, type SyncTable } from './core'
import type { PushRow } from './protocol'
import type { RemoteClient } from './remote'
import { stripForPush } from './serialize'

const CURSOR_KEY = 'cursor'
const SEEDED_KEY = 'seeded'

/**
 * One-time migration: enqueue every existing local row (and image blob) so the data
 * created before sync was enabled gets pushed to the cloud. Idempotent — guarded by a
 * 'seeded' flag, and re-queuing is harmless (server LWW skips ties).
 */
export async function seedOutbox(): Promise<void> {
  const flag = await db.sync_meta.get(SEEDED_KEY)
  if (flag?.value) return
  const fallback = Date.now()
  for (const table of SYNC_TABLES) {
    const ids = (await db.table(table).toCollection().primaryKeys()) as string[]
    for (const id of ids) {
      const rec = (await db.table(table).get(id)) as { updatedAt?: number } | undefined
      await db.outbox.put({ table, id, deleted: 0, updatedAt: rec?.updatedAt ?? fallback })
    }
  }
  const imageIds = (await db.images.toCollection().primaryKeys()) as string[]
  for (const id of imageIds) {
    const img = await db.images.get(id)
    if (img?.blob) await db.blob_outbox.put({ id })
  }
  await db.sync_meta.put({ key: SEEDED_KEY, value: true })
}

// applyRemoteUpsert is generic on a literal table; the engine works with the union,
// so route through a non-generic alias (runtime branches on the table string anyway).
const upsert = applyRemoteUpsert as unknown as (
  table: SyncTable,
  rec: unknown,
) => Promise<void>

async function getCursor(): Promise<number> {
  const m = await db.sync_meta.get(CURSOR_KEY)
  return typeof m?.value === 'number' ? m.value : 0
}

async function setCursor(value: number): Promise<void> {
  await db.sync_meta.put({ key: CURSOR_KEY, value })
}

export interface SyncOutcome {
  pushed: number
  pulled: number
  cursor: number
}

/** Run one push+pull round trip. Throws (SyncError) on transport failure. */
export async function runSync(remote: RemoteClient): Promise<SyncOutcome> {
  const cursor = await getCursor()

  // 1) Build the push from the outbox. Snapshot entries to safely clear them later.
  const snapshot = await db.outbox.toArray()
  const push: Partial<Record<SyncTable, PushRow[]>> = {}
  for (const e of snapshot) {
    let row: PushRow
    if (e.deleted === 1) {
      row = { id: e.id, deleted: 1, updatedAt: e.updatedAt, data: null }
    } else {
      const rec = (await db.table(e.table).get(e.id)) as Record<string, unknown> | undefined
      if (!rec) continue // row vanished without a tombstone — nothing to push
      row = {
        id: e.id,
        deleted: 0,
        updatedAt: rec.updatedAt as number,
        data: stripForPush(e.table, rec),
      }
    }
    ;(push[e.table] ??= []).push(row)
  }

  // 2) One round trip.
  const res = await remote.postSync({ cursor, push })

  // 3) Apply pulled rows with client-side LWW (protects unsynced local edits).
  let pulled = 0
  for (const table of SYNC_TABLES) {
    const rows = res.pull[table]
    if (!rows) continue
    for (const r of rows) {
      const local = (await db.table(table).get(r.id)) as { updatedAt?: number } | undefined
      if (!lwwAccepts(r.updatedAt, local?.updatedAt)) continue
      if (r.deleted === 1) {
        await applyRemoteDelete(table, r.id)
        await db.blob_outbox.delete(r.id)
      } else {
        await upsert(table, { ...(r.data as object), id: r.id, updatedAt: r.updatedAt })
      }
      pulled++
    }
  }

  // 4) Clear outbox entries unchanged since the push snapshot (a row edited mid-sync
  //    will differ and stay queued for the next push).
  for (const e of snapshot) {
    const cur = await db.outbox.get([e.table, e.id])
    if (cur && cur.deleted === e.deleted && cur.updatedAt === e.updatedAt) {
      await db.outbox.delete([e.table, e.id])
    }
  }

  // 5) Advance the cursor only after everything applied successfully.
  await setCursor(res.cursor)
  return { pushed: snapshot.length, pulled, cursor: res.cursor }
}
