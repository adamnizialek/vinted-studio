// Scenariusz z życia: kolega dostał token, zanim właściciel dodał go po stronie serwera.
// Pierwsza próba dostaje 401 — i tu zaczynała się kaskada, przez którą „token za pierwszym
// razem nie wchodzi", a potem „nie ma żadnego info, czy jednak działa".

import { describe, it, expect, beforeEach, vi } from 'vitest'

const runSync = vi.fn()
const flushUploads = vi.fn()

vi.mock('@/sync/syncEngine', () => ({
  runSync: (...args: unknown[]) => runSync(...args),
  seedOutbox: vi.fn(async () => {}),
}))
vi.mock('@/sync/blobSync', () => ({
  flushUploads: (...args: unknown[]) => flushUploads(...args),
}))

import { useSync } from '@/state/sync'
import { getSyncToken, setSyncToken, syncEnabled } from '@/sync/config'
import { SyncError } from '@/sync/remote'

const authError = () => new SyncError('auth', 'Nieprawidłowy token synchronizacji.', 401)

describe('useSync.syncNow', () => {
  beforeEach(() => {
    runSync.mockReset()
    flushUploads.mockReset()
    runSync.mockResolvedValue({ pushed: 0, pulled: 0 })
    flushUploads.mockResolvedValue(undefined)
    setSyncToken('token-kolegi')
    useSync.setState({ status: 'idle', error: null, lastSyncedAt: null, pending: 0 })
  })

  it('zwraca status, żeby UI nie musiał go zgadywać po fakcie', async () => {
    expect(await useSync.getState().syncNow()).toBe('idle')
  })

  it('NIE kasuje tokenu, gdy serwer go odrzuci', async () => {
    // Kasowanie tokenu przy 401 zostawiało aplikację w stanie „ekran mówi połączono,
    // konfiguracja mówi rozłączono" — i bez przycisku, którym można ponowić.
    runSync.mockRejectedValue(authError())

    expect(await useSync.getState().syncNow()).toBe('error')
    expect(getSyncToken()).toBe('token-kolegi')
    expect(syncEnabled()).toBe(true)
  })

  it('wychodzi z błędu sama, gdy właściciel doda token po stronie serwera', async () => {
    // Dokładnie ta sytuacja: token jest poprawny, tylko serwer jeszcze o nim nie wiedział.
    // Ponowienie musi zadziałać BEZ wklejania tokenu drugi raz.
    runSync.mockRejectedValueOnce(authError())
    expect(await useSync.getState().syncNow()).toBe('error')

    expect(await useSync.getState().syncNow()).toBe('idle')
    expect(useSync.getState().error).toBeNull()
  })

  it('mówi wprost, że nie ma tokenu, zamiast po cichu nic nie robić', async () => {
    setSyncToken(null)
    expect(await useSync.getState().syncNow()).toBe('disabled')
    expect(runSync).not.toHaveBeenCalled()
  })

  it('traktuje brak sieci jako stan przejściowy, nie jako zły token', async () => {
    runSync.mockRejectedValue(new SyncError('network', 'Brak połączenia.'))

    expect(await useSync.getState().syncNow()).toBe('offline')
    expect(getSyncToken()).toBe('token-kolegi')
    expect(useSync.getState().error).toBeNull()
  })
})
