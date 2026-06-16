# YOLO Plan — Verified-Correctness Bundle (Option A)

Source brief: `research/which-feature-to-improve.md` (strategic research already done).
Branch: `worktree-yolo+verified-correctness-bundle`. Baseline: 206 tests pass, typecheck clean.

## Objective

Ship four high-certainty **S slices**, each correcting a *verified* defect in the flagship
AI features at **zero API cost** and **zero Vinted-constraint risk**, then **measure** the two
open questions so the next (L) investment is evidence-led. No `responseSchema`/Zod migration of
the description generator. Offline-first, on-device, Polish UI preserved.

## Tactical map (confirmed from code)

- **Images:** `src/lib/images.ts` — `processImage` (only internal callers, l.72 & l.100) clamps to
  `MAX_DIM=1600` (l.7,26) and re-encodes JPEG@`0.92` (l.9,33) for **every** image. `addGeneratedImage`
  (l.93, hard `kind:'generated'`, from `PhotoStudio.tsx:126`) and `addImageFromFile(blob,'model',…)`
  (`Models.tsx:81`) both go through it → paid 2K/4K destroyed before save. `ImageRecord.width/height`
  already stored (currently the clamped values). Download `PhotoStudio.tsx:174` hardcodes `.jpg`.
  Test env = **node + fake-indexeddb**, no `document`/`canvas`/`createImageBitmap` (must stub).
- **retailPrice:** not on `Product`; lives only as throwaway `useState('')` (`ProductEditor.tsx:441`),
  fed to `suggestPrice` (`src/lib/pricing.ts:22`). Persist path = the existing `update()` closure
  (`ProductEditor.tsx:101` → `putEntity`; DesignEditor splits via `SHARED_FIELDS`). Per-product field
  survives `resolveProduct` (spreads `...product`). No Dexie version bump (non-indexed).
- **Description candidates:** `Candidate {styleId,styleLabel,text}` in throwaway `useState`
  (`ProductEditor.tsx:753`); tab is conditionally rendered (l.192/401) → unmount discards them. Only
  one "generate all selected" button; no per-style regenerate. Saved descriptions use
  `descriptions: SavedDescription[]` via `update()` (the pattern to mirror).
- **SEO dedup:** `buildSeoTitle` (`src/lib/prompts.ts:277`) dedups only whole-equal parts → brand
  "Zara" + name "Zara sukienka" = "Zara Zara sukienka". Truncation `.slice(0,69)` cuts mid-word.
  `prompts.ts` has ZERO tests.

## Quality bar ("10/10" for THIS task)

1. A 2K generated image persists at **≥2K**, with **raw bytes preserved** (no re-encode), proven by test.
2. `retailPrice` and description candidates **survive navigation** (persisted on `Product`).
3. Per-style regenerate works; candidates are not lost on tab-switch.
4. `buildSeoTitle("Zara","Zara sukienka") === "Zara sukienka"`; truncation never cuts mid-word; ≤70 chars.
5. All 206 existing tests still green + new tests; `typecheck` clean; `vite build` succeeds.
6. No API spend, no Vinted scraping, offline-only, Polish UI, no `responseSchema`/Zod migration.
7. Measurement step reported (2K end-to-end + prompt-bound vs model-bound assessment).

## Workstreams (each an independent shippable slice, TDD where logic exists)

### Slice 1 — Resolution-preserving save for generated/model images
- Add pure helpers to `src/lib/images.ts`: `fitWithin(w,h,max)` and `preservesResolution(kind)`
  (`'generated'|'model'` → true).
- `processImage(source, { preserveResolution })`: when preserving, store the **raw source blob**
  unchanged (no clamp, no re-encode), width/height from the decoded bitmap, still build a 320px thumb.
  Otherwise keep existing clamp+re-encode (user uploads: `product`/`reference`).
- `addImageFromFile` passes `preservesResolution(kind)`; `addGeneratedImage` passes `true`.
- Fix download extension in `PhotoStudio.tsx:174` to follow the stored MIME (PNG→.png).
- **Test** `src/lib/images.test.ts` (stub `createImageBitmap` + `document.createElement('canvas')`,
  mock `@/db/db` putEntity + `@/sync/blobSync`): generated 2048×2731 → `width===2048` (≥ requested 2K),
  `record.blob === raw` (identity ⇒ no re-encode), `blob.size === raw.size`; product 4000 → clamped
  1600 + re-encoded (`blob !== raw`); `fitWithin` clamps & never upscales; `preservesResolution` map;
  `base64ToBlob` byte-exact.
