// Czyste funkcje cyklu życia oferty (wystawienie → sprzedaż). Bez Dexie/React,
// w pełni testowalne. Czas wszędzie jako epoch-ms (spójnie z resztą bazy).
import type { DesignListing, ID, Product } from '@/db/types'

export const DAY_MS = 86_400_000

/** Po ilu dniach wystawiona oferta trafia do kolejki „Wymaga uwagi”. */
export const STALE_LISTING_DAYS = 30

/** Pełne dni (w dół) między dwoma znacznikami epoch-ms; może być ujemne. */
export function daysBetween(from: number, to: number): number {
  return Math.floor((to - from) / DAY_MS)
}

/** Mediana listy liczb (null dla pustej). Nie mutuje wejścia. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** Normalizuje wklejony link do bezpiecznego href (dokleja https:// gdy brak schematu). */
export function listingHref(url: string | undefined): string | undefined {
  const u = url?.trim()
  if (!u) return undefined
  return /^https?:\/\//i.test(u) ? u : `https://${u}`
}

/** Okładka przedmiotu: jawne coverImageId, inaczej pierwsze zdjęcie (orig → AI). */
export function coverImageIdOf(
  product: Pick<Product, 'coverImageId' | 'photoIds' | 'generatedPhotoIds'>,
): ID | undefined {
  return product.coverImageId ?? product.photoIds[0] ?? product.generatedPhotoIds[0]
}

/** Ile dni przedmiot jest wystawiony; null jeśli nie jest 'listed' lub brak listedAt. */
export function daysListed(product: Product, now: number): number | null {
  if (product.status !== 'listed' || product.listedAt == null) return null
  return Math.max(0, daysBetween(product.listedAt, now))
}

export interface StaleListing {
  product: Product
  days: number
  /** Ile zalegających sztuk reprezentuje wiersz (sztuki jednego rozmiaru modelu to jedno ogłoszenie). */
  units: number
}

/**
 * Wystawione przedmioty starsze niż próg (włącznie), od najstarszych. Sztuki jednego
 * rozmiaru modelu zwija w jeden wiersz (najstarsza sztuka + licznik) — rozmiar jest
 * wystawiany jednym ogłoszeniem, więc 5 sztuk „M” to jedna zaległa oferta, nie pięć.
 */
export function staleListings(
  products: Product[],
  now: number,
  thresholdDays: number = STALE_LISTING_DAYS,
): StaleListing[] {
  const out: StaleListing[] = []
  const byListing = new Map<string, StaleListing>()
  for (const product of products) {
    const days = daysListed(product, now)
    if (days == null || days < thresholdDays) continue
    const key = product.designId ? `${product.designId}|${sizeKey(product)}` : undefined
    const prev = key ? byListing.get(key) : undefined
    if (prev) {
      prev.units++
      if (days > prev.days) Object.assign(prev, { product, days })
      continue
    }
    const row = { product, days, units: 1 }
    out.push(row)
    if (key) byListing.set(key, row)
  }
  return out.sort((a, b) => b.days - a.days)
}

export interface SellThrough {
  sold: number
  listed: number
  /** sprzedane / (sprzedane + wystawione); null gdy nic nie trafiło na rynek. */
  rate: number | null
}

/** Sprzedawalność wśród przedmiotów, które trafiły na rynek (wystawione + sprzedane). */
export function sellThrough(products: Product[]): SellThrough {
  let sold = 0
  let listed = 0
  for (const p of products) {
    if (p.status === 'sold') sold++
    else if (p.status === 'listed') listed++
  }
  const denom = sold + listed
  return { sold, listed, rate: denom > 0 ? sold / denom : null }
}

export interface DaysToSellStats {
  /** Mediana dni od wystawienia do sprzedaży; null gdy brak pokrycia. */
  medianDays: number | null
  /** Ile sprzedanych przedmiotów ma datę wystawienia (i da się policzyć). */
  covered: number
  /** Wszystkie sprzedane przedmioty (mianownik pokrycia). */
  totalSold: number
}

/**
 * Mediana czasu sprzedaży liczona z Product.listedAt → Product.soldAt. Pokrycie
 * jest częściowe: importowane sprzedaże nie mają productId, a przedmioty
 * sprzedane przed wdrożeniem nie mają listedAt (albo mają przybliżony z backfillu,
 * pomijany) — stąd osobne `covered`/`totalSold`.
 */
