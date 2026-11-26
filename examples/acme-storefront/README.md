# Acme Storefront (Laravel demo app)

A small Laravel 12 storefront (catalog, product pages, checkout, queued order processing, mail, notifications and a
scheduled task) that sends its telemetry to EdgeWatch through the official
[`laravel/nightwatch`](https://github.com/laravel/nightwatch) package and its agent. Nothing in the app talks to
EdgeWatch directly; the agent is pointed at the EdgeWatch ingest Worker with `NIGHTWATCH_BASE_URL`.

Verified with Laravel Framework 12.74.0 and `laravel/nightwatch` v1.30.6 (PHP 8.5) against a local EdgeWatch
(`wrangler dev`). Other versions are not verified here.

## Setup

```bash
cd examples/acme-storefront
composer install                      # laravel/framework + laravel/nightwatch (already in composer.json)
cp .env.example .env
touch database/database.sqlite
php artisan migrate --seed --force    # users, products, orders and the database queue tables
```

In a new app you would add the package with `composer require laravel/nightwatch`.

Set the two ingest settings in `.env`:

| Variable | Value |
| --- | --- |
| `NIGHTWATCH_TOKEN` | An EdgeWatch ingest key, e.g. `bun run --filter @edgewatch/ingest create-key acme-storefront ingest server --remote`. Its project receives the data. |
| `NIGHTWATCH_BASE_URL` | The EdgeWatch ingest origin, e.g. `https://edgewatch-ingest.<subdomain>.workers.dev`. Only the agent reads it. |

The other Nightwatch settings in `.env.example` (`NIGHTWATCH_ENABLED`, `NIGHTWATCH_SERVER`, and `LOG_STACK=single,nightwatch`
so logs reach the agent) are standard `laravel/nightwatch` options.

## Run

```bash
php artisan nightwatch:agent          # terminal 1: the official agent (reads NIGHTWATCH_BASE_URL and NIGHTWATCH_TOKEN)
php artisan serve                     # terminal 2: the app on APP_URL (http://127.0.0.1:8000)
php artisan demo:generate --orders=20 # terminal 3: storefront traffic
php artisan queue:work --stop-when-empty
php artisan schedule:run
```

The variables can also be set on the command line instead of `.env`, for example
`NIGHTWATCH_BASE_URL=https://edgewatch-ingest.<subdomain>.workers.dev NIGHTWATCH_TOKEN=ew_live_... php artisan nightwatch:agent`.

`demo:generate` uses Laravel's HTTP client to call the running app (`--url` overrides `APP_URL`). The agent records:

- **Requests:** `/api/catalog`, `/api/products/{slug}` (including 404s), `/api/checkout` (201, or 402 when the card is declined) and `/api/orders/{order}`, with the signed-in customer.
- **Commands:** `demo:generate`, with its outgoing requests.
- **Jobs:** `App\Jobs\ProcessOrder`, which fails for orders of more than 3 items.
- **Exceptions:** `PaymentDeclinedException` and the failed job's `RuntimeException`.
- **Other events:** queries, cache (`catalog`, `stats:orders-paid`), logs, the `OrderConfirmation` mail and the `OrderShipped` notification.
- **Scheduled task:** `prune-abandoned-orders`.

The agent sends live activity only, so the dashboard shows data from the time you run the demo; there is no historical
backfill.
