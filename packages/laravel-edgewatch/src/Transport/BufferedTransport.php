<?php

declare(strict_types=1);

namespace EdgeWatch\Laravel\Transport;

use Closure;
use Throwable;

/**
 * Buffers records in memory and hands them to the inner transport when the buffer fills or flush() is called
 * (end of request/command/job). Transmission errors never propagate to the application.
 */
final class BufferedTransport
{
    /**
     * @var list<array<string, mixed>>
     */
    private array $records = [];

    private bool $sending = false;

    /**
     * @param  (Closure(Throwable): void)|null  $onError
     */
    public function __construct(
        private Transport $transport,
        private int $capacity = 500,
        private ?Closure $onError = null,
    ) {
        $this->capacity = max(1, $capacity);
    }

    /**
     * @param  array<string, mixed>  $record
     */
    public function write(array $record): void
    {
        if ($this->sending) {
            return;
        }

        $this->records[] = $record;

        if (count($this->records) >= $this->capacity) {
            $this->flush();
        }
    }

    public function flush(): void
    {
        if ($this->records === [] || $this->sending) {
            return;
        }

        $records = $this->records;
        $this->records = [];
        $this->sending = true;

        try {
            $this->transport->send($records);
        } catch (Throwable $e) {
            if ($this->onError !== null) {
                ($this->onError)($e);
            }
        } finally {
            $this->sending = false;
        }
    }

    public function discard(): void
    {
        $this->records = [];
    }

    public function count(): int
    {
        return count($this->records);
    }

    public function inner(): Transport
    {
        return $this->transport;
    }
}
