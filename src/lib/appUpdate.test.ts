import { describe, it, expect } from 'vitest'
import { assetsOf } from './appUpdate'

describe('assetsOf', () => {
  it('reads the hashed entry bundle and stylesheet from built index.html', () => {
    const html =
      '<head><script type="module" crossorigin src="./assets/index-CeGyOtDN.js"></script>' +
      '<link rel="stylesheet" crossorigin href="./assets/index-Bx1.css"><link rel="icon" href="./icons/icon.svg"></head>'
    expect(assetsOf(html)).toEqual(['/assets/index-Bx1.css', '/assets/index-CeGyOtDN.js'])
  })
  it('normalises absolute and relative refs to the same path', () => {
    expect(assetsOf('<script src="https://vinted-studio.pages.dev/assets/index-A1.js"></script>')).toEqual(
      assetsOf('<script src="./assets/index-A1.js"></script>'),
    )
  })
  it('is empty in dev, where the entry is /src/main.tsx', () => {
    expect(assetsOf('<script type="module" src="/src/main.tsx"></script>')).toEqual([])
  })
})
