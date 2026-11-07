// Szkice ogłoszeń „Do wystawienia”: który towar z magazynu czeka na ogłoszenie, prompt dla
// Gemini (zdjęcie + fakty → tytuł i opis w JSON), sugestia ceny i tekst do wklejenia.
//
// Ten sam plik importuje scripts/drafts.ts uruchamiany gołym Node (strip-types), którego
// używa Lister (Claude), więc aplikacja i Lister liczą kolejkę i ceny identycznie. Stąd
// importy runtime tylko z czystych modułów i z rozszerzeniem `.ts` (Node go wymaga).
//
// Wystawia zawsze właściciel, ręcznie na Vinted: nic tutaj nie łączy się z Vinted.

import type { Design, ListingDraft, Product, Sale } from '@/db/types'
import { resolveProduct } from './designs.ts'
import { median } from './listing.ts'

/** Stan towaru w szkicu — cały towar jest nowy (patrz DEFAULT_CONDITION w constants.ts). */
export const DRAFT_CONDITION_LABEL = 'Nowy bez metki'

/** Tytuł bazowy (bez rozmiaru) prosimy o tyle znaków; twardy limit z rozmiarem — TITLE_MAX. */
export const TITLE_BASE_MAX = 55
export const TITLE_MAX = 70

/** Linia na początek opisu: zachęta do ofert (oferty kupujących podbijają zasięg — obserwacja właściciela). */
export const OFFER_LINE = 'Śmiało proponujcie swoją cenę 🙂'

/** Przypomnienie przy wystawianiu: Vinted ma przy zdjęciach pole „wygenerowane przez AI”. */
export const AI_PHOTOS_REMINDER =
  'Zdjęcia są wygenerowane przez AI: przy dodawaniu ogłoszenia na Vinted zaznacz, że zdjęcia są wygenerowane przez AI.'

/** Statusy sztuki, która czeka na ogłoszenie. 'draft' to starszy odpowiednik „w magazynie”. */
const WAITING: ReadonlySet<Product['status']> = new Set(['in_stock', 'draft'])

export interface DraftQueueItem {
  /** Id celu szkicu: modelu (Design) albo samodzielnego produktu. */
  key: string
  kind: 'design' | 'single'
  design?: Design
  /** Reprezentant z nałożonymi polami wspólnymi modelu (nazwa, zdjęcia…). */
  product: Product
  /** Sztuki czekające na ogłoszenie (każda sztuka to osobne ogłoszenie na Vinted). */
  units: Product[]
  /** Wszystkie sztuki modelu (ceny, ogłoszenia). Samodzielny: [product]. */
  members: Product[]
  draft?: ListingDraft
}

/**
 * Towar czekający na ogłoszenie: modele i samodzielne produkty z co najmniej jedną sztuką
 * w magazynie, która nie jest nigdzie wystawiona. `includeIncoming` dolicza też zamówione
 * (szkic można przygotować, zanim paczka dojdzie). Najpierw te bez szkicu, potem najnowsze.
 */
export function draftQueue(
  products: Product[],
  designs: Design[],
  opts: { includeIncoming?: boolean } = {},
): DraftQueueItem[] {
  const waiting = (p: Product) =>
    WAITING.has(p.status) || (opts.includeIncoming === true && p.status === 'incoming')
  const designsById = new Map(designs.map((d) => [d.id, d]))
  const members = new Map<string, Product[]>()
  const out: DraftQueueItem[] = []
  for (const p of products) {
    const d = p.designId ? designsById.get(p.designId) : undefined
    if (!d) {
      if (waiting(p))
        out.push({ key: p.id, kind: 'single', product: p, units: [p], members: [p], draft: p.listingDraft })
      continue
    }
    const arr = members.get(d.id)
    if (arr) arr.push(p)
    else members.set(d.id, [p])
  }
  for (const [designId, all] of members) {
    const units = all.filter(waiting)
    if (units.length === 0) continue
    const design = designsById.get(designId)!
    out.push({
      key: designId,
      kind: 'design',
      design,
      product: resolveProduct(units[0], designsById),
      units,
      members: all,
      draft: design.listingDraft,
    })
  }
  const createdAt = (it: DraftQueueItem) => it.design?.createdAt ?? it.product.createdAt
  return out.sort((a, b) => Number(!!a.draft) - Number(!!b.draft) || createdAt(b) - createdAt(a))
}

