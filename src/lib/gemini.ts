// Lekki klient REST Gemini API (bez SDK — zero dodatkowych zaleznosci).
// Klucz API uzytkownika jest trzymany lokalnie i wysylany wylacznie do Google.

import type { ImageResolution } from '@/db/types'

const BASE = 'https://generativelanguage.googleapis.com/v1beta'

/**
 * Limity czasu POJEDYNCZEJ próby (ms). Surowy `fetch` nie ma własnego timeoutu i
 * potrafił wisieć w nieskończoność — spinner kręcił się >5 min bez błędu. Generacja
 * obrazu bywa wolna pod obciążeniem (realne pomiary gemini-3.1-flash-image to
 * ~23–56 s przy 2K, a 4K dokłada kilkanaście sekund; dostawcy zalecają ≥120 s),
 * dlatego dostaje hojny budżet. Tekst/wizja zwracają szybciej → krótszy limit.
 */
const IMAGE_TIMEOUT_MS = 120_000
const DEFAULT_TIMEOUT_MS = 60_000
/** Liczba prób: pierwsza + jedno ponowienie błędu PRZEMIJAJĄCEGO. */
const MAX_ATTEMPTS = 2

/** Limit łącznego rozmiaru base64 na żądanie (~14 MB) — pod progiem 20 MB dla inline_data Gemini. */
export const MAX_BASE64_CHARS = 14_000_000
/** Odpowiadający limit surowych bajtów (base64 ≈ +33%) — tani pre-czek przed kodowaniem do base64. */
export const MAX_RAW_BYTES = MAX_BASE64_CHARS * 0.75

export class GeminiError extends Error {
  status?: number
  /** Czy błąd jest PRZEMIJAJĄCY i wart jednego ponowienia (timeout, sieć, 5xx). */
  retryable: boolean
  /** Stabilny kod błędu do rozróżnienia w UI/logice (np. 'timeout'). */
  code?: string
  constructor(message: string, status?: number, retryable = false, code?: string) {
    super(message)
    this.name = 'GeminiError'
    this.status = status
    this.retryable = retryable
    this.code = code
  }
}

export interface CallOptions {
  /** Limit czasu pojedynczej próby (ms). */
  timeoutMs?: number
  /** Zewnętrzny sygnał anulowania (np. przycisk „Anuluj" w UI). */
  signal?: AbortSignal
  /**
   * Czy ponawiać po TIMEOUCIE (domyślnie tak). Ekstrakcja ze zrzutu ustawia `false` —
   * interaktywny odczyt woli szybką porażkę niż drugie 60 s czekania na ten sam wynik.
   */
  retryTimeout?: boolean
}

export interface InlineImage {
  mime: string
  /** Dane base64 bez prefiksu data URL. */
  base64: string
}

/**
 * Mapuje `finishReason` kandydata na błąd (lub null, gdy w porządku). Wydzielone jako
 * czysta funkcja, by testować bez sieci. Oprócz filtrów bezpieczeństwa łapie też
 * `MAX_TOKENS` — to typowy, CICHY tryb porażki modeli „myślących”: rozumowanie zjada
 * budżet `maxOutputTokens`, a właściwa odpowiedź zostaje ucięta (niepełny JSON), więc
 * lepiej zgłosić zrozumiały błąd niż przepuścić obcięte dane do parsera.
 */
export function finishReasonError(finish: string | undefined): GeminiError | null {
  if (finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT')
    return new GeminiError('Odpowiedź zatrzymana przez filtry bezpieczeństwa. Zmień dane wejściowe.')
  if (finish === 'IMAGE_SAFETY' || finish === 'IMAGE_PROHIBITED_CONTENT')
    return new GeminiError(
      'Obraz wstrzymany przez filtry bezpieczeństwa. Zmień opis edycji lub zdjęcie i spróbuj ponownie.',
    )
  if (finish === 'MAX_TOKENS')
    return new GeminiError(
      'Odpowiedź została ucięta przez limit tokenów. Spróbuj ponownie z wyraźniejszym/mniejszym zrzutem lub wybierz inny model w Ustawieniach.',
    )
  return null
}

interface GeminiPart {
  text?: string
  inline_data?: { mime_type: string; data: string }
  inlineData?: { mimeType: string; data: string }
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError'
}

/**
 * Łączy limit czasu z opcjonalnym zewnętrznym sygnałem anulowania w jeden
 * `AbortSignal` dla `fetch`. `timedOut()` mówi, czy to MY przerwaliśmy żądanie
 * (limit czasu), czy użytkownik — bo to rozróżnienie decyduje, czy ponawiać
 * (timeout: tak) czy nie (anulowanie: nie). `done()` sprząta timer i listener.
 */
function withTimeout(timeoutMs: number, external?: AbortSignal) {
  const controller = new AbortController()
  let didTimeout = false
  const timer = setTimeout(() => {
    didTimeout = true
    controller.abort()
  }, timeoutMs)
  const onExternalAbort = () => controller.abort()
  if (external) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', onExternalAbort, { once: true })
  }
  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    done: () => {
      clearTimeout(timer)
      external?.removeEventListener('abort', onExternalAbort)
    },
  }
}