- DoD: test green, typecheck clean, no behavior change for `product`/`reference`.

### Slice 2 — Persist retailPrice on Product
- Add `retailPrice?: number` to `Product` (`src/db/types.ts`). No schema bump.
- `DetailsTab`: drive the calculator input off `draft.retailPrice` via `update({retailPrice:num(...)})`;
  feed `suggestPrice(draft.retailPrice ?? 0, draft.condition)`. Remove the local `useState`.
- **Test**: round-trip `putEntity('products',{…retailPrice}) → db.products.get` preserves it
  (node + fake-indexeddb), added to `src/db/writes.test.ts` or a focused test.
- DoD: value survives navigation (browser smoke), typecheck clean.

### Slice 3 — Persist description candidates + per-style regenerate
- Add `DescriptionCandidate {styleId,styleLabel,text}` to `src/db/types.ts`; add
  `descriptionCandidates?: DescriptionCandidate[]` to `Product`. Replace local `Candidate` in editor.
- `DescriptionsTab`: read `draft.descriptionCandidates ?? []`; persist all mutations (generate,
  edit, save, discard) through `update()`. Add `regenerate(styleId)` (single style) + per-card
  "Generuj ponownie" and a per-card discard (persistence makes lingering candidates a real annoyance).
- DoD: candidates survive tab-switch; per-style regenerate replaces only that style; typecheck clean.

### Slice 4 — SEO dedup fix + prompts.test.ts
- `buildSeoTitle`: drop the standalone brand part when the brand already appears as a whole word in
  the name (token-subsequence check, diacritic-safe — no `\b`); dedup remaining parts by whole-word
  phrase containment; word-boundary truncation to ≤70 chars.
- **Test** `src/lib/prompts.test.ts`: "Zara"/"Zara sukienka"→"Zara sukienka"; brand not in name kept;
  exact-dup collapse; mid-word truncation backtracks to a space and stays ≤70; plus smoke coverage of
  `buildProductFacts`, `styleById`, `buildDescriptionPrompt`.
- DoD: tests green.

### Slice 5 — Measurement (report, not code)
- Verify 2K end-to-end via Slice 1's test (createImageBitmap=2048 ⇒ stored width 2048, raw bytes).
- Inspect `buildPhotoPrompt` for prompt headroom (role-separation + explicit preserve list already
  present) → assess prompt-bound vs model-bound; write up before/after evidence in the end report.

## Risks & Mitigations
- **R: jsdom-free test env** → stub browser graphics primitives + mock DB/sync; assert on the record.
- **R: scope creep in DescriptionsTab UI** → ship only persist + per-style regen + discard; no redesign.
- **R: storing raw 2K/4K blobs grows IndexedDB** → intended tradeoff (don't destroy paid output);
  product/reference uploads still clamped to bound storage. Note in report.
- **R: per-keystroke persistence of candidate edits** → matches the app's existing optimistic-immediate
  `update()` idiom (name/notes already write every keystroke); keep consistent, no debounce.
- **R: EXIF orientation on raw-stored blob** → Gemini output carries no EXIF rotation; acceptable, noted.
- **R: API-gated UI paths (image gen, description gen)** → cannot exercise without spend; verify via
  unit tests + type/build + reason from the identical already-working `descriptions` persistence path;
  browser-verify the non-API paths (retailPrice, SEO). Be explicit in the report.

## Verification commands
- `npm test` (vitest run) — all green incl. new files
- `npm run typecheck` — exit 0
- `npm run build` — tsc -b && vite build succeeds
- dev-server boot smoke (Vite) — compiles & serves the editor without runtime error

## Progress
- [x] Slice 1 — images resolution-preserving + test (images.test.ts, 10 tests; download ext fix)
- [x] Slice 2 — retailPrice persisted (+ writes.test.ts round-trip)
- [x] Slice 3 — candidates persisted + per-style regenerate (descriptions.ts + .test.ts, 5 tests)
- [x] Slice 4 — SEO dedup + prompts.test.ts (17 tests)
- [ ] Slice 5 — measurement report (in end report)
- [ ] Phase 4a review (bugs/spec) + 4b review (quality/2nd opinion)
- [ ] Final verification evidence

### Verification snapshot (post-implementation)
- `npm run typecheck` → exit 0
- `npm test` → 30 files, **239 passed** (baseline 206 → +33 new)
- `npm run build` → tsc -b && vite build OK (3265 modules)
- dev server boot → HTTP 200; all changed modules transform with 0 errors