/** Rozmiary czekających sztuk z liczbą, w kolejności pierwszego wystąpienia: [['38', 2], ['37', 1]]. */
export function unitSizes(units: Product[]): [string, number][] {
  const m = new Map<string, number>()
  for (const u of units) {
    const s = sizeOf(u)
    m.set(s, (m.get(s) ?? 0) + 1)
  }
  return [...m]
}

/** Rozmiar sztuki do tytułu/formularza; '' gdy nieznany. */
export function sizeOf(p: Pick<Product, 'sizeLabel'>): string {
  const s = (p.sizeLabel ?? '').trim()
  return s === '?' ? '' : s
}

/** Tytuł na Vinted dla rozmiaru: tytuł bazowy + rozmiar (gdy go tam nie ma), przycięty do TITLE_MAX. */
export function titleForSize(title: string, size: string): string {
  const base = title.trim().replace(/\s+/g, ' ')
  const s = size.trim()
  const append = s !== '' && !base.toLowerCase().split(/[\s,]+/).includes(s.toLowerCase())
  const full = append ? `${base} ${s}` : base
  if (full.length <= TITLE_MAX) return full
  // Za długi: tniemy bazę po słowie, rozmiar zostaje na końcu (kupujący po nim filtrują).
  const room = TITLE_MAX - (append ? s.length + 1 : 0)
  let cut = base.slice(0, room)
  const sp = cut.lastIndexOf(' ')
  if (base.charAt(room) !== ' ' && sp > room / 2) cut = cut.slice(0, sp)
  return append ? `${cut.trimEnd()} ${s}` : cut.trimEnd()
}

// ── Cena ────────────────────────────────────────────────────────────────────

/** Ile ponad medianę dotychczasowych sprzedaży wystawiać (oferty schodzą zwykle o tyle). */
const OVER_MEDIAN = 1.12
/** Mnożniki ceny zakupu, gdy nie ma sprzedaży ani ceny: sprzedaże właściciela to ~2,2× zakupu. */
const PURCHASE_LIST_X = 2.5
const PURCHASE_MIN_X = 2

/** Zaokrąglenie „sklepowe”: od 100 zł do 5 zł, niżej do złotówki. */
export function roundPrice(n: number): number {
  return n >= 100 ? Math.round(n / 5) * 5 : Math.max(1, Math.round(n))
}

export interface PriceSuggestion {
  price: number
  minPrice: number
  basis: NonNullable<ListingDraft['priceBasis']>
}

/**
 * Cena szkicu, w kolejności pewności:
 *  1. cena wystawienia wpisana przez właściciela w magazynie (najwyższa wśród sztuk),
 *  2. mediana własnych sprzedaży tego modelu × 1,12 (najniższa oferta = mediana),
 *  3. cena zakupu × 2,5 (najniższa oferta = × 2) — do sprawdzenia, stąd `basis`.
 */
export function suggestDraftPrice(members: Product[], sales: Sale[]): PriceSuggestion | null {
  const listing = Math.max(0, ...members.filter((m) => m.status !== 'sold').map((m) => m.listingPrice ?? 0))
  if (listing > 0) return { price: listing, minPrice: roundPrice(listing * 0.85), basis: 'listing' }

  const ids = new Set(members.map((m) => m.id))
  const sold = median(
    sales
      .filter((s) => s.productId && ids.has(s.productId) && s.status === 'completed' && s.salePrice > 0)
      .map((s) => s.salePrice / Math.max(1, s.quantity || 1)),
  )
  if (sold != null) return { price: roundPrice(sold * OVER_MEDIAN), minPrice: roundPrice(sold), basis: 'sold' }

  const cost = median(members.map((m) => m.purchasePrice ?? 0).filter((c) => c > 0))
  if (cost != null)
    return { price: roundPrice(cost * PURCHASE_LIST_X), minPrice: roundPrice(cost * PURCHASE_MIN_X), basis: 'purchase' }
  return null
}

