<?php

namespace EdgeWatch\Laravel;

use EdgeWatch\Laravel\Redaction\Redactor;
use EdgeWatch\Laravel\Sql\SqlNormalizer;
use EdgeWatch\Laravel\Support\Uuid7;
use EdgeWatch\Laravel\Transport\BufferedTransport;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;
use Throwable;

/**
 * Builds Nightwatch-shaped records (laravel/nightwatch v1.30.6 sensors) and writes them to the buffer.
 */
class EdgeWatch
{
    public string $traceId;

    public string $executionSource = 'request';

    public float $startedAt;

    public bool $sampled = true;

    private int $queries = 0;

    private int $exceptions = 0;

    private string $exceptionPreview = '';

    private ?string $routeAction = null;

    /**
     * @param  array<string, mixed>  $config
     */
    public function __construct(
        public readonly BufferedTransport $buffer,
        public readonly Redactor $redactor,
        public readonly Uuid7 $uuid,
        private array $config,
        private string $basePath = '',
        private string $phpVersion = PHP_VERSION,
        private string $laravelVersion = '',
    ) {
        $this->startedAt = defined('LARAVEL_START') ? (float) LARAVEL_START : (float) ($_SERVER['REQUEST_TIME_FLOAT'] ?? microtime(true));
        $this->traceId = $this->uuid->generate();
        $this->sampled = $this->roll((float) ($config['sampling']['requests'] ?? 1.0));
    }

    public function startExecution(string $source, ?float $startedAt = null): void
    {
        $this->buffer->flush();
        $this->executionSource = $source;
        $this->startedAt = $startedAt ?? microtime(true);
        $this->traceId = $this->uuid->generate();
        $this->queries = 0;
        $this->exceptions = 0;
        $this->exceptionPreview = '';
        $this->routeAction = null;
        $this->sampled = $this->roll((float) ($this->config['sampling']['requests'] ?? 1.0));
    }

    public function query(QueryExecuted $event): void
    {
        if (! $this->sampled || ($this->config['filtering']['ignore_queries'] ?? false)) {
            return;
        }

        $this->queries++;
        $connection = (string) ($event->connectionName ?? '');
        $normalized = SqlNormalizer::normalize($event->sql);
        $sql = ($this->config['redact_sql_literals'] ?? true) ? $normalized : $this->redactor->scrub($event->sql);
        [$file, $line] = $this->location();

        $this->buffer->write([
            'v' => 1,
            't' => 'query',
            'timestamp' => microtime(true) - ($event->time / 1000),
            ...$this->common(),
            '_group' => hash('xxh128', "{$connection},{$normalized}"),
            'sql' => $sql,
            'file' => $file,
            'line' => $line,
            'duration' => (int) round($event->time * 1000),
            'connection' => $connection,
            'connection_type' => (string) ($event->readWriteType ?? ''),
        ]);
    }

    public function exception(Throwable $e, bool $handled = false): void
    {
        if (! $this->roll((float) ($this->config['sampling']['exceptions'] ?? 1.0))) {
            return;
        }

        // Exceptions force capture of the execution, matching Nightwatch's default exception sampling.
        $this->sampled = true;
        $this->exceptions++;
        $message = $this->redactor->scrub($e->getMessage());

        if (! $handled) {
            $this->exceptionPreview = mb_substr($message, 0, 255);
        }

        $file = $this->relative($e->getFile());

        $this->buffer->write([
            'v' => 3,
            't' => 'exception',
            'timestamp' => microtime(true),
            ...$this->common(),
            '_group' => hash('xxh128', $e::class.','.$e->getCode().','.$file.','.$e->getLine()),
            'class' => $e::class,
            'file' => $file,
            'line' => $e->getLine(),
            'message' => $message,
            'code' => (string) $e->getCode(),
            'trace' => json_encode($this->trace($e), JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE),
            'handled' => $handled,
            'php_version' => $this->phpVersion,
            'laravel_version' => $this->laravelVersion,
        ]);
    }

