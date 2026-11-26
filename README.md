# EdgeWatch

Edge-native observability backend for Laravel on Cloudflare Workers, **wire-compatible with Laravel Nightwatch**:
three Workers (ingest, consumer, API) plus a dashboard, fed by the official `laravel/nightwatch` agent pointed at
EdgeWatch with `NIGHTWATCH_BASE_URL` and `NIGHTWATCH_TOKEN`.
Protocol research and the exact source files it is based on: [docs/nightwatch-compat.md](docs/nightwatch-compat.md).

EdgeWatch is **single-tenant and self-hosted**: one owner runs it for their own apps. Projects are tags you switch between, not tenants.

![EdgeWatch dashboard: trace detail with waterfall](docs/images/trace-detail.png)

More screenshots (overview, traces, exceptions, queries, pipeline): [docs/dashboard.md](docs/dashboard.md).

```
Laravel app + laravel/nightwatch --TCP--> php artisan nightwatch:agent --HTTPS gzip (NIGHTWATCH_BASE_URL)--+
                                                                        v
                         workers/ingest (Hono, Zod, KV keys) --Queue--> workers/consumer --> D1 (metadata) + R2 (raw traces)
                                                                                                   ^
                                  apps/dashboard (React, Vite, Tailwind) <-- workers/api (Hono) ---+
```

