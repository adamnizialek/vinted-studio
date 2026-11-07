#!/usr/bin/env node
// Szkice ogłoszeń z linii poleceń — dla Listera (Claude), który pisze ogłoszenia ze zdjęć.
// Czyta magazyn Vinted Studio przez /api/sync i zapisuje szkic (tytuł, opis, cena) do modelu,
// skąd aplikacja pokazuje go w „Do wystawienia”. Zdjęcia AI generuje aplikacja (klucz Gemini
// jest tylko na urządzeniu). Z Vinted nic się tu nie łączy: wystawia właściciel ręcznie.
//
// Uruchomienie (Node 22.18+/24, bez kompilacji):
//   node scripts/drafts.ts list [--incoming] [--json]
//   node scripts/drafts.ts photos <key> [--out <dir>]
//   node scripts/drafts.ts show <key>
//   node scripts/drafts.ts put <key> --json <plik.json|-> [--dry-run]
//
// Token: VINTED_STUDIO_TOKEN, plik ~/.vinted-studio/token, albo (na tym komputerze) z Chrome,
// gdzie zapisała go aplikacja. Adres: VINTED_STUDIO_URL (domyślnie produkcja).

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import type { Design, ListingDraft, Product, Sale } from '../src/db/types.ts'
import { draftQueue, pasteBlock, suggestDraftPrice, unitSizes, type DraftQueueItem } from '../src/lib/listingDraft.ts'

const BASE = (process.env.VINTED_STUDIO_URL ?? 'https://vinted-studio.pages.dev').replace(/\/$/, '')

function fail(msg: string): never {
  console.error(`drafts: ${msg}`)
  process.exit(1)
}

function chromeLocalStorageDirs(): string[] {
  const home = homedir()
  const roots =
    platform() === 'win32'
      ? [join(home, 'AppData/Local/Google/Chrome/User Data')]
      : platform() === 'darwin'
        ? [join(home, 'Library/Application Support/Google/Chrome')]
        : [join(home, '.config/google-chrome')]
  const out: string[] = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const profile of readdirSync(root)) {
      const dir = join(root, profile, 'Local Storage/leveldb')
      if (existsSync(dir)) out.push(dir)
    }
  }
  return out
}

/**
 * Kandydaci na token z localStorage Chrome (klucz `vinted-studio-sync-token`, 64 znaki),
 * od najnowszego pliku; wpisy z originem produkcji przed innymi (np. lokalnym dev serwerem).
 */
function chromeTokenCandidates(): string[] {
  const key = Buffer.from('vinted-studio-sync-token')
  const host = new URL(BASE).host
  const found: { token: string; mtime: number; origin: boolean }[] = []
  for (const dir of chromeLocalStorageDirs()) {
    for (const f of readdirSync(dir)) {
      if (!/\.(ldb|log)$/.test(f)) continue
      const path = join(dir, f)
      let buf: Buffer
      try {
        buf = readFileSync(path)
      } catch {
        continue // plik zablokowany przez działającego Chrome
      }
      const mtime = statSync(path).mtimeMs
      for (let i = buf.indexOf(key); i >= 0; i = buf.indexOf(key, i + 1)) {
        const m = /[A-Za-z0-9_-]{64}/.exec(buf.subarray(i + key.length, i + key.length + 120).toString('latin1'))
        const origin = buf.subarray(Math.max(0, i - 80), i).toString('latin1').includes(host)
        if (m) found.push({ token: m[0], mtime, origin })
      }
    }
  }
  found.sort((a, b) => Number(b.origin) - Number(a.origin) || b.mtime - a.mtime)
  return [...new Set(found.map((c) => c.token))]
}

/** Czy serwer przyjmuje token (pusty sync z kursorem „na końcu” — prawie zerowa odpowiedź). */
async function accepted(t: string): Promise<boolean> {
  const res = await fetch(`${BASE}/api/sync`, {
    method: 'POST',
    headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
    body: JSON.stringify({ cursor: Number.MAX_SAFE_INTEGER }),
  })
  return res.ok
}

let cachedToken: string | undefined

