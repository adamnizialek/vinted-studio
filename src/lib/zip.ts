// Minimalny zapis archiwum ZIP metoda STORE (bez kompresji). Wejscia w tej
// aplikacji to gotowe JPEG/PNG (praktycznie nieskompresowalne), wiec DEFLATE nic
// by nie dal poza marnowaniem CPU — STORE kopiuje bajty 1:1 (bezstratnie, pelna
// rozdzielczosc) i liczy jedynie CRC-32. Czysty modul (TextEncoder/Uint8Array/
// DataView) — dziala w przegladarce i w tescie (node), bez zaleznosci.
//
// Format: lokalne naglowki + dane, central directory, End Of Central Directory.
// Bez ZIP64 — pola sa 32-bitowe; `assertZipFits` pilnuje limitow (patrz nizej).

export interface ZipEntry {
  /** Sciezka w archiwum (separator '/'; tworzy katalogi). Kodowana jako UTF-8. */
  name: string
  data: Uint8Array
}

/** Rzucany, gdy archiwum przekroczyloby 32-bitowe limity formatu (brak ZIP64). */
export class ZipTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipTooLargeError'
  }
}

/** Maks. liczba wpisow (pole uint16 w EOCD). */
export const ZIP_MAX_ENTRIES = 0xffff
/** Maks. rozmiar (pola offsetow/rozmiarow sa uint32). */
export const ZIP_MAX_BYTES = 0xffffffff

/** Pilnuje, by archiwum miescilo sie w 32-bitowych polach (bez ZIP64). */
export function assertZipFits(count: number, totalBytes: number): void {
  if (count > ZIP_MAX_ENTRIES)
    throw new ZipTooLargeError(`Za dużo plików w archiwum (${count} > ${ZIP_MAX_ENTRIES}).`)
  if (totalBytes > ZIP_MAX_BYTES)
    throw new ZipTooLargeError(`Archiwum przekracza 4 GB — pobierz mniejszą porcję.`)
}

// ---------------------------------------------------------------------------
// CRC-32 (IEEE 802.3): odbity wielomian 0xEDB88320, init/final XOR 0xFFFFFFFF.
// ---------------------------------------------------------------------------
let CRC_TABLE: Uint32Array | null = null

function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  CRC_TABLE = t
  return t
}

