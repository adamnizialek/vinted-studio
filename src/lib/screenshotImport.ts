// Czysta logika importu STANU MAGAZYNU ze zrzutu ekranu zamówienia (np. AliExpress) —
// bez React, bez Dexie i bez sieci. Vision (Gemini) zwraca JSON; tutaj go bezpiecznie
// parsujemy, walidujemy i mapujemy na szkice magazynu. Nigdy nie ufamy, że model
// zwróci czysty/poprawny JSON — parser NIGDY nie rzuca i odrzuca śmieciowe wiersze.
import type { StockDraft } from '@/lib/stockImport'

export type ItemConfidence = 'low' | 'medium' | 'high'

/** Pojedynczy przedmiot wyciągnięty ze zrzutu ekranu (po walidacji/koercji). */
export interface ExtractedItem {
  /** Zwięzła nazwa produktu (w języku oryginału, bez tłumaczenia/wymyślania). */
  name: string
  brand?: string
  color?: string
  size?: string
  /** Liczba sztuk tej pozycji (≥1). Każda sztuka = osobne ogłoszenie na Vinted. */
  quantity: number
  /** Cena za 1 sztukę (po rabacie). undefined, gdy nieczytelna. */
  unitPrice?: number
  /** Dosłowny tekst ceny ze zrzutu (np. "$4.99", "20,73 zł") — do podglądu/audytu. */
  priceText?: string
  /** Wykryta waluta (wielkimi literami), np. PLN/USD/EUR. */
  currency?: string
  /** Czy pozycja wygląda na zestaw/komplet (PCS/Set/Pack/N-piece) — cena ≠ za sztukę. */
  bundle: boolean
  confidence: ItemConfidence
}

const MAX_QTY = 999

// ---------------------------------------------------------------------------
// Schemat odpowiedzi Gemini (podzbiór OpenAPI; typy WIELKIMI literami; `propertyOrdering`
// poprawia spójność generacji). Korzeń to OBJECT z tablicą `items` — najpewniejsza forma.
// ---------------------------------------------------------------------------
export const EXTRACTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: {
            type: 'STRING',
            description:
              'Concise product name in its ORIGINAL language (do not translate). Strip SEO keyword spam, year tags and marketing adjectives; keep the essential item description (e.g. garment type). Do NOT invent brand/material not visible.',
          },
          brand: { type: 'STRING', nullable: true, description: 'Brand if clearly visible, else null. Do not guess.' },
          color: { type: 'STRING', nullable: true, description: 'Color from the variant/spec line if visible, else null.' },
          size: { type: 'STRING', nullable: true, description: 'Size from the variant/spec line if visible, else null.' },
          quantity: { type: 'INTEGER', description: 'Number of units for this line item (the "x2" qty). Default 1.' },
          unitPrice: {
            type: 'NUMBER',
            nullable: true,
            description:
              'Price ACTUALLY CHARGED per single unit (ignore struck-through original price). If only a line total is visible, divide by quantity. null if not clearly readable.',
          },
          priceText: { type: 'STRING', nullable: true, description: 'The verbatim on-screen price string, e.g. "$4.99" or "20,73 zł".' },
          currency: { type: 'STRING', nullable: true, description: 'Detected currency code, e.g. PLN, USD, EUR. null if unknown.' },
          bundle: {
            type: 'BOOLEAN',
            description: 'true if the title/spec indicates a multi-piece set (PCS, Set, Pack, 2-in-1, N-piece, combo) so the price is NOT per garment.',
          },
          confidence: { type: 'STRING', format: 'enum', enum: ['low', 'medium', 'high'], description: 'Your confidence in this row.' },
        },
        required: ['name', 'quantity', 'bundle', 'confidence'],
        propertyOrdering: ['name', 'brand', 'color', 'size', 'quantity', 'unitPrice', 'priceText', 'currency', 'bundle', 'confidence'],
      },
    },
  },
  required: ['items'],
  propertyOrdering: ['items'],
}

