<?php

namespace EdgeWatch\Laravel\Transport;

use Closure;
use RuntimeException;

/**
 * Sends records straight to an EdgeWatch ingest endpoint using the Nightwatch agent -> cloud format
 * (gzip'd {"records": [...]}, Bearer auth), so no local agent process is needed.
 */
final class HttpTransport implements Transport
{
    public const VERSION = '0.1.0';

    /**
     * @param  (Closure(string $url, array<string, string> $headers, string $body, float $connectionTimeout, float $timeout): int)|null  $sender
     */
    public function __construct(
        private string $url,
        private ?string $token,
        private string $server,
        private float $connectionTimeout = 0.5,
        private float $timeout = 0.5,
        private ?Closure $sender = null,
    ) {
        $this->sender ??= self::curlSender(...);
    }

    public function send(array $records): void
    {
        if ($records === []) {
            return;
        }

        $json = json_encode(['records' => $records], JSON_INVALID_UTF8_SUBSTITUTE | JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $body = gzencode($json);

        if ($body === false) {
            throw new RuntimeException('Unable to compress EdgeWatch payload.');
        }

        $status = ($this->sender)($this->url, [
            'accept' => 'application/json',
            'authorization' => 'Bearer '.($this->token ?? ''),
            'content-encoding' => 'gzip',
            'content-type' => 'application/json',
            'nightwatch-server' => $this->server,
            'user-agent' => 'EdgeWatchLaravel/'.self::VERSION,
        ], $body, $this->connectionTimeout, $this->timeout);

        if ($status < 200 || $status >= 300) {
            throw new RuntimeException("EdgeWatch ingest responded with HTTP {$status}");
        }
    }

    /**
     * @param  array<string, string>  $headers
     */
    private static function curlSender(string $url, array $headers, string $body, float $connectionTimeout, float $timeout): int
    {
        $ch = curl_init($url);

        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => array_map(static fn ($k, $v) => "{$k}: {$v}", array_keys($headers), $headers),
            CURLOPT_CONNECTTIMEOUT_MS => (int) ($connectionTimeout * 1000),
            CURLOPT_TIMEOUT_MS => (int) ($timeout * 1000),
            CURLOPT_NOSIGNAL => true,
        ]);

        curl_exec($ch);
        $error = curl_error($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);

        if ($status === 0) {
            throw new RuntimeException("EdgeWatch ingest request failed: {$error}");
        }

        return $status;
    }
}
