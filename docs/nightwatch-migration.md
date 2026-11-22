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

| | laravel/nightwatch 1.30.6 | laravel-edgewatch |
| --- | --- | --- |
| Records | request, query, exception, command, job-attempt, queued-job, scheduled-task, cache-event, outgoing-request, mail, notification, log, user | request, query, exception, command, job-attempt, queued-job, cache-event, user |
| Transport | TCP to a local agent | Direct HTTPS (gzip) or TCP to the agent; 0.5 s timeouts |
| SQL literals | sent as-is | stripped client-side (also stripped again in the consumer) |
| PII in messages | not scrubbed | scrubbed client-side and in the consumer |
| Over quota | agent pauses on `stop` | transport pauses on 429 / `stop` (shared via `storage/framework/edgewatch-backoff.json`) |

Not collected by laravel-edgewatch yet: scheduled tasks, outgoing HTTP requests, mail, notifications, logs. Use Option A if you need them.

## Browser errors (EdgeWatch only)

Nightwatch has no browser telemetry. EdgeWatch adds `POST /api/browser` and `@edgewatch/browser`
([packages/browser](../packages/browser/README.md)). To link a browser error to the server trace, render
`<meta name="edgewatch-trace-id" content="{{ app(\EdgeWatch\Laravel\EdgeWatch::class)->traceId() }}">` (laravel-edgewatch only).

## What you lose vs Nightwatch cloud

No alerts, issue assignment, user management, team accounts, long-term retention policies or the Nightwatch UI.
EdgeWatch's dashboard covers overview, traces with waterfall, exceptions and queries.
