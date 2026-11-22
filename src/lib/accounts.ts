// Konta sprzedażowe: zablokowane przez Vinted zostają w bazie (sprzedaże i statystyki są
// prawdziwe), ale nie są już proponowane do wystawiania ani do nowych wpisów.
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

/** Domyślne konto z ustawień — o ile nie jest zbanowane. */
export function usableDefaultAccount(
  accounts: Pick<Account, 'id' | 'bannedAt'>[] | undefined,
  id: ID | undefined,
): ID | undefined {
  if (!id) return undefined
  return isBanned(accounts?.find((a) => a.id === id)) ? undefined : id
}
