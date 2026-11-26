<?php

use EdgeWatch\Laravel\EdgeWatch;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\Events\JobFailed;
use Illuminate\Queue\Events\JobProcessed;
use Illuminate\Queue\Events\JobProcessing;
use Illuminate\Queue\Events\WorkerStopping;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\Jobs\SyncJob;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Schema;

class EdgeCaseJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable;

    public static bool $ran = false;

    public int $tries = 1;

    public function handle(): void
    {
        self::$ran = true;
    }
}

class ClosureHoldingJob implements ShouldQueue
{
    use Dispatchable, Queueable;

    public function __construct(public Closure $callback) {}

    public function handle(): void {}
}

function edgeCaseQueue(): void
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

function fakeQueueJob(string $uuid, string $name): SyncJob
{
    return new SyncJob(app(), (string) json_encode(['uuid' => $uuid, 'displayName' => $name, 'job' => 'Illuminate\\Queue\\CallQueuedHandler@call', 'data' => []]), 'redis', 'default');
}

function workOnce(): void
{
    test()->artisan('queue:work', ['--once' => true, '--stop-when-empty' => true]);
    app(EdgeWatch::class)->flush();
}

it('records a job that fails before handle() runs because a dead worker used up its attempts', function () {
    edgeCaseQueue();
    EdgeCaseJob::$ran = false;
    EdgeCaseJob::dispatch();
    DB::table('jobs')->update(['attempts' => 1]); // a previous worker reserved it and died mid-job

    workOnce();

    $attempts = $this->transport->records('job-attempt');
    expect(EdgeCaseJob::$ran)->toBeFalse()
        ->and($attempts)->toHaveCount(1) // JobProcessed still fires after JobFailed; it must not add a "processed" attempt
        ->and($attempts[0])->toMatchArray(['name' => EdgeCaseJob::class, 'status' => 'failed', 'attempt' => 2, 'connection' => 'database', 'execution_source' => 'job']);
});

it('records a failed attempt even when its JobProcessing was never seen', function () {
    event(new JobFailed('redis', fakeQueueJob('job-1', 'App\\Jobs\\Reindex'), new RuntimeException('boom')));
    app(EdgeWatch::class)->flush();

    $attempts = $this->transport->records('job-attempt');
    expect($attempts)->toHaveCount(1)
        ->and($attempts[0])->toMatchArray(['name' => 'App\\Jobs\\Reindex', 'job_id' => 'job-1', 'status' => 'failed', 'connection' => 'redis', 'execution_source' => 'job']);
});

it('sends the in-flight attempt as released when the worker stops mid-job', function () {
    event(new JobProcessing('redis', fakeQueueJob('job-2', 'App\\Jobs\\Import')));
    expect($this->transport->records('job-attempt'))->toBe([]);

    event(new WorkerStopping(1)); // timeout kill / memory limit: the process exits without terminating callbacks

    expect($this->transport->records('job-attempt'))->toHaveCount(1)
        ->and($this->transport->records('job-attempt')[0])->toMatchArray(['name' => 'App\\Jobs\\Import', 'job_id' => 'job-2', 'status' => 'released']);
});

it('closes an attempt left open when the restarted worker starts the next job', function () {
    $stale = fakeQueueJob('job-3', 'App\\Jobs\\Stale');
    $next = fakeQueueJob('job-4', 'App\\Jobs\\Next');
    event(new JobProcessing('redis', $stale));
    event(new JobProcessing('redis', $next));
    event(new JobProcessed('redis', $next));
    app(EdgeWatch::class)->flush();

    [$first, $second] = $this->transport->records('job-attempt');
    expect($first)->toMatchArray(['job_id' => 'job-3', 'status' => 'released'])
        ->and($second)->toMatchArray(['job_id' => 'job-4', 'status' => 'processed'])
        ->and($second['trace_id'])->not->toBe($first['trace_id']);
});

it('keeps the outer attempt when a sync job runs inside a queued job', function () {
    $outer = fakeQueueJob('job-5', 'App\\Jobs\\Outer');
    $inner = new SyncJob(app(), (string) json_encode(['uuid' => 'job-6', 'displayName' => 'App\\Jobs\\Inner', 'job' => 'x', 'data' => []]), 'sync', 'default');
    event(new JobProcessing('redis', $outer));
    event(new JobProcessing('sync', $inner));
    event(new JobProcessed('sync', $inner));
    event(new JobProcessed('redis', $outer));
    app(EdgeWatch::class)->flush();

    $attempts = collect($this->transport->records('job-attempt'))->keyBy('job_id');
    expect($attempts->keys()->sort()->values()->all())->toBe(['job-5', 'job-6'])
        ->and($attempts['job-5']['status'])->toBe('processed')
        ->and($attempts['job-6']['trace_id'])->toBe($attempts['job-5']['trace_id']);
});

it('reports a job whose payload cannot be serialized as an exception, without a queued-job record', function () {
    edgeCaseQueue();
    Route::get('/closure-job', function () {
        ClosureHoldingJob::dispatch(fn () => 1);

        return 'ok';
    });

    $this->get('/closure-job')->assertStatus(500);

    $request = $this->transport->records('request')[0];
    expect($this->transport->records('queued-job'))->toBe([])
        ->and($request['jobs_queued'])->toBe(0)
        ->and(collect($this->transport->records('exception'))->pluck('message')->implode(' '))->toContain("Serialization of 'Closure' is not allowed");
});

it('still records an attempt for a stored payload that cannot be decoded', function () {
    edgeCaseQueue();
    DB::table('jobs')->insert(['queue' => 'default', 'payload' => '{not json', 'attempts' => 0, 'available_at' => time(), 'created_at' => time()]);

    workOnce();

    $attempts = $this->transport->records('job-attempt');
    expect($attempts)->toHaveCount(1)
        ->and($attempts[0])->toMatchArray(['name' => 'unknown', 'connection' => 'database', 'queue' => 'default'])
        ->and($attempts[0]['status'])->toBeIn(['failed', 'released']);
});
