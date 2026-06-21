// Czysta logika rozpoznawania KOSZTU PROMOCJI ze zrzutu ekranu Vinted (podbicie /
// ekspozycja szafy) — bez React, bez Dexie, bez sieci. Vision (Gemini) zwraca JSON;
// tutaj go bezpiecznie parsujemy, walidujemy i mapujemy na szkic kosztu. Nigdy nie
// ufamy, że model zwróci czysty/poprawny JSON ani że poprawnie policzy kwotę — parser
// NIGDY nie rzuca, a flagi „sprawdź" liczymy deterministycznie (nie z samooceny modelu).
import type { ExpenseKind } from '@/db/types'
import { parseJsonLoose, parsePriceLoose, toStr } from '@/lib/screenshotImport'

/** Czasy trwania promocji oferowane przez Vinted (dni). Jedyne źródło prawdy tej reguły. */
export const PROMO_DURATIONS = [3, 7] as const

/** Etykieta klasyfikacji zwracana przez model (enum — bez dryfu w wolny tekst). */
export type PromotionLabel = 'PODBICIE' | 'EKSPOZYCJA_SZAFY' | 'UNKNOWN'

/** Pojedynczy koszt promocji odczytany ze zrzutu (po walidacji/koercji). */
export interface PromotionDraft {
  /** Surowa etykieta z modelu (po koercji do enuma). */
  label: PromotionLabel
  /** Rodzaj kosztu zmapowany z etykiety (boost/exposure/other). */
  kind: ExpenseKind
  /** Zapłacona kwota (zł), dodatnia. undefined, gdy nieczytelna. */
  amount?: number
  /** Dosłowny tekst kwoty ze zrzutu (np. "14,95 zł") — do podglądu/audytu i parsowania. */
  rawAmountText?: string
  /** Wykryta waluta (wielkimi literami), np. PLN. */
  currency?: string
  /** Czas trwania promocji w dniach (Vinted: 3 lub 7). undefined, gdy nieczytelny. */
  durationDays?: number
  /** Data zakupu tak, jak na ekranie (np. "12.03.2026"). */
  purchaseDate?: string
  /** Pewność modelu 0–1 (sklampowana). */
  confidence: number
}

/** Sygnały „sprawdź ten odczyt" liczone deterministycznie w kodzie (nie z modelu). */
export interface PromotionFlags {
  /** Model nie rozpoznał rodzaju promocji — wymaga ręcznego wyboru. */
  unknownType: boolean
  /** Brak odczytanej kwoty — wymaga ręcznego wpisania. */
  noAmount: boolean
  /** Niska pewność odczytu (<0,6). */
  lowConfidence: boolean
  /** Kwota nietypowa dla rozpoznanego rodzaju (np. podbicie >30 zł). */
  amountOutOfRange: boolean
  /** Czas trwania inny niż 3 lub 7 dni. */
  durationOdd: boolean
  /** Kwota nie pasuje do etykiety (np. ~15 zł przy „podbiciu" = raczej szafa). */
  labelAmountMismatch: boolean
  /** Waluta inna niż PLN — wymaga ręcznego potwierdzenia kwoty w zł. */
  nonPln: boolean
}

