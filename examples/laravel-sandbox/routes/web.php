<?php

use App\Models\User;
use Illuminate\Support\Facades\DB;
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

Route::post('/checkout', function () {
    throw new RuntimeException('Card was declined for jane@example.com');
})->name('checkout')->withoutMiddleware(\Illuminate\Foundation\Http\Middleware\ValidateCsrfToken::class);
