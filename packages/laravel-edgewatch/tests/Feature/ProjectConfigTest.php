<?php

use EdgeWatch\Laravel\Transport\HttpTransport;
use EdgeWatch\Laravel\Transport\Transport;
use Illuminate\Support\Facades\Route;

/** Loads config/edgewatch.php with only the given environment variables set. */
function edgewatchConfigWith(array $vars): array
{
    $keys = ['EDGEWATCH_TOKEN', 'NIGHTWATCH_TOKEN', 'EDGEWATCH_PROJECT_ID', 'EDGEWATCH_INGEST_URI', 'NIGHTWATCH_INGEST_URI'];
    $previous = [];
    foreach ($keys as $key) {
        $previous[$key] = getenv($key);
        putenv($key);
        unset($_ENV[$key], $_SERVER[$key]);
    }
    foreach ($vars as $key => $value) {
        putenv("{$key}={$value}");
        $_ENV[$key] = $_SERVER[$key] = $value;
    }

    try {
        return require __DIR__.'/../../config/edgewatch.php';
    } finally {
        foreach ($keys as $key) {
            $previous[$key] === false ? putenv($key) : putenv("{$key}={$previous[$key]}");
            unset($_ENV[$key], $_SERVER[$key]);
        }
    }
}

/** Builds the HTTP transport the service provider would build from the given config and returns what it sends. */
function sentWith(array $config, array $records = [['t' => 'request']]): array
{
    config(['edgewatch.ingest.uri' => 'https://ingest.test/api/ingest', ...$config]);
    app()->forgetInstance(Transport::class);
    $provider = new EdgeWatch\Laravel\EdgeWatchServiceProvider(app());
    $transport = (fn () => $this->makeTransport())->call($provider);
    expect($transport)->toBeInstanceOf(HttpTransport::class);

    $sent = [];
    Closure::bind(function () use (&$sent) {
        $this->sender = function ($url, $headers, $body) use (&$sent) {
            $sent = ['headers' => $headers, 'records' => json_decode(gzdecode($body), true)['records']];

            return 200;
        };
    }, $transport, HttpTransport::class)();
    $transport->send($records);

    return $sent;
}

describe('EDGEWATCH_PROJECT_ID (project tag)', function () {
    it('is read when set, trimmed, and sent as X-EdgeWatch-Project', function () {
        expect(edgewatchConfigWith(['EDGEWATCH_PROJECT_ID' => ' shop '])['project_id'])->toBe('shop');
        expect(sentWith(['edgewatch.token' => 'ew_live_owner', 'edgewatch.project_id' => 'shop'])['headers'])
            ->toMatchArray(['authorization' => 'Bearer ew_live_owner', 'x-edgewatch-project' => 'shop']);
    });

    it('is null when unset, and no tag header is sent', function () {
        expect(edgewatchConfigWith([])['project_id'])->toBeNull();
        expect(sentWith(['edgewatch.token' => 'ew_live_owner', 'edgewatch.project_id' => null])['headers'])->not->toHaveKey('x-edgewatch-project');
    });

    it('treats an empty or blank value as unset', function (string $value) {
        expect(edgewatchConfigWith(['EDGEWATCH_PROJECT_ID' => $value])['project_id'])->toBeNull();
        expect(sentWith(['edgewatch.token' => 'ew_live_owner', 'edgewatch.project_id' => $value])['headers'])->not->toHaveKey('x-edgewatch-project');
    })->with(['empty' => '', 'spaces' => '   ']);
});

describe('token fallbacks', function () {
    it('prefers the per-app EDGEWATCH_TOKEN over the shared NIGHTWATCH_TOKEN', function () {
        expect(edgewatchConfigWith(['EDGEWATCH_TOKEN' => 'ew_live_app', 'NIGHTWATCH_TOKEN' => 'ew_live_shared'])['token'])->toBe('ew_live_app');
    });

    it('falls back to NIGHTWATCH_* when the EDGEWATCH_* key is missing', function () {
        $config = edgewatchConfigWith(['NIGHTWATCH_TOKEN' => 'ew_live_shared', 'NIGHTWATCH_INGEST_URI' => 'https://ingest.test/api/ingest']);

        expect($config['token'])->toBe('ew_live_shared')
            ->and($config['ingest']['uri'])->toBe('https://ingest.test/api/ingest');
    });

    it('falls back to NIGHTWATCH_* when the EDGEWATCH_* key is set but empty', function () {
        $config = edgewatchConfigWith(['EDGEWATCH_TOKEN' => '', 'NIGHTWATCH_TOKEN' => 'ew_live_shared', 'EDGEWATCH_INGEST_URI' => ' ']);

        expect($config['token'])->toBe('ew_live_shared')
            ->and($config['ingest']['uri'])->toBe('127.0.0.1:2407');
    });

    it('is null with no token at all, and defaults to the local agent address', function () {
        $config = edgewatchConfigWith([]);

        expect($config['token'])->toBeNull()
            ->and($config['ingest']['uri'])->toBe('127.0.0.1:2407');
    });
});

it('sends a request that carries no project at all without any project tag', function () {
    config(['edgewatch.project_id' => null]);
    Route::get('/no-project', fn () => 'ok');

    $this->get('/no-project')->assertOk();
    $records = $this->transport->records();
    expect($records)->not->toBeEmpty()
        ->and(collect($records)->pluck('project_id')->filter()->all())->toBe([]);

    $sent = sentWith(['edgewatch.token' => 'ew_live_owner', 'edgewatch.project_id' => null], $records);
    expect($sent['headers'])->not->toHaveKey('x-edgewatch-project')
        ->and($sent['headers']['authorization'])->toBe('Bearer ew_live_owner')
        ->and(collect($sent['records'])->pluck('t')->all())->toContain('request');
});
