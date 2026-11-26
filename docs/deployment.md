# Deploying EdgeWatch to Cloudflare

The Cloudflare deployment uses three Workers and a Pages dashboard. The dashboard proxies account and read API
requests through a service binding, so browser traffic stays on its own origin. The checked-in resource IDs belong
to the test installation; provision your own account before reusing these configs.

## Prerequisites

- Bun 1.4.5+ (`bun install` at the repo root) and Node 22.12+ (Wrangler runs on Node).
- A Cloudflare account (Workers Free supports Queues with 24-hour retention), and either `bunx wrangler login` or `CLOUDFLARE_API_TOKEN`
  (+ `CLOUDFLARE_ACCOUNT_ID`) with Workers, KV, D1, R2, Queues and Pages edit permissions.

## 1. Create resources and write IDs into wrangler configs

```bash
bun run setup:cloudflare --validate  # preflight only: every binding, queue, cron, URL, the token and Worker secrets; exits 1 on errors
bun run setup:cloudflare --dry-run   # no changes; offline plan without a token, read-only with one
bun run setup:cloudflare             # find-or-create, write IDs over placeholders, apply migrations, set the signing secret
```

`scripts/setup-cloudflare.ts` (Cloudflare REST API, needs `CLOUDFLARE_API_TOKEN`; exits 1 with instructions if it is missing):

- Finds or creates, by name: KV namespace `edgewatch-api-keys` (`EDGEWATCH_KV_TITLE`), and the D1 database, R2 bucket, queue and
  DLQ named in the wrangler configs. Re-running reuses them, so nothing is duplicated.
- Writes the KV and D1 IDs into `workers/*/wrangler.jsonc`, but only over `REPLACE_WITH_*` placeholders. A different real ID is
  kept with a warning unless you pass `--force`. Comments in the configs are preserved.
- Applies D1 migrations (`wrangler d1 migrations apply --remote`; already-applied files are skipped). `--skip-migrations` to skip.
- Creates the ingest queue and DLQ with 14-day message retention by default. Set `EDGEWATCH_QUEUE_RETENTION_SECONDS=86400` for Workers Free on every setup run; paid plans support up to 1209600 seconds.
- Sets R2 lifecycle rules (`incoming/` 1 day, `traces/` `EDGEWATCH_RETENTION_DAYS`+1 days), keeping other rules on the bucket.
- Sets `TOKEN_SIGNING_SECRET` on `edgewatch-ingest` if missing. Before the first deploy the Worker does not exist yet, so
  the run ends with `Status: pending`, prints the exact next commands (`scripts/deploy.sh`, then `bun run setup:cloudflare`)
  and exits 0. The second run reuses every resource and sets the secret (`Status: complete`). `--skip-secret` to skip.
- It is one idempotent bootstrap: run it before the first deploy and again after it (or after any upgrade); both succeed.
- `--dry-run` changes nothing: offline plan without a token, read-only API calls with one.
- **Preflight.** Every run first checks, with reads only: each wrangler config parses and has the bindings its Worker
  reads (`API_KEYS`, `TRACES`, `INGEST_QUEUE`, and `DB` unless the config selects Hyperdrive or libSQL); the consumer
  consumes the ingest queue and its dead-letter queue, `DEAD_LETTER_QUEUE` matches, and both crons are set; the Workers
  bind the same bucket and database; `EDGEWATCH_POSTGRES_URL`/`EDGEWATCH_MYSQL_URL` are complete; the token is accepted;
  and the secrets each config needs exist on the deployed Worker (`TOKEN_SIGNING_SECRET`; `LIBSQL_AUTH_TOKEN` when
  `LIBSQL_URL` is set; `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` when `S3_BUCKET` is set). Any error stops the run
  before the first remote change. `--validate` runs only this and exits 1 on an error; without a token the account and
  secret checks are reported as skipped. A Worker that is not deployed yet is a warning, not an error.

