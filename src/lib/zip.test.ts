import { describe, it, expect } from 'vitest'
import { crc32, zipBytes, createZipFromBlobs, assertZipFits, ZipTooLargeError } from './zip'

const enc = (s: string) => new TextEncoder().encode(s)

// ---------------------------------------------------------------------------
// Minimaly parser ZIP (tylko metoda STORE) — odczytuje archiwum z powrotem,
// by zweryfikowac round-trip. Czyta End Of Central Directory -> Central Directory
// -> Local File Headers i wyciaga zapisane bajty.
// ---------------------------------------------------------------------------
interface ParsedEntry {
  name: string
  data: Uint8Array
  crc: number
  method: number
}

function parseZip(bytes: Uint8Array): ParsedEntry[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // EOCD: brak komentarza -> ostatnie 22 bajty.
  const eocd = bytes.length - 22
  if (dv.getUint32(eocd, true) !== 0x06054b50) throw new Error('zly podpis EOCD')
  const total = dv.getUint16(eocd + 10, true)
  const cdOffset = dv.getUint32(eocd + 16, true)

  const entries: ParsedEntry[] = []
  let p = cdOffset
  for (let i = 0; i < total; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('zly podpis naglowka centralnego')
    const method = dv.getUint16(p + 10, true)
    const crc = dv.getUint32(p + 16, true)
    const compSize = dv.getUint32(p + 20, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const localOffset = dv.getUint32(p + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen))

    // Local file header -> dane.
    if (dv.getUint32(localOffset, true) !== 0x04034b50) throw new Error('zly podpis naglowka lokalnego')
    const lNameLen = dv.getUint16(localOffset + 26, true)
    const lExtraLen = dv.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    const data = bytes.subarray(dataStart, dataStart + compSize)

    entries.push({ name, data: new Uint8Array(data), crc, method })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

describe('crc32', () => {
  it('matches canonical IEEE 802.3 test vectors', () => {
    expect(crc32(enc('')) >>> 0).toBe(0x00000000)
    expect(crc32(enc('a')) >>> 0).toBe(0xe8b7be43)
    expect(crc32(enc('abc')) >>> 0).toBe(0x352441c2)
    expect(crc32(enc('123456789')) >>> 0).toBe(0xcbf43926)
    expect(crc32(enc('The quick brown fox jumps over the lazy dog')) >>> 0).toBe(0x414fa339)
  })

  it('handles all byte values 0..255', () => {
    const all = new Uint8Array(256)
    for (let i = 0; i < 256; i++) all[i] = i
    // Znana wartosc CRC32 dla bajtow 0x00..0xFF.
    expect(crc32(all) >>> 0).toBe(0x29058c73)
  })
})

describe('zipBytes (store-only archive)', () => {
  it('produces a valid empty archive (EOCD only) for no entries', () => {
    const bytes = zipBytes([])
    expect(bytes.length).toBe(22)
    const dv = new DataView(bytes.buffer)
    expect(dv.getUint32(0, true)).toBe(0x06054b50)
    expect(parseZip(bytes)).toEqual([])
  })

  it('round-trips a single entry with correct name, bytes and CRC', () => {
    const data = enc('hello world')
    const out = parseZip(zipBytes([{ name: 'a.txt', data }]))
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('a.txt')
    expect(out[0].method).toBe(0) // STORE
    expect(Array.from(out[0].data)).toEqual(Array.from(data))
    expect(out[0].crc >>> 0).toBe(crc32(data) >>> 0)
  })

  it('round-trips multiple entries preserving order, names and offsets', () => {
    const entries = [
      { name: 'folder/01.jpg', data: enc('first') },
      { name: 'folder/02.jpg', data: new Uint8Array([0, 1, 2, 255, 254, 128]) },
      { name: 'folder/03.png', data: enc('') }, // pusty plik
    ]
    const out = parseZip(zipBytes(entries))
    expect(out.map((e) => e.name)).toEqual(['folder/01.jpg', 'folder/02.jpg', 'folder/03.png'])
    expect(Array.from(out[1].data)).toEqual([0, 1, 2, 255, 254, 128])
    expect(out[2].data.length).toBe(0)
    for (const e of out) expect(e.method).toBe(0)
  })

  it('round-trips UTF-8 (Polish) filenames', () => {
    const name = 'modelka-zażółć/ąęś.jpg'
    const out = parseZip(zipBytes([{ name, data: enc('x') }]))
    expect(out[0].name).toBe(name)
  })

  it('round-trips binary data covering all 256 byte values', () => {
    const data = new Uint8Array(256)
    for (let i = 0; i < 256; i++) data[i] = i
    const out = parseZip(zipBytes([{ name: 'bin', data }]))
    expect(Array.from(out[0].data)).toEqual(Array.from(data))
    expect(out[0].crc >>> 0).toBe(crc32(data) >>> 0)
  })
})

describe('createZipFromBlobs (memory-flat: data chunks stay Blobs)', () => {
  it('round-trips blob entries with correct names, bytes and CRC', async () => {
    const bin = new Uint8Array(256)
    for (let i = 0; i < 256; i++) bin[i] = i
    const blob = await createZipFromBlobs([
      { name: 'ania/01.png', blob: new Blob([bin], { type: 'image/png' }) },
      { name: 'ania/02.txt', blob: new Blob([enc('hello blob')], { type: 'text/plain' }) },
    ])
    expect(blob.type).toBe('application/zip')
    const out = parseZip(new Uint8Array(await blob.arrayBuffer()))
    expect(out.map((e) => e.name)).toEqual(['ania/01.png', 'ania/02.txt'])
    expect(out[0].method).toBe(0)
    expect(Array.from(out[0].data)).toEqual(Array.from(bin))
    expect(out[0].crc >>> 0).toBe(crc32(bin) >>> 0)
    expect(new TextDecoder().decode(out[1].data)).toBe('hello blob')
  })

  it('produces an archive byte-identical to the Uint8Array path', async () => {
    const a = enc('first')
    const b = new Uint8Array([0, 1, 2, 255, 254, 128])
    const fromBytes = zipBytes([
      { name: 'x/01.jpg', data: a },
      { name: 'x/02.jpg', data: b },
    ])
    const fromBlobs = new Uint8Array(
      await (
        await createZipFromBlobs([
          { name: 'x/01.jpg', blob: new Blob([a]) },
          { name: 'x/02.jpg', blob: new Blob([b]) },
        ])
      ).arrayBuffer(),
    )
    expect(Array.from(fromBlobs)).toEqual(Array.from(fromBytes))
  })
})

describe('assertZipFits (ZIP64 guard)', () => {
  it('accepts realistic sizes', () => {
    expect(() => assertZipFits(500, 2_000_000_000)).not.toThrow()
  })

  it('throws ZipTooLargeError above 65535 entries', () => {
    expect(() => assertZipFits(65536, 0)).toThrow(ZipTooLargeError)
  })

  it('throws ZipTooLargeError when total bytes exceed 4 GB', () => {
    expect(() => assertZipFits(1, 0x1_0000_0000)).toThrow(ZipTooLargeError)
  })
})
