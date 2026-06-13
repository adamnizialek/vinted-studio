// HTTP client for the sync API. The engine and blob-sync depend on the RemoteClient
// interface (not on fetch), so they are testable with fakes; httpRemote is the real impl.

import type { SyncRequest, SyncResponse } from './protocol'

export type SyncErrorKind = 'auth' | 'network' | 'http'

export class SyncError extends Error {
  kind: SyncErrorKind
  status?: number
  constructor(kind: SyncErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'SyncError'
    this.kind = kind
    this.status = status
  }
}

export interface RemoteClient {
  postSync(req: SyncRequest): Promise<SyncResponse>
  putBlob(id: string, blob: Blob): Promise<void>
  getBlob(id: string): Promise<Blob | undefined>
}

export interface RemoteConfig {
  token: string
  /** Origin for the API (default same-origin / empty). */
  baseUrl?: string
}

export function httpRemote(cfg: RemoteConfig): RemoteClient {
  const base = cfg.baseUrl ?? ''
  const auth = () => ({ Authorization: `Bearer ${cfg.token}` })

  async function call(path: string, init: RequestInit): Promise<Response> {
    let res: Response
    try {
      res = await fetch(base + path, init)
    } catch {
      throw new SyncError('network', 'Brak połączenia z serwerem synchronizacji.')
    }
    if (res.status === 401)
      throw new SyncError('auth', 'Nieprawidłowy token synchronizacji.', 401)
    return res
  }

  return {
    async postSync(req) {
      const res = await call('/api/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth() },
        body: JSON.stringify(req),
      })
      if (!res.ok) throw new SyncError('http', `Synchronizacja nieudana (HTTP ${res.status}).`, res.status)
      return (await res.json()) as SyncResponse
    },

    async putBlob(id, blob) {
      const res = await call(`/api/blob/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'content-type': blob.type || 'application/octet-stream', ...auth() },
        body: blob,
      })
      if (!res.ok) throw new SyncError('http', `Wysyłka zdjęcia nieudana (HTTP ${res.status}).`, res.status)
    },

    async getBlob(id) {
      const res = await call(`/api/blob/${encodeURIComponent(id)}`, {
        method: 'GET',
        headers: auth(),
      })
      if (res.status === 404) return undefined
      if (!res.ok) throw new SyncError('http', `Pobranie zdjęcia nieudane (HTTP ${res.status}).`, res.status)
      return await res.blob()
    },
  }
}