Commit the updated configs (IDs are not secrets). See [Configuration reference](#configuration-reference) for the
placeholder rules, which resources the Workers share, and every variable.

## Configuration reference

### `REPLACE_WITH_*` placeholders

This is the only place the placeholder rules are defined.

- A resource ID in `workers/*/wrangler.jsonc` whose value starts with `REPLACE_WITH_` (for example
  `REPLACE_WITH_KV_NAMESPACE_ID`, `REPLACE_WITH_D1_DATABASE_ID`) means "not provisioned yet".
- `bun run setup:cloudflare` writes real IDs only over placeholders. A real ID that differs from what Cloudflare has is
  kept with a warning unless you pass `--force`; `--dry-run` shows what it would write.
- `scripts/deploy.sh workers` refuses to run while any `REPLACE_WITH_` value is left in a Worker config, and
  `scripts/d1-migrate.sh --remote` while the D1 ID is still `REPLACE_WITH_D1_DATABASE_ID`.
- The checked-in configs carry the IDs of the project's test installation, not placeholders. To use your own account,
  put the placeholders back (or run the setup with `--force`) so the setup writes your IDs.

### Shared resources (intentional)

| Resource | Bound by | Why it is shared |
|---|---|---|
| D1 `edgewatch` (`DB`, same `database_id`) | `workers/consumer`, `workers/api` | One event store: the consumer writes, the API reads. Different IDs would split the data. `workers/ingest` has no D1 binding (it only needs one with `KEY_STORE=sql`, then it must be the same database). |
| KV `API_KEYS` (same `id`) | ingest, consumer, api | One key store: keys created once are checked by ingest and the API; the consumer reads project quotas. |
| R2 `edgewatch-traces` (`TRACES`) | ingest, consumer, api | Raw batches and trace blobs written by ingest/consumer are served by the API. |
| Queue `edgewatch-ingest` (+ `-dlq`) | ingest (producer), consumer | The pipeline between them. |

The setup preflight fails if the Workers bind different databases or buckets.

### `ratelimits` `namespace_id`

`workers/ingest/wrangler.jsonc` binds `RATE_LIMITER` with `namespace_id: "1001"` and `simple: { limit: 600, period: 60 }`.
`namespace_id` is required by Cloudflare: a positive integer, written as a string, that identifies the counter. It must
be unique among the rate-limit namespaces in your account, and stay the same across deploys (changing it resets the
counters). Keep `simple.period` equal to `RATE_LIMIT_PERIOD` (10 or 60). The binding is optional: without it ingest does
not rate limit and `/healthz` reports `rate_limiter: not_configured`.

### Environment variables

The first two rows are set in the Laravel app that runs the official agent; the rest configure EdgeWatch.
Worker vars live in `vars` in `workers/<name>/wrangler.jsonc`; secrets are set with
`bunx wrangler secret put <NAME>` in that Worker's directory. The single-process server (`apps/server`, Docker) reads all
of them from its environment. Scripts read theirs from the shell.

| Variable | Used by | Kind | Default | Meaning |
|---|---|---|---|---|
| `NIGHTWATCH_BASE_URL` | Laravel app's `php artisan nightwatch:agent` | agent env | `https://nightwatch.laravel.com` | Ingest contract: the EdgeWatch ingest origin (e.g. `https://edgewatch-ingest.<subdomain>.workers.dev`). Set on the agent, not on EdgeWatch. |
| `NIGHTWATCH_TOKEN` | Laravel app and agent | app/agent env | unset | Ingest contract: an EdgeWatch ingest key (`create-key <project> ingest`); its default project receives the data. |
| `TOKEN_SIGNING_SECRET` | ingest, server | secret, required | server: generated in `EDGEWATCH_DATA_DIR` | Signs short-lived agent ingest tokens. Set by `setup:cloudflare` (pending until ingest is deployed). |
| `TOKEN_TTL` | ingest | var | `3600` | Agent ingest token lifetime, seconds. |
| `MAX_BODY_BYTES` | ingest, server | var | `20000000` | Ingest body ceiling in decoded bytes; larger bodies get 413. Malformed values use the default. |
| `RATE_LIMIT_PERIOD` | ingest, server | var | `60` | Rate-limit window, seconds (10 or 60 on Workers; match `ratelimits.simple.period`). |
| `RATE_LIMIT` | server | var | `600` | Requests per project per window on the server; `0` disables. Workers use `ratelimits.simple.limit`. |
| `INGEST_URL` | ingest, server | var | request origin + `/api/ingest` | Public ingest URL returned to agents (set it behind a custom domain). |
| `KEY_STORE` | ingest, consumer, api | var | `kv` | `sql` stores API keys in the event store instead of KV. |
| `HYPERDRIVE` | consumer, api | binding | unset | Postgres/MySQL event store via Hyperdrive instead of D1. |
| `LIBSQL_URL` | consumer, api | var | unset | libSQL/Turso event store instead of D1. Cannot be combined with `HYPERDRIVE`. |
| `LIBSQL_AUTH_TOKEN` | consumer, api, server | secret | unset | libSQL auth token; required when `LIBSQL_URL` (or a libSQL `DATABASE_URL`) is set. |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION` | ingest, consumer, api, server | var | unset; region `auto` | S3-compatible blob store instead of R2. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | ingest, consumer, api, server | secret | unset | Required when `S3_BUCKET` is set. |
| `RETENTION_DAYS` | consumer, server | var | `30` | Default event retention; per-project `retention_days` overrides it. |
| `DEAD_LETTER_QUEUE` | consumer | var | `edgewatch-ingest-dlq` | Must match the consumer's `dead_letter_queue`. |
| `ALERT_LAG_SECONDS` | consumer, server | var | `600` | Pipeline lag before an alert. |
| `ALERT_WEBHOOK_URL` | consumer, server | secret | unset | Slack-compatible webhook for pipeline alerts. |
| `DAILY_RECORD_QUOTA` | consumer, server | var | `0` (off) | Records per project per day before ingest answers 429. |
| `CORS_ORIGIN` | api, server | var | `*` | Allowed origin for the read API; set it to the dashboard origin. |
| `DASHBOARD_ORIGIN` | api, server | var | unset | Extra origin accepted for cookie-authenticated `/auth/*` and account requests. |
| `OWNER_SETUP_TOKEN` | api, server | secret | unset | Required on the browser owner claim. See [first-owner setup](#dashboard-account-routing). |
| `OWNER_EMAIL`, `OWNER_PASSWORD`, `OWNER_NAME` | api, server | secret | unset | Creates the owner on the first request. Without these or `OWNER_SETUP_TOKEN`, setup is refused. |
| `PORT`, `HOST` | server | env | `8080`, `0.0.0.0` | Listen address. |
| `TRUSTED_PROXY_HEADER` | server | env | unset | Header holding the client address when the server runs behind a reverse proxy (for example `x-forwarded-for`; the first entry is used). Unset: the socket address is used and any client-sent `cf-connecting-ip` is replaced, so sign-in throttling cannot be bypassed. Only set it when every request passes through that proxy. |
| `EDGEWATCH_DATA_DIR` | server | env | `./data` (`/data` in Docker) | SQLite file, local blobs, generated signing secret. |
| `DATABASE_URL`, `DATABASE_POOL` | server | env | SQLite; pool `10` | `postgres://`, `mysql://` or libSQL URL for the event store. |
| `DASHBOARD_DIR` | server | env | set in Docker | Serves the built dashboard. |
| `ACCESS_LOG` | server | env | off | One log line per request. |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | `setup:cloudflare`, wrangler | shell | unset | API token (required for real runs); account ID when the token sees several. |
| `EDGEWATCH_KV_TITLE`, `EDGEWATCH_HYPERDRIVE_NAME` | `setup:cloudflare` | shell | `edgewatch-api-keys`, `edgewatch-pg` | Resource names to find or create. |
| `EDGEWATCH_QUEUE_RETENTION_SECONDS` | `setup:cloudflare` | shell | `1209600` | Queue retention; `86400` on Workers Free. |
| `EDGEWATCH_RETENTION_DAYS` | `setup:cloudflare` | shell | `30` | R2 lifecycle for `traces/`; use the longest retention you configure, or `0`. |
| `EDGEWATCH_POSTGRES_URL`, `EDGEWATCH_MYSQL_URL` | `setup:cloudflare` | shell | unset | Creates Hyperdrive and runs the external-database migrations. |
| `VITE_API_URL`, `VITE_PROJECT_ID` | dashboard build | build | unset (seed-data demo mode) | API base (`/` = same origin, or an HTTP(S) URL) and default project. Never put a key, token or password in a `VITE_*` variable. |
| `EDGEWATCH_PAGES_PROJECT` | `deploy.sh` | shell | `edgewatch-dashboard` | Pages project name. |

## 2. Apply D1 migrations (already done by step 1; manual alternative)

```bash
scripts/d1-migrate.sh --remote    # refuses to run while the D1 placeholder is still present
scripts/d1-migrate.sh --local     # local wrangler dev state
```

## 3. Deploy the Workers

On every upgrade, back up the database and apply pending migrations before deploying. `deploy.sh` does not apply
migrations; use step 2 for D1 or the matching `bun run migrate:<backend>` command for an external database.

```bash
scripts/deploy.sh workers         # consumer, then ingest, then api (wrangler deploy in each)
```

Each Worker can also be deployed alone: `cd workers/<name> && bunx wrangler deploy`.
Optional ingest vars: `TOKEN_TTL`, `MAX_BODY_BYTES`, `RATE_LIMIT_PERIOD`, `INGEST_URL` (public ingest URL if behind a custom domain).

**Ingest payload ceiling (`MAX_BODY_BYTES`, default `20000000` = 20 MB).** `POST /api/ingest` rejects a body larger
than this with `413 payload_too_large` before buffering it: a `Content-Length` above the limit is refused before any
byte is read, and a body without `Content-Length` (chunked) is counted while it streams and cut off at the first byte
over the limit. The limit applies to the decoded size, so a gzip body cannot inflate past it. A missing, empty or
malformed value uses the default; it is never treated as "no limit".
API var: `CORS_ORIGIN` (default `*`; set it to the dashboard origin).

## 4. Create API keys

```bash
bun run --filter @edgewatch/ingest create-key my-app ingest server --remote    # NIGHTWATCH_TOKEN for the official agent
bun run --filter @edgewatch/ingest create-key my-app read dashboard --remote   # optional credential for API integrations
```

Each key is printed once. Add `--expires 90d` to make it expire.
Manage keys afterwards with the same CLI (`--remote` is the default; use `--local` for `wrangler dev` state):

```bash
bun run --filter @edgewatch/ingest keys list                   # id, status (active/expired/revoked), scopes, project, expiry
bun run --filter @edgewatch/ingest keys rotate <id> --grace 7d  # new key, same project/scopes; old one expires in 7 days
bun run --filter @edgewatch/ingest keys revoke <id>
bun run --filter @edgewatch/ingest keys audit                  # who created, rotated or revoked which key, and when
```

A revoked key can pass for up to 60 s (KV edge cache), and agent tokens it already issued stay valid until `TOKEN_TTL`.

## 5. Deploy the dashboard (Cloudflare Pages)

```bash
VITE_API_URL=/ VITE_PROJECT_ID=my-app \
  scripts/deploy.sh dashboard
```

The deploy script rejects unknown targets and extra arguments. For `all`, it validates configuration and completes
the dashboard build before deploying any Worker. Dashboard-only deployment does not require local Worker resource IDs.
`VITE_API_URL` accepts an HTTP(S) base URL or a root-relative path, without credentials, query parameters or a fragment.

Builds `apps/dashboard` and runs `wrangler pages deploy` to project `edgewatch-dashboard` (`EDGEWATCH_PAGES_PROJECT` to change).
`public/_redirects` provides SPA routing. **Users sign in with email and password; sessions use HttpOnly cookies**: put the dashboard behind
Cloudflare Access (or similar) when SSO is required.

### Dashboard account routing

Deploy the account-enabled dashboard with `VITE_API_URL=/`. Its Pages Worker forwards `/auth/*` and `/v1/*`
to the `API` service binding in `apps/dashboard/wrangler.jsonc`, keeping session cookies on the dashboard origin.
If the API Worker is renamed, update that binding. The standalone server also routes `/auth/*` to the API.
Apply migrations 0022 and 0023 before deploying the account-enabled API. Account creation is invite-only after the
owner account exists. First-owner setup fails closed: a fresh installation refuses the public claim
(`POST /auth/setup` answers `403 setup_disabled` with the fix in the message) until one of these is configured:

1. **Token-gated claim in the browser (`OWNER_SETUP_TOKEN`):** `cd workers/api && bunx wrangler secret put OWNER_SETUP_TOKEN`
   (or `-e OWNER_SETUP_TOKEN=...` for the server). The dashboard opens **Set up your owner account** and the claim must
   include that token; a missing or wrong token gets `403 Invalid setup token.` After setup, remove it with
   `bunx wrangler secret delete OWNER_SETUP_TOKEN`.
2. **Pre-configured credentials (`OWNER_EMAIL` + `OWNER_PASSWORD`, optional `OWNER_NAME`):** the owner account is created
   automatically on the first request. The public claim stays refused (it would let someone else pick the owner); if the
   values are invalid (bad email, password under 8 characters) the refusal says so.

With neither set, nobody can become owner. Setup locks permanently once the owner account exists (`409`).

The owner can create seven-day invitation links in **Accounts**. Share links privately; email delivery is not configured.
Viewers can read telemetry; admins can also triage issues and replay dead letters; only the owner manages accounts.
Disabling a member ends their sessions. Logout revokes the current session; normal sessions expire after 12 hours,
or 30 days when remembered. All roles can access all projects in this single-owner installation. Never put a setup token or password in a Vite variable.

Manage or recover dashboard accounts directly against Cloudflare D1 without deleting any telemetry or other accounts (`--remote` is the default; use `--local` for `wrangler dev` state):

```bash
bun run --filter @edgewatch/api accounts list
bun run --filter @edgewatch/api accounts create --email admin@example.com --password 'changeme123' --role owner
bun run --filter @edgewatch/api accounts reset-password --email admin@example.com --password 'new-password'
bun run --filter @edgewatch/api accounts reset-password --owner --password 'new-password' --new-email admin@example.com
```

Passwords can also be piped via `--password-stdin` or passed via `EDGEWATCH_PASSWORD`. Resetting a password revokes only that account's active sessions and clears its login rate-limit window.

## 6. Point applications at it

See [nightwatch-migration.md](nightwatch-migration.md).

## Optional: Postgres or MySQL through Hyperdrive instead of D1

For more traffic or retention than D1's 10 GB holds (see [capacity.md](capacity.md#choosing-a-backend)). The Workers,
R2, KV and Queues stay the same; only the event store moves.

**With the setup script** (token also needs Hyperdrive:Edit):

```bash
EDGEWATCH_POSTGRES_URL="postgres://user:pass@host:5432/edgewatch" bun run setup:cloudflare
```

This finds or creates the Hyperdrive configuration `edgewatch-pg` (`EDGEWATCH_HYPERDRIVE_NAME` to rename it), adds
the `HYPERDRIVE` binding to the consumer and API configs, and runs the Postgres migrations. The URL is never logged.
Deploy both Workers afterwards.

**By hand:**

1. Create the schema with a direct connection string (not the Hyperdrive one):
   `bun run migrate:postgres "postgres://user:pass@host:5432/edgewatch"`. Re-run it after upgrades; it applies only new files.
2. Create a Hyperdrive configuration: `bunx wrangler hyperdrive create edgewatch-pg --connection-string="postgres://..."`.
3. Add the binding to `workers/consumer/wrangler.jsonc` and `workers/api/wrangler.jsonc`:
   `"hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<id from step 2>" }]`, then deploy both.

The D1 binding stays in the configs but is unused while `HYPERDRIVE` is bound. `backup:d1` does not cover Postgres; use
your provider's backups. This path has only been tested locally (`bun run e2e:postgres`), not on a real account.

**MySQL 8.0.19+** works the same way: `EDGEWATCH_MYSQL_URL="mysql://user:pass@host:3306/edgewatch" bun run setup:cloudflare`
(Hyperdrive configuration `edgewatch-mysql`), or by hand with `bun run migrate:mysql "mysql://..."` and
`wrangler hyperdrive create edgewatch-mysql --connection-string="mysql://..."`. The consumer and API pick the MySQL
driver from the `mysql://` scheme. MySQL commits each DDL statement on its own, so a migration file that fails halfway
stays half-applied: fix the cause and finish that file by hand before rerunning. Indexed text values (project IDs,
routes, users, hashes) are limited to 255 characters, and longer values are cut with a warning. Tested locally only
(`bun run e2e:mysql`, `bun run test:mysql`).

## Optional: libSQL / Turso instead of D1

libSQL speaks SQLite, so the D1 migrations and queries run on it unchanged. No Hyperdrive is involved: the consumer and
API reach it over HTTP.

1. Create the schema: `LIBSQL_AUTH_TOKEN=... bun run migrate:libsql "libsql://<db>-<org>.turso.io"`. Re-run it after
   upgrades; each file is applied in one transaction.
2. In `workers/consumer/wrangler.jsonc` and `workers/api/wrangler.jsonc`, add `"LIBSQL_URL": "libsql://..."` to `vars`.
   Then set the token on both: `bunx wrangler secret put LIBSQL_AUTH_TOKEN`. Deploy both.

`setup:cloudflare` does not automate this yet. `LIBSQL_URL` and `HYPERDRIVE` together are rejected at startup. Each
request or consumer batch opens its own HTTP client. Tested locally against `sqld` only (`bun run e2e:libsql`,
`bun run test:libsql`), not against Turso.

## Optional: S3-compatible storage and SQL keys instead of R2 and KV

Both are independent of the event store and of each other (details in [architecture.md](architecture.md#storage-backends)).

- **S3 instead of R2:** create the bucket, then set on all three Workers `S3_ENDPOINT`, `S3_BUCKET` and `S3_REGION` as
  vars and `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` as secrets (`bunx wrangler secret put ...`). Add a lifecycle rule
  on the bucket like the R2 one, and remove the `r2_buckets` binding if you no longer want it. Every blob read or write
  is then an S3 request from the Worker, so latency and egress follow your provider.
- **SQL keys instead of KV:** set `KEY_STORE=sql` on all three Workers. The ingest Worker then needs the event store
  too: bind `HYPERDRIVE` on it as well (or D1 as `DB`). Create keys with
  `bun run --filter @edgewatch/ingest keys create <project> ... --postgres <url>`; keys already in KV are not copied.

With Postgres, S3 and SQL keys together, only Queues is still Cloudflare-specific.

## Operations notes

- Over-quota block: `bunx wrangler kv key put --binding API_KEYS project:my-app '{"over_quota_until": 1767225600}' --remote` (from `workers/ingest`).
- Daily record quota: set `DAILY_RECORD_QUOTA` in `workers/consumer/wrangler.jsonc` (0 = none), or per project with
  `curl -X PUT -H "Authorization: Bearer $READ_KEY" -d '{"daily_record_quota": 100000}' $API/v1/projects/my-app/settings`
  (`null` = use the default, `0` = no quota). When a project reaches it, the consumer writes the KV block above until the next
  UTC midnight; raising or removing the quota lifts it. Counts: `GET /v1/usage?days=30` or the Pipeline page.
- Messages that fail all 20 retries land in `edgewatch-ingest-dlq`; the consumer stores them in D1 `dead_letters` and R2 `dead/`
  (kept until replayed). Replay from the dashboard's Pipeline page or `POST /v1/dead-letters/replay` (optional `{"ids": [...]}`);
  the consumer's 5-minute cron re-processes them.
- Alerts: `bunx wrangler secret put ALERT_WEBHOOK_URL` (from `workers/consumer`; a Slack incoming webhook works) sends dead-letter
  and queue-lag alerts (`ALERT_LAG_SECONDS`, default 600), each at most once per hour.
- Retention: `RETENTION_DAYS` in `workers/consumer/wrangler.jsonc` (hourly cron), or per project with
  `PUT /v1/projects/my-app/settings` `{"retention_days": 7}` (`null` = default, `0` = keep forever), plus R2 lifecycle rules
  from `setup-cloudflare.ts` (bucket-wide: use `EDGEWATCH_RETENTION_DAYS` = the longest retention, or 0).
- Logs: Workers Logs is enabled (`observability.enabled`); filter on `request_id` (also in the `X-Request-Id` response header) or `project_id`.
- Backups: see "Backups and restore" below.
- CI is configured in `.github/workflows/ci.yml`; its [first successful hosted run](https://github.com/n3crosis/edgewatch/actions/runs/45364773853) passed. Deployments are manual via the scripts above. Release steps: [release-checklist.md](release-checklist.md).

## Backups and restore

- **Point in time (D1 Time Travel):** Cloudflare keeps D1 history for 30 days on the Workers Paid plan (7 days on Free).
  `bunx wrangler d1 time-travel info edgewatch --timestamp <unix or RFC3339>` shows the bookmark;
  `bunx wrangler d1 time-travel restore edgewatch --timestamp <...>` rewinds the database in place (run from `workers/consumer`).
- **Dumps:** `bun run backup:d1` runs `wrangler d1 export --remote`, gzips the SQL to `backups/edgewatch-d1-<time>.sql.gz` and keeps
  the newest 14 (`--keep N`, `--out DIR`). `--r2 <bucket>` also uploads it to `<bucket>/backups/`; use a bucket without the traces
  lifecycle rule. `--local` dumps the self-hosting state in `.wrangler/state`. Cloudflare notes a remote export can block other
  queries to the database while it runs, so schedule it at a quiet time; the queue buffers ingest meanwhile.
- **Restore a dump** into a new database, then point the Workers at it:
  ```bash
  cd workers/consumer
  bunx wrangler d1 create edgewatch-restore
  gunzip -k ../../backups/edgewatch-d1-<time>.sql.gz
  bunx wrangler d1 execute edgewatch-restore --remote --file ../../backups/edgewatch-d1-<time>.sql
  # put the new database_id in workers/consumer and workers/api wrangler.jsonc, then deploy
  ```
- **Not in the dump:** trace JSON and dead-letter payloads in R2, and API keys in KV. Copy R2 with any S3-compatible tool (R2 has an
  S3 API), and keep raw API keys in your own secret store (KV only holds hashes). A restored D1 with missing R2 objects still lists
  traces; their detail view shows the summary without raw records.
- Schema and record compatibility rules: [record-versions.md](record-versions.md).

### Read and operator permissions

Read keys can inspect every project but cannot change settings or request dead-letter replay. Those actions require
the `admin` scope, which also permits reads. Create an operator credential with
`bun run --filter @edgewatch/ingest keys create <project> admin dashboard-admin` for programmatic API access. Dashboard users sign in with their account password.
Existing read keys remain valid for reads; create a separate admin key when upgrading. Ingest and browser keys
do not gain administrative access. Projects remain filters within a single-owner installation.

## Health checks

Every Worker answers `GET /healthz` without a key (the consumer's only HTTP route). The body is typed
(`HealthReport` in `packages/shared/src/health.ts`):

```json
{ "status": "ok", "service": "api", "checked_at": "2026-11-25T03:00:00.000Z",
  "checks": { "config": { "status": "ok", "required": true, "latency_ms": 0 },
              "events": { "status": "ok", "required": true, "latency_ms": 2, "backend": "d1" },
              "schema": { "status": "ok", "required": true, "latency_ms": 1, "backend": "d1" } } }
```

| Service | Checks (required unless noted) |
| --- | --- |
| ingest | backend config, key store read, blob store read, `INGEST_QUEUE` bound, `TOKEN_SIGNING_SECRET` set, `RATE_LIMITER` bound (optional), event store when `KEY_STORE=sql` |
| consumer | backend config, event store `SELECT 1`, schema (`traces` table), blob store read, key store read (optional: only the quota block uses it) |
| api | backend config, event store, schema, blob store read, key store read |

`status` is `ok`, `degraded` (an optional check failed; HTTP 200) or `down` (a required check failed; HTTP 503).
Each check has a 3 s limit (`timeout`). Failures carry only a fixed reason (`timeout`, `unavailable`,
`not_configured`, `schema_missing`, `over_capacity`); the real error goes to Workers Logs as `health_check_failed`.
Probes read a key that never exists, so they write nothing. `GET /health` stays a plain liveness check.
The queue binding is only checked for presence: Queues has no read API from a Worker.
