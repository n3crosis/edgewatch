<?php

use EdgeWatch\Laravel\EdgeWatch;
use Illuminate\Bus\Queueable;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Cache\Events\ForgettingKey;
use Illuminate\Cache\Events\KeyForgetFailed;
use Illuminate\Cache\Events\KeyWriteFailed;
use Illuminate\Cache\Events\WritingKey;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Notification;
use Illuminate\Notifications\Messages\MailMessage;
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

it('measures cache durations and records write and delete failures', function () {
    $deleteStarted = $deleteFinished = 0.0;
    Route::get('/cache-timing', function () use (&$deleteStarted, &$deleteFinished) {
        event(new WritingKey('redis', 'report:42', 'x', 300));
        usleep(3000);
        event(new KeyWriteFailed('redis', 'report:42', 'x', 300));
        $deleteStarted = microtime(true);
        event(new ForgettingKey('redis', 'report:42'));
        event(new KeyForgetFailed('redis', 'report:42'));
        $deleteFinished = microtime(true);
        Cache::get('anything');

        return 'ok';
    });

    $this->get('/cache-timing')->assertOk();

    $events = $this->transport->records('cache-event');

    expect(array_column($events, 'type'))->toBe(['write-failure', 'delete-failure', 'miss'])
        ->and($events[0])->toMatchArray(['store' => 'redis', 'key' => 'report:42', 'ttl' => 300])
        ->and($events[0]['duration'])->toBeGreaterThanOrEqual(3000)
        ->and($events[1]['timestamp'])->toBeGreaterThanOrEqual($deleteStarted)
        ->and($events[1]['duration'])->toBeInt()->toBeGreaterThanOrEqual(0)
        ->toBeLessThanOrEqual((int) ceil(($deleteFinished - $deleteStarted) * 1_000_000))
        ->and($events[2]['duration'])->toBeInt()->toBeGreaterThanOrEqual(0)
        ->and($events[0]['timestamp'])->toBeLessThan($events[1]['timestamp']);
});

it('records outgoing HTTP requests made with the Http client', function () {
    Http::fake(['api.stripe.com/*' => Http::response('{"error":"card_declined"}', 402)]);
    Route::get('/pay', function () {
        Http::withBody('{"amount":100}')->post('https://api.stripe.com/v1/charges?api_key=sk_test_secret');

        return 'ok';
    });

    $this->get('/pay')->assertOk();

    $out = $this->transport->records('outgoing-request');

    expect($out)->toHaveCount(1)
        ->and($out[0])->toMatchArray(['v' => 1, 'host' => 'api.stripe.com', 'method' => 'POST', 'url' => 'https://api.stripe.com/v1/charges', 'status_code' => 402, 'request_size' => 14])
        ->and($out[0]['duration'])->toBeInt()->toBeGreaterThanOrEqual(0)
        ->and($out[0]['trace_id'])->toBe($this->transport->records('request')[0]['trace_id'])
        ->and($this->transport->records('request')[0]['outgoing_requests'])->toBe(1);
});

it('can ignore outgoing HTTP requests', function () {
    config(['edgewatch.filtering.ignore_outgoing_requests' => true]);
    app()->forgetInstance(EdgeWatch::class);
    Http::fake();
    Route::get('/pay-ignored', fn () => Http::get('https://example.test/')->status());

    $this->get('/pay-ignored')->assertOk();

    expect($this->transport->records('outgoing-request'))->toBe([]);
});

it('records mail with recipient counts, a scrubbed subject and duration', function () {
    config(['mail.default' => 'array']);
    Route::get('/mail', function () {
        Mail::raw('Hello', fn ($m) => $m->to(['a@example.com', 'b@example.com'])->cc('c@example.com')->subject('Receipt for jane@example.com'));

        return 'ok';
    });

    $this->get('/mail')->assertOk();

    $mail = $this->transport->records('mail');

    expect($mail)->toHaveCount(1)
        ->and($mail[0])->toMatchArray(['v' => 1, 'mailer' => 'array', 'subject' => 'Receipt for [email]', 'to' => 2, 'cc' => 1, 'bcc' => 0, 'attachments' => 0, 'failed' => false])
        ->and($mail[0]['duration'])->toBeInt()->toBeGreaterThanOrEqual(0)
        ->and($this->transport->records('request')[0]['mail'])->toBe(1);
});

