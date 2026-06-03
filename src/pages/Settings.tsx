import { useEffect, useRef, useState } from 'react'
import {
  Database,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Upload,
  Trash2,
  Wand2,
  Coins,
} from 'lucide-react'
import { useSettings } from '@/state/settings'
import { toast } from '@/state/toast'
import { Button, Field, Select, TextArea, TextInput, SectionTitle } from '@/components/ui'
import {
  CURRENCY_OPTIONS,
  EST_IMAGE_COST_USD,
  IMAGE_MODEL_OPTIONS,
  TEXT_MODEL_OPTIONS,
  USD_PLN,
} from '@/lib/constants'
import { testConnection } from '@/lib/gemini'
import { clearAllData, exportAll, importAll } from '@/db/db'
import { downloadText } from '@/lib/csv'

export function SettingsPage() {
  const { settings, update } = useSettings()
  const [form, setForm] = useState(settings)
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [busy, setBusy] = useState(false)
  const importRef = useRef<HTMLInputElement>(null)

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

  const wipe = async () => {
    if (!window.confirm('Na pewno usunąć WSZYSTKIE produkty, modelki, zdjęcia i sprzedaże? Tej operacji nie można cofnąć.'))
      return
    setBusy(true)
    await clearAllData()
    setBusy(false)
    toast.success('Wyczyszczono dane.')
  }

  const estCost = (form.imagesGenerated * EST_IMAGE_COST_USD).toFixed(2)
  const estCostPln = (form.imagesGenerated * EST_IMAGE_COST_USD * USD_PLN).toFixed(0)

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
              . Klucz nie jest nigdzie wysyłany poza Google.
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

        <div className="grid gap-4 sm:grid-cols-2">
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
            hint="gemini-2.5-flash-image (Nano Banana) wygasa 02.10.2026 — nowsze: 3.1-flash-image / 3-pro-image."
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
        </div>
      </div>

      {/* KOSZTY */}
      <div className="card space-y-4 p-5">
        <div className="flex items-center gap-2 text-ink-900">
          <Coins size={18} className="text-amber-500" />
          <h3 className="font-bold">Generowanie zdjęć i koszty</h3>
        </div>
        <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Uwaga: generowanie obrazów przez Gemini API jest <b>płatne od pierwszego użycia</b> (brak
          darmowego limitu). Orientacyjnie ok. <b>${EST_IMAGE_COST_USD.toFixed(3)}</b> za obraz 1024px.
          Opisy tekstowe mają hojny darmowy limit.
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
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
        <div className="grid gap-4 sm:grid-cols-2">
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
