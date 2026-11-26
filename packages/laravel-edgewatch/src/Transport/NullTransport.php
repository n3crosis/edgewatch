<?php

declare(strict_types=1);

namespace EdgeWatch\Laravel\Transport;

final class NullTransport implements Transport
{
    public function send(array $records): void
    {
        //
    }
}
