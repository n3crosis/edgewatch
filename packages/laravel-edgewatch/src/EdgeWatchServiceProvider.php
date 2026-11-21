<?php

namespace EdgeWatch\Laravel;

use EdgeWatch\Laravel\Listeners\QueryListener;
use EdgeWatch\Laravel\Redaction\Redactor;
use EdgeWatch\Laravel\Support\Uuid7;
use EdgeWatch\Laravel\Transport\AgentTransport;
use EdgeWatch\Laravel\Transport\BufferedTransport;
use EdgeWatch\Laravel\Transport\HttpTransport;
use EdgeWatch\Laravel\Transport\NullTransport;
use EdgeWatch\Laravel\Transport\Transport;
use Illuminate\Console\Events\CommandFinished;
use Illuminate\Console\Events\CommandStarting;
use Illuminate\Contracts\Debug\ExceptionHandler;
use Illuminate\Contracts\Events\Dispatcher;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Foundation\Http\Events\RequestHandled;
use Illuminate\Queue\Events\JobProcessed;
use Illuminate\Queue\Events\JobProcessing;
use Illuminate\Support\ServiceProvider;
use Throwable;

class EdgeWatchServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__.'/../config/edgewatch.php', 'edgewatch');

        $this->app->singletonIf(Transport::class, fn (): Transport => $this->makeTransport());

        $this->app->singleton(EdgeWatch::class, function ($app): EdgeWatch {
            $config = (array) $app['config']->get('edgewatch', []);

            return new EdgeWatch(
                buffer: new BufferedTransport(
                    transport: $app->make(Transport::class),
                    capacity: (int) ($config['ingest']['event_buffer'] ?? 500),
                    onError: static function (Throwable $e) use ($app): void {
                        if ($app->bound('log')) {
                            rescue(static fn () => $app['log']->debug('[EdgeWatch] transmission failed: '.$e->getMessage()), report: false);
                        }
                    },
                ),
                redactor: new Redactor(
                    headers: array_values((array) ($config['redact_headers'] ?? [])),
                    payloadFields: array_values((array) ($config['redact_payload_fields'] ?? [])),
                    scrubPii: (bool) ($config['scrub_pii'] ?? true),
                ),
                uuid: new Uuid7,
                config: $config,
                basePath: $app->basePath(),
                laravelVersion: $app->version(),
            );
        });
    }

    public function boot(): void
    {
        $this->publishes([
            __DIR__.'/../config/edgewatch.php' => $this->app->configPath('edgewatch.php'),
        ], ['edgewatch', 'edgewatch-config']);

        if (! filter_var($this->app['config']->get('edgewatch.enabled', true), FILTER_VALIDATE_BOOL)) {
            return;
        }

        /** @var Dispatcher $events */
        $events = $this->app->make(Dispatcher::class);

        $events->listen(QueryExecuted::class, [QueryListener::class, 'handle']);

        $events->listen(RequestHandled::class, function (RequestHandled $event): void {
            rescue(fn () => $this->app->make(EdgeWatch::class)->request($event->request, $event->response), report: false);
        });

        $events->listen(CommandStarting::class, function (): void {
            if ($this->app->runningInConsole()) {
                rescue(fn () => $this->app->make(EdgeWatch::class)->startExecution('command'), report: false);
            }
        });
        $events->listen(JobProcessing::class, function (): void {
            rescue(fn () => $this->app->make(EdgeWatch::class)->startExecution('job'), report: false);
        });
        $events->listen([CommandFinished::class, JobProcessed::class], function (): void {
            rescue(fn () => $this->app->make(EdgeWatch::class)->flush(), report: false);
        });

        $this->callAfterResolving(ExceptionHandler::class, function ($handler): void {
            if (method_exists($handler, 'reportable')) {
                $handler->reportable(function (Throwable $e): void {
                    rescue(fn () => $this->app->make(EdgeWatch::class)->exception($e), report: false);
                });
            }
        });

        $this->app->terminating(function (): void {
            rescue(fn () => $this->app->make(EdgeWatch::class)->flush(), report: false);
        });
    }

    protected function makeTransport(): Transport
    {
        $config = (array) $this->app['config']->get('edgewatch.ingest', []);
        $uri = (string) ($config['uri'] ?? '127.0.0.1:2407');
        $token = $this->app['config']->get('edgewatch.token');
        $transport = (string) ($config['transport'] ?? 'auto');

        if ($transport === 'auto') {
            $transport = preg_match('#^https?://#i', $uri) === 1 ? 'http' : 'agent';
        }

        return match ($transport) {
            'http' => new HttpTransport(
                url: $uri,
                token: is_string($token) ? $token : null,
                server: (string) ($this->app['config']->get('edgewatch.server') ?: gethostname()),
                connectionTimeout: (float) ($config['connection_timeout'] ?? 0.5),
                timeout: (float) ($config['timeout'] ?? 0.5),
            ),
            'agent' => new AgentTransport(
                address: $uri,
                token: is_string($token) ? $token : null,
                connectionTimeout: (float) ($config['connection_timeout'] ?? 0.5),
                timeout: (float) ($config['timeout'] ?? 0.5),
            ),
            default => new NullTransport,
        };
    }
}
