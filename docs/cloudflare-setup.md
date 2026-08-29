# Cloudflare setup & deploy — Vinted Studio cross-device sync

The app hosts as a static Cloudflare Pages site with same-origin API Functions backed by
D1 (metadata + thumbnails) and R2 (image blobs). Everything below fits the free tier.

> **One caveat:** activating **R2** may require adding a billing profile (sometimes a card)
> to your Cloudflare account. Usage stays $0 at this scale and R2 egress is always free.
> Pages / D1 / Functions do not require this.

## 1. One-time cloud resources (needs your Cloudflare login)

```bash
# Authenticate the CLI (opens a browser)
npx wrangler login

# Create the D1 database — copy the printed database_id into wrangler.toml
npx wrangler d1 create vinted-studio

# Create the R2 bucket (name must match wrangler.toml: vinted-studio-images)
npx wrangler r2 bucket create vinted-studio-images
```

Edit `wrangler.toml` and replace `database_id = "REPLACE_AFTER_d1_create"` with the id printed above.

Apply the schema to the **remote** D1:

```bash
npm run db:migrate          # wrangler d1 migrations apply DB --remote
```

## 2. Set the sync token (the app's auth)

Generate a long random token and store it as a Pages secret:

```bash
# Generate one, e.g.:  openssl rand -hex 32
npx wrangler pages secret put SYNC_TOKEN
# paste the token when prompted
```

Keep this token — you paste it once per device in the app (Settings → Synchronizacja).

### Letting someone else sync on YOUR deployment

`SYNC_TOKEN` is the **owner** token. Anyone holding it sees the owner's data, so never hand
it out. To give another person sync without them creating a Cloudflare account, add their own
token to `SYNC_TOKENS` (comma-separated). Each token gets a **fully isolated data space** —
separate D1 rows, separate R2 objects, invisible to every other token.

```bash
# One random token per person, e.g.:  openssl rand -hex 32
npx wrangler pages secret put SYNC_TOKENS
# paste ALL guest tokens at once, comma-separated:  tok_kolega,tok_ktos_inny
```

No CLI? Same thing in the browser: **Workers & Pages → project → Settings → Variables and
Secrets → Add**, environment **Production**, tick **Encrypt**. Note that Cloudflare never
shows a secret's value again after saving, so keep your own copy of the tokens you hand out.

> **A secret only takes effect on the next deployment.** Until you redeploy, the guest's
> token is rejected with `401` and the app tells them the server does not know it yet.
> Trigger one with `gh workflow run deploy.yml` (or any push to `main`).

Send that person only *their* token. They open the app → **Ustawienia → Synchronizacja** →
paste → **Połącz**. Nothing else on their side. Revoking = removing the token from the list
and re-running the command (their rows stay in D1 until you delete them).

> Their storage counts against **your** free tier (R2 10 GB, D1 500 MB). Fine for a handful of
> people; see “Free-tier capacity” below.

## 3. Deploy

**Apply migrations before deploying** — the Functions query the `space` column added in
`0004_sync_spaces.sql`, so a deploy that runs ahead of the migration answers `/api/sync`
with HTTP 500 until you migrate. (The GitHub Actions workflow already does it in this
order; only manual deploys need care.)

```bash
npm run db:migrate          # FIRST — schema (adds `space` to every table)
npm run cf:deploy           # THEN — builds dist/ and deploys Pages + Functions
```

First deploy will prompt to create/link the Pages project (name: `vinted-studio`).

## 4. Use it

1. Open the deployed URL on your **main** device, go to **Ustawienia**.
2. Paste your **Gemini key** (as before — stays device-local) and your **sync token**, press **Połącz**.
   - This seeds all existing local data to the cloud (one-time) and starts syncing.
3. On a **second** device, open the same URL → Ustawienia → paste the **same sync token** → Połącz.
   - Products, sales, models and thumbnails appear immediately; full images stream from R2 on open.

## Local development

```bash
# Apply schema to the LOCAL emulated D1
npx wrangler d1 execute DB --local --file=migrations/0001_init.sql

# Provide tokens for local runs (gitignored). SYNC_TOKENS is optional — use it to
# exercise the multi-person path (each guest token gets its own isolated space).
printf 'SYNC_TOKEN=devtoken\nSYNC_TOKENS=guesttoken\n' > .dev.vars

# Build + run Pages + Functions with local D1/R2 emulation
npm run cf:dev              # http://127.0.0.1:8788
```

## Manual two-device verification checklist

- [ ] Create a product on device A → it appears on device B after a sync.
- [ ] Open the product on B → the full image lazy-loads from R2 (grid thumbnails were instant).
- [ ] Edit on B, delete on A → both changes propagate (last-write-wins; deletes via tombstone).
- [ ] Make edits on A while offline → they reconcile when A reconnects.
- [ ] Confirm the Gemini key entered on A is **not** present on B (it is never synced).
- [ ] Connect a **guest** token on device C → it starts empty and never sees A/B's products.
- [ ] Create a product on C → it does **not** appear on A or B.

## Free-tier capacity

R2 holds ~2,000–3,000 products (10 GB, $0 egress) before any cost; D1 (500 MB) and Workers
(100k req/day) are never in danger at single-user scale. See the design spec §12.
