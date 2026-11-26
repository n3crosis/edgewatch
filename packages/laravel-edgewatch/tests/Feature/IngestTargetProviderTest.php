<?php

it('is what the service provider uses to build the transport', function () {
    $app = app();
    $app['config']->set('edgewatch.ingest.uri', 'https://ingest.example.com');
    $app['config']->set('edgewatch.token', null);
    $provider = new class($app) extends EdgeWatch\Laravel\EdgeWatchServiceProvider
    {
        public function build(): EdgeWatch\Laravel\Transport\Transport
        {
            return $this->makeTransport();
        }
    };
    expect($provider->build())->toBeInstanceOf(EdgeWatch\Laravel\Transport\NullTransport::class);
    $app['config']->set('edgewatch.token', 'ew_live_x');
    expect($provider->build())->toBeInstanceOf(EdgeWatch\Laravel\Transport\HttpTransport::class);
    $app['config']->set('edgewatch.ingest.uri', '127.0.0.1:2407');
    expect($provider->build())->toBeInstanceOf(EdgeWatch\Laravel\Transport\AgentTransport::class);
});
