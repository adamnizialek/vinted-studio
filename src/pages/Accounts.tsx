import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Ban, Pencil, Plus, RotateCcw, Trash2, Users } from 'lucide-react'
import clsx from 'clsx'
import { db, deleteEntity, putEntity } from '@/db/db'
import type { Account } from '@/db/types'
import { uid } from '@/lib/id'
import { ACCOUNT_COLORS } from '@/lib/constants'
import { aggregateProfit, money, pluralPl } from '@/lib/format'
import { banPlan, isOnAccount } from '@/lib/listing'
import { isBanned, ownerNames, ownerToSave, personOf } from '@/lib/accounts'
import { banAccount, unbanAccount } from '@/lib/productActions'
import { toast } from '@/state/toast'
import { Button, EmptyState, Field, Modal, SectionTitle, TextArea, TextInput } from '@/components/ui'

export function Accounts() {
  const accounts = useLiveQuery(() => db.accounts.orderBy('createdAt').toArray(), [])
  const sales = useLiveQuery(() => db.sales.toArray(), [])
  const products = useLiveQuery(() => db.products.toArray(), [])
  const designs = useLiveQuery(() => db.designs.toArray(), [])
  const listingsByDesign = new Map((designs ?? []).map((d) => [d.id, d.listings]))
  const [editing, setEditing] = useState<Account | null>(null)
  const [open, setOpen] = useState(false)

  const startNew = () => {
    setEditing({
      id: uid(),
      name: '',
      vintedUsername: '',
      color: ACCOUNT_COLORS[(accounts?.length ?? 0) % ACCOUNT_COLORS.length],
      notes: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    setOpen(true)
  }

  const save = async () => {
    if (!editing) return
    if (!editing.name.trim()) return toast.error('Podaj nazwę konta.')
    await putEntity('accounts', { ...editing, owner: ownerToSave(accounts ?? [], editing.id, editing.owner) })
    setOpen(false)
    toast.success('Zapisano konto.')
  }

  // Vinted zablokował konto: zostaje dla historii sprzedaży, a to, co było na nim
  // wystawione, wraca do magazynu (ogłoszeń na Vinted już nie ma).
  const ban = async (a: Account) => {
    // Bez wczytanych danych potwierdzenie podałoby złą liczbę przedmiotów.
    if (!products || !designs) return
    const plan = banPlan(a.id, products, designs)
    const stock = plan.toStock.length
    const elsewhere = plan.takenOff.length - stock
    const items =
      [
        stock &&
          `${stock} ${pluralPl(stock, 'przedmiot wystawiony', 'przedmioty wystawione', 'przedmiotów wystawionych')} na tym koncie wróci do magazynu (bez konta), żeby można je było wystawić gdzie indziej.`,
        elsewhere &&
          `${elsewhere} ${pluralPl(elsewhere, 'przedmiot wystawiony', 'przedmioty wystawione', 'przedmiotów wystawionych')} także na innym koncie zostaje tam wystawione.`,
      ]
        .filter(Boolean)
        .join(' ') || 'Na tym koncie nic nie jest teraz wystawione.'
    const ok = window.confirm(
      `Oznaczyć konto „${a.name}” jako zbanowane na Vinted?\n\n${items}\n\n` +
        'Sprzedaże i statystyki konta zostają. Konto nie będzie już proponowane przy wystawianiu.',
    )
    if (!ok) return
    try {
      const { toStock } = await banAccount(a.id)
      toast.success(
        toStock
          ? `Konto „${a.name}” zbanowane. ${toStock} ${pluralPl(toStock, 'przedmiot wrócił', 'przedmioty wróciły', 'przedmiotów wróciło')} do magazynu.`
          : `Konto „${a.name}” oznaczone jako zbanowane.`,
      )
    } catch {
      toast.error('Nie udało się zapisać.')
    }
  }

  const unban = async (a: Account) => {
    const ok = window.confirm(
      `Przywrócić konto „${a.name}”? Będzie znów proponowane przy wystawianiu. Zdjęte przedmioty zostają w magazynie.`,
    )
    if (!ok) return
    try {
      await unbanAccount(a.id)
      toast.success(`Przywrócono konto „${a.name}”.`)
    } catch {
      toast.error('Nie udało się zapisać.')
    }
  }

  // Zbanowane na końcu — aktywne konta są tym, czym się pracuje.
  const sorted = accounts && [...accounts].sort((x, y) => Number(isBanned(x)) - Number(isBanned(y)))

  const remove = async (id: string) => {
    // Sprzedaże usuniętego konta wypadłyby z limitu i ewidencji jego osoby — takie konto
    // zostaje w bazie (zbanowane można oznaczyć, zamiast usuwać).
    if (!sales) return
    const sold = sales.filter((s) => s.accountId === id).length
    if (sold > 0)
      return toast.error(
        `Konto ma ${sold} ${pluralPl(sold, 'sprzedaż', 'sprzedaże', 'sprzedaży')} — jego przychód liczy się do limitu i ewidencji, więc nie można go usunąć. Jeśli Vinted je zablokował, oznacz je jako zbanowane.`,
      )
    if (!window.confirm('Usunąć to konto? Produkty pozostaną, ale stracą przypisanie.'))
      return
    await deleteEntity('accounts', id)
    toast.success('Usunięto konto.')
  }

  return (
    <div>
      <SectionTitle
        title="Konta sprzedażowe"
        right={
          <Button onClick={startNew}>
            <Plus size={16} /> Dodaj konto
          </Button>
        }
      />

      {accounts && accounts.length === 0 && (
        <EmptyState
          icon={<Users size={40} />}
          title="Brak kont"
          description="Dodaj swoje konta Vinted. Konta tej samej osoby połącz polem „Osoba” — mają wspólny limit i jedną ewidencję sprzedaży."
          action={
            <Button onClick={startNew}>
              <Plus size={16} /> Dodaj pierwsze konto
            </Button>
          }
        />
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sorted?.map((a) => {
          const banned = isBanned(a)
          const person = personOf(accounts ?? [], a.id)
          const accSales = (sales ?? []).filter((s) => s.accountId === a.id)
          // Spójnie z Pulpitem i Ewidencją — jedna reguła przychodu (aggregateProfit).
          const revenue = aggregateProfit(accSales).revenue
          // Magazyn nie należy do konta — konto ma tylko to, co na nim wystawione. Sztuka
          // modelu wystawionego na dwóch kontach liczy się na każdym z nich.
          const listed = (products ?? []).filter(
            (p) =>
              p.status === 'listed' &&
              isOnAccount(p, a.id, p.designId ? listingsByDesign.get(p.designId) : undefined),
          ).length
          return (
            <div key={a.id} className={clsx('card p-4', banned && 'opacity-75')}>
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <span
                    className={clsx('h-9 w-9 rounded-xl', banned && 'grayscale')}
                    style={{ background: a.color }}
                  />
                  <div>
                    <p className="flex items-center gap-2 font-bold text-ink-900">
                      {a.name}
                      {banned && (
                        <span className="badge bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300">
                          <Ban size={11} /> Zbanowane
                        </span>
                      )}
                    </p>
                    {a.vintedUsername && <p className="text-xs text-ink-400">@{a.vintedUsername}</p>}
                    {person?.named && (
                      <p
                        className="flex items-center gap-1 text-xs text-ink-500"
                        title={
                          person.accounts.length > 1
                            ? `Wspólny limit i ewidencja: ${person.accounts.map((x) => x.name).join(', ')}`
                            : undefined
                        }
                      >
                        <Users size={11} /> {person.name}
                        {person.accounts.length > 1 &&
                          ` · ${person.accounts.length} ${pluralPl(person.accounts.length, 'konto', 'konta', 'kont')}`}
                      </p>
                    )}
                    {banned && (
                      <p className="text-xs text-ink-400">
                        od {new Date(a.bannedAt!).toLocaleDateString('pl-PL')}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => void (banned ? unban(a) : ban(a))}
                    title={banned ? 'Przywróć konto' : 'Oznacz jako zbanowane na Vinted'}
                    aria-label={banned ? 'Przywróć konto' : 'Oznacz jako zbanowane na Vinted'}
                    className="rounded-lg p-1.5 text-ink-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                  >
                    {banned ? <RotateCcw size={15} /> : <Ban size={15} />}
                  </button>
                  <button
                    onClick={() => {
                      setEditing(a)
                      setOpen(true)
                    }}
                    className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    onClick={() => remove(a.id)}
                    className="rounded-lg p-1.5 text-ink-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
              <div className="mt-4 flex justify-between border-t border-ink-100 pt-3 text-sm">
                <div>
                  <p className="text-xs text-ink-400">Sprzedaż</p>
                  <p className="font-bold text-emerald-600">{money(revenue)}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-ink-400">Wystawione</p>
                  <p className="font-bold text-ink-900">{listed}</p>
                </div>
              </div>
              {a.notes && <p className="mt-3 text-xs text-ink-500">{a.notes}</p>}
            </div>
          )
        })}
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing && accounts?.some((a) => a.id === editing.id) ? 'Edytuj konto' : 'Nowe konto'}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Anuluj
            </Button>
            <Button onClick={save}>Zapisz</Button>
          </div>
        }
      >
        {editing && (
          <div className="space-y-4">
            <Field label="Nazwa konta">
              <TextInput
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="np. Konto Ani"
                autoFocus
              />
            </Field>
            <Field label="Nazwa użytkownika Vinted (opcjonalnie)">
              <TextInput
                value={editing.vintedUsername ?? ''}
                onChange={(e) => setEditing({ ...editing, vintedUsername: e.target.value })}
                placeholder="np. ania_vinted"
              />
            </Field>
            <Field
              label="Osoba (opcjonalnie)"
              hint="Konta tej samej osoby mają wspólny limit działalności nierejestrowanej i jedną ewidencję sprzedaży."
            >
              <TextInput
                list="owner-list"
                value={editing.owner ?? ''}
                onChange={(e) => setEditing({ ...editing, owner: e.target.value })}
                placeholder="np. Adam"
              />
              <datalist id="owner-list">
                {ownerNames(accounts ?? []).map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </Field>
            <Field label="Kolor">
              <div className="flex flex-wrap gap-2">
                {ACCOUNT_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setEditing({ ...editing, color: c })}
                    className={clsx(
                      'h-8 w-8 rounded-lg ring-2 ring-offset-2 transition',
                      editing.color === c ? 'ring-ink-900' : 'ring-transparent',
                    )}
                    style={{ background: c }}
                  />
                ))}
              </div>
            </Field>
            <Field label="Notatki (opcjonalnie)">
              <TextArea
                rows={2}
                value={editing.notes ?? ''}
                onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
              />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  )
}
