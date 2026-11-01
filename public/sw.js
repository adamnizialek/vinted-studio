// Prosty Service Worker dla powloki aplikacji (offline shell).
// Strategia: strona (nawigacja) — najpierw siec, cache tylko offline; pozostale zasoby
// z tego samego origin (zahaszowane bundle) — cache + odswiezanie w tle;
// zapytania do API (zewnetrzne jak Gemini ORAZ wlasne /api/*) zawsze ida przez siec.
const CACHE = 'vinted-studio-v4'
// Wolna siec: po tylu ms otwieramy zcache'owana powloke zamiast czekac.
const NAV_TIMEOUT_MS = 4000
const CORE = [
  './', // powloka; './index.html' na Pages to przekierowanie 308 — nie do cache
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Cache'ujemy KAŻDY zasób osobno — pojedynczy błąd nie unieważnia całości
      // (inaczej niż atomowe addAll). Zahaszowane bundle JS/CSS dochodzą leniwie
      // przy pierwszym wejściu online (handler fetch poniżej).
      .then((c) => Promise.allSettled(CORE.map((url) => c.add(url))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return // API zewnetrzne — tylko siec
  // Wlasne API (synchronizacja + pelne obrazy z R2 pod /api/blob/{id}) to dane
  // DYNAMICZNE i uwierzytelnione — NIGDY nie przez cache powloki. Strategia
  // "cache-first" serwowala tu nieaktualna/pusta odpowiedz, przez co pelne zdjecia
  // nie doczytywaly sie z R2 (widoczne jako rozmyty kwadrat). Zawsze prosto do sieci.
  if (url.pathname.startsWith('/api/')) return
  // Sprawdzenie nowej wersji (appUpdate.ts) pyta serwer z pominieciem cache.
  if (request.cache === 'no-store') return

  // Nawigacja: najpierw siec. Przy "cache + odswiezanie w tle" pierwsze otwarcie po
  // wdrozeniu pokazywalo POPRZEDNIA wersje (stary index.html -> stary bundle).
  if (request.mode === 'navigate') {
    const network = fetch(request)
    // Zapis świeżej powłoki trwa dłużej niż odpowiedź (np. gdy wygrał timeout) —
    // waitUntil nie pozwala przeglądarce uśpić SW w połowie.
    event.waitUntil(
      network
        .then((res) => {
          if (res.status !== 200 || res.type !== 'basic' || res.redirected) return
          const copy = res.clone() // od razu — zanim odpowiedź przeczyta przeglądarka
          return caches.open(CACHE).then((c) => c.put('./', copy))
        })
        .catch(() => {}),
    )
    event.respondWith(
      caches.match('./').then((cached) => {
        if (!cached) return network
        const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), NAV_TIMEOUT_MS))
        // Strona błędu (5xx) z sieci przegrywa z działającą powłoką z cache.
        const fresh = network.then(
          (res) => (res.ok || res.type === 'opaqueredirect' ? res : cached),
          () => cached,
        )
        return Promise.race([fresh, timeout])
      }),
    )
    return
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(request, copy))
          }
          return res
        })
        .catch(() => cached)
      return cached || network
    }),
  )
})
