// Schowek i zapis plików na telefonie — wspólne dla edytora i „Do wystawienia”.
import { toast } from '@/state/toast'
import { downloadBlob } from './csv'

export async function copyText(text: string, done = 'Skopiowano do schowka.'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(done)
  } catch {
    toast.error('Nie udało się skopiować.')
  }
}

/**
 * Zapis plików: na telefonie natywny arkusz udostępniania („Zapisz w Zdjęciach/Plikach”) —
 * iOS Safari ignoruje <a download> na blob: URL. Na komputerze canShare zwykle daje false
 * → klasyczne pobranie. Zwraca false, gdy telefon odrzucił share (np. wygasła aktywacja
 * stuknięcia po długim pobieraniu) — wtedy drugie stuknięcie zadziała, bo bloby są już lokalnie.
 */
export async function shareOrDownload(files: File[]): Promise<boolean> {
  if (navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files })
      return true
    } catch (e) {
      // Anulowanie arkusza przez użytkownika to nie błąd.
      if (e instanceof DOMException && e.name === 'AbortError') return true
      if (e instanceof DOMException && e.name === 'NotAllowedError') return false
      // Inny błąd udostępniania → klasyczne pobranie poniżej.
    }
  }
  for (const f of files) downloadBlob(f.name, f)
  return true
}
