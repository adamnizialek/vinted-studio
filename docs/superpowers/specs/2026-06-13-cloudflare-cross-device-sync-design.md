# Cross-device sync for Vinted Studio — Cloudflare (Pages + D1 + R2)

- **Date:** 2026-06-13
- **Status:** Approved (design) — ready for implementation plan
- **Author:** Adam + Claude

## 1. Problem & context

Vinted Studio is a Vite + React 18 PWA (a personal Vinted-reselling assistant). All
data currently lives in **Dexie / IndexedDB**, which is per-device and per-browser:
products, AI models, accounts, sales, image blobs, and settings. Nothing syncs, so the
app is unusable across phone + desktop.

The app is already configured for free static hosting (`vercel.json`). The missing
piece is **cross-device data persistence**, and the only data that grows into GB is
**images** (resized to ≤1600px JPEG, stored as `Blob` records, plus a ~320px inline
data-URL thumbnail per image).

**Goal:** persist and sync all data across the owner's devices, for free, while keeping
the existing offline-first PWA behaviour.

## 2. Decisions (made during brainstorming)

| Decision | Choice | Why |
|---|---|---|
| Stack | **Cloudflare**: Pages + Pages Functions + D1 + R2 | Only free tier where images never become a bill: R2 = 10 GB free, **$0 unlimited egress**, no idle-pause. D1 (500 MB) holds metadata forever. |
| Host topology | **Consolidate on Cloudflare Pages** (retire Vercel) | Same-origin API via Pages Functions bound directly to D1 + R2. One project, one deploy, no CORS. Frontend move is the same Vite `dist` build. |
| Gemini API key | **Device-local, never synced** | Keep the existing direct browser→Google call. Key stays out of synced data; entered once per device (like today). No proxy to build, no large image payloads relayed, $0. |
| Sync mechanism | **Offline-first delta sync, last-write-wins** | Fits existing Dexie + Thumb/FullImage code. Single user ⇒ near-zero real conflicts ⇒ plain LWW is sufficient (no CRDTs). |
| Auth | **Single shared bearer token** (device-local secret) | Zero auth UI, no redirects, robust with service-worker offline. Cloudflare Access rejected: its login-redirect flow fights an installed offline PWA, and is overkill for one user. |

### Non-goals (YAGNI)

- No multi-user / multi-tenant auth. The app's "accounts" are Vinted seller profiles, all
  owned by the single app owner — not auth identities.
- No CRDTs / operational-transform conflict resolution.
- No realtime/websocket sync. Periodic + event-triggered sync is enough.
- No chunked/multipart R2 uploads (images are <~500 KB, far under limits).
- No Gemini proxy / server-side AI.

## 3. Architecture

```
Cloudflare Pages (single project)
├─ static SPA            ← existing Vite `dist/` build
└─ /functions/api/*      ← Pages Functions (same origin, no CORS)
      ├─ DB     binding → D1   (all metadata rows + inline thumbnails)
      ├─ BUCKET binding → R2   (full image blobs only)
      └─ SYNC_TOKEN secret     (bearer auth)

Each device:
  Dexie/IndexedDB  ← local source of truth + offline cache (unchanged schema)
  device-local secrets (NOT synced): geminiApiKey, sync bearer token
```

**Layering principle:** D1 is a *sync transport*, not a query engine. The app keeps
querying Dexie locally (as today); D1 only ships opaque row envelopes by sync stamp.
This keeps the server tiny and avoids re-modelling the schema in SQL.

## 4. Data model

### 4.1 Local (Dexie) — unchanged shape, two additions

- Keep all existing tables and the `ImageRecord.blob` / `thumb` split as-is.
- Add a small **`sync_meta`** Dexie table: `{ key: 'cursor', value: <number> }` plus
  `{ key: 'deviceId', value: <uuid> }`. Stores the pull high-water mark and a device id.
- Add an **`outbox`** Dexie table: `{ table, id }` (compound PK) marking locally-changed
  rows that still need to be pushed. **Only user mutations write to the outbox; applying a
  pulled row never does** — this is what prevents pull→push echo loops. A thin write
  wrapper (the same one that bumps `updatedAt`) records the outbox entry; the sync engine
  reads the outbox to build `push`, and clears entries the server acknowledged.
- Image blobs remain in Dexie as a **local cache**; on a fresh device a blob may be
  absent until lazily fetched from R2.

### 4.2 Remote (D1) — JSON-envelope per entity

One table per Dexie entity (`products`, `models`, `accounts`, `sales`, `images`,
`settings`). Every row is an opaque JSON envelope plus sync columns:

