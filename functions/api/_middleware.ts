// Bramka autoryzacji dla każdej trasy /api/*. Token bearer jest porównywany w stałym czasie
// z listą dozwolonych sekretów i zamieniany na PRZESTRZEŃ DANYCH, którą trasy niżej dostają
// w `ctx.data.space`. Dzięki temu jeden deployment obsługuje wiele osób, a ich dane się nie
// widzą — bez zakładania osobnego projektu Cloudflare dla każdej z nich.
//
// `SYNC_TOKEN`  → przestrzeń domyślna (dane sprzed tej zmiany, bez prefiksu).
// `SYNC_TOKENS` → lista dodatkowych tokenów, każdy z własną, odizolowaną przestrzenią.
// Ta sama strona (SPA), więc CORS nie jest potrzebny.

import { bearerToken, resolveSpace, type SpaceEnv } from './_lib/space'

export interface SyncData extends Record<string, unknown> {
  /** Przestrzeń danych wywołującego — '' dla właściciela deploymentu. */
  space: string
}

export const onRequest: PagesFunction<SpaceEnv, string, SyncData> = async (ctx) => {
  const space = await resolveSpace(bearerToken(ctx.request.headers.get('Authorization')), ctx.env)
  if (space === null) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }
  ctx.data.space = space
  return ctx.next()
}
