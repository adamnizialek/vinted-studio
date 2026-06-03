/** Generator identyfikatorow — uzywa crypto.randomUUID gdy dostepne. */
export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  // Fallback (starsze przegladarki / brak secure context).
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}