// ---------------------------------------------------------------------------
// Prompt ekstrakcji. Reguły wprost (zob. research): jeden obiekt na pozycję, wariant
// w polach (nie osobny wiersz), cena rzeczywiście zapłacona, brak zgadywania, pomijaj
// wysyłkę/rabaty/podatki i elementy interfejsu. Pisany po angielsku dla precyzji —
// model rozumie polskie etykiety interfejsu (Łącznie, Dostawa, Rabat…) niezależnie.
// ---------------------------------------------------------------------------
export const EXTRACTION_PROMPT = `You extract purchased clothing/items from one or more screenshots of an online shopping order (most often AliExpress; the UI may be in Polish or English). Return ONLY JSON matching the provided schema.

Rules:
- Output exactly ONE object per distinct product line item. Never merge two products into one row; never split one product across rows.
- Put the variant (color, size) into the color/size fields — NOT as separate rows.
- name: copy a concise version of the product title in its ORIGINAL language. Do NOT translate. Remove SEO keyword spam, year tags ("2024 New Arrival"), and marketing words. Do not invent a brand, material, or size that is not shown.
- unitPrice: the price ACTUALLY CHARGED per single unit. Ignore struck-through / original (pre-discount) prices. If only a line total and quantity are shown, divide to get the per-unit price.
- priceText: copy the price exactly as it appears on screen (with its currency symbol). currency: the detected currency code (PLN, USD, EUR…). Do NOT convert between currencies.
- quantity: the number of units of this item ("x2" → 2). Default to 1 if not shown.
- bundle: set true when the title or variant indicates a multi-piece set (PCS, Pieces, Set, Pack, 2-in-1, 3-piece, combo) — in that case the shown price is for the whole set, not per garment.
- If a field is not clearly visible, return null for it. NEVER guess a value.
- IGNORE: shipping fee, tax, seller discount / coupon / coins lines, order totals, promo banners, countdown timers, buttons (Confirm Receipt, Contact Seller…), tracking widgets, carrier logos. These are NOT items.
- If no purchasable items are visible, return {"items": []}.`

// ---------------------------------------------------------------------------
// Parsowanie + koercja
// ---------------------------------------------------------------------------

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

/**
 * Parsuje JSON tolerancyjnie: zdejmuje ogrodzenie ```json…```; gdy bezpośredni parse
 * zawiedzie, próbuje wyciąć najbardziej zewnętrzny obiekt/tablicę z otaczającego tekstu.
 * Zwraca null, gdy nic sensownego nie da się odczytać.
 */
export function parseJsonLoose(text: string): unknown {
  if (!text) return null
  let s = text.trim()
  const fence = s.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i)
  if (fence) s = fence[1].trim()

  const direct = tryParse(s)
  if (direct !== undefined) return direct

  const candidates: string[] = []
  const ob = s.indexOf('{')
  const cb = s.lastIndexOf('}')
  if (ob >= 0 && cb > ob) candidates.push(s.slice(ob, cb + 1))
  const oa = s.indexOf('[')
  const ca = s.lastIndexOf(']')
  if (oa >= 0 && ca > oa) candidates.push(s.slice(oa, ca + 1))
  for (const c of candidates) {
    const p = tryParse(c)
    if (p !== undefined) return p
  }
  return null
}

/** Trim + zamiana pustego na undefined. Liczby skończone zamienia na string. */
export function toStr(v: unknown): string | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : undefined
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t ? t : undefined
}

/** Ilość: liczba całkowita w [1, MAX_QTY]; brak/śmieć → 1. */
function toQuantity(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(MAX_QTY, Math.floor(n))
}

/**
 * Parsuje cenę ze stringa odpornie na separatory tysięcy i różne notacje (PL/US/EU):
 *  - oba separatory (`,` i `.`) → ostatni z nich jest dziesiętny, reszta to grupowanie,
 *  - jeden separator → dziesiętny tylko gdy po nim są 1–2 cyfry (np. `20,73`, `4.99`),
 *    w przeciwnym razie to grupowanie tysięcy (`10,000` → 10000, `1,299` → 1299).
 * Celowo NIE używamy `parsePlNumber` (CSV) — ono ucina `$1,234.56` do `1.234`.
 * Zwraca undefined dla braku liczby.
 */
export function parsePriceLoose(raw: string): number | undefined {
  const cleaned = raw.replace(/[^\d.,-]/g, '')
  if (!cleaned) return undefined
  const neg = cleaned.startsWith('-')
  const s = cleaned.replace(/-/g, '')
  const hasComma = s.includes(',')
  const hasDot = s.includes('.')

  let normalized: string
  if (hasComma && hasDot) {
    const dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.'
    const grp = dec === ',' ? '.' : ','
    normalized = s.split(grp).join('').replace(dec, '.')
  } else if (hasComma || hasDot) {
    const sep = hasComma ? ',' : '.'
    const parts = s.split(sep)
    const last = parts[parts.length - 1]
    normalized = parts.length === 2 && last.length >= 1 && last.length <= 2
      ? `${parts[0]}.${last}` // separator dziesiętny
      : parts.join('') // grupowanie tysięcy → usuń separatory
  } else {
    normalized = s
  }

  const n = Number(normalized)
  if (!Number.isFinite(n)) return undefined
  return neg ? -n : n
}

