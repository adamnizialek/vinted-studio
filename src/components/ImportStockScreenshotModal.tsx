import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import clsx from 'clsx'
import { Camera, Loader2, Sparkles } from 'lucide-react'
import { db, importStock } from '@/db/db'
import { extractFromImages, MAX_BASE64_CHARS, MAX_RAW_BYTES, type InlineImage } from '@/lib/gemini'
import {
  parseExtractionResult,
  extractedToStockDrafts,
  allocateLandedCosts,
  landedFactor,
  rowFlags,
  EXTRACTION_PROMPT,
  EXTRACTION_SCHEMA,
  type ExtractedItem,
  type OrderTotals,
} from '@/lib/screenshotImport'
import {
  draftImportKey,
  dedupKeyedStock,
  type KeyedStockDraft,
  type ResolvedStockDraft,
} from '@/lib/stockImport'
import { blobToBase64 } from '@/lib/images'
import { money } from '@/lib/format'
import { toast } from '@/state/toast'
import { useSettings } from '@/state/settings'
import { FileDrop } from '@/components/FileDrop'
import { Button, Field, Modal, NumberInput, Select, TextInput } from '@/components/ui'

/** Wiersz recenzji = przedmiot z odczytu + stan UI (klucz Reacta, zaznaczenie). */
interface EditRow extends ExtractedItem {
  key: string
  include: boolean
}

interface Shot {
  url: string
  name: string
}

