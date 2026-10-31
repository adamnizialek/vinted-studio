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

/** Debounce dowolnej wartosci. */
export function useDebounced<T>(value: T, delay = 300): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return v
}

/**
 * Stan trzymany w localStorage — preferencja per-urzadzenie (nie synchronizowana,
 * jak token sync). Odczyt/zapis w try/catch, bo storage bywa niedostepny (tryb
 * prywatny, brak zgody); wtedy stan zyje tylko w pamieci. `initial` jest fallbackiem.
 */
export function useLocalStorageState<T>(
  key: string,
  initial: T,
): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* storage niedostepny — zostaje w pamieci */
    }
  }, [key, value])

  return [value, setValue]
}
