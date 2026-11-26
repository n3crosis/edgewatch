<?php

declare(strict_types=1);

namespace EdgeWatch\Laravel\Logging;

use EdgeWatch\Laravel\EdgeWatch;
use Illuminate\Contracts\Container\Container;
use Monolog\Logger as Monolog;
use Psr\Log\LoggerInterface;

/** `custom` driver for the `edgewatch` (and `nightwatch`) log channel, e.g. LOG_STACK=single,edgewatch. */
final class Logger
{
    public function __construct(private Container $app)
    {
        //
    }

    /** @param array<string, mixed> $config */
    public function __invoke(array $config): LoggerInterface
    {
        return new Monolog('edgewatch', [
            new LogHandler(fn (): EdgeWatch => $this->app->make(EdgeWatch::class), Monolog::toMonologLevel((string) ($config['level'] ?? 'debug'))),
        ]);
    }
}
