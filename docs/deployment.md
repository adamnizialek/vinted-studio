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
