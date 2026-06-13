import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { loadSyncToken } from '@/sync/config'

// Wczytaj lokalny token synchronizacji zanim aplikacja wystartuje, by getImageBlob/
// silnik synchronizacji od razu znaly konfiguracje.
loadSyncToken()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Rejestracja Service Workera (PWA, offline shell). Pomijamy w dev.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      /* offline niedostepny — aplikacja dalej dziala online */
    })
  })
}
