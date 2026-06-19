import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  buildImageRequestBody,
  supportsImageConfig,
  buildExtractionRequestBody,
  supportsThinkingLevel,
  finishReasonError,
  generateText,
  generateImage,
  GeminiError,
} from '@/lib/gemini'

describe('supportsImageConfig', () => {
  it('is true for the Gemini 3 image family (resolution/aspectRatio knobs)', () => {
    expect(supportsImageConfig('gemini-3.1-flash-image')).toBe(true)
    expect(supportsImageConfig('gemini-3-pro-image')).toBe(true)
  })
  it('is false for the legacy 2.5 flash image model', () => {
    expect(supportsImageConfig('gemini-2.5-flash-image')).toBe(false)
  })
})

describe('buildImageRequestBody', () => {
  const img = { mime: 'image/jpeg', base64: 'AAAA' }

  it('sends imageConfig (imageSize + aspectRatio) for Gemini 3 models so 2K is actually requested', () => {
    const body = buildImageRequestBody('hello', [img], {
      apiKey: 'k',
      model: 'gemini-3.1-flash-image',
      resolution: '2K',
      aspectRatio: '3:4',
    })
    expect(body.generationConfig.responseModalities).toEqual(['TEXT', 'IMAGE'])
    expect(body.generationConfig.imageConfig).toEqual({ imageSize: '2K', aspectRatio: '3:4' })
  })

  it('omits imageConfig entirely for the legacy 2.5 model (it rejects the field)', () => {
    const body = buildImageRequestBody('hello', [img], {
      apiKey: 'k',
      model: 'gemini-2.5-flash-image',
      resolution: '2K',
      aspectRatio: '3:4',
    })
    expect('imageConfig' in body.generationConfig).toBe(false)
  })

  it('includes the prompt and each input image as ordered parts', () => {
    const body = buildImageRequestBody('hello', [img], {
      apiKey: 'k',
      model: 'gemini-3.1-flash-image',
      resolution: '2K',
    })
    expect(body.contents[0].parts[0]).toEqual({ text: 'hello' })
    expect(body.contents[0].parts[1]).toEqual({
      inline_data: { mime_type: 'image/jpeg', data: 'AAAA' },
    })
  })
})

describe('finishReasonError', () => {
  it('returns null for a normal completion', () => {
    expect(finishReasonError('STOP')).toBeNull()
    expect(finishReasonError(undefined)).toBeNull()
  })
  it('flags truncation (MAX_TOKENS) as an actionable error, not silent partial JSON', () => {
    const e = finishReasonError('MAX_TOKENS')
    expect(e).toBeInstanceOf(Error)
    expect(e?.message).toMatch(/ucięta|tokenów/i)
  })
  it('flags safety stops', () => {
    expect(finishReasonError('SAFETY')).toBeInstanceOf(Error)
    expect(finishReasonError('PROHIBITED_CONTENT')).toBeInstanceOf(Error)
  })
})

describe('supportsThinkingLevel', () => {
  it('is true for Gemini 3 (uses thinkingLevel, not thinkingBudget)', () => {
    expect(supportsThinkingLevel('gemini-3.5-flash')).toBe(true)
    expect(supportsThinkingLevel('gemini-3-pro')).toBe(true)
  })
  it('is false for Gemini 2.5 / 2.0 (uses thinkingBudget)', () => {
    expect(supportsThinkingLevel('gemini-2.5-flash')).toBe(false)
    expect(supportsThinkingLevel('gemini-2.0-flash')).toBe(false)
  })
})

