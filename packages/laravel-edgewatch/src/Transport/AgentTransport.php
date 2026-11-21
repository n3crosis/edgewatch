<?php

namespace EdgeWatch\Laravel\Transport;

use Closure;
use RuntimeException;

/**
 * Speaks the laravel/nightwatch app -> agent TCP protocol (v1.30.6, src/Payload.php + src/Ingest.php):
 * "<length>:v1:<tokenHash>:<json>" and expects the agent to answer "2:OK".
 */
final class AgentTransport implements Transport
{
    public const PAYLOAD_VERSION = 'v1';

    private string $tokenHash;

    /**
     * @param  (Closure(string $address, float $timeout): resource)|null  $streamFactory
     */
    public function __construct(
        private string $address,
        ?string $token,
        private float $connectionTimeout = 0.5,
        private float $timeout = 0.5,
        private ?Closure $streamFactory = null,
    ) {
        $this->tokenHash = self::tokenHash($token ?? '');
        $this->address = str_contains($address, '://') ? $address : "tcp://{$address}";
    }

    public static function tokenHash(string $token): string
    {
        return substr(hash('xxh128', $token), 0, 7);
    }

    public static function frame(string $body, string $tokenHash): string
    {
        $length = strlen(self::PAYLOAD_VERSION) + 1 + strlen($tokenHash) + 1 + strlen($body);

        return $length.':'.self::PAYLOAD_VERSION.':'.$tokenHash.':'.$body;
    }

    public function send(array $records): void
    {
        if ($records === []) {
            return;
        }

        $this->transmit(json_encode($records, JSON_INVALID_UTF8_SUBSTITUTE | JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    }

    public function ping(): void
    {
        $this->transmit('PING');
    }

    private function transmit(string $body): void
    {
        $stream = $this->streamFactory !== null
            ? ($this->streamFactory)($this->address, $this->connectionTimeout)
            : $this->connect();

        try {
            $seconds = (int) $this->timeout;
            stream_set_timeout($stream, $seconds, (int) (($this->timeout - $seconds) * 1_000_000));

            $payload = self::frame($body, $this->tokenHash);

            while ($payload !== '') {
                $written = fwrite($stream, $payload);

                if ($written === false || $written === 0) {
                    throw new RuntimeException('Unable to write to the EdgeWatch agent stream.');
                }

                $payload = substr($payload, $written);
            }

            $response = '';
            $attempts = 0;

            while (strlen($response) < 4 && ! feof($stream) && $attempts++ < 5) {
                $chunk = fread($stream, 4 - strlen($response));

                if ($chunk === false) {
                    break;
                }

                $response .= $chunk;
            }

            if ($response !== '2:OK') {
                throw new RuntimeException("Unexpected response from agent [{$response}]");
            }
        } finally {
            if (is_resource($stream)) {
                fclose($stream);
            }
        }
    }

    /**
     * @return resource
     */
    private function connect()
    {
        set_error_handler(static fn (): bool => true);

        try {
            $stream = stream_socket_client($this->address, $code, $message, $this->connectionTimeout);
        } finally {
            restore_error_handler();
        }

        if ($stream === false) {
            throw new RuntimeException("Failed connecting to the agent: {$message} [{$code}]");
        }

        return $stream;
    }
}
