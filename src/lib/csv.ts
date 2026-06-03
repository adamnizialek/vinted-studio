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
