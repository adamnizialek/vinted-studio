// Map a local entity to the opaque `data` payload pushed to the server.
// Two fields never leave the device: the image `blob` (goes to R2 separately) and
// the `geminiApiKey` (device-local secret).

import type { SyncTable } from './core'

export function stripForPush(
  table: SyncTable,
  rec: Record<string, unknown>,
): Record<string, unknown> {
  if (table === 'images') {
    const { blob: _blob, ...rest } = rec
    return rest
  }
  if (table === 'settings') {
    const { geminiApiKey: _key, ...rest } = rec
    return rest
  }
  return rec
}
