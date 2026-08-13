// Rozpoznawanie ZNACZENIA kolumn w zaimportowanym arkuszu — niezależnie od ich KOLEJNOŚCI
// i od tego, czy nagłówki są po polsku, czy po angielsku.
//
// Dlaczego to istnieje: pierwotny import zakładał jeden konkretny arkusz („finessin"):
// szukał polskich podciągów i po cichu spadał do sztywnych pozycji A–E. Cudzy plik z inną
// kolejnością kolumn albo z angielskimi nagłówkami dawał albo śmieci, albo „nie znaleziono
// przedmiotów". Dodatkowo stary detektor mógł przypisać TĘ SAMĄ kolumnę wszystkim polom
// (nagłówek „Data;Nazwa;Cena zakupu;Cena sprzedaży" wczytany bez separatora to jedna komórka,
// która zawiera wszystkie cztery słowa kluczowe) i twierdzić, że rozpoznał nagłówki.
//
// Zasady: (1) punktujemy każdą parę (pole, kolumna), (2) przypisujemy zachłannie od
// najlepszego dopasowania, (3) każda kolumna i każde pole trafia do wyniku CO NAJWYŻEJ RAZ.

/** Pola, które import potrafi wypełnić z arkusza. */
export type ImportField = 'date' | 'name' | 'purchase' | 'sale'

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  date: 'Data',
  name: 'Nazwa przedmiotu',
  purchase: 'Cena zakupu',
  sale: 'Cena sprzedaży',
}

/** Wynik rozpoznania: pole → indeks kolumny. Brak klucza = nie rozpoznano / brak w pliku. */
export type ColumnMap = Partial<Record<ImportField, number>>

/**
 * Sprowadza nagłówek do porównywalnej postaci: małe litery, bez polskich znaków
 * diakrytycznych, bez interpunkcji, ze zwiniętymi spacjami. Dzięki temu „Cena Sprzedaży",
 * „cena sprzedazy" i „CENA_SPRZEDAŻY" to ten sam tekst.
 */