it('records notifications once per channel and does not double count their mail', function () {
    config(['mail.default' => 'array']);
    Route::get('/notify', function () {
        Notification::route('mail', 'jane@example.com')->notify(new class extends \Illuminate\Notifications\Notification
        {
            public function via(object $notifiable): array
            {
                return ['mail'];
            }

            public function toMail(object $notifiable): MailMessage
            {
                return (new MailMessage)->subject('Shipped')->line('On its way');
            }
        });

        return 'ok';
    });

    $this->get('/notify')->assertOk();

    $notifications = $this->transport->records('notification');

    expect($notifications)->toHaveCount(1)
        ->and($notifications[0])->toMatchArray(['v' => 1, 'channel' => 'mail', 'class' => \Illuminate\Notifications\Notification::class.'@anonymous', 'failed' => false])
        ->and($notifications[0]['duration'])->toBeInt()
        ->and($this->transport->records('mail'))->toBe([])
        ->and($this->transport->records('request')[0])->toMatchArray(['notifications' => 1, 'mail' => 0]);
});

it('can ignore mail and notifications', function () {
    config(['mail.default' => 'array', 'edgewatch.filtering.ignore_mail' => true, 'edgewatch.filtering.ignore_notifications' => true]);
    app()->forgetInstance(EdgeWatch::class);
    Route::get('/mail-ignored', function () {
        Mail::raw('Hello', fn ($m) => $m->to('a@example.com'));

        return 'ok';
    });

    $this->get('/mail-ignored')->assertOk();

    expect($this->transport->records('mail'))->toBe([]);
});

it('records each scheduled task in its own trace with cron, status and duration', function () {
    $this->travelTo(now()->setTime(10, 5));
    $schedule = app(Schedule::class);
    $schedule->call(function () {
        DB::select('select 1');
        usleep(2000);
    })->everyFiveMinutes()->name('prune-carts');
    $schedule->call(fn () => throw new RuntimeException('stock feed down'))->everyMinute()->name('sync-stock');
    $schedule->call(fn () => null)->everyMinute()->skip(fn () => true)->name('never-runs');
    $schedule->call(fn () => null)->hourly();

    Artisan::call('schedule:run');

    $tasks = collect($this->transport->records('scheduled-task'))->keyBy('name');
    $exceptions = $this->transport->records('exception');

    expect($tasks->keys()->all())->toBe(['prune-carts', 'sync-stock', 'never-runs'])
        ->and($tasks['prune-carts'])->toMatchArray(['v' => 1, 'cron' => '*/5 * * * *', 'status' => 'processed', 'execution_source' => 'schedule', 'queries' => 1, 'repeat_seconds' => 0])
        ->and($tasks['prune-carts']['duration'])->toBeGreaterThanOrEqual(2000)
        ->and($tasks['sync-stock'])->toMatchArray(['cron' => '* * * * *', 'status' => 'failed', 'exceptions' => 1])
        ->and($tasks['never-runs'])->toMatchArray(['status' => 'skipped', 'duration' => 0])
        ->and($tasks->pluck('trace_id')->unique())->toHaveCount(3)
        ->and($exceptions)->toHaveCount(1)
        ->and($exceptions[0])->toMatchArray(['class' => RuntimeException::class, 'trace_id' => $tasks['sync-stock']['trace_id']])
        ->and($this->transport->records('command'))->toBe([]);
});