    public function request(Request $request, Response $response): void
    {
        if (! $this->sampled) {
            return;
        }

        $route = $request->route();
        $methods = is_object($route) ? $route->methods() : [];
        sort($methods);
        $domain = is_object($route) ? (string) $route->getDomain() : '';
        $path = is_object($route) ? ($route->uri() === '/' ? '/' : '/'.$route->uri()) : '';
        $duration = (int) round((microtime(true) - $this->startedAt) * 1_000_000);
        $query = (string) $request->server->get('QUERY_STRING', '');
        $content = $response->getContent();

        $this->buffer->write([
            'v' => 1,
            't' => 'request',
            'timestamp' => $this->startedAt,
            'deploy' => (string) ($this->config['deployment'] ?? ''),
            'server' => $this->server(),
            '_group' => hash('xxh128', implode('|', $methods).",{$domain},{$path}"),
            'trace_id' => $this->traceId,
            'user' => $this->user(),
            'method' => $request->getMethod(),
            'url' => $request->getSchemeAndHttpHost().$request->getBaseUrl().$request->getPathInfo().($query !== '' ? "?{$query}" : ''),
            'route_name' => is_object($route) ? (string) $route->getName() : '',
            'route_methods' => $methods,
            'route_domain' => $domain,
            'route_path' => $path,
            'route_action' => $this->routeAction ?? (is_object($route) ? $route->getActionName() : ''),
            'ip' => (string) $request->ip(),
            'duration' => $duration,
            'status_code' => $response->getStatusCode(),
            'request_size' => strlen((string) $request->getContent()),
            'response_size' => is_string($content) ? strlen($content) : 0,
            'bootstrap' => 0,
            'before_middleware' => 0,
            'action' => $duration,
            'render' => 0,
            'after_middleware' => 0,
            'sending' => 0,
            'terminating' => 0,
            'exceptions' => $this->exceptions,
            'logs' => 0,
            'queries' => $this->queries,
            'lazy_loads' => 0,
            'jobs_queued' => 0,
            'mail' => 0,
            'notifications' => 0,
            'outgoing_requests' => 0,
            'files_read' => 0,
            'files_written' => 0,
            'cache_events' => 0,
            'hydrated_models' => 0,
            'peak_memory_usage' => memory_get_peak_usage(true),
            'exception_preview' => $this->exceptionPreview,
            'context' => '',
            'headers' => json_encode((object) $this->redactor->headers($request->headers->all()), JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE),
            'payload' => $this->payload($request, $response),
        ]);
    }

    public function flush(): void
    {
        $this->buffer->flush();
    }

    /**
     * @return array<string, mixed>
     */
    private function common(): array
    {
        return [
            'deploy' => (string) ($this->config['deployment'] ?? ''),
            'server' => $this->server(),
            'trace_id' => $this->traceId,
            'execution_source' => $this->executionSource,
            'execution_id' => $this->traceId,
            'execution_preview' => '',
            'execution_stage' => 'action',
            'user' => $this->user(),
        ];
    }

    private function payload(Request $request, Response $response): string
    {
        if ($response->getStatusCode() !== 500 || $request->request->count() === 0) {
            return '';
        }

        if (! ($this->config['capture_request_payload'] ?? false)) {
            return '{"_nightwatch_error":"NOT_ENABLED"}';
        }

        return (string) json_encode($this->redactor->payload($request->request->all()), JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    }

    private function server(): string
    {
        return (string) ($this->config['server'] ?? '') ?: (string) gethostname();
    }

    private function user(): string
    {
        try {
            if (function_exists('app') && app()->resolved('auth')) {
                return (string) (app('auth')->id() ?? '');
            }
        } catch (Throwable) {
            //
        }

        return '';
    }

    /**
     * @return array{0: string, 1: int}
     */
    private function location(): array
    {
        foreach (debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS, 50) as $frame) {
            $file = $frame['file'] ?? '';

            if ($file === '' || str_contains($file, DIRECTORY_SEPARATOR.'vendor'.DIRECTORY_SEPARATOR) || str_starts_with($file, __DIR__.DIRECTORY_SEPARATOR)) {
                continue;
            }

            return [$this->relative($file), (int) ($frame['line'] ?? 0)];
        }

        return ['', 0];
    }

    private function relative(string $file): string
    {
        return $this->basePath !== '' && str_starts_with($file, $this->basePath)
            ? ltrim(substr($file, strlen($this->basePath)), DIRECTORY_SEPARATOR)
            : $file;
    }

    /**
     * @return list<array{file: string, source: string, code: null}>
     */
    private function trace(Throwable $e): array
    {
        $frames = [['file' => $this->relative($e->getFile()).':'.$e->getLine(), 'source' => '', 'code' => null]];

        foreach (array_slice($e->getTrace(), 0, 50) as $frame) {
            $frames[] = [
                'file' => isset($frame['file']) ? $this->relative($frame['file']).(isset($frame['line']) ? ':'.$frame['line'] : '') : '[internal function]',
                'source' => ($frame['class'] ?? '').($frame['type'] ?? '').$frame['function'].'()',
                'code' => null,
            ];
        }

        return $frames;
    }

    private function roll(float $rate): bool
    {
        return $rate >= 1.0 || ($rate > 0.0 && mt_rand() / mt_getrandmax() < $rate);
    }
}
