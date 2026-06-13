import { useEffect, useRef } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { AlertTriangle, Cloud, CloudOff, Loader2, RefreshCw } from 'lucide-react'
import clsx from 'clsx'
import { db } from '@/db/db'
import { useSync } from '@/state/sync'
import { syncEnabled } from '@/sync/config'

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
    if (!syncEnabled()) return
    void syncNow()
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

function relativeTime(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return 'przed chwilą'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min temu`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} godz. temu`
  return `${Math.round(h / 24)} dni temu`
}

export function SyncBadge({ className }: { className?: string }) {
  const { status, pending, lastSyncedAt, syncNow } = useSync()
  if (status === 'disabled') return null

  const map = {
    syncing: { icon: <Loader2 size={14} className="animate-spin" />, text: 'Synchronizacja…', tone: 'text-brand-600' },
    idle: { icon: <Cloud size={14} />, text: lastSyncedAt ? `Zsynchronizowano ${relativeTime(lastSyncedAt)}` : 'Połączono', tone: 'text-emerald-600' },
    offline: { icon: <CloudOff size={14} />, text: 'Offline — zsynchronizuje się później', tone: 'text-ink-400' },
    error: { icon: <AlertTriangle size={14} />, text: 'Błąd synchronizacji', tone: 'text-red-600' },
  } as const
  const s = map[status as keyof typeof map] ?? map.idle

  return (
    <div className={clsx('flex items-center justify-between gap-2 rounded-xl bg-ink-50 px-3 py-2 text-xs', className)}>
      <span className={clsx('flex min-w-0 items-center gap-1.5 font-medium', s.tone)}>
        {s.icon}
        <span className="truncate">{s.text}</span>
      </span>
      <button
        onClick={() => void syncNow()}
        disabled={status === 'syncing'}
        title="Synchronizuj teraz"
        className="flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-ink-500 hover:bg-ink-100 hover:text-ink-800 disabled:opacity-40"
      >
        <RefreshCw size={13} />
        {pending > 0 && <span className="font-semibold">{pending}</span>}
      </button>
    </div>
  )
}
