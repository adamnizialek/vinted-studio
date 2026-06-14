# YOLO Plan — Import stanu magazynu ze zrzutu ekranu (AliExpress) przez Gemini Vision

**Branch:** `yolo/stock-import-screenshot` · **Worktree:** `.claude/worktrees/yolo-stock-import-screenshot`
**Status:** Phase 2 done — executing (TDD). Research synthesized; scope locked.

## Goal
User uploads AliExpress order screenshot(s) → Gemini vision (existing client + user's key) extracts line items → editable review → create `in_stock` products, reusing the existing dedup/import pipeline. Account-less by default (assign on listing).

## Research synthesis (decisions, grounded)
- **Gemini structured output:** `generationConfig.responseMimeType:'application/json'` + `responseSchema` (flat). Schema = OpenAPI subset, **UPPERCASE** types (STRING/NUMBER/INTEGER/BOOLEAN/ARRAY/OBJECT), `propertyOrdering` improves consistency, `nullable:true` for optional, enum via `{type:STRING,format:'enum',enum:[...]}`. Works with multimodal input on gemini-2.5-flash/-lite + 3.x. NOT on image-generation models.
- **Thinking gotcha (critical):** reasoning tokens come from `maxOutputTokens`; too-low cap → HTTP 200, finishReason MAX_TOKENS, **empty parts** → JSON.parse throws. Mitigate: `temperature:0`, `maxOutputTokens` generous (use 8192), and minimize thinking — `thinkingConfig.thinkingBudget:0` for gemini-2.5-*, `thinkingConfig.thinkingLevel:'low'` for gemini-3.x. **Never send both** (HTTP 400). New helper `supportsThinkingLevel(model)=/^gemini-3/.test(model)` mirrors `supportsImageConfig`.
- **Extraction:** one object per product line item; variant (color/size) as fields not rows; **active/charged price, ignore struck-through**; unitPrice = per single unit; null over guessing; keep name concise (not translated, no invented facts); bundle flag if title/spec has PCS/Set/Pack/N-piece/combo; ignore UI chrome + shipping/tax/discount lines. temp 0, single call (human review covers the rest).
- **Currency:** Polish users often see USD on order page, PLN at payment. Do NOT auto-convert (rates vary). Extract number + detected currency + verbatim priceText; flag non-PLN rows amber; store number as PLN (app is PLN-centric), user edits.
- **UX (Dext/Seller Ledger/Veryfi patterns):** review-before-commit; per-row flags for low-confidence/bundle/non-PLN; select-all default; dedup at commit (warn, don't block — existing multiset already does this); summary before commit; never silently drop unreadable rows.
- **Quantity:** each garment = own Vinted listing → expand qty into N drafts (matches existing `importStock` qty:1 multiset). Quantity shown + editable per row.

## Codebase anchors (do not re-derive)
- `src/lib/stockImport.ts` — `StockDraft{name,purchaseCost?}`, `ResolvedStockDraft=&{accountId?}`, `stockImportKey(name,cost)`, `dedupKeyedStock` (multiset), `normalizeForMatch`.
- `src/db/db.ts` → `importStock(drafts)`: products `condition:'dobry'`, `purchasePrice`, `currency:'PLN'`, `quantity:1`, `status:'in_stock'`, `importKey`, outbox. Multiset dedup by importKey.
- `src/lib/gemini.ts` — `callGenerate` (private, generic), `generateText` (text only), `buildImageRequestBody`+`supportsImageConfig` (pure, tested in `gemini.test.ts`). Part shape `inline_data:{mime_type,data}`. `GeminiError`.
- `src/lib/images.ts` → `blobToBase64(blob)`. `src/lib/salesImport.ts` → `parsePlNumber` (handles `$4.99`, `20,73 zł`, `1 234,56 zł`).
- `src/components/ui.tsx`: Modal/Field/Button/Select/TextInput/Spinner. `FileDrop` (image accept/multiple/filter). `Popover.tsx`: `ResponsivePicker`+`OptionRow` (desktop popover / mobile sheet). `useSettings()` → `geminiApiKey`,`textModel`.
- Entry: `src/pages/Inventory.tsx` "Importuj stan" button → `<ImportStockModal>`.
- Tests: vitest pure-fn, PL comments. `npm run typecheck`; `npx vitest run`. Baseline 135 green.

## Build sequence (TDD — test first, watch fail, implement)

### Task 1 — Gemini vision extraction (`src/lib/gemini.ts` + `gemini.test.ts`)
- `supportsThinkingLevel(model)` = `/^gemini-3/.test(model)`.
- `buildExtractionRequestBody(prompt, images: InlineImage[], opts:{model,responseSchema?,maxOutputTokens?})` PURE → body with text+inline_data parts, `generationConfig`: `responseMimeType:'application/json'`, `responseSchema` (if given), `temperature:0`, `maxOutputTokens:8192`, and model-aware `thinkingConfig` (`{thinkingLevel:'low'}` if gemini-3, else `{thinkingBudget:0}`).
- `extractFromImages(prompt, images, opts:{apiKey,model,responseSchema?})` → calls `callGenerate`, returns joined text. Reuse empty-output guard.
- Tests (pure, mirror existing): thinkingBudget:0 for 2.5, thinkingLevel:'low' for 3.x, never both; responseMimeType/schema present; parts ordered text-then-images; temperature 0.

### Task 2 — Pure extraction logic (`src/lib/screenshotImport.ts` + test)
- Types: `ExtractedItem{name,brand?,color?,size?,quantity,unitPrice?,priceText?,currency?,bundle,confidence}`.
- `EXTRACTION_PROMPT` (rules above), `EXTRACTION_SCHEMA` (object `{items:ARRAY<item>}`, UPPERCASE types, propertyOrdering).
- `parseExtractionResponse(text): ExtractedItem[]` — NEVER throws: strip ```json fences, JSON.parse in try/catch, accept `{items:[...]}` or bare `[...]`, validate/coerce each (name string non-empty; quantity int ≥1 default 1; unitPrice finite number or undefined; bundle bool; confidence enum default 'low'); drop invalid.
- `extractedToStockDrafts(items): {drafts: StockDraft[], ...}` — expand quantity into N drafts; map unitPrice→purchaseCost, brand/color/size pass-through; name maybe `${name}` (variant kept in fields).
- Row-level flags helper: `rowFlags(item)` → {nonPln, bundle, lowConfidence, noPrice} for amber review.
- Tests: malformed JSON → []; fenced JSON; bare array; object-with-items; quantity expansion (qty3 → 3 drafts); missing/garbage numbers; bundle/non-PLN flags; coercion clamps.

### Task 3 — Extend writer for enrichment (`stockImport.ts` + `db.ts`)
- Add optional `brand?,color?,sizeLabel?` to `StockDraft`. `importStock` maps them onto Product (undefined for CSV path → unchanged). `importKey` stays name+cost (idempotent). Add db test asserting enrichment fields persist and CSV path unaffected.

### Task 4 — Screenshot modal (`src/components/ImportStockScreenshotModal.tsx`)
- FileDrop (accept image, multiple). On files → blobToBase64 each → `extractFromImages` with `settings.textModel`+key+EXTRACTION_SCHEMA → `parseExtractionResponse`. Loading spinner; PL error toasts (no key → prompt Settings; empty → retry; parse fail → retry).
- Thumbnail strip of uploaded screenshots (object URLs) for reference.
- Editable review rows: name (TextInput), quantity (int), unit price (number), optional account Select, include checkbox; amber flag chips (bundle / non-PLN / low-confidence / no-price). Select-all default.
- Dedup preview vs existing importKeys (reuse pattern from ImportStockModal). Summary "N do dodania · łączny koszt X". Commit → `extractedToStockDrafts`/rows → `importStock` → toast → close.
- Guard total base64 size (~14MB) with clear PL error.

### Task 5 — Entry point (`src/pages/Inventory.tsx`)
- Replace single "Importuj stan" button with `ResponsivePicker` menu → OptionRow "Z pliku (CSV/XLSX)" (opens ImportStockModal) + "Ze zrzutu ekranu (AI)" (opens ImportStockScreenshotModal). Keep both modals mounted.

### Task 6 — Verify & polish
- `npm run typecheck` clean; `npx vitest run` all green (135 + new). `npm run dev` smoke (manual screenshot if a key is available; otherwise exercise UI states with mocked extraction). Lint/format consistent.

## 10/10 bar
1. Vision call robust: structured JSON, model-aware thinking, temp 0, generous tokens; graceful empty/MAX_TOKENS/parse-fail with Polish messages.
2. Pure logic exhaustively unit-tested; never throws on bad AI output.
3. Review-before-commit: editable, amber flags, dedup preview, summary, partial-failure friendly, account-less default.
4. Idempotent re-import (multiset by name+cost) — consistent with CSV path; CSV path untouched/green.
5. Enriched products (brand/color/size when detected). UI matches app Polish tone + design system; responsive entry menu.

## Out of scope (report)
- Auto USD→PLN conversion (warn instead). Persisting the screenshot image. Bounding-box side-by-side (use thumbnail strip). Bundle auto-division (flag only). Files API for >20MB (guard + error).
