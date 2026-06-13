import { describe, it, expect } from 'vitest'
import { parsePlNumber, parsePlDate } from '@/lib/salesImport'

describe('parsePlNumber', () => {
  it('parses comma decimals', () => {
    expect(parsePlNumber('22,4')).toBe(22.4)
    expect(parsePlNumber('350,56')).toBe(350.56)
  })

  it('parses plain integers', () => {
    expect(parsePlNumber('83')).toBe(83)
  })

  it('returns undefined for empty / non-numeric', () => {
    expect(parsePlNumber('')).toBeUndefined()
    expect(parsePlNumber(undefined)).toBeUndefined()
    expect(parsePlNumber('—')).toBeUndefined()
  })

  it('extracts the number from a noisy cell', () => {
    expect(parsePlNumber('0 (zwrot)')).toBe(0)
  })
})

describe('parsePlDate', () => {
  it('parses DD.MM.YYYY at local noon', () => {
    const ts = parsePlDate('13.01.2026')
    expect(ts).not.toBeNull()
    const d = new Date(ts as number)
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(0)
    expect(d.getDate()).toBe(13)
    expect(d.getHours()).toBe(12)
  })

  it('rejects malformed or out-of-range dates', () => {
    expect(parsePlDate('25.01.22026')).toBeNull()
    expect(parsePlDate('')).toBeNull()
    expect(parsePlDate('foo')).toBeNull()
    expect(parsePlDate('13.13.2026')).toBeNull()
    expect(parsePlDate('30.02.2026')).toBeNull()
  })
})
