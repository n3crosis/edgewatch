# Nightwatch parity matrix

Release gate: EdgeWatch is not tagged, released, published or called v1.0 until every cell below is **done** and all suites are green.

Legend: **done** = implemented and covered by a test; **partial** = some of it exists (explained); **missing** = not implemented. Each cell names the file that proves it.

"Agent emits" is the official `laravel/nightwatch` package and agent (v1.30.6), which EdgeWatch receives unchanged; EdgeWatch ships no Laravel client of its own.

Paths are relative to the repo root. Short names used in the table:

| Short name | File |
| --- | --- |
| schemas | `packages/shared/src/records.ts` (validated by `workers/ingest/src/index.ts`) |
| ingest tests | `workers/ingest/test/ingest.test.ts` |
| consumer | `workers/consumer/src/process.ts`, `workers/consumer/src/events.ts` |
| consumer tests | `workers/consumer/test/consumer.test.ts` |
| R2 | `traces/{project_id}/{date}/{trace_id}.json`, written by `workers/consumer/src/process.ts`; every validated record is kept |
| API | `workers/api/src/index.ts`, `workers/api/src/events.ts` |
| API tests | `workers/api/test/api.test.ts` |
| dashboard | `apps/dashboard/src/pages/*`, event views configured in `apps/dashboard/src/lib/events.tsx` |

## Matrix

| Requirement | Agent emits | Ingest accepts | Consumer parses | D1 stores | R2 stores | API endpoint | Dashboard view | Tests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Request status, duration | done (official agent) | done (schemas `request`) | done (consumer) | done (`traces`, `0001_init.sql`) | done | done (`/v1/traces`) | done (`TracesPage.tsx`) | done (consumer tests, API tests) |
| Request peak memory | done (official agent) | done (schemas) | done (consumer) | done (`traces.peak_memory_usage`, `0003_nightwatch_fields.sql`) | done | done (`/v1/traces/:id`) | done (`TraceDetailPage.tsx`) | done (consumer tests, API tests) |
| Route and action tags | done (official agent) | done (schemas) | done (consumer) | done (`traces.route_name`, `traces.route_action`) | done | done (`/v1/traces/:id`) | done (`TraceDetailPage.tsx`) | done (consumer tests, API tests) |
| User attribution | done (official agent) | done (schemas `user`) | done (consumer, `users` table) | done (`users`, `0003_nightwatch_fields.sql`) | done | done (`/v1/users`, `/v1/users/:id`, trace detail) | done (Users view, `lib/events.tsx`; trace detail) | done (consumer tests, API tests, `format.test.ts`) |
| Query SQL normalization and hash | done (official agent) | done (schemas `query`) | done (`packages/shared/src/sql.ts`) | done (`queries.sql_hash`) | done | done (`/v1/queries`) | done (`QueriesPage.tsx`) | done (`shared.test.ts`, consumer tests) |
| Query bindings scrubbing | done (official agent; no bindings sent) | done | done (literals stripped again in `sql.ts`) | done | done | done | done | done (`shared.test.ts`) |
| Query duration, slow-query threshold | done (official agent) | done | done | done (`queries.duration_ms`) | done | done (`/v1/queries`, `slow` count > 100 ms) | done (`QueriesPage.tsx`) | done (API tests) |
| N+1 detection | partial (official agent sends `lazy_loads` as 0; EdgeWatch uses the repeated-query heuristic) | done | done (`traces.lazy_loads`) | done | done | done (`/v1/traces/:id` `repeated_queries`) | done (`TraceDetailPage.tsx` warning) | done (API tests) |
| Exceptions with stack traces | done (official agent) | done (schemas) | done (consumer) | done (`exceptions`, `0001_init.sql`) | done | done (`/v1/exceptions`, `/v1/exceptions/:group`) | done (`ExceptionsPage.tsx`, `ExceptionDetailPage.tsx`) | done (consumer tests, API tests) |
| Job queue, attempts, duration, failures | done (official agent) | done (schemas) | done (consumer `EVENT_TABLES`) | done (`job_attempts`, `0004_job_attempts.sql`) | done | done (`/v1/jobs`, `/v1/jobs/:name`) | done (Jobs view, `lib/events.tsx`) | done (consumer tests, API tests, `format.test.ts`) |
| Artisan command name, exit code, duration | done (official agent) | done (schemas) | done (consumer `EVENT_TABLES`, command line PII-scrubbed) | done (`commands`, `0005_commands.sql`) | done | done (`/v1/commands`, `/v1/commands/:name`) | done (Commands view, `lib/events.tsx`) | done (consumer tests, API tests, `format.test.ts`) |
| Cache hit, miss, set, forget, duration | done (official agent) | done (schemas) | done (consumer `EVENT_TABLES`, key PII-scrubbed and cut to 255 chars) | done (`cache_events`, `0006_cache_events.sql`) | done | done (`/v1/cache`, `/v1/cache/:key`, `hit_ratio`) | done (Cache view with hit ratio, `lib/events.tsx`) | done (consumer tests, API tests, `format.test.ts`) |
| Outgoing HTTP host, method, status, duration | done (official agent) | done (schemas) | done (consumer `EVENT_TABLES`, URL PII-scrubbed without query string) | done (`outgoing_requests`, `0007_outgoing_requests.sql`) | done | done (`/v1/outgoing-requests`, `/v1/outgoing-requests/:host`) | done (Outgoing HTTP view, `lib/events.tsx`) | done (consumer tests, API tests, `format.test.ts`) |
| Mail | done (official agent) | done (schemas `mail`) | done (consumer `EVENT_TABLES`, subject PII-scrubbed) | done (`mail`, `0008_mail_notifications.sql`) | done | done (`/v1/mail`, `/v1/mail/:class`) | done (Mail view, `lib/events.tsx`) | done (consumer tests, API tests, `format.test.ts`) |
| Notifications | done (official agent) | done (schemas `notification`) | done (consumer `EVENT_TABLES`) | done (`notifications`, `0008_mail_notifications.sql`) | done | done (`/v1/notifications`, `/v1/notifications/:class`) | done (Notifications view, `lib/events.tsx`) | done (consumer tests, API tests, `format.test.ts`) |
| Scheduled task status, duration, cron | done (official agent) | done (schemas `scheduled-task`) | done (consumer `EVENT_TABLES` + trace root) | done (`scheduled_tasks`, `0009_scheduled_tasks.sql`) | done | done (`/v1/scheduled-tasks`, `/v1/scheduled-tasks/:name`) | done (Scheduled tasks view, `lib/events.tsx`) | done (consumer tests, API tests, `format.test.ts`) |
| Logs level, message, context | done (official agent) | done (schemas `log`) | done (consumer `EVENT_TABLES`, PII-scrubbed, message 4096 / context 2048 chars) | done (`logs`, `0010_logs.sql`) | done | done (`/v1/logs?level=`, `/v1/logs/:level`) | done (Logs view, `lib/events.tsx`) | done (consumer tests, API tests, `format.test.ts`) |

