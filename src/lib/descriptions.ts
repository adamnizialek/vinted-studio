// Czyste funkcje na liscie propozycji opisow — bez Dexie/React, w pelni testowalne.
import type { DescriptionCandidate } from '@/db/types'

/** Dodaje propozycje lub podmienia istniejaca dla tego samego stylu (w miejscu). */
export function upsertCandidate(
  list: DescriptionCandidate[],
  c: DescriptionCandidate,
): DescriptionCandidate[] {
  const i = list.findIndex((x) => x.styleId === c.styleId)
  if (i === -1) return [...list, c]
  const next = list.slice()
  next[i] = c
  return next
}

/** Usuwa propozycje danego stylu (no-op, gdy nie ma takiej). */
export function removeCandidate(
  list: DescriptionCandidate[],
  styleId: string,
): DescriptionCandidate[] {
  return list.filter((c) => c.styleId !== styleId)
}
