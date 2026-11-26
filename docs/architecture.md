# EdgeWatch architecture

EdgeWatch is a Nightwatch-compatible observability backend on Cloudflare Workers. This page describes what is implemented
on `main`; see "Not implemented" at the end.

```
Laravel app --(a) laravel/nightwatch --TCP--> nightwatch:agent --HTTPS (NIGHTWATCH_BASE_URL)--+
            +-(b) edgewatch/laravel-edgewatch --HTTPS gzip, or TCP to the agent -------------+
Browser -----(c) @edgewatch/browser -- sendBeacon --> POST /api/browser (EdgeWatch extension) -+
                                                                                              v
                                         workers/ingest (Hono)  -- KV API_KEYS (hashed keys, quota blocks)
                                           |  Queue edgewatch-ingest (one message per trace; >100 KB parked in R2 incoming/, in parts of at most 1 MB)
                                           v
                                         workers/consumer -- D1 (projects, traces, exceptions, queries)
                                           |                 R2 traces/{project_id}/{date}/{trace_id}.json
                                           |  DLQ edgewatch-ingest-dlq after 20 retries
                                           v
apps/dashboard (React, Kumo UI) --> workers/api (Hono, read keys) -- D1 + R2
```

## Components

| Path | Role |
| --- | --- |
| `packages/shared` | Zod record schemas (Nightwatch v1.30.6 shapes), SQL normalizer + `sql_hash`, PII scrubber, HMAC ingest tokens, browser-event mapping. Used by all Workers. |
| `workers/ingest` | `POST /api/agent-auth` and `POST /api/ingest` (the official agent's contract), `POST /api/browser`, `GET /health`. Validates records, groups by `trace_id`, enqueues. Returns `429 {stop, refresh_in}` + `Retry-After` for over-quota/rate-limited projects. |
| `workers/consumer` | Queue consumer. Normalizes SQL (literals stripped, `sql_hash`), scrubs PII from exception/log messages, merges records per trace, writes raw JSON to R2 and summary rows to D1. Retries are idempotent: exact duplicate records are skipped in R2 and a trace's child rows are rebuilt from the merged records. D1 writes go in batches of 50 statements; a stored trace keeps at most 5000 records / 8 MB (root records always kept, the rest counted in `dropped_records`). |
| `workers/api` | Read API for the dashboard: `/v1/projects/:id/{overview,traces,traces/:traceId,traces/:traceId/raw,exceptions,exceptions/:group,queries,queries/:sqlHash}` plus `jobs`, `commands`, `cache`, `outgoing-requests`, `mail`, `notifications`, `scheduled-tasks`, `logs`, `users` (each with `/:key`). Optional project filter (`/v1/projects/:id/...` or `/v1/...?project_id=`), read-scope keys, CORS. Waterfall spans derived from raw R2 records. |
| `workers/migrations` | D1 schema (`0001_init.sql` ... `0020_issue_revisions.sql`); representative API reads and consumer write/retention queries are checked for index use by `scripts/d1-indexes.test.ts`. |
| `packages/laravel-edgewatch` | Composer client that emits all 13 Nightwatch-format record types: requests, queries, exceptions, commands, queued jobs / job attempts, scheduled tasks, cache events, outgoing HTTP, mail, notifications, logs, users. Transports: TCP to a Nightwatch agent, or direct HTTPS gzip to ingest; buffered, 0.5 s connect/send timeouts, never throws into the app; honors 429/`stop`. |
| `packages/browser` | `@edgewatch/browser`, dependency-free browser error reporter. |
| `apps/dashboard` | React + Vite + Tailwind v4 + Kumo UI (`@cloudflare/kumo`, the design system of record; Base UI primitives, Phosphor icons). Seed data by default, `workers/api` when `VITE_API_URL` is set. Filters, search, 1h/6h/24h range, 15 s live polling, data-source badge. |
| `apps/server` | The three Workers' fetch, queue and scheduled handlers composed in one Bun process: SQLite (`bun:sqlite`) or Postgres, files or S3, `kv_store` keys, a SQLite-journaled queue with the Workers' retry/DLQ policy, an in-memory rate limiter, timers for the crons, and the built dashboard. Root `Dockerfile`. |
| `examples/laravel-sandbox` | Laravel 12 app using the local package; demo routes, job, cache and command. |
| `scripts/` | `e2e.sh` (local live pipeline check), `setup-cloudflare.ts`, `d1-migrate.sh`, `deploy.sh`. |

## Storage interfaces

The Workers depend on four interfaces in `packages/shared/src/storage.ts`, not on Cloudflare binding types. Each is the
subset of a binding EdgeWatch calls, so the Cloudflare bindings satisfy them directly (checked at compile time and
exercised in `workers/consumer/test/storage.test.ts`).

| Interface | Used for | Cloudflare (default) | Alternatives |
| --- | --- | --- | --- |
| `SqlDatabase` (`prepare`/`bind`/`first`/`all`/`run`, atomic `batch`) | Event store | D1 | Postgres or MySQL 8.0.19+ through Hyperdrive (`HYPERDRIVE` binding; the URL scheme picks the driver); libSQL/Turso (`LIBSQL_URL`) |
| `BlobStore` (`get`/`put`/`delete`) | Trace JSON, parked batches, dead letters | R2 | Any S3-compatible bucket (`S3_*` vars) |
| `KeyStore` (JSON `get`/`put`/`delete`) | API keys, project blocks | KV | The event store's `kv_store` table (`KEY_STORE=sql`) |
| `IngestQueue` (`sendBatch`) | Ingest to consumer | Queues | Processing inside the ingest request |

SQL is written once, in SQLite's dialect. The Postgres store (`packages/shared/src/postgres.ts`) translates it
(`sql-dialect.ts`): `?` parameters, `INSERT OR IGNORE`, `group_concat`, two-argument `max`/`min`, `sum` of comparisons,
`rowid`, `LIKE`, `GROUP BY +col` and the reserved `user` column. The same translator turns `workers/migrations` into
Postgres DDL (`bun run migrate:postgres`). When the consumer or API has a `HYPERDRIVE` binding, it opens a postgres.js
client per batch or request and uses it instead of D1. Capacity limits per backend are in [capacity.md](capacity.md).

MySQL (`packages/shared/src/mysql.ts`, mysql2) uses the same approach (`toMysql`, `bun run migrate:mysql`). Each
connection sets `ANSI_QUOTES` and `PIPES_AS_CONCAT` so `"` and `||` mean what they do in SQLite. The translator handles
`?N` parameter reuse, `INSERT OR IGNORE`/`ON CONFLICT` (as `INSERT IGNORE` and `ON DUPLICATE KEY UPDATE` with an
`excluded` row alias), chunked `rowid` deletes (as `DELETE ... LIMIT`), `group_concat`, truncating `CAST`, backslashes in
literals and the reserved `key`/`sql` columns. Tables use `utf8mb4_bin`, so keys compare exactly as in SQLite, and
`LIKE` is made case-insensitive. Indexed `TEXT` columns become `VARCHAR(255)`; other `TEXT` columns become `MEDIUMTEXT`.
Partial indexes become full indexes. The queries avoid `RETURNING`, which MySQL lacks.

libSQL / Turso (`packages/shared/src/libsql.ts`) speaks SQLite, so queries and migrations run untranslated
(`bun run migrate:libsql`). It is reached over HTTP with `@libsql/client/web`, which works on Workers without
Hyperdrive. `batch` is one write transaction. Integers past 2^53 are rounded like D1 does.

### Storage backends

`openBackends(env)` (`packages/shared/src/backends.ts`) runs at the start of every request, queue batch and cron run in
all three Workers. It swaps each store according to these settings, and fails with a typed 500 when a selected backend
is missing a setting:

| Setting | Effect | Workers that need it |
| --- | --- | --- |
| `HYPERDRIVE` binding | Postgres or MySQL (by the connection string's scheme) is the event store instead of D1 | consumer, API (and ingest with `KEY_STORE=sql`) |
| `LIBSQL_URL` var, `LIBSQL_AUTH_TOKEN` secret | libSQL / Turso is the event store instead of D1 (not together with `HYPERDRIVE`) | consumer, API (and ingest with `KEY_STORE=sql`) |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, optional `S3_REGION` (default `auto`) | Blobs go to an S3-compatible bucket (AWS S3, MinIO, B2, R2's S3 endpoint), path-style, SigV4-signed | all three |
| `KEY_STORE=sql` | API keys, audit entries and project blocks live in the event store's `kv_store` table (migration 0016) instead of KV | all three |

With all three set, only Queues remains a Cloudflare product (`bun run e2e:portable` checks this stack). The SQL key
store honours `cacheTtl` with an in-isolate cache on D1; with Postgres the store is opened per request and only
Hyperdrive's query cache applies. Expired `kv_store` rows are deleted by the hourly retention run. Manage keys there
with `bun run --filter @edgewatch/ingest keys ... --postgres <url>`.

Outside Workers, `apps/server` passes the same handlers an env built from these interfaces (no Cloudflare bindings),
so the Worker code is shared unchanged; see [self-hosting.md](self-hosting.md#single-process--docker) for its limits.

## Auth model

- EdgeWatch is single-tenant: one owner plus invited dashboard accounts (owner, admin, viewer roles), no orgs or tenants.
  Dashboard users sign in with email and password (HttpOnly session cookie); API keys only prove "this is the owner's app" or integration.
- API keys are random strings; only `sha256(key)` is stored in KV as `apikey:<hex>` -> `{project_id, name, scopes, created_at?, expires_at?, disabled?, allowed_origins?}`.
  A key authenticates only if it is not disabled (revoked) and `expires_at` has not passed; an agent token never outlives its key.
  `scripts/keys.ts` creates, lists, rotates and revokes keys and appends each change to `audit:<ms>:<random>` in the same namespace.
  `project_id` is the key's default project for untagged data; it does not limit what the key can write or read.
- Scopes: `ingest` (agent/client, secret), `read` (dashboard/API), `browser` (public; only `/api/browser`, optional origin allow-list).
- `/api/agent-auth` exchanges an ingest key for a short-lived HMAC token (`TOKEN_SIGNING_SECRET`, `TOKEN_TTL`, default 3600 s); `/api/ingest` accepts that token or the raw key.

## Quota and rate limiting

- KV `project:<id>` = `{"over_quota_until": <unix s>, "message": "..."}` blocks a project on agent-auth, ingest and browser endpoints.
  It is set by hand, or by the consumer (`"reason": "daily_quota"`) when a project reaches its daily record quota.
- D1 `usage_daily`: records per project per UTC day, added by the consumer after a message is processed (kept 400 days).
  The quota is `projects.daily_record_quota`, else the consumer's `DAILY_RECORD_QUOTA`; it is checked after each batch, so the
  block lands within one batch of the limit and applies to new ingest (already queued records are still stored).
- Optional Workers Rate Limiting binding `RATE_LIMITER` (configured 600 requests / 60 s per project in `workers/ingest/wrangler.jsonc`).
- Both answer `429 {"message", "stop": true, "refresh_in"}` with `Retry-After` and `X-EdgeWatch-Stop: 1`.

## Data model

- D1 `traces`: one row per trace (source, name, status, duration, counts, server, deploy, user, `r2_key`).
- D1 `exceptions`: one row per occurrence, `group_hash` = Nightwatch `_group`.
- D1 `queries`: one row per query with normalized SQL and `sql_hash`.
- R2 `traces/{project_id}/{date}/{trace_id}.json`: all raw records of a trace (merged across ingest batches).

## Pipeline health

- Every consumer batch adds to `pipeline_minutes` (batches, messages, retries and queue lag, i.e. how long the batch's oldest
  message waited); rows are kept 7 days.
- Messages that fail every retry go to `edgewatch-ingest-dlq`, which the same Worker consumes: each is stored in R2
  `dead/{project_id}/{message_id}.json` (parked payloads inlined) and D1 `dead_letters`, and is kept until replayed.
- `POST /v1/dead-letters/replay` flags dead letters; a 5-minute cron (`*/5 * * * *`) re-processes flagged ones through the
  normal idempotent path and deletes them, or records the error (given up after 5 tries; can be requested again). The same cron
  sends a queue-lag alert to `ALERT_WEBHOOK_URL` above `ALERT_LAG_SECONDS`. Dead-letter alerts are sent as they arrive.
- `GET /v1/pipeline` and `GET /v1/dead-letters` back the dashboard's Pipeline page.

## Retention

- `workers/consumer` runs an hourly cron (`17 * * * *`) that deletes D1 trace, exception, query and event rows older than
  the project's `retention_days` (`PUT /v1/projects/:id/settings`), else `RETENTION_DAYS` (default 30; `0` keeps everything),
  in bounded chunks, and deletes the R2 objects of the deleted traces. One query finds the projects with expired rows; only
  those are cleaned, starting at a different project each hour.
  Each run keeps going until nothing old is left or it has used 900 D1 queries or 10 minutes (`complete: false` in the
  `retention` log); the next run continues from there.
- `scripts/setup-cloudflare.ts` adds R2 lifecycle rules as a backstop: `incoming/` (parked oversized payloads) after 1 day,
  `traces/` after `EDGEWATCH_RETENTION_DAYS + 1` days.
- The R2 `traces/` lifecycle rule is bucket-wide: with per-project retention longer than `EDGEWATCH_RETENTION_DAYS`, rerun the
  setup with `EDGEWATCH_RETENTION_DAYS` set to the longest one (or 0 to drop the rule). Retention has not run against a real account.

## Errors and logs

- Every error from ingest and the API is JSON: `{"error": {"code", "message", "details?"}, "message", "request_id"}`.
  Codes: `unauthenticated`, `forbidden`, `not_found`, `invalid_request`, `payload_too_large`, `unprocessable`,
  `over_quota`, `rate_limited`, `unavailable`, `internal_error`. Top-level `message` stays for Nightwatch-agent compatibility;
  429s also carry `stop` and `refresh_in`.
- A failed KV, R2 or Queue call answers `503 unavailable` with `Retry-After: 5`; any other failure (including D1 errors in
  the API) answers `500 internal_error`. Neither body includes the cause, which is logged scrubbed. Ingest's quota and
  rate-limit checks fail open, so an outage of either never drops data.
- Each response has `X-Request-Id` (the caller's `X-Request-Id`/`cf-ray` if safe, else a UUID).
- Workers log one JSON line per request (`service`, `event`, `request_id`, `project_id`, `method`, `path`, `status`, `duration_ms`)
  plus events such as `records_rejected`, `enqueue_failed`, `batch`, `trace_store_failed`, `retention`. Query strings, headers
  and bodies are never logged; values pass through a redactor that masks secret-like keys and scrubs emails, card numbers and bearer tokens.

## Performance notes

- Ingest streams and gunzips the body with a decoded-size cap (gzip bombs stop at `MAX_BODY_BYTES`), and API-key lookups use a 60s KV edge cache (key disables take up to a minute).
- The consumer processes a queue batch as a whole: payloads load in parallel, records regroup by (project, trace) across messages,
  traces store with concurrency 6, SQL hashes are computed once per statement, and only failed messages are retried.
- R2 writes are single `put`s of a known-size string: a trace object is read-modified-written on merge, so it is built in memory
  anyway. Reads of raw traces are streamed (`GET /v1/projects/:id/traces/:trace/raw`).

## Not implemented

- Billing: usage is counted per project per day and can trigger a daily quota block, but nothing is billed.
- Dashboard users: the owner enters a read key, which stays in that browser (sessionStorage, or localStorage when remembered)
  and is cleared on a 401. There are no users, sessions or SSO; use Cloudflare Access for that.
- Key management UI or API: keys are managed with the `scripts/keys.ts` CLI only.
- Alerts for ingest-side errors (only pipeline alerts exist), source maps for browser errors.

## Projects (single-tenant)

- **Tag, not tenant:** `project_id` groups data by app. Ingest takes it from `X-EdgeWatch-Project` (laravel-edgewatch sends
  `EDGEWATCH_PROJECT_ID`) or `?project=` (1-64 of `A-Z a-z 0-9 . _ -`, else `422`); without a tag the key's default project is used.
  `/api/agent-auth` with a tag mints an agent token for that project. Any ingest key may write to any project.
- **Storage:** D1 `traces`, `exceptions` and `queries` carry `project_id` (part of the trace primary key) with `(project_id, timestamp)`
  indexes (`0001_init.sql`, `0002_project_indexes.sql`). R2 objects live at `traces/{project_id}/{date}/{trace_id}.json`, so the same
  trace id in two projects never collides.
- **Reads:** any read key reads everything. Data routes exist as `/v1/projects/:projectId/...` (filtered) and `/v1/...` with an optional
  `?project_id=` (all projects without it). `GET /v1/projects` lists every project that has sent data.
- **Dashboard:** the sidebar project selector (Kumo `Select`) sets the active project (saved in localStorage); all pages refetch for it.
  Seed-data mode ships two demo projects (`demo` shop, `billing-api`).
