import { describe, it, expect } from 'vitest'

describe('test harness', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2)
  })

  it('has IndexedDB polyfilled', () => {
    expect(typeof indexedDB).not.toBe('undefined')
  })
})
