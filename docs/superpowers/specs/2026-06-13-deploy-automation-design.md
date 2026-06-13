# Design: Automated Cloudflare Pages deploy via GitHub Actions

**Date:** 2026-06-13
**Status:** Approved (pending spec review)

## Problem

The `vinted-studio` Cloudflare Pages project has **no automatic deployment**. Deploys
only happen when someone runs `wrangler pages deploy` by hand (`npm run cf:deploy`).
As a result, production drifted many commits behind `main`: the live build was pinned
to `2436865` while `main` was at `23f4e3e`, missing per-account sales import, dark mode,
and magazyn inline editing. Pushing to GitHub does nothing on Cloudflare today.

## Goal

Every push/merge to `main` automatically builds and deploys the current code to the
`vinted-studio` Cloudflare Pages **Production** environment, applying any pending D1
migrations first, gated by the test suite so a broken `main` never ships.

## Non-goals

- PR preview deployments (production-only for now).
- Separate staging/preview D1 or R2 resources.
- Changing the app build, `wrangler.toml`, bindings, or the existing `cf:deploy` script
  (kept as a manual fallback / rollback tool).

## Approach

A single GitHub Actions workflow runs the same steps a human would, in CI, on every push
to `main`. Chosen over Cloudflare's dashboard Git integration because it is fully
version-controlled, lets us run D1 migrations before deploy (Git integration does not),
and requires no manual dashboard build configuration.

## Component: `.github/workflows/deploy.yml`

### Triggers
- `push` to `main` — the primary trigger.
- `workflow_dispatch` — a manual "Run workflow" button for re-deploys / rollbacks.
- `concurrency: { group: deploy-production, cancel-in-progress: true }` — a newer push
  cancels an in-flight deploy so the latest commit always wins.

### Job (`ubuntu-latest`)
Steps run sequentially, fail-fast. If any step fails, **no deploy happens**.

1. `actions/checkout@v4`
2. `actions/setup-node@v4` with `node-version: 24` (matches local v24.13.1) and `cache: npm`
3. `npm ci` — lockfile-exact install (`package-lock.json` present)
4. `npm test` — vitest gate. A failing test blocks the deploy.
5. `npm run build` — `tsc -b && vite build`; also serves as the typecheck.
6. `npx wrangler d1 migrations apply DB --remote` — apply pending migrations (append-only,
   idempotent; already-applied ones are skipped). Runs **before** deploy so schema is ready
   when new code goes live.
7. `npx wrangler pages deploy dist --project-name vinted-studio --branch main` — uploads
   `dist/` + the `functions/` Pages Functions; `--branch main` marks it Production.

### Environment / auth
Wrangler reads these from env automatically (set at job level):
- `CLOUDFLARE_API_TOKEN` — from GitHub secret `secrets.CLOUDFLARE_API_TOKEN`.
- `CLOUDFLARE_ACCOUNT_ID` — from GitHub secret `secrets.CLOUDFLARE_ACCOUNT_ID`
  (value: `23a85aea8c2d5ac5954eedd74cc46a88`).

No other wrangler config is needed; `wrangler.toml` supplies project name, D1 (`DB`),
and R2 (`BUCKET`) bindings.

## One-time manual setup (done by the user, documented in the implementation)

1. **Create a Cloudflare API token** (dash.cloudflare.com → My Profile → API Tokens →
   Create Token → Custom token) with:
   - *Account → Cloudflare Pages → Edit*
   - *Account → D1 → Edit*
   - Account resources scoped to `Adam.nizialek1@gmail.com's Account`.
2. **Add GitHub repo secrets** (repo → Settings → Secrets and variables → Actions →
   New repository secret):
   - `CLOUDFLARE_API_TOKEN` = the token from step 1
   - `CLOUDFLARE_ACCOUNT_ID` = `23a85aea8c2d5ac5954eedd74cc46a88`

R2 permissions are not required — deploy does not touch R2.

## Data flow

```
push to main
   └─ GitHub Actions: checkout → npm ci → npm test → npm run build
        └─ wrangler d1 migrations apply DB --remote   (schema first)
             └─ wrangler pages deploy dist --branch main   (Production live)
```

## Error handling

- Test, build, or migration failure → workflow stops, **production unchanged**.
- Rapid successive pushes → `concurrency` cancels the superseded run.
- Migrations are append-only and idempotent, so a re-run (e.g. manual `workflow_dispatch`)
  is safe and does not re-apply existing migrations.
- Manual fallback preserved: `npm run cf:deploy` still works locally, and Cloudflare keeps
  deployment history for one-click rollback.

## Verification

- Validate workflow YAML syntax before commit (`actionlint` if available, else a YAML parse).
- After secrets are set, confirm the first run on a no-op push to `main` reaches a green
  "deploy" step and that `wrangler pages deployment list` shows a new deployment whose
  source commit matches `main` HEAD.

## Risk note

This automates **production**: every merge to `main` is live within ~2 minutes. `main`
must stay deployable; the `npm test` gate (step 4) is the guardrail.
