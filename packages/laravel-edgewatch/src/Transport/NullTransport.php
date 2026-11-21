<?php

namespace EdgeWatch\Laravel\Transport;

final class NullTransport implements Transport
{
    public function send(array $records): void
    {
        //
    }
}