export const PRICE_BASIS_LABELS: Record<NonNullable<ListingDraft['priceBasis']>, string> = {
  listing: 'cena z magazynu',
  sold: 'Twoje sprzedaże tego modelu + 12%',
  purchase: 'cena zakupu × 2,5 — sprawdź',
  manual: 'ustalona ręcznie albo przez Listera',
}

// ── Prompt (Gemini: zdjęcie + fakty → JSON) ─────────────────────────────────

export const DRAFT_SYSTEM = [
  'Piszesz ogłoszenia na Vinted w Polsce dla osoby, która sprzedaje nowe ubrania, buty i dodatki.',
  'Masz zdjęcie przedmiotu i jego dane. Nazwa w danych pochodzi z chińskiego sklepu (AliExpress): to tylko wskazówka, czym jest przedmiot. Jej sformułowań nie kopiuj.',
  'Tytuł: tak, jak kupujący wpisują w wyszukiwarkę Vinted: rodzaj rzeczy, dla kogo (damskie/męskie, gdy wynika to z danych albo zdjęcia), najważniejsza cecha lub styl, kolor. Naturalnie, po polsku, małymi literami jest OK.',
  `Tytuł ma najwyżej ${TITLE_BASE_MAX} znaków i jest bez rozmiaru (rozmiar dopisuje aplikacja), bez emoji i bez wykrzykników.`,
  `Opis zaczyna się dokładnie od zdania: "${OFFER_LINE}". Potem 2–4 krótkie zdania w pierwszej osobie, swobodnie, jak zwykła osoba na Vinted: co to jest, jak wygląda i jak się nosi, że jest nowe. Na końcu w osobnej linii 3–5 trafnych hasztagów.`,
  'Pisz tylko to, co widać na zdjęciu albo co jest w danych. Markę, skład materiału i wymiary podawaj wyłącznie wtedy, gdy są w danych. Czego nie wiesz, tego nie piszesz.',
  'Bez języka reklamy i bez superlatyw. Polskie znaki obowiązkowo.',
  'Pole "warnings": krótkie uwagi dla sprzedającego, co sprawdzić przed wystawieniem (np. kolor na zdjęciu inny niż w danych, nieczytelny wariant). Pusta lista, gdy wszystko się zgadza.',
].join('\n')

/** Schemat odpowiedzi (podzbiór OpenAPI Gemini, typy WIELKIMI literami). */
export const DRAFT_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    description: { type: 'STRING' },
    category: { type: 'STRING', description: 'Kategoria Vinted, np. "Kobiety > Buty > Kowbojki"' },
    color: { type: 'STRING', description: 'Główny kolor po polsku, jak w formularzu Vinted' },
    material: { type: 'STRING', description: 'Tylko gdy podany w danych; inaczej pusty' },
    warnings: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['title', 'description', 'warnings'],
} as const

/** Fakty o przedmiocie wstrzykiwane do promptu (tylko wypełnione pola). */
export function draftFacts(item: Pick<DraftQueueItem, 'product' | 'units'>, hasPhoto: boolean): string {
  const p = item.product
  const lines: string[] = []
  const add = (label: string, v?: string | number) => {
    if (v != null && String(v).trim()) lines.push(`- ${label}: ${String(v).trim()}`)
  }
  add('Nazwa ze sklepu', p.name)
  add('Marka', p.brand)
  add('Kategoria', p.category)
  // Wariant koloru z AliExpress bywa śmieciowy („2”, „3.5cm Black”) — prompt prosi o weryfikację ze zdjęciem.
  add('Wariant (kolor) ze sklepu', p.color)
  add('Materiał', p.material)
  add('Stan', DRAFT_CONDITION_LABEL)
  add('Rozmiary na stanie', unitSizes(item.units).map(([s]) => s).filter(Boolean).join(', '))
  if (p.tags.length) add('Słowa kluczowe', p.tags.join(', '))
  add('Uwagi sprzedającego', p.notes)
  if (!hasPhoto) lines.push('- (brak zdjęcia: pisz ogólnie, na podstawie nazwy, i dodaj uwagę, że trzeba dodać zdjęcie)')
  return lines.join('\n')
}