/** Pojedyncza próba żądania `:generateContent` z limitem czasu + anulowaniem. */
async function callGenerateOnce(
  model: string,
  apiKey: string,
  body: unknown,
  opts: CallOptions,
): Promise<GeminiPart[]> {
  if (!apiKey) throw new GeminiError('Brak klucza API Gemini. Dodaj go w Ustawieniach.')

  const t = withTimeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.signal)
  try {
    const res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: t.signal,
    })

    // Limit czasu obejmuje też ODCZYT treści — duży obraz (4K base64) bywa
    // wysyłany długo po nagłówkach. Nie połykamy abortu jako `null`: musi dojść
    // do mapowania na czytelny błąd w `catch` poniżej.
    const json = await res.json().catch((err) => {
      if (isAbortError(err)) throw err
      return null
    })

    if (!res.ok) {
      const msg =
        (json as any)?.error?.message ?? `Błąd Gemini API (HTTP ${res.status}).`
      if (res.status === 429)
        throw new GeminiError(
          'Przekroczono limit zapytań (429). Odczekaj chwilę lub sprawdź limity klucza.',
          429,
        )
      if (res.status === 400 && /API key not valid/i.test(msg))
        throw new GeminiError('Nieprawidłowy klucz API. Sprawdź go w Ustawieniach.', 400)
      if (res.status === 404)
        throw new GeminiError(
          `Model "${model}" nie istnieje lub jest niedostępny dla tego klucza. Wybierz inny model w Ustawieniach.`,
          404,
        )
      // 5xx (np. przeciążenie serwera) jest przemijający — pozwól na jedno ponowienie.
      throw new GeminiError(msg, res.status, res.status >= 500)
    }

    const candidate = (json as any)?.candidates?.[0]
    const blockReason = (json as any)?.promptFeedback?.blockReason
    if (blockReason)
      throw new GeminiError(
        `Treść zablokowana przez filtry bezpieczeństwa (${blockReason}). Zmień zdjęcie/opis i spróbuj ponownie.`,
      )
    if (!candidate)
      throw new GeminiError('Gemini nie zwróciło żadnej odpowiedzi. Spróbuj ponownie.')

    const fe = finishReasonError(candidate.finishReason)
    if (fe) throw fe

    return (candidate.content?.parts ?? []) as GeminiPart[]
  } catch (e) {
    // Błędy już zmapowane (status, filtry, finishReason) przepuszczamy bez zmian.
    if (e instanceof GeminiError) throw e
    if (isAbortError(e)) {
      if (t.timedOut())
        throw new GeminiError(
          'Przekroczono limit czasu — model nie odpowiedział na czas. Spróbuj ponownie lub zmniejsz rozdzielczość w Ustawieniach.',
          undefined,
          true, // przemijające — pozwól na jedno ponowienie
          'timeout',
        )
      // Przerwane świadomie przez użytkownika (przycisk „Anuluj").
      throw new GeminiError('Anulowano generowanie.')
    }
    // Pozostałe (np. TypeError z sieci, błąd odczytu strumienia).
    throw new GeminiError(
      'Brak połączenia z Gemini API (sieć lub CORS). Sprawdź internet i spróbuj ponownie.',
      undefined,
      true, // błąd sieciowy bywa przemijający — wart jednego ponowienia
    )
  } finally {
    t.done()
  }
}

