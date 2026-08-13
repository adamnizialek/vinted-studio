/**
 * Separatory, których szukamy w pliku. Kolejność = preferencja przy remisie:
 * przecinek jest kanonicznym CSV, ale Excel w polskim locale zapisuje ŚREDNIKI
 * (bo przecinek jest znakiem dziesiętnym), a „Tekst Unicode" daje TABULATORY.
 */
export const CSV_DELIMITERS = [',', ';', '\t', '|'] as const
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number]

/** Dyrektywa `sep=;` w pierwszej linii — Excel ją zapisuje i sam honoruje. */
const SEP_DIRECTIVE_RE = /^sep=(.)\r?\n/i

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Zdejmuje `sep=X` z początku pliku. Zwraca resztę tekstu i zadeklarowany separator
 * (o ile jest jednym z obsługiwanych) — inaczej `undefined`.
 */
function readSepDirective(text: string): { rest: string; delimiter?: CsvDelimiter } {
  const m = text.match(SEP_DIRECTIVE_RE)
  if (!m) return { rest: text }
  const declared = m[1] === 't' ? '\t' : m[1]
  const delimiter = (CSV_DELIMITERS as readonly string[]).includes(declared)
    ? (declared as CsvDelimiter)
    : undefined
  return { rest: text.slice(m[0].length), delimiter }
}

/**
 * Wykrywa separator: tokenizuje kilka pierwszych wierszy KAŻDYM kandydatem i wybiera
 * ten, który daje najbardziej SPÓJNĄ liczbę kolumn (>1). Spójność jest kluczowa —
 * w polskim pliku ze średnikami przecinki dziesiętne też występują, ale tną wiersze
 * na nierówne kawałki („35,00" → 2 pola, „350,56" → 2, ale nagłówek → 1), więc
 * przegrywają z równym podziałem na średnikach. Cudzysłowy są respektowane, bo
 * liczymy prawdziwym tokenizerem, a nie zliczaniem znaków.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const { rest, delimiter } = readSepDirective(stripBom(text))
  if (delimiter) return delimiter

  let best: { d: CsvDelimiter; cols: number; score: number } | null = null
  for (const d of CSV_DELIMITERS) {
    const rows = tokenize(rest, d, 20)
    if (!rows.length) continue
    const counts = rows.map((r) => r.length)
    const cols = counts[0]
    if (cols < 2) continue // jedna kolumna = ten znak nie jest separatorem tego pliku
    // Udział wierszy o TAKIEJ SAMEJ szerokości co nagłówek.
    const consistent = counts.filter((n) => n === cols).length / counts.length
    // Spójność decyduje; liczba kolumn tylko rozstrzyga remisy (lekka waga).
    const score = consistent * 100 + Math.min(cols, 50) / 100
    if (!best || score > best.score) best = { d, cols, score }
  }
  return best?.d ?? ','
}

/**
 * Tokenizuje CSV danym separatorem. Obsługuje pola w cudzysłowach (polskie liczby
 * „22,4"), zdublowane cudzysłowy "", CRLF i BOM. `maxRows` ogranicza pracę przy
 * samym wykrywaniu separatora. Pusty końcowy wiersz (po końcowym \n) jest pomijany.
 */
function tokenize(text: string, delimiter: string, maxRows = Infinity): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    rows.push(row)
    row = []
  }

  for (let i = 0; i < text.length; i++) {
    if (rows.length >= maxRows) break
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === delimiter) {
      pushField()
    } else if (c === '\n') {
      pushField()
      pushRow()
    } else if (c === '\r') {
      // pomijamy — koniec wiersza obsługuje \n
    } else {
      field += c
    }
  }
  // Domknij ostatni wiersz, o ile coś w nim jest.
  if (rows.length < maxRows && (field !== '' || row.length > 0)) {
    pushField()
    pushRow()
  }
  return rows
}

/**
 * Tokenizuje CSV do tablicy wierszy (string[][]). Separator jest WYKRYWANY
 * (przecinek / średnik / tabulator / pionowa kreska), o ile nie podano go wprost —
 * bez tego eksport z Excela w polskim locale (średniki) rozpadał się na śmieci,
 * a aplikacja nie umiała wczytać własnego eksportu z `toCsv`.
 */
export function parseCsv(text: string, delimiter?: CsvDelimiter): string[][] {
  const d = delimiter ?? detectDelimiter(text)
  // `sep=` to dyrektywa dla Excela, nie wiersz danych — nie może trafić do tabeli.
  const { rest } = readSepDirective(stripBom(text))
  return tokenize(rest, d)
}

/** Eksport tablicy obiektow do CSV (separator ; — przyjazny dla Excela PL). */
export function toCsv(rows: Record<string, unknown>[], headers?: string[]): string {
  if (rows.length === 0) return ''
  const cols = headers ?? Object.keys(rows[0])
  const escape = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v)
    if (/[";\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
    return s
  }
  const head = cols.join(';')
  const body = rows.map((r) => cols.map((c) => escape(r[c])).join(';')).join('\n')
  // BOM, by Excel poprawnie odczytal polskie znaki.
  return '﻿' + head + '\n' + body
}

export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([text], { type: mime })
  downloadBlob(filename, blob)
}

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
