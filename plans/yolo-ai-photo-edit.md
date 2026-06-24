# AI Photo Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the reseller refine an already-generated photo with a free-text AI instruction (clean background, warm light, smooth wrinkles), non-destructively, preserving the paid ≥2K bytes.

**Architecture:** A new per-cell **"Edytuj z AI"** button in the PhotoStudio generated-photo grid opens a `Modal` scoped to that image: a free-text box + 2–3 positive-phrased Polish preset chips + a cost-bearing Generuj button. On submit it reuses the existing paid pipeline — `generateImage` (the source image fed back as full-resolution `inline_data` via `toInline`) → `addGeneratedImage` (lossless, ≥2K-preserving) — and saves the edit as a **new** generated cell inserted **adjacent** to its source, carrying provenance (`editedFromId`, `editInstruction`). The grid itself becomes the before/after.

**Tech Stack:** React 18 + Vite + TypeScript, Dexie/IndexedDB, Google Gemini REST (no SDK), Tailwind, Vitest. Polish UI.

## Global Constraints

- **Output ≥2K** — never downscale or lossily re-encode paid model output (documented Vinted low-res ban). Edits derive `imageSize` from the **source's** pixels, never `settings.imageResolution`.
- **Positive-only prompts** — Gemini image models have no negative channel; describe the desired end state. App-authored scaffolding (preset chips) must be positive; never inject a naked negation.
- **Paid per image, no free tier** — surface cost before each edit; `bumpImageCount` only on a successful image response; `retryTimeout:false` on the edit call to avoid the documented timeout double-charge.
- **Local-first** — no new D1/Dexie migration; new provenance fields are **optional** and ride free under blob sync. Data + API key stay on device.
- **Non-destructive** — the source image is never mutated or deleted; an edit is always a new `ImageRecord`.
- **Reuse, don't duplicate** — the design-vs-product save routing must live in ONE shared helper used by both `generate()` and the edit path (prevents orphaning images on shared designs).

**Research provenance:** Built from `research/` brief + a 5-agent research workflow (Gemini edit-prompt best-practices, comparable-app UX, Gemini editing API specifics) + adversarial critique. Key API facts: editing uses the same `generateContent` shape as text-to-image; `gemini-3.1-flash-image` reportedly **ignores `imageSize`** (returns ~1K) even on edits while `gemini-3-pro-image` honors 2K/4K → keep a post-save sub-2K warning; output is PNG; omit `aspectRatio` to inherit the source's framing; `IMAGE_SAFETY`/`IMAGE_PROHIBITED_CONTENT` arrive as HTTP 200 with no image.

---

## File Structure

- **Modify** `src/db/types.ts` — extend `GeneratedImageMeta` with optional `editedFromId`, `editInstruction`.
- **Modify** `src/lib/gemini.ts` — extend `finishReasonError` to map `IMAGE_SAFETY`/`IMAGE_PROHIBITED_CONTENT`.
- **Modify** `src/lib/gemini.test.ts` — assert the new finish reasons.
- **Modify** `src/lib/images.ts` — add pure `resolutionForEdit(width, height)`.
- **Modify** `src/lib/images.test.ts` — test `resolutionForEdit`.
- **Modify** `src/lib/prompts.ts` — add pure `buildEditPrompt(...)` + `EDIT_PRESETS`.
- **Modify** `src/lib/prompts.test.ts` — test `buildEditPrompt` + presets.
- **Create** `src/lib/generatedPhotos.ts` — pure `insertAfterId(...)` + db helper `saveGeneratedToTarget(...)`.
- **Create** `src/lib/generatedPhotos.test.ts` — test both (pure + fake-indexeddb integration).
- **Modify** `src/pages/PhotoStudio.tsx` — refactor `generate()` onto `saveGeneratedToTarget`; add the edit button, modal, state, and `runEdit` handler.

Build order: pure/leaf units first (Tasks 1–4), then the shared save helper (Task 5), then the `generate()` refactor that adopts it (Task 6), then the UI (Task 7), then full verification (Task 8). Each task is independently testable.

---

### Task 1: `resolutionForEdit` — derive edit resolution from the source (never downgrade)

**Files:**
- Modify: `src/lib/images.ts` (add export near `fitWithin`)
- Test: `src/lib/images.test.ts`

**Interfaces:**
- Consumes: `ImageResolution` from `@/db/types` (already imported in images.ts).
- Produces: `resolutionForEdit(width: number, height: number): ImageResolution`.

- [ ] **Step 1: Write the failing test** — append to `src/lib/images.test.ts`:

```ts
import { resolutionForEdit } from '@/lib/images' // add to the existing import block

describe('resolutionForEdit (preserve the source tier, never below 2K)', () => {
  it('keeps a 4K-class source at 4K', () => {
    expect(resolutionForEdit(4096, 3072)).toBe('4K')
    expect(resolutionForEdit(3528, 4704)).toBe('4K')
  })
  it('keeps a 2K-class source at 2K (no spurious upgrade)', () => {
    expect(resolutionForEdit(2048, 2731)).toBe('2K')
    expect(resolutionForEdit(2048, 1536)).toBe('2K')
  })
  it('floors a 1K-class source up to 2K (Vinted >=2K rule)', () => {
    expect(resolutionForEdit(1024, 1152)).toBe('2K')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/images.test.ts -t resolutionForEdit`
