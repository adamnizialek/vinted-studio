import { beforeEach, describe, it, expect } from 'vitest'
import {
  processSync,
  type PulledRow,
  type StoredRow,
  type SyncStore,
} from './protocol'
import type { SyncTable } from './core'

/** In-memory SyncStore mirroring the D1 envelope tables. */
class MemoryStore implements SyncStore {
  rows = new Map<string, StoredRow & { table: SyncTable; id: string }>()
  tombstonedBlobs: string[] = []

  private key(table: SyncTable, id: string) {
    return `${table}:${id}`
  }

  async maxStamp() {
    let m = 0
    for (const r of this.rows.values()) m = Math.max(m, r.syncStamp)
    return m
  }

  async getContentUpdatedAt(table: SyncTable, id: string) {
    return this.rows.get(this.key(table, id))?.contentUpdatedAt
  }

  async upsert(table: SyncTable, id: string, row: StoredRow) {
    this.rows.set(this.key(table, id), { ...row, table, id })
  }

  async rowsSince(cursor: number) {
    const out: Partial<Record<SyncTable, PulledRow[]>> = {}
    for (const r of this.rows.values()) {
      if (r.syncStamp <= cursor) continue
      ;(out[r.table] ??= []).push({
        id: r.id,
        deleted: r.deleted,
        updatedAt: r.contentUpdatedAt,
        data: JSON.parse(r.data),
      })
    }
    return out
  }

  async onImageTombstone(id: string) {
    this.tombstonedBlobs.push(id)
  }
}

let store: MemoryStore
beforeEach(() => {
  store = new MemoryStore()
})

describe('processSync — push', () => {
  it('accepts a new row, assigns a stamp, and acks it', async () => {
    const res = await processSync(
      store,
      { cursor: 0, push: { accounts: [{ id: 'a1', deleted: 0, updatedAt: 100, data: { name: 'A' } }] } },
      1000,
    )
    expect(res.ack.accounts).toEqual(['a1'])
    expect(await store.getContentUpdatedAt('accounts', 'a1')).toBe(100)
    expect(res.cursor).toBeGreaterThan(0)
  })

  it('skips a push older than the stored row (acks but does not overwrite)', async () => {
    await store.upsert('accounts', 'a1', {
      syncStamp: 5,
      contentUpdatedAt: 200,
      deleted: 0,
      data: JSON.stringify({ name: 'newer' }),
    })
    const res = await processSync(
      store,
      { cursor: 0, push: { accounts: [{ id: 'a1', deleted: 0, updatedAt: 100, data: { name: 'older' } }] } },
      1000,
    )
    expect(res.ack.accounts).toEqual(['a1']) // processed
    const row = store.rows.get('accounts:a1')!
    expect(JSON.parse(row.data).name).toBe('newer') // not clobbered
  })

  it('deletes the R2 blob when an image tombstone is accepted', async () => {
    const res = await processSync(
      store,
      { cursor: 0, push: { images: [{ id: 'i1', deleted: 1, updatedAt: 100, data: null }] } },
      1000,
    )
    expect(res.ack.images).toEqual(['i1'])
    expect(store.tombstonedBlobs).toEqual(['i1'])
  })

  it('assigns strictly-increasing stamps even within the same millisecond', async () => {
    await processSync(
      store,
      {
        cursor: 0,
        push: {
          accounts: [
            { id: 'a1', deleted: 0, updatedAt: 100, data: {} },
            { id: 'a2', deleted: 0, updatedAt: 100, data: {} },
          ],
        },
      },
      1000,
    )
    const s1 = store.rows.get('accounts:a1')!.syncStamp
    const s2 = store.rows.get('accounts:a2')!.syncStamp
    expect(s2).toBeGreaterThan(s1)
  })
})

describe('processSync — pull', () => {
  it('returns rows changed since the cursor (including tombstones) and advances the cursor', async () => {
    await store.upsert('products', 'p1', {
      syncStamp: 10,
      contentUpdatedAt: 100,
      deleted: 0,
      data: JSON.stringify({ name: 'P1' }),
    })
    await store.upsert('products', 'p2', {
      syncStamp: 20,
      contentUpdatedAt: 200,
      deleted: 1,
      data: JSON.stringify(null),
    })
    const res = await processSync(store, { cursor: 15 }, 1000)
    expect(res.pull.products?.map((r) => r.id)).toEqual(['p2'])
    expect(res.pull.products?.[0].deleted).toBe(1)
    expect(res.cursor).toBe(20)
  })

  it('returns everything for a fresh client (cursor 0)', async () => {
    await store.upsert('accounts', 'a1', {
      syncStamp: 7,
      contentUpdatedAt: 100,
      deleted: 0,
      data: JSON.stringify({ name: 'A' }),
    })
    const res = await processSync(store, { cursor: 0 }, 1000)
    expect(res.pull.accounts).toHaveLength(1)
    expect(res.pull.accounts?.[0].data).toEqual({ name: 'A' })
  })
})
