/**
 * Wykrywanie nowej wersji aplikacji. PWA (zwłaszcza na iPhonie) potrafi wisieć
 * w pamięci całymi dniami i nie przeładować się sama — po wdrożeniu dalej działa
 * stary bundle. Porównujemy więc zasoby (zahaszowane JS/CSS z /assets/), z którymi
 * wystartowała strona, z tymi, które serwer podaje w świeżym index.html.
 */

/** Zahaszowane zasoby z /assets/ wskazane w HTML-u (posortowane ścieżki); w dev — pusto. */
export function assetsOf(html: string): string[] {
  const paths = [...html.matchAll(/\b(?:src|href)="([^"]*\/assets\/[^"]+)"/g)].map(
    (m) => new URL(m[1], 'https://x').pathname,
  )
  return [...new Set(paths)].sort()
}

// Zrzut przy starcie modułu: <head> ma wtedy jeszcze tylko tagi z index.html
// (leniwe chunki doklejają swoje <link> później, dopiero przy imporcie).
const BOOT_ASSETS = typeof document === 'undefined' ? [] : assetsOf(document.head.innerHTML)

/** Czy serwer ma już inne zasoby niż te, na których działa strona. */
export async function isNewBuildAvailable(): Promise<boolean> {
  if (!BOOT_ASSETS.length) return false // dev (Vite) — brak zahaszowanych zasobów
  // `no-store` omija też Service Workera (sw.js przepuszcza takie zapytania do sieci).
  const res = await fetch(import.meta.env.BASE_URL, { cache: 'no-store' })
  if (!res.ok) return false
  const latest = assetsOf(await res.text())
  return latest.length > 0 && latest.join() !== BOOT_ASSETS.join()
}
