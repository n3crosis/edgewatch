<?php

use App\Jobs\SendOrderConfirmation;
use App\Models\User;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Notification;
use Illuminate\Support\Facades\Route;

// Demo routes that generate EdgeWatch telemetry: requests, queries (with literals to be stripped) and exceptions.

Route::get('/', fn () => view('welcome'));

Route::get('/users/{id}', function (string $id) {
    $user = User::findOrFail($id);
    DB::select("select count(*) as c from users where email like '%@example.com'");

    return ['id' => $user->id, 'name' => $user->name];
})->name('users.show');

Route::get('/report', function () {
    return [
        'users' => User::query()->whereIn('id', [1, 2, 3])->count(),
        'latest' => User::query()->latest()->limit(5)->pluck('email'),
    ];
})->name('report');

// Outgoing HTTP call through Laravel's Http client (outgoing-request record).
Route::get('/upstream', function () {
    return ['status' => Http::timeout(5)->get(env('UPSTREAM_URL', 'http://127.0.0.1:8787/health'))->status()];
})->name('upstream');

// Mail and a notification (sandbox MAIL_MAILER=log, so nothing leaves the machine).
Route::post('/welcome', function () {
    Mail::raw('Welcome aboard', fn ($m) => $m->to('jane@example.com')->subject('Welcome jane@example.com'));
    Notification::route('mail', 'jane@example.com')->notify(new App\Notifications\Welcome);

    return response()->noContent();
})->name('welcome')->withoutMiddleware(\Illuminate\Foundation\Http\Middleware\ValidateCsrfToken::class);

Route::post('/checkout', function () {
    throw new RuntimeException('Card was declined for jane@example.com');
})->name('checkout')->withoutMiddleware(\Illuminate\Foundation\Http\Middleware\ValidateCsrfToken::class);

// Cache events (miss then write, hit on repeat) and a queued job (queued-job now, job-attempt when a worker runs it).
Route::post('/orders', function () {
    $stats = Cache::remember('order-stats', 60, fn () => ['users' => User::count()]);
    SendOrderConfirmation::dispatch(1);
    Log::warning('Low stock after order for jane@example.com', ['sku' => 'TSHIRT-M', 'left' => 2]);

    return response()->json(['queued' => true, 'stats' => $stats], 202);
})->name('orders.store')->withoutMiddleware(\Illuminate\Foundation\Http\Middleware\ValidateCsrfToken::class);