export function daysToSellStats(products: Product[]): DaysToSellStats {
  const sold = products.filter((p) => p.status === 'sold')
  const durations: number[] = []
  for (const p of sold) {
    // Daty z backfillu (listedAtApprox) to tylko ostatnia edycja — zafałszowałyby medianę.
    if (p.listedAt != null && !p.listedAtApprox && p.soldAt != null && p.soldAt >= p.listedAt) {
      durations.push(daysBetween(p.listedAt, p.soldAt))
    }
  }
  return { medianDays: median(durations), covered: durations.length, totalSold: sold.length }
}

// ── Ogłoszenia modelu (Design.listings) ─────────────────────────────────────
// Na Vinted każdy rozmiar to osobne ogłoszenie, więc ogłoszenie dotyczy rozmiaru modelu
// (`size` = sizeLabel jego sztuk). Zapisy bez `size` (sprzed rozmiarów) obejmują cały model.

/** Klucz rozmiaru sztuki — sztuki o tym samym rozmiarze dzielą ogłoszenie. */
export function sizeKey(product: Pick<Product, 'sizeLabel'>): string {
  return (product.sizeLabel ?? '').trim()
}

/** Ogłoszenia, które obejmują dany rozmiar (jego własne + te na cały model). */
export function listingsForSize(
  listings: DesignListing[] | undefined,
  size: string,
): DesignListing[] {
  return (listings ?? []).filter((l) => l.size == null || l.size === size)
}

/** Konta (bez powtórzeń), na których wisi któreś z ogłoszeń. */
function accountsOf(listings: DesignListing[]): ID[] {
  return [...new Set(listings.map((l) => l.accountId))]
}

/** Statusy sztuki, które idą za ogłoszeniami modelu. Sprzedane, zarezerwowane i
 *  zarchiwizowane zostają, jak są — to decyzje o konkretnej sztuce. */
const FOLLOWS_DESIGN_LISTINGS: ReadonlySet<Product['status']> = new Set(['draft', 'in_stock', 'listed'])

/** Najwcześniejsze ogłoszenie modelu; undefined gdy nigdzie nie jest wystawiony. */
function firstListing(listings: DesignListing[] | undefined): DesignListing | undefined {
  let first: DesignListing | undefined
  for (const l of listings ?? []) if (!first || l.since < first.since) first = l
  return first
}

/** Najwcześniejsza data wystawienia modelu; null gdy nigdzie nie jest wystawiony. */
export function earliestListing(listings: DesignListing[] | undefined): number | null {
  return firstListing(listings)?.since ?? null
}

/**
 * Ogłoszenia odczytane z samych sztuk: wystawione sztuki z kontem, per rozmiar i konto
 * najwcześniejsza data. Dla modeli sprzed `Design.listings` (i przy łączeniu wystawionych przedmiotów
 * w model) — żeby pierwsze kliknięcie nie nadpisało prawdziwych dat dzisiejszą.
 */
export function listingsFromProducts(products: Product[]): DesignListing[] {
  return mergeListings(
    [],
    products
      .filter((p) => p.status === 'listed' && p.accountId && p.listedAt != null)
      .map((p) => ({
        accountId: p.accountId!,
        since: p.listedAt!,
        size: sizeKey(p),
        // Data z backfillu zostaje przybliżona — nie może stać się „dokładną” w modelu.
        ...(p.listedAtApprox ? { approx: true } : {}),
      })),
  )
}

/** Ogłoszenia modelu: zapisane, a dla starszych modeli (bez pola) — odczytane ze sztuk. */
export function effectiveListings(
  listings: DesignListing[] | undefined,
  members: Product[],
): DesignListing[] {
  return listings ?? listingsFromProducts(members)
}

/** Łączy dwie listy ogłoszeń: per rozmiar i konto wcześniejsze (razem z flagą przybliżenia). */
export function mergeListings(a: DesignListing[], b: DesignListing[]): DesignListing[] {
  const byKey = new Map<string, DesignListing>()
  for (const l of [...a, ...b]) {
    const key = `${l.size ?? '*'}|${l.accountId}`
    const prev = byKey.get(key)
    if (!prev || l.since < prev.since) byKey.set(key, l)
  }
  return [...byKey.values()]
}

/**
 * Czy przedmiot należy do konta (filtr Magazynu, licznik wystawionych na stronie Kont). Sztuka rozmiaru
 * wystawionego na dwóch kontach nie ma własnego konta, więc liczy się ogłoszenie rozmiaru.
 */
