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
  const d = new Date(year, mon - 1, day, 12, 0, 0, 0)
  if (d.getFullYear() !== year || d.getMonth() !== mon - 1 || d.getDate() !== day) return null
  return d.getTime()
}

export type ImportBucket = 'ready' | 'review' | 'excluded'

export interface ParsedRow {
  /** 1-based indeks wiersza danych w pliku (nagłówek = 0). */
  rowIndex: number
  bucket: ImportBucket
  /** Powody (PL) — dla kubełków review/excluded. */
  issues: string[]
  productName: string
  dateTs: number | null
  salePrice?: number
  purchaseCost?: number
  status: 'completed' | 'returned'
  excludedReason?: 'fee'
}

export interface ParsedSheet {
  rows: ParsedRow[]
  /** false → nie rozpoznano nagłówków, użyto kolumn A–D. */
  headerDetected: boolean
}

/** Czysty szkic sprzedaży gotowy do zapisu (bez pól nadawanych przez DB). */
export interface DraftSale {
  soldAt: number
  productName: string
  salePrice: number
  purchaseCost?: number
  status: 'completed' | 'returned'
}

interface ColumnMap {
  date: number
  name: number
  purchase: number
  sale: number
}

/** Rozpoznaje kolumny po nagłówkach (z tolerancją na literówkę "zaukupu"). null → brak dopasowania. */
function detectColumns(header: string[]): ColumnMap | null {
  const norm = header.map((h) => h.trim().toLowerCase())
  const find = (pred: (h: string) => boolean) => norm.findIndex(pred)
  const date = find((h) => h.includes('data'))
  const name = find((h) => h.includes('nazwa'))
  const purchase = find((h) => h.includes('zakup') || h.includes('zaukup'))
  // "Cena Sprzedaży" — odróżniamy od "Data sprzedaży" wymagając też "cena".
  const sale = find((h) => h.includes('sprzeda') && h.includes('cena'))
  if (date < 0 || name < 0 || purchase < 0 || sale < 0) return null
  return { date, name, purchase, sale }
}

const FEE_RE = /podbic|ekspozycj/i
const RETURN_RE = /\(zwrot\)/i

function classifyRow(cells: string[], col: ColumnMap, rowIndex: number): ParsedRow | null {
  const cell = (i: number) => (cells[i] ?? '').trim()
  const name = cell(col.name)
  const rawDate = cell(col.date)
  const rawSale = cell(col.sale)
  const rawPurchase = cell(col.purchase)

  if (!name && !rawDate && !rawSale && !rawPurchase) return null // pusty wiersz separujący

  const salePrice = parsePlNumber(rawSale)
  const purchaseCost = parsePlNumber(rawPurchase)
  const dateTs = parsePlDate(rawDate)
  const isReturn = RETURN_RE.test(name) || RETURN_RE.test(rawSale) || RETURN_RE.test(rawPurchase)
  const status: 'completed' | 'returned' = isReturn ? 'returned' : 'completed'

  const issues: string[] = []
  const isFee = FEE_RE.test(name) && (salePrice === undefined || salePrice <= 0)

  let bucket: ImportBucket
  let excludedReason: ParsedRow['excludedReason']
  if (isFee) {
    bucket = 'excluded'
    excludedReason = 'fee'
    issues.push('Opłata (podbicie/ekspozycja) — nie sprzedaż')
  } else if (!name) {
    bucket = 'review'
    issues.push('Brak nazwy')
  } else if (salePrice === undefined || salePrice <= 0) {
    bucket = 'review'
    issues.push('Brak ceny sprzedaży')
  } else if (dateTs === null) {
    bucket = 'review'
    issues.push('Brak lub niepoprawna data')
  } else {
    bucket = 'ready'
  }

  return { rowIndex, bucket, issues, productName: name, dateTs, salePrice, purchaseCost, status, excludedReason }
}

/** Parsuje cały plik CSV sprzedaży: wykrywa kolumny, klasyfikuje wiersze. */
export function parseSalesCsv(text: string): ParsedSheet {
  const table = parseCsv(text)
  if (table.length === 0) return { rows: [], headerDetected: false }
  const detected = detectColumns(table[0])
  const col: ColumnMap = detected ?? { date: 0, name: 1, purchase: 2, sale: 3 }
  const rows: ParsedRow[] = []
  // Pierwszy wiersz to zawsze nagłówek (eksport z Arkuszy go zawiera), więc dane
  // czytamy od i = 1 — także przy fallbacku pozycyjnym.
  for (let i = 1; i < table.length; i++) {
    const r = classifyRow(table[i], col, i)
    if (r) rows.push(r)
  }
  return { rows, headerDetected: detected !== null }
}

export interface KeyedDraft {
  key: string
  draft: DraftSale
}

/** Deterministyczny klucz treści wiersza — do wykrywania duplikatów przy ponownym imporcie. */
export function saleImportKey(
  accountId: string,
  dateTs: number | null,
  name: string,
  salePrice: number,
  purchaseCost?: number,
): string {
  const day = dateTs === null ? 'nodate' : new Date(dateTs).toISOString().slice(0, 10)
  const n = name.trim().toLowerCase().replace(/\s+/g, ' ')
  return [accountId, day, n, salePrice, purchaseCost ?? ''].join('|')
}

/**
 * Różnica multizbiorów: dla każdego klucza wstawia tylko nadmiar ponad już istniejące.
 * Zachowuje prawdziwe powtórki, a ponowny import tych samych wierszy jest idempotentny.
 */
export function dedupKeyed(
  existingCounts: Map<string, number>,
  keyed: KeyedDraft[],
): { toInsert: KeyedDraft[]; skipped: number } {
  const seen = new Map(existingCounts)
  const toInsert: KeyedDraft[] = []
  let skipped = 0
  for (const item of keyed) {
    const c = seen.get(item.key) ?? 0
    if (c > 0) {
      seen.set(item.key, c - 1)
      skipped++
    } else {
      toInsert.push(item)
    }
  }
  return { toInsert, skipped }
}
