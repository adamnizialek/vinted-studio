// Czysta logika importu STANU MAGAZYNU z CSV (arkusz `finessin`) — bez React i bez Dexie.
// Importujemy tylko wiersze NIESPRZEDANE; wiersze sprzedane należą do importu sprzedaży.
import type { ID } from '@/db/types'
import { parseCsv } from '@/lib/csv'
import { parsePlNumber, FEE_RE } from '@/lib/salesImport'

export type StockBucket = 'stock' | 'sold' | 'excluded'

export interface ParsedStockRow {
  /** 1-based indeks wiersza danych w pliku (nagłówek = 0). */
  rowIndex: number
  bucket: StockBucket
  /** Powody (PL) — dla kubełków sold/excluded. */
  issues: string[]
  name: string
  purchaseCost?: number
  salePrice?: number
}

/** Szkic przedmiotu z magazynu (bez konta — to dokłada dopasowanie/recenzja). */
export interface StockDraft {
  name: string
  purchaseCost?: number
}

/** Szkic gotowy do zapisu — po auto-dopasowaniu i ręcznej recenzji. */
export type ResolvedStockDraft = StockDraft & { accountId?: ID }

interface StockColumnMap {
  name: number
  purchase: number
  sale: number
}

/** Rozpoznaje kolumny po nagłówkach (toleruje literówkę "zaukupu"). null → brak dopasowania. */
function detectStockColumns(header: string[]): StockColumnMap | null {
  const norm = header.map((h) => h.trim().toLowerCase())
  const find = (pred: (h: string) => boolean) => norm.findIndex(pred)
  const name = find((h) => h.includes('nazwa'))
  const purchase = find((h) => h.includes('zakup') || h.includes('zaukup'))
  // "Cena sprzedaży" — odróżniamy od "Data sprzedaży" wymagając też "cena".
  const sale = find((h) => h.includes('sprzeda') && h.includes('cena'))
  if (name < 0 || purchase < 0 || sale < 0) return null
  return { name, purchase, sale }
}

function classifyStockRow(
  cells: string[],
  col: StockColumnMap,
  rowIndex: number,
): ParsedStockRow | null {
  const cell = (i: number) => (cells[i] ?? '').trim()
  const name = cell(col.name)
  // Wiersz bez prawdziwej nazwy (pusty / sama liczba jak "0" / separator) — pomijamy.
  if (!name || !/[a-z]/i.test(name)) return null

  const salePrice = parsePlNumber(cell(col.sale))
  const purchaseCost = parsePlNumber(cell(col.purchase))

  if (FEE_RE.test(name)) {
    return {
      rowIndex,
      bucket: 'excluded',
      issues: ['Opłata (podbicie/ekspozycja) — nie magazyn'],
      name,
      purchaseCost,
      salePrice,
    }
  }
  if (salePrice !== undefined && salePrice > 0) {
    return {
      rowIndex,
      bucket: 'sold',
      issues: ['Sprzedane — pomijane (należy do sprzedaży)'],
      name,
      purchaseCost,
      salePrice,
    }
  }
  // Brak ceny sprzedaży → przedmiot wciąż w magazynie.
  return { rowIndex, bucket: 'stock', issues: [], name, purchaseCost, salePrice }
}

/** Parsuje cały plik CSV `finessin`: wykrywa kolumny i klasyfikuje wiersze. Nigdy nie rzuca. */
export function parseStockCsv(text: string): ParsedStockRow[] {
  const table = parseCsv(text)
  if (table.length === 0) return []
  const detected = detectStockColumns(table[0])
  // Fallback pozycyjny dla `finessin`: A=Data, B=Miesiąc, C=Nazwa, D=Cena zakupu, E=Cena sprzedaży.
  const col: StockColumnMap = detected ?? { name: 2, purchase: 3, sale: 4 }
  const rows: ParsedStockRow[] = []
  for (let i = 1; i < table.length; i++) {
    const r = classifyStockRow(table[i], col, i)
    if (r) rows.push(r)
  }
  return rows
}

export interface AccountMatch {
  draft: StockDraft
  /** Ustawione tylko gdy confidence === 'single'. */
  accountId?: ID
  /** Konta, które sprzedały tę (znormalizowaną) nazwę. */
  candidates: ID[]
  confidence: 'single' | 'ambiguous' | 'none'
}

/**
 * Normalizuje nazwę do dopasowania: małe litery, zwinięte spacje, BEZ kodów SKU.
 * Kody SKU (np. "AX10247937", "MD175497", "sj2306109140799009") są usuwane;
 * tokeny rozmiaru ("XXXL", "M") to czyste litery i ZOSTAJĄ.
 */
export function normalizeForMatch(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b[a-z]{1,3}\d{4,}\b/gi, ' ') // kody typu "ax10247937" / "md175497"
    .replace(/\b\d{6,}\b/g, ' ') // długie kody czysto cyfrowe
    .replace(/\s+/g, ' ')
    .trim()
}

/** Buduje indeks: znormalizowana nazwa sprzedaży → zbiór kont, które ją sprzedały. */
export function buildAccountIndex(
  sales: { productName: string; accountId?: ID }[],
): Map<string, Set<ID>> {
  const idx = new Map<string, Set<ID>>()
  for (const s of sales) {
    if (!s.accountId) continue
    const key = normalizeForMatch(s.productName)
    if (!key) continue
    let set = idx.get(key)
    if (!set) {
      set = new Set<ID>()
      idx.set(key, set)
    }
    set.add(s.accountId)
  }
  return idx
}

/** Dopasowuje każdy szkic do konta na podstawie sprzedaży już w aplikacji. */
export function matchAccounts(
  drafts: StockDraft[],
  sales: { productName: string; accountId?: ID }[],
): AccountMatch[] {
  const idx = buildAccountIndex(sales)
  return drafts.map((draft) => {
    const candidates = [...(idx.get(normalizeForMatch(draft.name)) ?? [])]
    if (candidates.length === 1) {
      return { draft, accountId: candidates[0], candidates, confidence: 'single' }
    }
    if (candidates.length >= 2) {
      return { draft, accountId: undefined, candidates, confidence: 'ambiguous' }
    }
    return { draft, accountId: undefined, candidates, confidence: 'none' }
  })
}

export interface KeyedStockDraft {
  key: string
  draft: ResolvedStockDraft
}

/**
 * Deterministyczny klucz treści przedmiotu — do wykrywania duplikatów przy ponownym imporcie.
 * Konto CELOWO nie wchodzi do klucza (źródło `finessin` nie zna konta), więc ponowny import
 * jest stabilny nawet po ręcznym przypisaniu konta w magazynie.
 */
export function stockImportKey(name: string, purchaseCost?: number): string {
  return [normalizeForMatch(name), purchaseCost ?? ''].join('|')
}

/**
 * Różnica multizbiorów: dla każdego klucza wstawia tylko nadmiar ponad już istniejące.
 * Zachowuje prawdziwe powtórki (np. 5× ta sama koszulka), a ponowny import jest idempotentny.
 */
export function dedupKeyedStock(
  existingCounts: Map<string, number>,
  keyed: KeyedStockDraft[],
): { toInsert: KeyedStockDraft[]; skipped: number } {
  const seen = new Map(existingCounts)
  const toInsert: KeyedStockDraft[] = []
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
