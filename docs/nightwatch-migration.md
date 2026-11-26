# Migrating from Laravel Nightwatch to EdgeWatch

EdgeWatch implements the Nightwatch **agent → cloud** contract of `laravel/nightwatch` v1.30.6
(details and sources: [nightwatch-compat.md](nightwatch-compat.md)). Two ways to switch:

## Option A: keep the official package and agent (no code changes)

```dotenv
NIGHTWATCH_TOKEN=ew_live_...                         # an EdgeWatch ingest key
```

Run the agent with EdgeWatch as its base URL:

```bash
NIGHTWATCH_BASE_URL=https://edgewatch-ingest.<subdomain>.workers.dev php artisan nightwatch:agent
```

- `NIGHTWATCH_BASE_URL` is read by the agent source (`agent/build/agent.phar`) but is not in Nightwatch's public docs, so a
  future agent release could change it. Verified locally with agent 1.30.6 ("Authentication successful", "Ingest successful").
- The agent calls `POST /api/agent-auth`, then `POST {ingest_url}` with gzip `{"records": [...]}`. EdgeWatch returns the
  `{token, expires_in, refresh_in, ingest_url}` shape the agent validates, and `429 {stop: true, refresh_in}` when over quota.
- Everything the official package records is accepted. Record types EdgeWatch does not model yet are stored raw in R2.

## Option B: replace the package with edgewatch/laravel-edgewatch (agentless)

```bash
composer remove laravel/nightwatch
composer require edgewatch/laravel-edgewatch   # not on Packagist yet: use a path/VCS repository
```

```dotenv
EDGEWATCH_TOKEN=ew_live_...
EDGEWATCH_INGEST_URI=https://edgewatch-ingest.<subdomain>.workers.dev/api/ingest
```

Every `EDGEWATCH_*` key falls back to the matching `NIGHTWATCH_*` key (`NIGHTWATCH_TOKEN`, `NIGHTWATCH_REQUEST_SAMPLE_RATE`,
`NIGHTWATCH_IGNORE_QUERIES`, ...), so existing Nightwatch env files keep working. Setting `EDGEWATCH_INGEST_URI` to
`127.0.0.1:2407` sends to a Nightwatch agent over TCP instead.

`EDGEWATCH_TRANSPORT=auto` (the default) picks the transport from `EDGEWATCH_INGEST_URI`:

| `EDGEWATCH_INGEST_URI` | Transport | Sends to |
| --- | --- | --- |
| not set, or `host:port` (`127.0.0.1:2407`, `agent:2407`) | agent (TCP) | that address (default `127.0.0.1:2407`) |
| `https://host/path` or `http://host/path` | HTTP | that URL |
| `https://host` (no path) | HTTP | `https://host/api/ingest` |
| `host.example.com` or `host.example.com/path` (no scheme) | HTTP | `https://host.example.com/api/ingest` (or the given path) |

HTTP with no `EDGEWATCH_TOKEN`/`NIGHTWATCH_TOKEN` is turned off rather than sending requests that would all get 401.
Set `EDGEWATCH_TRANSPORT=http`, `agent` or `null` to override the detection.

Check the connection:

```console
$ php artisan edgewatch:test
Transport: http (auto: ingest URL)
Endpoint:  https://edgewatch-ingest.<subdomain>.workers.dev/api/ingest
PASS  HTTP 200 in 84 ms (empty batch, no telemetry sent)
```

It sends one empty batch (`{"records":[]}`) with the normal token and project headers, so it tests the route, TLS and
the token without sending any data. It prints the exact HTTP status and latency, adds the server's error message and a
hint on failure (401 token, 404 path, 429 rate limit or quota, 5xx `/healthz`), and exits 1 on anything but 2xx. With
the agent transport it only opens and closes a TCP connection to the agent, so there is no HTTP status to report.
`--timeout=<seconds>` (default 5) bounds the check.

Queue workers: a job that fails before `handle()` runs (for example its attempts were used up by a worker that died)
is still recorded as a failed attempt; an attempt still open when the worker stops (timeout, memory limit,
`queue:restart`) or when the next job starts is recorded as `released` and sent at once; a job whose stored payload
cannot be decoded is recorded with the name `unknown` instead of being dropped. A job that cannot be serialized on
dispatch never reaches the queue, so it produces an exception record and no `queued-job` record.

