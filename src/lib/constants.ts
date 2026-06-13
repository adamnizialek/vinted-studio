import type { Condition, ExpenseKind, ImageResolution, ProductStatus, SaleStatus } from '@/db/types'

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

export const EXPENSE_KIND_LABELS: Record<ExpenseKind, string> = {
  boost: 'Podbicie',
  exposure: 'Ekspozycja',
  other: 'Inne',
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
  { value: 'gemini-3.1-flash-image', label: 'gemini-3.1-flash-image (Nano Banana 2) — zalecany' },
  { value: 'gemini-3-pro-image', label: 'gemini-3-pro-image (Nano Banana Pro) — najwyższa jakość' },
  { value: 'gemini-2.5-flash-image', label: 'gemini-2.5-flash-image (Nano Banana, tylko 1024px)' },
]

export const IMAGE_RESOLUTION_OPTIONS: { value: ImageResolution; label: string }[] = [
  { value: '1K', label: '1K (~1024px, najtaniej)' },
  { value: '2K', label: '2K (~2048px, zalecane dla Vinted)' },
  { value: '4K', label: '4K (~4096px, maks. jakość)' },
]

export const DEFAULT_TEXT_MODEL = 'gemini-2.5-flash'
export const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image'
export const DEFAULT_IMAGE_RESOLUTION: ImageResolution = '2K'

/**
 * Orientacyjny koszt jednego wygenerowanego obrazu (USD) wg modelu i rozdzielczosci.
 * Zrodlo: oficjalny cennik Gemini API (https://ai.google.dev/gemini-api/docs/pricing).
 * UWAGA: generowanie obrazow przez API NIE ma darmowego limitu — placisz od 1. uzycia.
 * - gemini-2.5-flash-image renderuje zawsze ~1MP, wiec ignoruje wyzsza rozdzielczosc.
 */
const IMAGE_COST_USD: Record<
  string,
  { default: number } & Partial<Record<ImageResolution, number>>
> = {
  'gemini-2.5-flash-image': { '1K': 0.039, default: 0.039 },
  'gemini-3.1-flash-image': { '1K': 0.067, '2K': 0.101, '4K': 0.15, default: 0.101 },
  'gemini-3-pro-image': { '1K': 0.134, '2K': 0.134, '4K': 0.24, default: 0.134 },
}

/** Ostrozny fallback dla nieznanego modelu (zeby kosztorys nie pokazywal $0). */
const FALLBACK_IMAGE_COST_USD = 0.1

/** Szacunkowy koszt (USD) jednego obrazu dla danego modelu i rozdzielczosci. */
export function estimateImageCostUsd(model: string, resolution: ImageResolution): number {
  const perModel = IMAGE_COST_USD[model]
  if (!perModel) return FALLBACK_IMAGE_COST_USD
  return perModel[resolution] ?? perModel.default
}

/** Przybliżony kurs USD→PLN tylko do orientacyjnego pokazania kosztu. */
export const USD_PLN = 4.0

/** Predefiniowane kolory kont. */
export const ACCOUNT_COLORS = [
  '#0b9b82', '#6366f1', '#ec4899', '#f59e0b',
  '#ef4444', '#14b8a6', '#8b5cf6', '#0ea5e9',
]
