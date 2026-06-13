import { describe, it, expect } from 'vitest'
import { parseCsv } from '@/lib/csv'

describe('parseCsv', () => {
  it('parses simple rows', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ])
  })

  it('keeps quoted commas as one field (Polish decimals)', () => {
    expect(parseCsv('x,"22,4",55')).toEqual([['x', '22,4', '55']])
  })

  it('unescapes doubled quotes', () => {
    expect(parseCsv('"he said ""hi""",b')).toEqual([['he said "hi"', 'b']])
  })

  it('handles CRLF and a trailing newline without an empty row', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('strips a leading BOM', () => {
    expect(parseCsv('﻿a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
})
