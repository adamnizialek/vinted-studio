import { beforeEach, describe, it, expect, vi } from 'vitest'
import { db, putEntity } from '@/db/db'
import { runSync } from './syncEngine'
import type { RemoteClient } from './remote'
import type { SyncRequest, SyncResponse } from './protocol'

async function clearAll() {
  await Promise.all([
    db.products.clear(),
    db.accounts.clear(),
    db.images.clear(),
    db.outbox.clear(),
    db.sync_meta.clear(),
    db.blob_outbox.clear(),
  ])
}
beforeEach(clearAll)

function fakeRemote(
  response: SyncResponse,
  capture?: (req: SyncRequest) => void,
): RemoteClient {
  return {
    postSync: vi.fn(async (req: SyncRequest) => {
      capture?.(req)
      return response
    }),
    putBlob: vi.fn(async () => {}),
    getBlob: vi.fn(async () => undefined),
  }
}

const account = (id: string) => ({ id, name: 'A', color: '#000', createdAt: 1, updatedAt: 1 })

const product = (id: string, name: string, updatedAt: number) => ({
  id,
  name,
  updatedAt,
  createdAt: 1,
  condition: 'dobry' as const,
  currency: 'PLN',
  quantity: 1,
  status: 'in_stock' as const,
  photoIds: [],
  generatedPhotoIds: [],
  descriptions: [],
  tags: [],
})

describe('runSync — push', () => {
  it('pushes outbox entries, clears them, and advances the cursor', async () => {
    await putEntity('accounts', account('a1'))
    let captured: SyncRequest | undefined
    const remote = fakeRemote({ cursor: 42, ack: { accounts: ['a1'] }, pull: {} }, (r) => {
      captured = r
    })

    const out = await runSync(remote)

    expect(captured?.push?.accounts).toHaveLength(1)
    expect(captured?.push?.accounts?.[0].id).toBe('a1')
    expect(out.pushed).toBe(1)
    expect(await db.outbox.toArray()).toHaveLength(0)
    expect((await db.sync_meta.get('cursor'))?.value).toBe(42)
  })

  it('pushes a tombstone (deleted:1, no data) for a locally deleted row', async () => {
    await putEntity('accounts', account('a1'))
    await db.outbox.clear()
    const { deleteEntity } = await import('@/db/db')
    await deleteEntity('accounts', 'a1')
    let captured: SyncRequest | undefined
    const remote = fakeRemote({ cursor: 1, ack: { accounts: ['a1'] }, pull: {} }, (r) => {
      captured = r
    })

    await runSync(remote)

    expect(captured?.push?.accounts?.[0]).toMatchObject({ id: 'a1', deleted: 1, data: null })
  })
})

describe('runSync — pull', () => {
  it('applies a pulled upsert into Dexie', async () => {
    const remote = fakeRemote({
      cursor: 5,
      ack: {},
      pull: { products: [{ id: 'p1', deleted: 0, updatedAt: 100, data: product('p1', 'Remote', 100) }] },
    })

    await runSync(remote)

    expect((await db.products.get('p1'))?.name).toBe('Remote')
  })

  it('applies a pulled tombstone by deleting the local row', async () => {
    await putEntity('accounts', account('a1'))
    await db.outbox.clear()
    const remote = fakeRemote({
      cursor: 9,
      ack: {},
      // tombstone newer than the local row -> accepted
      pull: { accounts: [{ id: 'a1', deleted: 1, updatedAt: Date.now() + 100000, data: null }] },
    })

    await runSync(remote)

    expect(await db.accounts.get('a1')).toBeUndefined()
  })

  it('does not let an older pulled row clobber a newer local edit (client-side LWW)', async () => {
    await putEntity('products', product('p1', 'Local', 1)) // stamped updatedAt = now (large)
    await db.outbox.clear()
    const remote = fakeRemote({
      cursor: 3,
      ack: {},
      pull: { products: [{ id: 'p1', deleted: 0, updatedAt: 100, data: product('p1', 'StaleRemote', 100) }] },
    })

    await runSync(remote)

    expect((await db.products.get('p1'))?.name).toBe('Local')
  })
})
