// Bearer-token auth gate for every /api/* route. Single shared secret (SYNC_TOKEN),
// constant-time compared. Same-origin with the SPA, so no CORS handling needed.

interface Env {
  SYNC_TOKEN: string
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  if (ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i]
  return diff === 0
}

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const header = ctx.request.headers.get('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const expected = ctx.env.SYNC_TOKEN ?? ''
  if (!expected || !timingSafeEqual(token, expected)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }
  return ctx.next()
}
