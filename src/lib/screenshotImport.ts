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

/** Podsumowanie pieniężne zamówienia (nie pozycja) — do rozłożenia wysyłki/cła na sztuki. */
export interface OrderTotals {
  /** Wielka suma faktycznie zapłacona ("Suma") — z wysyłką/cłem/podatkiem, po rabatach. */
  orderTotal?: number
  /** Suma częściowa pozycji ("Podsuma") — przed wysyłką. Do audytu/sanity-check. */
  subtotal?: number
  /** Sama wysyłka, gdy widoczna osobno. Do audytu. */
  shipping?: number
  /** Waluta sum (wielkimi literami). */
  currency?: string
}

/** Pełny odczyt: pozycje + podsumowanie pieniężne zamówienia. */
export interface ExtractedResult {
  items: ExtractedItem[]
  order: OrderTotals
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
    // Podsumowanie pieniężne zamówienia (NIE pozycje). Pozwala rozłożyć wysyłkę/cło na sztuki.
    orderSubtotal: {
      type: 'NUMBER',
      nullable: true,
      description: 'The items subtotal BEFORE shipping (labels: "Podsuma", "Subtotal", "Suma częściowa"). null if not shown.',
    },
    orderTotal: {
      type: 'NUMBER',
      nullable: true,
      description:
        'The FINAL amount ACTUALLY PAID for the whole order — the bottom amount-to-pay line (labels: "Suma", "Razem", "Łącznie", "Do zapłaty", "Total"). It already includes shipping and customs/tax and subtracts any discounts/coins, so take the discounted amount even when it is SMALLER than the items subtotal, and ignore any struck-through original total. This is NOT the items subtotal ("Podsuma" / "Suma częściowa" / "Subtotal"); never return a subtotal. null if multiple separate orders are shown or it is not clearly readable.',
    },
    orderShipping: {
      type: 'NUMBER',
      nullable: true,
      description: 'Shipping/delivery fee if shown as its own line (labels: "Dostawa", "Wysyłka", "Shipping"). null if free or not shown.',
    },
    orderCurrency: { type: 'STRING', nullable: true, description: 'Currency code of the order totals, e.g. PLN, USD, EUR. null if unknown.' },
  },
  required: ['items'],
  propertyOrdering: ['items', 'orderSubtotal', 'orderTotal', 'orderShipping', 'orderCurrency'],
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
- Do NOT add shipping, tax, discounts, coins or totals as item rows — they are NOT items. Instead capture the money summary in the top-level order fields below.

Order money summary (top-level fields, NOT items):
- orderTotal: the FINAL amount ACTUALLY PAID for the whole order — the bottom "amount to pay" line (labels: "Suma", "Razem", "Łącznie", "Do zapłaty", "Total"). It already includes shipping and customs/tax and subtracts any discounts/coins, so use the discounted amount even when it is SMALLER than the items subtotal, and ignore any struck-through original total. This number lets us spread shipping across the items, so read it carefully. It is NOT the items subtotal — never return a subtotal here.
- orderSubtotal: the items subtotal BEFORE shipping ("Podsuma" / "Suma częściowa" / "Subtotal"). orderShipping: the shipping/delivery line if shown ("Dostawa" / "Wysyłka" / "Shipping"). orderCurrency: the currency of these totals.
- If a total is not visible, return null for it. If screenshots show MORE THAN ONE order/shop, return null for orderTotal (do not sum across separate orders).
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

