<?php

namespace App\Jobs;

use App\Models\User;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Cache;

class SendOrderConfirmation implements ShouldQueue
{
    use Queueable;

    public function __construct(public int $userId) {}

    public function handle(): void
    {
        $user = User::find($this->userId);
        Cache::put("order-confirmation:{$this->userId}", now()->toIso8601String(), 300);
        logger()->info('Order confirmation sent', ['user' => $user?->id]);
    }
}
