// Lekki klient REST Gemini API (bez SDK — zero dodatkowych zaleznosci).
// Klucz API uzytkownika jest trzymany lokalnie i wysylany wylacznie do Google.

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
      maxOutputTokens: opts.maxOutputTokens ?? 3072,
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
  const parts: GeminiPart[] = [{ text: prompt }]
  for (const img of inputImages) {
    parts.push({ inline_data: { mime_type: img.mime, data: img.base64 } })
  }
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      temperature: opts.temperature ?? 0.9,
    },
  }
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
    maxOutputTokens: 16,
  })
  return out
}