/**
 * Wykonuje żądanie z limitem czasu i JEDNYM ponowieniem przy błędach
 * PRZEMIJAJĄCYCH (timeout, sieć, 5xx). Anulowanie przez użytkownika oraz błędy
 * DETERMINISTYCZNE (4xx, filtry bezpieczeństwa, pusta odpowiedź) NIE są ponawiane.
 *
 * UWAGA KOSZTOWA: ponowienie po TIMEOUCIE generacji obrazu może obciążyć konto
 * DWUKROTNIE — limit przerywamy po stronie klienta (AbortController), ale model
 * mógł już wygenerować i naliczyć obraz serwerowo; my tylko przestaliśmy czekać.
 * Błędy 5xx/sieci tej wady nie mają (nie doszło do udanej generacji). To świadomy
 * kompromis: jedno ponowienie ratuje zerwane połączenia, a „Anuluj" jest
 * bezpiecznikiem. Gdyby koszt miał priorytet — uczynić timeout obrazu nieponawialnym.
 */
async function callGenerate(
  model: string,
  apiKey: string,
  body: unknown,
  opts: CallOptions = {},
): Promise<GeminiPart[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await callGenerateOnce(model, apiKey, body, opts)
    } catch (e) {
      // Nie ponawiaj, gdy użytkownik anulował, błąd nie jest przemijający,
      // albo wyczerpaliśmy próby.
      if (opts.signal?.aborted) throw e
      if (!(e instanceof GeminiError && e.retryable)) throw e
      // Timeout NIE jest ponawiany, gdy wywołujący tego nie chce (ekstrakcja ze zrzutu).
      if (e.code === 'timeout' && opts.retryTimeout === false) throw e
      if (attempt >= MAX_ATTEMPTS - 1) throw e
    }
  }
}

function extractText(parts: GeminiPart[]): string {
  return parts
    .map((p) => p.text ?? '')
    .join('')
    .trim()
}

function extractImages(parts: GeminiPart[]): InlineImage[] {
  const out: InlineImage[] = []
  for (const p of parts) {
    const inline = p.inlineData ?? p.inline_data
    if (inline) {
      const mime = (inline as any).mimeType ?? (inline as any).mime_type ?? 'image/png'
      out.push({ mime, base64: (inline as any).data })
    }
  }
  return out
}

/** Buduje `parts`: prompt tekstowy + każdy obraz jako `inline_data` (base64). Jedno źródło prawdy. */
function imageParts(prompt: string, images: InlineImage[]): GeminiPart[] {
  return [
    { text: prompt },
    ...images.map((img) => ({ inline_data: { mime_type: img.mime, data: img.base64 } })),
  ]
}

export interface TextOptions extends CallOptions {
  apiKey: string
  model: string
  temperature?: number
  maxOutputTokens?: number
  system?: string
}

export async function generateText(prompt: string, opts: TextOptions): Promise<string> {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    ...(opts.system
      ? { systemInstruction: { parts: [{ text: opts.system }] } }
      : {}),
    generationConfig: {
      temperature: opts.temperature ?? 0.95,
      topP: 0.95,
      // Hojny limit: modele 2.5/3.x mają "thinking" wliczane w maxOutputTokens,
      // więc zbyt niski limit potrafi pochłonąć cały budżet na myślenie i zwrócić
      // pusty tekst. 8192 spokojnie mieści rozumowanie + krótki opis Vinted.
      maxOutputTokens: opts.maxOutputTokens ?? 8192,
    },
  }
  const parts = await callGenerate(opts.model, opts.apiKey, body, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: opts.signal,
  })
  const text = extractText(parts)
  if (!text)
    throw new GeminiError('Model nie zwrócił tekstu (możliwy limit tokenów). Spróbuj ponownie.')
  return text
}

export interface ImageOptions extends CallOptions {
  apiKey: string
  model: string
  temperature?: number
  /** Rozdzielczosc wyjsciowa — wysylana tylko do modeli Gemini 3 image. */
  resolution?: ImageResolution
  /** Proporcje (np. '3:4') — natywne pole imageConfig modeli Gemini 3. */
  aspectRatio?: string
}

