# EdgeWatch

Edge-native observability backend for Laravel on Cloudflare Workers, **wire-compatible with Laravel Nightwatch**:
point the official Nightwatch agent at EdgeWatch (`NIGHTWATCH_BASE_URL`) or use the agentless `edgewatch/laravel-edgewatch` client.
Protocol research and the exact source files it is based on: [docs/nightwatch-compat.md](docs/nightwatch-compat.md).

```
Laravel app ──TCP (len:v1:hash:json)──▶ Nightwatch agent ──HTTPS gzip──┐
Laravel app ──laravel-edgewatch (HTTPS gzip, 500ms timeout)────────────┤
                                                                        ▼
                         workers/ingest (Hono, Zod, KV keys) ──Queue──▶ workers/consumer ──▶ D1 (metadata) + R2 (raw traces)
                                                                                                   ▲
                                  apps/dashboard (React, Vite, Tailwind) ◀── workers/api (Hono) ───┘
```

| Path | What |
| --- | --- |
| `packages/laravel-edgewatch` | Composer package: `EdgeWatchServiceProvider`, UUIDv7 trace IDs, query listener + SQL literal stripping, PII redaction, buffered transport (500 records, 500 ms timeout). Pest tests. |
| `packages/shared` | TypeScript shared by the Workers: Zod schemas for every Nightwatch record type, SQL normalizer (same output as the PHP one), HMAC ingest tokens. |
| `workers/ingest` | `POST /api/agent-auth` and `POST /api/ingest` (Nightwatch agent contract). API keys in KV (hashed), records validated and enqueued per trace. |
| `workers/consumer` | Queue consumer: normalizes SQL, computes `sql_hash`, writes D1 rows and raw traces to R2 at `traces/{project_id}/{date}/{trace_id}.json`. |
| `workers/api` | Read API for the dashboard: overview, traces, exceptions, queries. |
| `workers/migrations` | D1 schema: `projects`, `traces`, `exceptions`, `queries`. |
| `apps/dashboard` | React + Vite + Tailwind UI. Uses built-in seed data unless `VITE_API_URL` is set. |
| `examples/laravel-sandbox` | Laravel app wired to the local package via a Composer path repository. |
| `fixtures/sql-normalization.json` | Shared SQL normalization cases, run by both Pest and Vitest. |

## Development

Requirements: Node 22 + pnpm 9, PHP 8.2+ with Composer.

```bash
pnpm install
pnpm test                 # Vitest: shared, ingest, consumer, api, dashboard
pnpm test:php             # Pest: packages/laravel-edgewatch (run `composer install` there first)
pnpm dev:dashboard        # http://localhost:5173 with seed data
```

Run the pipeline locally:

```bash
cd workers/consumer && npx wrangler d1 migrations apply edgewatch --local
cd workers/ingest && cp .dev.vars.example .dev.vars && pnpm create-key demo ingest local --local && pnpm dev
```

## Deploying

Create the Cloudflare resources and put their IDs in each `wrangler.jsonc`:
`wrangler kv namespace create API_KEYS`, `wrangler d1 create edgewatch`, `wrangler r2 bucket create edgewatch-traces`,
`wrangler queues create edgewatch-ingest` (+ `edgewatch-ingest-dlq`), then `wrangler secret put TOKEN_SIGNING_SECRET` for ingest and `pnpm -r deploy`.