export function ImportStockScreenshotModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useSettings((s) => s.settings)
  const accounts = useLiveQuery(() => db.accounts.orderBy('createdAt').toArray(), [])

  // Klucze treści przedmiotów już w magazynie (multizbiór) — do podglądu licznika „do dodania".
  const existingCounts = useLiveQuery(async () => {
    const products = await db.products.toArray()
    const m = new Map<string, number>()
    for (const p of products) if (p.importKey) m.set(p.importKey, (m.get(p.importKey) ?? 0) + 1)
    return m
  }, [])

  const [rows, setRows] = useState<EditRow[]>([])
  const [shots, setShots] = useState<Shot[]>([])
  const [reading, setReading] = useState(false) // ekstrakcja AI w toku
  const [busy, setBusy] = useState(false) // zapis do bazy w toku
  const [accountId, setAccountId] = useState('') // opcjonalne konto dla całego importu
  const [extractedEmpty, setExtractedEmpty] = useState(false) // odczyt zakończony, 0 przedmiotów
  const [orderTotal, setOrderTotal] = useState<number | undefined>(undefined) // suma zamówienia (z dostawą), edytowalna
  const [readOrder, setReadOrder] = useState<OrderTotals>({}) // oryginalny odczyt sum — audyt/sanity-check
  const shotsRef = useRef<Shot[]>([])
  // Identyfikator bieżącego odczytu — unieważnia wyniki odczytów porzuconych (close)
  // lub wyprzedzonych (ponowny upload), by nie zapisać rzędów na zamkniętym modalu.
  const reqId = useRef(0)

  const revokeShots = () => {
    for (const s of shotsRef.current) URL.revokeObjectURL(s.url)
    shotsRef.current = []
  }

  // Zwolnij obiekty URL miniatur, gdyby komponent zniknął (np. nawigacja) bez close().
  useEffect(() => () => revokeShots(), [])

  const close = () => {
    reqId.current++ // unieważnij ewentualny odczyt w locie
    revokeShots()
    setRows([])
    setShots([])
    setAccountId('')
    setExtractedEmpty(false)
    setOrderTotal(undefined)
    setReadOrder({})
    setReading(false)
    onClose()
  }

  const onFiles = async (files: File[]) => {
    if (!files.length) return
    if (!settings?.geminiApiKey) {
      toast.error('Dodaj klucz API Gemini w Ustawieniach, aby odczytać zrzut ekranu.')
      return
    }
    // Tani pre-czek surowego rozmiaru — odrzuć ZANIM zakodujemy cokolwiek do base64.
    const totalBytes = files.reduce((n, f) => n + f.size, 0)
    if (totalBytes > MAX_RAW_BYTES) {
      toast.error('Zrzuty są za duże (limit ~14 MB). Wybierz mniej zdjęć lub je przytnij.')
      return
    }

    // Podgląd miniatur (zwolnij poprzednie obiekty URL).
    revokeShots()
    const nextShots = files.map((f) => ({ url: URL.createObjectURL(f), name: f.name }))
    shotsRef.current = nextShots
    setShots(nextShots)
    setRows([])
    setExtractedEmpty(false)
    setOrderTotal(undefined)
    setReadOrder({})
    setReading(true)
    const id = ++reqId.current
    try {
      const images: InlineImage[] = await Promise.all(
        files.map(async (f) => ({ mime: f.type || 'image/png', base64: await blobToBase64(f) })),
      )
      if (reqId.current !== id) return
      const totalChars = images.reduce((n, img) => n + img.base64.length, 0)
      if (totalChars > MAX_BASE64_CHARS) {
        toast.error('Zrzuty są za duże (limit ~14 MB). Wybierz mniej zdjęć lub je przytnij.')
        return
      }
      const text = await extractFromImages(EXTRACTION_PROMPT, images, {
        apiKey: settings.geminiApiKey,
        model: settings.textModel,
        responseSchema: EXTRACTION_SCHEMA,
      })
      if (reqId.current !== id) return // odczyt porzucony/wyprzedzony — nie zapisuj
      const { items, order } = parseExtractionResult(text)
      if (!items.length) {
        setExtractedEmpty(true)
        toast.error('Nie znaleziono przedmiotów na zrzucie. Spróbuj wyraźniejszego zdjęcia zamówienia.')
        return
      }
      setRows(items.map((it, i) => ({ ...it, key: `shot-${i}`, include: true })))
      setReadOrder(order)
      // Pre-wypełnij sumę tylko, gdy w zł (lub waluta sum nieznana) — inaczej nie mieszamy z ceną w zł.
      const totalIsPln = !order.currency || /^(pln|zł|zl)$/i.test(order.currency)
      setOrderTotal(totalIsPln ? order.orderTotal : undefined)
    } catch (e) {
      if (reqId.current === id) toast.error(e instanceof Error ? e.message : 'Nie udało się odczytać zrzutu ekranu.')
    } finally {
      if (reqId.current === id) setReading(false)
    }
  }

  const patch = (key: string, changes: Partial<EditRow>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...changes } : r)))

  // Rozkład landed liczony po PEŁNYM odczycie (wszystkie pozycje) — współczynnik dostawy ma
  // wtedy poprawną podstawę, nawet gdy część pozycji odznaczysz. Zwraca te same wiersze (po
  // indeksie) z ceną za sztukę zawierającą rozłożoną dostawę; bez sumy → ceny bez zmian.
  const landedRows = useMemo(() => allocateLandedCosts(rows, orderTotal), [rows, orderTotal])
  const factor = useMemo(() => landedFactor(rows, orderTotal), [rows, orderTotal])
  const rawSubtotal = useMemo(() => rows.reduce((n, r) => n + (r.unitPrice ?? 0) * r.quantity, 0), [rows])

  // Zaznaczone wiersze w zł (ceny ODCZYTANE) + ich koszt landed — wyrównane indeksami.
  // Wiersz w obcej walucie czeka, aż użytkownik wpisze cenę w zł (edycja czyści walutę),
  // żeby nie zapisać np. 4,99 USD jako 4,99 zł.
  const picked = useMemo(() => {
    const sel: { raw: EditRow; landed: number | undefined }[] = []
    rows.forEach((r, i) => {
      if (r.include && !rowFlags(r).nonPln) sel.push({ raw: r, landed: landedRows[i]?.unitPrice })
    })
    return sel
  }, [rows, landedRows])
  const needsCurrencyFix = useMemo(() => rows.filter((r) => r.include && rowFlags(r).nonPln).length, [rows])

  // Szkice do importu: purchaseCost = koszt landed (z dostawą), keyCost = cena odczytana
  // (stabilny dedup, niezależny od edytowalnej sumy zamówienia).
  const importDrafts = useMemo(
    () => extractedToStockDrafts(picked.map((p) => p.raw), picked.map((p) => p.landed)),
    [picked],
  )

  // Podgląd: zdedupuj szkice (multizbiór) względem magazynu po stabilnym kluczu odczytu.
  const { newCount, dupCount, totalCost } = useMemo(() => {
    const keyed: KeyedStockDraft[] = importDrafts.map((d) => ({ key: draftImportKey(d), draft: d }))
    const { toInsert, skipped } = dedupKeyedStock(existingCounts ?? new Map(), keyed)
    const cost = toInsert.reduce((n, k) => n + (k.draft.purchaseCost ?? 0), 0)
    return { newCount: toInsert.length, dupCount: skipped, totalCost: cost }
  }, [importDrafts, existingCounts])

  const doImport = async () => {
    const drafts: ResolvedStockDraft[] = importDrafts.map((d) => ({
      ...d,
      accountId: accountId || undefined,
    }))
    if (!drafts.length) return toast.error('Brak przedmiotów do importu.')
    setBusy(true)
    try {
      const res = await importStock(drafts)
      toast.success(`Dodano do magazynu: ${res.inserted}, pominięto duplikaty: ${res.skippedDuplicates}.`)
      close()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Błąd importu.')
    } finally {
      setBusy(false)
    }
  }

  const selectedCount = rows.filter((r) => r.include).length

  return (
    <Modal
      open={open}
      onClose={close}
      size="xl"
      title="Import magazynu ze zrzutu ekranu"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-ink-500">
            {newCount} do dodania
            {dupCount > 0 && <span className="text-ink-400"> · {dupCount} już w magazynie</span>}
            {newCount > 0 && totalCost > 0 && (
              <span className="text-ink-400"> · koszt {money(totalCost)}</span>
            )}
            {needsCurrencyFix > 0 && (
              <span className="text-amber-600"> · {needsCurrencyFix} do przeliczenia na zł</span>
            )}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={close}>
              Anuluj
            </Button>
            <Button onClick={doImport} disabled={busy || newCount === 0}>
              {busy ? <Loader2 size={16} className="animate-spin-slow" /> : <>Dodaj {newCount} do magazynu</>}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        <FileDrop onFiles={onFiles} accept="image/*" multiple disabled={reading}>
          <Camera className="text-brand-500" />
          <span className="text-sm font-semibold text-ink-700">
            Przeciągnij zrzut(y) ekranu zamówienia — np. z AliExpress — lub kliknij
          </span>
          <span className="text-xs text-ink-400">
            Sztuczna inteligencja odczyta nazwy, ceny i ilości. Importują się <strong>bez konta</strong>.
          </span>
        </FileDrop>

        {/* Pasek miniatur wgranych zrzutów — do porównania z odczytem. */}
        {shots.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {shots.map((s) => (
              <img
                key={s.url}
                src={s.url}
                alt={s.name}
                className="h-20 w-20 shrink-0 rounded-lg object-cover ring-1 ring-ink-100"
              />
            ))}
          </div>
        )}

        {reading && (
          <div className="flex items-center justify-center gap-2 rounded-xl bg-ink-50 px-4 py-6 text-sm text-ink-500 ring-1 ring-ink-100 dark:bg-ink-900/40 dark:ring-ink-800">
            <Loader2 size={18} className="animate-spin-slow text-brand-500" />
            <Sparkles size={16} className="text-brand-500" />
            Czytam zrzut ekranu…
          </div>
        )}

        {!reading && rows.length > 0 && (
          <div className="space-y-4">
            <p className="rounded-xl bg-ink-50 px-4 py-3 text-xs text-ink-500 ring-1 ring-ink-100 dark:bg-ink-900/40 dark:text-ink-300 dark:ring-ink-800">
              Sprawdź i popraw odczyt przed dodaniem. Ceny są <strong>za sztukę</strong>; ilość większa niż 1
              doda osobny przedmiot za każdą sztukę. Podaj sumę zamówienia poniżej, a dostawę rozłożymy na
              sztuki. Konto przypiszesz później w Magazynie.
            </p>

            {accounts && accounts.length > 0 && (
              <Field label="Konto dla całego importu (opcjonalnie)">
                <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="sm:w-64">
                  <option value="">— bez konta —</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            <Field label="Suma zamówienia z dostawą (opcjonalnie)">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <div className="flex items-center gap-1">
                  <NumberInput
                    min={0}
                    value={orderTotal}
                    placeholder="suma"
                    onValueChange={(n) => setOrderTotal(n != null && n > 0 ? n : undefined)}
                    aria-label="Suma zamówienia z dostawą"
                    className="w-28 text-right"
                  />
                  <span className="text-xs text-ink-400">zł</span>
                </div>
                {factor !== undefined && orderTotal !== undefined ? (
                  <span className="text-xs text-ink-400">
                    {orderTotal > rawSubtotal
                      ? `+ ${money(orderTotal - rawSubtotal)} dostawy/cła`
                      : orderTotal < rawSubtotal
                        ? `− ${money(rawSubtotal - orderTotal)} rabatu`
                        : 'bez dopłaty'}{' '}
                    — rozłożone na sztuki proporcjonalnie do ceny.
                  </span>
                ) : orderTotal !== undefined ? (
                  <span className="text-xs text-amber-600">
                    Uzupełnij ceny wszystkich pozycji w zł, aby rozłożyć dostawę.
                  </span>
                ) : (
                  <span className="text-xs text-ink-400">
                    Wpisz „Sumę"/„Razem do zapłaty" z zamówienia, aby doliczyć dostawę do każdej sztuki.
                  </span>
                )}
                {readOrder.subtotal !== undefined && Math.abs(readOrder.subtotal - rawSubtotal) >= 0.5 && (
                  <span className="text-xs text-amber-600">
                    Podsuma z odczytu ({money(readOrder.subtotal)}) ≠ suma cen pozycji ({money(rawSubtotal)}) — sprawdź ceny.
                  </span>
                )}
              </div>
            </Field>

            <div className="rounded-xl border border-ink-100">
              <div className="flex items-center justify-between border-b border-ink-100 px-4 py-2 text-sm font-semibold text-ink-700">
                <span>Odczytane przedmioty ({rows.length})</span>
                <span className="text-xs font-normal text-ink-400">{selectedCount} zaznaczonych</span>
              </div>
              <div className="divide-y divide-ink-50">
                {rows.map((r, i) => (
                  <ReviewLine key={r.key} r={r} landed={landedRows[i]?.unitPrice} onPatch={(c) => patch(r.key, c)} />
                ))}
              </div>
            </div>
          </div>
        )}

        {!reading && extractedEmpty && (
          <p className="rounded-xl bg-ink-50 px-4 py-4 text-center text-sm text-ink-400 ring-1 ring-ink-100">
            Nic nie odczytano. Spróbuj wyraźniejszego zrzutu strony zamówienia (z nazwami i cenami).
          </p>
        )}
      </div>
    </Modal>
  )
}