| | laravel/nightwatch 1.30.6 | laravel-edgewatch |
| --- | --- | --- |
| Records | request, query, exception, command, job-attempt, queued-job, scheduled-task, cache-event, outgoing-request, mail, notification, log, user | same 13 record types |
| Transport | TCP to a local agent | Direct HTTPS (gzip) or TCP to the agent; 0.5 s timeouts |
| SQL literals | sent as-is | stripped client-side (also stripped again in the consumer) |
| PII in messages | not scrubbed | scrubbed client-side and in the consumer |
| Over quota | agent pauses on `stop` | transport pauses on 429 / `stop` (shared via `storage/framework/edgewatch-backoff.json`) |

Logs: add `edgewatch` to `LOG_STACK` (e.g. `LOG_STACK=single,edgewatch`); an existing `nightwatch` entry also works. `EDGEWATCH_LOG_LEVEL` (falls back to `NIGHTWATCH_LOG_LEVEL`) sets the minimum level.

## Several Laravel apps (projects)

EdgeWatch is single-tenant. Use one ingest key for all your apps (`EDGEWATCH_TOKEN` or `NIGHTWATCH_TOKEN`) and set
`EDGEWATCH_PROJECT_ID=shop`, `EDGEWATCH_PROJECT_ID=billing-api`, ... in each app's `.env` to tag its data. The official agent cannot
send a tag, so with Option A create one ingest key per app (`create-key shop ingest`); untagged data goes to the key's default
project. One read key shows every project in the dashboard's project selector.

## Captured environments (EdgeWatch client)

The EdgeWatch Laravel client adds the configured environment to execution records. It defaults to `APP_ENV`;
set `EDGEWATCH_ENVIRONMENT=staging` to override it (maximum 128 characters). Apply migration 0021 before upgrading
the consumer and API. The dashboard Environment selector scopes investigations and trace details show the captured value.
Pipeline and Setup remain project-wide, as do issue status changes and lifecycle history. Historical traces and clients without the field remain Unknown;
server and deployment names are never used to infer an environment.

## Browser errors (EdgeWatch only)

Nightwatch has no browser telemetry. EdgeWatch adds `POST /api/browser` and `@edgewatch/browser`
([packages/browser](../packages/browser/README.md)). To link a browser error to the server trace, render
`<meta name="edgewatch-trace-id" content="{{ app(\EdgeWatch\Laravel\EdgeWatch::class)->traceId() }}">` (laravel-edgewatch only).

## What you lose vs Nightwatch cloud

No alerts, issue assignment, user management, team accounts, long-term retention policies or the Nightwatch UI.
EdgeWatch's dashboard covers overview, traces with waterfall, exceptions and queries.

## What to set when pointing the official agent at EdgeWatch (verified against laravel/nightwatch 1.30.6)

| Variable | Where | Effect | Source |
| --- | --- | --- | --- |
| `NIGHTWATCH_TOKEN` | app and agent | App: only hashed (`xxh128`, first 7 chars) to frame TCP payloads to the agent. Agent: sent verbatim as `Authorization: Bearer` to `/api/agent-auth`. No format check, so EdgeWatch `ew_live_...` keys work. | `src/NightwatchServiceProvider.php:252`, agent `src/agent.php:46,110,133`, agent `src/Server.php:43` |
| `NIGHTWATCH_BASE_URL` | agent only | Base URL for `/api/agent-auth` (default `https://nightwatch.laravel.com`). Set it to the EdgeWatch ingest origin. Undocumented. | agent `src/agent.php:49` |
| `NIGHTWATCH_SERVER` | app (config) and agent (`--server`) | Only the server name: the `nightwatch-server` header and the records' `server` field (default `gethostname()`). It does **not** choose the endpoint. | `config/nightwatch.php:7`, `src/Console/AgentCommand.php:67`, agent `src/agent.php:67,133,138` |
| `NIGHTWATCH_INGEST_URI` | app and agent | Local TCP address of the agent (default `127.0.0.1:2407`), not the cloud. | agent `src/agent.php:52` |

`php artisan nightwatch:agent` must be running (start guide). `/api/agent-auth` must return JSON with `token` (string),
`expires_in` (int), `refresh_in` (int) and `ingest_url` (string); anything else makes the agent log
`Invalid authentication response` and retry (`agent src/IngestDetailsRepository.php` `parseResponse`). Extra keys are ignored.
EdgeWatch returns exactly these four keys (`workers/ingest/src/index.ts`, `/api/agent-auth`).
