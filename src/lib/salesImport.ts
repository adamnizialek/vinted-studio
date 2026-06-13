// Czysta logika importu sprzedaży z CSV (Arkusze Google) — bez React i bez Dexie.
import { parseCsv } from '@/lib/csv'

/** Parsuje liczbę w formacie PL (przecinek dziesiętny). Zwraca undefined, gdy brak liczby. */
export function parsePlNumber(raw: string | undefined): number | undefined {
  if (raw == null) return undefined
  const cleaned = raw.replace(/\s/g, '').replace(/zł/gi, '').replace(',', '.')
  const m = cleaned.match(/-?\d+(\.\d+)?/)
  if (!m) return undefined
  const n = Number(m[0])
  return Number.isFinite(n) ? n : undefined
}

/** Parsuje datę "DD.MM.YYYY" jako południe lokalne. Zwraca null dla błędnych/poza zakresem. */
export function parsePlDate(raw: string | undefined): number | null {
  if (!raw) return null
  const m = raw.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/)
  if (!m) return null
  const day = Number(m[1])
  const mon = Number(m[2])
  const year = Number(m[3])
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return null
  if (year < 2020 || year > 2030) return null
  return new Date(year, mon - 1, day, 12, 0, 0, 0).getTime()
}
