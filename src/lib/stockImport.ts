// Czysta logika importu STANU MAGAZYNU z CSV (arkusz `finessin`) — bez React i bez Dexie.
// Importujemy tylko wiersze NIESPRZEDANE; wiersze sprzedane należą do importu sprzedaży.
import type { ID } from '@/db/types'
import { parseCsv } from '@/lib/csv'
import {
  hasRequired,
  looksLikeHeaderRow,
  resolveColumns,
  type ColumnMap,
  type ImportField,
  type ResolvedColumns,
} from '@/lib/columnMap'
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
  /**
   * STABILNY koszt do klucza deduplikacji, niezależny od edytowalnej sumy zamówienia. Gdy
   * zrzut ekranu rozkłada dostawę, `purchaseCost` to koszt landed (zmienny), a `keyCost` to
   * cena ODCZYTANA (stała) — dzięki temu ponowny import jest idempotentny mimo zmiany sumy.
   * Brak → klucz liczony z `purchaseCost` (import z CSV bez zmian, zgodnie wstecznie).
   */
  keyCost?: number
  /**
   * Wzbogacenie pochodzące z importu ze zrzutu ekranu (vision). Opcjonalne i
   * czysto addytywne — import z CSV ich nie ustawia, więc jego zachowanie się nie zmienia.
   */
  brand?: string
  color?: string
  sizeLabel?: string
}

/** Szkic gotowy do zapisu — po auto-dopasowaniu i ręcznej recenzji. */
export type ResolvedStockDraft = StockDraft & { accountId?: ID }

/** Pola, które import magazynu potrafi wykorzystać (data nie jest mu potrzebna). */
export const STOCK_FIELDS: readonly ImportField[] = ['name', 'purchase', 'sale']

/** Bez nazwy nie ma czego importować; ceny są opcjonalne. */
const STOCK_REQUIRED: readonly ImportField[] = ['name']

export function stockColumnsUsable(map: ColumnMap): boolean {
  return hasRequired(map, STOCK_REQUIRED)
}

/** Pozycyjny plan awaryjny dla arkusza `finessin`: A=Data, B=Miesiąc, C=Nazwa, D=Zakup, E=Sprzedaż. */
const STOCK_POSITIONAL: ColumnMap = { name: 2, purchase: 3, sale: 4 }

/** Ustala przypisanie kolumn dla arkusza magazynu (polityka w `resolveColumns`). */
export function resolveStockColumns(header: string[], override?: ColumnMap): ResolvedColumns {
  return resolveColumns(header, STOCK_FIELDS, STOCK_REQUIRED, STOCK_POSITIONAL, override)
}

function classifyStockRow(
  cells: string[],
  col: ColumnMap,
  rowIndex: number,
): ParsedStockRow | null {
  // Kolumna nieobecna w pliku → pusta komórka (np. arkusz bez cen sprzedaży:
  // nic nie zostanie uznane za sprzedane, wszystko trafi do magazynu).
  const cell = (i: number | undefined) => (i === undefined ? '' : (cells[i] ?? '').trim())
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

export interface ParsedStockSheet {
  rows: ParsedStockRow[]
  /** false → nagłówków nie rozpoznano; użyto domysłu pozycyjnego. */
  headerDetected: boolean
  /** Faktycznie użyte przypisanie kolumn — do pokazania i poprawienia w UI. */
  columns: ColumnMap
  /** Czy pierwszy wiersz potraktowano jako nagłówek (a nie jako dane). */
  hasHeaderRow: boolean
}

/**
 * Klasyfikuje gotową tabelę (string[][]) magazynu. Nigdy nie rzuca.
 * `override` pozwala UI narzucić własne przypisanie kolumn (wartość -1 = „brak w pliku").
 */
export function parseStockSheet(table: string[][], override?: ColumnMap): ParsedStockSheet {
  if (table.length === 0)
    return { rows: [], headerDetected: false, columns: {}, hasHeaderRow: false }
  const { columns, headerDetected } = resolveStockColumns(table[0], override)
  const hasHeaderRow = looksLikeHeaderRow(table[0])
  const rows: ParsedStockRow[] = []
  for (let i = hasHeaderRow ? 1 : 0; i < table.length; i++) {
    const r = classifyStockRow(table[i], columns, i)
    if (r) rows.push(r)
  }
  return { rows, headerDetected, columns, hasHeaderRow }
}

/** Wygodny skrót, gdy interesują nas tylko wiersze. */
export function parseStockTable(table: string[][], override?: ColumnMap): ParsedStockRow[] {
  return parseStockSheet(table, override).rows
}

/** Parsuje cały plik CSV magazynu. Nigdy nie rzuca. */
export function parseStockCsv(text: string, override?: ColumnMap): ParsedStockRow[] {
  return parseStockTable(parseCsv(text), override)
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
 * Klucz dedup ze szkicu. Używa STABILNEGO `keyCost` (cena odczytana), a w jego braku
 * `purchaseCost` — dzięki czemu import z CSV zachowuje się jak dawniej, a import ze zrzutu
 * pozostaje idempotentny mimo zmiany sumy zamówienia (która zmienia tylko koszt landed).
 */
export function draftImportKey(d: { name: string; purchaseCost?: number; keyCost?: number }): string {
  return stockImportKey(d.name, d.keyCost ?? d.purchaseCost)
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