/** Token ustalany RAZ na uruchomienie (czytanie Chrome jest kosztowne). */
async function token(): Promise<string> {
  if (cachedToken) return cachedToken
  const fromEnv = process.env.VINTED_STUDIO_TOKEN?.trim()
  const file = join(homedir(), '.vinted-studio', 'token')
  if (fromEnv) cachedToken = fromEnv
  else if (existsSync(file)) cachedToken = readFileSync(file, 'utf8').trim()
  else {
    for (const t of chromeTokenCandidates()) {
      if (await accepted(t)) {
        cachedToken = t
        break
      }
    }
  }
  return (
    cachedToken ??
    fail('brak tokenu: ustaw VINTED_STUDIO_TOKEN albo otwórz Vinted Studio w Chrome na tym komputerze')
  )
}

interface Row<T> {
  id: string
  deleted: 0 | 1
  updatedAt: number
  data: T
}
type Pull = Partial<Record<'products' | 'designs' | 'sales' | 'images', Row<unknown>[]>>

async function sync(body: unknown): Promise<{ cursor: number; pull: Pull }> {
  const res = await fetch(`${BASE}/api/sync`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status === 401) fail('token odrzucony (401)')
  if (!res.ok) fail(`sync HTTP ${res.status}`)
  return (await res.json()) as { cursor: number; pull: Pull }
}

const live = <T>(rows: Row<unknown>[] | undefined): T[] =>
  (rows ?? []).filter((r) => !r.deleted && r.data).map((r) => r.data as T)

