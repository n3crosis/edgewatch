# Capacity and high-traffic behavior

What EdgeWatch can absorb on each backend, what fails first under load, and what happens to data when it does.
Platform limits were checked against the Cloudflare docs on 2026-11-24 (links per row). EdgeWatch numbers come from
the code and wrangler configs on `main`. Row sizes were measured locally (see [Sizing](#sizing-d1)); nothing here
has been load-tested on a real Cloudflare account yet.

EdgeWatch needs **Workers Paid**: Queues require it, and the Free plan's 50 subrequests and 10 ms CPU per invocation
are below what one consumer batch uses.

## Platform limits that matter

| Product | Limit | Value (Paid) | Where EdgeWatch hits it | Source |
| --- | --- | --- | --- | --- |
| D1 | Database size | 10 GB, cannot be raised | All metadata rows (traces, queries, events) | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 | Concurrency | One query at a time per database; throughput is about 1 / query duration; a full queue returns "overloaded" | Every consumer invocation writes to the same database | same |
| D1 | Bound parameters per statement | 100 | Widest insert binds 22 | same |
| D1 | SQL statement length | 100 KB | Statements are fixed-size; values are bound | same |
| D1 | Query or batch duration | 30 s per call (a batch counts as one call) | Consumer batches of 50 statements | same |
| D1 | Row / string size | 2 MB | Exception stacks, log messages (log messages capped at 4 KB) | same |
| D1 | Queries per invocation | 1,000 (a batch counts as 1) | Consumer, retention cron | same |
| Queues | Message size | 128 KB | Ingest parks payloads over 100 KB in R2 | [Queues limits](https://developers.cloudflare.com/queues/platform/limits/) |
| Queues | `sendBatch` | 100 messages or 256 KB | Ingest sends at most 100 messages / 200 KB per call | same |
| Queues | Throughput per queue | 5,000 messages/s, then `send` throws | Ingest sends one message per trace | same |
| Queues | Backlog per queue | 25 GB | Backlog while the consumer is behind | same |
| Queues | Retention | 4 days by default, up to 14 | Unconsumed messages are deleted after this | [Queue config](https://developers.cloudflare.com/queues/configuration/configure-queues/) |
| Queues | Consumer concurrency | Up to 250 invocations, autoscaled unless `max_concurrency` is set | Many invocations write to one single-threaded D1 | [Consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/) |
| Queues | Consumer wall time / CPU | 15 min / 30 s default, up to 5 min | Large batches of large traces | [Queues limits](https://developers.cloudflare.com/queues/platform/limits/) |
| Workers | Memory | 128 MB per isolate (shared by concurrent requests) | Ingest buffers up to `MAX_BODY_BYTES` of decoded JSON | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Workers | Request body | 100 MB (Free/Pro zones), 200 MB (Business) | Agent batches | same |
| Workers | Subrequests | 10,000 per invocation | About 4 per trace in the consumer | same |
| Workers | Cron wall time | 15 min | Retention job | same |
| R2 | Writes to the same key | 1 per second | A trace split over messages processed concurrently | [R2 limits](https://developers.cloudflare.com/r2/platform/limits/) |
| R2 | Storage | Unlimited | Raw traces | same |
| KV | Reads | Unlimited; `cacheTtl` minimum 30 s | API key lookups (cached 60 s) | [KV limits](https://developers.cloudflare.com/kv/platform/limits/) |
| Hyperdrive | Origin connections | About 100 per configuration | Postgres backend: each consumer batch and API request opens a client with up to 5 connections | [Hyperdrive limits](https://developers.cloudflare.com/hyperdrive/platform/limits/) |
| Hyperdrive | Query duration | 60 s | Postgres backend | same |
| Analytics Engine | Data points | 250 per invocation, 3-month retention | Not used; candidate for high-volume metrics | [Analytics Engine limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/) |

## EdgeWatch's own caps

| Cap | Value | Where |
| --- | --- | --- |
| Decoded ingest body | 20 MB (`MAX_BODY_BYTES`) | `workers/ingest` |
| Browser ingest body | 256 KB, 50 events | `workers/ingest` |
| Inline queue message | 100 KB; larger payloads are parked under `incoming/` in R2 | `workers/ingest` |
| Ingest rate limit | 600 requests / 60 s per project (`RATE_LIMITER`), then `429` stop | `workers/ingest/wrangler.jsonc` |
| Daily record quota | Off by default; `DAILY_RECORD_QUOTA` or per project. Checked after each consumer batch, then `429` stop until UTC midnight | `workers/consumer/wrangler.jsonc`, `PUT /v1/projects/:id/settings` |
| Consumer batch | 50 messages, 5 s wait, one concurrent invocation (`max_concurrency`) | `workers/consumer/wrangler.jsonc` |
| Consumer retries | 20, backoff 5 s doubling to 10 min (about 2.3 hours in total), then `edgewatch-ingest-dlq` | `workers/consumer` |
| Queue message retention | 14 days on the ingest queue and DLQ (set by `scripts/setup-cloudflare.ts`) | Cloudflare queue settings |
| D1 statements per batch | 50 | `workers/consumer` |
| Stored trace | 5,000 records or 8 MB; root records always kept | `workers/consumer` |
| Retention | 30 days, hourly cron; each run deletes in chunks (1,000 traces, 5,000 child rows) until caught up or out of budget (900 D1 queries, 10 minutes) | `workers/consumer` |
| Client buffer | Flush at the end of each request/command/job, or every 500 records | `packages/laravel-edgewatch` |
| Client sampling | Request, command and exception rates, default 1.0 | `packages/laravel-edgewatch` config |

## Sizing (D1)

Measured by applying all migrations to SQLite, inserting 20,000 realistic rows per table and comparing the
vacuumed file size (row data plus every index):

| Row | Bytes |
| --- | ---: |
| `traces` | 581 |
| `queries` | 385 |
| `cache_events` | 244 |

A request with 10 queries and 2 cache calls is about 5 KB of D1. At that shape, the 10 GB cap holds about
2 million requests. The sustained rate D1 can retain is therefore:

| Retention | Requests retained per day | Sustained rate | With 10% sampling |
| --- | ---: | ---: | ---: |
| 30 days | 68,000 | 0.8/s | 8/s |
| 7 days | 290,000 | 3.4/s | 34/s |
| 1 day | 2,000,000 | 23/s | 230/s |

D1's on-disk size can differ from local SQLite, so treat these as estimates. Per-execution `queries` rows are the
largest share; storing per-minute query aggregates instead would cut the per-request size to about 1.1 KB.

## Failure modes under high traffic

| Trigger | What happens today | Data lost? | Fix |
| --- | --- | --- | --- |
| D1 reaches 10 GB | Inserts fail, consumer retries for about 2.3 hours, messages go to the DLQ | Not lost: the dead-letter handler writes each payload to R2 `dead/` before D1, so payloads survive even when D1 is full; they are missing from the dashboard until replayed after space is freed | Size alerts; sampling; query aggregates; Postgres backend |
| Retention falls behind | Fixed: each hourly run deletes until caught up, up to about 450,000 traces or 4.5 million child rows per run. Before, a daily run stopped at 50,000 traces and 250,000 rows per table | No | Done |
| D1 overloaded by concurrent consumers | Mitigated: at most 5 consumer invocations write at once, and failed messages back off for up to 10 minutes over about 2.3 hours. Before, up to 250 invocations and about 1 minute of retries | Only until replayed: dead letters are kept and can be replayed | Done |
| Ingest over the rate limit | `429` stop; the client pauses for `refresh_in` (60 s) and drops what it produces meanwhile. The agentless client sends one request per PHP execution, so it stops at about 10 executions/s per project | Yes, by design | Use the official agent (it batches) or raise `RATE_LIMIT`; consider limiting by records instead of requests |
| Queue over 5,000 messages/s | `sendBatch` throws, ingest returns `503` with `Retry-After: 5` | Client-side only, if it does not retry | None needed below D1's ceiling |
| Consumer down longer than queue retention | Setup raises queue retention from 4 to 14 days; older messages are deleted | Only after 14 days | Done |
| Large decoded bodies in one isolate | Several concurrent 20 MB batches can pass the 128 MB isolate memory | Request fails (`1102`), client retries | Load-test; lower `MAX_BODY_BYTES` if needed |
| Hyperdrive pool exhausted | `Failed to acquire a connection from the pool` | Retry, then DLQ | Same concurrency cap and backoff as D1 |

## What to monitor

- **Pipeline page / `GET /v1/pipeline`:** queue lag (alert default 10 minutes), retries per hour, dead-letter count.
- **`ALERT_WEBHOOK_URL`:** dead-letter and queue-lag alerts, each at most once per hour.
- **Workers Logs:** `retention` with `complete: false` on several runs in a row means retention is falling behind;
  `batch_failed`, `enqueue_failed` and ingest 503s mean a binding is failing.
- **D1 size:** `wrangler d1 info edgewatch` against the 10 GB cap (no automatic alert yet).

## Choosing a backend

| Traffic (sustained, after sampling) | Backend |
| --- | --- |
| Below about 3 req/s at 7-day retention | D1 (default) |
| Higher, or longer retention | Postgres through Hyperdrive, or sampling |
| Very high volume metrics only | Analytics Engine for aggregates (not planned yet) |

R2 has no storage cap and keeps the raw traces on every backend.

**Single process (`apps/server`, Docker):** for small installs without Cloudflare. Its queue journals accepted
messages to SQLite (10,000 pending messages, then `503`). Keep the data directory on persistent storage even with
remote databases. Run one server process per deployment; trace merges require a single writer.
Details in [self-hosting.md](self-hosting.md#single-process--docker).

**Postgres sizing:** the consumer uses one concurrent invocation with up to 5 connections per client, plus the API's.
Keep `max_concurrency: 1` on every backend: trace blobs use read-modify-write merges, regardless of the SQL backend's
ability to handle parallel writes. Postgres throughput through Hyperdrive has only been checked locally (e2e), not
measured. The same applies to MySQL through Hyperdrive (watch `max_connections`).
libSQL, like SQLite, takes one write transaction at a time, so keep the consumer's `max_concurrency` low as for D1. Each
query is an HTTP round trip from the Worker, and no Hyperdrive pooling or caching is in between. Not measured.
On MySQL, indexed text values are capped at 255 characters (`VARCHAR(255)`, utf8mb4, so a 3-column index fits InnoDB's
3072-byte key limit).

## Local load test

`bun run load-test` starts ingest+consumer and the API on Miniflare with fresh state, sends Nightwatch-shaped batches
(10 request traces with 10 queries each = 110 records per request) from 8 parallel senders for `DURATION` seconds, then
waits until the consumer has counted every record in `usage_daily`. The per-project rate limiter is raised for the run
(`LOAD_RATE_LIMIT`; at the default 600 requests/min a single project is capped at 10 requests/s).

The run also keeps one reader per dashboard endpoint (`overview`, `traces`, `exceptions`, `queries`)
busy against the API while ingest is under load (`READERS=0` turns them off) and reports their latency.

Runs on the development VM (8 vCPU Intel Xeon, wrangler 4.166, local SQLite-backed D1), `DURATION=15`. "Before" is the
code before the consumer memory changes below, "after" includes them:

| Measure | Before | After |
| --- | --- | --- |
| Ingest requests | 497, all 200 | 496, all 200 |
| Ingest throughput | 32.9 requests/s, 3,617 records/s | 32.7 requests/s, 3,592 records/s |
| Ingest latency | p50 235 ms, p95 287 ms, p99 439 ms | p50 244 ms, p95 268 ms, p99 288 ms |
| Dashboard reads under load (each of the 4 endpoints, about 350 reads) | p50 36 ms, p95 90 ms, max 264 ms | p50 37 ms, p95 88 ms, max 127 ms |
| Consumer throughput | 1,934 records/s (176 traces/s) | 1,860 records/s (169 traces/s) |
| End to end | all 54,670 records stored in 28.3 s | all 54,560 records stored in 29.3 s |

One run each, so differences of a few percent are noise: the changes below did not change throughput or read latency
measurably. The four endpoints show near-identical latency because Miniflare serves the API from a single thread, so a
read mostly waits for the one before it. The earlier run documented for 1.0.0-rc (489 requests, p95 289 ms, about 1,900
consumer records/s) is in the same range.

### Consumer memory

`bun scripts/consumer-bench.ts` (also `bun run bench:consumer`) runs the consumer's `processBodies` outside Workers,
against the single-process server's SQLite store and an in-memory blob store, one process per scenario, and reports wall
time, peak RSS and how far RSS grew during the run. Median of 5 runs each, same VM, on `f0dc25f` (before) and
`fe42001` (after):

| Scenario | Wall time before → after | Peak RSS before → after | RSS growth before → after |
| --- | --- | --- | --- |
| `batch`: 10 batches of 50 messages, 55,000 records | 4,106 → 4,229 ms | 147 → 148 MB | 103 → 104 MB |
| `merge`: a 4,001-record trace, then 10 more batches merged into it (5,001 records) | 1,670 → 1,689 ms | 113 → 107 MB | 69 → 63 MB |
| `parked`: one parked payload of 40,000 records in 400 traces | 2,132 → 2,302 ms | 206 → 210 MB | 162 → 166 MB |
| `bigtrace`: one 20,001-record trace sent through ingest's `enqueue` | 266 → 241 ms | 134 → 128 MB | 90 → 84 MB |

What changed, and what it bought:
- **Big traces are parked in parts.** Ingest splits a trace over the inline limit into parked objects of at most 1 MB
  (`MAX_PARKED_PART_BYTES`), one queue message each. The consumer already merged a trace that arrives in several
  messages, so it no longer loads one 20 MB object for a single message.
- **Records past the cap are dropped while grouping.** A trace never holds more than `MAX_TRACE_RECORDS` non-root
  records in memory; the extra ones are only counted in `dropped_records`, as before.
- **Less held at once in `storeTrace`.** Each record is serialized once (its length feeds the size cap, a 53-bit hash
  the duplicate check, instead of a set of full JSON strings), statements go to the database 50 at a time instead of
  being built for the whole trace first, and per-message and per-trace record lists are released once used.
- **Result:** about 6 MB (7–9%) less RSS growth for merges and big traces. No gain for many small traces (`batch`)
  or for one big parked payload of many traces (`parked`, 4 MB more, within noise), where the input itself dominates.
  Wall time stayed within run-to-run noise (about ±10%). An earlier 5-run measurement, before rebasing onto 32 newer
  commits, showed the same pattern (7–11 MB less for `merge` and `bigtrace`).

These are Bun numbers; Workers isolates (128 MB) were not measured, because Miniflare does not report per-isolate memory.

**Not streamed:** a parked part is still read whole with `.json()`: Workers has no streaming JSON parser, and parts are
now at most 1 MB. A trace is still written to R2 as one JSON string (at most `MAX_TRACE_BYTES`, 8 MB), because R2 needs
a known length for a streamed upload. Ingest still reads the request body into memory (capped at `MAX_BODY_BYTES`) to
parse and validate it, though the gzip decode is streamed.

These are local numbers: Miniflare runs every Worker and the D1 SQLite file in one process on one machine, with one
consumer at a time. They show that EdgeWatch's own code is not the bottleneck at this rate and that the queue absorbs a
burst faster than the consumer drains it. They do not predict Cloudflare: real D1 write latency, network hops and
Worker scheduling all differ. The current deployment uses `max_concurrency: 1` to serialize trace merges.

## Not verified yet

- D1 write throughput for EdgeWatch's batches on a real database (needs a deployed account and a load test).
- Real D1 on-disk size per row.
- Ingest memory with concurrent large batches.

### Dashboard aggregation

The overview transfers at most 45 aggregate rows from the database (one total, 24 chart buckets, and 20 routes),
regardless of the request count in the selected window. Query latency statistics similarly aggregate in SQL and
return at most 200 query groups. Percentiles use exact nearest-rank calculations over the matching population.
This bounds the overview and percentile-result payloads in Worker memory; database scanning and sorting still grow with the selected
window. These changes do not establish production throughput limits without a live-account load test.