export function normalizeHeader(h: string): string {
  return h
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // znaki diakrytyczne
    .replace(/ł/gi, 'l') // ł nie rozkłada się przez NFD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Wzorzec rozpoznający pole + jego waga (1 = pewniak, 0.5 = słaba poszlaka). */
interface Pattern {
  re: RegExp
  weight: number
}

const PATTERNS: Record<ImportField, Pattern[]> = {
  date: [
    { re: /^(data|date|dzien|day)$/, weight: 1 },
    { re: /\b(data|date)\b/, weight: 0.8 },
    { re: /\b(dzien|day|kiedy)\b/, weight: 0.6 },
  ],
  name: [
    { re: /^(nazwa|name|przedmiot|produkt|product|item|tytul|title)$/, weight: 1 },
    { re: /\b(nazwa|name|przedmiot|produkt|product|item|towar|tytul|title|model)\b/, weight: 0.8 },
    { re: /\b(opis|description)\b/, weight: 0.5 },
  ],
  purchase: [
    { re: /\b(cena|koszt|price|cost)\b.*\b(zakup\w*|zaukup\w*|kupna|purchase|buy)\b/, weight: 1 },
    { re: /\b(zakup\w*|zaukup\w*|kupno|kupna|purchase|buy|bought)\b/, weight: 0.85 },
    { re: /\b(koszt\w*|cost|wydatek)\b/, weight: 0.7 },
  ],
  sale: [
    { re: /\b(cena|kwota|price|amount)\b.*\b(sprzeda\w*|sale|sold|sell)\b/, weight: 1 },
    { re: /\b(sprzeda\w*|sold|sale|sell|selling)\b/, weight: 0.85 },
    { re: /\b(przychod|revenue|utarg)\b/, weight: 0.6 },
    { re: /^(cena|kwota|price|amount)$/, weight: 0.55 },
  ],
}

/** Słowa daty — „Data sprzedaży" to KOLUMNA DATY, nie kolumna ceny. */
const DATE_WORD_RE = /\b(data|date)\b/
/** Słowa ceny — ich obecność znosi karę za słowo daty („Cena sprzedaży" mimo „sprzedaży"). */
const PRICE_WORD_RE = /\b(cena|kwota|koszt|price|cost|amount|zl|pln|eur)\b/

/** Punktuje dopasowanie pojedynczego nagłówka do pojedynczego pola (0 = brak). */
export function scoreHeader(header: string, field: ImportField): number {
  const h = normalizeHeader(header)
  if (!h) return 0
  let best = 0
  for (const p of PATTERNS[field]) if (p.re.test(h)) best = Math.max(best, p.weight)
  if (!best) return 0
  // „Data sprzedaży" pasuje słabo do `sale` — bez słowa ceny to jednak data.
  if (field !== 'date' && DATE_WORD_RE.test(h) && !PRICE_WORD_RE.test(h)) best -= 0.5
  return Math.max(0, best)
}

/** Minimalny wynik, przy którym ufamy automatowi. Niżej → prosimy użytkownika o wskazanie. */
const MIN_SCORE = 0.4

/**
 * Przypisuje kolumny do pól zachłannie: najlepsze pary najpierw, każda kolumna i każde
 * pole użyte co najwyżej raz. Pola bez dopasowania po prostu nie trafiają do wyniku.
 */
export function detectColumnMap(header: string[], fields: readonly ImportField[]): ColumnMap {
  const pairs: { field: ImportField; index: number; score: number }[] = []
  for (const field of fields) {
    for (let i = 0; i < header.length; i++) {
      const score = scoreHeader(header[i] ?? '', field)
      if (score >= MIN_SCORE) pairs.push({ field, index: i, score })
    }
  }
  // Stabilna kolejność: wynik malejąco, potem kolumna rosnąco (powtarzalne przy remisie).
  pairs.sort((a, b) => b.score - a.score || a.index - b.index)

  const map: ColumnMap = {}
  const usedColumns = new Set<number>()
  for (const p of pairs) {
    if (map[p.field] !== undefined || usedColumns.has(p.index)) continue
    map[p.field] = p.index
    usedColumns.add(p.index)
  }
  return map
}

/**
 * Czy wiersz wygląda na NAGŁÓWEK, a nie na dane. Arkusze bywają bez nagłówka — wtedy
 * pierwszy wiersz to już przedmiot i zjedzenie go CICHO gubi sprzedaż/przedmiot, czego
 * użytkownik nie zauważy. Odwrotna pomyłka (nagłówek wzięty za dane) kończy się widocznym
 * wierszem „do sprawdzenia", więc w razie wątpliwości wolimy nie odrzucać wiersza.
 *
 * Nagłówek = co najmniej dwie niepuste komórki, ani jednej z samą liczbą lub datą
 * (te występują wyłącznie w danych) i przynajmniej jedna zawiera literę.
 */
export function looksLikeHeaderRow(row: string[]): boolean {
  const cells = row.map((c) => (c ?? '').trim()).filter(Boolean)
  if (cells.length < 2) return false
  const numeric = /^-?[\d\s]+([.,]\d+)?\s*(zl|pln|eur|%)?$/i
  const dateish = /^\d{1,4}[.\-/]\d{1,2}[.\-/]\d{1,4}$/
  if (cells.some((c) => numeric.test(c) || dateish.test(c))) return false
  return cells.some((c) => /[a-ząćęłńóśźż]/i.test(c))
}

/**
 * Łączy automat z ręcznym nadpisaniem użytkownika. `override` wygrywa zawsze;
 * wartość `-1` oznacza świadome „ta kolumna nie występuje w moim pliku".
 */
export function applyOverride(detected: ColumnMap, override?: ColumnMap): ColumnMap {
  if (!override) return detected
  const out: ColumnMap = { ...detected }
  for (const [field, index] of Object.entries(override) as [ImportField, number][]) {
    if (index == null || index < 0) delete out[field]
    else out[field] = index
  }
  return out
}

/** Czy przypisanie zawiera wszystkie pola, bez których import nie ma sensu. */
export function hasRequired(map: ColumnMap, required: readonly ImportField[]): boolean {
  return required.every((f) => map[f] !== undefined)
}

export interface ResolvedColumns {
  columns: ColumnMap
  /** Czy komplet wymaganych pól wyszedł z ROZPOZNANYCH nagłówków (a nie z domysłu). */
  headerDetected: boolean
}

/**
 * Pełna polityka ustalania kolumn — jedno miejsce dla obu importów:
 *  1. rozpoznaj po nagłówkach,
 *  2. gdy brakuje pola wymaganego, dołóż plan pozycyjny (zgodność z arkuszem `finessin`),
 *     ale zgłoś `headerDetected:false`, żeby UI pokazało to do zatwierdzenia zamiast
 *     po cichu zaimportować śmieci,
 *  3. na wierzchu ręczne wskazanie użytkownika, które wygrywa zawsze.
 */
export function resolveColumns(
  header: string[],
  fields: readonly ImportField[],
  required: readonly ImportField[],
  positional: ColumnMap,
  override?: ColumnMap,
): ResolvedColumns {
  const detected = detectColumnMap(header, fields)
  const headerDetected = hasRequired(detected, required)
  const base = headerDetected ? detected : { ...positional, ...detected }
  return { columns: applyOverride(base, override), headerDetected }
}
