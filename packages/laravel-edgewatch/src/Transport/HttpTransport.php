<?php

declare(strict_types=1);

namespace EdgeWatch\Laravel\Transport;

use Closure;
use RuntimeException;

/**
 * Sends records straight to an EdgeWatch ingest endpoint using the Nightwatch agent -> cloud format
 * (gzip'd {"records": [...]}, Bearer auth), so no local agent process is needed.
 *
 * Honors the agent's "stop" contract: a 429 or any response with {"stop": true} pauses sending for
 * `refresh_in` seconds (or Retry-After, default 60); records produced while paused are dropped, like the agent does.
 */
final class HttpTransport implements Transport
{
    public const VERSION = '1.0.0';

    /**
     * @param  (Closure(string $url, array<string, string> $headers, string $body, float $connectionTimeout, float $timeout): (int|array{0: int, 1: string, 2: array<string, string>}))|null  $sender
     */
    public function __construct(
        private string $url,
        private ?string $token,
        private string $server,
        private float $connectionTimeout = 0.5,
        private float $timeout = 0.5,
        private ?Closure $sender = null,
        private Backoff $backoff = new Backoff,
        private ?string $projectId = null,
    ) {
        $this->sender ??= self::curlSender(...);
        $this->projectId = $projectId === null || trim($projectId) === '' ? null : trim($projectId);
    }

    public function backoff(): Backoff
    {
        return $this->backoff;
    }

    public function send(array $records): void
    {
        if ($records === [] || $this->backoff->isPaused()) {
            return;
        }

        $json = json_encode(['records' => $records], JSON_INVALID_UTF8_SUBSTITUTE | JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $body = gzencode($json);

        if ($body === false) {
            throw new RuntimeException('Unable to compress EdgeWatch payload.');
        }

        $headers = $this->headers();

        $result = ($this->sender)($this->url, $headers, $body, $this->connectionTimeout, $this->timeout);

        [$status, $responseBody, $responseHeaders] = is_int($result) ? [$result, '', []] : $result;
        $json = json_decode($responseBody, true);
        $json = is_array($json) ? $json : [];

        if ($status === 429 || ($json['stop'] ?? false) === true) {
            $retryAfter = $responseHeaders['retry-after'] ?? null;
            $seconds = (int) ($json['refresh_in'] ?? (is_numeric($retryAfter) ? $retryAfter : 60));
            $this->backoff->pause($seconds, (string) ($json['message'] ?? "HTTP {$status}"));

            if ($status === 429) {
                throw new RuntimeException("EdgeWatch ingest asked to stop for {$seconds}s: ".($json['message'] ?? 'HTTP 429'));
            }
        }

        if ($status < 200 || $status >= 300) {
            throw new RuntimeException("EdgeWatch ingest responded with HTTP {$status}");
        }
    }

    /**
     * Sends an empty batch with the normal headers: checks the route, TLS, token and project tag without sending telemetry.
     * Ignores and does not touch the backoff state.
     *
     * @return array{status: int, body: string, ms: float, error: string|null}
     */
    public function probe(): array
    {
        $started = hrtime(true);

        try {
            $result = ($this->sender)($this->url, $this->headers(), (string) gzencode('{"records":[]}'), $this->connectionTimeout, $this->timeout);
            [$status, $body] = is_int($result) ? [$result, ''] : [$result[0], $result[1]];
            $error = null;
        } catch (\Throwable $e) {
            [$status, $body, $error] = [0, '', $e->getMessage()];
        }

        return ['status' => $status, 'body' => $body, 'ms' => (hrtime(true) - $started) / 1e6, 'error' => $error];
    }

    /** @return array<string, string> */
    private function headers(): array
    {
        $headers = [
            'accept' => 'application/json',
            'authorization' => 'Bearer '.($this->token ?? ''),
            'content-encoding' => 'gzip',
            'content-type' => 'application/json',
            'nightwatch-server' => $this->server,
            'user-agent' => 'EdgeWatchLaravel/'.self::VERSION,
        ];

        if ($this->projectId !== null) {
            $headers['x-edgewatch-project'] = $this->projectId;
        }

        return $headers;
    }

    /**
     * @param  array<string, string>  $headers
     * @return array{0: int, 1: string, 2: array<string, string>}
     */
    private static function curlSender(string $url, array $headers, string $body, float $connectionTimeout, float $timeout): array
    {
        $ch = curl_init($url);
        $responseHeaders = [];

        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => array_map(static fn ($k, $v) => "{$k}: {$v}", array_keys($headers), $headers),
            CURLOPT_CONNECTTIMEOUT_MS => (int) ($connectionTimeout * 1000),
            CURLOPT_TIMEOUT_MS => (int) ($timeout * 1000),
            CURLOPT_NOSIGNAL => true,
            CURLOPT_HEADERFUNCTION => static function ($ch, string $line) use (&$responseHeaders): int {
                if (str_contains($line, ':')) {
                    [$name, $value] = explode(':', $line, 2);
                    $responseHeaders[strtolower(trim($name))] = trim($value);
                }

                return strlen($line);
            },
        ]);

        $response = curl_exec($ch);
        $error = curl_error($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);

        if ($status === 0) {
            throw new RuntimeException("EdgeWatch ingest request failed: {$error}");
        }

        return [$status, is_string($response) ? $response : '', $responseHeaders];
    }
}
