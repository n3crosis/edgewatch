<?php

namespace EdgeWatch\Laravel\Transport;

/**
 * Remembers an ingest "stop" instruction (HTTP 429 / {"stop": true, "refresh_in": n}) so every PHP worker
 * process stops sending until the window passes. Persisted to a small file because PHP-FPM processes don't share memory.
 */
final class Backoff
{
    private float $until = 0.0;

    private float $checkedAt = -1.0;

    public function __construct(private ?string $path = null)
    {
        //
    }

    public function pause(int $seconds, string $reason = ''): void
    {
        $this->until = microtime(true) + max(1, $seconds);
        $this->checkedAt = microtime(true);

        if ($this->path !== null) {
            @file_put_contents($this->path, json_encode(['until' => $this->until, 'reason' => $reason]), LOCK_EX);
        }
    }

    public function pausedUntil(): float
    {
        // Re-read the shared file at most once per second.
        if ($this->path !== null && microtime(true) - $this->checkedAt >= 1.0) {
            $this->checkedAt = microtime(true);
            $data = is_file($this->path) ? json_decode((string) @file_get_contents($this->path), true) : null;
            $this->until = is_array($data) ? (float) ($data['until'] ?? 0) : 0.0;
        }

        return $this->until;
    }

    public function isPaused(): bool
    {
        return $this->pausedUntil() > microtime(true);
    }

    public function clear(): void
    {
        $this->until = 0.0;

        if ($this->path !== null && is_file($this->path)) {
            @unlink($this->path);
        }
    }
}