// ---------------------------------------------------------------------------
// Schemat odpowiedzi Gemini (podzbiór OpenAPI; typy WIELKIMI literami; `format:'enum'`
// + `propertyOrdering` poprawiają spójność generacji). Korzeń to OBJECT — jeden zakup
// promocji = jeden wynik (w odróżnieniu od importu magazynu, który zwraca listę).
// ---------------------------------------------------------------------------
export const PROMOTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    label: {
      type: 'STRING',
      format: 'enum',
      enum: ['PODBICIE', 'EKSPOZYCJA_SZAFY', 'UNKNOWN'],
      description:
        'Vinted promotion type. EKSPOZYCJA_SZAFY when the receipt is about the whole wardrobe/closet ("szafa", "Promowanie szafy", "Ekspozycja", "Promuj szafę"). PODBICIE when it shows a single item plus "Podbicie"/"Podbij". UNKNOWN if it is not a Vinted promotion receipt.',
    },
    amount: {
      type: 'NUMBER',
      nullable: true,
      description:
        'Final TOTAL paid for the promotion as a decimal number (the value next to "Razem" / "Do zapłaty" / "Zapłacono"). NOT a subtotal or a discount line. null if not readable.',
    },
    rawAmountText: {
      type: 'STRING',
      nullable: true,
      description: 'The verbatim on-screen total exactly as printed, e.g. "14,95 zł". Keep the comma and "zł". Do NOT convert or round.',
    },
    currency: { type: 'STRING', nullable: true, description: 'Currency code, usually PLN. null if unknown.' },
    durationDays: { type: 'INTEGER', nullable: true, description: 'Promotion length in days, usually 3 or 7. null if not shown.' },
    purchaseDate: { type: 'STRING', nullable: true, description: 'Purchase / payment date as printed (e.g. "12.03.2026"). null if absent.' },
    confidence: { type: 'NUMBER', description: 'Your confidence 0.0–1.0 that the label and amount are correct.' },
  },
  required: ['label', 'confidence'],
  propertyOrdering: ['label', 'amount', 'rawAmountText', 'currency', 'durationDays', 'purchaseDate', 'confidence'],
}

// ---------------------------------------------------------------------------
// Prompt rozpoznawania. Pisany po angielsku dla precyzji — model rozumie polskie
// etykiety interfejsu (Razem, Do zapłaty, Zapłacono, szafa…) niezależnie od języka promptu.
// ---------------------------------------------------------------------------
export const PROMOTION_PROMPT = `You read ONE screenshot of a Polish Vinted PROMOTION purchase or payment confirmation and return ONLY JSON matching the provided schema.

Vinted has two paid promotions:
- "Podbicie" (item Bump): boosts a SINGLE listing. The screen shows one item and the word "Podbicie"/"Podbij", a duration ("3 dni" / "7 dni"), and a small fee (usually a few zł). → label PODBICIE.
- "Promowanie szafy" / "Ekspozycja szafy" (Wardrobe Spotlight): promotes the WHOLE wardrobe. The screen mentions the wardrobe/closet ("szafa", "Promowanie szafy", "Ekspozycja", "Promuj szafę"), "7 dni", and a higher amount (≈14,95 zł). → label EKSPOZYCJA_SZAFY.

Rules:
- label: classify using the cue words above. If the screenshot is NOT a Vinted promotion purchase/confirmation, return label "UNKNOWN".
- amount: the FINAL paid total — the value next to "Razem", "Do zapłaty" or "Zapłacono". Never return a subtotal, a struck-through price, or a discount line. null if not clearly readable.
- rawAmountText: copy that total EXACTLY as printed, including the comma and "zł" (e.g. "14,95 zł"). Do NOT convert currency and do NOT round.
- currency: the currency code shown (usually PLN). null if unknown.
- durationDays: the promotion length in days if shown (usually 3 or 7). null otherwise.
- purchaseDate: the payment/purchase date as printed, if visible. null otherwise.
- confidence: 0.0–1.0, your honest confidence in the label and amount.
- If a field is not clearly visible, return null for it. NEVER guess.`

// ---------------------------------------------------------------------------
// Koercje pomocnicze (nigdy nie rzucają)
// ---------------------------------------------------------------------------

/** Kwota: dodatnia, skończona; string parsujemy odpornie (separatory PL/tysięcy). */
function toPositive(v: unknown): number | undefined {
  let n: number | undefined
  if (typeof v === 'number') n = v
  else if (typeof v === 'string') n = parsePriceLoose(v)
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined
  return n
}

/** Czas trwania: dodatnia liczba całkowita; brak/śmieć → undefined. */
function toDuration(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.floor(n)
}

