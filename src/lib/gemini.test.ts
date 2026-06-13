import { describe, it, expect } from 'vitest'
import { buildImageRequestBody, supportsImageConfig } from '@/lib/gemini'

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
