<?php

use App\Models\Order;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Schedule;

// Console commands in app/Console/Commands are auto-discovered by Laravel.

// Runs on every `php artisan schedule:run` so the demo always produces a scheduled task.
Schedule::call(function () {
    $pruned = Order::where('status', 'pending')->where('created_at', '<', now()->subDay())->delete();
    Log::info('Pruned abandoned orders', ['count' => $pruned]);
})->everyMinute()->name('prune-abandoned-orders');
