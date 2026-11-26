<?php

namespace EdgeWatch\Laravel\Tests;

use EdgeWatch\Laravel\EdgeWatchServiceProvider;
use EdgeWatch\Laravel\Transport\Transport;
use Orchestra\Testbench\TestCase as Orchestra;

abstract class TestCase extends Orchestra
{
    public FakeTransport $transport;

    protected function getPackageProviders($app): array
    {
        return [EdgeWatchServiceProvider::class];
    }

    protected function defineEnvironment($app): void
    {
        $app['config']->set('database.default', 'testing');
        $app['config']->set('edgewatch.token', 'test-token');
        $app['config']->set('edgewatch.server', 'test-server');
        $app['config']->set('edgewatch.environment', 'test-environment');

        $this->transport = new FakeTransport;
        $app->instance(Transport::class, $this->transport);
    }
}
