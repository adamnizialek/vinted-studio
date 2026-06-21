import { useEffect, useRef, useState } from 'react'
import { Camera, Loader2, Sparkles } from 'lucide-react'
import { extractFromImages, MAX_BASE64_CHARS, MAX_RAW_BYTES, type InlineImage } from '@/lib/gemini'
import {
  parsePromotionResponse,
  promotionFlags,
  PROMOTION_PROMPT,
  PROMOTION_SCHEMA,
  type PromotionDraft,
  type PromotionFlags,
} from '@/lib/promotionScreenshot'
import { blobToBase64 } from '@/lib/images'
import { toast } from '@/state/toast'
import { useSettings } from '@/state/settings'
import { FileDrop } from '@/components/FileDrop'

export interface PromotionReadResult {
  draft: PromotionDraft
  flags: PromotionFlags
  /** Plik zrzutu — zapisujemy go do bazy dopiero przy zapisie kosztu (nie tworzymy sierot). */
  file: File
}

/**
 * Pole „wczytaj ze zrzutu ekranu": wgrywa jeden zrzut zakupu promocji, wysyła go do
 * Gemini (wizja → JSON), parsuje wynik i przekazuje szkic w górę przez `onResult`.
 * Zapisu kosztu NIE robi — to robi formularz po zatwierdzeniu przez człowieka.
 */
export function PromotionScreenshotField({
  onResult,
  disabled,
}: {
  onResult: (r: PromotionReadResult) => void
  disabled?: boolean
}) {
  const settings = useSettings((s) => s.settings)
  const [reading, setReading] = useState(false)
  // Identyfikator bieżącego odczytu — unieważnia wyniki porzucone (unmount) lub wyprzedzone
  // (ponowny upload), by nie wstrzyknąć szkicu po zamknięciu/zmianie.
  const reqId = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  // Przerwij ewentualny odczyt w locie, gdy komponent znika (np. zamknięcie modala).
  useEffect(
    () => () => {
      reqId.current++
      abortRef.current?.abort()
    },
    [],
  )

  const onFiles = async (files: File[]) => {
    const file = files[0]
    if (!file) return
    if (!settings?.geminiApiKey) {
      toast.error('Dodaj klucz API Gemini w Ustawieniach, aby odczytać zrzut ekranu.')
      return
    }
    if (file.size > MAX_RAW_BYTES) {
      toast.error('Zrzut jest za duży (limit ~14 MB). Przytnij go lub zmniejsz.')
      return
    }

    setReading(true)
    const id = ++reqId.current
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    try {
      const images: InlineImage[] = [{ mime: file.type || 'image/png', base64: await blobToBase64(file) }]
      if (reqId.current !== id) return
      if (images[0].base64.length > MAX_BASE64_CHARS) {
        toast.error('Zrzut jest za duży (limit ~14 MB). Przytnij go lub zmniejsz.')
        return
      }
      const text = await extractFromImages(PROMOTION_PROMPT, images, {
        apiKey: settings.geminiApiKey,
        model: settings.textModel,
        responseSchema: PROMOTION_SCHEMA,
        signal: ac.signal,
      })
      if (reqId.current !== id) return // odczyt porzucony/wyprzedzony — nie przekazuj
      const draft = parsePromotionResponse(text)
      onResult({ draft, flags: promotionFlags(draft), file })
    } catch (e) {
      if (reqId.current === id) toast.error(e instanceof Error ? e.message : 'Nie udało się odczytać zrzutu ekranu.')
    } finally {
      if (reqId.current === id) setReading(false)
    }
  }

  return (
    <div className="space-y-2">
      <FileDrop onFiles={onFiles} accept="image/*" multiple={false} disabled={disabled || reading}>
        <Camera className="text-brand-500" />
        <span className="text-sm font-semibold text-ink-700">Wczytaj ze zrzutu ekranu — kliknij lub przeciągnij</span>
        <span className="text-xs text-ink-400">
          AI rozpozna <strong>rodzaj</strong> (podbicie / ekspozycja szafy) i <strong>kwotę</strong>. Sprawdzisz je przed zapisem.
        </span>
      </FileDrop>

      {reading && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center justify-center gap-2 rounded-xl bg-ink-50 px-4 py-4 text-sm text-ink-500 ring-1 ring-ink-100 dark:bg-ink-900/40 dark:ring-ink-800"
        >
          <Loader2 size={18} className="animate-spin-slow text-brand-500" />
          <Sparkles size={16} className="text-brand-500" />
          Czytam zrzut ekranu…
        </div>
      )}
    </div>
  )
}
