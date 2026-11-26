<?php

use EdgeWatch\Laravel\EdgeWatch;
use EdgeWatch\Laravel\Support\Uuid7;
use EdgeWatch\Laravel\Transport\AgentTransport;
use EdgeWatch\Laravel\Transport\HttpTransport;
use EdgeWatch\Laravel\Transport\Transport;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;

it('merges the default config with Nightwatch-compatible keys', function () {
    expect(config('edgewatch.ingest.timeout'))->toBe(0.5)
        ->and(config('edgewatch.ingest.connection_timeout'))->toBe(0.5)
        ->and(config('edgewatch.ingest.event_buffer'))->toBe(500)
        ->and(config('edgewatch.redact_headers'))->toContain('Authorization');
});

it('captures queries with stripped literals, a UUIDv7 trace id and a Nightwatch-shaped record', function () {
    DB::select("select 1 as one, 'jane@example.com' as email");
    app(EdgeWatch::class)->flush();

    $query = $this->transport->records('query')[0];

    expect($query)->toMatchArray([
        'v' => 1,
        't' => 'query',
        'sql' => 'select ? as one, ? as email',
        'connection' => 'testing',
        'server' => 'test-server',
        'environment' => 'test-environment',
        'execution_source' => 'request',
    ])
        ->and(Uuid7::isValid($query['trace_id']))->toBeTrue()
        ->and($query['_group'])->toHaveLength(32)
        ->and($query['duration'])->toBeInt()
        ->and($query['file'])->toContain('ServiceProviderTest.php');
});

it('captures reported exceptions with PII scrubbed', function () {
    report(new RuntimeException('Payment failed for jane@example.com'));
    app(EdgeWatch::class)->flush();

    $exception = $this->transport->records('exception')[0];

    expect($exception)->toMatchArray([
        'v' => 3,
        't' => 'exception',
        'class' => RuntimeException::class,
        'message' => 'Payment failed for [email]',
        'handled' => false,
    ])->and(json_decode($exception['trace'], true))->toBeArray();
});

it('records a request, its queries and exceptions under one trace and flushes on terminate', function () {
    Route::get('/orders/{id}', function () {
        DB::select('select * from sqlite_master where name = ?', ['orders']);
        report(new LogicException('boom'));

        return response('ok');
    })->name('orders.show');

    $this->get('/orders/42', ['Authorization' => 'Bearer super-secret-token'])->assertOk();

    $request = $this->transport->records('request')[0];

    expect($request)->toMatchArray([
        'v' => 1,
        't' => 'request',
        'method' => 'GET',
        'route_name' => 'orders.show',
        'environment' => 'test-environment',
        'route_path' => '/orders/{id}',
        'route_methods' => ['GET', 'HEAD'],
        'status_code' => 200,
        'queries' => 1,
        'exceptions' => 1,
        'exception_preview' => 'boom',
    ])
        ->and(json_decode($request['headers'], true)['authorization'])->toBe(['Bearer [18 bytes redacted]'])
        ->and(collect($this->transport->records())->pluck('trace_id')->unique())->toHaveCount(1);
});

it('picks the transport from the ingest URI', function (string $uri, string $class) {
    app()->forgetInstance(Transport::class);
    config(['edgewatch.ingest.uri' => $uri]);

    expect(app(Transport::class))->toBeInstanceOf($class);
})->with([
    'agent host:port' => ['127.0.0.1:2407', AgentTransport::class],
    'https endpoint' => ['https://ingest.edgewatch.test/api/ingest', HttpTransport::class],
]);
