// Prosty Service Worker dla powloki aplikacji (offline shell).
// Strategia: zasoby z tego samego origin — cache + odswiezanie w tle;
// zapytania do API (zewnetrzne jak Gemini ORAZ wlasne /api/*) zawsze ida przez siec.
const CACHE = 'vinted-studio-v3'
const CORE = [
  './',
  './index.html',
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
        // Offline: dla nawigacji wracamy do zcache'owanej powłoki aplikacji.
        .catch(() => cached || (request.mode === 'navigate' ? caches.match('./index.html') : undefined))
      return cached || network
    }),
  )
})
