import { describe, it, expect } from 'vitest'
import type { SyncStatus } from '@/state/sync'
import { ALL_SYNC_STATUSES, connectMessage, isConnected, manualSyncMessage, statusLabel } from './status'

describe('isConnected', () => {
  it('jest połączony dokładnie wtedy, gdy status nie jest „disabled”', () => {
    // Jedyne źródło prawdy. Wcześniej ekran trzymał osobny useState, który po nieudanym
    // logowaniu zostawał na „true”, choć token był już skasowany — stąd „Rozłącz” bez
    // czego kolwiek do rozłączenia i brak przycisku, żeby spróbować jeszcze raz.
    expect(isConnected('disabled')).toBe(false)
    for (const s of ALL_SYNC_STATUSES.filter((s) => s !== 'disabled')) {
      expect(isConnected(s)).toBe(true)
    }
  })
})

describe('manualSyncMessage', () => {
  it('ma komunikat dla KAŻDEGO statusu — żaden klik nie kończy się ciszą', () => {
    for (const s of ALL_SYNC_STATUSES) {
      const msg = manualSyncMessage(s)
      expect(msg.text.length).toBeGreaterThan(0)
      expect(['success', 'error', 'info']).toContain(msg.tone)
    }
  })

  it('potwierdza udaną synchronizację zamiast milczeć', () => {
    expect(manualSyncMessage('idle')).toEqual({ tone: 'success', text: expect.stringContaining('Zsynchronizowano') })
  })

  it('nie udaje sukcesu, gdy nic nie poszło na serwer', () => {
    expect(manualSyncMessage('offline').tone).not.toBe('success')
    expect(manualSyncMessage('error').tone).toBe('error')
    expect(manualSyncMessage('disabled').tone).toBe('error')
  })
})

describe('connectMessage', () => {
  it('pokazuje konkretny powód odmowy z serwera, a nie ogólnik', () => {
    const msg = connectMessage('error', 'Serwer odrzucił token.')
    expect(msg).toEqual({ tone: 'error', text: 'Serwer odrzucił token.' })
  })

  it('nie ogłasza sukcesu, kiedy urządzenie jest offline', () => {
    // „Połączono ✔” po nieudanym połączeniu to było kłamstwo — nic nie dotarło na serwer.
    expect(connectMessage('offline', null).tone).toBe('info')
  })

  it('potwierdza połączenie tylko po realnie udanej rundzie', () => {
    expect(connectMessage('idle', null).tone).toBe('success')
  })
})

describe('statusLabel', () => {
  const now = Date.parse('2026-08-29T12:00:00Z')

  it('opisuje KAŻDY status — pasek stanu nigdy nie jest pusty', () => {
    for (const s of ALL_SYNC_STATUSES) {
      expect(statusLabel(s, null, now).length).toBeGreaterThan(0)
    }
  })

  it('mówi, KIEDY ostatnio się udało, zamiast samego „Połączono”', () => {
    expect(statusLabel('idle', now - 90_000, now)).toContain('2 min temu')
    expect(statusLabel('idle', null, now)).toBe('Połączono ✔')
  })

  it('nie chwali się starym sukcesem, gdy teraz jest błąd', () => {
    const label: string = statusLabel('error' as SyncStatus, now - 1000, now)
    expect(label).not.toContain('temu')
  })
})
