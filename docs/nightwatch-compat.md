# Laravel Nightwatch wire compatibility

EdgeWatch aims to be a drop-in backend for the official Laravel Nightwatch client.
Everything below was read directly from source; nothing here is inferred from marketing pages.

## Sources read

| Source | Version / date | Files |
| --- | --- | --- |
| `laravel/nightwatch` on Packagist (dist = GitHub tag) | **v1.30.6** (2026-10-27, ref `33000668ae9407d204d5033f39cdfe14de4ac161`) | `config/nightwatch.php`, `src/NightwatchServiceProvider.php`, `src/Ingest.php`, `src/Payload.php`, `src/RecordsBuffer.php`, `src/SocketStreamFactory.php`, `src/Sensors/*.php`, `src/Records/*.php`, `src/Concerns/RedactsHeaders.php`, `src/State/*.php`, `agent/helpers.php`, `agent/Dockerfile` |
| Agent PHAR bundled in the package | `agent/build/agent.phar` from v1.30.6 (extracted with `Phar::extractTo`) | `src/agent.php`, `src/Server.php`, `src/Payload.php`, `src/Ingest.php`, `src/IngestDetails.php`, `src/IngestDetailsRepository.php`, `src/StreamBuffer.php`, `src/Factories/BrowserFactory.php`, `src/CheckSignature.php` |
| `CHANGELOG.md`, `AGENTS.md` | `1.x` branch, fetched 2026-11-22 | Changelog entries #432 "Verify payload token before version", #428 "Refresh expired token before ingesting", #341 "Set user-agent on agent ingest requests", #294 "Handle expired tokens", #202 "Improve agent payload validation" |
| Docs: <https://nightwatch.laravel.com/docs/environment-variables> | fetched 2026-11-22 | env var names/defaults |
| Docs: <https://nightwatch.laravel.com/docs/guides/docker> | fetched 2026-11-22 | official image `laravelphp/nightwatch-agent:v1`, sidecar pattern, shared `NIGHTWATCH_TOKEN` |

## Architecture: two hops, two protocols

```
Laravel app ──(TCP, framed text, 127.0.0.1:2407)──▶ Nightwatch agent ──(HTTPS, gzip JSON)──▶ Nightwatch cloud
 laravel/nightwatch package                          `php artisan nightwatch:agent`             base: NIGHTWATCH_BASE_URL
                                                     or laravelphp/nightwatch-agent:v1          (default https://nightwatch.laravel.com)
```

* The Laravel package **never talks HTTP to the cloud**. It writes to a local agent over raw TCP
  (`config/nightwatch.php` → `ingest.uri`, default `127.0.0.1:2407`; `src/Ingest.php` prefixes `tcp://`).
* The agent is the only component that talks HTTPS. Its cloud base URL comes from the
  `NIGHTWATCH_BASE_URL` environment variable (`agent.phar:src/agent.php`:
  `$baseUrl ??= $_SERVER['NIGHTWATCH_BASE_URL'] ?? 'https://nightwatch.laravel.com'`).
  **This variable is not listed in the public environment-variables docs**; it exists only in the agent source.

**Consequence for EdgeWatch:** to accept data from an unmodified Nightwatch install, EdgeWatch must
implement the *agent → cloud* contract (hop 2). Users run the official agent with
`NIGHTWATCH_BASE_URL=https://<edgewatch-ingest-host>` and keep their app config unchanged.
The record payloads (hop 1) are forwarded verbatim by the agent, so the record shapes below are also what EdgeWatch ingests.

## Hop 1: app → agent (TCP)

Source: `src/Payload.php`, `src/Ingest.php`, `agent.phar:src/Server.php`, `agent.phar:src/Payload.php`.

* Frame: `<length>:v1:<tokenHash>:<body>`
  * `length` = `strlen("v1") + 1 + strlen(tokenHash) + 1 + strlen(body)` (decimal ASCII).
  * `tokenHash` = `substr(hash('xxh128', NIGHTWATCH_TOKEN), 0, 7)` (computed identically in app and agent).
  * `body` = JSON array of records (`json_encode` with `JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE|JSON_PRESERVE_ZERO_FRACTION|JSON_INVALID_UTF8_SUBSTITUTE`), or the text `PING`.
