import { useEffect, useRef, useState } from 'react'
import {
  Cloud,
  Database,
  Download,
  Eraser,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
  Upload,
  Trash2,
  Wand2,
  Coins,
} from 'lucide-react'
import { useSettings } from '@/state/settings'
import { useSync } from '@/state/sync'
import { toast } from '@/state/toast'
import { Button, Field, Select, TextArea, TextInput, SectionTitle } from '@/components/ui'
import {
  CURRENCY_OPTIONS,
  DEFAULT_IMAGE_RESOLUTION,
  estimateImageCostUsd,
  IMAGE_MODEL_OPTIONS,
  IMAGE_RESOLUTION_OPTIONS,
  TEXT_MODEL_OPTIONS,
  USD_PLN,
} from '@/lib/constants'
import { testConnection } from '@/lib/gemini'
import { clearAllData, clearImportedData, countImportedData, exportAll, importAll } from '@/db/db'
import { getSyncToken, setSyncToken } from '@/sync/config'
import { connectMessage, isConnected, manualSyncMessage, statusLabel } from '@/sync/status'
import { seedOutbox } from '@/sync/syncEngine'
import { downloadText } from '@/lib/csv'

export function SettingsPage() {
  const { settings, update } = useSettings()
  const [form, setForm] = useState(settings)
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [busy, setBusy] = useState(false)
  const importRef = useRef<HTMLInputElement>(null)
  const [syncToken, setSyncTokenInput] = useState(getSyncToken() ?? '')
  const [savedToken, setSavedToken] = useState(getSyncToken() ?? '')
  const syncStatus = useSync((s) => s.status)
  const lastSyncedAt = useSync((s) => s.lastSyncedAt)
  const syncError = useSync((s) => s.error)
  // Wprost ze sklepu — bez osobnego useState, który potrafił się rozjechać z konfiguracją.
  const connected = isConnected(syncStatus)
  // Zmieniony token trzeba móc zatwierdzić, nie tylko rozłączyć i połączyć od nowa.
  const tokenChanged = syncToken.trim() !== savedToken

  useEffect(() => setForm(settings), [settings])
  if (!form) return null

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm({ ...form, [key]: value })

  const save = async () => {
    await update(form)
    toast.success('Zapisano ustawienia.')
  }

  const test = async () => {
    if (!form.geminiApiKey) return toast.error('Najpierw wpisz klucz API.')
    setTesting(true)
    try {
      await update(form) // zapisz, by reszta aplikacji widziala klucz
      await testConnection(form.geminiApiKey, form.textModel)
      toast.success('Połączenie z Gemini działa ✔')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Błąd połączenia.')
    } finally {
      setTesting(false)
    }
  }

  const doExport = async () => {
    const data = await exportAll()
    const stamp = new Date().toISOString().slice(0, 10)
    downloadText(`vinted-studio-backup-${stamp}.json`, JSON.stringify(data), 'application/json')
    toast.success('Pobrano kopię zapasową (bez klucza API).')
  }

  const doImport = async (file: File) => {
    setBusy(true)
    try {
      const data = JSON.parse(await file.text())
      await importAll(data)
      await useSettings.getState().load()
      toast.success('Zaimportowano dane z kopii zapasowej.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Nie udało się zaimportować pliku.')
    } finally {
      setBusy(false)
    }
  }

  const connectSync = async () => {
    const token = syncToken.trim()
    if (!token) return toast.error('Wpisz token synchronizacji.')
    setSyncToken(token)
    setSavedToken(token)
    setBusy(true)
    try {
      await seedOutbox()
      const status = await useSync.getState().syncNow()
      const msg = connectMessage(status, useSync.getState().error)
      toast[msg.tone](msg.text)
    } finally {
      setBusy(false)
    }
  }

  const disconnectSync = () => {
    setSyncToken(null)
    setSavedToken('')
    setSyncTokenInput('')
    useSync.setState({ status: 'disabled', error: null, lastSyncedAt: null })
    toast.success('Rozłączono synchronizację (dane pozostają lokalnie).')
  }

  const manualSync = async () => {
    setBusy(true)
    try {
      const msg = manualSyncMessage(await useSync.getState().syncNow())
      toast[msg.tone](msg.text)
    } finally {
      setBusy(false)
    }
  }

  const wipe = async () => {
    if (!window.confirm('Na pewno usunąć WSZYSTKIE produkty, modelki, zdjęcia i sprzedaże? Tej operacji nie można cofnąć.'))
      return
    setBusy(true)
    await clearAllData()
    setBusy(false)
    toast.success('Wyczyszczono dane.')
  }

  const clearImported = async () => {
    const c = await countImportedData()
    const total = c.sales + c.expenses + c.products
    if (total === 0) return toast.success('Brak danych z importu do usunięcia.')
    if (
      !window.confirm(
        `Usunąć ${c.sales} sprzedaży, ${c.expenses} kosztów i ${c.products} przedmiotów pochodzących z importu? ` +
          'Ręczne wpisy oraz produkty ze zdjęciami zostaną zachowane. Tej operacji nie można cofnąć.',
      )
    )
      return
    setBusy(true)
    try {
      const res = await clearImportedData()
      toast.success(
        `Usunięto z importu: ${res.sales} sprzedaży, ${res.expenses} kosztów, ${res.products} przedmiotów.`,
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Błąd czyszczenia danych.')
    } finally {
      setBusy(false)
    }
  }

  const perImageCost = estimateImageCostUsd(form.imageModel, form.imageResolution)
  const estCost = (form.imagesGenerated * perImageCost).toFixed(2)
  const estCostPln = (form.imagesGenerated * perImageCost * USD_PLN).toFixed(0)

  return (
    <div className="space-y-5">
      <SectionTitle
        title="Ustawienia"
        subtitle="Klucz API i dane zapisane są wyłącznie lokalnie w tej przeglądarce."
        right={
          <Button onClick={save}>
            <Wand2 size={16} /> Zapisz
          </Button>
        }
      />

      {/* GEMINI API */}
      <div className="card space-y-4 p-5">
        <div className="flex items-center gap-2 text-ink-900">
          <KeyRound size={18} className="text-brand-500" />
          <h3 className="font-bold">Gemini API</h3>
        </div>

        <Field
          label="Klucz API Gemini"
          hint={
            <>
              Pobierz bezpłatnie w{' '}
              <a className="text-brand-600 underline" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
                Google AI Studio → API keys
              </a>
              . Klucz nie jest nigdzie wysyłany poza Google. <b>Opisy tekstowe</b> działają na
              darmowym kluczu; <b>generowanie zdjęć</b> wymaga włączenia płatności — patrz niżej.
            </>
          }
        >
          <div className="flex gap-2">
            <div className="relative flex-1">
              <TextInput
                type={showKey ? 'text' : 'password'}
                value={form.geminiApiKey}
                onChange={(e) => set('geminiApiKey', e.target.value)}
                placeholder="AIza..."
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700"
              >
                {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <Button variant="ghost" onClick={test} disabled={testing}>
              {testing ? <Loader2 size={16} className="animate-spin-slow" /> : 'Testuj'}
            </Button>
          </div>
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Model tekstowy (opisy)" hint="Możesz wpisać dowolne ID modelu.">
            <TextInput
              list="text-models"
              value={form.textModel}
              onChange={(e) => set('textModel', e.target.value)}
            />
            <datalist id="text-models">
              {TEXT_MODEL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </datalist>
          </Field>
          <Field
            label="Model obrazów (zdjęcia)"
            hint="Domyślnie gemini-3.1-flash-image. Stary 2.5-flash-image daje tylko 1024px (ryzyko blokady za niską jakość) i wygasa 02.10.2026."
          >
            <TextInput
              list="image-models"
              value={form.imageModel}
              onChange={(e) => set('imageModel', e.target.value)}
            />
            <datalist id="image-models">
              {IMAGE_MODEL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </datalist>
          </Field>
          <Field
            label="Rozdzielczość zdjęć"
            hint="2K (~2048px) zalecane dla Vinted — znacznie ostrzejsze niż 1024px. Działa dla modeli Gemini 3."
          >
            <Select
              value={form.imageResolution ?? DEFAULT_IMAGE_RESOLUTION}
              onChange={(e) => set('imageResolution', e.target.value as typeof form.imageResolution)}
            >
              {IMAGE_RESOLUTION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>

      {/* KOSZTY */}
      <div className="card space-y-4 p-5">
        <div className="flex items-center gap-2 text-ink-900">
          <Coins size={18} className="text-amber-500" />
          <h3 className="font-bold">Generowanie zdjęć i koszty</h3>
        </div>
        <div className="space-y-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <p>
            Generowanie obrazów przez Gemini API jest <b>płatne od pierwszego użycia</b> — w
            cenniku Google modele obrazów mają darmowy limit <b>zero</b>. Na kluczu bez włączonych
            płatności każda próba kończy się błędem 429; czekanie nic nie da.
          </p>
          <p>
            Żeby to odblokować: w{' '}
            <a
              className="underline"
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noreferrer"
            >
              Google AI Studio → API keys
            </a>{' '}
            otwórz projekt swojego klucza i włącz płatności (plan płatny / billing). Koszt
            orientacyjnie <b>${perImageCost.toFixed(3)}</b> za obraz przy <b>{form.imageModel}</b> @{' '}
            <b>{form.imageResolution}</b> — czyli ok. <b>{(perImageCost * USD_PLN).toFixed(2)} zł</b>.
          </p>
          <p>
            <b>Opisy, tytuły i ceny</b> działają normalnie na darmowym kluczu — płatność dotyczy
            wyłącznie zdjęć.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Wariantów na jedną generację" hint="Ile zdjęć generować naraz (więcej = wyższy koszt).">
            <Select value={form.imageVariants} onChange={(e) => set('imageVariants', Number(e.target.value))}>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
          <div className="rounded-xl bg-ink-50 px-4 py-3 text-sm">
            <p className="text-ink-500">Wygenerowano dotąd</p>
            <p className="text-lg font-bold text-ink-900">
              {form.imagesGenerated} obrazów{' '}
              <span className="text-sm font-medium text-ink-400">
                ≈ ${estCost} (~{estCostPln} zł)
              </span>
            </p>
          </div>
        </div>
      </div>

      {/* SPRZEDAZ / OPISY */}
      <div className="card space-y-4 p-5">
        <h3 className="font-bold text-ink-900">Sprzedaż i opisy</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Waluta">
            <Select value={form.currency} onChange={(e) => set('currency', e.target.value)}>
              {CURRENCY_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Doklejaj stopkę do opisów">
            <label className="mt-1 flex cursor-pointer items-center gap-2 text-sm text-ink-700">
              <input
                type="checkbox"
                checked={form.appendSignature}
                onChange={(e) => set('appendSignature', e.target.checked)}
                className="h-4 w-4 rounded border-ink-300 text-brand-500 focus:ring-brand-400"
              />
              Tak, dodawaj poniższą stopkę
            </label>
          </Field>
        </div>
        <Field label="Stopka / podpis (opcjonalnie)">
          <TextArea
            rows={2}
            value={form.signature ?? ''}
            onChange={(e) => set('signature', e.target.value)}
            placeholder="np. Wysyłka w 24h 📦 Łączę przesyłki!"
          />
        </Field>
      </div>

      {/* SYNCHRONIZACJA */}
      <div className="card space-y-4 p-5">
        <div className="flex items-center gap-2 text-ink-900">
          <Cloud size={18} className="text-brand-500" />
          <h3 className="font-bold">Synchronizacja między urządzeniami</h3>
        </div>
        <div className="space-y-2 rounded-xl bg-ink-50 px-4 py-3 text-sm text-ink-600 dark:bg-ink-900/40 dark:text-ink-300">
          <p>
            <b>Opcjonalne.</b> Bez tokenu aplikacja działa w całości lokalnie — wszystko zostaje w
            tej przeglądarce. Token włącza synchronizację, żeby te same produkty, zdjęcia, modelki
            i sprzedaże widzieć na telefonie i na komputerze.
          </p>
          <p>
            Skąd wziąć token: dostajesz go od właściciela tej instalacji <b>albo</b> ustawiasz
            własny we własnym projekcie Cloudflare. Każdy token ma <b>osobne, prywatne dane</b> —
            osoba, która dała Ci token, nie widzi Twojego magazynu ani sprzedaży.
          </p>
          <p className="text-xs text-ink-400">
            Token i klucz Gemini nigdy się nie synchronizują — zostają wyłącznie na tym urządzeniu.
          </p>
        </div>
        <Field label="Token synchronizacji">
          <div className="flex gap-2">
            <TextInput
              type="password"
              value={syncToken}
              onChange={(e) => setSyncTokenInput(e.target.value)}
              placeholder="wklej token…"
              autoComplete="off"
              spellCheck={false}
            />
            {/* „Połącz” zostaje widoczny także po nieudanej próbie i po zmianie tokenu —
                inaczej jedyną drogą do ponowienia było „Rozłącz”, co brzmiało jak porażka. */}
            {(!connected || tokenChanged) && (
              <Button onClick={connectSync} disabled={busy}>
                {busy ? <Loader2 size={16} className="animate-spin-slow" /> : 'Połącz'}
              </Button>
            )}
            {connected && (
              <Button variant="ghost" onClick={disconnectSync} disabled={busy}>
                Rozłącz
              </Button>
            )}
          </div>
        </Field>
        {connected && (
          <div className="flex items-center gap-3 text-sm">
            <Button variant="ghost" onClick={manualSync} disabled={busy || syncStatus === 'syncing'}>
              <RefreshCw size={16} className={syncStatus === 'syncing' ? 'animate-spin' : undefined} />
              Synchronizuj teraz
            </Button>
            <span className="text-ink-400">{statusLabel(syncStatus, lastSyncedAt)}</span>
          </div>
        )}
        {syncStatus === 'error' && syncError && (
          <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {syncError}
          </p>
        )}
      </div>

      {/* DANE */}
      <div className="card space-y-4 p-5">
        <div className="flex items-center gap-2 text-ink-900">
          <Database size={18} className="text-brand-500" />
          <h3 className="font-bold">Kopia zapasowa danych</h3>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={doExport} disabled={busy}>
            <Download size={16} /> Eksportuj (JSON)
          </Button>
          <Button variant="ghost" onClick={() => importRef.current?.click()} disabled={busy}>
            <Upload size={16} /> Importuj
          </Button>
          <input
            ref={importRef}
            type="file"
            accept="application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) doImport(f)
              e.target.value = ''
            }}
          />
          <Button variant="ghost" onClick={clearImported} disabled={busy}>
            <Eraser size={16} /> Wyczyść zaimportowane
          </Button>
          <Button variant="danger" onClick={wipe} disabled={busy}>
            <Trash2 size={16} /> Wyczyść dane
          </Button>
        </div>
        <p className="text-xs text-ink-400">
          Eksport zawiera produkty, modelki, zdjęcia i sprzedaże (klucz API nie jest eksportowany).
        </p>
      </div>
    </div>
  )
}
