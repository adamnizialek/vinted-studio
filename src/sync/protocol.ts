// Server-side sync protocol — pure logic over an injected store, so it can be
// unit-tested with an in-memory store and reused by the D1-backed Pages Function.

import { SYNC_TABLES, type SyncTable, lwwAccepts, nextStamp } from './core'

/** A row as pushed by the client. */
export interface PushRow {
  id: string
  deleted: 0 | 1
  updatedAt: number
  data: unknown
}

/** A row returned to the client in the pull. */
export interface PulledRow {
  id: string
  deleted: 0 | 1
  updatedAt: number
  data: unknown
}

export interface SyncRequest {
  /** Client's last sync_stamp high-water mark (exclusive lower bound for the pull). */
  cursor: number
  push?: Partial<Record<SyncTable, PushRow[]>>
}

export interface SyncResponse {
  /** New high-water mark the client should store. */
  cursor: number
  /** Ids the server processed this push (accepted OR skipped). */
  ack: Partial<Record<SyncTable, string[]>>
  /** Rows with sync_stamp > request.cursor (including tombstones). */
  pull: Partial<Record<SyncTable, PulledRow[]>>
}

/** A persisted envelope row (mirror of the D1 columns). `data` is a JSON string. */
export interface StoredRow {
  syncStamp: number
  contentUpdatedAt: number
  deleted: 0 | 1
  data: string
}

/** Storage abstraction implemented by the D1-backed Function and the test in-memory store. */
export interface SyncStore {
  /** Highest sync_stamp across all tables (0 if empty). */
  maxStamp(): Promise<number>
  /** Stored content_updated_at for a row, or undefined if absent. */
  getContentUpdatedAt(table: SyncTable, id: string): Promise<number | undefined>
  /** Insert or replace an envelope row. */
  upsert(table: SyncTable, id: string, row: StoredRow): Promise<void>
  /** All rows with sync_stamp > cursor, grouped by table (data already parsed). */
  rowsSince(cursor: number): Promise<Partial<Record<SyncTable, PulledRow[]>>>
  /** Side effect when an image tombstone is accepted — delete the R2 blob. */
  onImageTombstone(id: string): Promise<void>
}

/**
 * Apply a client's push (last-write-wins) then return everything changed since the
 * client's cursor. `now` is the server wall clock (injected for deterministic tests).
 */
export async function processSync(
  store: SyncStore,
  req: SyncRequest,
  now: number,
): Promise<SyncResponse> {
  const ack: Partial<Record<SyncTable, string[]>> = {}
  let stamp = await store.maxStamp()

  for (const table of SYNC_TABLES) {
    const rows = req.push?.[table]
    if (!rows?.length) continue
    for (const row of rows) {
      ;(ack[table] ??= []).push(row.id)
      const stored = await store.getContentUpdatedAt(table, row.id)
      if (!lwwAccepts(row.updatedAt, stored)) continue
      stamp = nextStamp(stamp, now)
      await store.upsert(table, row.id, {
        syncStamp: stamp,
        contentUpdatedAt: row.updatedAt,
        deleted: row.deleted,
        data: JSON.stringify(row.data ?? null),
      })
      if (table === 'images' && row.deleted === 1) await store.onImageTombstone(row.id)
    }
  }

  const pull = await store.rowsSince(req.cursor)
  const cursor = await store.maxStamp()
  return { cursor, ack, pull }
}