function Flag({
  tone,
  onClick,
  children,
}: {
  tone: 'warn' | 'info'
  onClick?: () => void
  children: ReactNode
}) {
  const cls = {
    warn: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    info: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  }[tone]
  const common = clsx('rounded-full px-2 py-0.5 text-[11px] font-medium', cls)
  return onClick ? (
    <button type="button" onClick={onClick} className={clsx(common, 'underline-offset-2 hover:underline')}>
      {children}
    </button>
  ) : (
    <span className={common}>{children}</span>
  )
}

function ReviewLine({
  r,
  landed,
  onPatch,
}: {
  r: EditRow
  landed?: number
  onPatch: (changes: Partial<EditRow>) => void
}) {
  const f = rowFlags(r)
  const variant = [r.color, r.size].filter(Boolean).join(' · ')
  // Pokaż koszt landed (z rozłożoną dostawą), gdy różni się od odczytanej ceny za sztukę.
  const showLanded =
    landed !== undefined && r.unitPrice !== undefined && !f.nonPln && Math.abs(landed - r.unitPrice) >= 0.01

  return (
    <div className={clsx('px-4 py-3', !r.include && 'opacity-50')}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="checkbox"
          aria-label="Dodaj ten przedmiot"
          checked={r.include}
          onChange={(e) => onPatch({ include: e.target.checked })}
          className="h-4 w-4 rounded border-ink-300 text-brand-500 focus:ring-brand-400"
        />
        <TextInput
          value={r.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          aria-label="Nazwa przedmiotu"
          className="min-w-[10rem] flex-1"
        />
        <NumberInput
          integer
          min={1}
          value={r.quantity}
          onValueChange={(n) => onPatch({ quantity: Math.max(1, n ?? 1) })}
          aria-label="Ilość"
          className="w-16 text-center"
        />
        <div className="flex items-center gap-1">
          <NumberInput
            min={0}
            value={r.unitPrice}
            placeholder="cena"
            onValueChange={(n) => {
              // Wpisanie poprawnej ceny = wartość w zł → czyścimy wykrytą walutę (znika nonPln).
              // Przy pustym/niepoprawnym polu NIE czyścimy waluty, by wiersz w obcej walucie
              // dalej był wyłączony z importu (nie zaimportuje się bez ceny jako 0 zł).
              if (n != null && n > 0) onPatch({ unitPrice: n, currency: undefined })
              else onPatch({ unitPrice: undefined })
            }}
            aria-label="Cena za sztukę"
            className="w-24 text-right"
          />
          <span className="text-xs text-ink-400">{f.nonPln ? r.currency : 'zł'}</span>
        </div>
      </div>
      {(variant || r.priceText || showLanded || f.bundle || f.nonPln || f.lowConfidence || f.noPrice) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-7">
          {variant && <span className="text-xs text-ink-400">{variant}</span>}
          {r.priceText && <span className="text-xs text-ink-400">odczyt: {r.priceText}</span>}
          {showLanded && <span className="text-xs font-medium text-emerald-600">→ {money(landed)} z dostawą</span>}
          {f.nonPln &&
            (r.unitPrice !== undefined ? (
              <Flag tone="warn" onClick={() => onPatch({ currency: undefined })}>
                waluta {r.currency} — użyj {r.unitPrice} jako zł
              </Flag>
            ) : (
              <Flag tone="warn">waluta {r.currency} — wpisz cenę w zł</Flag>
            ))}
          {f.bundle && <Flag tone="warn">zestaw — cena może nie być za sztukę</Flag>}
          {f.noPrice && <Flag tone="warn">brak ceny</Flag>}
          {f.lowConfidence && <Flag tone="info">niepewny odczyt</Flag>}
        </div>
      )}
    </div>
  )
}
