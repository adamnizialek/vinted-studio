# Automatic outfit styling for try-on photos

**Date:** 2026-06-23
**Status:** Approved — ready for implementation plan
**Scope:** Single-file prompt enhancement + tests

## Problem

When generating a "product on a model" (try-on) photo, the studio drops the hero
garment onto the model but says nothing about the *rest* of the outfit. The model
keeps the plain "t-shirt and jeans" basics it was generated in (or Gemini invents
arbitrary surrounding pieces). The product is never styled into a coordinated look,
so it presents worse than it could.

The user wants the model's whole outfit **adjusted to the product**: the AI should
style a complete, flattering look around the hero item so it is presented in the
best possible way — while the product itself stays exactly as photographed.

## Current behaviour (baseline)

`src/lib/prompts.ts` → `buildPhotoPrompt(input)` (lines ~218–257), `tryOn` branch:

1. "Photorealistic virtual try-on."
2. Use reference image(s) as the model, clothing item(s) as following input(s).
3. Generate the same person — preserve face/identity/hair/skin/proportions — now
   wearing `${garment}` (`describeGarment` = `this {color} {brand} {name}`).
4. Optional model `appearance` + `promptNotes`.
5. `CRITICAL: preserve the garment exactly as in the product photo…`.
6. `scene` (one of 5 `SCENE_PRESETS` — background/lighting/pose only).
7. Framing/orientation + photorealism line.
8. "genuine second-hand clothing listing photo. No text/watermark/logos."
9. Optional `customNotes`.

There is **no styling axis** and **no test coverage** for `buildPhotoPrompt`
(`src/lib/prompts.test.ts` covers description prompts and `styleById`, not photos).

## Decisions (from brainstorming)

1. **Automatic stylist** — always-on, no new UI. Every try-on comes out styled.
2. **Flatter, hero stays the star** — complementary pieces are understated and
   coordinating (mostly neutral), so it is always obvious which single item is for
   sale. This matters specifically for resale: on Vinted you list one item, and a
   loud full look could make a buyer think the shoes/bag are included.
3. Applies to **`tryOn` mode only**; `enhance` (background cleanup) is unchanged.

## Approach

**Chosen: A — generic, photo-grounded stylist clause.**

Add one styling paragraph to the try-on prompt. Gemini already receives the product
photo(s) as input, so it *sees* the garment type; we do not branch on `category`.
The whole change lives in `src/lib/prompts.ts`. No new types, no UI, no DB, no
changes to `gemini.ts` or `PhotoStudio.tsx`.

Rejected alternatives:

- **B — category-aware styling map** (top→bottoms+shoes, dress→shoes, …). `category`
  is free-text Polish, brittle to parse, and redundant since Gemini sees the photo.
- **C — two-pass (text "styling brief" → image).** Doubles latency/cost and adds a
  failure mode for an understated look. Overkill.

## Implementation

### New helper in `src/lib/prompts.ts`

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

### Insertion point

Insert the clause into the `tryOn` array **immediately after** the existing
`CRITICAL: preserve the garment exactly…` line and **before** `scene`, so the
"hero locked / surrounding pieces styled" contrast sits adjacent:

```ts
    'CRITICAL: preserve the garment exactly as in the product photo — same colour, print, pattern, texture, cut, length and all details. Fit it naturally on the body with realistic folds and draping.',
    buildStylingClause(input.product),   // <-- new line
    scene,
```

The `.filter(Boolean).join('\n')` already in place keeps formatting consistent;
`buildStylingClause` always returns a non-empty string so it is never filtered out.

### Three properties this guarantees

1. **Hero stays 100% faithful** — the `CRITICAL` preservation clause is untouched;
   styling explicitly targets only the *surrounding* pieces.
2. **Reference de-coupling** — the clause states the reference image is for *identity
   only*, not clothing, so the model's plain basics are restyled rather than copied.
   This is the one real risk (strong identity-lock could otherwise drag the basics
   along), so the wording calls it out directly.
3. **Per-variant variety is free** — the understated-but-open instruction lets each
   of the 2–4 variants come out slightly differently coordinated, giving options. No
   extra code.

## Escape hatch (no new UI)

The existing **custom-notes** field is the per-photo override. Typing e.g.
"plain studio basics, no styling" appends to the prompt and lets the user opt out of
styling for a specific generation. This is already wired through
`input.customNotes` and needs no change.

## Testing

Add `buildPhotoPrompt` cases to `src/lib/prompts.test.ts`:

1. **Try-on includes styling** — `tryOn` prompt contains the styling clause
   (`STYLING:`) and the hero-focal wording ("focal point" / "single item").
2. **Colour woven in** — when `product.color` is set, the clause contains
   `(which is <color>)`; when absent, it does not contain `(which is`.
3. **Enhance excludes styling** — `enhance` mode prompt does **not** contain
   `STYLING:`.
4. **Hero preservation intact** — try-on prompt still contains the
   `CRITICAL: preserve the garment exactly` line.

## Non-goals

- No new UI controls (styling is automatic per the decision above).
- No "style vibe" selector, no editorial/bold mode, no seasonality logic.
- No changes to `enhance` mode, types, DB, `gemini.ts`, or `PhotoStudio.tsx`.
- No category-based branching.

## Files touched

- `src/lib/prompts.ts` — add `buildStylingClause`, wire into `tryOn` branch.
- `src/lib/prompts.test.ts` — add the four `buildPhotoPrompt` cases above.
