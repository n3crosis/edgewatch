<?php

namespace App\Console\Commands;

use App\Models\Product;
use App\Models\User;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Sends storefront traffic to the running app with Laravel's HTTP client. The official laravel/nightwatch
 * agent records everything this produces: this command and its outgoing requests, the app's request traces,
 * queries, cache events, logs, exceptions and queued jobs. Nothing here talks to EdgeWatch directly.
 */
class GenerateDemoLogs extends Command
{
    protected $signature = 'demo:generate
        {--orders=20 : Number of checkout attempts to send}
        {--url= : Base URL of the running app (defaults to APP_URL)}';

    protected $description = 'Send storefront traffic to the running Acme Storefront app';

    public function handle(): int
    {
        $base = rtrim((string) ($this->option('url') ?: config('app.url')), '/').'/api';
        $orders = max(1, min(500, (int) $this->option('orders')));
        $users = User::pluck('id')->all();
        $products = Product::pluck('slug')->all();

        if ($users === [] || $products === []) {
            $this->error('No users or products: run `php artisan migrate --seed` first.');

            return self::FAILURE;
        }

        $statuses = [];
        $count = function (int $status) use (&$statuses): void {
            $statuses[$status] = ($statuses[$status] ?? 0) + 1;
        };

        for ($i = 0; $i < $orders; $i++) {
            $count(Http::acceptJson()->get("{$base}/catalog")->status());
            $slug = $products[$i % count($products)];
            $count(Http::acceptJson()->get("{$base}/products/{$slug}")->status());
            if ($i % 9 === 4) {
                $count(Http::acceptJson()->get("{$base}/products/discontinued-item")->status());
            }

            $checkout = Http::acceptJson()->post("{$base}/checkout", [
                'user_id' => $users[$i % count($users)],
                'product' => $slug,
                'quantity' => $i % 6 === 5 ? 4 : 1 + ($i % 3),
                'card' => $i % 7 === 3 ? 'declined' : 'visa',
            ]);
            $count($checkout->status());
            if ($checkout->status() === 201) {
                $count(Http::acceptJson()->get("{$base}/orders/{$checkout->json('data.id')}")->status());
            }
        }

        ksort($statuses);
        Log::info('Demo traffic sent', ['orders' => $orders, 'statuses' => $statuses]);
        $this->info("Sent {$orders} checkout attempts to {$base}.");
        foreach ($statuses as $status => $n) {
            $this->line("  HTTP {$status}: {$n}");
        }
        $this->line('Next: php artisan queue:work --stop-when-empty && php artisan schedule:run');

        return self::SUCCESS;
    }
}
