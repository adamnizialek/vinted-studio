import type { Condition } from '@/db/types'

// Heurystyka wyceny: przedzial % ceny detalicznej w zaleznosci od stanu.
// To KONWENCJA rynkowa (nie zweryfikowany algorytm Vinted) — patrz README.
const CONDITION_PCT: Record<Condition, [number, number]> = {
  nowy_z_metka: [0.85, 0.95],
  nowy_bez_metki: [0.75, 0.9],
  bardzo_dobry: [0.7, 0.85],
  dobry: [0.6, 0.7],
  zadowalajacy: [0.4, 0.55],
}

export interface PriceSuggestion {
  low: number
  high: number
  target: number // srodek przedzialu (cel)
  anchor: number // cena wystawienia z marginesem na negocjacje (target x1.12)
  floor: number // minimalna akceptowalna oferta (target x0.9)
}

/** Sugeruje przedzial cenowy + cene "kotwiczaca" i prog odrzucenia ofert. */
export function suggestPrice(
  retail: number,
  condition: Condition,
): PriceSuggestion | null {
  if (!retail || retail <= 0) return null
  const [lo, hi] = CONDITION_PCT[condition]
  const low = roundNice(retail * lo)
  const high = roundNice(retail * hi)
  const target = roundNice((low + high) / 2)
  const anchor = roundNice(target * 1.12)
  const floor = roundNice(target * 0.9)
  return { low, high, target, anchor, floor }
}

function roundNice(n: number): number {
  if (n >= 100) return Math.round(n / 5) * 5
  if (n >= 20) return Math.round(n)
  return Math.round(n)
}