/** Cały stan (tylko odczyt: push pusty). */
async function load() {
  const { cursor, pull } = await sync({ cursor: 0 })
  return {
    cursor,
    products: live<Product>(pull.products),
    designs: live<Design>(pull.designs),
    sales: live<Sale>(pull.sales),
    imageIds: new Set(live<{ id: string }>(pull.images).map((i) => i.id)),
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(name)

function find(queue: DraftQueueItem[], key: string | undefined): DraftQueueItem {
  if (!key) fail('podaj <key> (z `list`)')
  return queue.find((i) => i.key === key || i.key.startsWith(key)) ?? fail(`nie ma w kolejce: ${key}`)
}

function summary(it: DraftQueueItem, sales: Sale[]) {
  const price = suggestDraftPrice(it.members, sales)
  return {
    key: it.key,
    kind: it.kind,
    name: it.product.name,
    color: it.product.color,
    sizes: Object.fromEntries(unitSizes(it.units).map(([s, n]) => [s || '?', n])),
    purchasePrice: it.units[0]?.purchasePrice,
    suggestedPrice: price,
    photos: it.product.photoIds.length,
    aiPhotos: it.product.generatedPhotoIds.length,
    draft: it.draft ? { source: it.draft.source, title: it.draft.title, price: it.draft.price, edited: !!it.draft.edited } : null,
  }
}

async function main() {
  const cmd = process.argv[2]
  if (!cmd || cmd === 'help' || flag('--help')) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 15).join('\n'))
    return
  }
  const state = await load()
  const queue = draftQueue(state.products, state.designs, { includeIncoming: flag('--incoming') || cmd !== 'list' })

  if (cmd === 'list') {
    const rows = queue.map((it) => summary(it, state.sales))
    if (flag('--json')) return console.log(JSON.stringify(rows, null, 2))
    for (const r of rows) {
      const sizes = Object.entries(r.sizes).map(([s, n]) => `${s}×${n}`).join(' ')
      const price = r.draft?.price ?? r.suggestedPrice?.price
      console.log(
        `${r.key.slice(0, 8)}  ${r.draft ? `[szkic: ${r.draft.source}]` : '[bez szkicu]'}  ${r.name.slice(0, 50)}  ${sizes}  ${price ? `${price} zł` : 'brak ceny'}  zdjęcia: ${r.photos}${r.aiPhotos ? ` + AI ${r.aiPhotos}` : ''}`,
      )
    }
    return
  }

  const item = find(queue, process.argv[3])

  if (cmd === 'photos') {
    const out = arg('--out') ?? join(homedir(), 'Vinted', 'do-wystawienia', item.key.slice(0, 8))
    mkdirSync(out, { recursive: true })
    const ids = [...item.product.photoIds, ...(item.draft?.photoIds ?? item.product.generatedPhotoIds)]
    for (const [i, id] of [...new Set(ids)].entries()) {
      const res = await fetch(`${BASE}/api/blob/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${await token()}` } })
      if (!res.ok) {
        console.error(`pominięto ${id}: HTTP ${res.status}`)
        continue
      }
      const ext = (res.headers.get('content-type') ?? '').includes('png') ? 'png' : 'jpg'
      const kind = item.product.photoIds.includes(id) ? 'oryginal' : 'ai'
      const path = join(out, `${String(i + 1).padStart(2, '0')}-${kind}.${ext}`)
      writeFileSync(path, Buffer.from(await res.arrayBuffer()))
      console.log(path)
    }
    writeFileSync(join(out, 'facts.json'), JSON.stringify(summary(item, state.sales), null, 2))
    console.log(join(out, 'facts.json'))
    return
  }

  if (cmd === 'show') {
    if (!item.draft) fail('ten przedmiot nie ma jeszcze szkicu')
    const [size] = unitSizes(item.units)[0] ?? ['']
    return console.log(pasteBlock(item.draft, size, item.draft.photoIds.length > 0))
  }

  if (cmd === 'put') {
    const src = arg('--json') ?? fail('podaj --json <plik.json> (albo - dla stdin)')
    const input = JSON.parse(readFileSync(src === '-' ? 0 : src, 'utf8')) as Partial<ListingDraft>
    if (!input.title?.trim() || !input.description?.trim()) fail('JSON musi mieć title i description')
    const prev = item.draft
    const now = Date.now()
    const suggested = suggestDraftPrice(item.members, state.sales)
    const price =
      input.price != null
        ? { price: input.price, minPrice: input.minPrice, priceBasis: 'manual' as const }
        : prev?.priceBasis === 'manual'
          ? { price: prev.price, minPrice: prev.minPrice, priceBasis: prev.priceBasis }
          : suggested
            ? { price: suggested.price, minPrice: suggested.minPrice, priceBasis: suggested.basis }
            : {}
    const draft: ListingDraft = {
      title: input.title.trim(),
      description: input.description.trim(),
      category: input.category ?? prev?.category,
      color: input.color ?? prev?.color,
      material: input.material ?? prev?.material,
      ...price,
      // Zdjęcia zostają z aplikacji (bez usuniętych): szkic Listera ich nie zmienia.
      photoIds: (prev?.photoIds ?? item.product.generatedPhotoIds).filter((id) => state.imageIds.has(id)),
      warnings: input.warnings?.length ? input.warnings : undefined,
      source: 'lister',
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    }
    // Świeży wiersz celu (cały, jak z pull) + szkic. Sync to last-write-wins na CAŁY wiersz (jak
    // między urządzeniami): zmiana tego modelu zrobiona offline na telefonie i jeszcze nie
    // wysłana przegra z tym zapisem. Dlatego `put` zaraz po `list`, nie na starych danych.
    const table = item.kind === 'design' ? 'designs' : 'products'
    const row = (table === 'designs' ? state.designs : state.products).find((r) => r.id === item.key)
    if (!row) fail(`brak wiersza ${table}/${item.key}`)
    const data = { ...row, listingDraft: draft, updatedAt: now }
    if (flag('--dry-run')) return console.log(JSON.stringify({ table, id: item.key, listingDraft: draft }, null, 2))
    const res = await sync({ cursor: state.cursor, push: { [table]: [{ id: item.key, deleted: 0, updatedAt: now, data }] } })
    if (!(res as { ack?: Record<string, string[]> }).ack?.[table]?.includes(item.key)) fail('serwer nie potwierdził zapisu')
    console.log(`zapisano szkic: ${draft.title} (${table}/${item.key})`)
    return
  }

  fail(`nieznana komenda: ${cmd}`)
}

await main()
