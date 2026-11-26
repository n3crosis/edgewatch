<?php

declare(strict_types=1);

// Keys mirror config/nightwatch.php (laravel/nightwatch v1.30.6). Every EDGEWATCH_* variable
// falls back to its NIGHTWATCH_* counterpart so an existing Nightwatch .env works unchanged.

$csv = static fn (?string $value, string $default): array => array_values(array_filter(array_map('trim', explode(',', $value ?? $default))));

// First of the given variables that is set to a non-blank string (trimmed). `EDGEWATCH_TOKEN=` (empty) therefore falls
// back to NIGHTWATCH_TOKEN instead of sending an empty token, and `EDGEWATCH_PROJECT_ID=` means "no project tag".
$firstSet = static function (string ...$keys): ?string {
    foreach ($keys as $key) {
        $value = env($key);
        if (is_string($value) && trim($value) !== '') {
            return trim($value);
        }
    }

    return null;
};

return [
    'enabled' => env('EDGEWATCH_ENABLED', env('NIGHTWATCH_ENABLED', true)),
    // Ingest key. EdgeWatch is single-tenant, so one key can serve all your apps; EDGEWATCH_TOKEN wins over the
    // NIGHTWATCH_TOKEN shared with the Nightwatch agent.
    'token' => $firstSet('EDGEWATCH_TOKEN', 'NIGHTWATCH_TOKEN'),
    // Project tag for this app (sent as X-EdgeWatch-Project by the HTTP transport). Unset or blank: EdgeWatch files
    // the data under the ingest key's default project. The agent (TCP) transport cannot carry a tag.
    'project_id' => $firstSet('EDGEWATCH_PROJECT_ID'),
    'deployment' => env('EDGEWATCH_DEPLOY', env('NIGHTWATCH_DEPLOY', env('LARAVEL_CLOUD_DEPLOY_UUID', env('FORGE_DEPLOY_COMMIT', env('VAPOR_COMMIT_HASH'))))),
    'server' => env('EDGEWATCH_SERVER', env('NIGHTWATCH_SERVER')),
    'capture_request_payload' => env('EDGEWATCH_CAPTURE_REQUEST_PAYLOAD', env('NIGHTWATCH_CAPTURE_REQUEST_PAYLOAD', false)),
    'redact_payload_fields' => $csv(env('EDGEWATCH_REDACT_PAYLOAD_FIELDS', env('NIGHTWATCH_REDACT_PAYLOAD_FIELDS')), '_token,password,password_confirmation,current_password'),
    'redact_headers' => $csv(env('EDGEWATCH_REDACT_HEADERS', env('NIGHTWATCH_REDACT_HEADERS')), 'Authorization,Cookie,Proxy-Authorization,X-CSRF-TOKEN,X-XSRF-TOKEN'),

    // EdgeWatch additions.
    'environment' => env('EDGEWATCH_ENVIRONMENT', env('APP_ENV', 'production')),
    'redact_sql_literals' => env('EDGEWATCH_REDACT_SQL_LITERALS', true),
    'scrub_pii' => env('EDGEWATCH_SCRUB_PII', true),

    'sampling' => [
        'requests' => env('EDGEWATCH_REQUEST_SAMPLE_RATE', env('NIGHTWATCH_REQUEST_SAMPLE_RATE', 1.0)),
        'commands' => env('EDGEWATCH_COMMAND_SAMPLE_RATE', env('NIGHTWATCH_COMMAND_SAMPLE_RATE', 1.0)),
        'exceptions' => env('EDGEWATCH_EXCEPTION_SAMPLE_RATE', env('NIGHTWATCH_EXCEPTION_SAMPLE_RATE', 1.0)),
    ],

    'filtering' => [
        'ignore_queries' => env('EDGEWATCH_IGNORE_QUERIES', env('NIGHTWATCH_IGNORE_QUERIES', false)),
        'ignore_outgoing_requests' => env('EDGEWATCH_IGNORE_OUTGOING_REQUESTS', env('NIGHTWATCH_IGNORE_OUTGOING_REQUESTS', false)),
        'log_level' => env('EDGEWATCH_LOG_LEVEL', env('NIGHTWATCH_LOG_LEVEL', 'debug')),
        'ignore_mail' => env('EDGEWATCH_IGNORE_MAIL', env('NIGHTWATCH_IGNORE_MAIL', false)),
        'ignore_notifications' => env('EDGEWATCH_IGNORE_NOTIFICATIONS', env('NIGHTWATCH_IGNORE_NOTIFICATIONS', false)),
        'ignore_cache_events' => env('EDGEWATCH_IGNORE_CACHE_EVENTS', env('NIGHTWATCH_IGNORE_CACHE_EVENTS', false)),
        // Long-running worker/server commands: their jobs/requests are traced individually instead.
        'ignore_commands' => $csv(env('EDGEWATCH_IGNORE_COMMANDS'), 'queue:work,queue:listen,horizon,horizon:work,horizon:supervisor,schedule:work,octane:start,octane:frankenphp,octane:roadrunner,octane:swoole,reverb:start,serve,nightwatch:agent,pail,tinker'),
    ],

    'ingest' => [
        // auto: http(s):// URIs use the direct HTTP transport, host:port URIs speak the Nightwatch agent TCP protocol.
        'transport' => env('EDGEWATCH_TRANSPORT', 'auto'),
        'uri' => $firstSet('EDGEWATCH_INGEST_URI', 'NIGHTWATCH_INGEST_URI') ?? '127.0.0.1:2407',
        'timeout' => env('EDGEWATCH_INGEST_TIMEOUT', env('NIGHTWATCH_INGEST_TIMEOUT', 0.5)),
        'connection_timeout' => env('EDGEWATCH_INGEST_CONNECTION_TIMEOUT', env('NIGHTWATCH_INGEST_CONNECTION_TIMEOUT', 0.5)),
        'event_buffer' => env('EDGEWATCH_INGEST_EVENT_BUFFER', env('NIGHTWATCH_INGEST_EVENT_BUFFER', 500)),
    ],
];
