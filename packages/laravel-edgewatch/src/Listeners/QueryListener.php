<?php

declare(strict_types=1);

namespace EdgeWatch\Laravel\Listeners;

use EdgeWatch\Laravel\EdgeWatch;
use Illuminate\Database\Events\QueryExecuted;
use Throwable;

final class QueryListener
{
    public function __construct(private EdgeWatch $edgewatch)
    {
        //
    }

    public function handle(QueryExecuted $event): void
    {
        try {
            $this->edgewatch->query($event);
        } catch (Throwable) {
            // Telemetry must never break the application.
        }
    }
}
