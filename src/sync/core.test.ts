import { describe, it, expect } from 'vitest'
import { lwwAccepts, nextStamp, SYNC_TABLES } from './core'

describe('lwwAccepts', () => {
  it('accepts when no stored row exists', () => {
    expect(lwwAccepts(100, undefined)).toBe(true)
    expect(lwwAccepts(100, null)).toBe(true)
  })

  it('accepts a strictly newer edit', () => {
    expect(lwwAccepts(200, 100)).toBe(true)
  })

  it('rejects an older edit (a stale offline write cannot clobber a newer one)', () => {
    expect(lwwAccepts(100, 200)).toBe(false)
  })

  it('rejects an equal-timestamp edit (keep existing on tie — deterministic)', () => {
    expect(lwwAccepts(100, 100)).toBe(false)
  })
})

describe('nextStamp', () => {
  it('uses the wall clock when it is ahead of the last stamp', () => {
    expect(nextStamp(50, 1000)).toBe(1000)
  })

  it('forces a strictly-increasing value when the clock is behind or equal (no collisions)', () => {
    expect(nextStamp(1000, 1000)).toBe(1001)
    expect(nextStamp(1000, 999)).toBe(1001)
  })
})

describe('SYNC_TABLES', () => {
  it('lists exactly the seven entity tables', () => {
    expect([...SYNC_TABLES].sort()).toEqual([
      'accounts',
      'expenses',
      'images',
      'models',
      'products',
      'sales',
      'settings',
    ])
  })
})
