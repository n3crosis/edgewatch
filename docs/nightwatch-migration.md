# Migrating from Laravel Nightwatch to EdgeWatch

EdgeWatch implements the Nightwatch **agent -> cloud** contract of `laravel/nightwatch` v1.30.6
(details and sources: [nightwatch-compat.md](nightwatch-compat.md)). You keep the official package and agent; only
the agent's base URL and token change.

## Point the official agent at EdgeWatch (no code changes)

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

## Several Laravel apps (projects)

EdgeWatch is single-tenant. The official agent cannot send a project tag, so create one ingest key per app
(`create-key shop ingest`, `create-key billing-api ingest`, ...) and use it as that app's `NIGHTWATCH_TOKEN`; each key's
data goes to its default project. One read key shows every project in the dashboard's project selector.

## Captured environments

Migration 0021 stores an execution record's `environment` field on traces when the sender includes it; records from the
official agent do not carry it and show as Unknown. The dashboard Environment selector scopes investigations. Pipeline and
Setup remain project-wide, as do issue status changes and lifecycle history. Server and deployment names are never used
to infer an environment.

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