export function crc32(bytes: Uint8Array): number {
  const t = crcTable()
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------------------
// Budowa archiwum
// ---------------------------------------------------------------------------
// Stala data DOS (1980-01-01 00:00) — deterministyczne wyjscie (powtarzalne testy).
const DOS_TIME = 0
const DOS_DATE = 0x21
const UTF8_FLAG = 0x0800 // bit 11 — nazwy plikow w UTF-8
const VERSION = 20 // 2.0
const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const NAME_ENCODER = new TextEncoder()

/** Wpis znormalizowany: CRC i rozmiar policzone z gory, dane jako gotowy chunk. */
interface NormalizedEntry {
  nameBytes: Uint8Array
  crc: number
  size: number
  /** Dane pliku — Uint8Array (w pamieci) lub Blob (na dysku, bez kopiowania do RAM). */
  data: Uint8Array | Blob
}

/**
 * Skleja znormalizowane wpisy w liste fragmentow archiwum: lokalne naglowki +
 * dane (przez referencje), central directory, EOCD. Danych NIE kopiujemy — gdy
 * sa Blobem, przegladarka trzyma je na dysku, wiec finalny Blob ich nie wciaga
 * do pamieci. Wszystkie pola little-endian.
 */
function assembleChunks(entries: NormalizedEntry[]): (Uint8Array | Blob)[] {
  const totalData = entries.reduce((s, e) => s + e.size, 0)
  assertZipFits(entries.length, totalData)

  const chunks: (Uint8Array | Blob)[] = []
  const central: { nameBytes: Uint8Array; crc: number; size: number; offset: number }[] = []
  let offset = 0

  for (const { nameBytes, crc, size, data } of entries) {
    const header = new Uint8Array(30 + nameBytes.length)
    const dv = new DataView(header.buffer)
    dv.setUint32(0, SIG_LOCAL, true)
    dv.setUint16(4, VERSION, true)
    dv.setUint16(6, UTF8_FLAG, true)
    dv.setUint16(8, 0, true) // metoda: STORE
    dv.setUint16(10, DOS_TIME, true)
    dv.setUint16(12, DOS_DATE, true)
    dv.setUint32(14, crc, true)
    dv.setUint32(18, size, true) // compressed
    dv.setUint32(22, size, true) // uncompressed
    dv.setUint16(26, nameBytes.length, true)
    dv.setUint16(28, 0, true) // extra len
    header.set(nameBytes, 30)

    central.push({ nameBytes, crc, size, offset })
    chunks.push(header, data)
    offset += header.length + size
  }

  const cdStart = offset
  for (const c of central) {
    const header = new Uint8Array(46 + c.nameBytes.length)
    const dv = new DataView(header.buffer)
    dv.setUint32(0, SIG_CENTRAL, true)
    dv.setUint16(4, VERSION, true) // version made by
    dv.setUint16(6, VERSION, true) // version needed
    dv.setUint16(8, UTF8_FLAG, true)
    dv.setUint16(10, 0, true) // metoda: STORE
    dv.setUint16(12, DOS_TIME, true)
    dv.setUint16(14, DOS_DATE, true)
    dv.setUint32(16, c.crc, true)
    dv.setUint32(20, c.size, true)
    dv.setUint32(24, c.size, true)
    dv.setUint16(28, c.nameBytes.length, true)
    dv.setUint16(30, 0, true) // extra len
    dv.setUint16(32, 0, true) // comment len
    dv.setUint16(34, 0, true) // disk number start
    dv.setUint16(36, 0, true) // internal attrs
    dv.setUint32(38, 0, true) // external attrs
    dv.setUint32(42, c.offset, true) // offset lokalnego naglowka
    header.set(c.nameBytes, 46)
    chunks.push(header)
    offset += header.length
  }
  const cdSize = offset - cdStart
  // Precyzyjny limit: offset central directory musi zmiescic sie w uint32 (bez ZIP64).
  // (Naglowki nieco powiekszaja archiwum ponad sumę danych sprawdzaną wyżej.)
  if (cdStart > ZIP_MAX_BYTES) throw new ZipTooLargeError('Archiwum przekracza 4 GB.')

  const eocd = new Uint8Array(22)
  const dv = new DataView(eocd.buffer)
  dv.setUint32(0, SIG_EOCD, true)
  dv.setUint16(4, 0, true) // numer dysku
  dv.setUint16(6, 0, true) // dysk z central dir
  dv.setUint16(8, entries.length, true) // wpisy na tym dysku
  dv.setUint16(10, entries.length, true) // wpisy razem
  dv.setUint32(12, cdSize, true)
  dv.setUint32(16, cdStart, true)
  dv.setUint16(20, 0, true) // dlugosc komentarza
  chunks.push(eocd)

  return chunks
}

const fromBytes = (e: ZipEntry): NormalizedEntry => ({
  nameBytes: NAME_ENCODER.encode(e.name),
  crc: crc32(e.data),
  size: e.data.length,
  data: e.data,
})

/** Skleja archiwum w jeden bufor (uzyteczne w testach; sciezka synchroniczna). */
export function zipBytes(entries: ZipEntry[]): Uint8Array {
  const chunks = assembleChunks(entries.map(fromBytes)) as Uint8Array[]
  const total = chunks.reduce((s, c) => s + c.length, 0)
  const out = new Uint8Array(total)
  let p = 0
  for (const c of chunks) {
    out.set(c, p)
    p += c.length
  }
  return out
}

export interface ZipBlobEntry {
  name: string
  blob: Blob
}

/**
 * Buduje archiwum ZIP z Blobow BEZ trzymania wszystkich bajtow w pamieci naraz:
 * kazdy blob czytamy raz (przejsciowo) tylko po to, by policzyc CRC i rozmiar, a
 * do archiwum wstawiamy sam Blob (dysk). Szczytowe zuzycie pamieci ~ jeden obraz,
 * nie cala galeria — kluczowe przy „pobierz wszystkie" w pelnej rozdzielczosci.
 */
export async function createZipFromBlobs(entries: ZipBlobEntry[]): Promise<Blob> {
  const normalized: NormalizedEntry[] = []
  for (const entry of entries) {
    const bytes = new Uint8Array(await entry.blob.arrayBuffer()) // przejsciowo, tylko do CRC
    normalized.push({
      nameBytes: NAME_ENCODER.encode(entry.name),
      crc: crc32(bytes),
      size: entry.blob.size,
      data: entry.blob, // referencja na Blob (dysk), nie kopia bajtow
    })
  }
  return new Blob(assembleChunks(normalized) as BlobPart[], { type: 'application/zip' })
}
