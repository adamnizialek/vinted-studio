import { useEffect, useState } from 'react'
import { db } from '@/db/db'

/**
 * Zwraca objectURL dla pelnego bloba obrazu (po id). Sam zwalnia URL przy zmianie/odmontowaniu.
 * Do list uzywaj raczej `rec.thumb` (data URL) — taniej.
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

    db.images.get(imageId).then((rec) => {
      if (revoked || !rec) return
      current = URL.createObjectURL(rec.blob)
      setUrl(current)
    })

    return () => {
      revoked = true
      if (current) URL.revokeObjectURL(current)
    }
  }, [imageId])

  return url
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
