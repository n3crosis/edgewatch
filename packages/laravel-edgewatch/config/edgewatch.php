<?php

// Keys mirror config/nightwatch.php (laravel/nightwatch v1.30.6). Every EDGEWATCH_* variable
// falls back to its NIGHTWATCH_* counterpart so an existing Nightwatch .env works unchanged.

$csv = static fn (?string $value, string $default): array => array_values(array_filter(array_map('trim', explode(',', $value ?? $default))));

return [
    'enabled' => env('EDGEWATCH_ENABLED', env('NIGHTWATCH_ENABLED', true)),
    'token' => env('EDGEWATCH_TOKEN', env('NIGHTWATCH_TOKEN')),
    'deployment' => env('EDGEWATCH_DEPLOY', env('NIGHTWATCH_DEPLOY', env('LARAVEL_CLOUD_DEPLOY_UUID', env('FORGE_DEPLOY_COMMIT', env('VAPOR_COMMIT_HASH'))))),
    'server' => env('EDGEWATCH_SERVER', env('NIGHTWATCH_SERVER')),
    'capture_request_payload' => env('EDGEWATCH_CAPTURE_REQUEST_PAYLOAD', env('NIGHTWATCH_CAPTURE_REQUEST_PAYLOAD', false)),
    'redact_payload_fields' => $csv(env('EDGEWATCH_REDACT_PAYLOAD_FIELDS', env('NIGHTWATCH_REDACT_PAYLOAD_FIELDS')), '_token,password,password_confirmation,current_password'),
    'redact_headers' => $csv(env('EDGEWATCH_REDACT_HEADERS', env('NIGHTWATCH_REDACT_HEADERS')), 'Authorization,Cookie,Proxy-Authorization,X-CSRF-TOKEN,X-XSRF-TOKEN'),

    // EdgeWatch additions.
    'redact_sql_literals' => env('EDGEWATCH_REDACT_SQL_LITERALS', true),
    'scrub_pii' => env('EDGEWATCH_SCRUB_PII', true),

    'sampling' => [
        'requests' => env('EDGEWATCH_REQUEST_SAMPLE_RATE', env('NIGHTWATCH_REQUEST_SAMPLE_RATE', 1.0)),
        'exceptions' => env('EDGEWATCH_EXCEPTION_SAMPLE_RATE', env('NIGHTWATCH_EXCEPTION_SAMPLE_RATE', 1.0)),
    ],

    'filtering' => [
        'ignore_queries' => env('EDGEWATCH_IGNORE_QUERIES', env('NIGHTWATCH_IGNORE_QUERIES', false)),
    ],

    'ingest' => [
        // auto: http(s):// URIs use the direct HTTP transport, host:port URIs speak the Nightwatch agent TCP protocol.
        'transport' => env('EDGEWATCH_TRANSPORT', 'auto'),
        'uri' => env('EDGEWATCH_INGEST_URI', env('NIGHTWATCH_INGEST_URI', '127.0.0.1:2407')),
        'timeout' => env('EDGEWATCH_INGEST_TIMEOUT', env('NIGHTWATCH_INGEST_TIMEOUT', 0.5)),
        'connection_timeout' => env('EDGEWATCH_INGEST_CONNECTION_TIMEOUT', env('NIGHTWATCH_INGEST_CONNECTION_TIMEOUT', 0.5)),
        'event_buffer' => env('EDGEWATCH_INGEST_EVENT_BUFFER', env('NIGHTWATCH_INGEST_EVENT_BUFFER', 500)),
    ],
];