| Path | What |
| --- | --- |
| `packages/shared` | TypeScript shared by the Workers: Zod schemas for every Nightwatch record type, SQL normalizer, PII scrubber, HMAC ingest tokens. |
| `workers/ingest` | `POST /api/agent-auth` and `POST /api/ingest` (Nightwatch agent contract). Hashed API keys in KV, Zod validation, per-trace queue messages, 429 `stop`/`refresh_in` + `Retry-After` when rate-limited or blocked by a manual over-quota flag in KV (no usage metering). |
| `workers/consumer` | Queue consumer: normalizes SQL, computes `sql_hash`, scrubs PII, writes D1 rows and raw traces to R2 at `traces/{project_id}/{date}/{trace_id}.json`. |
| `workers/api` | API: overview, route-grouped Requests, persistent Issues, chronological Logs, traces (filters, search, range, cursor, waterfall, raw R2 trace, related job/request traces), exceptions, queries, jobs, commands, cache, outgoing requests, mail, notifications, scheduled tasks, logs, users. Full list in [CHANGELOG.md](CHANGELOG.md#endpoints). |
| `workers/migrations` | D1 schema `0001`-`0020`: traces, exceptions, queries, users, job attempts, commands, cache events, outgoing requests, mail, notifications, scheduled tasks, logs, dead letters, pipeline stats, daily usage, web vitals, issue state/history, captured route templates and the optional SQL key table. |
| `apps/server` | One Bun process (or the root `Dockerfile`) running the ingest, consumer and API code plus the dashboard, on SQLite, Postgres, MySQL or libSQL and local files or S3, for running without Cloudflare ([self-hosting](docs/self-hosting.md#single-process--docker)). |
| `apps/dashboard` | React + Vite + Tailwind v4 + [Kumo UI](https://kumo-ui.com) (`@cloudflare/kumo`, design system of record). Seed data unless `VITE_API_URL` is set (header badge shows the source); search, filters, 1h/6h/24h, 15 s live polling. |
| `scripts/` | `e2e.sh` + `e2e-records.mjs` (live local pipeline test), `nightwatch-agent.sh` (fresh Laravel 12 app with the official `laravel/nightwatch` agent), `setup-cloudflare.ts` (+ tests), `d1-migrate.sh`, `deploy.sh`. |
| `fixtures/sql-normalization.json` | SQL normalization cases, run by Vitest. |

Docs: [changelog](CHANGELOG.md) | [release checklist](docs/release-checklist.md) | [Nightwatch parity](docs/nightwatch-parity.md) | [architecture](docs/architecture.md) | [deployment](docs/deployment.md) | [self-hosting / local](docs/self-hosting.md) |
[dashboard screenshots](docs/dashboard.md) | [migrating from Nightwatch](docs/nightwatch-migration.md) | [Nightwatch wire format](docs/nightwatch-compat.md)

## Development

Requirements: [Bun](https://bun.sh) 1.4.5+ (package manager and script runner), Node 22.12+ (Wrangler and Vitest run on Node). PHP 8.2+ and Composer are needed only for `bun run nightwatch-agent`.

```bash
bun install
```

- **Dev:** `bun run dev:dashboard` serves the dashboard at http://localhost:5173 on seed data (set `VITE_API_URL` for a real API; the dashboard uses email/password accounts and secure session cookies; use same-origin routing for production).
  `bun run dev:ingest`, `dev:consumer`, `dev:api` run each Worker on `wrangler dev`; `bun run e2e` wires them all together.
- **Test:** `bun run test` runs Vitest in every workspace (shared, ingest, consumer, api, dashboard, server).
- **Lint:** `bun run lint` runs Biome's linter over the TypeScript sources (`biome.json`).
- **Typecheck:** `bun run typecheck` runs `tsc --noEmit` in every workspace.
- **E2E:** `bun run e2e` starts the three Workers locally, sends agent-format gzip batches for every record type and checks ingest -> queue -> consumer -> D1/R2 -> api across several projects (see [self-hosting](docs/self-hosting.md)). `bun run e2e:postgres` runs the same checks with Postgres as the event store, `bun run e2e:portable` runs them on Postgres + an S3 bucket (local moto) + SQL keys, and `bun run test:postgres` runs the Postgres adapter tests (both start a Postgres container with Docker unless `E2E_POSTGRES_URL` / `EDGEWATCH_TEST_POSTGRES_URL` is set).
- **Official agent:** `bun run nightwatch-agent` creates a new Laravel 12 app in a temp dir, installs `laravel/nightwatch`, runs its unmodified `php artisan nightwatch:agent` with `NIGHTWATCH_BASE_URL` pointed at a local ingest Worker, sends a request, commands, a queued job, cache calls, a log line, a handled exception, an outgoing HTTP call, a mail, a notification, a scheduled task and a signed-in user, and reads every record type back from the API. `bun run nightwatch-agent:server` does the same against the single-process server.
- **CI:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs `bun install --frozen-lockfile`, typecheck, lint, Vitest, build, Docker, the e2e and the official-agent check. The [first successful hosted run](https://github.com/n3crosis/edgewatch/actions/runs/45364773853) passed; require CI on the final release commit.
- **Logs and errors:** see [architecture](docs/architecture.md#errors-and-logs).

## Several apps (projects)

EdgeWatch is **single-tenant and self-hosted**: one owner, several projects (your Laravel apps or sites). There are no
orgs or tenants. `project_id` is just a tag:

- **Ingest:** one ingest key (`bun run --filter @edgewatch/ingest create-key <default-project> ingest`) can write to any project. List, rotate, revoke and audit keys with `bun run --filter @edgewatch/ingest keys` ([deployment](docs/deployment.md#4-create-api-keys)).
  The official agent sends no project tag, so its data goes to the ingest key's default project: create one ingest key
  per app (`create-key <project> ingest`) and use it as that app's `NIGHTWATCH_TOKEN`. Direct HTTP senders can also tag
  a batch with `X-EdgeWatch-Project` or `?project=`.
- **Reads:** one read key sees every project. Read endpoints take an optional project filter (`/v1/projects/:id/...` or `?project_id=`).
- **Dashboard:** a project selector in the sidebar filters every view.

Details: [architecture](docs/architecture.md#projects-single-tenant).

## Deploying

The checked-in resource IDs in `workers/*/wrangler.jsonc` belong to the project's test installation. Point them at your own
account with the setup script (placeholder rules: [deployment.md](docs/deployment.md#replace_with_-placeholders)).

```bash
export CLOUDFLARE_API_TOKEN=...   # + CLOUDFLARE_ACCOUNT_ID if the token sees several accounts
bun run setup:cloudflare --validate  # preflight: bindings, queues, URLs, token, secrets; changes nothing
bun run setup:cloudflare --dry-run   # preview; works without a token
bun run setup:cloudflare             # find-or-create KV, D1, R2, queues + DLQ, write IDs over placeholders, apply D1 migrations
scripts/deploy.sh               # workers, then the dashboard on Cloudflare Pages (needs VITE_API_URL)
```

Without Cloudflare: `docker build -t edgewatch . && docker run -p 8080:8080 -v edgewatch-data:/data edgewatch` runs everything in one container ([docs/self-hosting.md](docs/self-hosting.md#single-process--docker)).

Details: [docs/deployment.md](docs/deployment.md). For more data than D1's 10 GB, the consumer and API can use Postgres or MySQL through Hyperdrive ([docs/deployment.md](docs/deployment.md#optional-postgres-or-mysql-through-hyperdrive-instead-of-d1)), or libSQL/Turso ([docs/deployment.md](docs/deployment.md#optional-libsql--turso-instead-of-d1)).

## Supported Laravel versions

The supported Laravel versions are the ones the official `laravel/nightwatch` package supports; EdgeWatch only receives
what its agent sends. Verified here: **Laravel 12.74.0 with `laravel/nightwatch` v1.30.6** on PHP 8.5 locally (CI uses
PHP 8.3), by `bun run nightwatch-agent`. No other Laravel or `laravel/nightwatch` version has been checked.

## Release status

Version **1.0.0 is a release candidate**: not tagged; no packages are published. Every local suite passes (Vitest,
script tests, e2e on Miniflare, the official-agent check). Hosted CI has passed. A deploy to a real Cloudflare account remains unverified. The owner's remaining steps are in [docs/release-checklist.md](docs/release-checklist.md); the
Nightwatch parity matrix and known differences are in [docs/nightwatch-parity.md](docs/nightwatch-parity.md).

## Known limitations (not planned for 1.0)

1. **Dashboard login:** invite-only email/password accounts with owner, admin and viewer roles. Sessions use HttpOnly cookies; no credential is embedded in the bundle. Owners invite teammates and manage access in Accounts. API keys remain available for integrations. See [deployment.md](docs/deployment.md#dashboard-account-routing) for initial owner setup.
2. **Key/project management:** keys are managed with a CLI (`bun run --filter @edgewatch/ingest keys create|list|revoke|rotate|audit`), with optional expiry and an audit log in KV. There is no key UI or API. A revoked key can still pass for up to 60 s (KV edge cache), and agent tokens it already issued stay valid until `TOKEN_TTL` (1 h).
3. **Usage metering:** records are counted per project per UTC day (`/v1/usage`, Pipeline page), and an optional daily record quota (`DAILY_RECORD_QUOTA` on the consumer, or per project via `PUT /v1/projects/:id/settings`) sets the 429 `stop` until UTC midnight. Counting happens in the consumer, so records already queued when the quota is hit are still stored, and stable message receipts prevent redeliveries from being counted twice. There is no billing.
4. **Retention:** hourly D1/R2 retention uses `RETENTION_DAYS` or a per-project `retention_days` (`PUT /v1/projects/:id/settings`). The R2 lifecycle backstop from the setup script is bucket-wide, so set `EDGEWATCH_RETENTION_DAYS` to the longest retention you use (or 0). Not yet run on a real account.
5. **Real-account validation:** setup/deploy scripts and the `RATE_LIMITER` binding are untested against a real Cloudflare account. The Vitest pool bundles wrangler 4.35, which warns `Unexpected fields ... "ratelimits"` (tests inject a mock limiter); wrangler 4.166 used for dev/deploy accepts it.
6. **Security review:** seeded fuzz tests cover the ingest body parser (raw bytes, corrupt gzip, wrong shapes), record validation, SQL normalization, PII scrubbing and ingest tokens. There has been no external review, and CORS/origin checks are only unit-tested.
7. **Load testing:** `bun run load-test` measures local Miniflare throughput (numbers in [docs/capacity.md](docs/capacity.md#local-load-test)); there are no numbers from a real Cloudflare account.
8. **Self-observability:** the Pipeline page and `/v1/pipeline` show consumer throughput, queue lag and dead letters; dead letters can be replayed, and `ALERT_WEBHOOK_URL` sends dead-letter and queue-lag alerts. Ingest-side errors (4xx/5xx) are only in Workers Logs, with no alert.
9. **Ops:** `bun run backup:d1` dumps D1 (Time Travel covers point-in-time restore); R2 traces and KV keys need their own copies. Version policy: [docs/record-versions.md](docs/record-versions.md).
