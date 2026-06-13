import { create } from 'zustand'
import { db } from '@/db/db'
import { runSync } from '@/sync/syncEngine'
import { flushUploads } from '@/sync/blobSync'
import { currentRemote, setSyncToken, syncEnabled } from '@/sync/config'
import { SyncError } from '@/sync/remote'

export type SyncStatus = 'disabled' | 'idle' | 'syncing' | 'offline' | 'error'

interface SyncState {
  status: SyncStatus
  lastSyncedAt: number | null
  /** Pending local changes not yet pushed (outbox + blob uploads). */
  pending: number
  error: string | null
  refreshPending: () => Promise<void>
  /** Run one sync round (rows + blob uploads). Safe to call repeatedly; coalesces. */
  syncNow: () => Promise<void>
}

export const useSync = create<SyncState>((set, get) => ({
  status: syncEnabled() ? 'idle' : 'disabled',
  lastSyncedAt: null,
  pending: 0,
  error: null,

  refreshPending: async () => {
    const [rows, blobs] = await Promise.all([db.outbox.count(), db.blob_outbox.count()])
    set({ pending: rows + blobs })
  },

  syncNow: async () => {
    const remote = currentRemote()
    if (!remote) {
      set({ status: 'disabled' })
      return
    }
    if (get().status === 'syncing') return
    set({ status: 'syncing', error: null })
    try {
      await runSync(remote)
      await flushUploads(remote)
      await get().refreshPending()
      set({ status: 'idle', lastSyncedAt: Date.now(), error: null })
    } catch (e) {
      if (e instanceof SyncError && e.kind === 'auth') {
        setSyncToken(null)
        set({ status: 'error', error: 'Nieprawidłowy token synchronizacji — wpisz go ponownie w Ustawieniach.' })
      } else if (e instanceof SyncError && e.kind === 'network') {
        set({ status: 'offline', error: null })
      } else {
        set({ status: 'error', error: e instanceof Error ? e.message : 'Błąd synchronizacji.' })
      }
      await get().refreshPending()
    }
  },
}))
