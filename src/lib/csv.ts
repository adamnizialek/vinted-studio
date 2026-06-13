/**
 * Tokenizuje CSV do tablicy wierszy (string[][]). Obsługuje pola w cudzysłowach
 * z przecinkami (polskie liczby "22,4"), zdublowane cudzysłowy "", CRLF i BOM.
 * Pusty końcowy wiersz (po końcowym \n) jest pomijany.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0 // pomiń BOM

  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    rows.push(row)
    row = []
  }

  for (; i < text.length; i++) {
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
    } else if (c === ',') {
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
  if (field !== '' || row.length > 0) {
    pushField()
    pushRow()
  }
  return rows
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
