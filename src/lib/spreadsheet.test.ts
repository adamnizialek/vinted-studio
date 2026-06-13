import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { readWorkbook, isSpreadsheet, cellToString } from '@/lib/spreadsheet'

function xlsxFile(sheets: Record<string, unknown[][]>, name = 'wb.xlsx'): File {
  const wb = XLSX.utils.book_new()
  for (const [sheet, aoa] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheet)
  }
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return new File([buf], name, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

describe('isSpreadsheet', () => {
  it('accepts csv and xlsx, rejects images', () => {
    expect(isSpreadsheet(new File([''], 'a.csv'))).toBe(true)
    expect(isSpreadsheet(new File([''], 'a.xlsx'))).toBe(true)
    expect(isSpreadsheet(new File([''], 'a.xls'))).toBe(true)
    expect(isSpreadsheet(new File([''], 'a.png', { type: 'image/png' }))).toBe(false)
  })
})

describe('cellToString', () => {
  it('formats dates as dd.MM.yyyy, numbers with dot, passes strings', () => {
    expect(cellToString(new Date(2024, 2, 15))).toBe('15.03.2024')
    expect(cellToString(22.4)).toBe('22.4')
    expect(cellToString(35)).toBe('35')
    expect(cellToString(42.92)).toBe('42.92')
    expect(cellToString('Koszulka')).toBe('Koszulka')
    expect(cellToString(null)).toBe('')
    expect(cellToString(undefined)).toBe('')
  })

  it('strips IEEE-754 float noise from computed cells', () => {
    expect(cellToString(0.1 + 0.2)).toBe('0.3') // 0.30000000000000004 → "0.3"
    expect(cellToString(42.92000000000001)).toBe('42.92')
    expect(cellToString(1700)).toBe('1700')
  })

  it('drops non-finite numbers to empty string', () => {
    expect(cellToString(Infinity)).toBe('')
    expect(cellToString(NaN)).toBe('')
  })
})

describe('readWorkbook', () => {
  it('reads a CSV file as a single sheet named after the file', async () => {
    const f = new File(['Nazwa,Cena\nFoo,"22,4"\n'], 'items.csv', { type: 'text/csv' })
    const wb = await readWorkbook(f)
    expect(wb.sheetNames).toEqual(['items.csv'])
    expect(wb.tableOf('items.csv')).toEqual([
      ['Nazwa', 'Cena'],
      ['Foo', '22,4'],
    ])
  })

  it('routes a .csv to the CSV path even when MIME is application/vnd.ms-excel (Windows)', async () => {
    // Windows z Excelem raportuje .csv jako application/vnd.ms-excel — NIE wolno tego
    // przepuścić przez SheetJS (zniszczyłby przecinki dziesiętne i polskie znaki).
    const f = new File(['Nazwa,Cena\nFoo,"22,4"\n'], 'finessin.csv', {
      type: 'application/vnd.ms-excel',
    })
    const wb = await readWorkbook(f)
    expect(wb.sheetNames).toEqual(['finessin.csv'])
    expect(wb.tableOf('finessin.csv')).toEqual([
      ['Nazwa', 'Cena'],
      ['Foo', '22,4'],
    ])
  })

  it('rejects files above the size cap', async () => {
    const big = new File([new Uint8Array(26 * 1024 * 1024)], 'huge.xlsx')
    await expect(readWorkbook(big)).rejects.toThrow(/zbyt duży/)
  })

  it('reads XLSX sheets, coercing numbers to dot-strings and listing all tabs', async () => {
    const f = xlsxFile({
      finessin: [
        ['Nazwa', 'Cena zakupu', 'Cena sprzedazy'],
        ['Foo', 22.4, ''],
      ],
      Main: [
        ['Data', 'Nazwa'],
        ['x', 'y'],
      ],
    })
    const wb = await readWorkbook(f)
    expect(wb.sheetNames).toEqual(['finessin', 'Main'])
    expect(wb.tableOf('finessin')[0]).toEqual(['Nazwa', 'Cena zakupu', 'Cena sprzedazy'])
    expect(wb.tableOf('finessin')[1][1]).toBe('22.4')
    expect(wb.tableOf('Main')[1]).toEqual(['x', 'y'])
    expect(wb.tableOf('missing')).toEqual([])
  })
})
