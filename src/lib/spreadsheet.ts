// Wczytywanie arkuszy z pliku (CSV lub XLSX) do tabeli string[][] — bez React i bez Dexie.
// XLSX czytamy LENIWIE (dynamiczny import SheetJS), więc biblioteka trafia do osobnego chunku
// ładowanego dopiero przy realnym imporcie — bundle startowy pozostaje nietknięty.
import { format } from 'date-fns'
import { parseCsv } from '@/lib/csv'

const XLSX_RE = /\.xlsx?$/i
const CSV_RE = /\.csv$/i
// Zabezpieczenie przed zawieszeniem zakładki/OOM na ogromnym (lub spreparowanym) pliku.
const MAX_BYTES = 25 * 1024 * 1024

/** Czy plik wygląda na arkusz, który umiemy wczytać (CSV/XLSX/XLS) — po rozszerzeniu lub MIME. */
export function isSpreadsheet(file: File): boolean {
  return (
    XLSX_RE.test(file.name) ||
    CSV_RE.test(file.name) ||
    file.type.includes('csv') ||
    file.type === 'text/plain' ||
    file.type.includes('spreadsheetml') || // .xlsx
    file.type.includes('ms-excel') // .xls
  )
}

function looksXlsx(file: File): boolean {
  // Rozszerzenie wygrywa z MIME: Windows mapuje .csv na "application/vnd.ms-excel",
  // więc plik .csv MUSI iść przez parseCsv (locale PL, przecinki dziesiętne), nie przez SheetJS.
  if (CSV_RE.test(file.name)) return false
  return (
    XLSX_RE.test(file.name) ||
    file.type.includes('spreadsheetml') ||
    file.type.includes('ms-excel')
  )
}

/** Konwertuje komórkę SheetJS na tekst — daty i liczby pod naszą kontrolą (nie wg locale Excela). */
export function cellToString(v: unknown): string {
  if (v == null) return ''
  if (v instanceof Date) return format(v, 'dd.MM.yyyy')
  // Liczby z XLSX to surowe double — utnij szum IEEE-754 (np. 0.1+0.2 → 0.30000000000000004)
  // zanim trafią do parsePlNumber i do kluczy deduplikacji. toPrecision(15) zwija szum,
  // zostawiając 35, 22.4, 42.92 nietknięte. Nieskończoności/NaN → pusty string.
  if (typeof v === 'number') return Number.isFinite(v) ? String(Number(v.toPrecision(15))) : ''
  return String(v)
}

export interface Workbook {
  /** Nazwy arkuszy. CSV → pojedynczy wpis (nazwa pliku). */
  sheetNames: string[]
  /** Wiersze danego arkusza jako tabela komórek tekstowych. Nieznana nazwa → []. */
  tableOf(sheetName: string): string[][]
}

/** Wczytuje plik (CSV lub XLSX) i udostępnia jego arkusze jako tabele string[][]. */
export async function readWorkbook(file: File): Promise<Workbook> {
  if (file.size > MAX_BYTES) {
    throw new Error('Plik jest zbyt duży (limit 25 MB).')
  }
  if (looksXlsx(file)) {
    const XLSX = await import('xlsx')
    const data = new Uint8Array(await file.arrayBuffer())
    const wb = XLSX.read(data, { type: 'array', cellDates: true })
    return {
      sheetNames: [...wb.SheetNames],
      tableOf(sheetName) {
        const ws = wb.Sheets[sheetName]
        if (!ws) return []
        const aoa = XLSX.utils.sheet_to_json(ws, {
          header: 1,
          raw: true,
          blankrows: false,
          defval: '',
        }) as unknown[][]
        return aoa.map((row) => row.map(cellToString))
      },
    }
  }
  const text = await file.text()
  const table = parseCsv(text)
  return { sheetNames: [file.name], tableOf: () => table }
}
