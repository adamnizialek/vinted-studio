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
> succeeds. If the workflow runs without them, both Wrangler steps (D1 migrate and Pages
> deploy) fail at the authentication check — no migrations are applied and nothing is
> deployed, so production is left untouched.

## Manual deploy / fallback
Still available locally:
```bash
npm run cf:deploy   # npm run build && wrangler pages deploy dist
```
Note: `cf:deploy` does **not** apply D1 migrations. If the release includes schema
changes, run `npm run db:migrate` first.

## Verify a deploy
```bash
npx wrangler pages deployment list --project-name vinted-studio
```
The newest entry's source commit should match `main` HEAD.

## Rollback
Fastest path — Cloudflare dashboard: Pages → vinted-studio → Deployments → pick a
previous successful deployment → **Rollback** (serves that build immediately; does not
touch git or D1).

Code-level rollback: `git revert <bad-commit>` and push to `main` — the workflow
redeploys the reverted state automatically. Use this when you want `main` and production
to match. Note: neither path undoes an already-applied D1 migration; write a new forward
migration if the schema needs reverting.
