import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SPACE,
  parseTokenList,
  resolveSpace,
  spaceIdForToken,
  scopedRowId,
  unscopeRowId,
  blobKey,
  bearerToken,
} from './space'

describe('parseTokenList', () => {
  it('splits on commas, semicolons and newlines and trims', () => {
    expect(parseTokenList('a, b;c\nd')).toEqual(['a', 'b', 'c', 'd'])
  })
  it('drops empties so a stray comma cannot become a valid token', () => {
    expect(parseTokenList('a,,  ,b')).toEqual(['a', 'b'])
    expect(parseTokenList('')).toEqual([])
    expect(parseTokenList(undefined)).toEqual([])
  })
})

describe('bearerToken', () => {
  it('reads a bearer header', () => {
    expect(bearerToken('Bearer abc')).toBe('abc')
  })
  it('ignores anything else', () => {
    expect(bearerToken('Basic abc')).toBe('')
    expect(bearerToken(null)).toBe('')
  })
})

describe('resolveSpace', () => {
  const env = { SYNC_TOKEN: 'owner-secret', SYNC_TOKENS: 'friend-secret, second-friend' }

  it('gives the owner the default (unprefixed) space so existing data keeps working', async () => {
    expect(await resolveSpace('owner-secret', env)).toBe(DEFAULT_SPACE)
  })

  it('gives every extra token its own space', async () => {
    const a = await resolveSpace('friend-secret', env)
    const b = await resolveSpace('second-friend', env)
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    expect(a).not.toBe(b)
    expect(a).not.toBe(DEFAULT_SPACE)
  })

  it('rejects an unknown token', async () => {
    expect(await resolveSpace('nope', env)).toBeNull()
  })

  it('rejects an empty token even when nothing is configured', async () => {
    // Niedokonfigurowany deployment MUSI być zamknięty, a nie otwarty dla wszystkich.
    expect(await resolveSpace('', {})).toBeNull()
    expect(await resolveSpace('', { SYNC_TOKEN: '' })).toBeNull()
    expect(await resolveSpace('anything', {})).toBeNull()
  })

  it('does not leak the token into the space id', async () => {
    const space = await resolveSpace('friend-secret', env)
    expect(space).not.toContain('friend')
    expect(space).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is deterministic across calls (same token → same space)', async () => {
    expect(await spaceIdForToken('friend-secret')).toBe(await spaceIdForToken('friend-secret'))
  })

  it('keeps the owner in the default space even if his token is ALSO in SYNC_TOKENS', async () => {
    // Realna pomyłka operatora przy dodawaniu gościa. Gdyby wygrała lista gości, właściciel
    // wylądowałby w pustej przestrzeni i zobaczył aplikację bez swoich danych.
    const space = await resolveSpace('owner-secret', {
      SYNC_TOKEN: 'owner-secret',
      SYNC_TOKENS: 'owner-secret,friend-secret',
    })
    expect(space).toBe(DEFAULT_SPACE)
  })

  it('works when only SYNC_TOKENS is configured', async () => {
    expect(await resolveSpace('solo', { SYNC_TOKENS: 'solo' })).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('row and blob scoping', () => {
  it('leaves the default space untouched (backward compatible)', () => {
    expect(scopedRowId(DEFAULT_SPACE, 'abc')).toBe('abc')
    expect(blobKey(DEFAULT_SPACE, 'img1')).toBe('images/img1')
  })

  it('namespaces other spaces', () => {
    expect(scopedRowId('deadbeefdeadbeef', 'abc')).toBe('deadbeefdeadbeef:abc')
    expect(blobKey('deadbeefdeadbeef', 'img1')).toBe('images/deadbeefdeadbeef/img1')
  })

  it('round-trips ids, including ids that themselves contain a colon', () => {
    const space = 'deadbeefdeadbeef'
    for (const id of ['abc', 'a:b:c', '']) {
      expect(unscopeRowId(space, scopedRowId(space, id))).toBe(id)
      expect(unscopeRowId(DEFAULT_SPACE, scopedRowId(DEFAULT_SPACE, id))).toBe(id)
    }
  })

  it('keeps two spaces from colliding on the same client-generated id', () => {
    // Ids pochodzą od klienta (uid()), więc ta sama wartość MOŻE trafić z dwóch przestrzeni
    // (np. po zaimportowaniu cudzej kopii zapasowej) — klucz w D1 musi je rozróżnić.
    expect(scopedRowId('aaaaaaaaaaaaaaaa', 'same-id')).not.toBe(
      scopedRowId('bbbbbbbbbbbbbbbb', 'same-id'),
    )
  })
})
