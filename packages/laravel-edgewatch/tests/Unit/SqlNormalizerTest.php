<?php

use EdgeWatch\Laravel\Sql\SqlNormalizer;

$fixtures = json_decode(file_get_contents(__DIR__.'/../../../../fixtures/sql-normalization.json'), true);

it('normalizes SQL by stripping literals', function (string $sql, string $normalized) {
    expect(SqlNormalizer::normalize($sql))->toBe($normalized);
})->with(array_combine(
    array_column($fixtures, 'name'),
    array_map(fn ($f) => [$f['sql'], $f['normalized']], $fixtures),
));

it('hashes the normalized SQL with a 128-bit SHA-256 prefix', function () {
    $hash = SqlNormalizer::hash("select * from users where id = 1");

    expect($hash)->toHaveLength(32)
        ->and($hash)->toBe(substr(hash('sha256', 'select * from users where id = ?'), 0, 32))
        ->and(SqlNormalizer::hash('select * from users where id = 99'))->toBe($hash);
});

it('produces different hashes for structurally different queries', function () {
    expect(SqlNormalizer::hash('select * from users'))->not->toBe(SqlNormalizer::hash('select * from posts'));
});
