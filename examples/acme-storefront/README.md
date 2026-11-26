# Acme Storefront (Laravel Demo App)

A minimal Laravel 12 application that generates 3 full days (72 hours) of realistic storefront logs and telemetry for an EdgeWatch dashboard.

## Setup

```bash
cd examples/acme-storefront
composer install
cp .env.example .env
```

Set `EDGEWATCH_INGEST_URL`, `EDGEWATCH_TOKEN`, and `EDGEWATCH_PROJECT` in `.env` (or pass them as CLI options).

## Generate 3 days of demo data

```bash
php artisan demo:generate --days=3
```

Options:

- `--days=3` - number of days of historical traffic and logs to generate (default: `3`)
- `--project=acme-storefront` - project slug in EdgeWatch
- `--endpoint=...` - ingest endpoint URL (`POST /api/ingest`)
- `--token=...` - ingest API key
- `--write-log` - also append generated log entries to `storage/logs/laravel.log`
- `--dry-run` - generate locally and print counts without sending HTTP requests
