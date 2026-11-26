<?php

use EdgeWatch\Laravel\Support\IngestTarget;

it('detects the transport from the ingest URI', function (string $uri, string $transport, string $resolved) {
    expect(IngestTarget::resolve('auto', $uri, 'ew_live_x'))->toMatchArray(['transport' => $transport, 'uri' => $resolved]);
})->with([
    'nothing set' => ['', 'agent', '127.0.0.1:2407'],
    'agent address' => ['127.0.0.1:2407', 'agent', '127.0.0.1:2407'],
    'agent by hostname' => ['nightwatch-agent:2407', 'agent', 'nightwatch-agent:2407'],
    'full URL' => ['https://ingest.example.com/api/ingest', 'http', 'https://ingest.example.com/api/ingest'],
    'URL without a path' => ['https://ingest.example.com', 'http', 'https://ingest.example.com/api/ingest'],
    'URL with a trailing slash' => ['http://127.0.0.1:8080/', 'http', 'http://127.0.0.1:8080/api/ingest'],
    'bare hostname' => ['edgewatch-ingest.acme.workers.dev', 'http', 'https://edgewatch-ingest.acme.workers.dev/api/ingest'],
    'hostname with a path' => ['ingest.example.com/custom/ingest', 'http', 'https://ingest.example.com/custom/ingest'],
    'custom path kept' => ['https://proxy.example.com/edgewatch/ingest', 'http', 'https://proxy.example.com/edgewatch/ingest'],
    'surrounding spaces' => ['  https://ingest.example.com  ', 'http', 'https://ingest.example.com/api/ingest'],
]);

it('turns HTTP off without a token instead of sending requests that get 401', function () {
    expect(IngestTarget::resolve('auto', 'https://ingest.example.com', null))->toMatchArray(['transport' => 'null'])
        ->and(IngestTarget::resolve('http', 'https://ingest.example.com', '  ')['reason'])->toContain('EDGEWATCH_TOKEN')
        ->and(IngestTarget::resolve('auto', '127.0.0.1:2407', null))->toMatchArray(['transport' => 'agent']);
});

it('honours an explicit transport and rejects unknown ones', function () {
    expect(IngestTarget::resolve('agent', 'https://ingest.example.com', 't')['transport'])->toBe('agent')
        ->and(IngestTarget::resolve('HTTP', 'ingest.example.com:8443', 't'))->toMatchArray(['transport' => 'http', 'uri' => 'https://ingest.example.com:8443/api/ingest'])
        ->and(IngestTarget::resolve('null', 'https://x.test', 't')['transport'])->toBe('null')
        ->and(IngestTarget::resolve('carrier-pigeon', 'https://x.test', 't'))->toMatchArray(['transport' => 'null', 'reason' => 'unknown EDGEWATCH_TRANSPORT "carrier-pigeon" (use auto, http or agent)']);
});

it('prints the endpoint without credentials or query string', function () {
    expect(IngestTarget::display('https://user:secret@ingest.example.com:8443/api/ingest?key=abc'))->toBe('https://ingest.example.com:8443/api/ingest')
        ->and(IngestTarget::display('127.0.0.1:2407'))->toBe('127.0.0.1:2407');
});
