# YOLO Plan — Gallery tab in "Modelki AI" with full-res bulk download

## Problem / request
In the **Modelki AI** page (`/modelki`) add a new **"Galeria"** tab that shows *every generated photo on the model* (the virtual try-on outputs produced in Studio using a model), and lets the user **download all photos in the highest resolution**.

## Research synthesis (grounded in code)
- Try-on images are saved by `addGeneratedImage` (`src/lib/images.ts:180`) as `ImageRecord` with `kind: 'generated'`, **top-level `modelId`** (indexed) + `meta.modelId`. Linked to a product (`productId`) or design (`designId`).
- The `images` Dexie index is `'id, kind, productId, modelId, createdAt'` (`src/db/db.ts:77`) → can query `db.images.where('kind').equals('generated')` cheaply.
- `db.images.where('modelId')...` alone is NOT enough: `kind:'model'` (generated portraits) and `kind:'reference'` (uploads) also carry `modelId` (`Models.tsx` addImages/generate). **Gallery = `kind:'generated'` AND `modelId != null`** (enhance/"czyść tło" saves `modelId: undefined` → correctly excluded).
- Generated images are stored **full-resolution, losslessly** (`preserveResolution: true`, `images.ts:188`). `getImageBlob(id)` (`images.ts:232` → `sync/blobSync.ts:33`) returns the local full blob, or lazily fetches from R2 and caches it; returns `undefined` when offline & uncached. Reading does NOT touch the outbox.
- SW (`public/sw.js:44`) already bypasses `/api/*` → R2 blob fetch + client-side zip download unaffected.
- No zip lib in deps; team hand-rolls utilities (`lib/csv.ts`). Inputs are already-compressed JPEG/PNG → **STORE (no compression) is optimal**; hand-rolled store-only ZIP is testable in the node test env and adds no dependency.
- UI primitives: `Button(variant)`, `SectionTitle`, `EmptyState`, `Modal(size)`, `Field` (`components/ui.tsx`). Image views: `Thumb` (cheap stored data-URL) and `FullImage` (loads full blob) in `components/ImageView.tsx`. Segmented-control pattern: styled `<button>` group (PhotoStudio mode toggle). `downloadBlob(name, blob)` in `lib/csv.ts:76`. `useLocalStorageState` available.
- Tests run in **node** + fake-indexeddb (`vitest.config.ts`, `src/test/setup.ts`). Node has global `Blob`, `TextEncoder/Decoder`. Pure logic is unit-tested; React UI is verified in the browser (project rule).

## Decisions (auto mode — documented assumptions)
1. **Placement:** page-level segmented tabs in `/modelki`: **"Modelki"** (existing grid+modal) and **"Galeria"**. Matches "a new tab in the Modelki AI tab".
2. **Content:** all `kind:'generated'` images with a `modelId`, **grouped by model** (one section per model). Generated images whose `modelId` no longer resolves (model deleted; try-on images survive on products) go to a fallback group so they remain downloadable. Excludes enhance/background-clean images (no model). Does NOT include the model's own reference/portrait images (those are "of" the model, shown in the edit modal; the request is photos *on* the model = try-ons).
3. **Performance:** grid tiles render `Thumb` (stored 320px data-URL — instant, no blob load). Full blob loads only in a click lightbox and during bulk download. Critical: a gallery may hold hundreds of large images.
4. **Bulk download:** build ONE **store-only ZIP** (full-res bytes, lossless) client-side and download it as a single file via `downloadBlob` (robust cross-platform; multiple `a.download` clicks fail on iOS; a *single* Blob download works everywhere incl. iOS Safari). Files named `<modelSlug>/<NN>.<ext>`. **No Web Share fallback** — `navigator.canShare({files})` is unreliable for `application/zip` (WebKit may reject it). Buttons: gallery-wide "Pobierz wszystkie (N)" + per-model "Pobierz (n)". Progress indicator + toast; failed/uncached (offline) blobs skipped and reported in the toast.
5. **Out of scope:** deleting from the gallery (cascade to product/design is non-trivial); editing; linking a photo back to its source product/Studio (grouped products clear `productId`, so resolution is fiddly — deferred). Lightbox offers a full-size preview + single-image download.

## Quality bar ("10/10" for this task)
- Correct query semantics (only true try-on photos; orphans handled; no enhance images).
- Bulk zip is **bit-exact full resolution** (verified: stored bytes == source bytes; CRC-32 correct).
- ZIP is valid & opens in OS unzippers (correct local headers, central directory, EOCD, little-endian, UTF-8 filename flag).
- Handles large galleries without loading every full blob into the grid; download shows progress and never silently drops images (skips are counted + surfaced).
- No regressions to the existing Modelki grid/modal, sync/outbox, or Studio.
- Typecheck clean, all tests green (incl. new zip + grouping tests), feature exercised in the browser.

## File-level breakdown

