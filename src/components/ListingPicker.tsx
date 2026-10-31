import { useState } from 'react'
import { Check, ChevronDown, Megaphone } from 'lucide-react'
import clsx from 'clsx'
import type { Account, Design, Product, ProductStatus } from '@/db/types'
import { STATUS_LABELS, STATUS_TONE } from '@/lib/constants'
import { dateFromInput, dateInputValue, pluralPl } from '@/lib/format'
import {
  daysBetween,
  earliestListing,
  effectiveListings,
  listingsForSize,
  sizeKey,
} from '@/lib/listing'
import {
  applyStatusChange,
  listProductOn,
  toggleDesignListing,
  unlistProduct,
} from '@/lib/productActions'
import { patchEntity } from '@/db/db'
import { toast } from '@/state/toast'
import { ResponsivePicker, OptionRow } from '@/components/Popover'
import { SoldModal } from '@/components/SoldModal'
import { TextInput } from '@/components/ui'

// „Gdzie to jest wystawione” — jeden wybór zamiast osobnego statusu i konta. Wybranie
// konta zapisuje naraz status, konto i datę wystawienia, z której liczą się czas
// sprzedaży i zalegające oferty na pulpicie.

/**
 * Data wystawienia: dziś (domyślnie, `null`) albo wcześniejsza — do dopisania starych
 * ogłoszeń. `null` rozwiązujemy dopiero przy zapisie, żeby okno otwarte przed północą
 * nie zapisało wczorajszej daty. Pole stoi poza `role="menu"` (czytniki ekranu).
 */
function SinceField({ day, setDay }: { day: string | null; setDay: (d: string | null) => void }) {
  const today = dateInputValue(Date.now())
  return (
    <label className="mb-1 flex items-center justify-between gap-3 px-2.5 py-1.5 text-xs text-ink-500">
      <span>Wystawione od</span>
      <TextInput
        type="date"
        value={day ?? today}
        max={today}
        onChange={(e) =>
          setDay(!e.target.value || e.target.value === today ? null : e.target.value)
        }
        className="!w-auto !py-1 text-xs"
      />
    </label>
  )
}

/** Dzień z pola daty → znacznik: dziś to „teraz”, inny dzień to lokalne południe. */
function sinceFrom(day: string | null): number {
  const now = Date.now()
  return day == null ? now : Math.min(dateFromInput(day, now), now)
}

const AccountDot = ({ account }: { account: Account }) => (
  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: account.color }} />
)

/** Pojedynczy przedmiot: status i konto w jednym chipie. */
export function ProductListingPicker({
  product,
  accounts,
  className,
}: {
  product: Product
  accounts: Account[]
  className?: string
}) {
  const [soldOpen, setSoldOpen] = useState(false)
  const [day, setDay] = useState<string | null>(null)
  const listedOn =
    product.status === 'listed' ? accounts.find((a) => a.id === product.accountId) : undefined

  const run = async (close: () => void, action: () => Promise<void>) => {
    close()
    try {
      await action()
    } catch {
      toast.error('Nie udało się zapisać.')
    }
  }

  const pickStatus = (status: ProductStatus, close: () => void) => {
    if (status === product.status) return close()
    if (status === 'sold') {
      close()
      setSoldOpen(true)
      return
    }
    if (status === 'in_stock') return run(close, () => unlistProduct(product.id))
    void run(close, () => applyStatusChange(product.id, status))
  }

  return (
    <>
      <ResponsivePicker
        title="Gdzie jest wystawione?"
        trigger={({ ref, toggle, aria }) => (
          <button
            ref={ref}
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              toggle()
            }}
            // `tap-target` adds a mobile-only 44px hit area without growing the pill.
            className={clsx(
              'badge tap-target max-w-full shadow-sm',
              STATUS_TONE[product.status],
              className,
            )}
            {...aria}
          >
            {listedOn ? (
              <>
                <AccountDot account={listedOn} />
                <span className="truncate">{listedOn.name}</span>
              </>
            ) : (
              STATUS_LABELS[product.status]
            )}
            <ChevronDown size={12} className="-mr-0.5 shrink-0 opacity-70" />
          </button>
        )}
      >
        {(close) => (
          <>
            {/* Sprzedany przedmiot nie wraca na Vinted stąd (sprzedaż zostałaby policzona
                dwa razy); konto sprzedaży poprawia się w Sprzedaży. */}
            {accounts.length > 0 && product.status !== 'sold' && (
              <>
                <p className="px-2.5 pb-1 pt-0.5 text-xs font-semibold uppercase tracking-wide text-ink-400">
                  Wystawione na
                </p>
                {!listedOn && <SinceField day={day} setDay={setDay} />}
              </>
            )}
            <div role="menu" aria-label="Gdzie jest wystawione">
              {accounts.length > 0 && product.status !== 'sold' && (
                <>
                  {accounts.map((a) => {
                    const selected = listedOn?.id === a.id
                    return (
                      <OptionRow
                        key={a.id}
                        selected={selected}
                        onClick={() =>
                          selected
                            ? close()
                            : run(close, () => listProductOn(product.id, a.id, sinceFrom(day), day != null))
                        }
                      >
                        <AccountDot account={a} />
                        <span className="truncate">{a.name}</span>
                        {selected && <Check size={15} className="ml-auto text-ink-500" />}
                      </OptionRow>
                    )
                  })}
                  <div className="my-1 border-t border-ink-100" />
                </>
              )}
              {(['in_stock', 'sold', 'reserved', 'draft', 'archived'] as const).map((s) => (
                <OptionRow
                  key={s}
                  selected={s === product.status}
                  onClick={() => pickStatus(s, close)}
                >
                  <span className={clsx('badge', STATUS_TONE[s])}>
                    {s === 'sold' && product.status !== 'sold' ? 'Sprzedane…' : STATUS_LABELS[s]}
                  </span>
                  {s === product.status && <Check size={15} className="ml-auto text-ink-500" />}
                </OptionRow>
              ))}
            </div>
          </>
        )}
      </ResponsivePicker>

      {/* Mounted only while open so each grid card doesn't hold idle useLiveQuery
          subscriptions (one per card otherwise). */}
      {soldOpen && (
        <SoldModal
          open
          onClose={() => setSoldOpen(false)}
          product={product}
          onSold={(patch) => {
            void patchEntity('products', product.id, patch)
            setSoldOpen(false)
          }}
        />
      )}
    </>
  )
}

