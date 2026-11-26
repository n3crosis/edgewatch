<?php

namespace EdgeWatch\Laravel\Tests;

use EdgeWatch\Laravel\Transport\Transport;

final class FakeTransport implements Transport
{
    /** @var list<list<array<string, mixed>>> */
    public array $batches = [];

    public function send(array $records): void
    {
        $this->batches[] = $records;
    }

    /** @return list<array<string, mixed>> */
    public function records(?string $type = null): array
    {
        $all = array_merge(...($this->batches ?: [[]]));

        return array_values($type === null ? $all : array_filter($all, fn ($r) => $r['t'] === $type));
    }
}
