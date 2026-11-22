# Deploying EdgeWatch to Cloudflare

Status: the scripts below have been exercised with `--dry-run` and against a stubbed `wrangler`, **not against a real Cloudflare account**.
Nothing from this branch is deployed, and the resource IDs in `workers/*/wrangler.jsonc` are placeholders
(`REPLACE_WITH_KV_NAMESPACE_ID`, `REPLACE_WITH_D1_DATABASE_ID`) until you run the setup script.

## Prerequisites

- Node 22+ and pnpm 9 (`pnpm install` at the repo root).
- A Cloudflare account with Workers Paid (Queues require it), and either `npx wrangler login` or `CLOUDFLARE_API_TOKEN`
  (+ `CLOUDFLARE_ACCOUNT_ID`) with Workers, KV, D1, R2, Queues and Pages edit permissions.

## 1. Create resources and write IDs into wrangler configs

```bash
node scripts/cf-setup.mjs --dry-run   # print what would be created
node scripts/cf-setup.mjs             # create or reuse, then write IDs
```

Creates (or reuses by name): KV namespace `edgewatch-api-keys`, D1 database `edgewatch`, R2 bucket `edgewatch-traces`,
queues `edgewatch-ingest` and `edgewatch-ingest-dlq`. Writes the KV id and D1 id into all three `workers/*/wrangler.jsonc`
and sets the `TOKEN_SIGNING_SECRET` secret on `edgewatch-ingest` if missing. Names can be overridden with
`EDGEWATCH_KV_TITLE`, `EDGEWATCH_D1_NAME`, `EDGEWATCH_R2_BUCKET`, `EDGEWATCH_QUEUE`, `EDGEWATCH_DLQ`.
Commit the updated configs (IDs are not secrets).

The `ratelimits` binding in `workers/ingest/wrangler.jsonc` uses `namespace_id: "1001"`; pick any integer unique within your account.

## 2. Apply D1 migrations

```bash
scripts/d1-migrate.sh --remote    # refuses to run while the D1 placeholder is still present
scripts/d1-migrate.sh --local     # local wrangler dev state
```

## 3. Deploy the Workers

```bash
scripts/deploy.sh workers         # consumer, then ingest, then api (wrangler deploy in each)
```

Each Worker can also be deployed alone: `cd workers/<name> && npx wrangler deploy`.
Optional ingest vars: `TOKEN_TTL`, `MAX_BODY_BYTES`, `RATE_LIMIT_PERIOD`, `INGEST_URL` (public ingest URL if behind a custom domain).
API var: `CORS_ORIGIN` (default `*`; set it to the dashboard origin).

## 4. Create API keys

```bash
pnpm --filter @edgewatch/ingest create-key my-app ingest server --remote    # NIGHTWATCH_TOKEN / EDGEWATCH_TOKEN
pnpm --filter @edgewatch/ingest create-key my-app read dashboard --remote   # VITE_API_KEY
pnpm --filter @edgewatch/ingest create-key my-app browser web --remote      # @edgewatch/browser key (public)
```

## 5. Deploy the dashboard (Cloudflare Pages)

```bash
VITE_API_URL=https://edgewatch-api.<subdomain>.workers.dev VITE_API_KEY=ew_read_... VITE_PROJECT_ID=my-app \
  scripts/deploy.sh dashboard
```

Builds `apps/dashboard` and runs `wrangler pages deploy` to project `edgewatch-dashboard` (`EDGEWATCH_PAGES_PROJECT` to change).
`public/_redirects` provides SPA routing. **The read key is embedded in the static bundle**: put the dashboard behind
Cloudflare Access (or similar) until real dashboard auth exists.

## 6. Point applications at it

See [nightwatch-migration.md](nightwatch-migration.md).

## Operations notes

- Over-quota block: `npx wrangler kv key put --binding API_KEYS project:my-app '{"over_quota_until": 1767225600}' --remote` (from `workers/ingest`).
- Failed queue batches land in `edgewatch-ingest-dlq`; there is no DLQ consumer/replay tool yet.
- No CI/CD pipeline is configured in this repo; deployments are manual via the scripts above.