interface ImageRequestBody {
  contents: { role: string; parts: GeminiPart[] }[]
  generationConfig: {
    responseModalities: string[]
    temperature?: number
    imageConfig?: { imageSize?: ImageResolution; aspectRatio?: string }
  }
}

/**
 * Czy model obsluguje natywny `imageConfig` (rozdzielczosc + proporcje).
 * Dotyczy wylacznie rodziny Gemini 3 image — starszy gemini-2.5-flash-image
 * odrzuca to pole (HTTP 400) i renderuje zawsze ~1MP.
 */
export function supportsImageConfig(model: string): boolean {
  return /^gemini-3/.test(model)
}

/**
 * Buduje cialo zadania `:generateContent` dla generacji obrazu. Wydzielone jako
 * czysta funkcja, by jednoznacznie testowac, ze rozdzielczosc (imageSize) realnie
 * trafia do API dla modeli Gemini 3 i NIE trafia do starego modelu 2.5.
 */
export function buildImageRequestBody(
  prompt: string,
  inputImages: InlineImage[],
  opts: ImageOptions,
): ImageRequestBody {
  const parts = imageParts(prompt, inputImages)

  const body: ImageRequestBody = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      temperature: opts.temperature ?? 0.9,
    },
  }

  if (supportsImageConfig(opts.model)) {
    const imageConfig: { imageSize?: ImageResolution; aspectRatio?: string } = {}
    if (opts.resolution) imageConfig.imageSize = opts.resolution
    if (opts.aspectRatio) imageConfig.aspectRatio = opts.aspectRatio
    if (Object.keys(imageConfig).length) body.generationConfig.imageConfig = imageConfig
  }

  return body
}

// ---------------------------------------------------------------------------
// Ekstrakcja strukturalna z obrazow (vision -> JSON).
// Uzywane przy imporcie magazynu ze zrzutu ekranu zamowienia (np. AliExpress):
// wysylamy zrzut(y) + prompt i wymuszamy odpowiedz w JSON wg schematu.
// ---------------------------------------------------------------------------

/**
 * Czy model nalezy do rodziny Gemini 3, ktora steruje myśleniem przez
 * `thinkingLevel` (a NIE `thinkingBudget`). Wyslanie obu pol naraz to HTTP 400,
 * wiec budowniczy ciala zapytania wybiera jedno wg tej funkcji.
 */
export function supportsThinkingLevel(model: string): boolean {
  return /^gemini-3/.test(model)
}

/**
 * Wybiera bezpieczny `thinkingConfig` dla danego modelu (lub `undefined`):
 *  - Gemini 3 → `thinkingLevel:'low'` (te modele nie przyjmują `thinkingBudget`),
 *  - Gemini 2.5 flash / flash-lite → `thinkingBudget:0` (można wyłączyć myślenie),
 *  - reszta (2.5-pro, 2.0-flash, nieznane) → `undefined` — bo np. 2.5-pro NIE pozwala
 *    wyłączyć myślenia (min 128) i `thinkingBudget:0` zwróciłby HTTP 400. Tu polegamy
 *    na hojnym `maxOutputTokens` + osłonie na pustą odpowiedź.
 */
function thinkingConfigFor(model: string): { thinkingBudget?: number; thinkingLevel?: string } | undefined {
  if (supportsThinkingLevel(model)) return { thinkingLevel: 'low' }
  if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 }
  return undefined
}

export interface ExtractionOptions extends CallOptions {
  apiKey: string
  model: string
  /** Schemat odpowiedzi (podzbior OpenAPI, typy WIELKIMI literami). Opcjonalny. */
  responseSchema?: unknown
  maxOutputTokens?: number
}

interface ExtractionRequestBody {
  contents: { role: string; parts: GeminiPart[] }[]
  generationConfig: {
    temperature: number
    maxOutputTokens: number
    responseMimeType: string
    responseSchema?: unknown
    thinkingConfig?: { thinkingBudget?: number; thinkingLevel?: string }
  }
}

