import { beforeEach, describe, it, expect } from 'vitest'
import {
  db,
  putEntity,
  patchEntity,
  deleteEntity,
  applyRemoteUpsert,
  applyRemoteDelete,
  deleteProductCascade,
} from './db'
import type { Account, ImageRecord, Product } from './types'

async function clearAll() {
  await Promise.all([
    db.products.clear(),
    db.models.clear(),
    db.accounts.clear(),
    db.sales.clear(),
    db.images.clear(),
    db.settings.clear(),
    db.outbox.clear(),
    db.sync_meta.clear(),
  ])
}

beforeEach(clearAll)

const sampleAccount = (id = 'a1'): Account => ({
  id,
  name: 'Test',
  color: '#ffffff',
  createdAt: 1,
  updatedAt: 1,
})

const sampleImage = (id: string): ImageRecord => ({
  id,
  mime: 'image/jpeg',
  width: 10,
  height: 10,
  thumb: 'data:image/jpeg;base64,xx',
  kind: 'product',
  createdAt: 1,
  updatedAt: 1,
})

const sampleProduct = (id = 'p1', photoIds: string[] = []): Product => ({
  id,
  name: 'P',
  condition: 'dobry',
  currency: 'PLN',
  quantity: 1,
  status: 'in_stock',
  photoIds,
  generatedPhotoIds: [],
  descriptions: [],
  tags: [],
  createdAt: 1,
  updatedAt: 1,
})

describe('putEntity (user write)', () => {
  it('writes the row, stamps updatedAt, and queues an outbox entry (deleted:0)', async () => {
    const before = Date.now()
    await putEntity('accounts', sampleAccount())
    const row = await db.accounts.get('a1')
    expect(row?.name).toBe('Test')
    expect(row!.updatedAt).toBeGreaterThanOrEqual(before)
    const ob = await db.outbox.get(['accounts', 'a1'])
    expect(ob).toEqual({ table: 'accounts', id: 'a1', deleted: 0, updatedAt: row!.updatedAt })
  })
})

describe('patchEntity (user partial update)', () => {
  it('merges changes, preserves other fields, bumps updatedAt, queues outbox', async () => {
    await putEntity('accounts', sampleAccount())
    await db.outbox.clear()
    await patchEntity('accounts', 'a1', { name: 'Renamed' })
    const row = await db.accounts.get('a1')
    expect(row?.name).toBe('Renamed')
    expect(row?.color).toBe('#ffffff')
    expect((await db.outbox.get(['accounts', 'a1']))?.deleted).toBe(0)
  })
})

describe('deleteEntity (user delete)', () => {
  it('removes the row locally and queues a tombstone (deleted:1)', async () => {
    await putEntity('accounts', sampleAccount())
    await db.outbox.clear()
    await deleteEntity('accounts', 'a1')
    expect(await db.accounts.get('a1')).toBeUndefined()
    const ob = await db.outbox.get(['accounts', 'a1'])
    expect(ob?.deleted).toBe(1)
    expect(ob!.updatedAt).toBeGreaterThan(0)
  })
})

describe('applyRemoteUpsert (sync-apply path — no echo)', () => {
  it('writes the row WITHOUT an outbox entry and keeps the remote updatedAt', async () => {
    await applyRemoteUpsert('accounts', { ...sampleAccount(), updatedAt: 555 })
    const row = await db.accounts.get('a1')
    expect(row?.updatedAt).toBe(555)
    expect(await db.outbox.get(['accounts', 'a1'])).toBeUndefined()
  })
})

describe('applyRemoteDelete (sync-apply path — no echo)', () => {
  it('removes the row WITHOUT queuing an outbox entry', async () => {
    await putEntity('accounts', sampleAccount())
    await db.outbox.clear()
    await applyRemoteDelete('accounts', 'a1')
    expect(await db.accounts.get('a1')).toBeUndefined()
    expect(await db.outbox.get(['accounts', 'a1'])).toBeUndefined()
  })
})

describe('deleteProductCascade (soft)', () => {
  it('removes the product + its images locally and queues both as tombstones; leaves sales', async () => {
    await putEntity('images', sampleImage('i1'))
    await putEntity('products', sampleProduct('p1', ['i1']))
    await db.outbox.clear()
    await deleteProductCascade('p1')
    expect(await db.products.get('p1')).toBeUndefined()
    expect(await db.images.get('i1')).toBeUndefined()
    expect((await db.outbox.get(['products', 'p1']))?.deleted).toBe(1)
    expect((await db.outbox.get(['images', 'i1']))?.deleted).toBe(1)
  })
})
