# Measurement — Option A follow-up (evidence for the next L investment)

Companion to `which-feature-to-improve.md`. Produced after shipping the verified-correctness
bundle. Two questions the brief told us to answer before any large spend.

## Q1 — Does a 2K request now persist at ≥2K, end-to-end? **YES (verified).**

Byte-level trace (confirmed by an independent reviewer + a behavioral test):

```
Gemini generateImage → {mime, base64}  (typically PNG, no EXIF orientation)
  → addGeneratedImage(base64, mime, …)        src/lib/images.ts
  → base64ToBlob (byte-exact, no recompression)
  → processImage(raw, { preserveResolution: true })
      → returns { blob: <the raw blob, untouched>, width/height from decode, thumb: 320px JPEG }
  → ImageRecord.blob = exact Gemini bytes  → FullImage display + download (correct extension)
```

The raw blob is **never** routed through `drawToCanvas`/`canvasToBlob`, so the old
`MAX_DIM=1600` clamp and `JPEG@0.92` re-encode are both bypassed for paid output.

| | Before (bug) | After (this bundle) |
|---|---|---|
| 2048px Gemini output, stored width | **1200px** (clamped to 1600 long-side, then aspect) | **2048px** |
| Main blob | canvas re-encode, JPEG q0.92 (lossy) | original bytes, **identity** (lossless) |
| 4K tier | non-functional (destroyed to ≤1600) | preserved |
| Thumbnail | 320px JPEG | 320px JPEG (unchanged) |

Test proof (`src/lib/images.test.ts`): with a decoded 2048×2731 bitmap and a 5000-byte raw
payload, the stored record has `width===2048`, `height===2731`, `blob.size===5000` (== input ⇒
no re-encode). The RED run before the fix produced `1200` — the bug, reproduced and then fixed.
Restores the documented ≥2K reason-for-being at **zero API cost**.

## Q2 — Is try-on quality prompt-bound or model-bound? **Largely MODEL-BOUND.**

Inspected `buildPhotoPrompt` (`src/lib/prompts.ts`). The try-on prompt already implements the
best practices the brief cited for Nano-Banana-class models:

- **Role separation** — model reference(s) declared as the FIRST input, garment as the
  following input(s).
- **Explicit identity-preservation** — "keep their face, identity, hair, skin tone and body
  proportions perfectly consistent with the reference."
- **Explicit garment preserve-list** — "preserve the garment exactly … same colour, print,
  pattern, texture, cut, length and all details."
- Scene/aspect control, anti-text/anti-watermark, anatomy/hands guidance.

→ The prompt is already at/near the structural ceiling of what prompting can do. The brief's
cited evidence (arxiv 2509.17654) attributes garbled logos/prints and identity drift to the
**model capability ceiling**, not missing prompt structure. So a prompt-only revamp (Option B's
"prompt fidelity" pillar) has **little headroom** — it would likely barely move the regen rate.

### Evidence-led recommendation for the next (L) step
1. **Do not bet on prompt rewording.** The role-separation + preserve-list structure is already
   present; further prose tuning is marginal.
2. **Highest-leverage levers are model-side**, not prompt-side: try a more capable image model
   when available; improve/curate reference images (count, angles, lighting).
3. **New, cheap A/B now available:** this bundle preserves model reference images at full
   resolution. They are also fed back as try-on *inputs* (`PhotoStudio.toInline` sends the stored
   blob un-resized). So you can A/B **full-res vs downscaled references** for identity fidelity —
   genuinely cheap to test (output billing is unchanged).
4. **Conscious-accept / watch item:** because of (3), try-on input payload for model references
   grew (garment/product inputs are still ≤1600px). Output cost (the billed ~$0.039/img) is
   unchanged and Gemini caps input-image tokens, so the delta is expected to be ~negligible — but
   measure input-token cost in the A/B before committing to always-full-res references.
5. Option B's batching/cost pillar remains illusory (per brief: `candidateCount` doesn't cut
   per-image output billing; the "50% off" is the async Batch API, incompatible with interactive
   variant UX). Don't fund the L revamp on it.

**Bottom line:** the certain win (≥2K preservation) is shipped and verified. The flashy L revamp
(B) should be scoped as a **model/reference experiment**, not a prompt rewrite — and the full-res
reference A/B is the first, cheapest experiment to run.
