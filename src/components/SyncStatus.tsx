import { useEffect, useRef } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import clsx from 'clsx'
import { db } from '@/db/db'
import { useSync } from '@/state/sync'
import { syncEnabled } from '@/sync/config'
import { relativeTime } from '@/sync/status'

/**
 * Wires the sync triggers ONCE: initial sync on mount, on regaining focus/connectivity,
 * and a debounced sync whenever the local outbox grows. Call from a single top-level spot.
 */
export function useSyncTriggers() {
  const syncNow = useSync((s) => s.syncNow)
  const refreshPending = useSync((s) => s.refreshPending)
  const pending = useLiveQuery(
    async () => (await db.outbox.count()) + (await db.blob_outbox.count()),
    [],
    0,
  )
  const timer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    void refreshPending()
    if (syncEnabled()) void syncNow()
    // Always listen: syncNow() no-ops while sync is disabled, so listeners keep working
    // even if the user connects after this mounts (no reload needed).
    const wake = () => {
      if (navigator.onLine) void syncNow()
    }
    window.addEventListener('online', wake)
    window.addEventListener('focus', wake)
    return () => {
      window.removeEventListener('online', wake)
      window.removeEventListener('focus', wake)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void refreshPending()
    if (!syncEnabled() || !pending) return
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void syncNow(), 4000)
    return () => clearTimeout(timer.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])
}

/** Status synchronizacji jako kropka; szczegoly w podpowiedzi, klikniecie synchronizuje od razu. */
export function SyncDot({ className }: { className?: string }) {
  const { status, pending, lastSyncedAt, syncNow } = useSync()
  if (status === 'disabled') return null

  const map = {
    syncing: { text: 'Synchronizacja…', tone: 'bg-brand-500 animate-pulse' },
    idle: {
      text: lastSyncedAt ? `Zsynchronizowano ${relativeTime(lastSyncedAt)}` : 'Połączono',
      tone: 'bg-emerald-500',
    },
    offline: { text: 'Offline — zsynchronizuje się później', tone: 'bg-ink-400' },
    error: { text: 'Błąd synchronizacji', tone: 'bg-red-500' },
  } as const
  const s = map[status as keyof typeof map] ?? map.idle
  const title = pending > 0 ? `${s.text} · do wysłania: ${pending}` : s.text

  return (
    <button
      type="button"
      onClick={() => void syncNow()}
      disabled={status === 'syncing'}
      title={`${title} — kliknij, aby zsynchronizować`}
      aria-label={title}
      className={clsx('tap-target relative grid h-5 w-5 shrink-0 place-items-center rounded-full', className)}
    >
      <span className={clsx('h-2.5 w-2.5 rounded-full', s.tone)} />
    </button>
  )
}