```sql
CREATE TABLE IF NOT EXISTS products (
  id                 TEXT    PRIMARY KEY,
  sync_stamp         INTEGER NOT NULL,            -- server monotonic; pull cursor ordering
  content_updated_at INTEGER NOT NULL,            -- client edit time (ms); LWW comparison
  deleted            INTEGER NOT NULL DEFAULT 0,  -- tombstone (0/1)
  data               TEXT    NOT NULL             -- JSON: full entity, see note
);
CREATE INDEX IF NOT EXISTS idx_products_sync ON products(sync_stamp);
-- identical shape for: models, accounts, sales, images, settings
```

Notes:
- `data` is the entity serialized to JSON. For **`images`**, `data` is the `ImageRecord`
  **without `blob`** but **with the inline `thumb`** (~15–30 KB) — so grids render on a
  fresh device with no R2 round-trip. The blob lives only in R2.
- `data` for **`settings`** is serialized **with `geminiApiKey` stripped** (reuse the
  existing export logic). The key never leaves the device.
- Why two timestamps: `content_updated_at` (client wall-clock, the app's existing
  `updatedAt`) drives **LWW correctness** so an old offline edit can't clobber a newer
  one. `sync_stamp` (server-assigned, strictly monotonic) drives the **pull cursor** so
  same-millisecond writes are never skipped.

### 4.3 Remote (R2)

- Bucket holds full image binaries only, at key **`images/{imageId}`** (single owner ⇒
  no per-user prefix needed).
- `Content-Type` set from the record's `mime`.

## 5. Sync protocol

### 5.1 `POST /api/sync` — push + pull in one round trip

Request:
```jsonc
{
  "cursor": 0,                       // client's last sync_stamp high-water mark
  "push": {                          // rows listed in the local outbox (user-changed since last push)
    "products": [{ "id": "...", "deleted": 0, "updatedAt": 1718200000000, "data": {…} }],
    "sales":    [ … ], "images": [ … ], "models": [ … ], "accounts": [ … ], "settings": [ … ]
  }
}
```

Server, per pushed row (LWW):
1. Load existing row by id. If incoming `updatedAt` **>** stored `content_updated_at`
   (or row absent) → **accept**: write `data`, `deleted`, `content_updated_at = updatedAt`,
   `sync_stamp = nextStamp()`. Else → **skip** (keep existing).
2. `nextStamp()` returns a strictly-increasing server value:
   `max(currentMaxStamp + 1, Date.now())`. Guarantees monotonic, collision-free cursors.
3. If an accepted **`images`** row has `deleted = 1` → also `BUCKET.delete("images/"+id)`.

Response:
```jsonc
{
  "cursor": 1718200005123,           // new high-water mark client should store
  "ack": {                           // ids the server processed this push (accepted OR skipped)
    "products": ["..."], "sales": [ … ], …
  },
  "pull": {                          // rows with sync_stamp > request.cursor (incl. tombstones)
    "products": [ … ], "sales": [ … ], "images": [ … ], …
  }
}
```

On a successful response the client: clears the `outbox` entries listed in `ack`, applies
`pull` with the same LWW rule against local Dexie, and stores the new `cursor` — **all
only on full success** (idempotent; a failed/partial sync just re-runs, re-pushing the
still-present outbox rows). To avoid dropping a row edited *during* the sync, the engine
snapshots each pushed row's `updatedAt` and clears its outbox entry only if the row's
current local `updatedAt` is unchanged from the snapshot; otherwise it stays queued for
the next push.

Applying a pulled row:
- `deleted = 1` → delete local Dexie row; if `images`, also delete the cached local blob.
- `images` insert/update → upsert metadata + thumb into Dexie; **do not** fetch the blob
  here (lazy — see §6).
- `settings` → merge, but **preserve the local `geminiApiKey`**.

### 5.2 Triggers & cadence

Sync runs on: app load, `window` focus + `online` event, a debounced timer after local
mutations (~3–5 s), and a manual "Sync now" control. Failures retry with exponential
backoff. The UI shows a subtle indicator: *synced / syncing / offline / last synced ⟨time⟩*.

## 6. Image blobs (R2)

- **Upload on create:** when `addImageFromFile` / `addGeneratedImage` writes a new
  `ImageRecord`, enqueue an upload `PUT /api/blob/:id` (body = blob bytes). Track an
  `uploaded` flag locally; retry on failure. The metadata row syncs via §5 independently.
- **Lazy download:** `FullImage` (and anything needing full bytes) checks local Dexie
  first; if the blob is missing (row arrived from another device), `GET /api/blob/:id`,
  store the bytes into the local Dexie `images.blob` cache, then render. **Grids/lists are
  unaffected** — they already render from the synced inline `thumb`.
- **Delete:** soft-delete propagates via §5; the server deletes the R2 object when it
  accepts a `deleted = 1` images row. Locally, `deleteProductCascade` /
  `deleteModelCascade` change from **hard-delete to soft-delete** (set `deleted`, bump
  `updatedAt`) so the deletion syncs; local blob is dropped on apply.

