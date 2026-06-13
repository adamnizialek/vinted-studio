import { afterEach, describe, it, expect, vi } from 'vitest'
import { httpRemote, SyncError } from './remote'

afterEach(() => {
  vi.unstubAllGlobals()
})

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('httpRemote.postSync', () => {
  it('sends the bearer token and returns the parsed response', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      ok({ cursor: 9, ack: {}, pull: {} }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const remote = httpRemote({ token: 'tok123' })
    const res = await remote.postSync({ cursor: 0 })

    expect(res.cursor).toBe(9)
    const init = fetchMock.mock.calls[0][1]
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok123' })
  })

  it('throws an auth SyncError on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 401 })))
    const remote = httpRemote({ token: 'bad' })
    await expect(remote.postSync({ cursor: 0 })).rejects.toMatchObject({ kind: 'auth' })
  })

  it('throws a network SyncError when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('failed to fetch')
    }))
    const remote = httpRemote({ token: 'tok' })
    await expect(remote.postSync({ cursor: 0 })).rejects.toBeInstanceOf(SyncError)
    await expect(remote.postSync({ cursor: 0 })).rejects.toMatchObject({ kind: 'network' })
  })
})

describe('httpRemote.getBlob', () => {
  it('returns undefined on 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nf', { status: 404 })))
    const remote = httpRemote({ token: 'tok' })
    expect(await remote.getBlob('missing')).toBeUndefined()
  })

  it('returns the blob on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bytes', { status: 200, headers: { 'content-type': 'image/jpeg' } })),
    )
    const remote = httpRemote({ token: 'tok' })
    const blob = await remote.getBlob('i1')
    expect(blob).toBeInstanceOf(Blob)
    expect(await blob!.text()).toBe('bytes')
  })
})
