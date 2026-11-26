# EdgeWatch Laravel sandbox

Laravel 12 app that installs `edgewatch/laravel-edgewatch` from `../../packages/laravel-edgewatch` through a Composer
path repository (symlinked, so package edits apply immediately).

> The spec asked for Laravel 11, but every Laravel 11 release is blocked by Composer's security-advisory check, and
> Laravel 11 is no longer receiving security fixes. The package itself supports `^11.0|^12.0`.

```bash
composer install
cp .env.example .env && php artisan key:generate && php artisan migrate
php artisan serve
```

Demo routes: `GET /users/{id}`, `GET /report` (queries), `POST /checkout` (throws). Tests: `./vendor/bin/pest`.

Point it at a local pipeline (`wrangler dev` on :8787):

- **Agentless:** `EDGEWATCH_INGEST_URI=http://127.0.0.1:8787/api/ingest` with `EDGEWATCH_TOKEN=<ingest key>`.
- **Official Nightwatch agent:** `EDGEWATCH_INGEST_URI=127.0.0.1:2407`. Then run the agent with
  `NIGHTWATCH_TOKEN=<ingest key> NIGHTWATCH_BASE_URL=http://127.0.0.1:8787`.