export function buildDraftPrompt(item: Pick<DraftQueueItem, 'product' | 'units'>, hasPhoto: boolean): string {
  return [
    DRAFT_SYSTEM,
    '',
    'Dane przedmiotu:',
    draftFacts(item, hasPhoto),
    '',
    'Zwróć JSON: title, description, category, color, material, warnings.',
  ].join('\n')
}

export interface DraftText {
  title: string
  description: string
  category?: string
  color?: string
  material?: string
  warnings: string[]
}

/** Opis zaczyna się od zachęty do ofert — dopisujemy OFFER_LINE, gdy model ją pominął. */
export function ensureOfferLine(description: string): string {
  const d = description.trim()
  const head = d.slice(0, 160).toLowerCase()
  if (/propon\w*\s+(\S+\s+)?cen|ofert/.test(head)) return d
  return `${OFFER_LINE}\n\n${d}`
}

/**
 * Układ opisu, gdy model zwrócił jedną linię: zdanie o ofertach w osobnym akapicie,
 * hasztagi z końca w osobnej linii (tak czyta się je na Vinted).
 */
export function tidyDescription(description: string): string {
  let d = ensureOfferLine(description)
  if (d.startsWith(OFFER_LINE)) d = `${OFFER_LINE}\n\n${d.slice(OFFER_LINE.length).trimStart()}`
  // Hasztagi doklejone do ostatniego zdania (a nie już osobna linia hasztagów) → osobna linia.
  const lines = d.split('\n')
  const last = lines[lines.length - 1]
  const m = /^(.*?\S)[ \t]+((?:#[\p{L}\p{N}_]+[ \t]*)+)$/u.exec(last)
  if (m && !m[1].trimStart().startsWith('#')) lines.splice(-1, 1, m[1], '', m[2].trim())
  return lines.join('\n').trim()
}

const opt = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined

/**
 * Parsuje odpowiedź modelu (nigdy nie ufamy, że to czysty JSON: zdejmujemy płotki ```).
 * Rzuca Error z czytelnym komunikatem, gdy brakuje tytułu albo opisu.
 */
export function parseDraftResponse(raw: string): DraftText {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  let j: Record<string, unknown>
  try {
    j = JSON.parse(cleaned) as Record<string, unknown>
  } catch {
    throw new Error('Model zwrócił niepoprawny JSON. Spróbuj ponownie.')
  }
  const title = opt(j.title)?.replace(/\s+/g, ' ')
  const description = opt(j.description)
  if (!title || !description) throw new Error('Model nie zwrócił tytułu albo opisu. Spróbuj ponownie.')
  return {
    title: title.length > TITLE_MAX ? titleForSize(title, '') : title,
    description: tidyDescription(description),
    category: opt(j.category),
    color: opt(j.color),
    material: opt(j.material),
    warnings: Array.isArray(j.warnings) ? j.warnings.map(opt).filter((w): w is string => !!w) : [],
  }
}

// ── Tekst do wklejenia ──────────────────────────────────────────────────────

/**
 * Cały szkic jako tekst do wklejenia (przycisk „Kopiuj wszystko”, wyjście CLI dla Listera).
 * `aiPhotos` dokleja przypomnienie o polu „zdjęcia wygenerowane przez AI”.
 */
export function pasteBlock(draft: ListingDraft, size: string, aiPhotos: boolean): string {
  const lines = [`Tytuł: ${titleForSize(draft.title, size)}`]
  if (draft.price) lines.push(`Cena: ${draft.price} zł${draft.minPrice ? ` (najniższa oferta: ${draft.minPrice} zł)` : ''}`)
  if (size) lines.push(`Rozmiar: ${size}`)
  lines.push(`Stan: ${DRAFT_CONDITION_LABEL}`)
  if (draft.category) lines.push(`Kategoria: ${draft.category}`)
  if (draft.color) lines.push(`Kolor: ${draft.color}`)
  if (draft.material) lines.push(`Materiał: ${draft.material}`)
  lines.push('', 'Opis:', draft.description)
  if (aiPhotos) lines.push('', `⚠️ ${AI_PHOTOS_REMINDER}`)
  return lines.join('\n')
}
