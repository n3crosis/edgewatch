<?php

use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

Artisan::command('report:daily', function () {
    $this->info('Users: '.\App\Models\User::count());
})->purpose('Demo command that generates an EdgeWatch command record');
