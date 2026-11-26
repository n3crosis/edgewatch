# Changelog

All notable changes to EdgeWatch are recorded here. Versions follow [Semantic Versioning](https://semver.org).

## [1.0.0] - Unreleased

- Removed before release: the agentless PHP client `edgewatch/laravel-edgewatch` (with its Pest suite), the
  `examples/laravel-sandbox` app and the `fresh-laravel` scripts that exercised it, the `test:php` script and the
  Composer/Pest CI steps. EdgeWatch now receives Laravel telemetry only from the official `laravel/nightwatch` agent
  (`NIGHTWATCH_BASE_URL` + `NIGHTWATCH_TOKEN`); `bun run nightwatch-agent` checks that path in a fresh Laravel app, and
  `bun run e2e` sends agent-format batches directly.
- Dashboard command palette (Cmd+K / Ctrl+K): fuzzy page navigation, trace search, open by trace ID, full keyboard
  and focus handling. On phones the header keeps search, theme and sign-out on the first row.
- Docs explain why the dashboard has no query EXPLAIN view (the wire format carries no bindings or plans).
- `GET /healthz` on the ingest, consumer and API Workers and the Bun server: typed report (`ok`/`degraded`/`down`)
  of each dependency with latency and a fixed failure reason; 503 when a required check fails. The Docker
  `HEALTHCHECK` uses it.
- `setup:cloudflare` preflight: every run first checks bindings, queues, crons, database URLs, the token and the
  Worker secrets each config needs, and stops before any remote change on an error. `--validate` runs only that.
- D1 backups use independent temporary local configs and clean up only files created by that invocation, including on export failure. Remote backups preserve existing local configuration.

- Corrected bootstrap requirements to Bun 1.4.5+ and Node 22.12+, clarified migration-before-deploy ordering, and reject invalid D1 migration arguments before invoking Wrangler.

- Deployment rejects invalid targets and API URLs before side effects, builds the dashboard before a combined deploy, and only requires Worker resource IDs for Worker deployments.

- Fixed standalone/Docker dashboard requests with `VITE_API_URL=/`: API URLs now resolve against the browser origin. Regression tests exercise authenticated reads, mutations, remote API prefixes and rejected-key sign-out.

- CI now checks a fresh Laravel install with the official agent. The fresh-install harness bounds health probes and initializes shared Worker storage before starting the API.

- Mixed handled/unhandled exception groups remain in the Unhandled view. Groups are handled only when all scoped occurrences were handled; API responses include both counts and the dashboard labels mixed groups.

- Added user-detail links to Requests, Jobs, Exceptions and Logs with exact user filtering, scope-preserving drilldowns, and matching demo behavior. Exception counts, trends, stacks and occurrences all respect the selected captured user.

- Query and exception trends load only the visible groups, including single-group details. Empty pages skip trend reads, and large pages use bounded parameter batches.

- Query and exception searches now filter complete group populations before pagination; query sorting also applies before page limits. List filters and pagination persist in URLs and detail Back links. Search treats SQL wildcard characters as literal text.

- Added shareable log inspectors with captured context and origin availability. Log detail reads enforce project, environment and time scope independently of feed pagination; demo logs now paginate the full retained dataset.

- Trace details expose missing stored records and storage-limit discard counts, with a visible incomplete-data notice.

- Trace tabs, event filters and event details are shareable in URLs. Content-derived event IDs survive stored-record reordering; missing events are explicit. Waterfalls handle zero-duration traces and late child events.

- Added dashboard-wide environment selection with scoped links, pagination resets, matching demo data, and clear project-wide issue lifecycle semantics.

- Scope investigation API aggregates, events, trace details and issue visibility by captured environment. Issue lifecycle remains project-wide; environment-scoped impact counts and lifecycle scope are explicit.

- Capture explicit Laravel environment metadata, retain it on traces (migration 0021), and add exact environment filtering and display. Missing metadata remains unknown.

- Added fixed start/end investigation windows with shareable URLs. Queries, exceptions and grouped event views now enforce end bounds, including stack traces and samples.

- Trace investigations support exact user ID and server filters with shareable URLs and matching demo/API behavior.

- Request drilldowns now include traffic/error and p95 latency trends. Charts share the execution-list filters and use 24 SQL-aggregated buckets via `/v1/requests/trend`.

- Issue lifecycle updates require `expected_revision` and reject stale edits even after a status changes back. Successful status changes and their audit entries commit atomically, including consumer regressions across statement-batch boundaries. Apply migration `0020_issue_revisions.sql` before upgrading.

- Dashboard overview statistics now aggregate in SQL and return at most 45 rows to the Worker, avoiding request-history-sized memory use. Totals, chart buckets and route p95 values remain exact; future-dated telemetry is excluded from the selected window.

- Record dispatch and range selection ignore inherited object properties. Unknown types such as `constructor` remain forward-compatible telemetry instead of causing failures. Invalid project-path encoding and malformed paging cursors return 400.

- Query p95 now uses the full matching population instead of silently truncating at 50,000 samples, keeping list and detail latency statistics consistent with their counts.

- Dashboard pages load on demand, with recoverable loading errors and keyboard-accessible Query/Exception links. The standalone server returns 404 for missing assets and 400 for malformed encoded paths rather than serving the dashboard shell or throwing.

- Request occurrences and Traces support inclusive minimum-duration filtering. Trace filters/pagination persist in URLs; trace links support keyboard navigation and opening a new tab.

- Unnamed requests group by captured Laravel route template, with distinct named/template/unknown identities and exact occurrence drilldowns. Apply migration `0019_route_paths.sql` before updating the consumer and API.

- Grouped event details now respect the selected time range; percent-escaped names open correctly. Event filters persist in URLs and event tables provide keyboard-accessible investigation links. (release candidate, not tagged)

- Added Requests grouped by route name and method, occurrence drilldowns, chronological Logs with context and origin links, and project/time scope in dashboard URLs.
- Added persistent Issues for unhandled exceptions, admin-only resolve/ignore/reopen controls, regression reopening, and audit history. Apply migration `0018_issues.sql` before upgrading.

Read-only API keys no longer authorize mutations. Create a key with the `admin` scope for project settings and dead-letter replay.

Release hardening: durable SQLite queue journal for the standalone server, serialized consumer writes and queued
replays, idempotent usage receipts (migration `0017_usage_receipts.sql`), recovery of trace blobs after failed SQL
writes, and Docker startup verification in CI. Apply migrations before deploying the updated consumer.

First stable release of the self-hosted, single-tenant EdgeWatch stack: Cloudflare Workers (ingest, consumer, API),
D1 + R2 storage, the React/Kumo dashboard, and `@edgewatch/browser` (npm). Laravel apps send telemetry with the official
`laravel/nightwatch` agent. Only `@edgewatch/browser` is a versioned client package; the Workers, dashboard and
`@edgewatch/shared` are private.

### Nightwatch compatibility

- `POST /api/agent-auth` returns `{token, expires_in, refresh_in, ingest_url}`, and `POST /api/ingest` accepts the official
  agent's gzip batches, so the unmodified `laravel/nightwatch` package and `php artisan nightwatch:agent` work with
  `NIGHTWATCH_BASE_URL` pointed at EdgeWatch (checked by `bun run nightwatch-agent` with Laravel 12.74 and `laravel/nightwatch` v1.30.6). Supported Laravel versions
  are those `laravel/nightwatch` supports; no other combination has been verified.
- 429 responses carry `stop` / `refresh_in` and `Retry-After` for rate limits and manual over-quota blocks.
- Official job attempts are stored as their own trace keyed by `attempt_id`; the dispatching trace is kept in
  `origin_trace_id` and both directions are returned under `related` on `/v1/traces/:id`.

### Record types

All 13 Nightwatch record types are accepted, stored in D1 (raw traces in R2 at
`traces/{project_id}/{date}/{trace_id}.json`) and shown in the dashboard: `request`, `query`, `exception`, `command`,
`job-attempt`, `queued-job`, `scheduled-task`, `cache-event`, `outgoing-request`, `mail`, `notification`, `log`, `user`.
Unknown record types with an integer `v` and a string `t` are accepted and kept in R2.

### Endpoints

- Ingest Worker: `POST /api/agent-auth`, `POST /api/ingest`, `POST /api/browser`, `GET /health`.
- API Worker (read or admin key; every route also under `/v1/projects/:projectId/...` or with `?project_id=`):
  `/v1/projects`, `/v1/overview`, `/v1/requests`, `/v1/log-entries`, `/v1/issues`, `/v1/issues/:group`, `/v1/permissions`, `/v1/traces`, `/v1/traces/:traceId`, `/v1/traces/:traceId/raw`,
  `/v1/exceptions`, `/v1/exceptions/:group`, `/v1/queries`, `/v1/queries/:sqlHash`,
  `/v1/jobs`, `/v1/commands`, `/v1/cache`, `/v1/outgoing-requests`, `/v1/mail`, `/v1/notifications`,
  `/v1/scheduled-tasks`, `/v1/logs`, `/v1/users`, `/v1/web-vitals` (each with a `/:key` detail route), `GET /health`.
- Mutations require an admin key. Issues: `PUT /v1/projects/:projectId/issues/:group` (`status`, `reason`, `expected_revision`, optional `expected_status`).
- Pipeline: `GET /v1/pipeline`, `GET /v1/dead-letters`, `POST /v1/dead-letters/replay`.
- Usage and settings: `GET /v1/usage`, `PUT /v1/projects/:id/settings` (`daily_record_quota`, `retention_days`); `/v1/projects` includes both settings.

### Browser SDK (`@edgewatch/browser`)

- Reports uncaught errors and unhandled rejections to `POST /api/browser`. This is EdgeWatch's own format, not part of
  the Nightwatch wire protocol.

### Reliability
- Consumer retries are idempotent: duplicate records are skipped in R2 and a trace's D1 child rows are rebuilt on merge.
- D1 writes are chunked (50 statements per batch); a stored trace keeps at most 5000 records / 8 MB, counting the rest in `dropped_records`.
- KV, R2 and Queue failures answer `503 unavailable` with `Retry-After`; other failures answer `500 internal_error`. Causes are never returned.
- Migration `0012` adds indexes for all-project reads, users and trace rebuilds; `scripts/d1-indexes.test.ts` EXPLAINs representative API and consumer queries.
- Retention runs hourly and keeps deleting until caught up, within 900 D1 queries and 10 minutes per run.
- The consumer runs one queue invocation at a time to preserve trace merges and retries failed messages 20 times (5 s to 10 min backoff, about 2.3 hours) before the DLQ; setup keeps queue messages for 14 days.
- Dead letters are stored (D1 `dead_letters`, R2 `dead/`), shown on a new Pipeline page and replayable; per-minute consumer stats record queue lag; optional `ALERT_WEBHOOK_URL` alerts on dead letters and queue lag (migration `0013`).
- Usage metering: records per project per UTC day (`usage_daily`, migration `0014`), shown on the Pipeline page; an optional daily record quota (`DAILY_RECORD_QUOTA` or per project) writes the over-quota block automatically until UTC midnight.
- Postgres through Hyperdrive as an optional event store: a `HYPERDRIVE` binding on the consumer and API replaces D1. Queries and migrations are translated from the SQLite dialect (`bun run migrate:postgres`); `bun run e2e:postgres` passes the full e2e on Postgres. Not yet run on a real account.
- S3-compatible blob store (`S3_*` vars) and a SQL key store (`KEY_STORE=sql`, migration `0016_kv_store`) as alternatives to R2 and KV; `keys ... --postgres <url>` manages SQL keys. `bun run e2e:portable` passes the full e2e with Postgres, S3 (moto) and SQL keys. Not yet run on a real account.
- Ingest now sends `Retry-After: 5` with the `503` it returns when the queue rejects a batch (agent and browser paths), like the other storage failures.
- Single-process server (`apps/server`, `bun run server`) and a `Dockerfile`: the Worker code runs unchanged in one Bun process on SQLite or Postgres, files or S3, with a durable SQLite queue journal, and serves the dashboard (`VITE_API_URL=/` means same origin). `bun run fresh-laravel:server` passes both fresh-Laravel checks against it.
- MySQL 8.0.19+ as an event store, through Hyperdrive on Workers (picked by the `mysql://` scheme) or `DATABASE_URL=mysql://...` on `apps/server`. Queries are translated from the SQLite dialect (`toMysql`), migrations by `bun run migrate:mysql`; `setup:cloudflare` takes `EDGEWATCH_MYSQL_URL`. Checked by `bun run test:mysql` and `bun run e2e:mysql` (local only).
- libSQL / Turso as an event store: `LIBSQL_URL` (+ `LIBSQL_AUTH_TOKEN`) on the consumer and API, or `DATABASE_URL=libsql://...` on `apps/server`. Queries and migrations run untranslated over HTTP (`@libsql/client/web`); `bun run migrate:libsql`, `test:libsql`, `e2e:libsql` (local sqld only).
- Usage and project-settings writes no longer use `RETURNING` (MySQL has none); they read the row back in the same batch.
- Ingest tokens with a non-canonical base64url signature (the last character's 2 unused bits changed) are rejected; before, up to 4 spellings of one token verified.
- `setup:cloudflare` provisions Hyperdrive when `EDGEWATCH_POSTGRES_URL` is set: finds or creates the configuration, binds it on the consumer and API, and runs the Postgres migrations.
- Storage interfaces (`SqlDatabase`, `BlobStore`, `KeyStore`, `IngestQueue` in `@edgewatch/shared`): the Workers no longer depend on Cloudflare binding types; D1, R2, KV and Queues satisfy them directly, with no behavior change.
- Seeded fuzz tests for the ingest/browser parsers, record validation, SQL normalization, PII scrubbing and ingest tokens. They found two bugs, now fixed: an ingest token with extra `.segment`s appended was accepted, and a truncated gzip body left an unhandled promise rejection in the ingest Worker (the request already got a 400).
- `bun run load-test`: local Miniflare throughput check, with dashboard read latency under load (see `docs/capacity.md`).
- `bun run bench:consumer`: consumer memory/time benchmark. Ingest parks big traces in parts of at most 1 MB, and the
  consumer holds less in memory per trace (before/after numbers in `docs/capacity.md`).
- `bun run backup:d1` (gzipped D1 dumps, rotation, optional R2 upload), restore steps, and a record/schema version policy (`docs/record-versions.md`).
- Browser SDK breadcrumbs (clicks, navigation, console, fetch; PII-scrubbed) and Core Web Vitals (LCP, INP, CLS, FCP, TTFB) with a Web vitals page and `/v1/web-vitals` (migration `0015`).
- Dashboard sign-in: the read key is entered in the browser and kept there (session or remembered); `VITE_API_KEY` is no longer built into the bundle.
- Key management CLI (`keys create|list|revoke|rotate|audit`): optional key expiry, rotation with a grace period, revocation and a KV audit log. Expired keys are rejected and agent tokens never outlive their key.
- Per-project retention: `projects.retention_days` overrides `RETENTION_DAYS`; the hourly job only cleans projects with expired rows.
- Capacity limits, D1 sizing and high-traffic failure modes are documented in `docs/capacity.md`.

### Known differences and caveats

- **Lazy loads are always 0.** `laravel/nightwatch` 1.30.6 declares `lazy_loads` but never increments it.
- **N+1 is a heuristic.** The same `sql_hash` 5 or more times in one trace is listed as a repeated query and
  raises the "Possible N+1 queries" warning. It can flag legitimate repeated queries and miss N+1
  loops with fewer than 5 iterations.
- `hydrated_models`, `files_read` and `files_written` are always 0 (the agent never increments them).
- `mail.failed` and `notification.failed` are always false: Laravel has no failure event.
- Scheduled tasks run with `runInBackground()` report a duration of about 0.
- Outgoing request URLs are stored without query string or fragment (Nightwatch keeps the full URL).
- Usage is metered per project per UTC day in the consumer, so a daily quota stops ingest within one batch of the limit, not exactly at it. There is no billing (EdgeWatch is single-tenant).
- Verified locally on the release candidate: typecheck, lint, Vitest + script tests, `e2e` and `nightwatch-agent`
  (see [docs/release-checklist.md](docs/release-checklist.md) for the commit and counts). Pending: hosted CI on the final
  commit, a deploy to a real Cloudflare account (gates 2-4), the tag and the npm publish decision.
