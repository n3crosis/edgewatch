<?php

use EdgeWatch\Laravel\Transport\Backoff;
use EdgeWatch\Laravel\Transport\HttpTransport;

it('posts gzip-compressed {"records": [...]} with Nightwatch agent headers and a 500ms timeout', function () {
    $captured = [];
    $transport = new HttpTransport('https://ingest.test/api/ingest', 'tok_123', 'web-1', sender: function ($url, $headers, $body, $connect, $timeout) use (&$captured) {
        $captured = compact('url', 'headers', 'body', 'connect', 'timeout');

        return 200;
    });

    $transport->send([['v' => 1, 't' => 'request', 'trace_id' => 'abc']]);

    expect($captured['url'])->toBe('https://ingest.test/api/ingest')
        ->and($captured['headers'])->toMatchArray([
            'authorization' => 'Bearer tok_123',
            'content-encoding' => 'gzip',
            'content-type' => 'application/json',
            'nightwatch-server' => 'web-1',
            'user-agent' => 'EdgeWatchLaravel/'.HttpTransport::VERSION,
        ])
        ->and(json_decode(gzdecode($captured['body']), true))->toBe(['records' => [['v' => 1, 't' => 'request', 'trace_id' => 'abc']]])
        ->and($captured['connect'])->toBe(0.5)
        ->and($captured['timeout'])->toBe(0.5);
});

it('throws on non-2xx responses', function () {
    (new HttpTransport('https://ingest.test', 't', 's', sender: fn () => 401))->send([['t' => 'query']]);
})->throws(RuntimeException::class, 'HTTP 401');

it('does nothing for an empty batch', function () {
    $called = false;
    (new HttpTransport('https://ingest.test', 't', 's', sender: function () use (&$called) { $called = true; return 200; }))->send([]);

    expect($called)->toBeFalse();
});

it('gives up within the timeout when the endpoint hangs', function () {
    $server = stream_socket_server('tcp://127.0.0.1:0');
    $address = stream_socket_get_name($server, false);
    $start = microtime(true);

    expect(fn () => (new HttpTransport("http://{$address}/api/ingest", 't', 's'))->send([['t' => 'query']]))->toThrow(RuntimeException::class)
        ->and(microtime(true) - $start)->toBeLessThan(1.5);

    fclose($server);
})->skip(! function_exists('curl_init'), 'ext-curl not installed');

it('honors 429 + stop/refresh_in by pausing all sends until the window passes', function () {
    $calls = 0;
    $path = tempnam(sys_get_temp_dir(), 'ew');
    $transport = new HttpTransport('https://ingest.test', 't', 's', sender: function () use (&$calls) {
        $calls++;

        return [429, '{"message":"Over quota.","stop":true,"refresh_in":120}', ['retry-after' => '120']];
    }, backoff: new Backoff($path));

    expect(fn () => $transport->send([['t' => 'query']]))->toThrow(RuntimeException::class, 'stop for 120s');

    $transport->send([['t' => 'query']]);
    $transport->send([['t' => 'query']]);

    expect($calls)->toBe(1)
        ->and($transport->backoff()->pausedUntil())->toBeGreaterThan(microtime(true) + 110);

    // A fresh process (new Backoff on the same file) also stays paused.
    $other = new HttpTransport('https://ingest.test', 't', 's', sender: function () use (&$calls) { $calls++; return 200; }, backoff: new Backoff($path));
    $other->send([['t' => 'query']]);
    expect($calls)->toBe(1);

    @unlink($path);
});

it('falls back to Retry-After and resumes once the window has passed', function () {
    $backoff = new Backoff;
    $responses = [[429, '', ['retry-after' => '1']], 200];
    $calls = 0;
    $transport = new HttpTransport('https://ingest.test', 't', 's', sender: function () use (&$responses, &$calls) { $calls++; return array_shift($responses); }, backoff: $backoff);

    expect(fn () => $transport->send([['t' => 'query']]))->toThrow(RuntimeException::class);
    expect($backoff->isPaused())->toBeTrue();

    (fn () => $this->until = microtime(true) - 1)->call($backoff);
    $transport->send([['t' => 'query']]);

    expect($calls)->toBe(2);
});

it('pauses on a 2xx response that carries stop: true without throwing', function () {
    $transport = new HttpTransport('https://ingest.test', 't', 's', sender: fn () => [200, '{"stop":true,"refresh_in":30}', []]);

    $transport->send([['t' => 'query']]);

    expect($transport->backoff()->isPaused())->toBeTrue();
});