* One connection per batch. Agent replies `2:OK` once the frame is complete, then closes. The client reads 4 bytes and throws on anything else.
* Agent validation order (changelog #432): token hash first (`hash_equals`; mismatch → log "Incoming token hash mismatch!" and drop), then version (≠ `v1` → agent flushes and shuts down).
* Client defaults: `ingest.timeout` = 0.5 s (read), `ingest.connection_timeout` = 0.5 s, `ingest.event_buffer` = 500 records (buffer is flushed when full and at the end of each request/command/job). All transmission failures are swallowed and reported as unrecoverable (changelog #443).

## Hop 2: agent → cloud (HTTPS) — what EdgeWatch implements

### 2a. Authentication: `POST {NIGHTWATCH_BASE_URL}/api/agent-auth`

Source: `agent.phar:src/agent.php`, `agent.phar:src/IngestDetailsRepository.php`.

Request headers (exact):

| Header | Value |
| --- | --- |
| `accept` | `application/json` |
| `authorization` | `Bearer <NIGHTWATCH_TOKEN>` (the environment token, called "refresh token" in the agent) |
| `content-type` | `application/json` |
| `nightwatch-server` | `NIGHTWATCH_SERVER` / `--server` / `gethostname()` |
| `user-agent` | `NightwatchAgent/<version.txt>` (e.g. `NightwatchAgent/1.30.6`) |

Body: the literal string `{}`. Timeouts: connect 5 s, total 10 s.

Expected 2xx JSON response (all four keys required, types checked; otherwise "Invalid authentication response"):

```json
{ "token": "string", "expires_in": 3600, "refresh_in": 3000, "ingest_url": "https://.../ingest" }
```

* `expires_in`, `refresh_in` must be **integers** (seconds). The agent re-authenticates after `refresh_in`, and also before ingesting if `now > expires_at` (changelog #428).
* Error responses (non-2xx) may carry JSON `{ "message": string, "stop": bool, "refresh_in": number }`.
  `stop: true` makes the agent stop authenticating until `refresh_in`. Without `refresh_in` the agent backs off
  (2.5, 5, 10, 15, 30, 60, 120, 240, then 300 s… before first success; 300 s then 3600 s after).

### 2b. Ingest: `POST {ingest_url}`

Source: `agent.phar:src/Ingest.php`, `agent.phar:src/StreamBuffer.php`.

| Header | Value |
| --- | --- |
| `accept` | `application/json` |
| `authorization` | `Bearer <token from agent-auth>` |
| `content-encoding` | `gzip` |
| `content-type` | `application/json` |
| `nightwatch-server` | server name |
| `user-agent` | `NightwatchAgent/<version>` |

* Body: `gzencode('{"records":[ ...records... ]}')`. The agent concatenates the JSON arrays it received from apps.
* Flushed when the buffer reaches 6,000,000 bytes (uncompressed) or 10 s after the first buffered record. Max 5 concurrent requests. Timeouts: connect 5 s, total 10 s.
* Response: any 2xx = success. The body is parsed as JSON if possible; `{ "stop": true, "refresh_in": n, "message": "..." }`
  (on 2xx **or** error) pauses ingestion, drops buffered data and re-authenticates after `refresh_in` (default 900 s). This is how quota exhaustion is signalled.
* Non-2xx without `stop` is logged ("Ingest failed") and the batch is dropped; there is no retry.

**Not confirmed from source:** the exact status codes Nightwatch cloud returns (e.g. 401 vs 403 for a bad token, 429 for quota),
and the shape of a successful body. The agent only relies on 2xx vs non-2xx and on the optional `message`/`stop`/`refresh_in` keys, so EdgeWatch returns:
`200 {"ok":true,"accepted":n,"rejected":m,"errors":[...]}` on success, `401 {"message":"Unauthenticated."}` on missing, unknown, read-only or expired tokens,
`413` over `MAX_BODY_BYTES`, `422 {"message":"..."}` when the body is not JSON or has no `records` array, `503` if KV, R2 or the queue is unavailable.
Individually malformed records are dropped and counted in `rejected` rather than failing the batch, because the agent drops the whole batch on any non-2xx.
Quota / rate limiting: when KV `project:<id>` holds `{"over_quota_until": <unix s>, "message": "..."}` in the future (checked on
`/api/agent-auth` and `/api/ingest`), or the optional `RATE_LIMITER` binding rejects the project (ingest only), EdgeWatch answers
`429 {"message":"...","stop":true,"refresh_in":<s>}` with `Retry-After: <s>` and `X-EdgeWatch-Stop: 1`. The official agent pauses on `stop`;
`laravel-edgewatch`'s HTTP transport pauses on `429` or `stop` (using `refresh_in`, then `Retry-After`, then 60 s), shared across PHP
processes via `storage/framework/edgewatch-backoff.json`. Setting `over_quota_until` is manual/ops-driven: there is no usage metering yet.

## Record shapes (common to both hops)

Every record is a flat JSON object with `v` (schema version) and `t` (type). Shared fields on execution-scoped records:
`timestamp` (float, unix seconds with microseconds), `deploy`, `server`, `_group` (xxh128 hex grouping key), `trace_id` (UUID string; v4 in Nightwatch),
`execution_source` (`request`|`command`|`job`|`schedule`), `execution_id`, `execution_preview`, `execution_stage`
(`bootstrap`|`before_middleware`|`action`|`render`|`after_middleware`|`sending`|`terminating`|`end`), `user`.

Durations are integer **microseconds**. Text columns are truncated client-side to 255 (`tinyText`), 65,535 (`text`) or 16,777,215 (`mediumText`) bytes.

| `t` | `v` | Fields beyond the common ones (source file) |
| --- | --- | --- |
| `request` | 1 | `method, url, route_name, route_methods[], route_domain, route_path, route_action, ip, duration, status_code, request_size, response_size, bootstrap, before_middleware, action, render, after_middleware, sending, terminating, exceptions, logs, queries, lazy_loads, jobs_queued, mail, notifications, outgoing_requests, files_read, files_written, cache_events, hydrated_models, peak_memory_usage, exception_preview, context, headers (JSON string), payload (JSON string or "")` — no `execution_*` keys (`Sensors/RequestSensor.php`) |
| `query` | 1 | `sql, file, line, duration, connection, connection_type ("read"|"write"|"")` (`Sensors/QuerySensor.php`) |
| `exception` | **3** | `class, file, line, message, code (string), trace (JSON string of [{file, source, code}]), handled (bool), php_version, laravel_version` (`Sensors/ExceptionSensor.php`) |
| `command` | 1 | `class, name, command, exit_code, duration, bootstrap, action, terminating` + counters (`Sensors/CommandSensor.php`) |
| `job-attempt` | 1 | `job_id, attempt_id, attempt, name, connection, queue, status, duration` + counters (`Sensors/JobAttemptSensor.php`) |
| `queued-job` | 1 | `job_id, name, connection, queue, duration` |
| `scheduled-task` | 1 | `name, cron, timezone, repeat_seconds, without_overlapping, on_one_server, run_in_background, even_in_maintenance_mode, status, duration` + counters |
| `cache-event` | 1 | `store, key, type, duration, ttl` |
| `outgoing-request` | 1 | `host, method, url, duration, request_size, response_size, status_code` |
| `mail` | 1 | `mailer, class, subject, to, cc, bcc, attachments, duration, failed` |
| `notification` | 1 | `channel, class, duration, failed` |
| `log` | 1 | `level, message, context, extra` (no `_group`) |
| `user` | 1 | `timestamp, id, name, username` only |

Grouping keys (`_group`), all `hash('xxh128', ...)`:
* request: `implode('|', route_methods).",".route_domain.",".route_path`
* query: `"{connection},{sql}"`, where for mysql/mariadb/pgsql/sqlite/sqlsrv/singlestore `in (?, ?)` lists collapse to `in (...?)` and insert `values (?,?), (?,?)` to `values ...`
* exception: `"{class},{code},{file},{line}"`

Redaction defaults (client side): headers `Authorization, Cookie, Proxy-Authorization, X-XSRF-TOKEN` (docs) — the provider fallback also includes `X-CSRF-TOKEN`;
values become `[N bytes redacted]` (auth scheme and cookie names kept). Payload fields `_token, password, password_confirmation` (provider fallback adds `current_password`). Request payloads are only captured on HTTP 500 and only when `NIGHTWATCH_CAPTURE_REQUEST_PAYLOAD=true`.

## Configuration keys (client)

From `config/nightwatch.php` v1.30.6 and the env-vars docs:
`NIGHTWATCH_ENABLED, NIGHTWATCH_TOKEN, NIGHTWATCH_DEPLOY, NIGHTWATCH_SERVER, NIGHTWATCH_CAPTURE_EXCEPTION_SOURCE_CODE, NIGHTWATCH_CAPTURE_REQUEST_PAYLOAD, NIGHTWATCH_REDACT_PAYLOAD_FIELDS, NIGHTWATCH_REDACT_HEADERS, NIGHTWATCH_{REQUEST,COMMAND,EXCEPTION,SCHEDULED_TASK}_SAMPLE_RATE, NIGHTWATCH_IGNORE_{CACHE_EVENTS,MAIL,NOTIFICATIONS,OUTGOING_REQUESTS,QUERIES}, NIGHTWATCH_LOG_LEVEL, NIGHTWATCH_INGEST_URI, NIGHTWATCH_INGEST_TIMEOUT, NIGHTWATCH_INGEST_CONNECTION_TIMEOUT, NIGHTWATCH_INGEST_EVENT_BUFFER`.
Agent-only: `NIGHTWATCH_AGENT_LOG_LEVEL` (documented), `NIGHTWATCH_BASE_URL` (**undocumented**, source only).

## How EdgeWatch maps onto this

| Nightwatch | EdgeWatch |
| --- | --- |
| `POST /api/agent-auth` | `workers/ingest` — same path, headers and response shape; `NIGHTWATCH_TOKEN` is looked up in KV (`apikey:<sha256(token)>`) |
| `POST {ingest_url}` | `workers/ingest` `POST /api/ingest`; accepts gzip or plain JSON; validates `{records: [...]}` with Zod (known `t` types strictly, unknown types passed through) and enqueues to a Queue |
| short-lived ingest token | HMAC-signed token minted by `/api/agent-auth` (project id + expiry) |
| `laravel/nightwatch` package | `edgewatch/laravel-edgewatch` emits the same record shapes; transport `agent` speaks hop 1 to an official agent, transport `http` speaks hop 2b directly (no agent needed) |

Drop-in usage with the **official** Nightwatch client:

```dotenv
# app and agent (unchanged)
NIGHTWATCH_TOKEN=<edgewatch project token>
# agent only
NIGHTWATCH_BASE_URL=https://ingest.<your-edgewatch-domain>
```

### Deliberate differences

* `laravel-edgewatch` generates UUIDv7 `trace_id`s (time-ordered, good for D1/R2 keys); Nightwatch uses UUIDv4. Both are valid UUID strings, so the backend accepts either.
* `laravel-edgewatch` strips literals from SQL before sending (PII protection) and the consumer computes `sql_hash` = first 32 hex chars of SHA-256 of the normalized SQL. EdgeWatch stores the client's `_group` as-is but does not depend on it, because xxh128 is not available in Workers' WebCrypto.
* Because `NIGHTWATCH_BASE_URL` is undocumented, Laravel could rename or remove it in a future agent release. The `http` transport in `laravel-edgewatch` exists as a fallback that does not depend on the agent.
