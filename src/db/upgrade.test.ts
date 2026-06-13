import { describe, it, expect } from 'vitest'
import Dexie from 'dexie'

const DB_NAME = 'vinted-studio'

describe('Dexie v1 -> v2 upgrade', () => {
  it('backfills updatedAt from createdAt and adds outbox + sync_meta, without data loss', async () => {
    // 1) Create a v1 database with the original schema and rows that lack updatedAt.
    const v1 = new Dexie(DB_NAME)
    v1.version(1).stores({
      products:
        'id, status, accountId, brand, category, createdAt, updatedAt, soldAt, *tags',
      models: 'id, createdAt, updatedAt',
      accounts: 'id, createdAt',
      sales: 'id, accountId, productId, soldAt, status, createdAt',
      images: 'id, kind, productId, modelId, createdAt',
      settings: 'id',
    })
    await v1.open()
    await v1.table('accounts').put({ id: 'a1', name: 'Old', color: '#000', createdAt: 12345 })
    await v1.table('images').put({
      id: 'i1',
      mime: 'image/jpeg',
      width: 1,
      height: 1,
      thumb: 't',
      kind: 'product',
      createdAt: 999,
    })
    v1.close()

    // 2) Open via the real module (v1 + v2 declared) -> triggers the upgrade.
    const { db } = await import('@/db/db')
    await db.open()

    const acc = await db.accounts.get('a1')
    expect(acc?.name).toBe('Old') // no data loss
    expect(acc?.updatedAt).toBe(12345) // backfilled from createdAt

    const img = await db.images.get('i1')
    expect(img?.updatedAt).toBe(999)

    // New tables exist and are usable.
    await db.outbox.put({ table: 'accounts', id: 'x', deleted: 0, updatedAt: 1 })
    expect(await db.outbox.toArray()).toHaveLength(1)
    await db.sync_meta.put({ key: 'cursor', value: 42 })
    expect((await db.sync_meta.get('cursor'))?.value).toBe(42)
  })
})
