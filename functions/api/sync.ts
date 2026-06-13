// POST /api/sync — push (last-write-wins) + pull in one round trip, backed by D1.
// The decision logic lives in src/sync/protocol.ts (unit-tested with an in-memory store);
// this file is just the D1/R2 adapter.

import { SYNC_TABLES, type SyncTable } from '../../src/sync/core'
import {
  processSync,
  type PulledRow,
  type StoredRow,
  type SyncRequest,
  type SyncStore,
} from '../../src/sync/protocol'

interface Env {
  DB: D1Database
  BUCKET: R2Bucket
  SYNC_TOKEN: string
}

// Table names are interpolated into SQL, but ONLY from the SYNC_TABLES whitelist
// (server constant) — never from request input — so there is no injection surface.
class D1Store implements SyncStore {
  constructor(
    private db: D1Database,
    private bucket: R2Bucket,
  ) {}

  async maxStamp(): Promise<number> {
    const union = SYNC_TABLES.map((t) => `SELECT MAX(sync_stamp) AS s FROM ${t}`).join(
      ' UNION ALL ',
    )
    const row = await this.db.prepare(`SELECT MAX(s) AS m FROM (${union})`).first<{
      m: number | null
    }>()
    return row?.m ?? 0
  }

  async getContentUpdatedAt(table: SyncTable, id: string): Promise<number | undefined> {
    const row = await this.db
      .prepare(`SELECT content_updated_at AS c FROM ${table} WHERE id = ?`)
      .bind(id)
      .first<{ c: number }>()
    return row?.c
  }

  async upsert(table: SyncTable, id: string, r: StoredRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO ${table} (id, sync_stamp, content_updated_at, deleted, data)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
           sync_stamp = ?2, content_updated_at = ?3, deleted = ?4, data = ?5`,
      )
      .bind(id, r.syncStamp, r.contentUpdatedAt, r.deleted, r.data)
      .run()
  }

  async rowsSince(cursor: number): Promise<Partial<Record<SyncTable, PulledRow[]>>> {
    const out: Partial<Record<SyncTable, PulledRow[]>> = {}
    for (const t of SYNC_TABLES) {
      const res = await this.db
        .prepare(
          `SELECT id, content_updated_at AS c, deleted, data FROM ${t}
           WHERE sync_stamp > ? ORDER BY sync_stamp`,
        )
        .bind(cursor)
        .all<{ id: string; c: number; deleted: number; data: string }>()
      if (res.results.length) {
        out[t] = res.results.map((r) => ({
          id: r.id,
          deleted: (r.deleted ? 1 : 0) as 0 | 1,
          updatedAt: r.c,
          data: JSON.parse(r.data),
        }))
      }
    }
    return out
  }

  async onImageTombstone(id: string): Promise<void> {
    await this.bucket.delete(`images/${id}`)
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  let req: SyncRequest
  try {
    req = (await ctx.request.json()) as SyncRequest
  } catch {
    return json({ error: 'invalid json' }, 400)
  }
  if (typeof req?.cursor !== 'number') return json({ error: 'missing cursor' }, 400)

  const store = new D1Store(ctx.env.DB, ctx.env.BUCKET)
  const res = await processSync(store, req, Date.now())
  return json(res)
}
