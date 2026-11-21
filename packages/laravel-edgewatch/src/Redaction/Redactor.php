<?php

namespace EdgeWatch\Laravel\Redaction;

/**
 * Header and payload redaction match laravel/nightwatch output ("[N bytes redacted]", auth scheme and cookie
 * names preserved). scrub() is an EdgeWatch addition that masks common PII inside free text.
 */
final class Redactor
{
    private const AUTH_SCHEMES = ['basic', 'bearer', 'concealed', 'digest', 'dpop', 'gnap', 'hoba', 'mutual', 'negotiate', 'oauth', 'privatetoken', 'scram-sha-1', 'scram-sha-256', 'vapid'];

    /**
     * @param  list<string>  $headers
     * @param  list<string>  $payloadFields
     */
    public function __construct(
        private array $headers = [],
        private array $payloadFields = [],
        private bool $scrubPii = true,
    ) {
        $this->headers = array_map('strtolower', $headers);
    }

    /**
     * @param  array<string, list<string|null>|string|null>  $headers
     * @return array<string, list<string>>
     */
    public function headers(array $headers): array
    {
        $result = [];

        foreach ($headers as $name => $values) {
            $lower = strtolower((string) $name);
            $values = array_map(static fn ($v): string => (string) $v, (array) $values);

            $result[$lower] = in_array($lower, $this->headers, true)
                ? array_map(fn (string $value): string => $this->redactHeaderValue($lower, $value), $values)
                : $values;
        }

        return $result;
    }

    /**
     * @param  array<array-key, mixed>  $payload
     * @return array<array-key, mixed>
     */
    public function payload(array $payload): array
    {
        $result = [];

        foreach ($payload as $key => $value) {
            $result[$key] = match (true) {
                is_array($value) => $this->payload($value),
                is_string($value) && in_array($key, $this->payloadFields, true) => self::bytes($value),
                default => $value,
            };
        }

        return $result;
    }

    public function scrub(string $text): string
    {
        if (! $this->scrubPii) {
            return $text;
        }

        $text = preg_replace('/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i', '[email]', $text) ?? $text;
        $text = preg_replace('/\b(?:\d[ -]?){12,18}\d\b/', '[card]', $text) ?? $text;
        $text = preg_replace('/\b(bearer)\s+[A-Za-z0-9._~+\/=-]{8,}/i', '$1 [redacted]', $text) ?? $text;

        return $text;
    }

    private function redactHeaderValue(string $header, string $value): string
    {
        if ($header === 'cookie') {
            $cookies = explode(';', $value);

            foreach ($cookies as $cookie) {
                if (! str_contains($cookie, '=')) {
                    return self::bytes($value);
                }
            }

            return implode('; ', array_map(static function (string $cookie): string {
                [$name, $val] = explode('=', $cookie, 2);

                return trim($name).'='.self::bytes($val);
            }, $cookies));
        }

        if (in_array($header, ['authorization', 'proxy-authorization'], true) && str_contains($value, ' ')) {
            [$scheme, $credentials] = explode(' ', $value, 2);

            if (in_array(strtolower($scheme), self::AUTH_SCHEMES, true)) {
                return $scheme.' '.self::bytes($credentials);
            }
        }

        return self::bytes($value);
    }

    private static function bytes(string $value): string
    {
        return '['.strlen($value).' bytes redacted]';
    }
}
