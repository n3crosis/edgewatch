<?php

declare(strict_types=1);

namespace EdgeWatch\Laravel\Support;

/**
 * Zero-config transport detection, shared by the service provider and `edgewatch:test`.
 *
 * - `http(s)://...`, or a hostname with a path or without a port (`ingest.example.com`) → direct HTTPS.
 * - `host:port` (`127.0.0.1:2407`, `agent:2407`) or nothing set → TCP to a local Nightwatch agent.
 * - An HTTP URL with no path gets `/api/ingest`, the ingest route of the Workers and the Bun server.
 * - HTTP without a token is turned off: every request would be rejected with 401.
 */
final class IngestTarget
{
    public const DEFAULT_AGENT = '127.0.0.1:2407';

    public const INGEST_PATH = '/api/ingest';

    /** @return array{transport: 'http'|'agent'|'null', uri: string, reason: string} */
    public static function resolve(string $transport, ?string $uri, ?string $token): array
    {
        $uri = trim((string) $uri);
        $transport = strtolower(trim($transport));
        $explicit = $transport !== '' && $transport !== 'auto';

        if ($uri === '') {
            $uri = self::DEFAULT_AGENT;
        }

        if (! $explicit) {
            $transport = self::looksLikeHttp($uri) ? 'http' : 'agent';
        }

        if (in_array($transport, ['null', 'none', 'off'], true)) {
            return ['transport' => 'null', 'uri' => $uri, 'reason' => "EDGEWATCH_TRANSPORT={$transport}"];
        }

        if (! in_array($transport, ['http', 'agent'], true)) {
            return ['transport' => 'null', 'uri' => $uri, 'reason' => "unknown EDGEWATCH_TRANSPORT \"{$transport}\" (use auto, http or agent)"];
        }

        if ($transport === 'http') {
            $uri = self::httpUrl($uri);

            if ($token === null || trim($token) === '') {
                return ['transport' => 'null', 'uri' => $uri, 'reason' => 'EDGEWATCH_TOKEN (or NIGHTWATCH_TOKEN) is not set'];
            }
        }

        $reason = $explicit ? "EDGEWATCH_TRANSPORT={$transport}" : ($transport === 'http' ? 'auto: ingest URL' : 'auto: local agent address');

        return ['transport' => $transport, 'uri' => $uri, 'reason' => $reason];
    }

    public static function looksLikeHttp(string $uri): bool
    {
        if (preg_match('#^https?://#i', $uri) === 1) {
            return true;
        }

        if (str_contains($uri, '://')) {
            return false;
        }

        $host = explode('/', $uri, 2)[0];

        if (str_contains($uri, '/')) {
            return true;
        }

        // host:port is an agent address; a bare dotted hostname is a web endpoint.
        return preg_match('/:\d+$/', $host) !== 1 && str_contains($host, '.') && filter_var($host, FILTER_VALIDATE_IP) === false;
    }

    public static function httpUrl(string $uri): string
    {
        if (preg_match('#^https?://#i', $uri) !== 1) {
            $uri = 'https://'.$uri;
        }

        $path = (string) parse_url($uri, PHP_URL_PATH);

        if ($path === '' || $path === '/') {
            $query = parse_url($uri, PHP_URL_QUERY);
            $base = preg_replace('#[/?].*$#', '', substr($uri, strpos($uri, '//') + 2));
            $uri = substr($uri, 0, strpos($uri, '//') + 2).$base.self::INGEST_PATH.(is_string($query) ? "?{$query}" : '');
        }

        return $uri;
    }

    /** The URI without credentials or query string, safe to print. */
    public static function display(string $uri): string
    {
        $parts = parse_url($uri);

        if ($parts === false || ! isset($parts['host'])) {
            return $uri;
        }

        return (isset($parts['scheme']) ? "{$parts['scheme']}://" : '').$parts['host'].(isset($parts['port']) ? ":{$parts['port']}" : '').($parts['path'] ?? '');
    }
}
