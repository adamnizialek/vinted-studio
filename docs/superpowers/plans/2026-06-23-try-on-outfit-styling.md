# Automatic Outfit Styling for Try-On Photos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When generating a try-on photo, the AI styles a complete, understated outfit around the hero garment so the product presents its best — while the product itself stays 100% faithful and the clear focal point.

**Architecture:** A single new helper `buildStylingClause(product)` in `src/lib/prompts.ts` returns a styling instruction string. It is inserted into the `tryOn` branch of `buildPhotoPrompt`, immediately after the existing `CRITICAL: preserve the garment exactly…` line. `enhance` mode is untouched. No new types, UI, DB, or changes to `gemini.ts`/`PhotoStudio.tsx`.

**Tech Stack:** TypeScript, Vitest (`vitest run`). Tests live beside source as `*.test.ts`. Path alias `@/` → `src/`.

## Global Constraints

- Hero garment must remain 100% faithful: do **not** alter the existing `CRITICAL: preserve the garment exactly as in the product photo…` line.
- Styling is **automatic** — no new UI controls, no new state, no changes to `PhotoStudio.tsx` or `src/db/types.ts`.
- Styling applies to `tryOn` mode only; `enhance` mode output must contain **no** styling text.
- The styling clause must be understated ("hero stays the star"): coordinating/neutral pieces, no loud/competing items — copy this intent verbatim from the helper below.
- Run a specific test file with: `npx vitest run src/lib/prompts.test.ts`.

---

### Task 1: Add automatic outfit styling to the try-on prompt

**Files:**
- Modify: `src/lib/prompts.ts` (add `buildStylingClause`; wire into the `tryOn` array in `buildPhotoPrompt`, after the `CRITICAL` line at ~line 249)
- Test: `src/lib/prompts.test.ts` (add `buildPhotoPrompt` import + a new `describe` block)

**Interfaces:**
- Consumes: `buildPhotoPrompt(input: PhotoPromptInput): string` (existing export); `Product` type from `@/db/types` (existing).
- Produces: `function buildStylingClause(p?: Product): string` — **file-private** (not exported). It returns a single-line string that always starts with `STYLING:`, contains `focal point` and `single item`, and includes ` (which is <color>)` only when `p.color` is non-empty.

- [ ] **Step 1: Write the failing tests**

In `src/lib/prompts.test.ts`, add `buildPhotoPrompt` to the existing import from `@/lib/prompts`:

```ts
import {
  buildDescriptionPrompt,
  buildPhotoPrompt,
  buildProductFacts,
  buildSeoTitle,
  DESCRIPTION_STYLES,
  styleById,
} from '@/lib/prompts'
```

Then append this `describe` block to the end of the file (it reuses the existing `product()` helper defined at the top of the file):

```ts
describe('buildPhotoPrompt — automatic outfit styling', () => {
  it('adds the styling clause and keeps the hero garment the focal point (tryOn)', () => {
    const prompt = buildPhotoPrompt({
      mode: 'tryOn',
      product: product({ name: 'sukienka', color: 'czerwona' }),
      sceneId: 'studio',
    })
    expect(prompt).toContain('STYLING:')
    expect(prompt).toContain('focal point')
    expect(prompt).toContain('single item')
  })

  it('weaves the product colour into the styling clause when present', () => {
    const prompt = buildPhotoPrompt({
      mode: 'tryOn',
      product: product({ name: 'sukienka', color: 'czerwona' }),
      sceneId: 'studio',
    })
    expect(prompt).toContain('(which is czerwona)')
  })

  it('omits the colour parenthetical when the product has no colour', () => {
    const prompt = buildPhotoPrompt({
      mode: 'tryOn',
      product: product({ name: 'sukienka' }),
      sceneId: 'studio',
    })
    expect(prompt).toContain('STYLING:')
    expect(prompt).not.toContain('(which is')
  })

  it('does not add styling in enhance mode', () => {
    const prompt = buildPhotoPrompt({
      mode: 'enhance',
      product: product({ name: 'sukienka', color: 'czerwona' }),
      sceneId: 'studio',
    })
    expect(prompt).not.toContain('STYLING:')
  })

  it('still preserves the hero garment exactly (tryOn)', () => {
    const prompt = buildPhotoPrompt({
      mode: 'tryOn',
      product: product({ name: 'sukienka' }),
      sceneId: 'studio',
    })
    expect(prompt).toContain('CRITICAL: preserve the garment exactly')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/prompts.test.ts`
