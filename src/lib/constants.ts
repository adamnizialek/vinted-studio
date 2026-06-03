import type { Condition, ProductStatus, SaleStatus } from '@/db/types'

export const CONDITION_LABELS: Record<Condition, string> = {
  nowy_z_metka: 'Nowy z metką',
  nowy_bez_metki: 'Nowy bez metki',
  bardzo_dobry: 'Bardzo dobry',
  dobry: 'Dobry',
  zadowalajacy: 'Zadowalający',
}

export const CONDITION_OPTIONS = Object.entries(CONDITION_LABELS).map(
  ([value, label]) => ({ value: value as Condition, label }),
)

export const STATUS_LABELS: Record<ProductStatus, string> = {
  draft: 'Szkic',
  in_stock: 'W magazynie',
  listed: 'Wystawione',
  reserved: 'Zarezerwowane',
  sold: 'Sprzedane',
  archived: 'Archiwum',
}

export const STATUS_OPTIONS = Object.entries(STATUS_LABELS).map(
  ([value, label]) => ({ value: value as ProductStatus, label }),
)

/** Kolory statusow (klasy Tailwind) dla znacznikow. */
export const STATUS_TONE: Record<ProductStatus, string> = {
  draft: 'bg-ink-100 text-ink-700',
  in_stock: 'bg-blue-100 text-blue-700',
  listed: 'bg-brand-100 text-brand-700',
  reserved: 'bg-amber-100 text-amber-700',
  sold: 'bg-emerald-100 text-emerald-700',
  archived: 'bg-ink-100 text-ink-500',
}

export const SALE_STATUS_LABELS: Record<SaleStatus, string> = {
  completed: 'Zakończona',
  pending: 'W toku',
  cancelled: 'Anulowana',
  returned: 'Zwrot',
}

/** Podpowiedzi kategorii (Vinted PL) — pole pozostaje dowolnym tekstem. */
export const CATEGORY_SUGGESTIONS = [
  'Kobiety / Ubrania',
  'Kobiety / Buty',
  'Kobiety / Torebki',
  'Kobiety / Akcesoria',
  'Mężczyźni / Ubrania',
  'Mężczyźni / Buty',
  'Mężczyźni / Akcesoria',
  'Dzieci / Ubrania',
  'Dzieci / Buty',
  'Dzieci / Zabawki',
  'Dom',
  'Elektronika',
  'Rozrywka',
  'Uroda',
]

/** Najczestsze rozmiary do szybkiego wyboru. */
export const SIZE_SUGGESTIONS = [
  'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL',
  '32', '34', '36', '38', '40', '42', '44', '46',
  '/ obuwie /', '35', '36', '37', '38', '39', '40', '41', '42', '43', '44', '45',
]

export const CURRENCY_OPTIONS = ['PLN', 'EUR', 'CZK', 'GBP', 'USD']

/** Dostepne modele Gemini (mozna nadpisac dowolnym ID w Ustawieniach). */
export const TEXT_MODEL_OPTIONS = [
  { value: 'gemini-2.5-flash', label: 'gemini-2.5-flash (stabilny, tani)' },
  { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro (najlepsza jakość)' },
  { value: 'gemini-3.5-flash', label: 'gemini-3.5-flash (najnowszy flash)' },
  { value: 'gemini-2.0-flash', label: 'gemini-2.0-flash (fallback)' },
]

export const IMAGE_MODEL_OPTIONS = [
  { value: 'gemini-2.5-flash-image', label: 'gemini-2.5-flash-image (Nano Banana)' },
  { value: 'gemini-3.1-flash-image', label: 'gemini-3.1-flash-image (Nano Banana 2)' },
  { value: 'gemini-3-pro-image', label: 'gemini-3-pro-image (Nano Banana Pro)' },
]

export const DEFAULT_TEXT_MODEL = 'gemini-2.5-flash'
export const DEFAULT_IMAGE_MODEL = 'gemini-2.5-flash-image'

/**
 * Szacunkowy koszt jednego wygenerowanego obrazu (USD) dla Gemini 2.5 Flash Image
 * przy 1024x1024 (1290 tokenow x $30/1M). Modele 3.x / wyzsze rozdzielczosci moga
 * kosztowac wiecej. UWAGA: generowanie obrazow przez API NIE ma darmowego limitu.
 * Zrodlo: https://ai.google.dev/gemini-api/docs/pricing
 */
export const EST_IMAGE_COST_USD = 0.039

/** Przybliżony kurs USD→PLN tylko do orientacyjnego pokazania kosztu. */
export const USD_PLN = 4.0

/** Predefiniowane kolory kont. */
export const ACCOUNT_COLORS = [
  '#0b9b82', '#6366f1', '#ec4899', '#f59e0b',
  '#ef4444', '#14b8a6', '#8b5cf6', '#0ea5e9',
]
