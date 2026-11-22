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
| `packages/laravel-edgewatch` | Composer client: requests, queries (literals stripped), exceptions, artisan commands, queued jobs / job attempts, cache events, users. UUIDv7 trace IDs, PII redaction, buffered transport (500 records, 500 ms timeouts), honors 429/`stop`. Pest tests. |
| `packages/browser` | `@edgewatch/browser`: dependency-free browser error reporter for EdgeWatch's own `POST /api/browser` (not part of the Nightwatch wire format). |
| `packages/shared` | TypeScript shared by the Workers: Zod schemas for every Nightwatch record type, SQL normalizer (same output as the PHP one), PII scrubber, HMAC ingest tokens, browser-event mapping. |
| `workers/ingest` | `POST /api/agent-auth` and `POST /api/ingest` (Nightwatch agent contract), `POST /api/browser`. Hashed API keys in KV, Zod validation, per-trace queue messages, 429 `stop`/`refresh_in` + `Retry-After` when over quota or rate-limited. |
| `workers/consumer` | Queue consumer: normalizes SQL, computes `sql_hash`, scrubs PII, writes D1 rows and raw traces to R2 at `traces/{project_id}/{date}/{trace_id}.json`. |
| `workers/api` | Read API for the dashboard: overview, traces (filters, search, range, cursor), exceptions, queries, trace waterfall. |
| `workers/migrations` | D1 schema: `projects`, `traces`, `exceptions`, `queries`. |
| `apps/dashboard` | React + Vite + Tailwind + shadcn/ui. Seed data unless `VITE_API_URL` is set (header badge shows the source); search, filters, 1h/6h/24h, 15 s live polling. |
| `examples/laravel-sandbox` | Laravel 12 app wired to the local package via a Composer path repository. |
| `scripts/` | `e2e.sh` (live local pipeline test), `cf-setup.mjs`, `d1-migrate.sh`, `deploy.sh`. |
| `fixtures/sql-normalization.json` | Shared SQL normalization cases, run by both Pest and Vitest. |

Docs: [architecture](docs/architecture.md) · [deployment](docs/deployment.md) · [self-hosting / local](docs/self-hosting.md) ·
[migrating from Nightwatch](docs/nightwatch-migration.md) · [Nightwatch wire format](docs/nightwatch-compat.md)

## Development

Requirements: Node 22 + pnpm 9, PHP 8.2+ with Composer.

```bash
pnpm install
pnpm test                 # Vitest: shared, browser, ingest, consumer, api, dashboard
pnpm test:php             # Pest: packages/laravel-edgewatch + examples/laravel-sandbox (composer install in both first)
pnpm e2e                  # sandbox -> ingest -> queue -> consumer -> D1/R2 -> api, all on wrangler dev
pnpm dev:dashboard        # http://localhost:5173 with seed data
```

## Deploying

Not deployed anywhere yet; resource IDs in `workers/*/wrangler.jsonc` are placeholders until you run the setup script.

```bash
node scripts/cf-setup.mjs       # creates/reuses KV, D1, R2, queues + DLQ and writes IDs into wrangler configs
scripts/d1-migrate.sh --remote
scripts/deploy.sh               # workers, then the dashboard on Cloudflare Pages (needs VITE_API_URL)
```

Details: [docs/deployment.md](docs/deployment.md).

## Remaining gaps for a complete release (priority order)

1. **Dashboard auth and multi-tenancy:** the dashboard ships a read key in its bundle; no users, orgs, SSO, RBAC or per-project membership. Put it behind Cloudflare Access for now.
2. **Key/project management:** keys are created with a CLI script; no rotation, expiry or audit log.
3. **Usage metering and quotas:** 429 `stop` works, but quota blocks are set by hand in KV; nothing counts events or bills.
4. **Retention:** no D1 pruning job or R2 lifecycle rule; storage grows unbounded.
5. **Real-account validation:** setup/deploy scripts and the `RATE_LIMITER` binding are untested against a real Cloudflare account.
6. **Security review:** no external review or fuzzing of the ingest parser, tokens, CORS or browser-key origin checks.
7. **Load testing:** no throughput numbers for ingest, queue batching or D1 write limits (D1 single-writer limits will matter first).
8. **Self-observability and alerting:** no metrics/alerts on ingest errors, queue lag or DLQ depth; no DLQ replay tool; no user-facing alerts.
9. **Collector parity:** laravel-edgewatch lacks scheduled tasks, outgoing requests, mail, notifications and logs (the official agent path sends them).
10. **Dashboard coverage:** no pages for logs, mail, notifications, cache, scheduled tasks or users; no saved views.
11. **Browser SDK:** no source maps, breadcrumbs, web vitals; not published to npm (laravel-edgewatch not on Packagist either).
12. **Ops:** no CI, no backups/restore for D1 (beyond Cloudflare Time Travel), no schema-versioning policy for future record versions.
