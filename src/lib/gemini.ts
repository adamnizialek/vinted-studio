// Lekki klient REST Gemini API (bez SDK — zero dodatkowych zaleznosci).
// Klucz API uzytkownika jest trzymany lokalnie i wysylany wylacznie do Google.

import type { ImageResolution } from '@/db/types'

const BASE = 'https://generativelanguage.googleapis.com/v1beta'

export class GeminiError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'GeminiError'
    this.status = status
  }
}

export interface InlineImage {
  mime: string
  /** Dane base64 bez prefiksu data URL. */
  base64: string
}

interface GeminiPart {
  text?: string
  inline_data?: { mime_type: string; data: string }
  inlineData?: { mimeType: string; data: string }
}

async function callGenerate(
  model: string,
  apiKey: string,
  body: unknown,
): Promise<GeminiPart[]> {
  if (!apiKey) throw new GeminiError('Brak klucza API Gemini. Dodaj go w Ustawieniach.')

  let res: Response
  try {
    res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
    })
  } catch (e) {
    throw new GeminiError(
      'Brak połączenia z Gemini API (sieć lub CORS). Sprawdź internet i spróbuj ponownie.',
    )
  }

  const json = await res.json().catch(() => null)

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
    throw new GeminiError(msg, res.status)
  }

  const candidate = (json as any)?.candidates?.[0]
  const blockReason = (json as any)?.promptFeedback?.blockReason
  if (blockReason)
    throw new GeminiError(
      `Treść zablokowana przez filtry bezpieczeństwa (${blockReason}). Zmień zdjęcie/opis i spróbuj ponownie.`,
    )
  if (!candidate)
    throw new GeminiError('Gemini nie zwróciło żadnej odpowiedzi. Spróbuj ponownie.')

  const finish = candidate.finishReason
  if (finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT')
    throw new GeminiError(
      'Odpowiedź zatrzymana przez filtry bezpieczeństwa. Zmień dane wejściowe.',
    )

  return (candidate.content?.parts ?? []) as GeminiPart[]
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

export interface TextOptions {
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
  const parts = await callGenerate(opts.model, opts.apiKey, body)
  const text = extractText(parts)
  if (!text)
    throw new GeminiError('Model nie zwrócił tekstu (możliwy limit tokenów). Spróbuj ponownie.')
  return text
}

export interface ImageOptions {
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
  const parts: GeminiPart[] = [{ text: prompt }]
  for (const img of inputImages) {
    parts.push({ inline_data: { mime_type: img.mime, data: img.base64 } })
  }

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

export interface ExtractionOptions {
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
  const parts: GeminiPart[] = [{ text: prompt }]
  for (const img of images) {
    parts.push({ inline_data: { mime_type: img.mime, data: img.base64 } })
  }

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
  const parts = await callGenerate(opts.model, opts.apiKey, body)
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
  const resParts = await callGenerate(opts.model, opts.apiKey, body)
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
