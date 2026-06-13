# Implementation Plan — Cloudflare cross-device sync

- **Date:** 2026-06-13
- **Spec:** `docs/superpowers/specs/2026-06-13-cloudflare-cross-device-sync-design.md`
- **Branch:** `feat/cloudflare-cross-device-sync`

## Objective

Give Vinted Studio cross-device data persistence for free by adding an offline-first
delta-sync layer on top of the existing Dexie/IndexedDB app, backed by Cloudflare Pages
(host + same-origin Functions API), D1 (metadata rows + inline thumbnails), and R2 (full
image blobs). Sync uses last-write-wins keyed on a client content timestamp, with a local
**outbox** for dirty-tracking and a server-monotonic **sync_stamp** cursor for pulls. The
Gemini key and the sync bearer token stay device-local and are never synced. Keep the PWA
fully usable offline; the frontend moves from Vercel to Cloudflare Pages with the same
Vite `dist` build.

**Sequencing:** Stream 3 (local data layer) unblocks Stream 4 (client engine). Stream 2
(API) can be built and tested locally via `wrangler pages dev` before Stream 1's cloud
resources exist. Stream 5 ties everything together and verifies end-to-end. Streams marked
**[user]** need the owner's authenticated Cloudflare access (dashboard / `wrangler login`);
everything else is code/config I write.

---

## Stream 1 — Cloudflare infra, D1 schema & deploy config

- **Task 1.1 — `wrangler.toml` + bindings.** Add `wrangler.toml` declaring the Pages
  project, `[[d1_databases]]` (binding `DB`), `[[r2_buckets]]` (binding `BUCKET`), and
  Functions config. Add `wrangler` as a devDependency; add `npm` scripts (`cf:dev`,
  `cf:deploy`, `db:migrate`, `db:migrate:local`).
  - *DoD:* `npx wrangler pages dev dist` boots with `DB` + `BUCKET` bindings resolvable
    locally (Miniflare). *Validation:* `wrangler.toml` parses; local dev serves the SPA.
- **Task 1.2 — D1 schema migration.** Write `migrations/0001_init.sql`: six tables
  (`products`, `models`, `accounts`, `sales`, `images`, `settings`), each
  `(id TEXT PK, sync_stamp INTEGER, content_updated_at INTEGER, deleted INTEGER DEFAULT 0,
  data TEXT)` + `idx_<table>_sync` on `sync_stamp`.
  - *DoD:* `wrangler d1 execute DB --local --file=migrations/0001_init.sql` succeeds; tables
    exist. *Validation:* `SELECT name FROM sqlite_master` lists all six tables + indexes.
- **Task 1.3 [user] — Cloud resources.** Create Cloudflare account (if needed), create the
  D1 DB and R2 bucket, link the Pages project to the repo, run the migration against remote
  D1, and set the `SYNC_TOKEN` secret. I provide the exact commands; owner runs the
  interactive/authenticated ones (`wrangler login`, `wrangler pages secret put SYNC_TOKEN`).
  - *DoD:* Remote D1 migrated; R2 bucket exists; `SYNC_TOKEN` set. *Validation:* `wrangler d1
    execute DB --remote --command "SELECT 1"` and `wrangler r2 object list` succeed.
  - *Note:* enabling R2 may require adding a billing profile even though usage stays $0.
- **Task 1.4 — Retire Vercel.** Remove `vercel.json`; move its PWA cache-control headers to
  Cloudflare Pages (`public/_headers`). Confirm the SW + manifest headers still apply.
  - *DoD:* `_headers` reproduces the `sw.js` / `manifest.webmanifest` / `assets/*` cache
    rules. *Validation:* response headers on `cf:dev` match the old Vercel rules.

## Stream 2 — Backend API (Pages Functions)

- **Task 2.1 — Auth middleware.** `functions/_middleware.ts` gates `/api/*`: constant-time
  compare of `Authorization: Bearer` against `env.SYNC_TOKEN`; `401` on mismatch/absence.
  - *DoD:* requests without/with-wrong token get `401`; correct token passes through.
  - *Validation:* unit test of the compare helper; `curl` against `cf:dev` (401 vs 200).
