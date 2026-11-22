<?php

use EdgeWatch\Laravel\EdgeWatch;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Schema;

class EdgeWatchTestJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable;

    public int $tries = 1;

    public function __construct(public bool $fail = false) {}

    public function handle(): void
    {
        DB::select('select ? as v', [1]);

        if ($this->fail) {
            throw new RuntimeException('job failed for jane@example.com');
        }
    }
}

function databaseQueue(): void
{
    config(['queue.default' => 'database', 'queue.connections.database' => ['driver' => 'database', 'table' => 'jobs', 'queue' => 'default', 'retry_after' => 90, 'connection' => 'testing']]);
    config(['queue.failed.driver' => 'null']);
    Schema::create('jobs', function ($table) {
        $table->id();
        $table->string('queue')->index();
        $table->longText('payload');
        $table->unsignedTinyInteger('attempts');
        $table->unsignedInteger('reserved_at')->nullable();
        $table->unsignedInteger('available_at');
        $table->unsignedInteger('created_at');
    });
}

it('records artisan commands with their exit code, duration and queries', function () {
    Artisan::command('demo:report {--force}', function () {
        DB::select("select * from sqlite_master where name = 'users'");

        return 3;
    });

    // Real CLI runs reroute Symfony console events in Kernel::handle(); Artisan::call() in tests needs it explicitly.
    app(\Illuminate\Contracts\Console\Kernel::class)->rerouteSymfonyCommandEvents();
    $this->artisan('demo:report --force')->assertExitCode(3);

    $command = $this->transport->records('command')[0];
    $query = $this->transport->records('query')[0];

    expect($command)->toMatchArray([
        'v' => 1,
        't' => 'command',
        'name' => 'demo:report',
        'exit_code' => 3,
        'execution_source' => 'command',
        'queries' => 1,
    ])
        ->and($command['command'])->toContain('demo:report')
        ->and($command['duration'])->toBeInt()->toBeGreaterThan(0)
        ->and($query['trace_id'])->toBe($command['trace_id'])
        ->and($query['sql'])->toBe('select * from sqlite_master where name = ?');
});

it('does not record ignored long-running commands', function () {
    expect(app(EdgeWatch::class)->isIgnoredCommand('queue:work'))->toBeTrue()
        ->and(app(EdgeWatch::class)->isIgnoredCommand('demo:report'))->toBeFalse();
});

it('records queued jobs, processed job attempts and failed attempts on their own traces', function () {
    databaseQueue();

    Route::post('/orders', function () {
        EdgeWatchTestJob::dispatch();
        EdgeWatchTestJob::dispatch(true);

        return response('queued', 201);
    });

    $this->post('/orders')->assertCreated();

    $request = $this->transport->records('request')[0];
    $queued = $this->transport->records('queued-job');

    expect($request['jobs_queued'])->toBe(2)
        ->and($queued)->toHaveCount(2)
        ->and($queued[0])->toMatchArray(['name' => EdgeWatchTestJob::class, 'connection' => 'database', 'queue' => 'default', 'trace_id' => $request['trace_id']]);

    $this->artisan('queue:work', ['--once' => true, '--stop-when-empty' => true]);
    $this->artisan('queue:work', ['--once' => true, '--stop-when-empty' => true]);

    // The worker reports the exception after JobFailed; it is flushed with the next execution (or on terminate).
    app(EdgeWatch::class)->flush();
    [$ok, $failed] = $this->transport->records('job-attempt');

    expect($ok)->toMatchArray(['t' => 'job-attempt', 'name' => EdgeWatchTestJob::class, 'status' => 'processed', 'attempt' => 1, 'connection' => 'database', 'execution_source' => 'job'])
        ->and($ok['queries'])->toBeGreaterThanOrEqual(1)
        ->and($ok['job_id'])->toBe($queued[0]['job_id'])
        ->and($ok['trace_id'])->not->toBe($request['trace_id'])
        ->and($failed)->toMatchArray(['status' => 'failed'])
        ->and($failed['trace_id'])->not->toBe($ok['trace_id'])
        ->and(collect($this->transport->records('exception'))->firstWhere('trace_id', $failed['trace_id'])['message'])->toBe('job failed for [email]')
        ->and($this->transport->records('command'))->toBeEmpty();
});

it('keeps sync jobs inside the current request trace', function () {
    config(['queue.default' => 'sync']);
    Route::get('/sync', function () {
        EdgeWatchTestJob::dispatchSync();

        return 'ok';
    });

    $this->get('/sync')->assertOk();

    $attempt = $this->transport->records('job-attempt')[0];
    $request = $this->transport->records('request')[0];

    expect($attempt)->toMatchArray(['status' => 'processed', 'connection' => 'sync'])
        ->and($attempt['trace_id'])->toBe($request['trace_id']);
});

it('records cache hits, misses, writes and deletes', function () {
    Route::get('/cache', function () {
        Cache::put('user:jane@example.com', 'x', 60);
        Cache::get('user:jane@example.com');
        Cache::get('missing');
        Cache::forget('user:jane@example.com');

        return 'ok';
    });

    $this->get('/cache')->assertOk();

    $events = $this->transport->records('cache-event');

    expect(array_column($events, 'type'))->toBe(['write', 'hit', 'miss', 'delete'])
        ->and($events[0])->toMatchArray(['v' => 1, 'store' => 'array', 'key' => 'user:[email]', 'ttl' => 60])
        ->and($this->transport->records('request')[0]['cache_events'])->toBe(4);
});

it('can ignore cache events', function () {
    config(['edgewatch.filtering.ignore_cache_events' => true]);
    app()->forgetInstance(EdgeWatch::class);
    $ew = app(EdgeWatch::class);
    (fn () => $this->config['filtering']['ignore_cache_events'] = true)->call($ew);

    Cache::get('anything');
    $ew->flush();

    expect($this->transport->records('cache-event'))->toBeEmpty();
});
