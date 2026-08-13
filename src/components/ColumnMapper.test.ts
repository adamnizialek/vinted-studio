import { describe, it, expect } from 'vitest'
import { columnLetter } from '@/components/ColumnMapper'

describe('columnLetter', () => {
  it('labels columns the way a spreadsheet does', () => {
    expect(columnLetter(0)).toBe('A')
    expect(columnLetter(2)).toBe('C')
    expect(columnLetter(25)).toBe('Z')
    expect(columnLetter(26)).toBe('AA')
    expect(columnLetter(27)).toBe('AB')
    expect(columnLetter(51)).toBe('AZ')
    expect(columnLetter(52)).toBe('BA')
  })
})
