import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Pencil, Plus, Trash2, Users } from 'lucide-react'
import clsx from 'clsx'
import { db, deleteEntity, putEntity } from '@/db/db'
import type { Account } from '@/db/types'
import { uid } from '@/lib/id'
import { ACCOUNT_COLORS } from '@/lib/constants'
import { aggregateProfit, money } from '@/lib/format'
import { toast } from '@/state/toast'
import { Button, EmptyState, Field, Modal, SectionTitle, TextArea, TextInput } from '@/components/ui'

export function Accounts() {
  const accounts = useLiveQuery(() => db.accounts.orderBy('createdAt').toArray(), [])
  const sales = useLiveQuery(() => db.sales.toArray(), [])
  const products = useLiveQuery(() => db.products.toArray(), [])
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
    await putEntity('accounts', editing)
    setOpen(false)
    toast.success('Zapisano konto.')
  }

  const remove = async (id: string) => {
    if (!window.confirm('Usunąć to konto? Produkty i sprzedaże pozostaną, ale stracą przypisanie.'))
      return
    await deleteEntity('accounts', id)
    toast.success('Usunięto konto.')
  }

  return (
    <div>
      <SectionTitle
        title="Konta sprzedażowe"
        subtitle="Każde konto ma osobną ewidencję; widok wspólny sumuje wszystkie."
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
          description="Dodaj konta (np. dla każdej osoby lub profilu Vinted), aby prowadzić osobne ewidencje sprzedaży."
          action={
            <Button onClick={startNew}>
              <Plus size={16} /> Dodaj pierwsze konto
            </Button>
          }
        />
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {accounts?.map((a) => {
          const accSales = (sales ?? []).filter((s) => s.accountId === a.id)
          // Spójnie z Pulpitem i Ewidencją — jedna reguła przychodu (aggregateProfit).
          const revenue = aggregateProfit(accSales).revenue
          const stock = (products ?? []).filter(
            (p) => p.accountId === a.id && p.status !== 'sold' && p.status !== 'archived',
          ).length
          return (
            <div key={a.id} className="card p-4">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <span className="h-9 w-9 rounded-xl" style={{ background: a.color }} />
                  <div>
                    <p className="font-bold text-ink-900">{a.name}</p>
                    {a.vintedUsername && <p className="text-xs text-ink-400">@{a.vintedUsername}</p>}
                  </div>
                </div>
                <div className="flex gap-1">
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
                  <p className="text-xs text-ink-400">W magazynie</p>
                  <p className="font-bold text-ink-900">{stock}</p>
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
