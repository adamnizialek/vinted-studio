# Dark Mode — Design Spec

**Date:** 2026-06-13
**Status:** Approved (design)

## Goal

Add dark mode to Vinted Studio. The theme **follows the operating system** via
`prefers-color-scheme` — there is **no in-app toggle, no settings field, no sync, and
no JavaScript theme state**. Switching the OS appearance flips the whole app live.

## Why this approach

The palette is already disciplined: one neutral ramp (`ink-50` … `ink-950`) plus the
`brand` teal. Light mode uses the *low* end of `ink` for backgrounds and the *high* end
for text. So instead of editing ~306 color-utility usages across 16 files, we make the
`ink` ramp **CSS-variable-backed** and **flip the variables** in a single
`@media (prefers-color-scheme: dark)` block. ~95% of the UI inverts automatically.

Rejected alternatives:
- **`dark:` on every utility** — ~306 edits, error-prone, doubles class soup. No.
- **Full semantic token system** (`surface`/`text`/`muted`/`border` everywhere) —
  cleanest long-term vocabulary but a much larger refactor than this task warrants. YAGNI.

## Components / changes

### 1. `tailwind.config.js`
- Convert every `ink-*` entry to the CSS-variable form so opacity modifiers keep working:
  `ink: { 50: 'rgb(var(--ink-50) / <alpha-value>)', … 950: 'rgb(var(--ink-950) / <alpha-value>)' }`.
- Add one new semantic token, `surface`, also var-backed:
  `surface: 'rgb(var(--surface) / <alpha-value>)'` — used for "white card/panel" backgrounds.
- `brand` stays literal (teal reads well on dark). Optional later: brighten brand by ~one
  step in dark; not required for v1.

CSS variables hold **space-separated RGB channels** (e.g. `--ink-50: 246 247 249`) so the
`rgb(var(--x) / <alpha-value>)` form and Tailwind opacity modifiers both work.

### 2. `src/index.css`
- `:root` — define `--ink-50 … --ink-950` at today's values, `--surface: 255 255 255`,
  and keep `color-scheme: light`. Also expose `--checker: 236 238 242` for the `.checker`
  pattern.
- `@media (prefers-color-scheme: dark)` — override the ramp with the **tuned dark scale
  below** (a *role inversion*, not a naive numeric invert: backgrounds go dark, text goes
  light, and mid-tone muted text stays legible), set `--surface` to a dark elevated panel,
  set `--checker` to a dark value, and set `color-scheme: dark` so native scrollbars,
  inputs, and date pickers adapt.
- Update the component classes that currently hardcode `bg-white` to use `bg-surface`:
  `.card`, `.btn-ghost`, `.input` (and `focus:bg-white` → `focus:bg-surface` on `.input`).
- Update `.checker` to use `rgb(var(--checker))` instead of the literal `#eceef2`.

Proposed dark ramp (RGB channels; tunable during implementation):

| Token   | Light (current)   | Dark (proposed)     | Primary role                         |
|---------|-------------------|---------------------|--------------------------------------|
| ink-50  | 246 247 249       | 19 22 28           | canvas / body background             |
| ink-100 | 236 238 242       | 27 31 39           | subtle fills, hover, hairline border |
| ink-200 | 212 217 225       | 38 43 53           | borders, rings                       |
| ink-300 | 174 183 198       | 51 58 70           | stronger borders                     |
| ink-400 | 130 144 165       | 138 151 171        | muted text / icons                   |
| ink-500 | 99 113 137        | 164 175 193        | secondary text                       |
| ink-600 | 78 90 112         | 184 193 208        | secondary text (stronger)            |
| ink-700 | 64 73 91          | 204 211 222        | body text                            |
| ink-800 | 55 62 77          | 221 226 234        | headings                             |
| ink-900 | 31 36 46          | 238 241 245        | primary text                         |
| ink-950 | 19 22 28          | 246 247 249        | highest-contrast text                |
| surface | 255 255 255       | 30 35 44           | cards / panels                       |
| checker | 236 238 242       | 38 43 53           | transparency checkerboard            |

### 3. Hand-touched spots (the ~5% that don't auto-flip)
- **`bg-white` → `bg-surface`** across pages/components (~11 usages) and the three
  component classes above.
- **`text-white`** on colored buttons stays `text-white` (correct on dark).
- **Soft pastel tints** that would glow on dark — `bg-amber-50`, `bg-red-50`,
  `bg-brand-50` and any matching soft border/text pairings (~12 spots): add a `dark:`
  variant per spot, e.g. `bg-amber-50 dark:bg-amber-950/40`,
  `text-amber-700 dark:text-amber-300`. (Tailwind's default `darkMode: 'media'` emits
  these under the same media query — no config change needed.)
- **Dashboard chart** (`src/pages/Dashboard.tsx`, the one Recharts block) currently uses
  five hardcoded hex values (`#eceef2` grid, `#8290a5` axes, `#f6f7f9` cursor,
  `#eceef2` tooltip border, `#0b9b82` bar). Replace with theme-aware colors from a small
  hook `useThemeColors()` that reads the resolved CSS vars via
  `getComputedStyle(document.documentElement)` and recomputes on a
  `matchMedia('(prefers-color-scheme: dark)')` change event. The bar stays brand teal.

### 4. No new runtime state
No settings field, no Zustand changes, no Dexie/D1 migration, no toggle UI. The Layout
shell needs no structural change — its `ink`/`brand`/`surface` classes flip automatically.

## Data flow
None added. Theme resolution is pure CSS (`@media` + custom properties). The only JS that
reads the theme is `useThemeColors()`, used solely to feed colors into Recharts (which
takes color strings as props and can't consume CSS classes).

## Error handling / edge cases
- **Opacity modifiers** (`/40`, `/60`, etc.) keep working because vars store RGB channels
  consumed via `rgb(var(--x) / <alpha-value>)`.
- **Native widgets** (scrollbars, file inputs, date pickers) adapt via `color-scheme: dark`.
- **Images / generated photos** are unaffected; the `.checker` backdrop behind transparent
  images darkens so previews stay legible.
- **Browsers without `prefers-color-scheme`** fall back to `:root` = light. Safe default.

## Testing
- **Unit/smoke:** a test asserting the built CSS (or `index.css` source) defines the dark
  media block with the key `--ink-*` / `--surface` overrides and `color-scheme: dark`.
- **Manual verification:** toggle OS appearance (Windows Settings → Colors) and confirm
  Dashboard (incl. chart), Inventory, PhotoStudio (incl. checker backdrop), Settings, and
  at least one modal (e.g. Import) render correctly in both themes — no white flashes,
  legible muted text, readable pastel callouts.

## Out of scope (v1)
- In-app Light/Dark/System toggle and persisted preference.
- Per-device or synced theme.
- Brand-color tuning for dark (optional polish, can follow later).