it('names closure tasks by their location', function () {
    $this->travelTo(now()->setTime(11, 0));
    app(Schedule::class)->call(fn () => null)->hourly();

    Artisan::call('schedule:run');

    expect($this->transport->records('scheduled-task')[0]['name'])->toMatch('/^Closure at: .*CollectorsTest\.php:\d+$/');
});

function lazyLoadFixtures(): void
{
    Schema::create('lazy_authors', fn ($t) => [$t->id(), $t->string('name')]);
    Schema::create('lazy_posts', fn ($t) => [$t->id(), $t->foreignId('author_id'), $t->string('title')]);
    foreach (['Ada', 'Grace', 'Linus'] as $i => $name) {
        $author = LazyAuthor::create(['name' => $name]);
        LazyPost::create(['author_id' => $author->id, 'title' => "Post {$i}"]);
    }
}

it('counts Eloquent lazy loads (unloaded relation read as a property) per request', function () {
    lazyLoadFixtures();
    Route::get('/lazy', fn () => LazyPost::all()->map(fn (LazyPost $post) => $post->author->name)->implode(','));

    $this->get('/lazy')->assertOk()->assertSee('Ada,Grace,Linus');

    $request = $this->transport->records('request')[0];
    expect($request['lazy_loads'])->toBe(3);
});

it('does not count eager loads or explicit relation queries as lazy loads', function () {
    lazyLoadFixtures();
    Route::get('/eager', function () {
        $names = LazyPost::with('author')->get()->map(fn (LazyPost $post) => $post->author->name);
        $posts = LazyAuthor::first()->posts()->get();

        return $names->implode(',').':'.$posts->count();
    });

    $this->get('/eager')->assertOk()->assertSee('Ada,Grace,Linus:1');

    $request = $this->transport->records('request')[0];
    expect($request['lazy_loads'])->toBe(0);
});

it('counts lazy loads in commands and resets the counter between executions', function () {
    lazyLoadFixtures();
    Artisan::command('lazy:report', function (): void {
        LazyAuthor::all()->each(fn (LazyAuthor $a) => $a->posts->count());
    });

    app(\Illuminate\Contracts\Console\Kernel::class)->rerouteSymfonyCommandEvents();
    Artisan::command('lazy:none', function (): void {
        LazyAuthor::with('posts')->get();
    });
    $this->artisan('lazy:report')->assertExitCode(0);
    $this->artisan('lazy:none')->assertExitCode(0);

    $commands = collect($this->transport->records('command'))->keyBy('name');
    expect($commands['lazy:report']['lazy_loads'])->toBe(3)
        ->and($commands['lazy:none']['lazy_loads'])->toBe(0);
});

it('records logs sent to the edgewatch channel with level, scrubbed message and context', function () {
    config(['logging.default' => 'edgewatch']);
    Route::get('/log', function () {
        Log::info('Order placed by jane@example.com', ['order' => 42, 'email' => 'jane@example.com']);
        Log::debug('cart recalculated');

        return 'ok';
    });

    $this->get('/log')->assertOk();

    $logs = $this->transport->records('log');
    $request = $this->transport->records('request')[0];

    expect(array_column($logs, 'level'))->toBe(['info', 'debug'])
        ->and($logs[0])->toMatchArray(['v' => 1, 'message' => 'Order placed by [email]', 'trace_id' => $request['trace_id'], 'extra' => '{}'])
        ->and(json_decode($logs[0]['context'], true))->toBe(['order' => 42, 'email' => '[email]'])
        ->and($logs[0]['timestamp'])->toBeFloat()
        ->and($request['logs'])->toBe(2);
});

it('honours the minimum log level and also answers to the nightwatch channel name', function () {
    config(['logging.channels.nightwatch.level' => 'warning']);
    Route::get('/log-level', function () {
        Log::channel('nightwatch')->info('ignored');
        Log::channel('nightwatch')->error('payment failed', ['code' => 'card_declined']);

        return 'ok';
    });

    $this->get('/log-level')->assertOk();

    expect(array_column($this->transport->records('log'), 'message'))->toBe(['payment failed']);
});