- **Task 2.2 — `POST /api/sync` (push+pull).** `functions/api/sync.ts`: per pushed row, LWW
  vs stored `content_updated_at` (accept→write `data`/`deleted`, set `content_updated_at`,
  `sync_stamp = nextStamp()`); `nextStamp = max(currentMax+1, Date.now())` strictly
  increasing; on accepted `images` tombstone → `BUCKET.delete`. Return `{cursor, ack, pull}`
  where `pull` = rows with `sync_stamp > request.cursor` (incl. tombstones) and `ack` = ids
  processed. Pure LWW/stamp logic extracted to a testable module shared with the client.
  - *DoD:* push then pull on a second cursor returns exactly the changed rows; older edit
    can't clobber newer; same-ms writes both surface (monotonic stamp).
  - *Validation:* Vitest unit tests on the extracted LWW/stamp module; integration test via
    `wrangler pages dev` hitting local D1.
- **Task 2.3 — `PUT/GET /api/blob/:id`.** `functions/api/blob/[id].ts`: `PUT` →
  `BUCKET.put("images/"+id, body, {httpMetadata:{contentType}})`; `GET` → stream
  `BUCKET.get`, `404` if absent.
  - *DoD:* round-trip of a blob (put then get) returns identical bytes + content-type.
  - *Validation:* integration test against local R2 (Miniflare) via `cf:dev`.

## Stream 3 — Local data layer (Dexie v2)

- **Task 3.1 — Schema v2 + new fields.** Bump `db.ts` to `version(2)`: add `sync_meta`
  (`key` PK) and `outbox` (`[table+id]` compound PK) tables; add `updatedAt` to `Account`,
  `Sale`, `ImageRecord` types and backfill on upgrade (`updatedAt = createdAt` for existing
  rows). Keep all existing stores/indexes.
  - *DoD:* existing IndexedDB upgrades cleanly to v2 with no data loss; new tables present.
  - *Validation:* upgrade test (seed v1 data → open v2 → assert rows intact + `updatedAt`
    backfilled).
- **Task 3.2 — Write wrapper + outbox.** A thin helper used by all user mutations that
  stamps `updatedAt = Date.now()` and records `{table, id}` in `outbox` in the same Dexie
  transaction. **Sync-apply writes must bypass it** (no outbox entry). Route existing
  create/update call sites through it.
  - *DoD:* a user edit creates exactly one outbox entry; a sync-apply write creates none.
  - *Validation:* unit tests for both paths.
- **Task 3.3 — Soft-delete cascade.** Change `deleteProductCascade` / `deleteModelCascade`
  to set `deleted`/`updatedAt` (+ outbox) instead of hard-deleting, cascading the flag to
  associated image rows. Local row removal happens only when a tombstone is *applied* from
  sync (so the local UI still hides soft-deleted items immediately via a query filter).
  - *DoD:* deleting a product marks it + its images deleted and queues them; UI hides them.
  - *Validation:* unit test; manual check that lists exclude soft-deleted rows.

## Stream 4 — Client sync engine & blob sync

- **Task 4.1 [user-ish] — Vitest setup.** Add `vitest` + `fake-indexeddb` devDeps and a
  `test` script + config. (I add config; owner runs `npm install` if not already.)
  - *DoD:* `npm test` runs and discovers specs. *Validation:* a trivial spec passes.
- **Task 4.2 — `serialize.ts`.** Entity↔envelope: serialize each entity to
  `{id, deleted, updatedAt, data}`; for `images` drop `blob` (keep `thumb`); for `settings`
  **strip `geminiApiKey`**. Deserialize merges into Dexie; settings-apply **preserves the
  local `geminiApiKey`**.
  - *DoD:* round-trip preserves all fields except blob/key; key never appears in an envelope.
  - *Validation:* unit tests incl. explicit "no geminiApiKey in serialized settings".
- **Task 4.3 — `remote.ts`.** Authed fetch wrapper: injects bearer token, JSON helpers, a
  `SyncError` type, `401` → clear token + signal re-entry, network errors classified for
  backoff.
  - *DoD:* attaches token; surfaces 401/offline distinctly. *Validation:* unit tests w/
    mocked `fetch`.
