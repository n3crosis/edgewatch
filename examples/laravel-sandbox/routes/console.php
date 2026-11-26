<?php

use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

Artisan::command('report:daily', function () {
    $this->info('Users: '.\App\Models\User::count());
})->purpose('Demo command that generates an EdgeWatch command record');

// Scheduled task (scheduled-task record, its own trace): run with `php artisan schedule:run`.
Schedule::call(fn () => \App\Models\User::count())->everyMinute()->name('count-users');
