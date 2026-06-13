import { describe, it, expect } from 'vitest'
import { estimateImageCostUsd } from '@/lib/constants'

describe('estimateImageCostUsd', () => {
  it('prices gemini-3.1-flash-image per resolution tier', () => {
    expect(estimateImageCostUsd('gemini-3.1-flash-image', '1K')).toBeCloseTo(0.067, 3)
    expect(estimateImageCostUsd('gemini-3.1-flash-image', '2K')).toBeCloseTo(0.101, 3)
    expect(estimateImageCostUsd('gemini-3.1-flash-image', '4K')).toBeCloseTo(0.15, 3)
  })

  it('prices gemini-3-pro-image higher than flash', () => {
    expect(estimateImageCostUsd('gemini-3-pro-image', '2K')).toBeCloseTo(0.134, 3)
    expect(estimateImageCostUsd('gemini-3-pro-image', '4K')).toBeCloseTo(0.24, 3)
    expect(estimateImageCostUsd('gemini-3-pro-image', '2K')).toBeGreaterThan(
      estimateImageCostUsd('gemini-3.1-flash-image', '2K'),
    )
  })

  it('treats legacy 2.5-flash-image as a fixed ~1K price regardless of requested resolution', () => {
    // The old model only ever renders ~1MP; a higher resolution request is ignored.
    expect(estimateImageCostUsd('gemini-2.5-flash-image', '1K')).toBeCloseTo(0.039, 3)
    expect(estimateImageCostUsd('gemini-2.5-flash-image', '2K')).toBeCloseTo(0.039, 3)
  })

  it('returns a positive fallback for unknown models', () => {
    expect(estimateImageCostUsd('some-future-model', '2K')).toBeGreaterThan(0)
  })
})
