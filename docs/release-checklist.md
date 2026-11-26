# 1.0.0 release checklist (owner steps)

Version 1.0.0 remains a release candidate. Re-run the checks against the final release commit; earlier local results
are not evidence for later changes. The protocol matrix in [nightwatch-parity.md](nightwatch-parity.md) does not
establish parity with the current Nightwatch web interface.

Local gates: `bun run typecheck`, `lint`, `test`, `test:php`, `build`, `e2e`, `fresh-laravel`, and
`fresh-laravel:nightwatch`. Database adapters also require `test:postgres`, `test:mysql`, and `test:libsql`.
Migrations through `0021_trace_environment.sql` must be applied before deploying the updated consumer and API.
Create an `admin` key for issue updates, settings changes, and dead-letter replay; `read` keys now reject writes.
Upgrade the API and dashboard together after migration 0020. Issue API clients must read the current issue revision
and send it as `expected_revision` on updates; omitted revisions return 422 and stale revisions return 409.

Follow the deployment gates below and stop if any check fails.

## 1. Turn on CI

The workflow is configured in `.github/workflows/ci.yml`. Push it with credentials that can update workflows.
It includes fresh Laravel application checks for both the EdgeWatch and official Nightwatch clients, in addition to
the core CI and database-adapter jobs. All jobs must pass on the release commit.

- [x] The [first successful hosted run](https://github.com/n3crosis/edgewatch/actions/runs/45364773853) on `main` is green (install, composer install for both PHP projects, typecheck, lint, Vitest, Pest, build, e2e).

Verification snapshot (2026-11-24): implementation commit `6e02443` passed
[hosted core CI and all database jobs](https://github.com/n3crosis/edgewatch/actions/runs/45390925087).
Local fresh-install runs using the updated harness passed 25 checks for EdgeWatch and 27 for the official Nightwatch
client. These are local Workers/Miniflare checks, not evidence of a live Cloudflare deployment.
Wrangler authentication was rechecked and is expired; resource placeholders remain. Gates 2–4 are still unverified.

## 2. Create the Cloudflare resources

Needs a Cloudflare account on Workers Paid (Queues) and an API token with Workers, KV, D1, R2, Queues and Pages edit
permissions. Details: [deployment.md](deployment.md).

```bash
export CLOUDFLARE_API_TOKEN=...   # + CLOUDFLARE_ACCOUNT_ID if the token sees several accounts
bun run setup:cloudflare --dry-run
bun run setup:cloudflare          # KV, D1, R2, ingest queue + DLQ; writes IDs over the placeholders; applies D1 migrations
```

- [ ] No `REPLACE_WITH_*` left in `workers/*/wrangler.jsonc`; commit the IDs (they are not secrets).
- [ ] Pick a `ratelimits` `namespace_id` in `workers/ingest/wrangler.jsonc` that is unique in the account.

## 3. Deploy and set secrets

```bash
scripts/deploy.sh workers
bun run setup:cloudflare          # second run sets TOKEN_SIGNING_SECRET on edgewatch-ingest now that it exists
bun run --filter @edgewatch/ingest create-key <project> ingest server --remote     # NIGHTWATCH_TOKEN / EDGEWATCH_TOKEN
bun run --filter @edgewatch/ingest create-key <project> read dashboard --remote    # entered in the dashboard's sign-in prompt
VITE_API_URL=https://edgewatch-api.<subdomain>.workers.dev scripts/deploy.sh dashboard
```

- [ ] Set `CORS_ORIGIN` on the API Worker to the dashboard origin.
- [ ] Put the dashboard and API behind Cloudflare Access if SSO is required; the read key is entered at sign-in and stored in the browser.

## 4. Check the live deployment

- [ ] `GET https://edgewatch-ingest.<subdomain>.workers.dev/health` and the API `/health` return `{"ok":true}`.
- [ ] Point a Laravel app with the official agent at it (`NIGHTWATCH_BASE_URL=https://edgewatch-ingest...`, `NIGHTWATCH_TOKEN=<ingest key>`,
  `php artisan nightwatch:agent`); the agent authenticates and a request, a job and a command appear in the dashboard.
- [ ] Same with `edgewatch/laravel-edgewatch` (`EDGEWATCH_INGEST_URI=https://edgewatch-ingest.../api/ingest`).
- [ ] The consumer's hourly retention cron and 5-minute pipeline cron run without errors (Workers Logs), and the Pipeline page shows no dead letters.
- [ ] Optional: `ALERT_WEBHOOK_URL` is set on `edgewatch-consumer` and a test alert arrives.

## 5. Tag and publish (only after 1–4 pass)

- [x] Include MIT license files at the root and in both client packages, and npm license/repository metadata.
- [ ] Change `## [1.0.0] - Unreleased` in `CHANGELOG.md` to the release date and remove the "not yet verified" line.
- [ ] Tag: `git tag -a 1.0.0 -m "EdgeWatch 1.0.0" && git push origin 1.0.0`. The tag must be `1.0.0` because
  `packages/laravel-edgewatch/composer.json` has `"version": "1.0.0"` (or delete that field and let Packagist read the tag).
- [ ] Packagist: the package lives in a subdirectory of a monorepo, so publish it from a read-only split repository
  (e.g. `splitsh-lite` or a subtree split of `packages/laravel-edgewatch`) and submit that repository to Packagist.
- [ ] npm: `cd packages/browser && bun run build && npm publish --access public` (needs an npm account that owns the `@edgewatch` scope).
- [ ] GitHub release from the `1.0.0` tag with the CHANGELOG entry.
