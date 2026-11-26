<?php

declare(strict_types=1);

namespace EdgeWatch\Laravel;

use Closure;
use DateTimeZone;
use EdgeWatch\Laravel\Redaction\Redactor;
use EdgeWatch\Laravel\Sql\SqlNormalizer;
use EdgeWatch\Laravel\Support\Uuid7;
use EdgeWatch\Laravel\Transport\BufferedTransport;
use Illuminate\Cache\Events\CacheEvent;
use Illuminate\Cache\Events\KeyWriteFailed;
use Illuminate\Cache\Events\KeyWritten;
use Illuminate\Console\Application as ConsoleApplication;
use Illuminate\Console\Scheduling\CallbackEvent;
use Illuminate\Console\Scheduling\Event as SchedulingEvent;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Contracts\Queue\Job;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Http\Request;
use Illuminate\Mail\Events\MessageSending;
use Illuminate\Mail\Events\MessageSent;
use Illuminate\Notifications\Events\NotificationSent;
use Illuminate\Queue\Events\JobQueued;
use Illuminate\Support\Str;
use Monolog\LogRecord;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;
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

    private int $cacheEvents = 0;

    /** @var array<string, float> start time of in-flight cache operations, by "store,key" */
    private array $cacheStarts = [];

    private int $jobsQueued = 0;

    private int $outgoingRequests = 0;

    private int $mail = 0;

    private int $notifications = 0;

    private ?float $mailStartedAt = null;

    private bool $schedulingTask = false;

    private int $logs = 0;

    private int $lazyLoads = 0;

    private bool $writingLog = false;

    /** The failure of the last scheduled task: already recorded in its trace, so the scheduler's later report() is skipped. */
    private ?Throwable $scheduledTaskFailure = null;

    /** Scheduler loop commands are not recorded: each task they run gets its own trace instead, like Nightwatch. */
    private const SCHEDULER_COMMANDS = ['schedule:run', 'schedule:work', 'schedule:finish', 'vapor:schedule'];

    private ?float $notificationStartedAt = null;

    /** @var array{name: string, command: string, class: string}|null */
    private ?array $command = null;

    /** Open job attempts, innermost last (a sync job can run inside a queued one). @var list<array{started_at: float, nested: bool, job: Job, connection: string}> */
    private array $jobs = [];

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
        $this->cacheEvents = 0;
        $this->cacheStarts = [];
        $this->jobsQueued = 0;
        $this->outgoingRequests = 0;
        $this->mail = 0;
        $this->notifications = 0;
        $this->logs = 0;
        $this->lazyLoads = 0;
        $this->command = null;
        $this->jobs = [];
        $this->sampled = $this->roll((float) ($this->config['sampling'][in_array($source, ['command', 'schedule'], true) ? 'commands' : 'requests'] ?? 1.0));
    }

    public function isIgnoredCommand(?string $name): bool
    {
        return $name === null || $name === '' || $name === 'edgewatch:test' || in_array($name, self::SCHEDULER_COMMANDS, true)
            || in_array($name, (array) ($this->config['filtering']['ignore_commands'] ?? []), true);
    }

    /** Current trace ID, e.g. for <meta name="edgewatch-trace-id"> so @edgewatch/browser links browser errors to it. */
    public function traceId(): ?string
    {
        return $this->traceId ?? null;
    }

    /**
     * Stop recording until the next execution starts: used for ignored long-running commands (queue:work, horizon, ...)
     * and between queue jobs, so worker-loop cache/queries are not attached to a stale trace.
     */
    public function idle(): void
    {
        $this->buffer->flush();
        $this->sampled = false;
    }

    public function commandStarting(string $name, string $command, string $class = ''): void
    {
        $this->startExecution('command');
        $this->command = ['name' => $name, 'command' => $command, 'class' => $class];
    }

    public function commandFinished(int $exitCode): void
    {
        if ($this->command === null) {
            return;
        }

        $command = $this->command;
        $this->command = null;

        if ($this->sampled) {
            $duration = $this->elapsed($this->startedAt);
            $this->buffer->write([
                'v' => 1,
                't' => 'command',
                'timestamp' => $this->startedAt,
                ...$this->common(),
                '_group' => hash('xxh128', $command['name']),
                'class' => $command['class'],
                'name' => $command['name'],
                'command' => $this->redactor->scrub($command['command']),
                'exit_code' => $exitCode,
                'duration' => $duration,
                'bootstrap' => 0,
                'action' => $duration,
                'terminating' => 0,
                ...$this->counters(),
            ]);
        }

        $this->buffer->flush();
    }

    /**
     * Jobs on the sync connection run inside the current execution (as Nightwatch does); queued jobs start their own trace.
     */
    public function jobStarting(Job $job, string $connection): void
    {
        $nested = $connection === 'sync';

        if (! $nested) {
            // A queued attempt still open here never finished (the worker survived a fatal error mid-job): close it as released.
            $this->closeOpenJobs('released');
            $this->startExecution('job');
        }

        $this->jobs[] = ['started_at' => microtime(true), 'nested' => $nested, 'job' => $job, 'connection' => $connection];
    }

    public function jobFinished(Job $job, string $connection, string $status): void
    {
        $index = null;
        $id = self::read(static fn () => $job->uuid() ?? $job->getJobId(), null);
        foreach ($this->jobs as $i => $open) {
            if ($open['job'] === $job || ($id !== null && $id !== '' && self::read(static fn () => $open['job']->uuid() ?? $open['job']->getJobId(), null) === $id)) {
                $index = $i;
            }
        }

        if ($index === null) {
            // JobProcessed after JobFailed (attempts exhausted before handle() ran) has nothing left to close.
            if ($status !== 'failed') {
                return;
            }

            // Failed without a JobProcessing we saw: record a zero-length attempt in its own trace rather than drop it.
            $state = ['started_at' => microtime(true), 'nested' => $connection === 'sync', 'job' => $job, 'connection' => $connection];

            if (! $state['nested']) {
                $this->startExecution('job');
            }
        } else {
            $state = $this->jobs[$index];
            array_splice($this->jobs, $index, 1);
        }

        $this->recordAttempt($state, $status);

        if (! $state['nested']) {
            $this->idle();
        }
    }

    /**
     * WorkerStopping: the worker exits without running terminating callbacks (timeout, memory limit, queue:restart).
     * An attempt still open is recorded as released (the queue retries it) and the buffer is sent now.
     */
    public function workerStopping(): void
    {
        $this->closeOpenJobs('released');
        $this->flush();
    }

    private function closeOpenJobs(string $status): void
    {
        while (($state = array_pop($this->jobs)) !== null) {
            $this->recordAttempt($state, $status);
        }
    }

    /** @param  array{started_at: float, nested: bool, job: Job, connection: string}  $state */
    private function recordAttempt(array $state, string $status): void
    {
        if (! $this->sampled) {
            return;
        }

        $job = $state['job'];
        // A payload that cannot be decoded must not cost the attempt record: every read falls back.
        $name = (string) (self::read(static fn () => $job->resolveName(), null) ?: self::read(static fn () => $job->getName(), null) ?: 'unknown');

        $this->buffer->write([
            'v' => 1,
            't' => 'job-attempt',
            'timestamp' => $state['started_at'],
            ...$this->common(),
            '_group' => hash('xxh128', $name),
            'job_id' => (string) self::read(static fn () => $job->uuid() ?? $job->getJobId(), ''),
            'attempt_id' => $this->uuid->generate(),
            'attempt' => (int) self::read(static fn () => $job->attempts(), 1),
            'name' => $name,
            'connection' => $state['connection'],
            'queue' => (string) self::read(static fn () => $job->getQueue(), ''),
            'status' => $status,
            'duration' => $this->elapsed($state['started_at']),
            ...($state['nested'] ? [] : $this->counters()),
        ]);
    }

    private static function read(callable $read, mixed $fallback): mixed
    {
        try {
            return $read() ?? $fallback;
        } catch (Throwable) {
            return $fallback;
        }
    }

    public function jobQueued(JobQueued $event): void
    {
        $this->jobsQueued++;

        if (! $this->sampled) {
            return;
        }

        $payload = is_string($event->payload ?? null) ? (array) json_decode($event->payload, true) : [];
        $name = (string) ($payload['displayName'] ?? (is_object($event->job) ? $event->job::class : (string) $event->job));

        $this->buffer->write([
            'v' => 1,
            't' => 'queued-job',
            'timestamp' => microtime(true),
            ...$this->common(),
            '_group' => hash('xxh128', $name),
            'job_id' => (string) ($payload['uuid'] ?? $event->id ?? ''),
            'name' => $name,
            'connection' => (string) $event->connectionName,
            'queue' => (string) ($event->queue ?: (function_exists('config') ? config("queue.connections.{$event->connectionName}.queue", '') : '')),
            'duration' => 0,
        ]);
    }

    /** RetrievingKey / WritingKey / ForgettingKey: remember when the operation started so its duration can be measured. */
    public function cacheStarting(CacheEvent $event): void
    {
        if ($this->sampled) {
            $this->cacheStarts[$event->storeName.','.$event->key] = microtime(true);
        }
    }

    /**
     * @param  'hit'|'miss'|'write'|'delete'|'write-failure'|'delete-failure'  $type
     */
    public function cacheEvent(string $type, CacheEvent $event): void
    {
        $id = $event->storeName.','.$event->key;
        $startedAt = $this->cacheStarts[$id] ?? null;
        unset($this->cacheStarts[$id]);

        if (! $this->sampled || ($this->config['filtering']['ignore_cache_events'] ?? false)) {
            return;
        }

        $this->cacheEvents++;
        $store = (string) ($event->storeName ?? '');
        $key = $this->redactor->scrub((string) $event->key);

        $this->buffer->write([
            'v' => 1,
            't' => 'cache-event',
            'timestamp' => $startedAt ?? microtime(true),
            ...$this->common(),
            '_group' => hash('xxh128', "{$store},{$key}"),
            'store' => $store,
            'key' => $key,
            'type' => $type,
            'duration' => $startedAt === null ? 0 : $this->elapsed($startedAt),
            'ttl' => $event instanceof KeyWritten || $event instanceof KeyWriteFailed ? (int) ($event->seconds ?? 0) : 0,
        ]);
    }

    public function log(LogRecord $record): void
    {
        // EdgeWatch's own transmission errors are logged too: never feed them back into the buffer.
        if (! $this->sampled || $this->writingLog || str_starts_with($record->message, '[EdgeWatch]')) {
            return;
        }

        $this->writingLog = true;

        try {
            $this->logs++;
            $json = static fn (array $data): string => (string) json_encode((object) $data, JSON_INVALID_UTF8_SUBSTITUTE | JSON_PRESERVE_ZERO_FRACTION | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR);

            $this->buffer->write([
                'v' => 1,
                't' => 'log',
                'timestamp' => (float) $record->datetime->format('U.u'),
                ...$this->common(),
                'level' => $record->level->toPsrLogLevel(),
                'message' => $this->redactor->scrub($record->message),
                'context' => $this->redactor->scrub($json($record->context)),
                'extra' => $this->redactor->scrub($json($record->extra)),
            ]);
        } finally {
            $this->writingLog = false;
        }
    }

    public function scheduledTaskStarting(): void
    {
        $this->startExecution('schedule');
        $this->schedulingTask = true;
        $this->scheduledTaskFailure = null;
    }

    /**
     * @param  'processed'|'failed'|'skipped'  $status
     */
    public function scheduledTaskFinished(SchedulingEvent $task, string $status, ?Throwable $exception = null): void
    {
        // Skipped tasks never start; background tasks finish in a separate `schedule:finish` process.
        if (! $this->schedulingTask) {
            $this->startExecution('schedule');
        }

        $this->schedulingTask = false;

        if ($exception !== null) {
            $this->exception($exception);
            $this->scheduledTaskFailure = $exception;
        }

        if ($this->sampled) {
            $name = $this->scheduledTaskName($task);
            $timezone = $task->timezone instanceof DateTimeZone ? $task->timezone->getName() : (string) ($task->timezone ?? '');
            $repeatSeconds = (int) ($task->repeatSeconds ?? 0);
            $duration = $status === 'skipped' ? 0 : $this->elapsed($this->startedAt);

            $this->buffer->write([
                'v' => 1,
                't' => 'scheduled-task',
                'timestamp' => $this->startedAt,
                ...$this->common(),
                '_group' => hash('xxh128', implode(',', array_filter([$name, $task->expression, $timezone, $repeatSeconds ?: null]))),
                'name' => $name,
                'cron' => $task->expression,
                'timezone' => $timezone,
                'repeat_seconds' => $repeatSeconds,
                'without_overlapping' => $task->withoutOverlapping,
                'on_one_server' => $task->onOneServer,
                'run_in_background' => $task->runInBackground,
                'even_in_maintenance_mode' => $task->evenInMaintenanceMode,
                'status' => $status,
                'duration' => $duration,
                ...$this->counters(),
            ]);
        }

        $this->idle();
    }

    /** Same naming as Nightwatch: the artisan/shell command, the description, or the closure's location. */
    private function scheduledTaskName(SchedulingEvent $task): string
    {
        if (! $task instanceof CallbackEvent) {
            return str_replace(
                [ConsoleApplication::phpBinary(), ConsoleApplication::artisanBinary()],
                ['php', (string) preg_replace("#['\"]#", '', ConsoleApplication::artisanBinary())],
                (string) $task->command,
            );
        }

        $name = $task->getSummaryForDisplay();

        if (! in_array($name, ['Closure', 'Callback'], true)) {
            return $name;
        }

        $callback = (new \ReflectionProperty($task, 'callback'))->getValue($task);

        return match (true) {
            $callback instanceof Closure => sprintf('Closure at: %s:%s', $this->relative((string) (new \ReflectionFunction($callback))->getFileName()), (new \ReflectionFunction($callback))->getStartLine()),
            is_string($callback) => $callback,
            is_array($callback) => is_string($callback[0]) ? $callback[0] : $callback[0]::class,
            default => $callback::class,
        };
    }

    public function mailSending(MessageSending $event): void
    {
        if (! isset($event->data['__laravel_notification'])) {
            $this->mailStartedAt = microtime(true);
        }
    }

    /** Mail sent by a notification's mail channel is reported as the notification, like Nightwatch. */
    public function mailSent(MessageSent $event): void
    {
        if (isset($event->data['__laravel_notification'])) {
            return;
        }

        $startedAt = $this->mailStartedAt;
        $this->mailStartedAt = null;

        if (! $this->sampled || ($this->config['filtering']['ignore_mail'] ?? false)) {
            return;
        }

        $this->mail++;
        $message = $event->message;
        $class = (string) ($event->data['__laravel_mailable'] ?? '');
        $count = fn (string $method): int => method_exists($message, $method) ? count($message->{$method}()) : 0;

        $this->buffer->write([
            'v' => 1,
            't' => 'mail',
            'timestamp' => $startedAt ?? microtime(true),
            ...$this->common(),
            '_group' => hash('xxh128', $class),
            'mailer' => (string) ($event->data['mailer'] ?? ''),
            'class' => $class,
            'subject' => $this->redactor->scrub((string) (method_exists($message, 'getSubject') ? $message->getSubject() : '')),
            'to' => $count('getTo'),
            'cc' => $count('getCc'),
            'bcc' => $count('getBcc'),
            'attachments' => $count('getAttachments'),
            'duration' => $startedAt === null ? 0 : $this->elapsed($startedAt),
            'failed' => false,
        ]);
    }

    public function notificationSending(): void
    {
        $this->notificationStartedAt = microtime(true);
    }

    public function notificationSent(NotificationSent $event): void
    {
        $startedAt = $this->notificationStartedAt;
        $this->notificationStartedAt = null;

        if (! $this->sampled || ($this->config['filtering']['ignore_notifications'] ?? false)) {
            return;
        }

        $this->notifications++;
        $class = Str::before($event->notification::class, "\0");

        $this->buffer->write([
            'v' => 1,
            't' => 'notification',
            'timestamp' => $startedAt ?? microtime(true),
            ...$this->common(),
            '_group' => hash('xxh128', $class),
            'channel' => (string) $event->channel,
            'class' => $class,
            'duration' => $startedAt === null ? 0 : $this->elapsed($startedAt),
            'failed' => false,
        ]);
    }

    /** Guzzle middleware for Laravel's Http client (registered as a global middleware). */
    public function guzzleMiddleware(): callable
    {
        return fn (callable $handler): callable => function (RequestInterface $request, array $options) use ($handler) {
            $startedAt = microtime(true);

            return $handler($request, $options)->then(function (ResponseInterface $response) use ($request, $startedAt): ResponseInterface {
                rescue(fn () => $this->outgoingRequest($startedAt, microtime(true), $request, $response), report: false);

                return $response;
            });
        };
    }

    public function outgoingRequest(float $startedAt, float $endedAt, RequestInterface $request, ResponseInterface $response): void
    {
        if (! $this->sampled || ($this->config['filtering']['ignore_outgoing_requests'] ?? false)) {
            return;
        }

        $this->outgoingRequests++;
        $uri = $request->getUri();

        $this->buffer->write([
            'v' => 1,
            't' => 'outgoing-request',
            'timestamp' => $startedAt,
            ...$this->common(),
            '_group' => hash('xxh128', $uri->getHost()),
            'host' => $uri->getHost(),
            'method' => $request->getMethod(),
            'url' => $this->redactor->scrub((string) $uri->withQuery('')->withFragment('')),
            'duration' => (int) round(($endedAt - $startedAt) * 1_000_000),
            'request_size' => $request->getBody()->getSize() ?? 0,
            'response_size' => $response->getBody()->getSize() ?? (int) $response->getHeaderLine('content-length'),
            'status_code' => $response->getStatusCode(),
        ]);
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
        [$file, $line, $lazy] = $this->location();

        if ($lazy) {
            $this->lazyLoads++;
        }

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
        if ($e === $this->scheduledTaskFailure) {
            return;
        }

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
            'environment' => (string) ($this->config['environment'] ?? ''),
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
            'logs' => $this->logs,
            'queries' => $this->queries,
            'lazy_loads' => $this->lazyLoads,
            'jobs_queued' => $this->jobsQueued,
            'mail' => $this->mail,
            'notifications' => $this->notifications,
            'outgoing_requests' => $this->outgoingRequests,
            'files_read' => 0,
            'files_written' => 0,
            'cache_events' => $this->cacheEvents,
            'hydrated_models' => 0,
            'peak_memory_usage' => memory_get_peak_usage(true),
            'exception_preview' => $this->exceptionPreview,
            'context' => '',
            'headers' => json_encode((object) $this->redactor->headers($request->headers->all()), JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE),
            'payload' => $this->payload($request, $response),
        ]);

        $this->recordUser();
    }

    public function flush(): void
    {
        $this->buffer->flush();
    }

    /**
     * Per-execution counters shared by request, command and job-attempt records.
     *
     * @return array<string, int|string>
     */
    private function counters(): array
    {
        return [
            'exceptions' => $this->exceptions,
            'logs' => $this->logs,
            'queries' => $this->queries,
            'lazy_loads' => $this->lazyLoads,
            'jobs_queued' => $this->jobsQueued,
            'mail' => $this->mail,
            'notifications' => $this->notifications,
            'outgoing_requests' => $this->outgoingRequests,
            'files_read' => 0,
            'files_written' => 0,
            'cache_events' => $this->cacheEvents,
            'hydrated_models' => 0,
            'peak_memory_usage' => memory_get_peak_usage(true),
            'exception_preview' => $this->exceptionPreview,
        ];
    }

    private function elapsed(float $since): int
    {
        return (int) round((microtime(true) - $since) * 1_000_000);
    }

    /**
     * @return array<string, mixed>
     */
    private function common(): array
    {
        return [
            'deploy' => (string) ($this->config['deployment'] ?? ''),
            'server' => $this->server(),
            'environment' => (string) ($this->config['environment'] ?? ''),
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
        $user = $this->authenticatedUser();

        try {
            return $user === null ? '' : (string) $user->getAuthIdentifier();
        } catch (Throwable) {
            return '';
        }
    }

    /**
     * The user the app has already resolved, like laravel/nightwatch's UserProvider. Never asks the guard to load the
     * user itself: that runs a query, whose listener lands back here and recurses.
     */
    private function authenticatedUser(): ?Authenticatable
    {
        try {
            if (! function_exists('app') || ! app()->resolved('auth')) {
                return null;
            }

            $auth = app('auth');

            if (! $auth->hasResolvedGuards() || ! $auth->guard()->hasUser()) {
                return null;
            }

            $user = $auth->guard()->user();

            return $user instanceof Authenticatable ? $user : null;
        } catch (Throwable) {
            return null;
        }
    }

    /** laravel/nightwatch UserSensor: one `user` record per request with a signed-in user (name, and email as username). */
    private function recordUser(): void
    {
        $user = $this->authenticatedUser();

        if ($user === null) {
            return;
        }

        try {
            $this->buffer->write([
                'v' => 1,
                't' => 'user',
                'timestamp' => microtime(true),
                'id' => mb_substr((string) $user->getAuthIdentifier(), 0, 255),
                'name' => mb_substr((string) ($user->name ?? ''), 0, 255),
                'username' => mb_substr((string) ($user->email ?? ''), 0, 255),
            ]);
        } catch (Throwable) {
            //
        }
    }

    /**
     * First application frame of the current query, and whether the query is an Eloquent lazy load: reading an
     * unloaded relation as a property runs it through Model::getRelationshipFromMethod(), which sits between the
     * query and the application frame. Explicit `$model->relation()->get()` calls and eager loads do not.
     *
     * @return array{0: string, 1: int, 2: bool}
     */
    private function location(): array
    {
        $lazy = false;

        foreach (debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS, 80) as $frame) {
            $file = $frame['file'] ?? '';

            if (($frame['function'] ?? '') === 'getRelationshipFromMethod' && is_a($frame['class'] ?? '', Model::class, true)) {
                $lazy = true;
            }

            if ($file === '' || str_contains($file, DIRECTORY_SEPARATOR.'vendor'.DIRECTORY_SEPARATOR) || str_starts_with($file, __DIR__.DIRECTORY_SEPARATOR)) {
                continue;
            }

            return [$this->relative($file), (int) ($frame['line'] ?? 0), $lazy];
        }

        return ['', 0, $lazy];
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