- **Task 4.4 — `syncEngine.ts`.** Reads `outbox` → builds `push`; calls `/api/sync` with
  stored `cursor`; on success clears acked outbox rows (skipping rows whose local
  `updatedAt` changed mid-sync), applies `pull` via LWW into Dexie (deletes on tombstone,
  preserves local key on settings), stores new `cursor` — **only on full success**.
  Triggers: app load, `focus`/`online`, debounced post-mutation, manual. Backoff on failure.
  - *DoD:* two simulated clients converge; deletes propagate; offline edits reconcile on
    reconnect; no echo (pulled rows don't re-enter outbox).
  - *Validation:* unit tests on apply/cursor/outbox-clear logic with mocked remote; the
    shared LWW module reused from 2.2.
- **Task 4.5 — `blobSync.ts`.** Upload queue: on new `ImageRecord`, enqueue `PUT /api/blob`;
  track `uploaded`; retry. Lazy download: a `getBlob(id)` that returns the local Dexie blob
  or fetches `GET /api/blob/:id`, caches into Dexie, then returns it; `404` → undefined.
  - *DoD:* created image uploads once; a metadata-only row (from another device) triggers a
    single lazy fetch that populates the cache. *Validation:* unit tests w/ mocked remote.
- **Task 4.6 — `state/sync.ts`.** Zustand store: status (`idle/syncing/offline/error`),
  `lastSyncedAt`, pending-outbox count, `syncNow()` action.
  - *DoD:* store reflects engine state transitions. *Validation:* unit test of reducers.

## Stream 5 — UI integration, migration & end-to-end verification

- **Task 5.1 — Device setup UI.** In `Settings`, add a "Sync" section: sync-token field
  (stored device-local alongside the Gemini key, never synced) + connection test. Make the
  first-run path clear: paste Gemini key + sync token.
  - *DoD:* entering a valid token enables sync; invalid → clear error. *Validation:* manual.
- **Task 5.2 — Sync indicator + trigger wiring.** Add a small status indicator + "Sync now"
  to `Layout`; wire engine triggers (load/focus/online/post-mutation debounce).
  - *DoD:* indicator shows synced/syncing/offline/last-synced; manual sync works.
  - *Validation:* manual; observe transitions.
- **Task 5.3 — Lazy blob rendering.** Point `FullImage` (`useObjectUrl`) at
  `blobSync.getBlob` so full images on a fresh device stream from R2 and cache locally;
  grids keep using the inline `thumb` (unchanged).
  - *DoD:* on a device lacking the blob, opening a product fetches + renders it once.
  - *Validation:* two-profile manual test.
- **Task 5.4 — Initial seed/migration.** On first successful cloud connect with local data,
  enqueue all existing rows to the outbox and all blobs to the upload queue, throttled
  (respect D1 100k writes/day; trivial at <300 images). Idempotent (safe to re-run).
  - *DoD:* a populated device seeds cloud once; re-running adds nothing new.
  - *Validation:* manual seed → inspect D1 row counts + R2 object list.
- **Task 5.5 — End-to-end verification.** Against `wrangler pages dev` (local D1+R2) with
  two browser profiles: create/edit/delete on A → appears on B; full image lazy-loads on B;
  offline edits on A reconcile after reconnect; settings sync but Gemini key stays local.
  Then deploy to Pages and smoke-test on phone + desktop.
  - *DoD:* all flows pass locally; deployed app syncs across two real devices.
  - *Validation:* checklist run; `typecheck` + `npm test` + `npm run build` green.

---

## Risks & Mitigations

- **R2 billing-profile prompt at signup** (usage still $0). *Mitigation:* flag during Task
  1.3; proceed — egress is always free, storage is pennies past 10 GB.
- **Clock skew between devices** affects content-timestamp LWW. *Mitigation:* single user,
  rarely-simultaneous edits; skew is seconds. Accept; documented in spec §10.
- **Pull cursor missing same-ms rows.** *Mitigation:* server `nextStamp` is strictly
  increasing (`max(max+1, now)`), cursor is exclusive — covered by Task 2.2 tests.
- **Echo loops (pulled rows re-pushed).** *Mitigation:* outbox is written only by user
  mutations, never by sync-apply (Task 3.2) — covered by tests.
- **Dexie v1→v2 upgrade data loss.** *Mitigation:* additive migration + backfill, with an
  explicit upgrade test (Task 3.1); the existing JSON export remains a manual backup.
- **Auth wrinkle behind a PWA service worker.** *Mitigation:* bearer token (not redirect
  auth) → `/api` calls just carry the header; `401` prompts re-entry. SW must not cache
  `/api/*` responses.
- **Partial/failed sync.** *Mitigation:* cursor + outbox advance only on full success;
  idempotent re-run.

## Rollback

- All work is on `feat/cloudflare-cross-device-sync`; revert by not merging.
- The app remains fully functional offline on Dexie alone if sync is unconfigured (no token
  entered) — the sync layer is additive and inert without a token.
- Cloud teardown: delete the R2 bucket + D1 DB; no local data depends on them.

## Definition of Done (feature)

`typecheck`, `npm test`, and `npm run build` are green; the deployed Pages app syncs
create/edit/delete and images across two real devices; the Gemini key never leaves a
device; the app still works offline; spec watch-outs (§13) are all addressed.
