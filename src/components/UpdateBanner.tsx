import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { isNewBuildAvailable } from '@/lib/appUpdate'

// Nie częściej niż co tyle sprawdzamy, czy jest nowa wersja.
const CHECK_EVERY_MS = 60_000

/**
 * Pasek „Jest nowa wersja” — gdy aplikacja wraca na pierwszy plan, a na serwerze
 * jest już nowszy bundle. Nie przeładowujemy sami: w tle może trwać generowanie
 * zdjęć albo być otwarty niezapisany formularz.
 */
export function UpdateBanner() {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!import.meta.env.PROD) return
    let last = 0
    const check = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < CHECK_EVERY_MS) return
      last = Date.now()
      isNewBuildAvailable()
        .then((yes) => yes && setReady(true))
        .catch(() => {
          /* offline — spróbujemy przy następnym powrocie */
        })
    }
    // Stara strona po wdrożeniu nie doczyta leniwego chunka (np. xlsx) — stary hash
    // już nie istnieje na serwerze. Wtedy też trzeba odświeżyć.
    const chunkGone = () => setReady(true)
    check()
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    window.addEventListener('vite:preloadError', chunkGone)
    return () => {
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
      window.removeEventListener('vite:preloadError', chunkGone)
    }
  }, [])

  if (!ready) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.75rem)] z-[60] flex justify-center px-4">
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="pointer-events-auto flex items-center gap-2 rounded-full bg-brand-500 px-4 py-2 text-sm font-medium text-white shadow-pop"
      >
        <RefreshCw size={16} /> Jest nowa wersja · Odśwież
      </button>
    </div>
  )
}
