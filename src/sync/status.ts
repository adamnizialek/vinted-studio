// Jak stan synchronizacji wygląda dla użytkownika. Wydzielone ze Settings/SyncStatus, bo
// dokładnie tu mieszkały zgłoszone błędy: „Synchronizuj teraz” kończyło się ciszą, pasek
// stanu bywał pusty, a „Połączono ✔” pojawiało się nawet wtedy, gdy nic nie dotarło na
// serwer. Zamknięcie tego w czystych funkcjach z wyczerpującym `switch` sprawia, że
// TypeScript nie pozwoli dołożyć statusu bez komunikatu.

import type { SyncStatus } from '@/state/sync'

/** Wszystkie statusy — testy sprawdzają, że każdy ma swój komunikat. */
export const ALL_SYNC_STATUSES = ['disabled', 'idle', 'syncing', 'offline', 'error'] as const

export interface SyncMessage {
  tone: 'success' | 'error' | 'info'
  text: string
}

/**
 * Token jest skonfigurowany. To JEDYNE źródło prawdy dla przycisku „Połącz/Rozłącz” —
 * ekran nie może trzymać własnej kopii, bo rozjeżdżała się z konfiguracją.
 */
export function isConnected(status: SyncStatus): boolean {
  return status !== 'disabled'
}

export function relativeTime(ts: number, now: number = Date.now()): string {
  const s = Math.round((now - ts) / 1000)
  if (s < 60) return 'przed chwilą'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min temu`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} godz. temu`
  return `${Math.round(h / 24)} dni temu`
}

/** Odpowiedź na ręczne kliknięcie „Synchronizuj teraz”. Każdy status coś mówi. */
export function manualSyncMessage(status: SyncStatus): SyncMessage {
  switch (status) {
    case 'idle':
      return { tone: 'success', text: 'Zsynchronizowano ✔' }
    case 'syncing':
      return { tone: 'info', text: 'Synchronizacja już trwa…' }
    case 'offline':
      return { tone: 'info', text: 'Brak połączenia — zmiany wyślą się, gdy wróci internet.' }
    case 'error':
      return { tone: 'error', text: 'Synchronizacja nieudana — sprawdź token poniżej.' }
    case 'disabled':
      return { tone: 'error', text: 'Brak tokenu synchronizacji — najpierw się połącz.' }
  }
}

/** Odpowiedź na kliknięcie „Połącz”. `error` to komunikat ze sklepu, gdy serwer coś wyjaśnił. */
export function connectMessage(status: SyncStatus, error: string | null): SyncMessage {
  switch (status) {
    case 'idle':
      return { tone: 'success', text: 'Połączono. Dane synchronizują się między urządzeniami ☁️' }
    case 'syncing':
      return { tone: 'info', text: 'Synchronizacja w toku…' }
    case 'offline':
      // Token zapisany, ale nic nie potwierdziło, że serwer go akceptuje.
      return { tone: 'info', text: 'Token zapisany, ale brak połączenia — sprawdzę go, gdy wróci internet.' }
    case 'error':
      return { tone: 'error', text: error ?? 'Synchronizacja nieudana.' }
    case 'disabled':
      return { tone: 'error', text: 'Brak tokenu synchronizacji.' }
  }
}

/** Etykieta obok przycisku. Nigdy pusta — pusty pasek wyglądał jak zawieszona aplikacja. */
export function statusLabel(
  status: SyncStatus,
  lastSyncedAt: number | null,
  now: number = Date.now(),
): string {
  switch (status) {
    case 'idle':
      // Konkretne „kiedy” zamiast samego „Połączono” — widać, że runda naprawdę przeszła.
      return lastSyncedAt ? `Zsynchronizowano ${relativeTime(lastSyncedAt, now)}` : 'Połączono ✔'
    case 'syncing':
      return 'Synchronizacja…'
    case 'offline':
      return 'Offline — zsynchronizuje się później'
    case 'error':
      return 'Błąd — sprawdź token'
    case 'disabled':
      return 'Synchronizacja wyłączona'
  }
}
