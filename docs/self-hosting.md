# Self-hosting and local development

EdgeWatch runs only on Cloudflare's runtime (Workers, Queues, D1, R2, KV). "Self-hosting" means deploying it to your own
Cloudflare account ([deployment.md](deployment.md)) or running it locally with `wrangler dev` (Miniflare/workerd).
There is no Docker image or non-Cloudflare storage backend.

## Local setup

```bash
pnpm install
(cd packages/laravel-edgewatch && composer install)
(cd examples/laravel-sandbox && composer install && cp -n .env.example .env && php artisan key:generate && php artisan migrate --seed)
```

Requirements: Node 22+, pnpm 9, PHP 8.2+ (8.3 tested) with sqlite, curl, mbstring, zlib; Composer 2.

## One-command live pipeline check

```bash
pnpm e2e        # = scripts/e2e.sh
```

Starts `wrangler dev` for ingest + consumer (one process, so they share the local queue) on :8787 and the API on :8788 with
fresh state in `.wrangler/e2e-state`, applies migrations, creates ingest/read/browser keys in local KV, serves the sandbox on
:8010 with the HTTPS transport pointed at local ingest, generates a request, queries, an exception, a cache-backed order with a
queued job, a queue worker run, an artisan command and a browser error, then asserts the results through `workers/api`
(D1 rows, R2 raw records, exception grouping/PII scrubbing, `sql_hash` groups), the agent-auth handshake and the 429 `stop`
response. Exits non-zero on any failure; logs in `.wrangler/e2e-logs`. `E2E_KEEP=1` leaves everything running.

The script uses the agentless HTTPS path. The official agent path was verified manually (not scripted, because the sandbox
does not depend on `laravel/nightwatch`): `composer require laravel/nightwatch`, then
`NIGHTWATCH_TOKEN=<ingest key> NIGHTWATCH_BASE_URL=http://127.0.0.1:8787 php artisan nightwatch:agent`.

## Running pieces by hand

```bash
scripts/d1-migrate.sh --local
cd workers/ingest && npx wrangler dev -c wrangler.jsonc -c ../consumer/wrangler.jsonc --persist-to ../../.wrangler/state --var TOKEN_SIGNING_SECRET:dev
cd workers/api && npx wrangler dev --port 8788 --persist-to ../../.wrangler/state
pnpm --filter @edgewatch/ingest create-key demo ingest,read local --local   # run inside workers/ingest with --persist-to if you changed it
VITE_API_URL=http://127.0.0.1:8788 VITE_API_KEY=<read key> VITE_PROJECT_ID=demo pnpm dev:dashboard
```

Without `VITE_API_URL` the dashboard shows generated seed data, and its header badge says "Seed data".

## Tests

```bash
pnpm test        # Vitest: shared, browser, ingest, consumer, api (workerd pool), dashboard
pnpm test:php    # Pest: packages/laravel-edgewatch and examples/laravel-sandbox
```

## Limits of local mode

Local Workers Rate Limiting and KV `cacheTtl` behave differently from production; R2/D1 are emulated by Miniflare.
