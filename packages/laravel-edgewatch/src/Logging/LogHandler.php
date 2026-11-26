<?php

declare(strict_types=1);

namespace EdgeWatch\Laravel\Logging;

use Closure;
use EdgeWatch\Laravel\EdgeWatch;
use Monolog\Handler\AbstractHandler;
use Monolog\Level;
use Monolog\LogRecord;

final class LogHandler extends AbstractHandler
{
    /** @param Closure(): EdgeWatch $edgewatch */
    public function __construct(private Closure $edgewatch, Level $level)
    {
        parent::__construct($level, bubble: true);
    }

    public function handle(LogRecord $record): bool
    {
        if ($this->isHandling($record)) {
            rescue(fn () => ($this->edgewatch)()->log($record), report: false);
        }

        return false;
    }
}
