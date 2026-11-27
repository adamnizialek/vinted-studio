import { describe, it, expect } from 'vitest'
import { ownerNames, ownerToSave, people, personKey, personOf } from './accounts'

const acc = (id: string, owner?: string, bannedAt?: number) => ({ id, name: `konto-${id}`, owner, bannedAt })

describe('people', () => {
  it('groups accounts with the same owner, ignoring case and surrounding spaces', () => {
    const list = [acc('a', 'Adam'), acc('b'), acc('c', ' adam '), acc('d', 'Zosia')]
    const res = people(list)
    expect(res.map((p) => [p.name, p.named, p.accounts.map((a) => a.id)])).toEqual([
      ['Adam', true, ['a', 'c']],
      ['konto-b', false, ['b']],
      ['Zosia', true, ['d']],
    ])
  })

  it('keeps an account without an owner as its own person, as before', () => {
    expect(personKey(acc('b'))).toBe('account:b')
    expect(personKey(acc('b', '   '))).toBe('account:b')
    expect(personKey(acc('a', 'Adam'))).toBe(personKey(acc('x', 'ADAM')))
  })

  it('keeps banned accounts in their person — what they sold still counts', () => {
    const list = [acc('a', 'Adam', 1), acc('b', 'Adam')]
    expect(personOf(list, 'b')?.accounts.map((a) => a.id)).toEqual(['a', 'b'])
  })

  it('suggests each owner once, in the first spelling', () => {
    expect(ownerNames([acc('a', 'Adam'), acc('b', 'adam'), acc('c'), acc('d', 'Zosia')])).toEqual(['Adam', 'Zosia'])
  })

  it('saves an owner in the spelling other accounts already use', () => {
    const list = [acc('a', 'Adam'), acc('b')]
    expect(ownerToSave(list, 'b', '  adam ')).toBe('Adam')
    expect(ownerToSave(list, 'b', ' Ola ')).toBe('Ola')
    expect(ownerToSave(list, 'b', '   ')).toBeUndefined()
    // Sole account of a person may change its own spelling.
    expect(ownerToSave(list, 'a', 'ADAM')).toBe('ADAM')
  })
})
