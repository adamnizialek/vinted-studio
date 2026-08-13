// Adapter D1/R2 dla protokołu synchronizacji. Wydzielony z trasy `sync.ts`, żeby dało się
// go przetestować na prawdziwym SQLite (patrz d1Store.test.ts) — najważniejszy tu niezmiennik
// to IZOLACJA PRZESTRZENI, a takiego czegoś nie sprawdza się przez wpatrywanie się w kod.

import { SYNC_TABLES, type SyncTable } from '../../../src/sync/core'
import type { PulledRow, StoredRow, SyncStore } from '../../../src/sync/protocol'
import { blobKey, scopedRowId, unscopeRowId } from './space'

// Table names are interpolated into SQL, but ONLY from the SYNC_TABLES whitelist
// (server constant) — never from request input — so there is no injection surface.
//
// Każdy egzemplarz obsługuje JEDNĄ przestrzeń danych (`space`, ustaloną z tokenu przez
// middleware): id wierszy są nią prefiksowane, a każde zapytanie filtruje po kolumnie
// `space`. Właściciel deploymentu ma przestrzeń pustą, więc jego wiersze zostają
// dokładnie takie, jakie były przed wprowadzeniem wieloosobowości.
export class D1Store implements SyncStore {
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
