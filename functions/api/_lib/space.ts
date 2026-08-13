// Wieloosobowa synchronizacja: JEDEN deployment, WIELE odizolowanych przestrzeni danych.
//
// Wcześniej `SYNC_TOKEN` był jednym wspólnym sekretem nad jednym wspólnym zbiorem danych —
// żeby dać komuś synchronizację, trzeba było oddać mu też cały swój magazyn i sprzedaże
// (albo kazać mu postawić własny projekt Cloudflare). Teraz każdy token dostaje własną
// przestrzeń: wiersze D1 i obiekty R2 są nią prefiksowane, więc dane się nie widzą.
//
// Zgodność wsteczna jest tu najważniejsza: token z `SYNC_TOKEN` dostaje przestrzeń PUSTĄ,
// czyli id bez prefiksu — dokładnie takie, jakie już leżą w bazie. Istniejące dane działają
// dalej bez migracji treści.

/** Przestrzeń właściciela deploymentu: brak prefiksu = wiersze sprzed tej zmiany. */
export const DEFAULT_SPACE = ''

export interface SpaceEnv {
  /** Token właściciela — przestrzeń domyślna (istniejące dane). */
  SYNC_TOKEN?: string
  /** Dodatkowe tokeny (oddzielone przecinkiem / średnikiem / nową linią) — każdy własna przestrzeń. */
  SYNC_TOKENS?: string
}

/** Rozbija listę tokenów z sekretu. Puste wpisy i białe znaki są odrzucane. */
export function parseTokenList(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(/[,;\n\r]+/)
    .map((t) => t.trim())
    .filter(Boolean)
}

/** Porównanie o stałym czasie (dla równych długości) — nie zdradza pozycji różnicy. */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  if (ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i]
  return diff === 0
}

/**
 * Identyfikator przestrzeni = 16 znaków szesnastkowych z SHA-256(token). Skrót, a nie sam
 * token, żeby sekret nie wyciekał do kluczy R2, logów ani komunikatów o błędach. 64 bity
 * wystarczą z ogromnym zapasem na kolizje przy garstce tokenów.
 */
export async function spaceIdForToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Wyłuskuje token z nagłówka `Authorization: Bearer …`. */
export function bearerToken(header: string | null): string {
  const h = header ?? ''
  return h.startsWith('Bearer ') ? h.slice(7) : ''
}

/**
 * Sprawdza token i zwraca jego przestrzeń, albo `null` gdy token jest nieznany.
 * Pusty token NIGDY nie przechodzi — także wtedy, gdy sekret nie został ustawiony
 * (inaczej niedokonfigurowany deployment byłby otwarty dla wszystkich).
 */
export async function resolveSpace(token: string, env: SpaceEnv): Promise<string | null> {
  if (!token) return null
  const primary = (env.SYNC_TOKEN ?? '').trim()
  if (primary && timingSafeEqual(token, primary)) return DEFAULT_SPACE
  for (const candidate of parseTokenList(env.SYNC_TOKENS)) {
    if (timingSafeEqual(token, candidate)) return await spaceIdForToken(token)
  }
  return null
}

/** Id wiersza w D1 z prefiksem przestrzeni. Przestrzeń domyślna zostawia id nietknięte. */
export function scopedRowId(space: string, id: string): string {
  return space ? `${space}:${id}` : id
}

/** Odwrotność `scopedRowId` — zdejmuje ZNANY prefiks, więc id z dwukropkiem przeżyje. */
export function unscopeRowId(space: string, rowId: string): string {
  const prefix = `${space}:`
  return space && rowId.startsWith(prefix) ? rowId.slice(prefix.length) : rowId
}

/** Klucz obiektu w R2 dla pełnego zdjęcia. */
export function blobKey(space: string, id: string): string {
  return space ? `images/${space}/${id}` : `images/${id}`
}