/** Cena: dodatnia liczba skończona; string parsujemy odpornie (separatory tysięcy itd.). */
function toPrice(v: unknown): number | undefined {
  let n: number | undefined
  if (typeof v === 'number') n = v
  else if (typeof v === 'string') n = parsePriceLoose(v)
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined
  return n
}

function toConfidence(v: unknown): ItemConfidence {
  return v === 'high' || v === 'medium' || v === 'low' ? v : 'low'
}

/**
 * Parsuje surowy tekst odpowiedzi modelu na listę przedmiotów. NIGDY nie rzuca:
 * błędny JSON → []. Akceptuje `{items:[…]}` oraz gołą tablicę. Odrzuca wiersze bez nazwy.
 */
export function parseExtractionResponse(text: string): ExtractedItem[] {
  const raw = parseJsonLoose(text)
  if (!raw) return []
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)
      ? (raw as { items: unknown[] }).items
      : null
  if (!arr) return []

  const out: ExtractedItem[] = []
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue
    const obj = r as Record<string, unknown>
    const name = toStr(obj.name)
    if (!name) continue
    out.push({
      name,
      brand: toStr(obj.brand),
      color: toStr(obj.color),
      size: toStr(obj.size),
      quantity: toQuantity(obj.quantity),
      unitPrice: toPrice(obj.unitPrice),
      priceText: toStr(obj.priceText),
      currency: toStr(obj.currency)?.toUpperCase(),
      bundle: Boolean(obj.bundle),
      confidence: toConfidence(obj.confidence),
    })
  }
  return out
}

/**
 * Rozwija przedmioty na szkice magazynu: każda sztuka (quantity) = osobny szkic,
 * bo na Vinted każdy egzemplarz to osobne ogłoszenie (zgodnie z modelem `importStock`,
 * który tworzy produkty z quantity:1 i deduplikuje multizbiorem po nazwie+koszcie).
 *
 * UWAGA (świadome ograniczenie): klucz deduplikacji to nazwa+koszt (zob. `stockImportKey`)
 * i NIE obejmuje wariantu (brand/color/size). Dwa różne warianty o tej samej nazwie i cenie
 * są więc traktowane jak ten sam przedmiot przy ponownym imporcie — spójnie z importem z CSV.
 * Pierwszy import wstawia oba poprawnie; rozjazd możliwy tylko przy częściowym re-imporcie.
 */
export function extractedToStockDrafts(items: ExtractedItem[]): StockDraft[] {
  const drafts: StockDraft[] = []
  for (const it of items) {
    const base: StockDraft = { name: it.name }
    if (it.unitPrice !== undefined) base.purchaseCost = it.unitPrice
    if (it.brand) base.brand = it.brand
    if (it.color) base.color = it.color
    if (it.size) base.sizeLabel = it.size
    const qty = Math.max(1, Math.min(MAX_QTY, Math.floor(it.quantity || 1)))
    for (let i = 0; i < qty; i++) drafts.push({ ...base })
  }
  return drafts
}

export interface RowFlags {
  /** Cena w walucie innej niż PLN — wymaga ręcznego przeliczenia (kursy się różnią). */
  nonPln: boolean
  /** Zestaw/komplet — cena prawdopodobnie nie jest za pojedynczą sztukę. */
  bundle: boolean
  lowConfidence: boolean
  /** Brak odczytanej ceny. */
  noPrice: boolean
}

const PLN_RE = /^(pln|zł|zl)$/i

/** Sygnały „sprawdź ten wiersz” liczone deterministycznie (nie z samooceny modelu). */
export function rowFlags(it: ExtractedItem): RowFlags {
  return {
    nonPln: it.currency != null && !PLN_RE.test(it.currency),
    bundle: it.bundle === true,
    lowConfidence: it.confidence === 'low',
    noPrice: it.unitPrice === undefined,
  }
}
