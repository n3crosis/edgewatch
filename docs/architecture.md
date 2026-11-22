# EdgeWatch architecture

EdgeWatch is a Nightwatch-compatible observability backend on Cloudflare Workers. This page describes what is implemented
on `feat/mvp-edge-pipeline`; see "Not implemented" at the end.

```
Laravel app ──(a) laravel/nightwatch ──TCP──▶ nightwatch:agent ──HTTPS (NIGHTWATCH_BASE_URL)──┐
            └─(b) edgewatch/laravel-edgewatch ──HTTPS gzip, or TCP to the agent ─────────────┤
Browser ─────(c) @edgewatch/browser ── sendBeacon ──▶ POST /api/browser (EdgeWatch extension) ─┤
                                                                                              ▼
                                         workers/ingest (Hono)  ── KV API_KEYS (hashed keys, quota blocks)
                                           │  Queue edgewatch-ingest (one message per trace; >100 KB parked in R2 incoming/)
                                           ▼
                                         workers/consumer ── D1 (projects, traces, exceptions, queries)
                                           │                 R2 traces/{project_id}/{date}/{trace_id}.json
                                           │  DLQ edgewatch-ingest-dlq after 5 retries
                                           ▼
apps/dashboard (React, Kumo UI) ──▶ workers/api (Hono, read keys) ── D1 + R2
```

## Components

| Path | Role |
| --- | --- |
| `packages/shared` | Zod record schemas (Nightwatch v1.30.6 shapes), SQL normalizer + `sql_hash`, PII scrubber, HMAC ingest tokens, browser-event mapping. Used by all Workers. |
| `workers/ingest` | `POST /api/agent-auth` and `POST /api/ingest` (the official agent's contract), `POST /api/browser`, `GET /health`. Validates records, groups by `trace_id`, enqueues. Returns `429 {stop, refresh_in}` + `Retry-After` for over-quota/rate-limited projects. |
| `workers/consumer` | Queue consumer. Normalizes SQL (literals stripped, `sql_hash`), scrubs PII from exception/log messages, merges records per trace, writes raw JSON to R2 and summary rows to D1. Idempotent upserts so retries are safe. |
| `workers/api` | Read API for the dashboard: `/v1/projects/:id/{overview,traces,traces/:traceId,exceptions,exceptions/:group,queries,queries/:sqlHash}`. Read-scope keys, project isolation, CORS. Waterfall spans derived from raw R2 records. |
| `workers/migrations` | D1 schema (`0001_init.sql`). |
| `packages/laravel-edgewatch` | Composer client that emits Nightwatch-format records: requests, queries, exceptions, commands, queued jobs / job attempts, cache events (hit/miss/write/delete), users. Transports: TCP to a Nightwatch agent, or direct HTTPS gzip to ingest; buffered, 0.5 s connect/send timeouts, never throws into the app; honors 429/`stop`. |
| `packages/browser` | `@edgewatch/browser`, dependency-free browser error reporter. |
| `apps/dashboard` | React + Vite + Tailwind v4 + Kumo UI (`@cloudflare/kumo`, the design system of record; Base UI primitives, Phosphor icons). Seed data by default, `workers/api` when `VITE_API_URL` is set. Filters, search, 1h/6h/24h range, 15 s live polling, data-source badge. |
| `examples/laravel-sandbox` | Laravel 12 app using the local package; demo routes, job, cache and command. |
| `scripts/` | `e2e.sh` (local live pipeline check), `cf-setup.mjs`, `d1-migrate.sh`, `deploy.sh`. |

## Auth model

- API keys are random strings; only `sha256(key)` is stored in KV as `apikey:<hex>` → `{project_id, name, scopes, disabled?, allowed_origins?}`.
- Scopes: `ingest` (agent/client, secret), `read` (dashboard/API), `browser` (public; only `/api/browser`, optional origin allow-list).
- `/api/agent-auth` exchanges an ingest key for a short-lived HMAC token (`TOKEN_SIGNING_SECRET`, `TOKEN_TTL`, default 3600 s); `/api/ingest` accepts that token or the raw key.

## Quota and rate limiting

- KV `project:<id>` = `{"over_quota_until": <unix s>, "message": "..."}` blocks a project on agent-auth, ingest and browser endpoints.
- Optional Workers Rate Limiting binding `RATE_LIMITER` (configured 600 requests / 60 s per project in `workers/ingest/wrangler.jsonc`).
- Both answer `429 {"message", "stop": true, "refresh_in"}` with `Retry-After` and `X-EdgeWatch-Stop: 1`.

## Data model

- D1 `traces`: one row per trace (source, name, status, duration, counts, server, deploy, user, `r2_key`).
- D1 `exceptions`: one row per occurrence, `group_hash` = Nightwatch `_group`.
- D1 `queries`: one row per query with normalized SQL and `sql_hash`.
- R2 `traces/{project_id}/{date}/{trace_id}.json`: all raw records of a trace (merged across ingest batches).

## Not implemented

- Usage metering: quota blocks are set manually in KV; nothing counts events per project yet.
- Retention/TTL: no D1 pruning job and no R2 lifecycle rule are configured.
- Dashboard auth: the dashboard uses a single read key from `VITE_API_KEY` (visible in the bundle); there are no users, sessions or SSO.
- Project/key management UI or API: keys are created with `workers/ingest/scripts/create-key.mjs`.
- Records stored but not surfaced in the dashboard beyond raw/waterfall views: mail, notifications, logs, outgoing requests, scheduled tasks, cache events have no dedicated pages.
- Alerting/notifications, source maps for browser errors, EdgeWatch self-monitoring.