/** Pewność: liczba skłampowana do [0,1]; brak/śmieć → 0. */
function toConfidence(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/** Etykieta: koercja wielkością liter do enuma; nieznane → UNKNOWN. */
function toLabel(v: unknown): PromotionLabel {
  const s = typeof v === 'string' ? v.trim().toUpperCase() : ''
  return s === 'PODBICIE' || s === 'EKSPOZYCJA_SZAFY' ? s : 'UNKNOWN'
}

/** Mapuje etykietę klasyfikacji na istniejący rodzaj kosztu. */
export function labelToKind(label: PromotionLabel): ExpenseKind {
  if (label === 'PODBICIE') return 'boost'
  if (label === 'EKSPOZYCJA_SZAFY') return 'exposure'
  return 'other'
}

/**
 * Jedyne miejsce egzekwujące regułę „czas trwania dotyczy tylko podbicia/ekspozycji i może
 * być wyłącznie 3 lub 7 dni". Inne odczyty (np. 5 dni z błędu OCR lub czas przy 'other')
 * sprowadzamy do undefined, dzięki czemu formularz pokazuje dokładnie to, co zostanie zapisane.
 */
export function normalizeDuration(kind: ExpenseKind, days: number | undefined): number | undefined {
  return kind !== 'other' && days !== undefined && (PROMO_DURATIONS as readonly number[]).includes(days) ? days : undefined
}

/**
 * Parsuje surowy tekst odpowiedzi modelu na jeden szkic kosztu. NIGDY nie rzuca:
 * błędny JSON / nie-obiekt → bezpieczny domyślny szkic (UNKNOWN, brak kwoty, pewność 0).
 * Kwotę bierzemy najpierw z dosłownego `rawAmountText` (najbardziej wiarygodne), a w
 * razie braku z liczbowego `amount` — nigdy nie ufamy arytmetyce modelu na ślepo.
 */
export function parsePromotionResponse(text: string): PromotionDraft {
  const raw = parseJsonLoose(text)
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}

  const label = toLabel(obj.label)
  const rawAmountText = toStr(obj.rawAmountText)
  // Dosłowny tekst kwoty jest najbardziej wiarygodny; liczbowy `amount` to rezerwa.
  const amount = toPositive(rawAmountText) ?? toPositive(obj.amount)

  return {
    label,
    kind: labelToKind(label),
    amount,
    rawAmountText,
    currency: toStr(obj.currency)?.toUpperCase(),
    durationDays: toDuration(obj.durationDays),
    purchaseDate: toStr(obj.purchaseDate),
    confidence: toConfidence(obj.confidence),
  }
}

const PLN_RE = /^(pln|zł|zl)$/i

/**
 * Wiarygodne zakresy kwot (zł) dla rozpoznanego rodzaju — do flagi „kwota nietypowa".
 * Podbicie to opłata jednocyfrowa/niskie dwucyfrowe; ekspozycja szafy ≈ kilkanaście zł.
 */
const BOOST_MAX = 30
const EXPOSURE_MIN = 3
const EXPOSURE_MAX = 100
/** Próg „kwota pasuje raczej do drugiego rodzaju" (≈14,95 zł = szafa, ≈5 zł = podbicie). */
const MISMATCH_HIGH = 12
const MISMATCH_LOW = 6

/** Sygnały „sprawdź ten odczyt" liczone deterministycznie (nie z samooceny modelu). */
export function promotionFlags(d: PromotionDraft): PromotionFlags {
  const a = d.amount
  return {
    unknownType: d.label === 'UNKNOWN',
    noAmount: a === undefined,
    lowConfidence: d.confidence < 0.6,
    amountOutOfRange:
      a !== undefined &&
      ((d.kind === 'boost' && a > BOOST_MAX) ||
        (d.kind === 'exposure' && (a < EXPOSURE_MIN || a > EXPOSURE_MAX))),
    durationOdd: d.durationDays !== undefined && !(PROMO_DURATIONS as readonly number[]).includes(d.durationDays),
    labelAmountMismatch:
      a !== undefined &&
      ((d.kind === 'boost' && a >= MISMATCH_HIGH) || (d.kind === 'exposure' && a <= MISMATCH_LOW)),
    nonPln: d.currency != null && !PLN_RE.test(d.currency),
  }
}
