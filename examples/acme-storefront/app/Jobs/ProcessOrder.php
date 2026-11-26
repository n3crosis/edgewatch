<?php

namespace App\Jobs;

use App\Mail\OrderConfirmation;
use App\Models\Order;
use App\Notifications\OrderShipped;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Mail;
use RuntimeException;

class ProcessOrder implements ShouldQueue
{
    use Queueable;

    public int $tries = 1;

    public function __construct(public Order $order) {}

    public function handle(): void
    {
        // Large orders fail the (simulated) warehouse sync, so the demo also shows failed jobs.
        if ($this->order->quantity > 3) {
            throw new RuntimeException("Warehouse sync failed for order {$this->order->id}");
        }

        $this->order->update(['status' => 'paid']);
        Cache::increment('stats:orders-paid');
        Mail::to($this->order->user)->send(new OrderConfirmation($this->order));
        $this->order->user->notify(new OrderShipped($this->order));
    }
}
