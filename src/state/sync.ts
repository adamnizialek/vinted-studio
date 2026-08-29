import { create } from 'zustand'
import { db } from '@/db/db'
import { runSync } from '@/sync/syncEngine'
import { flushUploads } from '@/sync/blobSync'
import { currentRemote, syncEnabled } from '@/sync/config'
import { SyncError } from '@/sync/remote'

export type SyncStatus = 'disabled' | 'idle' | 'syncing' | 'offline' | 'error'

interface SyncState {
  status: SyncStatus
  lastSyncedAt: number | null
  /** Pending local changes not yet pushed (outbox + blob uploads). */
  pending: number
  error: string | null
  refreshPending: () => Promise<void>
  /**
   * Run one sync round (rows + blob uploads). Safe to call repeatedly; coalesces.
   * Returns the resulting status so callers can report the outcome without re-reading
   * the store and guessing whether their own call is the one that set it.
   */
  syncNow: () => Promise<SyncStatus>
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
      return 'disabled'
    }
    if (get().status === 'syncing') return 'syncing'
    set({ status: 'syncing', error: null })
    try {
      await runSync(remote)
      await flushUploads(remote)
      await get().refreshPending()
      set({ status: 'idle', lastSyncedAt: Date.now(), error: null })
    } catch (e) {
      if (e instanceof SyncError && e.kind === 'auth') {
        // Token ZOSTAJE. 401 znaczy tylko tyle, że serwer go teraz nie zna — a najczęstszy
        // powód jest przejściowy: właściciel instalacji jeszcze go nie dodał. Kasowanie
        // tokenu robiło z tego ślepy zaułek (ekran „połączono”, konfiguracja pusta) i kazało
        // wklejać go od nowa. Teraz kolejna próba — ręcznie albo przy powrocie do karty —
        // po prostu się udaje.
        set({
          status: 'error',
          error:
            'Serwer odrzucił token synchronizacji. Sprawdź, czy jest poprawny — a jeśli dostałeś go od kogoś, czy zdążył go już dodać po swojej stronie.',
        })
      } else if (e instanceof SyncError && e.kind === 'network') {
        set({ status: 'offline', error: null })
      } else {
        set({ status: 'error', error: e instanceof Error ? e.message : 'Błąd synchronizacji.' })
      }
      await get().refreshPending()
    }
    return get().status
  },
}))
