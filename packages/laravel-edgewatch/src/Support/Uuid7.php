<?php

declare(strict_types=1);

namespace EdgeWatch\Laravel\Support;

use Closure;

/**
 * RFC 9562 UUIDv7: 48-bit unix ms timestamp, 4-bit version, 12-bit counter, 2-bit variant, 62 random bits.
 * The 12-bit rand_a field is used as a monotonic counter so IDs generated in the same millisecond still sort.
 */
final class Uuid7
{
    private int $lastMs = -1;

    private int $counter = 0;

    /**
     * @param  (Closure(): int)|null  $clock  returns unix time in milliseconds
     * @param  (Closure(int): string)|null  $random  returns n random bytes
     */
    public function __construct(
        private ?Closure $clock = null,
        private ?Closure $random = null,
    ) {
        $this->clock ??= static fn (): int => (int) floor(microtime(true) * 1000);
        $this->random ??= static fn (int $n): string => random_bytes($n);
    }

    public function generate(): string
    {
        $ms = ($this->clock)();

        if ($ms > $this->lastMs) {
            $this->lastMs = $ms;
            $this->counter = ord(($this->random)(1)) & 0x7F;
        } else {
            $this->counter++;

            if ($this->counter > 0xFFF) {
                $this->lastMs++;
                $this->counter = 0;
            }
        }

        $ms = $this->lastMs;
        $random = ($this->random)(8);

        $bytes = pack('J', $ms << 16 | (0x7000 | $this->counter));
        $bytes .= chr((ord($random[0]) & 0x3F) | 0x80).substr($random, 1, 7);

        $hex = bin2hex($bytes);

        return substr($hex, 0, 8).'-'.substr($hex, 8, 4).'-'.substr($hex, 12, 4).'-'.substr($hex, 16, 4).'-'.substr($hex, 20, 12);
    }

    public static function timestamp(string $uuid): int
    {
        return (int) hexdec(substr(str_replace('-', '', $uuid), 0, 12));
    }

    public static function isValid(string $uuid): bool
    {
        return preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/', $uuid) === 1;
    }
}
