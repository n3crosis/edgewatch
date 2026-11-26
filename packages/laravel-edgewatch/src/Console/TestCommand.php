<?php

declare(strict_types=1);

namespace EdgeWatch\Laravel\Console;

use EdgeWatch\Laravel\Support\IngestTarget;
use EdgeWatch\Laravel\Transport\HttpTransport;
use Illuminate\Console\Command;

/**
 * Connectivity check only: HTTP sends an empty batch (`{"records":[]}`) with the normal headers, so the token, project tag,
 * TLS and route are all exercised without sending telemetry; the agent transport only opens and closes a TCP connection.
 */
final class TestCommand extends Command
{
    public function __construct()
    {
        // Command declares these untyped, so they are set here instead of redeclared.
        $this->signature = 'edgewatch:test {--timeout=5 : Seconds to wait for the endpoint}';
        $this->description = 'Check the configured EdgeWatch ingest endpoint (sends no telemetry)';

        parent::__construct();
    }

    public function handle(): int
    {
        $config = (array) $this->laravel['config']->get('edgewatch', []);
        $token = is_string($config['token'] ?? null) ? $config['token'] : null;
        $ingest = (array) ($config['ingest'] ?? []);
        $target = IngestTarget::resolve((string) ($ingest['transport'] ?? 'auto'), (string) ($ingest['uri'] ?? ''), $token);
        $timeout = max(0.1, (float) $this->option('timeout'));

        if (! filter_var($config['enabled'] ?? true, FILTER_VALIDATE_BOOL)) {
            $this->warn('EdgeWatch is disabled (EDGEWATCH_ENABLED=false); nothing is sent until it is enabled. Checking the endpoint anyway.');
        }

        $this->line("Transport: {$target['transport']} ({$target['reason']})");
        $this->line('Endpoint:  '.IngestTarget::display($target['uri']));

        if ($target['transport'] === 'null') {
            $this->error("FAIL  not configured: {$target['reason']}");

            return self::FAILURE;
        }

        return $target['transport'] === 'http'
            ? $this->http($target['uri'], (string) $token, $config, $timeout)
            : $this->agent($target['uri'], $timeout);
    }

    /** @param  array<string, mixed>  $config */
    private function http(string $url, string $token, array $config, float $timeout): int
    {
        $transport = new HttpTransport(
            url: $url,
            token: $token,
            server: (string) (($config['server'] ?? null) ?: gethostname()),
            connectionTimeout: $timeout,
            timeout: $timeout,
            projectId: is_string($config['project_id'] ?? null) ? $config['project_id'] : null,
        );
        $probe = $transport->probe();
        $ms = (int) round($probe['ms']);

        if ($probe['status'] === 0) {
            $this->error("FAIL  no HTTP response after {$ms} ms: {$probe['error']}");

            return self::FAILURE;
        }

        $result = "HTTP {$probe['status']} in {$ms} ms";

        if ($probe['status'] >= 200 && $probe['status'] < 300) {
            $this->info("PASS  {$result} (empty batch, no telemetry sent)");

            return self::SUCCESS;
        }

        $json = json_decode($probe['body'], true);
        $message = is_array($json) ? ($json['error']['message'] ?? $json['message'] ?? null) : null;
        $this->error("FAIL  {$result}");

        if (is_string($message) && $message !== '') {
            $this->line("      Server said: {$message}");
        }

        if (($hint = self::hint($probe['status'])) !== null) {
            $this->line("      {$hint}");
        }

        return self::FAILURE;
    }

    private function agent(string $address, float $timeout): int
    {
        $started = hrtime(true);
        $socket = @stream_socket_client(str_contains($address, '://') ? $address : "tcp://{$address}", $errno, $error, $timeout);
        $ms = (int) round((hrtime(true) - $started) / 1e6);

        if ($socket === false) {
            $this->error("FAIL  could not connect to the agent after {$ms} ms: {$error} ({$errno})");
            $this->line('      Start the agent (php artisan nightwatch:agent), or set EDGEWATCH_INGEST_URI to your EdgeWatch https:// URL.');

            return self::FAILURE;
        }

        fclose($socket);
        $this->info("PASS  agent accepted a TCP connection in {$ms} ms (agent transport has no HTTP status; nothing was sent)");

        return self::SUCCESS;
    }

    private static function hint(int $status): ?string
    {
        return match (true) {
            $status === 401 => 'The token was rejected: EDGEWATCH_TOKEN must be an ingest key (or agent token) for this EdgeWatch.',
            $status === 403 => 'Forbidden: the key cannot write to the EDGEWATCH_PROJECT_ID project.',
            $status === 404 || $status === 405 => 'No ingest route at this URL: EDGEWATCH_INGEST_URI should end in /api/ingest.',
            $status === 429 => 'Rate limited or over the daily quota: telemetry pauses until it resets.',
            $status >= 500 => 'The ingest service is failing: check GET /healthz on it.',
            default => null,
        };
    }
}