describe('buildExtractionRequestBody', () => {
  const img = { mime: 'image/png', base64: 'BBBB' }
  const schema = { type: 'OBJECT', properties: {} }

  it('forces JSON output (responseMimeType + responseSchema) at temperature 0', () => {
    const body = buildExtractionRequestBody('extract', [img], {
      model: 'gemini-2.5-flash',
      responseSchema: schema,
    })
    expect(body.generationConfig.responseMimeType).toBe('application/json')
    expect(body.generationConfig.responseSchema).toEqual(schema)
    expect(body.generationConfig.temperature).toBe(0)
  })

  it('orders parts as prompt-then-images using the inline_data shape', () => {
    const body = buildExtractionRequestBody('extract', [img], { model: 'gemini-2.5-flash' })
    expect(body.contents[0].parts[0]).toEqual({ text: 'extract' })
    expect(body.contents[0].parts[1]).toEqual({
      inline_data: { mime_type: 'image/png', data: 'BBBB' },
    })
  })

  it('sends thinkingBudget:0 for Gemini 2.5 (disables thinking so JSON is not starved)', () => {
    const body = buildExtractionRequestBody('x', [img], { model: 'gemini-2.5-flash' })
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 })
  })

  it('sends thinkingLevel:low for Gemini 3 and NEVER both (mixing returns HTTP 400)', () => {
    const body = buildExtractionRequestBody('x', [img], { model: 'gemini-3.5-flash' })
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' })
    expect('thinkingBudget' in (body.generationConfig.thinkingConfig ?? {})).toBe(false)
  })

  it('OMITS thinkingConfig for models that cannot disable thinking (2.5-pro / 2.0) — avoids HTTP 400', () => {
    // gemini-2.5-pro cannot set thinkingBudget:0 (min 128); 2.0-flash has no thinking knob.
    expect('thinkingConfig' in buildExtractionRequestBody('x', [img], { model: 'gemini-2.5-pro' }).generationConfig).toBe(false)
    expect('thinkingConfig' in buildExtractionRequestBody('x', [img], { model: 'gemini-2.0-flash' }).generationConfig).toBe(false)
  })

  it('keeps a generous maxOutputTokens so thinking models leave room for the JSON', () => {
    const body = buildExtractionRequestBody('x', [img], { model: 'gemini-2.5-flash' })
    expect(body.generationConfig.maxOutputTokens).toBeGreaterThanOrEqual(2048)
  })

  it('omits responseSchema when none is given (prompt-only JSON still requested)', () => {
    const body = buildExtractionRequestBody('x', [img], { model: 'gemini-2.5-flash' })
    expect('responseSchema' in body.generationConfig).toBe(false)
    expect(body.generationConfig.responseMimeType).toBe('application/json')
  })
})

// ── Timeout / anulowanie / ponowienie ────────────────────────────────────────
// Dlaczego: surowy `fetch` bez limitu czasu potrafi wisieć w nieskończoność
// (zaobserwowane: spinner kręcił się >5 min bez błędu). `callGenerate` ma teraz
// przerywać zacięte żądanie po `timeoutMs`, raz je ponawiać przy błędach
// PRZEMIJAJĄCYCH (timeout / sieć / 5xx) i NIGDY przy anulowaniu lub błędach
// deterministycznych (4xx). Testujemy realne zachowanie przez `generateText`
// z podmienionym `fetch` (środowisko 'node' ma globalne fetch/AbortController).

function abortError(): Error {
  const e = new Error('The operation was aborted')
  e.name = 'AbortError'
  return e
}

/** Żądanie, które „wisi", dopóki jego `signal` nie zostanie przerwany. */
function hangingFetch() {
  return vi.fn((_url: string, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal | undefined
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) return reject(abortError())
      signal?.addEventListener('abort', () => reject(abortError()), { once: true })
    })
  })
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

const OK_TEXT = {
  candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }],
}