export function isOnAccount(
  product: Product,
  accountId: ID,
  listings: DesignListing[] | undefined,
): boolean {
  if (product.accountId === accountId) return true
  return (
    !product.accountId &&
    product.status === 'listed' &&
    listingsForSize(listings, sizeKey(product)).some((l) => l.accountId === accountId)
  )
}

/**
 * Włącza ogłoszenie na koncie (z datą `since`) albo je zdejmuje, gdy już jest. Bez `size`
 * dotyczy całego modelu (wszystkich rozmiarów naraz). Z `size` — tylko tego rozmiaru;
 * ogłoszenie konta na cały model rozbija się wtedy na rozmiary (`sizes`), żeby zdjęcie
 * jednego rozmiaru zostawiło pozostałe wystawione.
 */
export function toggleListing(
  listings: DesignListing[] | undefined,
  accountId: ID,
  since: number,
  size?: string,
  sizes: string[] = [],
): DesignListing[] {
  const cur = listings ?? []
  if (size == null) {
    const rest = cur.filter((l) => l.accountId !== accountId)
    return rest.length < cur.length ? rest : [...cur, { accountId, since }]
  }
  const split = cur.flatMap((l) =>
    l.accountId === accountId && l.size == null
      ? [...new Set([...sizes, size])].map((s) => ({ ...l, size: s }))
      : [l],
  )
  const isThis = (l: DesignListing) => l.accountId === accountId && l.size === size
  return split.some(isThis) ? split.filter((l) => !isThis(l)) : [...split, { accountId, since, size }]
}

/**
 * Patch sztuki modelu po zmianie jego ogłoszeń (null = bez zmian). Wystawiony rozmiar →
 * jego niesprzedane sztuki są 'listed' od najwcześniejszego ogłoszenia (z tego liczy się
 * czas sprzedaży) i na koncie ogłoszenia, gdy jest jedno; przy dwóch konto rozstrzyga
 * sprzedaż. Rozmiar zdjęty wszędzie → jego sztuki wracają do magazynu bez konta.
 */
export function memberListingPatch(
  member: Product,
  listings: DesignListing[] | undefined,
): Partial<Product> | null {
  if (!FOLLOWS_DESIGN_LISTINGS.has(member.status)) return null
  const own = listingsForSize(listings, sizeKey(member))
  const first = firstListing(own)
  if (!first) {
    return member.status === 'listed' ? { status: 'in_stock', accountId: undefined } : null
  }
  const accounts = accountsOf(own)
  const accountId = accounts.length === 1 ? accounts[0] : undefined
  const approx = first.approx ? true : undefined
  if (
    member.status === 'listed' &&
    member.listedAt === first.since &&
    member.listedAtApprox === approx &&
    member.accountId === accountId
  )
    return null
  return { status: 'listed', listedAt: first.since, listedAtApprox: approx, accountId }
}

/** Konto podpowiadane przy sprzedaży: sztuki, a gdy go nie ma — jedynego ogłoszenia rozmiaru. */
export function suggestedSaleAccount(
  product: Product,
  listings: DesignListing[] | undefined,
): ID | undefined {
  if (product.accountId) return product.accountId
  const accounts = accountsOf(listingsForSize(listings, sizeKey(product)))
  return accounts.length === 1 ? accounts[0] : undefined
}

/**
 * Patch sprzedanej sztuki: konto ze sprzedaży zostaje na sztuce (dane per konto), a gdy
 * sztuka nie ma daty wystawienia, bierze ją z ogłoszenia jej rozmiaru na tym koncie (albo
 * najwcześniejszego) — inaczej sprzedaż z modelu nie zasiliłaby czasu sprzedaży.
 */
export function soldPatch(
  product: Product,
  soldAt: number,
  accountId: ID | undefined,
  listings: DesignListing[] | undefined,
): Partial<Product> {
  const patch: Partial<Product> = { status: 'sold', soldAt }
  if (accountId) patch.accountId = accountId
  // Sztuka modelu ma datę najwcześniejszego ogłoszenia; sprzedaż na innym koncie liczy się
  // od ogłoszenia na tym koncie. Własnej (innej) daty sztuki nie ruszamy.
  const own = listingsForSize(listings, sizeKey(product))
  const first = firstListing(own)
  if (product.listedAt == null || product.listedAt === first?.since) {
    const source = own.find((l) => l.accountId === accountId) ?? first
    if (source && source.since <= soldAt && source.since !== product.listedAt) {
      patch.listedAt = source.since
      patch.listedAtApprox = source.approx ? true : undefined
    }
  }
  return patch
}
