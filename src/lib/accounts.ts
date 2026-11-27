// Konta sprzedażowe: zablokowane przez Vinted zostają w bazie (sprzedaże i statystyki są
// prawdziwe), ale nie są już proponowane do wystawiania ani do nowych wpisów. Konta jednej
// osoby (Account.owner) dzielą limit i ewidencję sprzedaży.
import type { Account, ID } from '@/db/types'

/** Czy Vinted zablokował konto (patrz Account.bannedAt). */
export function isBanned(account: Pick<Account, 'bannedAt'> | undefined): boolean {
  return account?.bannedAt != null
}

/**
 * Konta do wyboru przy wystawianiu i nowych wpisach: bez zbanowanych. Konto już wybrane
 * (`keep`) zostaje na liście, żeby formularz nie zgubił ani nie podmienił zapisanej wartości.
 */
export function selectableAccounts<A extends Pick<Account, 'id' | 'bannedAt'>>(
  accounts: A[],
  keep: ID | ID[] | undefined = [],
): A[] {
  const kept = new Set(Array.isArray(keep) ? keep : [keep])
  return accounts.filter((a) => !isBanned(a) || kept.has(a.id))
}

/** Nazwa konta w listach wyboru i filtrach; zbanowane dostaje dopisek. */
export function accountLabel(account: Pick<Account, 'name' | 'bannedAt'>): string {
  return isBanned(account) ? `${account.name} (zbanowane)` : account.name
}

/**
 * Osoba = właściciel kont. Limit działalności nierejestrowanej i ewidencja sprzedaży są
 * na osobę, nie na konto, więc liczy się je ze wszystkich jej kont — także zbanowanych
 * (to, co na nich sprzedała, nadal jest jej przychodem). Konto bez właściciela jest
 * osobą samo dla siebie, jak dotąd.
 */
export interface Person<A> {
  /** `owner:<nazwa małymi literami>` albo `account:<id>` dla konta bez właściciela. */
  key: string
  /** Nazwa osoby (pisownia z pierwszego konta) albo nazwa konta bez właściciela. */
  name: string
  /** Czy to osoba wpisana w kontach (a nie pojedyncze konto bez właściciela). */
  named: boolean
  accounts: A[]
}

type PersonAccount = Pick<Account, 'id' | 'name' | 'owner'>

const ownerOf = (a: Pick<Account, 'owner'>) => a.owner?.trim() || undefined

/** Klucz osoby konta: ta sama nazwa właściciela (bez wielkości liter) = ta sama osoba. */
export function personKey(a: Pick<Account, 'id' | 'owner'>): string {
  const owner = ownerOf(a)
  return owner ? `owner:${owner.toLocaleLowerCase('pl-PL')}` : `account:${a.id}`
}

/** Osoby w kolejności pierwszego konta. */
export function people<A extends PersonAccount>(accounts: A[]): Person<A>[] {
  const byKey = new Map<string, Person<A>>()
  for (const a of accounts) {
    const key = personKey(a)
    const cur = byKey.get(key)
    if (cur) cur.accounts.push(a)
    else byKey.set(key, { key, name: ownerOf(a) ?? a.name, named: !!ownerOf(a), accounts: [a] })
  }
  return [...byKey.values()]
}

/** Osoba, do której należy konto. */
export function personOf<A extends PersonAccount>(accounts: A[], id: ID): Person<A> | undefined {
  const a = accounts.find((x) => x.id === id)
  return a && people(accounts).find((p) => p.key === personKey(a))
}

/** Wpisane już nazwy właścicieli — podpowiedzi w formularzu konta. */
export function ownerNames(accounts: PersonAccount[]): string[] {
  return people(accounts)
    .filter((p) => p.named)
    .map((p) => p.name)
}

/**
 * Właściciel do zapisu: przycięty, a gdy ta osoba jest już wpisana przy innym koncie
 * (inna wielkość liter) — w jej dotychczasowej pisowni, żeby nazwa osoby była wszędzie ta sama.
 */
export function ownerToSave(accounts: PersonAccount[], id: ID, owner: string | undefined): string | undefined {
  const trimmed = owner?.trim()
  if (!trimmed) return undefined
  const key = trimmed.toLocaleLowerCase('pl-PL')
  const others = accounts.filter((a) => a.id !== id)
  return ownerNames(others).find((n) => n.toLocaleLowerCase('pl-PL') === key) ?? trimmed
}

/** Domyślne konto z ustawień — o ile nie jest zbanowane. */
export function usableDefaultAccount(
  accounts: Pick<Account, 'id' | 'bannedAt'>[] | undefined,
  id: ID | undefined,
): ID | undefined {
  if (!id) return undefined
  return isBanned(accounts?.find((a) => a.id === id)) ? undefined : id
}
