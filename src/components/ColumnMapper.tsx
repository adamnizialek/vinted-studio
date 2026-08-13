// Ręczne wskazanie, która kolumna arkusza znaczy co. Automat po nagłówkach radzi sobie
// z polskimi i angielskimi nazwami w dowolnej kolejności, ale cudzy plik może mieć nagłówki
// zupełnie własne (albo nie mieć ich wcale) — wtedy zamiast po cichu zaimportować śmieci
// pokazujemy to okienko z podglądem pierwszych wierszy i pozwalamy poprawić przypisanie.

import { useMemo } from 'react'
import { AlertTriangle, Columns3 } from 'lucide-react'
import clsx from 'clsx'
import { IMPORT_FIELD_LABELS, type ColumnMap, type ImportField } from '@/lib/columnMap'
import { Field, Select } from '@/components/ui'

/** Etykieta kolumny jak w arkuszu: 0 → „A", 25 → „Z", 26 → „AA". */
export function columnLetter(index: number): string {
  let out = ''
  let n = index
  while (n >= 0) {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  }
  return out
}

/** „C — Nazwa przedmiotu" (albo samo „C", gdy nagłówek jest pusty). */
function columnOptionLabel(header: string[], index: number): string {
  const name = (header[index] ?? '').trim()
  return name ? `${columnLetter(index)} — ${name}` : columnLetter(index)
}

export function ColumnMapper({
  header,
  sampleRows,
  fields,
  value,
  onChange,
  headerDetected,
  requiredFields = [],
}: {
  /** Pierwszy wiersz arkusza (nagłówki). */
  header: string[]
  /** Kilka pierwszych wierszy DANYCH — do podglądu. */
  sampleRows: string[][]
  /** Pola, które ten import potrafi wykorzystać. */
  fields: readonly ImportField[]
  /** Aktualne przypisanie (pole → indeks kolumny). */
  value: ColumnMap
  onChange: (next: ColumnMap) => void
  /** Czy nagłówki udało się rozpoznać automatycznie. */
  headerDetected: boolean
  /** Pola, bez których import nie ma sensu — brak podświetlamy na czerwono. */
  requiredFields?: readonly ImportField[]
}) {
  // Szerokość tabeli bierzemy z najszerszego wiersza — arkusze bywają „poszarpane".
  const width = useMemo(
    () => Math.max(header.length, ...sampleRows.map((r) => r.length), 0),
    [header, sampleRows],
  )
  const columns = useMemo(() => Array.from({ length: width }, (_, i) => i), [width])

  // Kolumna → pole (odwrotność mapy) — do podświetlenia nagłówków w podglądzie.
  const fieldOfColumn = useMemo(() => {
    const m = new Map<number, ImportField>()
    for (const f of fields) {
      const i = value[f]
      if (i !== undefined && i >= 0) m.set(i, f)
    }
    return m
  }, [fields, value])

  const missing = requiredFields.filter((f) => value[f] === undefined)

  const setField = (field: ImportField, raw: string) => {
    const index = Number(raw)
    // -1 = „nie ma tego w moim pliku". Ta sama kolumna nie może opisywać dwóch pól,
    // więc przypisanie jej do nowego pola zwalnia poprzednie.
    const next: ColumnMap = { ...value }
    if (index < 0) delete next[field]
    else {
      for (const f of fields) if (f !== field && next[f] === index) delete next[f]
      next[field] = index
    }
    onChange(next)
  }

  return (
    <div className="space-y-3 rounded-xl border border-ink-100 p-4 dark:border-ink-800">
      <div className="flex items-center gap-2 text-sm font-semibold text-ink-800">
        <Columns3 size={16} className="text-brand-500" />
        Które kolumny to co?
      </div>

      {!headerDetected && (
        <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          Nie rozpoznaliśmy nagłówków w tym pliku — poniżej jest tylko zgadywanka. Sprawdź w
          podglądzie, czy kolumny się zgadzają, i popraw je w razie potrzeby.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {fields.map((f) => {
          const isMissing = missing.includes(f)
          return (
            <Field key={f} label={IMPORT_FIELD_LABELS[f]}>
              <Select
                value={String(value[f] ?? -1)}
                onChange={(e) => setField(f, e.target.value)}
                aria-label={`Kolumna dla: ${IMPORT_FIELD_LABELS[f]}`}
                className={clsx(isMissing && 'ring-1 ring-rose-400')}
              >
                <option value="-1">
                  {requiredFields.includes(f) ? '— wybierz kolumnę —' : '— brak w pliku —'}
                </option>
                {columns.map((i) => (
                  <option key={i} value={i}>
                    {columnOptionLabel(header, i)}
                  </option>
                ))}
              </Select>
            </Field>
          )
        })}
      </div>

      {missing.length > 0 && (
        <p className="text-xs font-medium text-rose-600 dark:text-rose-400">
          Wskaż kolumnę: {missing.map((f) => IMPORT_FIELD_LABELS[f]).join(', ')}.
        </p>
      )}

      {sampleRows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-ink-400">
                {columns.map((i) => {
                  const f = fieldOfColumn.get(i)
                  return (
                    <th
                      key={i}
                      scope="col"
                      className={clsx(
                        'whitespace-nowrap px-2 py-1 font-medium',
                        f && 'rounded-t bg-brand-50 text-brand-700 dark:bg-brand-950/50 dark:text-brand-300',
                      )}
                    >
                      {f ? IMPORT_FIELD_LABELS[f] : columnLetter(i)}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody className="text-ink-600">
              {sampleRows.map((row, r) => (
                <tr key={r} className="border-t border-ink-50 dark:border-ink-800">
                  {columns.map((i) => (
                    <td
                      key={i}
                      className={clsx(
                        'max-w-[12rem] truncate px-2 py-1',
                        fieldOfColumn.has(i) && 'bg-brand-50/50 text-ink-800 dark:bg-brand-950/30',
                      )}
                    >
                      {row[i] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
