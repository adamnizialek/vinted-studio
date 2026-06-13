// PUT/GET /api/blob/:id — full image binaries in R2 at key images/{id}.
// Metadata + thumbnails live in D1 (synced via /api/sync); only the heavy bytes are here.

interface Env {
  BUCKET: R2Bucket
  SYNC_TOKEN: string
}

export const onRequestPut: PagesFunction<Env> = async (ctx) => {
  const id = ctx.params.id as string
  const contentType = ctx.request.headers.get('content-type') ?? 'application/octet-stream'
  await ctx.env.BUCKET.put(`images/${id}`, ctx.request.body, {
    httpMetadata: { contentType },
  })
  return new Response(null, { status: 204 })
}

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const id = ctx.params.id as string
  const obj = await ctx.env.BUCKET.get(`images/${id}`)
  if (!obj) return new Response('not found', { status: 404 })
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'cache-control': 'private, max-age=31536000, immutable',
    },
  })
}
