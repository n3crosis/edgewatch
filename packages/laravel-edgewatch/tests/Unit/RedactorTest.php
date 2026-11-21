<?php

use EdgeWatch\Laravel\Redaction\Redactor;

beforeEach(function () {
    $this->redactor = new Redactor(
        headers: ['Authorization', 'Cookie', 'X-XSRF-TOKEN'],
        payloadFields: ['password', '_token'],
    );
});

it('redacts headers in the Nightwatch format', function () {
    $headers = $this->redactor->headers([
        'Authorization' => ['Bearer abc.def.ghi'],
        'Cookie' => ['session=abc123; theme=dark'],
        'X-XSRF-TOKEN' => ['xyz'],
        'Accept' => ['application/json'],
    ]);

    expect($headers['authorization'])->toBe(['Bearer [11 bytes redacted]'])
        ->and($headers['cookie'])->toBe(['session=[6 bytes redacted]; theme=[4 bytes redacted]'])
        ->and($headers['x-xsrf-token'])->toBe(['[3 bytes redacted]'])
        ->and($headers['accept'])->toBe(['application/json']);
});

it('redacts unknown auth schemes entirely', function () {
    expect($this->redactor->headers(['authorization' => ['Custom secret']])['authorization'])->toBe(['[13 bytes redacted]']);
});

it('redacts payload fields recursively', function () {
    expect($this->redactor->payload([
        'email' => 'a@b.co',
        'password' => 'hunter2',
        'nested' => ['password' => 'secret', 'keep' => 1],
    ]))->toBe([
        'email' => 'a@b.co',
        'password' => '[7 bytes redacted]',
        'nested' => ['password' => '[6 bytes redacted]', 'keep' => 1],
    ]);
});

it('scrubs PII from free text', function () {
    expect($this->redactor->scrub('User jane.doe@example.com paid with 4242 4242 4242 4242 using Bearer sk_live_1234567890'))
        ->toBe('User [email] paid with [card] using Bearer [redacted]');
});

it('can disable PII scrubbing', function () {
    expect((new Redactor(scrubPii: false))->scrub('jane@example.com'))->toBe('jane@example.com');
});