/**
 * Model albo jeden jego rozmiar (`size`): na których kontach wisi ogłoszenie. Jedno
 * ogłoszenie na rozmiar i konto, niezależnie od liczby sztuk; sztuki idą za nim (patrz
 * setDesignListings). Bez `size` (karta w Magazynie) zaznaczenie dotyczy wszystkich
 * rozmiarów naraz. Sprzedaż konkretnej sztuki oznacza się w modelu, przy rozmiarze.
 */
export function DesignListingPicker({
  design,
  members,
  accounts,
  size,
  className,
}: {
  design: Design
  members: Product[]
  accounts: Account[]
  /** Rozmiar (sizeKey) wybrany w edytorze modelu; brak = cały model. */
  size?: string
  className?: string
}) {
  const [day, setDay] = useState<string | null>(null)
  // Starszy model (bez pola) — ogłoszenia odczytane z jego wystawionych sztuk.
  const all = effectiveListings(design.listings, members)
  const listings = size == null ? all : listingsForSize(all, size)
  const shown = size == null ? members : members.filter((m) => sizeKey(m) === size)
  const live = accounts.filter((a) => listings.some((l) => l.accountId === a.id))
  const since = earliestListing(listings)
  const days = since == null ? null : Math.max(0, daysBetween(since, Date.now()))
  const unsold = shown.filter((m) => m.status !== 'sold' && m.status !== 'archived').length

  // Wyprzedany model nie ma czego wystawiać — chip znika (linia rozmiarów to pokazuje).
  if (accounts.length === 0 || (unsold === 0 && listings.length === 0)) return null

  const toggle = async (accountId: string) => {
    try {
      await toggleDesignListing(design.id, accountId, sinceFrom(day), size)
    } catch {
      toast.error('Nie udało się zapisać.')
    }
  }

  return (
    <ResponsivePicker
      title={size == null ? 'Gdzie jest wystawiony model?' : `Gdzie jest wystawiony rozmiar ${size}?`}
      trigger={({ ref, toggle: open, aria }) => (
        <button
          ref={ref}
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            open()
          }}
          className={clsx(
            'tap-target relative inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium transition',
            live.length
              ? STATUS_TONE.listed
              : 'text-ink-400 ring-1 ring-dashed ring-ink-200 hover:bg-ink-100',
            className,
          )}
          aria-label={
            live.length ? `Wystawiony na: ${live.map((a) => a.name).join(', ')}` : undefined
          }
          {...aria}
        >
          {live.length ? (
            <>
              {live.map((a) => (
                <AccountDot key={a.id} account={a} />
              ))}
              {/* Karta jest wąska: przy kilku kontach wystarczą kropki, nazwy są w arkuszu. */}
              <span className="truncate">
                {live.length === 1 ? `${live[0].name} · ` : ''}
                {days} {pluralPl(days ?? 0, 'dzień', 'dni', 'dni')}
              </span>
            </>
          ) : (
            <>
              <Megaphone size={12} /> Wystaw
            </>
          )}
          <ChevronDown size={11} className="shrink-0 opacity-70" />
        </button>
      )}
    >
      {() => (
        <>
          <p className="px-2.5 pb-1 pt-0.5 text-xs text-ink-500">
            Zaznacz konta, na których wisi ogłoszenie{' '}
            {size == null ? 'tego modelu, wszystkie rozmiary naraz' : `rozmiaru ${size || '(bez rozmiaru)'}`}{' '}
            ({unsold} {pluralPl(unsold, 'sztuka', 'sztuki', 'sztuk')} w sprzedaży).
          </p>
          <SinceField day={day} setDay={setDay} />
          <div role="menu" aria-label="Konta z ogłoszeniem">
            {accounts.map((a) => {
              const listedSince = earliestListing(listings.filter((l) => l.accountId === a.id))
              const on = listedSince != null
              return (
                <OptionRow
                  key={a.id}
                  role="menuitemcheckbox"
                  selected={on}
                  onClick={() => void toggle(a.id)}
                >
                  <span
                    className={clsx(
                      'grid h-5 w-5 shrink-0 place-items-center rounded-md ring-1',
                      on ? 'bg-brand-500 text-white ring-brand-500' : 'ring-ink-300',
                    )}
                  >
                    {on && <Check size={13} />}
                  </span>
                  <AccountDot account={a} />
                  <span className="truncate">{a.name}</span>
                  {on && (
                    <span className="ml-auto shrink-0 text-xs text-ink-400">
                      od {new Date(listedSince!).toLocaleDateString('pl-PL')}
                    </span>
                  )}
                </OptionRow>
              )
            })}
          </div>
        </>
      )}
    </ResponsivePicker>
  )
}
