<?php

use EdgeWatch\Laravel\Support\Uuid7;

it('generates RFC 9562 version 7 UUIDs', function () {
    $uuid = (new Uuid7)->generate();

    expect(Uuid7::isValid($uuid))->toBeTrue()
        ->and($uuid[14])->toBe('7')
        ->and(in_array($uuid[19], ['8', '9', 'a', 'b'], true))->toBeTrue();
});

it('encodes the unix millisecond timestamp in the first 48 bits', function () {
    $uuid = (new Uuid7(clock: fn () => 1_763_750_000_123))->generate();

    expect(Uuid7::timestamp($uuid))->toBe(1_763_750_000_123)
        ->and(substr($uuid, 0, 13))->toBe('019aa7b1-35fb');
});

it('is monotonic and unique within the same millisecond', function () {
    $generator = new Uuid7(clock: fn () => 1_700_000_000_000);
    $ids = array_map(fn () => $generator->generate(), range(1, 5000));

    $sorted = $ids;
    sort($sorted, SORT_STRING);

    expect($ids)->toBe($sorted)
        ->and(array_unique($ids))->toHaveCount(5000)
        ->and(collect($ids)->every(fn ($id) => Uuid7::isValid($id)))->toBeTrue();
});

it('sorts by time across milliseconds', function () {
    $now = 1_700_000_000_000;
    $generator = new Uuid7(clock: function () use (&$now) { return $now++; });

    $a = $generator->generate();
    $b = $generator->generate();

    expect(strcmp($a, $b))->toBeLessThan(0);
});