### Endpoints
- `PUT /api/blob/:id` — `BUCKET.put("images/"+id, request.body, { httpMetadata })`.
- `GET /api/blob/:id` — stream `BUCKET.get(...)`; `404` if absent (client shows placeholder).
- All endpoints require the bearer token (§7).

## 7. Auth

- A single high-entropy random token is generated once and stored as the Pages
  **`SYNC_TOKEN`** secret.
- The owner pastes it once per device; it is stored **device-local** (same store as the
  Gemini key, never synced) and sent as `Authorization: Bearer <token>`.
- Every Function does a constant-time compare against `env.SYNC_TOKEN`; mismatch → `401`.
- On `401`, the client clears the stored token and prompts re-entry.
- Device setup is one step: *"paste your Gemini key + your sync token."*

## 8. Migration / seeding

- **First (data-bearing) device:** push all existing local rows and upload all blobs
  (throttled batches — trivial at <300 images, far under D1's 100k writes/day).
- **Fresh device:** pull everything → metadata + thumbnails appear immediately; full
  images stream from R2 on open.
- The existing JSON export/import is **retained** as an offline backup escape hatch.

## 9. Code structure

```
functions/
  api/
    sync.ts            POST /api/sync   (push+pull, LWW, nextStamp, R2 delete on tombstone)
    blob/[id].ts       PUT/GET /api/blob/:id
  _middleware.ts       bearer-token auth gate for /api/*
migrations/
  0001_init.sql        D1 schema (six tables + indexes)
wrangler.toml          D1 + R2 bindings, Pages config
src/
  sync/
    remote.ts          authed fetch wrapper (token header, 401 handling, error types)
    syncEngine.ts      cursor mgmt, push/pull, LWW apply, triggers, status state
    blobSync.ts        upload queue + lazy fetch-and-cache
    serialize.ts       entity→envelope (+ strip geminiApiKey), envelope→entity
  db/db.ts             + sync_meta & outbox tables (schema v2); a write wrapper that
                       bumps updatedAt and records an outbox entry on every user mutation;
                       deleteCascade helpers → soft-delete (set deleted + bump updatedAt)
  state/sync.ts        zustand store for sync status (synced/syncing/offline/last)
  components/…         small sync-status indicator + "Sync now" + device-setup field
```

Vercel is retired (`vercel.json` removed); Cloudflare Pages builds the same `dist/`.

## 10. Error handling

- **Offline / network error:** sync silently retries with backoff; app keeps working
  from Dexie. Status indicator shows *offline / last synced*.
- **`401`:** clear token, prompt re-entry.
- **R2 blob `404` on download:** render placeholder, log; metadata still usable.
- **Partial sync:** cursor advances only on full success ⇒ safe re-run (idempotent).
- **D1 write-limit (one-time bulk seed):** batch + backoff; limits reset 00:00 UTC.
- **Clock skew between devices:** LWW uses client `content_updated_at`; small skew (secs)
  is acceptable for a single user. Documented minor risk.

## 11. Testing

No test framework exists today — **add Vitest**. Unit-test the pure logic:
- LWW decision (accept vs skip) across both timestamp fields.
- Tombstone application (delete propagation, blob-cache removal).
- Cursor advancement / `nextStamp` monotonicity.
- Envelope (de)serialization, incl. `geminiApiKey` strip + local-key preservation.
- `blobSync` upload queue + lazy fetch (mocked remote).

Full round-trip is verified manually against `wrangler pages dev` (local D1 + R2
emulation) using two browser profiles: create on A → appears on B; edit/delete propagates;
full image lazy-loads on B; offline edits reconcile on reconnect.

## 12. Free-tier capacity & cost

- **R2:** 10 GB free + **$0 egress**. At ~3–4 MB all-in per product, that's ~2,000–3,000
  products — far beyond the <300-image target. Overage is $0.015/GB-month (pennies), never
  a plan upgrade.
- **D1:** 500 MB easily holds all metadata + thumbnails for the foreseeable future;
  100k writes/day untouched outside the one-time seed.
- **Pages/Functions:** free request tiers never approached at single-user scale.

## 13. Watch-outs

1. **R2 activation** may require adding a billing profile (sometimes a card) to the
   Cloudflare account, even though usage stays $0 and egress is always free. Pages/D1/
   Functions do not. Verify at signup.
2. **Never sync `geminiApiKey`** — strip it from the settings envelope; it stays device-local.
3. **Egress** is the usual killer elsewhere; R2's $0 model means cross-device re-sync is
   always free. Still pull deltas only and render lists from inline thumbnails.
4. **Bulk seed** must be throttled to respect D1's 100k writes/day (non-issue at <300 images,
   but build backoff into the sync layer anyway).

## 14. Out of scope / future

- Optional later upgrade to Cloudflare Access for proper identity if multi-user is ever wanted.
- Optional Gemini Worker proxy if the key should never touch the browser.
- WebP / smaller max-dimension recompression to stretch free storage further (not needed
  at current scale; easy follow-up in the existing resize step).
