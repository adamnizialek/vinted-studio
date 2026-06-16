import { describe, it, expect } from 'vitest'
import type { DescriptionCandidate } from '@/db/types'
import { removeCandidate, upsertCandidate } from '@/lib/descriptions'

const cand = (styleId: string, text = styleId): DescriptionCandidate => ({
  styleId,
  styleLabel: styleId.toUpperCase(),
  text,
})

describe('upsertCandidate', () => {
  it('appends a candidate for a new style', () => {
    const out = upsertCandidate([cand('zwiezly')], cand('casual'))
    expect(out.map((c) => c.styleId)).toEqual(['zwiezly', 'casual'])
  })

  it('replaces the candidate for an existing style in place (per-style regenerate)', () => {
    const list = [cand('zwiezly', 'stary'), cand('casual', 'c')]
    const out = upsertCandidate(list, cand('zwiezly', 'nowy'))
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ styleId: 'zwiezly', text: 'nowy' }) // ta sama pozycja
    expect(out[1].styleId).toBe('casual')
  })

  it('does not mutate the input array', () => {
    const list = [cand('zwiezly')]
    upsertCandidate(list, cand('casual'))
    expect(list).toHaveLength(1)
  })
})

describe('removeCandidate', () => {
  it('removes the candidate with the given style', () => {
    const out = removeCandidate([cand('zwiezly'), cand('casual')], 'zwiezly')
    expect(out.map((c) => c.styleId)).toEqual(['casual'])
  })

  it('is a no-op when the style is absent', () => {
    const list = [cand('zwiezly')]
    expect(removeCandidate(list, 'casual')).toEqual(list)
  })
})
