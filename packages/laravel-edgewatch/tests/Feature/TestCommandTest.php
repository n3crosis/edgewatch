<?php

/** A real HTTP server (php -S) that logs the request it gets and answers with the given status and body. */
function fakeIngest(int $status, string $body = '{"ok":true,"accepted":0,"rejected":0}'): array
{
    $port = freePort();
    $dir = sys_get_temp_dir().'/edgewatch-test-'.bin2hex(random_bytes(4));
    mkdir($dir);
    file_put_contents("{$dir}/router.php", <<<'PHP'
        <?php
        $raw = file_get_contents('php://input');
        file_put_contents(getenv('EW_LOG'), json_encode([
            'method' => $_SERVER['REQUEST_METHOD'], 'path' => $_SERVER['REQUEST_URI'], 'headers' => array_change_key_case(getallheaders()),
            'body' => ($decoded = @gzdecode($raw)) === false ? $raw : $decoded,
        ]));
        http_response_code((int) getenv('EW_STATUS'));
        header('content-type: application/json');
        echo getenv('EW_BODY');
        PHP);
    $process = proc_open([PHP_BINARY, '-S', "127.0.0.1:{$port}", "{$dir}/router.php"], [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes, $dir, ['EW_STATUS' => (string) $status, 'EW_BODY' => $body, 'EW_LOG' => "{$dir}/request.json"]);
    for ($i = 0; $i < 100 && ($probe = @fsockopen('127.0.0.1', $port, $errno, $error, 0.05)) === false; $i++) {
        usleep(30_000);
    }
    if (is_resource($probe ?? null)) {
        fclose($probe);
    }
    $GLOBALS['edgewatchFakeIngest'][] = $process;

    return [$port, "{$dir}/request.json"];
}

function freePort(): int
{
    $socket = stream_socket_server('tcp://127.0.0.1:0');
    $port = (int) substr((string) stream_socket_get_name($socket, false), strrpos((string) stream_socket_get_name($socket, false), ':') + 1);
    fclose($socket);

    return $port;
}

afterEach(function () {
    foreach ($GLOBALS['edgewatchFakeIngest'] ?? [] as $process) {
        proc_terminate($process);
        proc_close($process);
    }
    $GLOBALS['edgewatchFakeIngest'] = [];
});

it('passes with the exact status and latency, sending only an empty batch', function () {
    [$port, $log] = fakeIngest(200);
    config(['edgewatch.ingest.uri' => "http://127.0.0.1:{$port}", 'edgewatch.project_id' => 'shop']);

    $this->artisan('edgewatch:test')
        ->expectsOutputToContain("Endpoint:  http://127.0.0.1:{$port}/api/ingest")
        ->expectsOutputToContain('PASS  HTTP 200 in ')
        ->assertExitCode(0);

    $request = json_decode((string) file_get_contents($log), true);
    expect($request)->toMatchArray(['method' => 'POST', 'path' => '/api/ingest', 'body' => '{"records":[]}'])
        ->and($request['headers'])->toMatchArray(['authorization' => 'Bearer test-token', 'x-edgewatch-project' => 'shop', 'content-encoding' => 'gzip'])
        ->and($this->transport->records())->toBe([]);
});

it('fails with the exact status, the server message and a hint', function (int $status, string $hint) {
    [$port] = fakeIngest($status, '{"error":{"code":"x","message":"Server says no."}}');
    config(['edgewatch.ingest.uri' => "http://127.0.0.1:{$port}/api/ingest"]);

    $this->artisan('edgewatch:test')
        ->expectsOutputToContain("FAIL  HTTP {$status} in ")
        ->expectsOutputToContain('Server says no.')
        ->expectsOutputToContain($hint)
        ->assertExitCode(1);
})->with([
    [401, 'The token was rejected'],
    [404, 'should end in /api/ingest'],
    [429, 'Rate limited'],
    [503, 'GET /healthz'],
]);

it('fails without an HTTP status when nothing listens', function () {
    config(['edgewatch.ingest.uri' => 'http://127.0.0.1:'.freePort()]);

    $this->artisan('edgewatch:test', ['--timeout' => 1])->expectsOutputToContain('FAIL  no HTTP response after ')->assertExitCode(1);
});

it('fails before any request when HTTP has no token', function () {
    config(['edgewatch.ingest.uri' => 'https://ingest.example.com', 'edgewatch.token' => null]);

    $this->artisan('edgewatch:test')->expectsOutputToContain('FAIL  not configured: EDGEWATCH_TOKEN')->assertExitCode(1);
});

it('checks the agent transport with a TCP connection only', function () {
    $server = stream_socket_server('tcp://127.0.0.1:0');
    $address = (string) stream_socket_get_name($server, false);
    config(['edgewatch.ingest.uri' => $address]);

    $this->artisan('edgewatch:test')->expectsOutputToContain('PASS  agent accepted a TCP connection in ')->assertExitCode(0);

    fclose($server);
    $this->artisan('edgewatch:test', ['--timeout' => 1])->expectsOutputToContain('FAIL  could not connect to the agent')->assertExitCode(1);
});

it('warns when EdgeWatch is disabled but still checks', function () {
    config(['edgewatch.enabled' => false, 'edgewatch.ingest.uri' => 'http://127.0.0.1:'.freePort()]);

    $this->artisan('edgewatch:test', ['--timeout' => 1])->expectsOutputToContain('EdgeWatch is disabled')->assertExitCode(1);
});
