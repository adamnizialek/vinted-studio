// POST /api/sync — push (last-write-wins) + pull in one round trip, backed by D1.
// The decision logic lives in src/sync/protocol.ts (unit-tested with an in-memory store);
// this file is just the D1/R2 adapter.

import { processSync, type SyncRequest } from '../../src/sync/protocol'
import { D1Store } from './_lib/d1Store'
import type { SpaceEnv } from './_lib/space'
import type { SyncData } from './_middleware'

interface Env extends SpaceEnv {
  DB: D1Database
  BUCKET: R2Bucket
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export const onRequestPost: PagesFunction<Env, string, SyncData> = async (ctx) => {
  let req: SyncRequest
  try {
    req = (await ctx.request.json()) as SyncRequest
  } catch {
    return json({ error: 'invalid json' }, 400)
  }
  if (typeof req?.cursor !== 'number') return json({ error: 'missing cursor' }, 400)

  // `space` pochodzi WYŁĄCZNIE z tokenu sprawdzonego w _middleware — nigdy z treści żądania.
  const store = new D1Store(ctx.env.DB, ctx.env.BUCKET, ctx.data.space)
  const res = await processSync(store, req, Date.now())
  return json(res)
}
