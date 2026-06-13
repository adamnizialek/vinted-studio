import { beforeEach, describe, it, expect, vi } from 'vitest'
import { db, putEntity } from '@/db/db'
import type { ImageRecord } from '@/db/types'
import { enqueueBlobUpload, flushUploads, getBlob } from './blobSync'
import type { RemoteClient } from './remote'

async function clearAll() {
  await Promise.all([db.images.clear(), db.outbox.clear(), db.blob_outbox.clear()])
}
beforeEach(clearAll)

const fakeRemote = (over: Partial<RemoteClient> = {}): RemoteClient => ({
  postSync: vi.fn(),
  putBlob: vi.fn(async () => {}),
  getBlob: vi.fn(async () => undefined),
  ...over,
})

const imageWithBlob = (id: string): ImageRecord => ({
  id,
  blob: new Blob(['bytes'], { type: 'image/jpeg' }),
  mime: 'image/jpeg',
  width: 1,
  height: 1,
  thumb: 't',
  kind: 'product',
  createdAt: 1,
  updatedAt: 1,
})

describe('flushUploads', () => {
  it('uploads queued blobs and clears the queue', async () => {
    await putEntity('images', imageWithBlob('i1'))
    await enqueueBlobUpload('i1')
    const remote = fakeRemote()

    await flushUploads(remote)

    expect(remote.putBlob).toHaveBeenCalledOnce()
    expect((remote.putBlob as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('i1')
    expect(await db.blob_outbox.toArray()).toHaveLength(0)
  })

  it('keeps the queue entry if the upload fails', async () => {
    await putEntity('images', imageWithBlob('i1'))
    await enqueueBlobUpload('i1')
    const remote = fakeRemote({
      putBlob: vi.fn(async () => {
        throw new Error('boom')
      }),
    })

    await expect(flushUploads(remote)).rejects.toThrow()
    expect(await db.blob_outbox.toArray()).toHaveLength(1)
  })
})

describe('getBlob', () => {
  it('returns the local blob without hitting the network', async () => {
    await putEntity('images', imageWithBlob('i1'))
    const remote = fakeRemote()
    const blob = await getBlob('i1', remote)
    expect(await blob!.text()).toBe('bytes')
    expect(remote.getBlob).not.toHaveBeenCalled()
  })

  it('lazily fetches from R2 and caches locally when the blob is missing', async () => {
    // Metadata-only row (arrived from another device — no blob).
    await db.images.put({ ...imageWithBlob('i2'), blob: undefined })
    const remote = fakeRemote({
      getBlob: vi.fn(async () => new Blob(['fetched'], { type: 'image/jpeg' })),
    })

    const blob = await getBlob('i2', remote)

    expect(await blob!.text()).toBe('fetched')
    expect(remote.getBlob).toHaveBeenCalledOnce()
    const cached = await db.images.get('i2')
    expect(await cached!.blob!.text()).toBe('fetched') // cached for next time
    // Caching must not enqueue an upload (it came FROM the server).
    expect(await db.blob_outbox.toArray()).toHaveLength(0)
  })

  it('returns undefined when offline (no remote) and no local blob', async () => {
    await db.images.put({ ...imageWithBlob('i3'), blob: undefined })
    expect(await getBlob('i3', null)).toBeUndefined()
  })
})