/**
 * Buduje cialo `:generateContent` dla ekstrakcji vision->JSON. Wydzielone jako czysta
 * funkcja, by jednoznacznie testowac newralgiczne ustawienia:
 *  - `responseMimeType:'application/json'` (+ opcjonalny `responseSchema`) wymusza JSON,
 *  - `temperature:0` dla deterministycznego odczytu,
 *  - `thinkingConfig` ZALEZNY OD MODELU: `thinkingBudget:0` dla 2.5/2.0 (wylacza myślenie),
 *    `thinkingLevel:'low'` dla Gemini 3 — NIGDY oba naraz (inaczej HTTP 400). Bez tego
 *    modele „myślące” potrafią zużyć cały `maxOutputTokens` na rozumowanie i zwrócić
 *    pustą odpowiedź (MAX_TOKENS), na której JSON.parse by się wywalił.
 */
export function buildExtractionRequestBody(
  prompt: string,
  images: InlineImage[],
  opts: { model: string; responseSchema?: unknown; maxOutputTokens?: number },
): ExtractionRequestBody {
  const parts = imageParts(prompt, images)

  const generationConfig: ExtractionRequestBody['generationConfig'] = {
    temperature: 0,
    maxOutputTokens: opts.maxOutputTokens ?? 8192,
    responseMimeType: 'application/json',
  }
  const thinking = thinkingConfigFor(opts.model)
  if (thinking) generationConfig.thinkingConfig = thinking
  if (opts.responseSchema) generationConfig.responseSchema = opts.responseSchema

  return { contents: [{ role: 'user', parts }], generationConfig }
}

/**
 * Wyciaga dane (jako tekst JSON) z obrazow + promptu. Zwraca surowy tekst odpowiedzi —
 * parsowanie/walidacje robi warstwa wyzsza (nigdy nie ufamy, ze model zwroci czysty JSON).
 * Rzuca `GeminiError`, gdy model nic nie zwroci (np. limit tokenow zjedzony przez myślenie).
 */
export async function extractFromImages(
  prompt: string,
  images: InlineImage[],
  opts: ExtractionOptions,
): Promise<string> {
  const body = buildExtractionRequestBody(prompt, images, {
    model: opts.model,
    responseSchema: opts.responseSchema,
    maxOutputTokens: opts.maxOutputTokens,
  })
  const parts = await callGenerate(opts.model, opts.apiKey, body, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: opts.signal,
    retryTimeout: false, // interaktywny odczyt — nie czekaj drugich 60 s na ten sam timeout
  })
  const text = extractText(parts)
  if (!text)
    throw new GeminiError(
      'Model nie zwrócił danych (możliwy limit tokenów lub nieczytelny zrzut). Spróbuj ponownie lub użyj wyraźniejszego zrzutu ekranu.',
    )
  return text
}

/**
 * Generuje obraz(y) na podstawie promptu tekstowego + opcjonalnych obrazow wejsciowych.
 * Uzywane do wirtualnej przymierzalni (modelka + ubranie) oraz czyszczenia zdjec.
 */
export async function generateImage(
  prompt: string,
  inputImages: InlineImage[],
  opts: ImageOptions,
): Promise<{ images: InlineImage[]; text: string }> {
  const body = buildImageRequestBody(prompt, inputImages, opts)
  const resParts = await callGenerate(opts.model, opts.apiKey, body, {
    timeoutMs: opts.timeoutMs ?? IMAGE_TIMEOUT_MS,
    signal: opts.signal,
    // Przekaż preferencję ponawiania timeoutu: edycja (płatna) ustawia false, by
    // timeout NIE był ponawiany — inaczej ryzyko podwójnego naliczenia generacji.
    retryTimeout: opts.retryTimeout,
  })
  const images = extractImages(resParts)
  const text = extractText(resParts)
  if (images.length === 0) {
    throw new GeminiError(
      text
        ? `Model nie wygenerował obrazu. Odpowiedź: "${text.slice(0, 240)}"`
        : 'Model nie wygenerował obrazu. Spróbuj zmienić prompt lub zdjęcia wejściowe.',
    )
  }
  return { images, text }
}

/** Szybki test poprawnosci klucza i modelu tekstowego. */
export async function testConnection(apiKey: string, model: string): Promise<string> {
  const out = await generateText('Odpowiedz jednym slowem: OK', {
    apiKey,
    model,
    temperature: 0,
    // NIE ograniczamy do kilkunastu tokenów — modele 2.5 z "thinking" zużyłyby
    // cały budżet na rozumowanie i zwróciły pusty tekst (fałszywy błąd testu).
    maxOutputTokens: 512,
  })
  return out
}
