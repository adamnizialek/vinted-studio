# Automated Cloudflare Pages Deploy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitHub Actions workflow that builds, tests, migrates D1, and deploys `vinted-studio` to Cloudflare Pages Production on every push to `main`.

**Architecture:** A single workflow (`.github/workflows/deploy.yml`) runs the same steps a human runs locally (`npm ci` → `npm test` → `npm run build` → `wrangler d1 migrations apply` → `wrangler pages deploy`), authenticated via two GitHub repo secrets that Wrangler reads from the environment. A short `docs/deployment.md` documents the one-time token/secret setup. No app code, `wrangler.toml`, or existing scripts change.

**Tech Stack:** GitHub Actions, Node 24, npm, Wrangler 4 (Cloudflare Pages + D1), Vitest.

**Branch:** `chore/ci-auto-deploy` (already created; spec already committed there).

---

## File Structure

- **Create** `.github/workflows/deploy.yml` — the entire CI/CD pipeline. One responsibility: build + deploy on push to `main`.
- **Create** `docs/deployment.md` — human-facing runbook for the one-time Cloudflare API token + GitHub secrets setup, and how to verify/rollback.
- **No other files change.** `wrangler.toml`, `package.json` (`cf:deploy` kept as manual fallback), and `functions/` are untouched.

---

### Task 1: Add the deploy workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Write the workflow file**

Create `.github/workflows/deploy.yml` with exactly this content:

```yaml
name: Deploy to Cloudflare Pages

on:
  push:
    branches: [main]
  workflow_dispatch: {}

# A newer push cancels an in-flight production deploy so the latest commit wins.
concurrency:
  group: deploy-production
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test

      - name: Build
        run: npm run build

      - name: Apply D1 migrations
        run: npx wrangler d1 migrations apply DB --remote

      - name: Deploy to Cloudflare Pages
        run: npx wrangler pages deploy dist --project-name vinted-studio --branch main
```

- [ ] **Step 2: Validate the YAML parses**

Run (cross-platform, no install needed):

```bash
npx --yes js-yaml .github/workflows/deploy.yml > /dev/null && echo "YAML OK"
```

Expected: prints `YAML OK` with no parse error. (If `js-yaml` errors, the YAML is malformed — fix indentation and re-run.)

- [ ] **Step 3: Sanity-check the steps match the spec**

Confirm by eye the step order is: checkout → setup-node(24, cache npm) → `npm ci` → `npm test` → `npm run build` → `wrangler d1 migrations apply DB --remote` → `wrangler pages deploy dist --project-name vinted-studio --branch main`, and that `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` are set at job `env`. No code to run.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "feat(ci): auto-deploy to Cloudflare Pages on push to main

Build + test + D1 migrate + wrangler pages deploy, gated by vitest.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Add the deployment runbook

**Files:**
- Create: `docs/deployment.md`

- [ ] **Step 1: Write the runbook**

Create `docs/deployment.md` with exactly this content:

````markdown
# Deployment

Production (`vinted-studio` Cloudflare Pages) deploys **automatically** on every push to
`main` via `.github/workflows/deploy.yml`. The pipeline runs:
`npm ci` → `npm test` → `npm run build` → `wrangler d1 migrations apply DB --remote` →
`wrangler pages deploy`. A failing test, build, or migration stops the deploy — production
stays unchanged.

## One-time setup (required before the first auto-deploy)

The workflow authenticates to Cloudflare with two GitHub repo secrets. Set them once:

### 1. Create a Cloudflare API token
dash.cloudflare.com → **My Profile** → **API Tokens** → **Create Token** → **Custom token**:
- Permissions:
  - **Account → Cloudflare Pages → Edit**
  - **Account → D1 → Edit**
- Account Resources: **Include → Adam.nizialek1@gmail.com's Account**
- Create, then copy the token (shown once).

### 2. Add GitHub repository secrets
Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:
- `CLOUDFLARE_API_TOKEN` = the token from step 1
- `CLOUDFLARE_ACCOUNT_ID` = `23a85aea8c2d5ac5954eedd74cc46a88`

> Set both secrets **before** merging the workflow to `main`, so the first auto-deploy
> succeeds. If the workflow runs without them, it fails harmlessly at the Wrangler step
> and production is left untouched.

## Manual deploy / fallback
Still available locally:
```bash
npm run cf:deploy   # npm run build && wrangler pages deploy dist
```

## Verify a deploy
```bash
npx wrangler pages deployment list --project-name vinted-studio
```
The newest entry's source commit should match `main` HEAD.

## Rollback
Cloudflare keeps deployment history. In the dashboard
(Pages → vinted-studio → Deployments) pick a previous successful deployment →
**Rollback**. Or re-run the workflow from an earlier commit via **Run workflow**
(workflow_dispatch) on that ref.
````

- [ ] **Step 2: Validate the doc renders / has no broken fences**

Run:

```bash
node -e "const t=require('fs').readFileSync('docs/deployment.md','utf8'); const f=(t.match(/```/g)||[]).length; if(f%2)throw new Error('unbalanced code fences'); console.log('doc OK,',t.split('\n').length,'lines')"
```

Expected: prints `doc OK, <n> lines` (no thrown error).

- [ ] **Step 3: Commit**

```bash
git add docs/deployment.md
git commit -m "docs(ci): deployment runbook + one-time secret setup

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Open PR and hand off manual setup

**Files:** none (git/GitHub operations).

- [ ] **Step 1: Push the branch**

```bash
git push -u origin chore/ci-auto-deploy
```

Expected: branch published; a PR-create URL is printed.

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base main --head chore/ci-auto-deploy \
  --title "ci: auto-deploy to Cloudflare Pages on push to main" \
  --body "Adds .github/workflows/deploy.yml (build → test → D1 migrate → wrangler pages deploy on push to main) and docs/deployment.md.

Before merging: set repo secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (see docs/deployment.md). Merging this PR is itself the first auto-deploy."
```

Expected: prints the PR URL.

- [ ] **Step 3: Surface the manual steps to the user**

Tell the user, in chat, the two manual actions they must do **before merging** (cannot be automated — they require Cloudflare + GitHub UI / privileged tokens):
1. Create the Cloudflare API token (Pages:Edit + D1:Edit).
2. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repo secrets.

Then they merge the PR; the merge triggers the first automated production deploy. No commit in this step.

---

## Self-Review

**Spec coverage:**
- Workflow file, triggers (`push: main` + `workflow_dispatch`), concurrency → Task 1 ✓
- 7 sequential fail-fast steps incl. `npm test` gate, migrate-before-deploy → Task 1 ✓
- Env auth (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) → Task 1 `env:` ✓
- One-time token + secrets setup → Task 2 runbook + Task 3 hand-off ✓
- Error handling / fallback / rollback → Task 2 runbook ✓
- Verification (`wrangler pages deployment list`) → Task 2 runbook ✓
- "Set secrets before merge" ordering note (flagged in spec as implementation detail) → Task 2 + Task 3 ✓
- Non-goals (no PR previews, no wrangler.toml/script changes) → respected; only 2 files created ✓

**Placeholder scan:** none — full YAML and doc content inline.

**Type/identifier consistency:** binding `DB`, project `vinted-studio`, account `23a85aea8c2d5ac5954eedd74cc46a88`, secret names, and `--branch main` are identical across the workflow, runbook, and PR body.