it('does not feed its own transmission errors back into the log stream', function () {
    config(['logging.default' => 'edgewatch']);
    Route::get('/log-self', function () {
        Log::debug('[EdgeWatch] transmission failed: timeout');

        return 'ok';
    });

    $this->get('/log-self')->assertOk();

    expect($this->transport->records('log'))->toBe([]);
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

it('exposes the current trace id for linking browser errors', function () {
    Route::get('/meta', fn () => app(EdgeWatch::class)->traceId());

    $body = $this->get('/meta')->assertOk()->getContent();

    expect($body)->toBe($this->transport->records('request')[0]['trace_id']);
});

it('records nothing from ignored worker commands outside of jobs', function () {
    databaseQueue();
    app(\Illuminate\Contracts\Console\Kernel::class)->rerouteSymfonyCommandEvents();
    EdgeWatchTestJob::dispatch();
    app(EdgeWatch::class)->flush();
    $this->transport->batches = [];

    $this->artisan('queue:work', ['--once' => true, '--stop-when-empty' => true]);
    Cache::get('after-the-job');
    app(EdgeWatch::class)->flush();

    expect(collect($this->transport->records())->pluck('t')->unique()->sort()->values()->all())->toBe(['job-attempt', 'query'])
        ->and(collect($this->transport->records())->pluck('trace_id')->unique())->toHaveCount(1)
        ->and($this->transport->records('command'))->toBeEmpty();
});

class LazyAuthor extends Model
{
    public $timestamps = false;

    protected $guarded = [];

    public function posts(): \Illuminate\Database\Eloquent\Relations\HasMany
    {
        return $this->hasMany(LazyPost::class, 'author_id');
    }
}

class LazyPost extends Model
{
    public $timestamps = false;

    protected $guarded = [];

    public function author(): \Illuminate\Database\Eloquent\Relations\BelongsTo
    {
        return $this->belongsTo(LazyAuthor::class, 'author_id');
    }
}

class EdgeWatchTestUser extends \Illuminate\Foundation\Auth\User
{
    protected $table = 'edgewatch_users';

    public $timestamps = false;

    protected $guarded = [];
}

function authUsers(): void
{
    Schema::create('edgewatch_users', fn ($t) => [$t->id(), $t->string('name'), $t->string('email'), $t->string('password')]);
    config(['auth.providers.users.model' => EdgeWatchTestUser::class]);
}

it('records the signed-in user like laravel/nightwatch (id, name, email as username) and attributes the request', function () {
    authUsers();
    $user = EdgeWatchTestUser::create(['name' => 'Ada Lovelace', 'email' => 'ada@example.com', 'password' => 'x']);
    Route::get('/me', fn () => 'hi');

    $this->actingAs($user)->get('/me')->assertOk();

    expect($this->transport->records('request')[0]['user'])->toBe((string) $user->id)
        ->and($this->transport->records('user'))->toHaveCount(1)
        ->and($this->transport->records('user')[0])->toMatchArray(['v' => 1, 't' => 'user', 'id' => (string) $user->id, 'name' => 'Ada Lovelace', 'username' => 'ada@example.com']);
});

it('records no user for guests and never resolves the user from inside its own query listener', function () {
    authUsers();
    Route::get('/guest', fn () => EdgeWatchTestUser::count());
    Route::get('/login', function () {
        Auth::login(EdgeWatchTestUser::forceCreate(['name' => 'Grace', 'email' => 'grace@example.com', 'password' => 'x']));

        return EdgeWatchTestUser::count();
    });

    $this->get('/guest')->assertOk();
    expect($this->transport->records('user'))->toBe([])
        ->and($this->transport->records('request')[0]['user'])->toBe('');

    $this->get('/login')->assertOk();
    expect(collect($this->transport->records('user'))->pluck('name')->all())->toBe(['Grace']);
});
