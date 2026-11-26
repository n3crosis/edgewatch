<?php

use App\Models\User;
use EdgeWatch\Laravel\EdgeWatch;
use EdgeWatch\Laravel\Support\Uuid7;
use EdgeWatch\Laravel\Transport\HttpTransport;
use EdgeWatch\Laravel\Transport\Transport;

beforeEach(function () {
    $this->records = new class implements Transport
    {
        public array $sent = [];

        public function send(array $records): void
        {
            array_push($this->sent, ...$records);
        }

        public function of(string $type): array
        {
            return array_values(array_filter($this->sent, fn ($r) => $r['t'] === $type));
        }
    };

    // Swap the real transport before EdgeWatch is resolved so the package's own buffer wraps it.
    $this->app->forgetInstance(EdgeWatch::class);
    $this->app->instance(Transport::class, $this->records);
});

it('is auto-discovered from the local path repository', function () {
    expect(app()->getProviders(\EdgeWatch\Laravel\EdgeWatchServiceProvider::class))->not->toBeEmpty();
});

it('uses the HTTP transport when EDGEWATCH_INGEST_URI is an https URL and a token is set', function () {
    $this->app->forgetInstance(Transport::class);
    config(['edgewatch.ingest.uri' => 'https://ingest.edgewatch.test/api/ingest', 'edgewatch.token' => 'ew_live_test']);

    expect(app(Transport::class))->toBeInstanceOf(HttpTransport::class);
});

it('turns the HTTP transport off when no token is set', function () {
    $this->app->forgetInstance(Transport::class);
    config(['edgewatch.ingest.uri' => 'https://ingest.edgewatch.test/api/ingest', 'edgewatch.token' => null]);

    expect(app(Transport::class))->toBeInstanceOf(\EdgeWatch\Laravel\Transport\NullTransport::class);
});

it('runs edgewatch:test from the app and reports a failure without a token', function () {
    config(['edgewatch.ingest.uri' => 'https://ingest.edgewatch.test/api/ingest', 'edgewatch.token' => null]);

    $this->artisan('edgewatch:test')->expectsOutputToContain('FAIL  not configured: EDGEWATCH_TOKEN')->assertExitCode(1);
});

it('reports a request with its queries under one UUIDv7 trace, with SQL literals stripped', function () {
    $user = User::factory()->create(['email' => 'jane@example.com']);

    $this->get("/users/{$user->id}", ['Authorization' => 'Bearer secret-token'])->assertOk();

    $request = $this->records->of('request')[0];
    $queries = $this->records->of('query');

    expect($request)->toMatchArray(['method' => 'GET', 'route_name' => 'users.show', 'route_path' => '/users/{id}', 'status_code' => 200])
        ->and(Uuid7::isValid($request['trace_id']))->toBeTrue()
        ->and(json_decode($request['headers'], true)['authorization'])->toBe(['Bearer [12 bytes redacted]'])
        ->and(collect($queries)->pluck('trace_id')->unique()->all())->toBe([$request['trace_id']])
        ->and(collect($queries)->pluck('sql'))->toContain('select count(*) as c from users where email like ?')
        ->and(json_encode($this->records->sent))->not->toContain('jane@example.com');
});

it('reports unhandled exceptions with PII scrubbed', function () {
    $this->post('/checkout')->assertServerError();

    expect($this->records->of('exception')[0])->toMatchArray([
        'class' => RuntimeException::class,
        'message' => 'Card was declined for [email]',
        'handled' => false,
    ])->and($this->records->of('request')[0]['status_code'])->toBe(500);
});

it('reports cache events and queued jobs for an order, and the job attempt when a worker runs it', function () {
    User::factory()->create();
    config(['queue.default' => 'sync']);

    $this->post('/orders')->assertStatus(202);
    app(EdgeWatch::class)->flush();

    $request = $this->records->of('request')[0];
    $cache = collect($this->records->of('cache-event'));

    expect($cache->pluck('type')->all())->toContain('miss', 'write')
        ->and($cache->pluck('key'))->toContain('order-stats')
        ->and($this->records->of('job-attempt')[0])->toMatchArray(['name' => \App\Jobs\SendOrderConfirmation::class, 'status' => 'processed'])
        ->and($request['cache_events'])->toBeGreaterThanOrEqual(2);
});

it('reports artisan commands', function () {
    app(\Illuminate\Contracts\Console\Kernel::class)->rerouteSymfonyCommandEvents();
    $this->artisan('report:daily')->assertSuccessful();

    expect($this->records->of('command')[0])->toMatchArray(['name' => 'report:daily', 'exit_code' => 0]);
});
