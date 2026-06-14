import { describe, it, expect } from 'vitest'
import {
  buildImageRequestBody,
  supportsImageConfig,
  buildExtractionRequestBody,
  supportsThinkingLevel,
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