describe('callGenerate — timeout / cancel / retry (przez generateText)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('przerywa zacięte żądanie po timeoutMs i ponawia raz, zanim zgłosi błąd', async () => {
    const fetchMock = hangingFetch()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      generateText('hi', { apiKey: 'k', model: 'gemini-2.5-flash', timeoutMs: 30 }),
    ).rejects.toThrow(/limit czasu|zbyt długo|nie odpowiedział/i)

    expect(fetchMock).toHaveBeenCalledTimes(2) // oryginał + jedno ponowienie
  })

  it('NIE ponawia, gdy użytkownik anuluje (zewnętrzny AbortSignal)', async () => {
    const fetchMock = hangingFetch()
    vi.stubGlobal('fetch', fetchMock)
    const ac = new AbortController()

    const p = generateText('hi', {
      apiKey: 'k',
      model: 'gemini-2.5-flash',
      timeoutMs: 5000,
      signal: ac.signal,
    })
    ac.abort()

    await expect(p).rejects.toThrow(/anulowano/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('ponawia przemijający błąd 503 i zwraca wynik', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: { message: 'overloaded' } }))
      .mockResolvedValueOnce(jsonResponse(200, OK_TEXT))
    vi.stubGlobal('fetch', fetchMock)

    const out = await generateText('hi', { apiKey: 'k', model: 'gemini-2.5-flash' })

    expect(out).toBe('OK')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('NIE ponawia deterministycznego 400 (zły klucz API)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: { message: 'API key not valid' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      generateText('hi', { apiKey: 'k', model: 'gemini-2.5-flash' }),
    ).rejects.toThrow(/klucz API/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('zgłasza GeminiError przy przekroczeniu limitu czasu (typ błędu, nie generyczny)', async () => {
    const fetchMock = hangingFetch()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      generateText('hi', { apiKey: 'k', model: 'gemini-2.5-flash', timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(GeminiError)
  })

  it('przerywa zacięcie podczas ODCZYTU treści (nagłówki wracają, body wisi)', async () => {
    // Realny scenariusz: nagłówki 200 przychodzą szybko, ale strumień treści
    // (duży obraz base64 4K) zacina się. Limit czasu musi obejmować odczyt body.
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined
      const res = {
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(abortError()), { once: true })
          }),
      } as unknown as Response
      return Promise.resolve(res)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      generateText('hi', { apiKey: 'k', model: 'gemini-2.5-flash', timeoutMs: 30 }),
    ).rejects.toThrow(/limit czasu|nie odpowiedział/i)
    expect(fetchMock).toHaveBeenCalledTimes(2) // body-stall jest przemijający → ponowiony
  })

  it('mapuje surowy błąd sieci (TypeError „Failed to fetch") jako przemijający i ponawia', async () => {
    // Najczęstszy realny błąd klienta: brak sieci / CORS — `fetch` rzuca TypeError.
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      generateText('hi', { apiKey: 'k', model: 'gemini-2.5-flash' }),
    ).rejects.toThrow(/sieć|CORS|połączenia/i)
    expect(fetchMock).toHaveBeenCalledTimes(2) // sieć → przemijające → jedno ponowienie
  })

  it('anulowanie WYGRYWA z ponowieniem błędu przemijającego (503 przy już anulowanym sygnale)', async () => {
    // Strażnik `if (opts.signal?.aborted) throw e` jest jedynym, który tu działa:
    // błąd 503 JEST przemijający, więc bez tego strażnika pętla by ponowiła.
    const ac = new AbortController()
    const fetchMock = vi.fn(() => {
      ac.abort() // użytkownik anuluje, zanim padnie decyzja o ponowieniu
      return Promise.resolve(jsonResponse(503, { error: { message: 'overloaded' } }))
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      generateText('hi', { apiKey: 'k', model: 'gemini-2.5-flash', signal: ac.signal }),
    ).rejects.toBeInstanceOf(GeminiError)
    expect(fetchMock).toHaveBeenCalledTimes(1) // brak ponowienia mimo retryable 503
  })

  it('ścieżka OBRAZU także respektuje timeout + ponowienie (mechanizm jest podłączony)', async () => {
    const fetchMock = hangingFetch()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      generateImage('hi', [], { apiKey: 'k', model: 'gemini-3.1-flash-image', timeoutMs: 30 }),
    ).rejects.toThrow(/limit czasu|nie odpowiedział/i)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('domyślny budżet zależy od typu: obraz=120 s, tekst=60 s', async () => {
    // Stałe są prywatne; obserwujemy je przez argument setTimeout w withTimeout.
    // `fetch` zwraca od razu, więc timer jest natychmiast czyszczony (zero realnego czekania).
    const delays: number[] = []
    const realSetTimeout = setTimeout
    const spy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((fn: TimerHandler, ms?: number, ...rest: unknown[]) => {
        if (typeof ms === 'number') delays.push(ms)
        return (realSetTimeout as any)(fn, ms, ...rest)
      }) as unknown as typeof setTimeout)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, OK_TEXT)))
    try {
      await generateText('hi', { apiKey: 'k', model: 'gemini-2.5-flash' })
      // OK_TEXT nie ma obrazu → generateImage rzuci „brak obrazu", ale timer (120 s)
      // został uzbrojony PRZED fetch, więc i tak go zmierzymy.
      await generateImage('hi', [], { apiKey: 'k', model: 'gemini-3.1-flash-image' }).catch(() => {})

      expect(delays).toContain(60_000) // tekst → DEFAULT_TIMEOUT_MS
      expect(delays).toContain(120_000) // obraz → IMAGE_TIMEOUT_MS
    } finally {
      spy.mockRestore()
    }
  })
})
