// Test izolacji przestrzeni na PRAWDZIWYM SQLite (node:sqlite) z PRAWDZIWYM schematem
// z katalogu migrations/. Chodzi o niezmiennik bezpieczeństwa — „dane jednej osoby nigdy nie
// wyciekają do drugiej" — którego nie da się sprawdzić czytaniem kodu ani atrapą sklepu.
// Emulator Cloudflare (`wrangler pages dev`) trzyma lokalne D1 pod innym kluczem niż
// `wrangler d1 execute --local`, więc ręczne sprawdzanie i tak było niemiarodajne.

import { describe, it, expect, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { D1Store } from './d1Store'
import { DEFAULT_SPACE, spaceIdForToken } from './space'
import { processSync } from '../../../src/sync/protocol'

/** Minimalny adapter D1Database nad node:sqlite — tylko to, czego używa D1Store. */
function d1(db: DatabaseSync): D1Database {
  const prepare = (sql: string) => {
    let params: unknown[] = []
    const stmt = {
      bind: (...args: unknown[]) => {
        params = args
        return stmt
      },
      first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...(params as never[])) }),
      run: async () => {
        db.prepare(sql).run(...(params as never[]))
      },
      /** D1 zwraca dla batcha listę wyników w kolejności zapytań. */
      __exec: () => ({ results: db.prepare(sql).all(...(params as never[])) }),
    }
    return stmt as unknown as D1PreparedStatement
  }
  return {
    prepare,
    batch: async (stmts: unknown[]) =>
      stmts.map((s) => (s as unknown as { __exec: () => unknown }).__exec()),
  } as unknown as D1Database
}

/** Atrapa R2 — interesuje nas wyłącznie to, KTÓRE klucze są kasowane. */
function fakeBucket() {
  const deleted: string[] = []
  return { deleted, bucket: { delete: async (k: string) => void deleted.push(k) } as unknown as R2Bucket }
}

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations/', import.meta.url))

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(MIGRATIONS_DIR + f, 'utf8'))
  }
  return db
}

const push = (id: string, name: string, updatedAt: number) => ({
  cursor: 0,
  push: { products: [{ id, deleted: 0 as const, updatedAt, data: { name } }] },
})

describe('D1Store — izolacja przestrzeni', () => {
  let db: DatabaseSync
  let ownerBucket: ReturnType<typeof fakeBucket>
  let guestBucket: ReturnType<typeof fakeBucket>
  let owner: D1Store
  let guest: D1Store
  const GUEST_SPACE = 'aaaaaaaaaaaaaaaa'

  beforeEach(() => {
    db = freshDb()
    ownerBucket = fakeBucket()
    guestBucket = fakeBucket()
    owner = new D1Store(d1(db), ownerBucket.bucket, DEFAULT_SPACE)
    guest = new D1Store(d1(db), guestBucket.bucket, GUEST_SPACE)
  })

  it('nie pokazuje jednej osobie danych drugiej', async () => {
    await processSync(owner, push('prod-1', 'TAJNY produkt Adama', 1000), 1000)

    const guestPull = await processSync(guest, { cursor: 0 }, 2000)
    expect(guestPull.pull).toEqual({})

    const ownerPull = await processSync(owner, { cursor: 0 }, 3000)
    expect(ownerPull.pull.products).toHaveLength(1)
    expect((ownerPull.pull.products as { data: { name: string } }[])[0].data.name).toBe(
      'TAJNY produkt Adama',
    )
  })

  it('NIE pozwala nadpisać cudzego wiersza o tym samym id (id pochodzą od klienta)', async () => {
    await processSync(owner, push('prod-1', 'produkt Adama', 1000), 1000)
    // Nowszy `updatedAt` — gdyby wiersze dzieliły klucz, last-write-wins zjadłby wpis Adama.
    await processSync(guest, push('prod-1', 'produkt kolegi', 9999), 2000)

    const ownerRows = (await processSync(owner, { cursor: 0 }, 3000)).pull.products as {
      id: string
      data: { name: string }
    }[]
    const guestRows = (await processSync(guest, { cursor: 0 }, 4000)).pull.products as {
      id: string
      data: { name: string }
    }[]

    expect(ownerRows).toHaveLength(1)
    expect(ownerRows[0].data.name).toBe('produkt Adama')
    expect(guestRows).toHaveLength(1)
    expect(guestRows[0].data.name).toBe('produkt kolegi')
    // Klient musi zobaczyć SWOJE gołe id, bez prefiksu przestrzeni.
    expect(ownerRows[0].id).toBe('prod-1')
    expect(guestRows[0].id).toBe('prod-1')
  })

  it('trzyma wiersze właściciela BEZ prefiksu (zgodność z danymi sprzed zmiany)', async () => {
    await processSync(owner, push('prod-1', 'Adam', 1000), 1000)
    await processSync(guest, push('prod-1', 'Kolega', 1000), 2000)

    const rows = db.prepare('SELECT id, space FROM products ORDER BY space').all() as {
      id: string
      space: string
    }[]
    expect(rows).toEqual([
      { id: 'prod-1', space: '' },
      { id: `${GUEST_SPACE}:prod-1`, space: GUEST_SPACE },
    ])
  })

  it('liczy kursor osobno dla każdej przestrzeni', async () => {
    await processSync(owner, push('a', 'A', 1000), 5_000)
    // Kursor kolegi nie może „przeskoczyć" jego własnych wierszy przez cudze zapisy.
    const guestFirst = await processSync(guest, push('b', 'B', 1000), 6_000)
    const guestAgain = await processSync(guest, { cursor: guestFirst.cursor }, 7_000)
    expect(guestAgain.pull).toEqual({})

    const guestFromZero = await processSync(guest, { cursor: 0 }, 8_000)
    expect(guestFromZero.pull.products).toHaveLength(1)
  })

  it('kasuje zdjęcie tylko z własnej przestrzeni R2', async () => {
    await processSync(
      guest,
      { cursor: 0, push: { images: [{ id: 'img-1', deleted: 1, updatedAt: 1000, data: null }] } },
      1000,
    )
    expect(guestBucket.deleted).toEqual([`images/${GUEST_SPACE}/img-1`])
    expect(ownerBucket.deleted).toEqual([])

    await processSync(
      owner,
      { cursor: 0, push: { images: [{ id: 'img-1', deleted: 1, updatedAt: 1000, data: null }] } },
      2000,
    )
    expect(ownerBucket.deleted).toEqual(['images/img-1'])
  })

  it('każdy realny token dostaje inną przestrzeń niż właściciel', async () => {
    const a = await spaceIdForToken('token-kolegi')
    const b = await spaceIdForToken('token-kogos-innego')
    expect(new Set([a, b, DEFAULT_SPACE]).size).toBe(3)
  })
})
