<?php

namespace EdgeWatch\Laravel\Transport;

interface Transport
{
    /**
     * @param  list<array<string, mixed>>  $records
     */
    public function send(array $records): void;
}
