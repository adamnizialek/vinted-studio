import { useEffect, useState } from 'react'
import { getImageBlob } from '@/lib/images'

/**
 * Zwraca objectURL dla pelnego bloba obrazu (po id). Sam zwalnia URL przy zmianie/odmontowaniu.
 * Do list uzywaj raczej `rec.thumb` (data URL) — taniej.
 * Blob pobierany jest przez getImageBlob, ktore (po wlaczeniu synchronizacji) doczytuje go
 * leniwie z R2, jesli nie ma go lokalnie.
 */
export function useObjectUrl(imageId?: string): string | undefined {
  const [url, setUrl] = useState<string>()

  useEffect(() => {
    let revoked = false
    let current: string | undefined

    if (!imageId) {
      setUrl(undefined)
      return
    }

    getImageBlob(imageId).then((blob) => {
      if (revoked || !blob) return
      current = URL.createObjectURL(blob)
      setUrl(current)
    })

    return () => {
      revoked = true
      if (current) URL.revokeObjectURL(current)
    }
  }, [imageId])

  return url
}

/** Kolory dla wykresu (Recharts), wyliczone ze zmiennych CSS motywu. */
export interface ChartColors {
  grid: string
  axis: string
  cursor: string
  tooltipBg: string
  tooltipBorder: string
  tooltipText: string
  /** Kolor slupkow — staly brand-500 (czytelny na obu motywach). */
  bar: string
}

function cssColor(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v ? `rgb(${v})` : fallback
}

function readChartColors(): ChartColors {
  return {
    grid: cssColor('--ink-100', '#eceef2'),
    axis: cssColor('--ink-400', '#8290a5'),
    cursor: cssColor('--ink-100', '#f6f7f9'),
    tooltipBg: cssColor('--surface', '#ffffff'),
    tooltipBorder: cssColor('--ink-200', '#eceef2'),
    tooltipText: cssColor('--ink-900', '#1f242e'),
    bar: '#0b9b82',
  }
}

/**
 * Zwraca kolory wykresu zsynchronizowane z aktualnym motywem systemowym.
 * Recharts przyjmuje kolory jako stringi (nie klasy), wiec czytamy je ze
 * zmiennych CSS i przeliczamy ponownie przy zmianie prefers-color-scheme.
 */
export function useChartColors(): ChartColors {
  const [colors, setColors] = useState<ChartColors>(readChartColors)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setColors(readChartColors())
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return colors
}

/** Debounce dowolnej wartosci. */
export function useDebounced<T>(value: T, delay = 300): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return v
}
