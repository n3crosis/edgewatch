# Record and schema version policy

EdgeWatch stores data in five formats. Each has its own compatibility rule for 1.x.

| Format | Where | Rule within 1.x |
| --- | --- | --- |
| Wire records (`v`, `t`) | Ingest body from `laravel/nightwatch` and `edgewatch/laravel-edgewatch` | Accept every `v` the supported clients send; additive handling only |
| EdgeWatch extensions (`web-vital`, `browser` field on exceptions, `execution_source: "browser"`) | `/api/browser`, `packages/shared/src/browser.ts` | `v: 1`; fields are only added, never renamed or removed |
| D1 schema | `workers/migrations/NNNN_*.sql` | Forward-only, additive migrations |
| Stored trace JSON | R2 `traces/<project>/<trace>.json` (`StoredTrace`: `project_id`, `trace_id`, `records`, optional `dropped_records`) | New optional fields only; readers ignore unknown fields |
| Read API | `/v1/...` | Additive; a breaking change gets `/v2` |

## Wire records

- Every record has an integer `v` and a type `t`. Today every known type is `v: 1`.
- Validation is per `t` (`RECORD_SCHEMAS` in `packages/shared/src/records.ts`). It checks the fields EdgeWatch reads and
  keeps the rest (`passthrough`), so new fields a client adds are stored in R2 unchanged.
- An unknown `t` is accepted with only `v` and `t` checked. It is stored in the R2 trace and shown in the raw records, but
  gets no D1 table until EdgeWatch adds one.
- `v` is not branched on yet. When Nightwatch ships a record with a different shape under a new `v`:
  1. add a schema for that `v` next to the old one and map both to the same D1 columns in the consumer;
  2. add fixtures for both versions to the shared and consumer tests and to `scripts/e2e-records.mjs`;
  3. keep reading the old `v` for the rest of the major version.
- A field the dashboard needs that a client stops sending becomes `NULL` in D1, never a rejected record.

## D1 migrations

- Files are numbered and applied once by `wrangler d1 migrations apply` (tracked in `d1_migrations`). Never edit or renumber an
  applied file; fix mistakes with a new migration.
- Within 1.x a migration may add tables, nullable columns or columns with defaults, and indexes. It must not drop or rename
  columns or tables or change a column's meaning; that waits for 2.0 with a written upgrade path.
- New queries must pass `scripts/d1-indexes.test.ts` (no full scans) and new per-type tables join the retention job through
  `EVENT_TABLES`.
- Apply migrations before deploying Workers: `setup-cloudflare.ts` applies D1 migrations unless explicitly skipped;
  existing D1 installations can use `scripts/d1-migrate.sh --remote`. `deploy.sh` does not apply migrations.
  For PostgreSQL, MySQL or libSQL, run the matching `bun run migrate:<backend>` command first.
  Old Worker code keeps working against a newer schema because changes are additive.
- Take a backup (`bun run backup:d1`) before applying migrations to a production database.

## Stored trace JSON

- Readers (`/v1/traces/:id`, `/v1/traces/:id/raw`, the consumer merge) read `records` and ignore unknown keys.
- A size or encoding change (for example gzip) would need a marker field and readers that handle both forms first; it is not
  planned for 1.x.

## Packages

- `edgewatch/laravel-edgewatch` and `@edgewatch/browser` follow semver. A minor release may add record fields or options; a
  removal or rename is a major release.
