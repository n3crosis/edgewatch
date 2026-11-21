<?php

use EdgeWatch\Laravel\Transport\AgentTransport;

function socketPair(string $ack = '2:OK'): array
{
    [$client, $agent] = stream_socket_pair(STREAM_PF_UNIX, STREAM_SOCK_STREAM, STREAM_IPPROTO_IP);
    fwrite($agent, $ack);

    return [$client, $agent];
}

it('computes the token hash like laravel/nightwatch', function () {
    expect(AgentTransport::tokenHash('my-token'))->toBe(substr(hash('xxh128', 'my-token'), 0, 7))
        ->and(AgentTransport::tokenHash('my-token'))->toHaveLength(7);
});

it('frames payloads as <length>:v1:<tokenHash>:<body>', function () {
    expect(AgentTransport::frame('[]', 'abc1234'))->toBe('13:v1:abc1234:[]');
});

it('writes a framed JSON payload and accepts the 2:OK acknowledgement', function () {
    [$client, $agent] = socketPair();
    $usedTimeout = null;

    $transport = new AgentTransport('127.0.0.1:2407', 'secret', 0.5, 0.5, function (string $address, float $timeout) use ($client, &$usedTimeout) {
        expect($address)->toBe('tcp://127.0.0.1:2407');
        $usedTimeout = $timeout;

        return $client;
    });

    $transport->send([['v' => 1, 't' => 'query', 'sql' => 'select 1', 'duration' => 1.0]]);

    $hash = AgentTransport::tokenHash('secret');
    $body = '[{"v":1,"t":"query","sql":"select 1","duration":1.0}]';

    expect(stream_get_contents($agent))->toBe((strlen("v1:{$hash}:") + strlen($body)).":v1:{$hash}:{$body}")
        ->and($usedTimeout)->toBe(0.5);
});

it('throws when the agent does not acknowledge', function () {
    [$client, $agent] = socketPair('NOPE');

    (new AgentTransport('127.0.0.1:2407', 'secret', streamFactory: fn () => $client))->send([['t' => 'query']]);
})->throws(RuntimeException::class, 'Unexpected response from agent [NOPE]');

it('fails fast when no agent is listening', function () {
    $start = microtime(true);

    expect(fn () => (new AgentTransport('127.0.0.1:1', 'secret'))->send([['t' => 'query']]))->toThrow(RuntimeException::class)
        ->and(microtime(true) - $start)->toBeLessThan(1.0);
});
