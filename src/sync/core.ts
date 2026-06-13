// Pure sync primitives shared by the server (Pages Function) and the client engine.
// No DOM, no Cloudflare, no Dexie — just the last-write-wins + stamp rules, so both
// sides agree and the logic is unit-testable in isolation.

/** The synced entity tables (mirror of the Dexie/D1 schema). */
export const SYNC_TABLES = [
  'products',
  'models',
  'accounts',
  'sales',
  'expenses',
  'images',
  'settings',
] as const

export type SyncTable = (typeof SYNC_TABLES)[number]

/** A row as pushed by a client / applied on either side. */
export interface SyncRow {
  id: string
  /** 0/1 tombstone flag. */
  deleted: 0 | 1
  /** Client content edit time (ms) — the LWW comparison key. */
  updatedAt: number
  /** Opaque entity payload (entity JSON minus blob; settings minus the API key). */
  data: unknown
}

/**
 * Last-write-wins decision. Accept the incoming write iff there is no stored row,
 * or it is strictly newer than what we have. Ties keep the existing row so the
 * outcome is deterministic regardless of arrival order.
 */
export function lwwAccepts(
  incomingUpdatedAt: number,
  storedUpdatedAt: number | null | undefined,
): boolean {
  if (storedUpdatedAt == null) return true
  return incomingUpdatedAt > storedUpdatedAt
}

/**
 * Server sync-stamp generator: strictly increasing and collision-free even when the
 * wall clock is behind or two writes land in the same millisecond. Drives the pull
 * cursor (exclusive lower bound), so monotonicity guarantees no row is ever skipped.
 */
export function nextStamp(currentMaxStamp: number, now: number): number {
  return Math.max(currentMaxStamp + 1, now)
}
