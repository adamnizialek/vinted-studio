// Device-local sync configuration. The bearer token is stored in localStorage (never
// synced, like the Gemini key) and turned into a RemoteClient. When no token is set,
// sync is disabled and the app runs purely on local Dexie.

import { httpRemote, type RemoteClient } from './remote'

const TOKEN_KEY = 'vinted-studio-sync-token'

let token: string | null = null
let remote: RemoteClient | null = null

function rebuild() {
  remote = token ? httpRemote({ token }) : null
}

/** Load the persisted token at app start. */
export function loadSyncToken(): void {
  try {
    token = localStorage.getItem(TOKEN_KEY)
  } catch {
    token = null
  }
  rebuild()
}

export function setSyncToken(value: string | null): void {
  const trimmed = value?.trim()
  token = trimmed ? trimmed : null
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* storage unavailable — keep in-memory only */
  }
  rebuild()
}

export function getSyncToken(): string | null {
  return token
}

export function syncEnabled(): boolean {
  return remote !== null
}

export function currentRemote(): RemoteClient | null {
  return remote
}
