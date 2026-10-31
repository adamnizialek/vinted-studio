import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8')
const tw = readFileSync(fileURLToPath(new URL('../../tailwind.config.js', import.meta.url)), 'utf8')

describe('dark mode wiring', () => {
  it('drives the ink ramp through CSS variables in Tailwind', () => {
    expect(tw).toContain('rgb(var(--ink-50) / <alpha-value>)')
    expect(tw).toContain('rgb(var(--ink-950) / <alpha-value>)')
    expect(tw).toContain('surface: ')
  })

  it('defines the light ramp on :root', () => {
    expect(css).toMatch(/--ink-50:\s*241 241 243/)
    expect(css).toMatch(/--surface:\s*255 255 255/)
    expect(css).toContain('color-scheme: light')
  })

  it('overrides the ramp and color-scheme in a prefers-color-scheme: dark block', () => {
    expect(css).toContain('@media (prefers-color-scheme: dark)')
    // The dark block flips backgrounds dark and text light, and opts native widgets in.
    const darkBlock = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'))
    expect(darkBlock).toContain('color-scheme: dark')
    expect(darkBlock).toMatch(/--ink-50:\s*18 18 20/) // canvas goes dark
    expect(darkBlock).toMatch(/--ink-900:\s*242 242 247/) // primary text goes light
    expect(darkBlock).toMatch(/--surface:\s*30 30 33/) // elevated panel
    expect(darkBlock).toMatch(/--checker:\s*44 44 48/) // transparency backdrop darkens
  })
})