function parseItemsFrom(raw: unknown): ExtractedItem[] {
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

function parseOrderFrom(raw: unknown): OrderTotals {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const obj = raw as Record<string, unknown>
  const order: OrderTotals = {}
  const total = toPrice(obj.orderTotal)
  const subtotal = toPrice(obj.orderSubtotal)
  const shipping = toPrice(obj.orderShipping)
  const currency = toStr(obj.orderCurrency)?.toUpperCase()
  if (total !== undefined) order.orderTotal = total
  if (subtotal !== undefined) order.subtotal = subtotal
  if (shipping !== undefined) order.shipping = shipping
  if (currency !== undefined) order.currency = currency
  return order
}

/**
 * Parsuje surowy tekst odpowiedzi modelu na pozycje + podsumowanie zamówienia. NIGDY nie
 * rzuca: błędny JSON → puste. Akceptuje `{items:[…]}` oraz gołą tablicę (wtedy brak sum).
 */
export function parseExtractionResult(text: string): ExtractedResult {
  const raw = parseJsonLoose(text)
  return { items: parseItemsFrom(raw), order: parseOrderFrom(raw) }
}

/** Wstecznie zgodny skrót: same pozycje (bez podsumowania). Odrzuca wiersze bez nazwy. */
export function parseExtractionResponse(text: string): ExtractedItem[] {
  return parseItemsFrom(parseJsonLoose(text))
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
export function extractedToStockDrafts(items: ExtractedItem[], landedUnit?: (number | undefined)[]): StockDraft[] {
  const drafts: StockDraft[] = []
  items.forEach((it, idx) => {
    // Koszt do zapisu = landed (z dostawą), gdy podano; inaczej cena odczytana. Klucz dedup
    // (keyCost) trzyma cenę ODCZYTANĄ, by ponowny import był idempotentny mimo zmiany sumy.
    const cost = landedUnit?.[idx] ?? it.unitPrice
    const base: StockDraft = { name: it.name }
    if (cost !== undefined) base.purchaseCost = cost
    if (it.unitPrice !== undefined && it.unitPrice !== cost) base.keyCost = it.unitPrice
    if (it.brand) base.brand = it.brand
    if (it.color) base.color = it.color
    if (it.size) base.sizeLabel = it.size
    const qty = Math.max(1, Math.min(MAX_QTY, Math.floor(it.quantity || 1)))
    for (let i = 0; i < qty; i++) drafts.push({ ...base })
  })
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

// ---------------------------------------------------------------------------
// Rozłożenie kosztu landed (wysyłka/cło w cenie sztuki)
// ---------------------------------------------------------------------------

/** Zaokrąglenie do grosza (2 miejsca po przecinku). */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Współczynnik landed = (wielka suma zamówienia) / (suma częściowa pozycji ważona ilością).
 * >1 gdy wysyłka/cło podnoszą koszt; <1 przy rabacie/monetach obniżających sumę.
 * Zwraca undefined, gdy nie da się rzetelnie rozłożyć:
 *  - brak / niedodatnia suma zamówienia,
 *  - pusta lista,
 *  - którakolwiek pozycja bez ceny (suma częściowa nieznana),
 *  - jakakolwiek pozycja w obcej walucie (nie wolno mieszać z sumą w zł).
 */
export function landedFactor(items: ExtractedItem[], orderTotal: number | undefined): number | undefined {
  if (orderTotal === undefined || !Number.isFinite(orderTotal) || orderTotal <= 0) return undefined
  if (items.length === 0) return undefined
  let subtotal = 0
  for (const it of items) {
    if (it.unitPrice === undefined) return undefined
    if (rowFlags(it).nonPln) return undefined
    subtotal += it.unitPrice * it.quantity
  }
  if (subtotal <= 0) return undefined
  return orderTotal / subtotal
}

/**
 * Rozkłada wielką sumę zamówienia (z wysyłką/cłem, po rabatach) na pozycje PROPORCJONALNIE
 * do ich wartości — by `purchaseCost` (cena za sztukę) oddawał realny koszt landed. Zwraca
 * NOWĄ listę z nadpisanym `unitPrice`; pozostałe pola (w tym `priceText` z oryginalnego
 * odczytu) bez zmian. Resztę z zaokrąglenia parkuje na pozycji o ILOŚCI 1 (jeśli istnieje),
 * więc suma kosztów (cena×ilość) trafia w sumę zamówienia co do grosza w typowym zamówieniu.
 * Gdy WSZYSTKIE pozycje mają ilość > 1, dokładne trafienie jedną ceną za sztukę bywa
 * niemożliwe — zostaje minimalna reszta (≤ ~liczba sztuk groszy). Cena nigdy nie schodzi < 0.
 * Gdy rozkład się nie stosuje (zob. `landedFactor`), zwraca pozycje bez zmiany ceny.
 */
export function allocateLandedCosts(items: ExtractedItem[], orderTotal: number | undefined): ExtractedItem[] {
  const factor = landedFactor(items, orderTotal)
  if (factor === undefined) return items.map((it) => ({ ...it }))

  const out = items.map((it) => ({ ...it, unitPrice: round2((it.unitPrice as number) * factor) }))
  const achieved = out.reduce((n, it) => n + (it.unitPrice as number) * it.quantity, 0)
  const drift = round2((orderTotal as number) - achieved)
  if (drift !== 0) {
    // Parkuj resztę na ostatniej pozycji o ilości 1 (wtedy reszta wchodzi w całości); gdy takiej
    // nie ma — na ostatniej pozycji (reszta dzielona przez ilość, więc trafienie przybliżone).
    let target = out.length - 1
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].quantity === 1) {
        target = i
        break
      }
    }
    const t = out[target]
    t.unitPrice = Math.max(0, round2((t.unitPrice as number) + drift / t.quantity))
  }
  return out
}
