<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

class GenerateDemoLogs extends Command
{
    protected $signature = 'demo:generate
        {--days=3 : Number of days of historical logs and telemetry to generate}
        {--project= : Project slug (defaults to EDGEWATCH_PROJECT or acme-storefront)}
        {--endpoint= : Ingest URL (defaults to EDGEWATCH_INGEST_URL)}
        {--token= : Ingest API token (defaults to EDGEWATCH_TOKEN)}
        {--write-log : Also write generated log entries to storage/logs/laravel.log}
        {--dry-run : Generate locally and print summary without sending}';

    protected $description = 'Generate multi-day realistic logs and telemetry for Acme Storefront';

    public function handle(): int
    {
        $days = max(1, min(14, (int) $this->option('days')));
        $project = (string) ($this->option('project') ?: env('EDGEWATCH_PROJECT', 'acme-storefront'));
        $endpoint = (string) ($this->option('endpoint') ?: env('EDGEWATCH_INGEST_URL', ''));
        $token = (string) ($this->option('token') ?: env('EDGEWATCH_TOKEN', ''));
        $dryRun = (bool) $this->option('dry-run');
        $writeLog = (bool) $this->option('write-log');

        if (! $dryRun && ($endpoint === '' || $token === '')) {
            $this->error('Provide --endpoint and --token (or set EDGEWATCH_INGEST_URL and EDGEWATCH_TOKEN), or pass --dry-run.');

            return self::FAILURE;
        }

        $now = time();
        $hours = $days * 24;
        $records = [];
        $counts = [
            'traces' => 0,
            'requests' => 0,
            'queries' => 0,
            'logs' => 0,
            'exceptions' => 0,
            'jobs' => 0,
            'commands' => 0,
            'scheduled_tasks' => 0,
            'cache_events' => 0,
            'outgoing_requests' => 0,
            'mail' => 0,
            'notifications' => 0,
        ];

        $users = [
            ['id' => '101', 'name' => 'Maya Lin', 'username' => 'maya@acme-storefront.test'],
            ['id' => '102', 'name' => 'Daniel Park', 'username' => 'daniel@acme-storefront.test'],
            ['id' => '103', 'name' => 'Hannah Brooks', 'username' => 'hannah@acme-storefront.test'],
            ['id' => '104', 'name' => 'Omar Farooq', 'username' => 'omar@acme-storefront.test'],
            ['id' => '105', 'name' => 'Clara Morales', 'username' => 'clara@acme-storefront.test'],
            ['id' => '106', 'name' => 'Lucas Meyer', 'username' => 'lucas@acme-storefront.test'],
            ['id' => '107', 'name' => 'Yuki Sato', 'username' => 'yuki@acme-storefront.test'],
            ['id' => '108', 'name' => 'Tessa Grant', 'username' => 'tessa@acme-storefront.test'],
        ];

        foreach ($users as $u) {
            $records[] = [
                'v' => 1,
                't' => 'user',
                'timestamp' => $now - 120,
                'id' => $u['id'],
                'name' => $u['name'],
                'username' => $u['username'],
            ];
        }

        $routes = [
            ['method' => 'GET', 'path' => '/api/catalog', 'name' => 'catalog.index', 'action' => 'App\\Http\\Controllers\\CatalogController@index', 'base_ms' => 58],
            ['method' => 'GET', 'path' => '/api/products/{slug}', 'name' => 'products.show', 'action' => 'App\\Http\\Controllers\\ProductController@show', 'base_ms' => 46],
            ['method' => 'GET', 'path' => '/api/cart', 'name' => 'cart.show', 'action' => 'App\\Http\\Controllers\\CartController@show', 'base_ms' => 72],
            ['method' => 'POST', 'path' => '/api/checkout', 'name' => 'checkout.store', 'action' => 'App\\Http\\Controllers\\CheckoutController@store', 'base_ms' => 360],
            ['method' => 'GET', 'path' => '/api/orders', 'name' => 'orders.index', 'action' => 'App\\Http\\Controllers\\OrderController@index', 'base_ms' => 155],
            ['method' => 'GET', 'path' => '/api/orders/{order}', 'name' => 'orders.show', 'action' => 'App\\Http\\Controllers\\OrderController@show', 'base_ms' => 88],
            ['method' => 'POST', 'path' => '/api/webhooks/payments', 'name' => 'webhooks.payments', 'action' => 'App\\Http\\Controllers\\PaymentWebhookController@handle', 'base_ms' => 230],
            ['method' => 'PATCH', 'path' => '/api/account/profile', 'name' => 'profile.update', 'action' => 'App\\Http\\Controllers\\ProfileController@update', 'base_ms' => 94],
        ];

        $paymentStack = implode("\n", [
            '#0 app/Services/PaymentGateway.php(88): App\\Services\\PaymentGateway->authorize()',
            '#1 app/Http/Controllers/CheckoutController.php(64): App\\Http\\Controllers\\CheckoutController->store()',
            '#2 vendor/laravel/framework/src/Illuminate/Routing/Controller.php(54): Illuminate\\Routing\\Controller->callAction()',
            '#3 vendor/laravel/framework/src/Illuminate/Pipeline/Pipeline.php(183): Illuminate\\Pipeline\\Pipeline->{closure}()',
        ]);

        $deadlockStack = implode("\n", [
            '#0 app/Services/OrderLedger.php(132): App\\Services\\OrderLedger->recordSettlement()',
            '#1 app/Http/Controllers/PaymentWebhookController.php(51): App\\Http\\Controllers\\PaymentWebhookController->handle()',
            '#2 vendor/laravel/framework/src/Illuminate/Database/Connection.php(825): Illuminate\\Database\\Connection->runQueryCallback()',
            '#3 vendor/laravel/framework/src/Illuminate/Routing/Router.php(807): Illuminate\\Routing\\Router->runRouteWithinStack()',
        ]);

        $stockStack = implode("\n", [
            '#0 app/Services/InventoryService.php(45): App\\Services\\InventoryService->reserve()',
            '#1 app/Http/Controllers/OrderController.php(96): App\\Http\\Controllers\\OrderController->show()',
            '#2 vendor/laravel/framework/src/Illuminate/Routing/ControllerDispatcher.php(46): Illuminate\\Routing\\ControllerDispatcher->dispatch()',
        ]);

        $seq = 0;

        for ($hourAgo = $hours - 1; $hourAgo >= 0; $hourAgo--) {
            $hourStart = $now - ($hourAgo * 3600) - 3540;
            $hourOfDay = (int) gmdate('G', $hourStart);
            // Natural diurnal curve: quieter overnight, busier during daytime hours.
            $requestsThisHour = ($hourOfDay >= 10 && $hourOfDay <= 21) ? 7 : 4;
            // Deterministic brief incident window ~14 hours ago and ~42 hours ago.
            $incidentHour = ($hourAgo === 14 || $hourAgo === 42);

            for ($r = 0; $r < $requestsThisHour; $r++) {
                $seq++;
                $ts = $hourStart + (int) floor(($r + 0.35) * (3500 / $requestsThisHour));
                if ($ts >= $now) {
                    $ts = $now - 5;
                }

                $traceId = (string) Str::uuid();
                $environment = ($seq % 7 === 0) ? 'staging' : 'production';
                $server = $environment === 'staging'
                    ? 'acme-staging-1'
                    : (($seq % 2 === 0) ? 'acme-web-1' : 'acme-web-2');
                $deploy = $environment === 'staging' ? 'v3.9.0-rc2' : ($hourAgo > 36 ? 'v3.8.1' : 'v3.8.2');
                $route = $routes[$seq % count($routes)];
                $user = $users[$seq % count($users)];

                $isCheckoutFail = $route['name'] === 'checkout.store' && ($incidentHour || $seq % 11 === 0);
                $isWebhookFail = $route['name'] === 'webhooks.payments' && ($incidentHour || $seq % 13 === 0);
                $isNotFound = $route['name'] === 'products.show' && ($seq % 17 === 0);
                $isNPlusOne = $route['name'] === 'orders.index' && ($seq % 3 === 0);

                $statusCode = $isCheckoutFail
                    ? 500
                    : ($isWebhookFail ? 503 : ($isNotFound ? 404 : ($route['method'] === 'POST' ? 201 : 200)));

                $jitter = (($seq * 41) % 110) - 25;
                $totalMs = max(24, $route['base_ms'] + $jitter + ($incidentHour ? 180 : 0) + ($isCheckoutFail ? 520 : 0) + ($isNPlusOne ? 410 : 0));
                $durationUs = $totalMs * 1000;

                $exec = [
                    'deploy' => $deploy,
                    'server' => $server,
                    'environment' => $environment,
                    '_group' => $route['method'].':'.$route['name'],
                    'trace_id' => $traceId,
                    'execution_source' => 'request',
                    'execution_id' => $traceId,
                    'execution_preview' => $route['method'].' '.$route['path'],
                    'execution_stage' => 'action',
                    'user' => $user['id'],
                ];

                $qCount = 0;
                $eCount = 0;
                $lCount = 0;
                $cCount = 0;
                $oCount = 0;
                $mCount = 0;
                $nCount = 0;
                $jQueued = 0;

                // Cache event
                $cacheHit = ($seq % 4 !== 0);
                $cacheKey = $route['name'] === 'catalog.index'
                    ? 'catalog:featured:v3'
                    : ($route['name'] === 'products.show' ? 'product:wireless-headphones' : "cart:user:{$user['id']}");
                $records[] = array_merge($exec, [
                    'v' => 1,
                    't' => 'cache-event',
                    'timestamp' => $ts + 0.010,
                    'store' => 'redis',
                    'key' => $cacheKey,
                    'type' => $cacheHit ? 'hit' : 'miss',
                    'duration' => $cacheHit ? 1100 : 2600,
                ]);
                $cCount++;
                $counts['cache_events']++;

                if (! $cacheHit) {
                    $records[] = array_merge($exec, [
                        'v' => 1,
                        't' => 'cache-event',
                        'timestamp' => $ts + 0.022,
                        'store' => 'redis',
                        'key' => $cacheKey,
                        'type' => 'write',
                        'ttl' => 600,
                        'duration' => 1800,
                    ]);
                    $cCount++;
                    $counts['cache_events']++;
                }

                // Primary SQL query
                $primarySql = match ($route['name']) {
                    'orders.index' => 'select * from orders where user_id = ? order by created_at desc limit 25',
                    'checkout.store' => 'select * from carts inner join cart_items on carts.id = cart_items.cart_id where carts.user_id = ? for update',
                    'catalog.index' => 'select id, slug, title, price_cents from products where status = ? order by featured_rank asc limit 24',
                    default => 'select * from products where slug = ? and published_at is not null limit 1',
                };
                $records[] = array_merge($exec, [
                    'v' => 1,
                    't' => 'query',
                    'timestamp' => $ts + 0.028,
                    'sql' => $primarySql,
                    'file' => 'app/Http/Controllers/OrderController.php',
                    'line' => 44,
                    'duration' => $route['name'] === 'checkout.store' ? 132000 : 16000,
                    'connection' => 'mysql',
                    'connection_type' => $route['method'] === 'GET' ? 'read' : 'write',
                ]);
                $qCount++;
                $counts['queries']++;

                // Slow reporting query periodically
                if ($route['name'] === 'orders.index' && $seq % 5 === 0) {
                    $records[] = array_merge($exec, [
                        'v' => 1,
                        't' => 'query',
                        'timestamp' => $ts + 0.048,
                        'sql' => 'select date(created_at) as day, count(*) as order_count, sum(total_cents) as gross_cents from orders where status = ? and created_at >= ? group by date(created_at)',
                        'file' => 'app/Services/SalesMetrics.php',
                        'line' => 82,
                        'duration' => 340000 + (($seq % 5) * 42000),
                        'connection' => 'mysql',
                        'connection_type' => 'read',
                    ]);
                    $qCount++;
                    $counts['queries']++;
                }

                // N+1 pattern on orders.index
                if ($isNPlusOne) {
                    for ($n = 0; $n < 6; $n++) {
                        $records[] = array_merge($exec, [
                            'v' => 1,
                            't' => 'query',
                            'timestamp' => $ts + 0.055 + ($n * 0.024),
                            'sql' => 'select * from order_items where order_items.order_id = ? and order_items.order_id is not null',
                            'file' => 'app/Models/Order.php',
                            'line' => 118,
                            'duration' => 21000 + (($n % 3) * 5000),
                            'connection' => 'mysql',
                            'connection_type' => 'read',
                        ]);
                        $qCount++;
                        $counts['queries']++;
                    }
                }

                // Outgoing HTTP on checkout & webhooks
                if ($route['name'] === 'checkout.store' || $route['name'] === 'webhooks.payments') {
                    $records[] = array_merge($exec, [
                        'v' => 1,
                        't' => 'outgoing-request',
                        'timestamp' => $ts + 0.13,
                        'host' => 'api.payments.acme.test',
                        'method' => 'POST',
                        'url' => 'https://api.payments.acme.test/v1/charges',
                        'status_code' => $isCheckoutFail ? 402 : ($isWebhookFail ? 502 : 200),
                        'duration' => $isCheckoutFail ? 390000 : 165000,
                    ]);
                    $oCount++;
                    $counts['outgoing_requests']++;
                }

                // Successful checkout: job, mail, notification, info log
                if ($route['name'] === 'checkout.store' && ! $isCheckoutFail) {
                    $orderCode = 'ACM-'.(5000 + $seq);
                    $records[] = array_merge($exec, [
                        'v' => 1,
                        't' => 'queued-job',
                        'timestamp' => $ts + 0.30,
                        'job_id' => (string) Str::uuid(),
                        'name' => 'App\\Jobs\\GenerateInvoicePdf',
                        'connection' => 'redis',
                        'queue' => 'billing',
                        'duration' => 4200,
                    ]);
                    $jQueued++;
                    $counts['jobs']++;

                    $records[] = array_merge($exec, [
                        'v' => 1,
                        't' => 'mail',
                        'timestamp' => $ts + 0.31,
                        'mailer' => 'smtp',
                        'class' => 'App\\Mail\\OrderConfirmation',
                        'subject' => "Acme Storefront order #{$orderCode} confirmed",
                        'to' => 1,
                        'cc' => 0,
                        'bcc' => 0,
                        'attachments' => 1,
                        'duration' => 84000,
                        'failed' => false,
                    ]);
                    $mCount++;
                    $counts['mail']++;

                    $records[] = array_merge($exec, [
                        'v' => 1,
                        't' => 'notification',
                        'timestamp' => $ts + 0.33,
                        'channel' => 'mail',
                        'class' => 'App\\Notifications\\OrderConfirmed',
                        'duration' => 34000,
                        'failed' => false,
                    ]);
                    $nCount++;
                    $counts['notifications']++;

                    $logContext = ['order' => $orderCode, 'total_cents' => 8900 + ($seq * 35), 'currency' => 'USD', 'user_id' => $user['id']];
                    $logMessage = "Order #{$orderCode} completed for customer #{$user['id']}";
                    $records[] = array_merge($exec, [
                        'v' => 1,
                        't' => 'log',
                        'timestamp' => $ts + 0.34,
                        'level' => 'info',
                        'message' => $logMessage,
                        'context' => json_encode($logContext, JSON_THROW_ON_ERROR),
                    ]);
                    $lCount++;
                    $counts['logs']++;
                    if ($writeLog) {
                        Log::info($logMessage, $logContext);
                    }
                }

                // Exceptions + rich logs across all severities
                if ($isCheckoutFail) {
                    $records[] = array_merge($exec, [
                        'v' => 1,
                        't' => 'exception',
                        'timestamp' => $ts + 0.51,
                        'class' => 'App\\Exceptions\\PaymentDeclinedException',
                        'file' => 'app/Services/PaymentGateway.php',
                        'line' => 88,
                        'message' => 'Payment authorization declined: insufficient funds.',
                        'code' => 'card_declined',
                        'trace' => $paymentStack,
                        'handled' => false,
                    ]);
                    $eCount++;
                    $counts['exceptions']++;

                    $logContext = ['gateway' => 'acme-pay', 'reason' => 'insufficient_funds', 'user_id' => $user['id'], 'env' => $environment];
                    $logMessage = 'Checkout authorization failed at payment gateway';
                    $records[] = array_merge($exec, [
                        'v' => 1,
                        't' => 'log',
                        'timestamp' => $ts + 0.515,
                        'level' => 'error',
                        'message' => $logMessage,
                        'context' => json_encode($logContext, JSON_THROW_ON_ERROR),
                    ]);
                    $lCount++;
                    $counts['logs']++;
                    if ($writeLog) {
                        Log::error($logMessage, $logContext);
                    }
                } elseif ($isWebhookFail) {
                    $records[] = array_merge($exec, [
                        'v' => 1,
                        't' => 'exception',
                        'timestamp' => $ts + 0.29,
                        'class' => 'Illuminate\\Database\\QueryException',
                        'file' => 'app/Services/OrderLedger.php',
                        'line' => 132,
                        'message' => 'SQLSTATE[40001]: Serialization failure: 1213 Deadlock found when trying to get lock',
                        'code' => '40001',
                        'trace' => $deadlockStack,
                        'handled' => false,
                    ]);
                    $eCount++;
                    $counts['exceptions']++;

                    $logContext = ['event_id' => "evt_{$seq}", 'table' => 'order_ledger', 'retryable' => true];
                    $logMessage = 'Payment settlement webhook hit database deadlock; returning 503 for retry';
                    $records[] = array_merge($exec, [
                        'v' => 1,
                        't' => 'log',
                        'timestamp' => $ts + 0.295,
                        'level' => 'critical',
                        'message' => $logMessage,
                        'context' => json_encode($logContext, JSON_THROW_ON_ERROR),
                    ]);
                    $lCount++;
                    $counts['logs']++;
                    if ($writeLog) {
                        Log::critical($logMessage, $logContext);
                    }
                } elseif ($route['name'] === 'orders.show' && $seq % 4 === 0) {
                    $records[] = array_merge($exec, [
                        'v' => 1,
                        't' => 'exception',
                        'timestamp' => $ts + 0.045,
                        'class' => 'App\\Exceptions\\StockThresholdException',
                        'file' => 'app/Services/InventoryService.php',
                        'line' => 45,
                        'message' => 'SKU-4821 fell below safety stock threshold (2 remaining).',
                        'code' => '0',
                        'trace' => $stockStack,
                        'handled' => true,
                    ]);
                    $eCount++;
                    $counts['exceptions']++;

                    $logContext = ['sku' => 'SKU-4821', 'remaining' => 2, 'warehouse' => 'us-east-1'];
                    $logMessage = 'Inventory safety threshold triggered for SKU-4821';
                    $records[] = array_merge($exec, [
                        'v' => 1,
                        't' => 'log',
                        'timestamp' => $ts + 0.048,
                        'level' => 'warning',
                        'message' => $logMessage,
                        'context' => json_encode($logContext, JSON_THROW_ON_ERROR),
                    ]);
                    $lCount++;
                    $counts['logs']++;
                    if ($writeLog) {
                        Log::warning($logMessage, $logContext);
                    }
                } elseif ($seq % 3 === 0) {
                    $level = ($seq % 9 === 0) ? 'notice' : (($seq % 6 === 0) ? 'debug' : 'info');
                    $logContext = ['route' => $route['name'], 'cache_hit' => $cacheHit, 'server' => $server, 'duration_ms' => $totalMs];
                    $logMessage = match ($level) {
                        'notice' => "Catalog pricing snapshot refreshed for {$route['name']}",
                        'debug' => "Served {$route['name']} in {$totalMs}ms (cache ".($cacheHit ? 'hit' : 'miss').')',
                        default => "Handled {$route['method']} {$route['path']} for user #{$user['id']}",
                    };
                    $records[] = array_merge($exec, [
                        'v' => 1,
                        't' => 'log',
                        'timestamp' => $ts + 0.040,
                        'level' => $level,
                        'message' => $logMessage,
                        'context' => json_encode($logContext, JSON_THROW_ON_ERROR),
                    ]);
                    $lCount++;
                    $counts['logs']++;
                    if ($writeLog) {
                        Log::log($level, $logMessage, $logContext);
                    }
                }

                $records[] = array_merge($exec, [
                    'v' => 1,
                    't' => 'request',
                    'timestamp' => $ts,
                    'method' => $route['method'],
                    'url' => 'https://shop.acme-storefront.test'.str_replace(['{order}', '{slug}'], [(string) (5000 + $seq), 'studio-headphones'], $route['path']),
                    'route_name' => $route['name'],
                    'route_methods' => [$route['method']],
                    'route_domain' => 'shop.acme-storefront.test',
                    'route_path' => $route['path'],
                    'route_action' => $route['action'],
                    'ip' => '203.0.113.'.(10 + ($seq % 60)),
                    'duration' => $durationUs,
                    'status_code' => $statusCode,
                    'request_size' => $route['method'] === 'POST' ? 760 : 0,
                    'response_size' => 3800 + (($seq % 12) * 320),
                    'bootstrap' => 8500,
                    'before_middleware' => 3500,
                    'action' => max(10000, $durationUs - 20000),
                    'render' => 4500,
                    'after_middleware' => 1800,
                    'sending' => 900,
                    'terminating' => 800,
                    'exceptions' => $eCount,
                    'logs' => $lCount,
                    'queries' => $qCount,
                    'lazy_loads' => $isNPlusOne ? 6 : 0,
                    'jobs_queued' => $jQueued,
                    'mail' => $mCount,
                    'notifications' => $nCount,
                    'outgoing_requests' => $oCount,
                    'files_read' => 0,
                    'files_written' => 0,
                    'cache_events' => $cCount,
                    'hydrated_models' => $isNPlusOne ? 36 : 5,
                    'peak_memory_usage' => (16 + ($seq % 14)) * 1024 * 1024,
                    'exception_preview' => $isCheckoutFail ? 'App\\Exceptions\\PaymentDeclinedException' : ($isWebhookFail ? 'Illuminate\\Database\\QueryException' : ''),
                    'context' => '',
                    'headers' => json_encode(['user-agent' => 'AcmeStorefrontWeb/3.8', 'accept' => 'application/json'], JSON_THROW_ON_ERROR),
                ]);
                $counts['requests']++;
                $counts['traces']++;
            }

            // Hourly background job attempt
            $jobTraceId = (string) Str::uuid();
            $jobTs = $hourStart + 1800;
            $jobSpecs = [
                ['name' => 'App\\Jobs\\GenerateInvoicePdf', 'queue' => 'billing', 'ms' => 540],
                ['name' => 'App\\Jobs\\SyncWarehouseStock', 'queue' => 'inventory', 'ms' => 820],
                ['name' => 'App\\Jobs\\DispatchShipmentNotice', 'queue' => 'notifications', 'ms' => 310],
            ];
            $jobSpec = $jobSpecs[$hourAgo % count($jobSpecs)];
            $jobStatus = ($hourAgo % 19 === 0) ? 'failed' : (($hourAgo % 11 === 0) ? 'released' : 'processed');
            $jobExec = [
                'deploy' => 'v3.8.2',
                'server' => 'acme-worker-1',
                'environment' => 'production',
                '_group' => $jobSpec['name'],
                'trace_id' => $jobTraceId,
                'execution_source' => 'job',
                'execution_id' => $jobTraceId,
                'execution_preview' => $jobSpec['name'],
                'execution_stage' => 'action',
                'user' => null,
            ];
            $records[] = array_merge($jobExec, [
                'v' => 1,
                't' => 'job-attempt',
                'timestamp' => $jobTs,
                'job_id' => (string) Str::uuid(),
                'attempt_id' => (string) Str::uuid(),
                'attempt' => $jobStatus === 'failed' ? 3 : 1,
                'name' => $jobSpec['name'],
                'connection' => 'redis',
                'queue' => $jobSpec['queue'],
                'status' => $jobStatus,
                'duration' => $jobSpec['ms'] * 1000,
                'peak_memory_usage' => 28 * 1024 * 1024,
            ]);
            $records[] = array_merge($jobExec, [
                'v' => 1,
                't' => 'outgoing-request',
                'timestamp' => $jobTs + 0.09,
                'host' => 'api.shipping.acme.test',
                'method' => 'POST',
                'url' => 'https://api.shipping.acme.test/v2/labels',
                'status_code' => $jobStatus === 'failed' ? 500 : 200,
                'duration' => 125000,
            ]);
            $counts['jobs']++;
            $counts['outgoing_requests']++;
            $counts['traces']++;

            // Hourly scheduled task
            $taskTraceId = (string) Str::uuid();
            $taskStatus = ($hourAgo % 23 === 0) ? 'failed' : (($hourAgo % 15 === 0) ? 'skipped' : 'processed');
            $records[] = [
                'v' => 1,
                't' => 'scheduled-task',
                'timestamp' => $hourStart + 300,
                'deploy' => 'v3.8.2',
                'server' => 'acme-worker-1',
                'environment' => 'production',
                '_group' => 'App\\Console\\Tasks\\PruneAbandonedCarts',
                'trace_id' => $taskTraceId,
                'execution_source' => 'schedule',
                'execution_id' => $taskTraceId,
                'execution_preview' => 'App\\Console\\Tasks\\PruneAbandonedCarts',
                'execution_stage' => 'action',
                'name' => 'App\\Console\\Tasks\\PruneAbandonedCarts',
                'cron' => '0 * * * *',
                'timezone' => 'UTC',
                'status' => $taskStatus,
                'duration' => ($taskStatus === 'skipped' ? 14 : 410) * 1000,
            ];
            $counts['scheduled_tasks']++;
            $counts['traces']++;

            // Daily artisan commands every 12 hours
            if ($hourAgo % 12 === 0) {
                $cmdTraceId = (string) Str::uuid();
                $cmdFailed = ($hourAgo === 24);
                $cmdName = $cmdFailed ? 'reports:export' : 'orders:reconcile';
                $records[] = [
                    'v' => 1,
                    't' => 'command',
                    'timestamp' => $hourStart + 600,
                    'deploy' => 'v3.8.2',
                    'server' => 'acme-worker-1',
                    'environment' => 'production',
                    '_group' => $cmdName,
                    'trace_id' => $cmdTraceId,
                    'execution_source' => 'command',
                    'execution_id' => $cmdTraceId,
                    'execution_preview' => $cmdName,
                    'execution_stage' => 'action',
                    'name' => $cmdName,
                    'command' => "php artisan {$cmdName}",
                    'exit_code' => $cmdFailed ? 1 : 0,
                    'duration' => ($cmdFailed ? 4800 : 2150) * 1000,
                    'peak_memory_usage' => 44 * 1024 * 1024,
                ];
                $counts['commands']++;
                $counts['traces']++;
            }
        }

        $totalRecords = count($records);
        $this->info("Generated {$totalRecords} records across {$days} days ({$counts['traces']} traces, {$counts['logs']} logs, {$counts['queries']} queries, {$counts['exceptions']} exceptions) for project \"{$project}\".");

        if ($dryRun) {
            $this->line('Dry run complete; nothing was sent.');

            return self::SUCCESS;
        }

        $chunks = array_chunk($records, 200);
        $accepted = 0;
        $rejected = 0;

        foreach ($chunks as $index => $chunk) {
            $payload = json_encode(['records' => $chunk], JSON_THROW_ON_ERROR);
            $compressed = gzencode($payload);
            if ($compressed === false) {
                $this->error('Failed to gzip request payload.');

                return self::FAILURE;
            }

            $response = Http::timeout(30)
                ->withToken($token)
                ->withHeaders([
                    'X-EdgeWatch-Project' => $project,
                    'Content-Encoding' => 'gzip',
                ])
                ->withBody($compressed, 'application/json')
                ->post($endpoint);

            if (! $response->successful()) {
                $this->error("Batch ".($index + 1).' failed (HTTP '.$response->status().'): '.$response->body());

                return self::FAILURE;
            }

            $body = $response->json();
            $accepted += (int) ($body['accepted'] ?? 0);
            $rejected += (int) ($body['rejected'] ?? 0);
            $this->line('Batch '.($index + 1).'/'.count($chunks).": accepted {$body['accepted']}, rejected {$body['rejected']}");
        }

        $this->info("Done: sent {$accepted} accepted, {$rejected} rejected to {$endpoint} (project \"{$project}\").");

        return $rejected > 0 ? self::FAILURE : self::SUCCESS;
    }
}
