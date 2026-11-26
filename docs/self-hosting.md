# Self-hosting and local development

Cloudflare Workers are the main target: deploy to your own account ([deployment.md](deployment.md)) or run locally with
`wrangler dev` (Miniflare/workerd). Without Cloudflare, the same Worker code runs as one Bun process or Docker container
(see [Single process / Docker](#single-process--docker) below).

## Single process / Docker

`apps/server` runs the ingest, consumer and API Workers' code plus the dashboard in one Bun process on one port, with:

| Piece | Default | Alternative |
| --- | --- | --- |
| Event store | SQLite file `$EDGEWATCH_DATA_DIR/edgewatch.sqlite` (WAL) | Postgres `DATABASE_URL=postgres://...` or MySQL 8.0.19+ `DATABASE_URL=mysql://...` (pool size `DATABASE_POOL`, default 10); libSQL/Turso `DATABASE_URL=libsql://...` or `http(s)://...` with `LIBSQL_AUTH_TOKEN` |
| Blobs | Files under `$EDGEWATCH_DATA_DIR/blobs` | S3-compatible: `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` |
| API keys | `kv_store` table in the event store | none |
| Queue | In-memory, batches of 50 / 1 s, same retry and dead-letter policy as the Workers | none |
| Rate limit | In-memory, `RATE_LIMIT` (600) per `RATE_LIMIT_PERIOD` (60 s) per project; `0` turns it off | none |
| Crons | Pipeline check every 5 min, retention hourly | none |

```bash
docker build -t edgewatch .
docker run -d -p 8080:8080 -v edgewatch-data:/data --name edgewatch edgewatch
# Required for first-owner setup (it fails closed without one of these):
#   -e OWNER_EMAIL=admin@example.com -e OWNER_PASSWORD=changeme123   (owner created on first request), or
#   -e OWNER_SETUP_TOKEN=<random>   (then open http://host:8080/ and claim the owner with that token)
# To create accounts or reset a forgotten password later without losing data:
# docker exec edgewatch bun apps/server/src/main.ts accounts reset-password --owner --password 'new-password'
docker exec edgewatch bun apps/server/src/main.ts keys create my-app --scopes ingest   # shown once
curl -s http://localhost:8080/healthz                                                  # {"status":"ok",...}
# Laravel: NIGHTWATCH_BASE_URL=http://host:8080 NIGHTWATCH_TOKEN=<ingest key> php artisan nightwatch:agent
# Dashboard: http://host:8080/
```

With Postgres and S3 instead of the volume's SQLite file and blob directory (keep `/data` for the queue journal and
signing secret):

```bash
docker run -d -p 8080:8080 -v edgewatch-data:/data --name edgewatch \
  -e DATABASE_URL=postgres://edgewatch:secret@db:5432/edgewatch \
  -e S3_ENDPOINT=https://s3.example.com -e S3_BUCKET=edgewatch -e S3_REGION=auto \
  -e S3_ACCESS_KEY_ID=... -e S3_SECRET_ACCESS_KEY=... \
  -e TOKEN_SIGNING_SECRET=... -e RETENTION_DAYS=30 edgewatch
```

The image (multi-stage, `oven/bun`, runs as the `bun` user, port 8080, data in `/data`) serves the built dashboard
from `DASHBOARD_DIR=/app/dashboard`. Logs are JSON lines on stdout; `ACCESS_LOG=1` adds one line per request.
`docker stop` sends SIGTERM: the server stops accepting, drains due queue work and exits (give it the default 10 s).

**Health.** `GET /healthz` returns the typed report described in
[deployment.md](deployment.md#health-checks), with `service: "server"` and these checks: event store (`SELECT 1`),
schema (`traces` table), blob store read, key store read, signing secret, and queue depth. The queue check is
optional: at 90% of the 10,000-message limit the server reports `degraded` (HTTP 200) with
`{ pending, capacity, dead_letters }`, before ingest starts answering 503. A failing required check returns 503,
which the image's `HEALTHCHECK` (every 30 s) turns into `unhealthy`; `docker inspect --format '{{.State.Health.Status}}' edgewatch`
shows it. `GET /health` stays a plain liveness check (`{"ok":true}`).

Without Docker: `bun run server` (same environment variables; `DASHBOARD_DIR` points at a dashboard built with
`VITE_API_URL=/`). `bun apps/server/src/main.ts migrate` applies migrations and exits; `serve` applies them on start.
`TOKEN_SIGNING_SECRET` is generated once into the data directory if unset. The other Worker vars (`RETENTION_DAYS`,
`DAILY_RECORD_QUOTA`, `ALERT_WEBHOOK_URL`, `MAX_BODY_BYTES`, `CORS_ORIGIN`, ...) work the same way.

Limits of the single process:
- Accepted messages are journaled in `EDGEWATCH_DATA_DIR/queue.sqlite`; persist this volume even with Postgres and S3.
  Ingest answers `503` with `Retry-After` when the pending queue reaches 10,000 messages. A clean stop drains due
  work and preserves delayed retries for restart. Delivery is at least once.
- Run one server process per deployment. Multiple writers to the same event store can race during trace merges,
  including when using Postgres and S3. Rate limits and key caches are also per process.
- SQLite takes one writer at a time; above the D1 sizing in [capacity.md](capacity.md#sizing-d1), use Postgres.
- Back up the data volume (or Postgres and the bucket) yourself; `backup:d1` is for D1 only.
- Checked with `bun run nightwatch-agent:server` (fresh Laravel 12 app with the official agent) and the
  `apps/server` tests; not load tested.

## Local setup

```bash
bun install
```

Requirements: Bun 1.4.5+, Node 22.12+ (Wrangler and Vitest run on Node). Only `bun run nightwatch-agent` also needs
PHP 8.2+ with sqlite, curl, mbstring, zlib, pcntl, posix and sockets, Composer 2 and network access (it installs
`laravel/laravel` and `laravel/nightwatch` into a temp dir).

## One-command live pipeline check

```bash
bun run e2e     # = scripts/e2e.sh
```

Starts `wrangler dev` for ingest + consumer (one process, so they share the local queue) on :8787 and the API on :8788 with
fresh state in `.wrangler/e2e-state`, applies migrations, creates ingest/read/admin keys in local KV, posts an agent-format gzip batch tagged for a second project, and agent-format batches with all 13 record types for two
more projects, then asserts the results through `workers/api` (D1 rows, R2 raw records, exception grouping/PII scrubbing,
`sql_hash` groups, project isolation), the agent-auth handshake and the 429 `stop` response. Exits non-zero on any failure; logs in `.wrangler/e2e-logs`. `E2E_KEEP=1` leaves everything running.

`bun run nightwatch-agent` (= `scripts/nightwatch-agent.sh`) checks the official agent end to end: a fresh Laravel 12
app with `laravel/nightwatch`, its unmodified `php artisan nightwatch:agent` pointed at local ingest with
`NIGHTWATCH_BASE_URL`, and every record type read back through `workers/api`. `RUNTIME=server` runs it against `apps/server`.

## Running pieces by hand

```bash
scripts/d1-migrate.sh --local
cd workers/ingest && bunx wrangler dev -c wrangler.jsonc -c ../consumer/wrangler.jsonc --persist-to ../../.wrangler/state --var TOKEN_SIGNING_SECRET:dev
cd workers/api && bunx wrangler dev --port 8788 --persist-to ../../.wrangler/state
bun run --filter @edgewatch/ingest create-key demo ingest,read local --local   # run inside workers/ingest with --persist-to if you changed it
VITE_API_URL=http://127.0.0.1:8788 VITE_PROJECT_ID=demo bun run dev:dashboard   # enter the read key when asked
```

Without `VITE_API_URL` the dashboard shows generated seed data, and its header badge says "Seed data".

## Tests

```bash
bun run test     # Vitest: shared, ingest, consumer, api (workerd pool), dashboard, server; then bun test scripts
```

## Limits of local mode

Local Workers Rate Limiting and KV `cacheTtl` behave differently from production; R2/D1 are emulated by Miniflare.

### Standalone queue durability

The server journals accepted messages and delayed retries to `EDGEWATCH_DATA_DIR/queue.sqlite`
with SQLite WAL and full synchronous commits. Keep this directory on persistent storage, including
when using a remote event database or S3. Run one server process per data directory. Delivery is
at least once: a crash after storage succeeds but before acknowledgment can redeliver a message.
The embedded `createEdgeWatch()` API uses memory queues unless a queue store is supplied.