Expected: FAIL — `resolutionForEdit is not a function` / import error.

- [ ] **Step 3: Write minimal implementation** — add to `src/lib/images.ts` (after `fitWithin`):

```ts
/**
 * Dobiera rozdzielczosc EDYCJI do ZRODLA: nigdy ponizej oryginalu i nigdy ponizej
 * 2K (regula Vinted). Edycja platnego 4K nie moze cicho zejsc do 2K. Prog 3072 px
 * lezy w luce miedzy dlugim bokiem 2K (~2K px) a 4K (~4K px).
 */
export function resolutionForEdit(width: number, height: number): ImageResolution {
  return Math.max(width, height) > 3072 ? '4K' : '2K'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/images.test.ts -t resolutionForEdit`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/images.ts src/lib/images.test.ts
git commit -m "feat(images): resolutionForEdit picks the source tier, never below 2K"
```

---

### Task 2: Map image-output safety stops in `finishReasonError`

**Files:**
- Modify: `src/lib/gemini.ts:65-73` (`finishReasonError`)
- Test: `src/lib/gemini.test.ts` (existing `finishReasonError` describe block)

**Interfaces:**
- Consumes: existing `GeminiError`.
- Produces: `finishReasonError('IMAGE_SAFETY' | 'IMAGE_PROHIBITED_CONTENT')` returns a `GeminiError` with a distinct withheld-image message; unchanged for `STOP`/`undefined`/`MAX_TOKENS`/`SAFETY`/`PROHIBITED_CONTENT`.

- [ ] **Step 1: Write the failing test** — add inside the existing `describe('finishReasonError', …)` in `src/lib/gemini.test.ts`:

```ts
  it('flags image-output safety stops as withheld-image errors', () => {
    const a = finishReasonError('IMAGE_SAFETY')
    const b = finishReasonError('IMAGE_PROHIBITED_CONTENT')
    expect(a).toBeInstanceOf(Error)
    expect(b).toBeInstanceOf(Error)
    expect(a?.message).toMatch(/wstrzymany|bezpieczeństwa/i)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/gemini.test.ts -t finishReasonError`
Expected: FAIL — `IMAGE_SAFETY` currently returns `null`, so `a` is `null` and `toBeInstanceOf(Error)` fails.

- [ ] **Step 3: Write minimal implementation** — in `src/lib/gemini.ts`, replace the body of `finishReasonError` so it has the new branch (keep existing branches verbatim):

```ts
export function finishReasonError(finish: string | undefined): GeminiError | null {
  if (finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT')
    return new GeminiError('Odpowiedź zatrzymana przez filtry bezpieczeństwa. Zmień dane wejściowe.')
  if (finish === 'IMAGE_SAFETY' || finish === 'IMAGE_PROHIBITED_CONTENT')
    return new GeminiError(
      'Obraz wstrzymany przez filtry bezpieczeństwa. Zmień opis edycji lub zdjęcie i spróbuj ponownie.',
    )
  if (finish === 'MAX_TOKENS')
    return new GeminiError(
      'Odpowiedź została ucięta przez limit tokenów. Spróbuj ponownie z wyraźniejszym/mniejszym zrzutem lub wybierz inny model w Ustawieniach.',
    )
  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/gemini.test.ts -t finishReasonError`
Expected: PASS (existing + new assertions).

- [ ] **Step 5: Commit**

```bash
git add src/lib/gemini.ts src/lib/gemini.test.ts
git commit -m "feat(gemini): map IMAGE_SAFETY/IMAGE_PROHIBITED_CONTENT to a withheld-image error"
```

---

### Task 3: `buildEditPrompt` + `EDIT_PRESETS` (positive 5-slot edit template)

**Files:**
- Modify: `src/lib/prompts.ts` (add after `buildPhotoPrompt`)
- Test: `src/lib/prompts.test.ts`

**Interfaces:**
- Produces:
  - `interface EditPromptInput { instruction: string; isTryOn: boolean }`
  - `buildEditPrompt(input: EditPromptInput): string`
  - `EDIT_PRESETS: { id: string; label: string; instruction: string }[]`

**Design notes:** 5-slot positive template — ANCHOR (`Using the provided photo, …`) + the user's verbatim CHANGE directive + INTEGRATE clause (match lighting/colour temperature/shadows/perspective/grain) + PRESERVE-LIST (locks model identity only when `isTryOn`; always locks garment fidelity + framing) + QUALITY clause. The user instruction is the change; the preserve-list carries the "keep everything else" discipline. We strip a trailing period so we don't emit `..`.

- [ ] **Step 1: Write the failing test** — append to `src/lib/prompts.test.ts`:

```ts
import { buildEditPrompt, EDIT_PRESETS } from '@/lib/prompts' // add to existing import block

describe('buildEditPrompt — positive 5-slot edit template', () => {
  it('anchors to the provided photo and includes the verbatim instruction', () => {
    const p = buildEditPrompt({ instruction: 'zmień tło na jasne studio', isTryOn: false })
    expect(p).toContain('Using the provided photo,')
    expect(p).toContain('zmień tło na jasne studio')
  })

  it('carries an integration clause and a keep-everything-else preserve-list', () => {
    const p = buildEditPrompt({ instruction: 'rozjaśnij', isTryOn: false })
    expect(p).toMatch(/match the current lighting/i)
    expect(p).toMatch(/keep everything else in the image exactly the same/i)
  })

  it('locks model identity ONLY when the source was a try-on (has a person)', () => {
    const tryOn = buildEditPrompt({ instruction: 'x', isTryOn: true })
    const enhance = buildEditPrompt({ instruction: 'x', isTryOn: false })
    expect(tryOn).toContain('the same person')
    expect(enhance).not.toContain('the same person')
    expect(enhance).toContain('the garment exactly') // garment fidelity always locked
  })

  it('does not emit a double period when the instruction already ends with one', () => {
    const p = buildEditPrompt({ instruction: 'zmień tło.', isTryOn: false })
    expect(p).not.toContain('tło..')
    expect(p).toContain('tło.')
  })

  it('exposes positive, uniquely-id\'d Polish presets that pre-fill the box', () => {
    expect(EDIT_PRESETS.length).toBeGreaterThanOrEqual(2)
    const ids = EDIT_PRESETS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const c of EDIT_PRESETS) {
      expect(c.label.trim()).not.toBe('')
      expect(c.instruction.trim()).not.toBe('')
      // App-authored scaffolding must be positive — never a naked negation.
      expect(c.instruction.toLowerCase()).not.toMatch(/\b(nie|bez|usuń całe tło)\b/)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/prompts.test.ts -t buildEditPrompt`
Expected: FAIL — import error (`buildEditPrompt`/`EDIT_PRESETS` not exported).

- [ ] **Step 3: Write minimal implementation** — add to `src/lib/prompts.ts` (after `buildPhotoPrompt`, before `describeGarment`):

```ts
export interface EditPromptInput {
  /** Co zmienić — dowolny tekst użytkownika (lub instrukcja z presetu). */
  instruction: string
  /** Czy źródłem była przymierzalnia (jest na nim osoba) — wtedy chronimy też tożsamość modelki. */
  isTryOn: boolean
}

/**
 * Buduje prompt EDYCJI istniejącego (już wygenerowanego) zdjęcia: pozytywny szablon
 * 5-slotowy zgodny z wytycznymi modeli Nano Banana — KOTWICA ("Using the provided
 * photo,") + zmiana (tekst użytkownika) + WTOPIENIE (dopasuj światło/temperaturę/
 * cienie/perspektywę/ziarno) + LISTA-ZACHOWAJ (tożsamość modelki tylko dla try-on,
 * wierność ubrania i kadr zawsze) + jakość. Nie wstrzykujemy własnych negacji —
 * model nie ma kanału negative-prompt; dyscyplinę "reszta bez zmian" niesie lista-zachowaj.
 */
export function buildEditPrompt(input: EditPromptInput): string {
  const instruction = input.instruction.trim().replace(/\.+$/, '')
  const preserve = input.isTryOn
    ? 'the same person — their face, identity, hair, skin tone, pose and body proportions; the garment exactly — same colour, print, pattern, texture, cut and length; and the overall framing and composition'
    : 'the garment exactly — same colour, print, pattern, texture, cut and length; and the overall framing and composition'
  return [
    `Using the provided photo, ${instruction}.`,
    'Blend the change naturally into the existing photo — match the current lighting, colour temperature, shadow direction, perspective and grain.',
    `Keep everything else in the image exactly the same: ${preserve}.`,
    'Maintain full photographic detail and sharpness. It must look like a genuine second-hand clothing listing photo. No added text, watermark or brand logos.',
  ].join('\n')
}

/**
 * Gotowe, POZYTYWNIE sformułowane podpowiedzi edycji (PL). Klik wstawia `instruction`
 * do pola tekstowego (rusztowanie, nie zamiennik — można dowolnie edytować przed wysłaniem).
 * Celowo tylko wiarygodne kategorie (tło/światło/zagniecenia); edycje twarzy/min pomijamy
 * w v1 (najczęstszy wyzwalacz IMAGE_SAFETY i dryfu tożsamości).
 */
export const EDIT_PRESETS: { id: string; label: string; instruction: string }[] = [
  {
    id: 'studio',
    label: 'Czyste tło studyjne',
    instruction:
      'umieść przedmiot na czystym, jednolitym, jasnym tle studyjnym z miękkim, równomiernym światłem',
  },
  {
    id: 'light',
    label: 'Rozjaśnij i ociepl',
    instruction:
      'rozjaśnij zdjęcie i nadaj mu cieplejsze, naturalne światło z poprawnym balansem bieli',
  },
  {
    id: 'dewrinkle',
    label: 'Wygładź zagniecenia',
    instruction:
      'wygładź zagniecenia i fałdy materiału tak, aby ubranie leżało gładko i równo',
  },
]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/prompts.test.ts -t buildEditPrompt`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/prompts.ts src/lib/prompts.test.ts
git commit -m "feat(prompts): buildEditPrompt + positive Polish EDIT_PRESETS for AI photo editing"
```

---

### Task 4: Extend `GeneratedImageMeta` with edit provenance (type-only)

**Files:**
- Modify: `src/db/types.ts:60-66` (`GeneratedImageMeta`)

**Interfaces:**
- Produces: `GeneratedImageMeta` gains optional `editedFromId?: ID`, `editInstruction?: string`.

This is a type-only change consumed by Tasks 5 and 7; it has no standalone runtime test (the round-trip is covered by Task 5's integration test and verified by `npm run typecheck`). Optional fields → no Dexie migration; they sync for free under blob sync.

- [ ] **Step 1: Edit the type** — in `src/db/types.ts`, extend the interface:

```ts
export interface GeneratedImageMeta {
  modelId?: ID
  prompt: string
  imageModel: string
  /** id zdjec wejsciowych (produkt + ew. dodatkowe). */
  sourceImageIds: ID[]
  /** id zdjecia-zrodla edycji (gdy ten obraz powstal przez "Edytuj z AI"). */
  editedFromId?: ID
  /** Instrukcja edycji wpisana przez uzytkownika (prowenancja/audyt). */
  editInstruction?: string
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors; existing call sites still satisfy the interface since both fields are optional).

- [ ] **Step 3: Commit**

```bash
git add src/db/types.ts
git commit -m "feat(types): add optional editedFromId/editInstruction provenance to GeneratedImageMeta"
```

---

### Task 5: Shared `saveGeneratedToTarget` + pure `insertAfterId`

**Files:**
- Create: `src/lib/generatedPhotos.ts`
- Create: `src/lib/generatedPhotos.test.ts`

**Interfaces:**
- Consumes: `addGeneratedImage` (`@/lib/images`), `db`/`patchEntity`/`putEntity` (`@/db/db`), `GeneratedImageMeta`/`ImageRecord`/`Product` (`@/db/types`).
- Produces:
  - `insertAfterId(ids: string[], newId: string, afterId?: string): string[]` — inserts `newId` right after `afterId`; if `afterId` is absent/unknown, prepends.
  - `saveGeneratedToTarget(rawProduct: Product, img: { base64: string; mime: string }, meta: GeneratedImageMeta, opts?: { insertAfter?: string }): Promise<ImageRecord>` — saves a generated image and links it to the Design (when the product is a size-variant of a design) or the Product, inserting the id at the right position. The ONE source of truth for both `generate()` and the edit path.

- [ ] **Step 1: Write the failing tests** — create `src/lib/generatedPhotos.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { db, putEntity } from '@/db/db'
import type { Design, GeneratedImageMeta, ImageRecord, Product } from '@/db/types'

// addGeneratedImage runs createImageBitmap/canvas (DOM) — out of scope here. We stub it
// to insert a minimal image row and return it, so we test ONLY the design-vs-product
// routing + id insertion (the orphan-on-shared-design risk the critique flagged).
vi.mock('@/lib/images', () => ({
  addGeneratedImage: vi.fn(
    async (
      base64: string,
      mime: string,
      meta: GeneratedImageMeta,
      links?: { productId?: string },
    ): Promise<ImageRecord> => {
      const rec: ImageRecord = {
        id: 'gen-new',
        mime,
        width: 2048,
        height: 2731,
        thumb: 'data:image/jpeg;base64,xx',
        kind: 'generated',
        productId: links?.productId,
        modelId: meta.modelId,
        meta,
        createdAt: 1,
        updatedAt: 1,
      }
      await putEntity('images', rec)
      return rec
    },
  ),
}))

import { insertAfterId, saveGeneratedToTarget } from '@/lib/generatedPhotos'

const meta = (over: Partial<GeneratedImageMeta> = {}): GeneratedImageMeta => ({
  prompt: 'p',
  imageModel: 'gemini-3-pro-image',
  sourceImageIds: [],
  ...over,
})

const product = (over: Partial<Product>): Product => ({
  id: 'p1',
  name: 'P',
  condition: 'dobry',
  currency: 'PLN',
  quantity: 1,
  status: 'in_stock',
  photoIds: [],
  generatedPhotoIds: [],
  descriptions: [],
  tags: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

beforeEach(async () => {
  await Promise.all([db.products.clear(), db.designs.clear(), db.images.clear(), db.outbox.clear()])
})

describe('insertAfterId', () => {
  it('inserts immediately after the anchor id', () => {
    expect(insertAfterId(['a', 'b', 'c'], 'x', 'b')).toEqual(['a', 'b', 'x', 'c'])
  })
  it('prepends when no anchor is given', () => {
    expect(insertAfterId(['a', 'b'], 'x')).toEqual(['x', 'a', 'b'])
  })
  it('prepends when the anchor id is not present', () => {
    expect(insertAfterId(['a', 'b'], 'x', 'zzz')).toEqual(['x', 'a', 'b'])
  })
})

describe('saveGeneratedToTarget — product (non-design)', () => {
  it('inserts the new id after the source and keeps productId on the image', async () => {
    await putEntity('products', product({ id: 'p1', generatedPhotoIds: ['src', 'other'] }))
    const rec = await saveGeneratedToTarget(
      product({ id: 'p1', generatedPhotoIds: ['src', 'other'] }),
      { base64: 'AAAA', mime: 'image/png' },
      meta({ editedFromId: 'src' }),
      { insertAfter: 'src' },
    )
    const fresh = await db.products.get('p1')
    expect(fresh?.generatedPhotoIds).toEqual(['src', 'gen-new', 'other'])
    expect((await db.images.get(rec.id))?.productId).toBe('p1')
  })
})

describe('saveGeneratedToTarget — shared design (the orphan guard)', () => {
  it('lands in design.generatedPhotoIds and clears productId on the image', async () => {
    const design: Design = {
      id: 'd1',
      name: 'D',
      tags: [],
      photoIds: [],
      generatedPhotoIds: ['src'],
      descriptions: [],
      createdAt: 1,
      updatedAt: 1,
    }
    await putEntity('designs', design)
    await putEntity('products', product({ id: 'p1', designId: 'd1' }))

    const rec = await saveGeneratedToTarget(
      product({ id: 'p1', designId: 'd1' }),
      { base64: 'AAAA', mime: 'image/png' },
      meta({ editedFromId: 'src' }),
      { insertAfter: 'src' },
    )

    const d = await db.designs.get('d1')
    expect(d?.generatedPhotoIds).toEqual(['src', 'gen-new'])
    const img = await db.images.get(rec.id)
    expect(img?.designId).toBe('d1')
    expect(img?.productId).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/generatedPhotos.test.ts`
Expected: FAIL — module `@/lib/generatedPhotos` does not exist.

- [ ] **Step 3: Write minimal implementation** — create `src/lib/generatedPhotos.ts`:

```ts
import { db, patchEntity, putEntity } from '@/db/db'
import type { GeneratedImageMeta, ImageRecord, Product } from '@/db/types'
import { addGeneratedImage } from './images'

/** Wstawia `newId` tuz za `afterId`; gdy `afterId` brak/nieznane — na poczatek. */
export function insertAfterId(ids: string[], newId: string, afterId?: string): string[] {
  if (!afterId) return [newId, ...ids]
  const i = ids.indexOf(afterId)
  if (i < 0) return [newId, ...ids]
  return [...ids.slice(0, i + 1), newId, ...ids.slice(i + 1)]
}

/**
 * Zapisuje wygenerowany obraz i podpina go do wlasciwego celu: gdy produkt jest
 * rozmiarem fasonu (`designId`), zdjecie nalezy do Design i jest WSPOLDZIELONE przez
 * warianty rozmiarowe; inaczej nalezy do Product. JEDNO zrodlo prawdy dla generate()
 * i edycji — bez tego galaz design-vs-product rozjezdza sie miedzy sciezkami i powstaje
 * osierocony obraz (zapisany z productId, nigdy niedodany do design.generatedPhotoIds).
 * `opts.insertAfter` wstawia id tuz za wskazanym (np. za zrodlem edycji), by oryginal
 * i edycja sasiadowaly; bez niego — na poczatek (zachowanie generate()).
 */
export async function saveGeneratedToTarget(
  rawProduct: Product,
  img: { base64: string; mime: string },
  meta: GeneratedImageMeta,
  opts: { insertAfter?: string } = {},
): Promise<ImageRecord> {
  const rec = await addGeneratedImage(
    img.base64,
    img.mime,
    meta,
    rawProduct.designId ? {} : { productId: rawProduct.id },
  )
  if (rawProduct.designId) {
    const d = await db.designs.get(rawProduct.designId)
    if (d)
      await patchEntity('designs', d.id, {
        generatedPhotoIds: insertAfterId(d.generatedPhotoIds, rec.id, opts.insertAfter),
      })
    await patchEntity('images', rec.id, { designId: rawProduct.designId, productId: undefined })
  } else {
    const fresh = await db.products.get(rawProduct.id)
    if (fresh)
      await putEntity('products', {
        ...fresh,
        generatedPhotoIds: insertAfterId(fresh.generatedPhotoIds, rec.id, opts.insertAfter),
      })
  }
  return rec
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/generatedPhotos.test.ts`
Expected: PASS (3 `insertAfterId` + 2 `saveGeneratedToTarget`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/generatedPhotos.ts src/lib/generatedPhotos.test.ts
git commit -m "feat(photos): shared saveGeneratedToTarget helper (design-safe routing + adjacency)"
```

---

### Task 6: Refactor `PhotoStudio.generate()` onto the shared helper (no behavior change)

**Files:**
- Modify: `src/pages/PhotoStudio.tsx` (the save loop at lines ~119-150; import block at top)

**Interfaces:**
- Consumes: `saveGeneratedToTarget` from Task 5.
- Produces: no new exports. `generate()` still prepends new cells (helper with no `insertAfter` prepends), so existing behavior is preserved.

This is a pure refactor (extract-to-shared). Its safety net is the full existing suite staying green plus typecheck. After it, `putEntity` is no longer used in this file.

- [ ] **Step 1: Update imports** — in `src/pages/PhotoStudio.tsx`:
  - Change `import { db, deleteEntity, patchEntity, putEntity } from '@/db/db'` to `import { db, deleteEntity, patchEntity } from '@/db/db'` (drop `putEntity` — now unused here; `tsc` has `noUnusedLocals`).
  - Add `import { saveGeneratedToTarget } from '@/lib/generatedPhotos'`.

- [ ] **Step 2: Replace the save loop** — inside `generate()`, replace this block:

```ts
        await bumpImageCount(images.length)
        for (const img of images) {
          const rec = await addGeneratedImage(
            img.base64,
            img.mime,
            { modelId: mode === 'tryOn' ? selModelId : undefined, prompt, imageModel: settings.imageModel, sourceImageIds: sourceIds },
            rawProduct?.designId ? {} : { productId: product.id },
          )
          if (rawProduct?.designId) {
            const d = await db.designs.get(rawProduct.designId)
            if (d)
              await patchEntity('designs', d.id, {
                generatedPhotoIds: [rec.id, ...d.generatedPhotoIds],
              })
            await patchEntity('images', rec.id, { designId: rawProduct.designId, productId: undefined })
          } else {
            const fresh = await db.products.get(product.id)
            if (fresh)
              await putEntity('products', { ...fresh, generatedPhotoIds: [rec.id, ...fresh.generatedPhotoIds] })
          }
          saved++
        }
```

with:

```ts
        await bumpImageCount(images.length)
        for (const img of images) {
          await saveGeneratedToTarget(rawProduct!, img, {
            modelId: mode === 'tryOn' ? selModelId : undefined,
            prompt,
            imageModel: settings.imageModel,
            sourceImageIds: sourceIds,
          })
          saved++
        }
```

(`rawProduct` is guaranteed non-null here: `generate()` early-returns unless `product` exists, and `product` is derived from `rawProduct`. The `!` documents that.)

- [ ] **Step 3: Verify `addGeneratedImage` import is still needed** — it is no longer referenced directly in `PhotoStudio.tsx` after this change. Remove it from the `@/lib/images` import, leaving `import { blobToBase64, getImageBlob } from '@/lib/images'`. (Add `resolutionForEdit` to this same import in Task 7.)

- [ ] **Step 4: Run the full suite + typecheck**

Run: `npm test`
Expected: PASS — 407 tests + the new ones from Tasks 1–5, 0 failures.

Run: `npm run typecheck`
Expected: PASS — no unused-local errors (confirms `putEntity`/`addGeneratedImage` were fully removed from this file).

- [ ] **Step 5: Commit**

```bash
git add src/pages/PhotoStudio.tsx
git commit -m "refactor(photo): route generate() saves through saveGeneratedToTarget"
```

---

### Task 7: Edit UI in PhotoStudio — button, modal, `runEdit`

**Files:**
- Modify: `src/pages/PhotoStudio.tsx` (imports, state, `runEdit` handler, per-cell button, modal JSX)

**Interfaces:**
- Consumes: `buildEditPrompt`/`EDIT_PRESETS` (`@/lib/prompts`), `resolutionForEdit` (`@/lib/images`), `saveGeneratedToTarget` (`@/lib/generatedPhotos`), `MAX_BASE64_CHARS` (`@/lib/gemini`), existing `Modal`/`Field`/`TextArea`/`Button`, `FullImage`, `estimateImageCostUsd`, `toInline`, `generateImage`, `bumpImageCount`, `toast`.
- Produces: no new exports. New local state `editTarget`, `editInstruction`, `editBusy`, `editController`; `editSource` live query; `runEdit()`.

This task is UI behavior, verified by the dev server (Task 8) per project rule. The logic it wires (`buildEditPrompt`, `resolutionForEdit`, `saveGeneratedToTarget`, `finishReasonError`) is already unit-tested in Tasks 1–5.

- [ ] **Step 1: Update imports** in `src/pages/PhotoStudio.tsx`:
  - lucide: ensure `Wand2`, `Loader2`, `X` are imported (Wand2/Loader2/X already are).
  - `import { DEFAULT_IMAGE_MODEL, DEFAULT_IMAGE_RESOLUTION, estimateImageCostUsd } from '@/lib/constants'` (already present).
  - `import { SCENE_PRESETS, buildPhotoPrompt, buildEditPrompt, EDIT_PRESETS, type PhotoMode } from '@/lib/prompts'`.
  - `import { generateImage, MAX_BASE64_CHARS, type InlineImage } from '@/lib/gemini'`.
  - `import { blobToBase64, getImageBlob, resolutionForEdit } from '@/lib/images'`.
  - `import { Button, EmptyState, Field, Modal, Select, TextArea, SectionTitle } from '@/components/ui'` (add `Modal`).

- [ ] **Step 2: Add edit state + derived values** — after the existing `const [controller, setController] = useState<AbortController | null>(null)` line:

```ts
  // Edycja istniejącego zdjęcia ("Edytuj z AI") — własne flagi/AbortController,
  // niezależne od głównej generacji (modal i tak blokuje tło backdropem).
  const [editTarget, setEditTarget] = useState<string | null>(null)
  const [editInstruction, setEditInstruction] = useState('')
  const [editBusy, setEditBusy] = useState(false)
  const [editController, setEditController] = useState<AbortController | null>(null)
  const editSource = useLiveQuery(
    async () => (editTarget ? await db.images.get(editTarget) : undefined),
    [editTarget],
  )
  const editResolution = editSource
    ? resolutionForEdit(editSource.width, editSource.height)
    : settings?.imageResolution ?? DEFAULT_IMAGE_RESOLUTION
  // Koszt w lockstep z tym, co realnie wyślemy (model z ustawień + rozdz. ze źródła).
  const editCost = estimateImageCostUsd(
    settings?.imageModel ?? DEFAULT_IMAGE_MODEL,
    editResolution,
  ).toFixed(3)
```

- [ ] **Step 3: Add the `runEdit` handler** — after the existing `generate` function (before `removeGenerated`):

```ts
  const runEdit = async () => {
    if (!editTarget || !editSource || !rawProduct) return
    if (!settings?.geminiApiKey) return toast.error('Dodaj klucz API w Ustawieniach.')
    const instruction = editInstruction.trim()
    if (!instruction) return toast.error('Opisz, co zmienić na zdjęciu.')

    const inl = await toInline(editTarget)
    if (!inl)
      return toast.error('Nie udało się wczytać zdjęcia źródłowego. Sprawdź połączenie i spróbuj ponownie.')
    // Pełne 2K/4K PNG w base64 (+~33%) może przekroczyć limit inline Gemini — czytelny
    // komunikat zamiast surowego HTTP 400, bez naliczania.
    if (inl.base64.length > MAX_BASE64_CHARS)
      return toast.error('To zdjęcie jest zbyt duże, aby edytować je w pełnej rozdzielczości.')

    const ac = new AbortController()
    setEditController(ac)
    setEditBusy(true)
    try {
      const prompt = buildEditPrompt({ instruction, isTryOn: !!editSource.meta?.modelId })
      const { images } = await generateImage(prompt, [inl], {
        apiKey: settings.geminiApiKey,
        model: settings.imageModel,
        resolution: editResolution,
        // Celowo BEZ aspectRatio — model dziedziczy kształt źródła (pewniejsze niż wymuszanie).
        signal: ac.signal,
        // Każda edycja jest płatna — nie ryzykuj podwójnego naliczenia po timeoucie.
        retryTimeout: false,
      })
      await bumpImageCount(images.length)
      let lowRes = false
      for (const img of images) {
        const rec = await saveGeneratedToTarget(
          rawProduct,
          img,
          {
            modelId: editSource.meta?.modelId,
            prompt,
            imageModel: settings.imageModel,
            sourceImageIds: [editTarget],
            editedFromId: editTarget,
            editInstruction: instruction,
          },
          { insertAfter: editTarget },
        )
        if (Math.max(rec.width, rec.height) < 2000) lowRes = true
      }
      toast.success('Zapisano edytowane zdjęcie ✨')
      // gemini-3.1-flash-image bywa, że ignoruje imageSize i zwraca ~1K — ostrzeż (nie ponawiaj: redo = podwójny koszt).
      if (lowRes)
        toast.info(
          'Uwaga: wynik ma mniej niż 2K. Dla Vinted wybierz model „gemini-3-pro-image” w Ustawieniach.',
        )
      setEditTarget(null)
      setEditInstruction('')
    } catch (e) {
      if (ac.signal.aborted) toast.info('Anulowano edycję.')
      else toast.error(e instanceof Error ? e.message : 'Błąd edycji.')
    } finally {
      setEditBusy(false)
      setEditController(null)
    }
  }
```

- [ ] **Step 4: Add the per-cell "Edytuj z AI" button** — in the generated-grid action bar, add it as the FIRST action (before Download). Replace the action-bar `<div>` contents at lines ~354-360:

```tsx
                  <div className="absolute inset-x-0 bottom-0 flex justify-end gap-1 bg-gradient-to-t from-black/60 to-transparent p-2 opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100">
                    <button
                      onClick={() => {
                        setEditTarget(id)
                        setEditInstruction('')
                      }}
                      className="rounded-lg bg-surface/90 p-1.5 text-ink-700 hover:bg-surface"
                      title="Edytuj z AI"
                    >
                      <Wand2 size={15} />
                    </button>
                    <button onClick={() => download(id)} className="rounded-lg bg-surface/90 p-1.5 text-ink-700 hover:bg-surface" title="Pobierz">
                      <Download size={15} />
                    </button>
                    <button onClick={() => removeGenerated(id)} className="rounded-lg bg-surface/90 p-1.5 text-red-600 hover:bg-surface" title="Usuń">
                      <Trash2 size={15} />
                    </button>
                  </div>
```

- [ ] **Step 5: Add the edit modal** — just before the final closing `</div>` of the component's returned tree (after the `lg:grid-cols-[360px_1fr]` grid div closes), add:

```tsx
      <Modal
        open={editTarget !== null}
        onClose={() => {
          if (!editBusy) setEditTarget(null)
        }}
        size="md"
        title="Edytuj zdjęcie z AI"
        footer={
          <div className="flex items-center justify-between gap-2">
            {editBusy ? (
              <Button variant="ghost" onClick={() => editController?.abort()}>
                <X size={16} /> Anuluj
              </Button>
            ) : (
              <span />
            )}
            <Button onClick={runEdit} disabled={editBusy || !editInstruction.trim()}>
              {editBusy ? <Loader2 size={16} className="animate-spin-slow" /> : <Wand2 size={16} />}
              Generuj (≈ ${editCost})
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <FullImage
              imageId={editTarget ?? undefined}
              className="h-24 w-auto rounded-xl object-cover"
            />
            <p className="text-sm text-ink-500">
              Opisz, co zmienić. Reszta zdjęcia (modelka, ubranie, kadr) zostanie bez zmian.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {EDIT_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setEditInstruction(p.instruction)}
                className="rounded-full bg-ink-100 px-3 py-1.5 text-xs font-medium text-ink-700 transition hover:bg-ink-200"
              >
                {p.label}
              </button>
            ))}
          </div>

          <Field label="Co zmienić?">
            <TextArea
              rows={3}
              value={editInstruction}
              onChange={(e) => setEditInstruction(e.target.value)}
              placeholder="np. zmień tło na jasne studio, rozjaśnij światło…"
            />
          </Field>

          <p className="text-xs text-ink-400">
            Powstanie nowe zdjęcie obok oryginału (oryginał zostaje). Płatne API ≈ ${editCost}.
          </p>
        </div>
      </Modal>
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS — no unused imports, all types satisfied.

- [ ] **Step 7: Commit**

```bash
git add src/pages/PhotoStudio.tsx
git commit -m "feat(photo): edit an already-generated photo with AI (per-cell Edytuj z AI)"
```

---

### Task 8: Full verification + dev-server smoke

**Files:** none (verification only).

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: PASS — all prior 407 + new tests (Tasks 1–5), 0 failures.

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run build`
Expected: PASS — `tsc -b` + `vite build` succeed.

- [ ] **Step 3: Dev-server smoke (project rule: exercise UI in the browser)**

Run: `npm run dev` and verify in the browser:
- A product with ≥1 generated photo shows a **Wand2** "Edytuj z AI" button in each generated cell's action bar (always visible on a narrow viewport, hover on desktop).
- Clicking it opens the modal with the source thumbnail, three preset chips, an empty text box, and a `Generuj (≈ $X.XXX)` button (disabled while the box is empty).
- A chip click pre-fills the box; the text remains editable.
- With a valid Gemini key: submitting produces a new cell **immediately to the right of** the source; the source is unchanged; the success toast fires; the cost counter (`imagesGenerated`) increments by 1.
- Cancel mid-edit shows "Anulowano edycję." and leaves all cells intact.
- (If key absent) submitting shows "Dodaj klucz API w Ustawieniach."
- Verify no regression in the existing **Generuj** (try-on/enhance) flow: it still appends generated photos and shows cost.

- [ ] **Step 4: Final commit (if any smoke-fix changes were needed)**

```bash
git add -A
git commit -m "test(photo): verify AI photo edit end-to-end"
```

---

## Self-Review

**Spec coverage** (every quality-bar item → task):
- Per-cell edit button, mobile-visible → Task 7 (Step 4), verified Task 8.
- Non-destructive new cell, adjacent to source → Tasks 5 (`insertAfterId` + `saveGeneratedToTarget`) + 7 (`insertAfter: editTarget`).
- Provenance (`editedFromId`, `editInstruction`, `sourceImageIds`) optional, no migration → Tasks 4 + 7.
- Output ≥2K, full source blob fed back, source-derived resolution → Tasks 1 (`resolutionForEdit`) + 7 (`toInline`, `resolution: editResolution`); post-save sub-2K warning → Task 7 Step 3.
- `aspectRatio` omitted to inherit shape → Task 7 Step 3 (no `aspectRatio` passed).
- Positive 5-slot `buildEditPrompt`, identity-lock only for try-on → Task 3.
- Cost surfaced, charge-on-success → Task 7 (cost on button; `bumpImageCount` after success only).
- Withheld-image safety outcome → Task 2 (`finishReasonError`) surfaces a distinct message via the existing `generateImage` throw path; counter not bumped (throws before `bumpImageCount`).
- Positive Polish preset chips that pre-fill → Task 3 (`EDIT_PRESETS`) + Task 7.
- Mid-edit cancel intact → Task 7 (`editController.abort()`).
- Shared-design no-orphan → Task 5 (integration test).
- Base64 size guard → Task 7 Step 3.
- No double-charge → Task 7 (`retryTimeout: false`).
- Pure functions unit-tested → Tasks 1, 2, 3, 5.

**Deferred to v2 (explicitly out of scope):** drift-nudge after N hops, stacking hints, a "2 warianty" toggle for edits, a ProductEditor deep-link/edit affordance, a richer chip set, face/expression presets, slider before/after compare.

**Type consistency:** `saveGeneratedToTarget(rawProduct, img, meta, opts)` and `resolutionForEdit(width, height)` and `buildEditPrompt({instruction, isTryOn})` and `EDIT_PRESETS[].instruction` names are used identically across Tasks 1–7. `GeneratedImageMeta.editedFromId/editInstruction` (Task 4) match their writes in Task 7.

**Placeholder scan:** none — every code step contains complete code.
