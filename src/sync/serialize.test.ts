import { describe, it, expect } from 'vitest'
import { stripForPush } from './serialize'

describe('stripForPush', () => {
  it('removes the device-local geminiApiKey from settings', () => {
    const out = stripForPush('settings', {
      id: 'app',
      geminiApiKey: 'secret',
      currency: 'PLN',
      updatedAt: 5,
    })
    expect(out).not.toHaveProperty('geminiApiKey')
    expect(out.currency).toBe('PLN')
    expect(out.updatedAt).toBe(5)
  })

  it('removes the blob from images but keeps the inline thumb', () => {
    const out = stripForPush('images', {
      id: 'i1',
      blob: { fake: true },
      thumb: 'data:...',
      mime: 'image/jpeg',
      updatedAt: 5,
    })
    expect(out).not.toHaveProperty('blob')
    expect(out.thumb).toBe('data:...')
  })

  it('leaves other tables untouched', () => {
    const product = { id: 'p1', name: 'P', updatedAt: 5 }
    expect(stripForPush('products', product)).toEqual(product)
  })
})