Expected: the 4 new assertions that look for `STYLING:` / `(which is czerwona)` / `focal point` / `single item` FAIL (text not present yet). The `enhance` test and the `CRITICAL` test will already PASS — that is fine; the suite as a whole is RED.

- [ ] **Step 3: Add the `buildStylingClause` helper**

In `src/lib/prompts.ts`, add this function directly below the existing `describeGarment` function (~line 262):

```ts
function buildStylingClause(p?: Product): string {
  const heroColor = p?.color?.trim() ? ` (which is ${p.color.trim()})` : ''
  return [
    `STYLING: Beyond the hero garment, dress the model in a complete, well-coordinated outfit`,
    `chosen to flatter and complement THIS item${heroColor} — tasteful, understated pieces`,
    `(simple bottoms or top, plain shoes) in neutral or softly coordinating colours.`,
    `The complementary pieces must stay quiet and supporting: no loud prints, bold colours, large`,
    `logos or statement accessories that compete with the hero garment, which stays the clear focal`,
    `point. Do NOT copy the plain basics from the reference image — restyle the surrounding clothing`,
    `freshly (the reference is ONLY for the person's identity, not their clothes). Keep accessories`,
    `minimal. It must stay obvious that the hero garment is the single item being presented.`,
  ].join(' ')
}
```

- [ ] **Step 4: Wire the clause into the try-on prompt**

In `buildPhotoPrompt`, inside the `tryOn` return array, insert one line **immediately after** the `CRITICAL: preserve the garment exactly…` element and **before** `scene`:

```ts
    'CRITICAL: preserve the garment exactly as in the product photo — same colour, print, pattern, texture, cut, length and all details. Fit it naturally on the body with realistic folds and draping.',
    buildStylingClause(input.product),
    scene,
```

(The existing `.filter(Boolean).join('\n')` stays as-is; `buildStylingClause` always returns a non-empty string, so it is never filtered out.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/prompts.test.ts`
Expected: PASS (all tests in the file green, including the 5 new ones).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/prompts.ts src/lib/prompts.test.ts
git commit -m "feat(photo): auto-style a flattering outfit around the hero garment

In try-on mode buildPhotoPrompt now adds an understated styling clause so the
model wears a coordinated look around the product; hero stays 100% faithful and
the clear focal point. Enhance mode unchanged. Adds buildPhotoPrompt tests.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Helper `buildStylingClause` + insertion after `CRITICAL`, before `scene` → Steps 3–4. ✓
- Colour woven in via `describeGarment`/`product.color` → `heroColor` parenthetical, Step 3. ✓
- tryOn-only; enhance unchanged → enhance branch untouched; test in Step 1. ✓
- No UI/types/DB/gemini.ts changes → only `prompts.ts` + its test modified. ✓
- Custom-notes escape hatch → already wired via `input.customNotes`; no change needed (non-goal honoured). ✓
- Tests: styling present + hero-focal; colour present/absent; enhance excludes; CRITICAL intact → 5 tests in Step 1 map to spec tests 1–4. ✓

**Placeholder scan:** No TBD/TODO; all code and commands are concrete. ✓

**Type consistency:** `buildStylingClause(p?: Product)` is file-private and matches its single call site `buildStylingClause(input.product)` where `input.product?: Product`. Import addition (`buildPhotoPrompt`) matches its usage in tests. Assertion strings (`STYLING:`, `focal point`, `single item`, `(which is czerwona)`, `CRITICAL: preserve the garment exactly`) all map to literal substrings produced by the helper or the existing prompt. ✓