Unknown record types pass ingest with only `v` (integer) and `t` (non-empty string) checked (`UnknownRecord` in schemas) and are kept in R2.

## Status

Every row above is **done** except N+1 detection, which is **partial** because the official agent never counts lazy loads.
Known differences:

* `mail.failed` and `notification.failed` are always `false`: Laravel dispatches no failure event (same as laravel/nightwatch).
* Tasks with `runInBackground()` finish in a separate `schedule:finish` process, so the official agent reports their duration as about 0 (it measures them from the finishing process).
* `lazy_loads`: laravel/nightwatch 1.30.6 declares the counter (`State/RequestState.php`, `State/CommandState.php`) but no code increments it, so the agent always sends 0.
* Server-side N+1 signal: the same `sql_hash` run 5 or more times in one trace is listed as a repeated query on the trace page. This is a heuristic, not lazy-load detection; together with `lazy_loads > 0` it raises the "Possible N+1 queries" warning.
* `hydrated_models`, `files_read` and `files_written` are sent as 0 by the agent (laravel/nightwatch 1.30.6 declares but never increments them either).
* Outgoing request URLs are stored without query string or fragment (Nightwatch keeps the full URL).
* `user` records: like laravel/nightwatch, the agent sends one per request with a signed-in user (`name`, and the email as `username`), and only reads a user the app has already resolved, so instrumentation never runs an auth query itself.
* Job attempts from laravel/nightwatch keep the dispatching request's `trace_id` and identify themselves by `attempt_id` (their child records carry it as `execution_id`). EdgeWatch stores each attempt as its own trace keyed by that id and keeps the dispatching trace in `origin_trace_id`; `/v1/traces/:id` returns both directions under `related`. Verified with the unmodified official agent by `bun run nightwatch-agent`.

### Release status

| Gate | State |
| --- | --- |
| Every matrix cell done | yes |
| Vitest (ingest, consumer, api, shared, dashboard); `bun test` (server, scripts) | see the local snapshot in [release-checklist.md](release-checklist.md) |
| e2e on Miniflare, all 13 record types, several projects | see the local snapshot (`bun run e2e`) |
| Unmodified `laravel/nightwatch` + `nightwatch:agent` against EdgeWatch | green locally: 27 passed, 0 failed (`bun run nightwatch-agent`, Laravel 12.74.0, agent 1.30.6) |
| CI on GitHub Actions | **passed**: [first successful hosted run](https://github.com/n3crosis/edgewatch/actions/runs/45364773853); recheck the final release commit |
| Deploy to a real Cloudflare account | **not verified**: configs carry the test installation's IDs; setup/deploy scripts are tested only against a fake Cloudflare API |
| Versions | 1.0.0 (git tag only); not tagged, nothing published |

Remaining owner steps: [release-checklist.md](release-checklist.md).
