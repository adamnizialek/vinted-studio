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
import { blobKey, scopedRowId, unscopeRowId, type SpaceEnv } from './_lib/space'
import type { SyncData } from './_middleware'

interface Env extends SpaceEnv {
  DB: D1Database
  BUCKET: R2Bucket
}

// Table names are interpolated into SQL, but ONLY from the SYNC_TABLES whitelist
// (server constant) — never from request input — so there is no injection surface.
//
// Każdy egzemplarz obsługuje JEDNĄ przestrzeń danych (`space`, ustaloną z tokenu przez
// middleware): id wierszy są nią prefiksowane, a każde zapytanie filtruje po kolumnie
// `space`. Właściciel deploymentu ma przestrzeń pustą, więc jego wiersze zostają
// dokładnie takie, jakie były przed wprowadzeniem wieloosobowości.
class D1Store implements SyncStore {
  constructor(
    private db: D1Database,
    private bucket: R2Bucket,
    private space: string,
  ) {}

  async maxStamp(): Promise<number> {
    // One MAX(sync_stamp) per table, batched into a single round trip. (A UNION ALL
    // across every table trips D1's "too many terms in compound SELECT" limit.)
    let max = 0
    const stmt = (t: SyncTable) =>
      this.db.prepare(`SELECT MAX(sync_stamp) AS s FROM ${t} WHERE space = ?`).bind(this.space)
    try {
      const results = await this.db.batch<{ s: number | null }>(SYNC_TABLES.map(stmt))
      for (const r of results) {
        const s = r.results[0]?.s
        if (s != null) max = Math.max(max, s)
      }
      return max
    } catch {
      // Okno wdrożenia: klient z nową tabelą w SYNC_TABLES (np. `expenses`) wysłany PRZED
      // migracją D1 (0002). Batch padłby na brakującej tabeli i zerwał CAŁY sync — degraduj
      // łagodnie, odpytując tabele pojedynczo i pomijając te, których jeszcze nie ma.
      for (const t of SYNC_TABLES) {
        try {
          const r = await stmt(t).first<{ s: number | null }>()
          if (r?.s != null) max = Math.max(max, r.s)
        } catch {
          // tabela jeszcze nie istnieje — pomiń
        }
      }
      return max
    }
  }

  async getContentUpdatedAt(table: SyncTable, id: string): Promise<number | undefined> {
    const row = await this.db
      .prepare(`SELECT content_updated_at AS c FROM ${table} WHERE id = ?`)
      .bind(scopedRowId(this.space, id))
      .first<{ c: number }>()
    return row?.c
  }

  async upsert(table: SyncTable, id: string, r: StoredRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO ${table} (id, space, sync_stamp, content_updated_at, deleted, data)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
           space = ?2, sync_stamp = ?3, content_updated_at = ?4, deleted = ?5, data = ?6`,
      )
      .bind(
        scopedRowId(this.space, id),
        this.space,
        r.syncStamp,
        r.contentUpdatedAt,
        r.deleted,
        r.data,
      )
      .run()
  }

  async rowsSince(cursor: number): Promise<Partial<Record<SyncTable, PulledRow[]>>> {
    const out: Partial<Record<SyncTable, PulledRow[]>> = {}
    for (const t of SYNC_TABLES) {
      try {
        const res = await this.db
          .prepare(
            `SELECT id, content_updated_at AS c, deleted, data FROM ${t}
             WHERE space = ? AND sync_stamp > ? ORDER BY sync_stamp`,
          )
          .bind(this.space, cursor)
          .all<{ id: string; c: number; deleted: number; data: string }>()
        if (res.results.length) {
          out[t] = res.results.map((r) => ({
            id: unscopeRowId(this.space, r.id),
            deleted: (r.deleted ? 1 : 0) as 0 | 1,
            updatedAt: r.c,
            data: JSON.parse(r.data),
          }))
        }
      } catch {
        // Tabela jeszcze nie istnieje (okno wdrożenia przed migracją) — pomiń;
        // zsynchronizuje się po zastosowaniu migracji D1.
      }
    }
    return out
  }

  async onImageTombstone(id: string): Promise<void> {
    await this.bucket.delete(blobKey(this.space, id))
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export const onRequestPost: PagesFunction<Env, string, SyncData> = async (ctx) => {
  let req: SyncRequest
  try {
    req = (await ctx.request.json()) as SyncRequest
  } catch {
    return json({ error: 'invalid json' }, 400)
  }
  if (typeof req?.cursor !== 'number') return json({ error: 'missing cursor' }, 400)

  // `space` pochodzi WYŁĄCZNIE z tokenu sprawdzonego w _middleware — nigdy z treści żądania.
  const store = new D1Store(ctx.env.DB, ctx.env.BUCKET, ctx.data.space)
  const res = await processSync(store, req, Date.now())
  return json(res)
}
