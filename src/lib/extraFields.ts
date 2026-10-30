// Podsumowania pól schowanych w zwijanej sekcji „Więcej szczegółów”.
// Formularze pokazują na wierzchu tylko to, czego właściciel faktycznie używa
// (rozmiar, ceny, konto); reszta jest zwinięta. Żeby nic nie było ukryte po
// cichu, nagłówek sekcji wypisuje pola, które mają już wartość — np. kolor
// wpisany przez import ze zrzutu ekranu.

import type { Product, Sale } from '@/db/types'
import { money } from './format'

const text = (v?: string) => v?.trim() || undefined

/** Wypełnione „dodatkowe” pola produktu, w kolejności z formularza. */
export function productExtras(p: Product): string[] {
  const out: string[] = []
  const add = (label: string, v?: string) => {
    if (v) out.push(`${label}: ${v}`)
  }
  add('Kolor', text(p.color))
  add('Marka', text(p.brand))
  add('Kategoria', text(p.category))
  add('Materiał', text(p.material))
  if (p.tags.length) add('Tagi', p.tags.join(', '))
  if (text(p.notes)) out.push('Notatki')
  const m = p.measurements
  if (m && Object.values(m).some((v) => v != null && v !== '')) out.push('Wymiary')
  if (p.quantity !== 1) add('Ilość', String(p.quantity))
  if (p.currency !== 'PLN') add('Waluta', p.currency)
  if (p.retailPrice) add('Cena detaliczna', money(p.retailPrice, p.currency))
  return out
}

/** Wypełnione „dodatkowe” pola wpisu sprzedaży. */
export function saleExtras(s: Sale): string[] {
  const out: string[] = []
  const add = (label: string, v?: string) => {
    if (v) out.push(`${label}: ${v}`)
  }
  add('Marka', text(s.brand))
  if (s.quantity !== 1) add('Ilość', String(s.quantity))
  if (s.shippingCost) add('Wysyłka', money(s.shippingCost, s.currency))
  if (s.platformFee) add('Prowizja', money(s.platformFee, s.currency))
  if (s.otherCosts) add('Inne', money(s.otherCosts, s.currency))
  add('Kupujący', text(s.buyer))
  if (text(s.notes)) out.push('Notatki')
  return out
}