### NEW `src/lib/zip.ts` (pure; browser+node safe)
- `crc32(bytes: Uint8Array): number` — IEEE poly 0xEDB88320, lazy 256-entry table.
- `interface ZipEntry { name: string; data: Uint8Array }`
- `createZip(entries: ZipEntry[]): Blob` — store-only (method 0), version 20, GP flag bit 11 (UTF-8 names), fixed DOS datetime constant (deterministic), per-entry local header + data, central directory, EOCD. Guard: if entries > 65535 or total bytes ≥ 4 GB → throw `ZipTooLargeError` (no ZIP64; realistic galleries are far below — UI catches and toasts). Returns `Blob` type `application/zip`. Build from chunk array (no large copies); push image `Uint8Array` by reference so the `Blob` references bytes without copying (browsers spill large Blobs to disk).
- CRC-32: reflected poly `0xEDB88320`, init/final XOR `0xFFFFFFFF`. Test vectors: `""`→0x00000000, `"a"`→0xE8B7BE43, `"abc"`→0x352441C6, `"123456789"`→0xCBF43926.
- Internals exported for testing as needed (e.g., `zipBytes(entries): Uint8Array`).

### NEW `src/lib/zip.test.ts`
- crc32 vectors: `""`→0, `"123456789"`→0xCBF43926, `"The quick brown fox..."`→0x414FA339.
- `createZip([])` → 22-byte EOCD-only, valid signature.
- Single + multiple entries: parse the produced bytes back (read EOCD → central dir → local headers → extract stored bytes) and assert round-trip equality of names + data, correct CRC, correct offsets/counts.
- UTF-8 filename round-trip (Polish chars).
- Binary data covering all byte values 0–255 round-trips and CRC matches.

### NEW `src/lib/modelGallery.ts` (pure + injectable async)
- `slugifyForFile(name: string): string` — ascii-safe, spaces/invalid→`-`, collapse, trim, fallback `modelka`.
- `extForMime(mime: string): 'png'|'jpg'|...` — png for image/png else jpg (mirror PhotoStudio download).
- `interface GalleryGroup { model: AiModel | null; key: string; label: string; imageIds: ID[] }`
- `groupGeneratedByModel(images: ImageRecord[], models: AiModel[]): GalleryGroup[]` — keep only `kind:'generated' && modelId`, group by modelId in model-list order, orphan group last, images sorted newest-first (createdAt desc).
- `galleryZipName(model, index, mime)` → `<slug>/<NN>.<ext>` (zero-padded to ≥2).
- `async zipGalleryImages(opts: { groups; fetchBlob:(id)=>Promise<Blob|undefined>; onProgress?:(done,total)=>void }): Promise<{ blob: Blob; included: number; skipped: number }>` — fetch each blob, skip undefined, build entries, `createZip`. Injectable `fetchBlob` → testable in node.

### NEW `src/lib/modelGallery.test.ts`
- grouping: only generated+modelId kept; portraits/refs/enhance excluded; order; orphan bucket.
- `slugifyForFile`, `extForMime`, `galleryZipName` (padding, ext, folder).
- `zipGalleryImages` with injected fetchBlob returning fake `Blob`s: progress called, skipped counted, zip round-trips to expected names/bytes.

### NEW `src/components/ModelGallery.tsx`
- Props: `{ models: AiModel[] }` (or self-queries). `useLiveQuery` for generated images: `db.images.where('kind').equals('generated').toArray()`. Compute groups via `groupGeneratedByModel`.
- Empty state when no groups (`EmptyState` + link to `/studio`).
- Top bar: total count + "Pobierz wszystkie (N)" (disabled while downloading; shows progress text).
- Per model section: cover thumb + name + count + "Pobierz (n)"; responsive grid of `Thumb` tiles. Tile hover overlay → quick single download; click → lightbox `Modal` with `FullImage` + download + (link to source product/studio if resolvable).
- Download handler: `getImageBlob` loop with `onProgress`; `zipGalleryImages`; then Web Share (`navigator.canShare?.({files:[file]})`) else `downloadBlob`. Toast success (`Pobrano N zdjęć`) / partial (`… pominięto M`) / error. Guard double-clicks via `downloading` state.

### EDIT `src/pages/Models.tsx`
- Add `tab` state (`'models' | 'gallery'`), default `'models'`.
- Render a segmented tab bar under `SectionTitle` (existing button-group style). Keep the "Nowa modelka" action visible on the Models tab.
- `tab==='models'` → existing grid + modal (unchanged). `tab==='gallery'` → `<ModelGallery models={models ?? []} />`.

## Build sequence
1. `src/lib/zip.ts` + `zip.test.ts` (TDD: write tests, watch fail, implement). Verify.
2. `src/lib/modelGallery.ts` + `modelGallery.test.ts` (TDD). Verify.
3. `src/components/ModelGallery.tsx` (UI; not unit-tested — browser-verified).
4. `src/pages/Models.tsx` tab integration.
5. Typecheck + full test run. Dev server + manual browser exercise.

## Verification commands
- `npm run typecheck`
- `npx vitest run`
- `npm run build` (tsc -b + vite build) — ensure production build is clean.
- Dev: `npm run dev`, exercise: seed a model + generated images, switch to Galeria, download all (open the zip, confirm full-res bytes), per-model download, lightbox, empty state, orphan group, regression on Modelki grid/modal + Studio.
