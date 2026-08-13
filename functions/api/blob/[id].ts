// PUT/GET /api/blob/:id — full image binaries in R2 at key images/{id}.
// Metadata + thumbnails live in D1 (synced via /api/sync); only the heavy bytes are here.
//
// Klucz jest prefiksowany PRZESTRZENIĄ wywołującego (z tokenu, przez _middleware), więc
// dwie osoby na tym samym deploymencie nigdy nie sięgną po swoje zdjęcia — nawet gdyby
// trafiły na ten sam identyfikator obrazu.

import { blobKey, type SpaceEnv } from '../_lib/space'
import type { SyncData } from '../_middleware'

interface Env extends SpaceEnv {
  BUCKET: R2Bucket
}

export const onRequestPut: PagesFunction<Env, 'id', SyncData> = async (ctx) => {
  const id = ctx.params.id as string
  const contentType = ctx.request.headers.get('content-type') ?? 'application/octet-stream'
  await ctx.env.BUCKET.put(blobKey(ctx.data.space, id), ctx.request.body, {
    httpMetadata: { contentType },
  })
  return new Response(null, { status: 204 })
}

export const onRequestGet: PagesFunction<Env, 'id', SyncData> = async (ctx) => {
  const id = ctx.params.id as string
  const obj = await ctx.env.BUCKET.get(blobKey(ctx.data.space, id))
  if (!obj) return new Response('not found', { status: 404 })
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'cache-control': 'private, max-age=31536000, immutable',
    },
  })
}
