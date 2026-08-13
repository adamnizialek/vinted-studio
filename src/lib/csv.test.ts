import { describe, it, expect } from 'vitest'
import { parseCsv, detectDelimiter, toCsv } from '@/lib/csv'

describe('detectDelimiter', () => {
  it('picks the comma for a classic CSV', () => {
    expect(detectDelimiter('Data,Nazwa,Cena\n01.02.2026,Bluza,35')).toBe(',')
  })

  it('picks the semicolon for a Polish Excel export', () => {
    expect(detectDelimiter('Data;Nazwa;Cena\n01.02.2026;Bluza;35,00')).toBe(';')
  })

  it('picks the tab for Excel "Unicode text"', () => {
    expect(detectDelimiter('Data\tNazwa\tCena\n01.02.2026\tBluza\t35,00')).toBe('\t')
  })

  it('is not fooled by decimal commas inside a semicolon file', () => {
    // Every data cell carries a comma; only ';' yields a CONSISTENT column count.
    expect(detectDelimiter('Nazwa;Zakup;Sprzedaz\nBluza;35,00;90,50\nKurtka;60,25;140,75')).toBe(';')
  })

  it('honours an explicit Excel "sep=" directive', () => {
    expect(detectDelimiter('sep=;\nData;Nazwa\n01.02.2026;Bluza')).toBe(';')
  })

  it('ignores delimiters that only appear inside quoted fields', () => {
    expect(detectDelimiter('Nazwa,Cena\n"Bluza; duza","22,4"')).toBe(',')
  })

  it('falls back to the comma for a single-column file', () => {
    expect(detectDelimiter('Nazwa\nBluza\nKurtka')).toBe(',')
  })

  it('handles empty input without throwing', () => {
    expect(detectDelimiter('')).toBe(',')
  })
})

describe('parseCsv', () => {
  it('parses a semicolon file with Polish decimal commas', () => {
    expect(parseCsv('Data;Nazwa;Cena zakupu\n01.02.2026;Bluza Nike;35,00')).toEqual([
      ['Data', 'Nazwa', 'Cena zakupu'],
      ['01.02.2026', 'Bluza Nike', '35,00'],
    ])
  })

  it('parses a tab-separated file', () => {
    expect(parseCsv('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('drops the Excel "sep=" directive line instead of treating it as a header', () => {
    expect(parseCsv('sep=;\na;b\n1;2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('honours an explicitly requested delimiter', () => {
    expect(parseCsv('a;b\n1;2', ',')).toEqual([['a;b'], ['1;2']])
  })

  it('round-trips its own toCsv export (regression: export used ; but import assumed ,)', () => {
    const exported = toCsv([{ Nazwa: 'Bluza Nike', Cena: '35,00' }])
    expect(parseCsv(exported)).toEqual([
      ['Nazwa', 'Cena'],
      ['Bluza Nike', '35,00'],
    ])
  })

  it('keeps quoted semicolons as one field in a semicolon file', () => {
    expect(parseCsv('Nazwa;Cena\n"Bluza; duza";35')).toEqual([
      ['Nazwa', 'Cena'],
      ['Bluza; duza', '35'],
    ])
  })
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
