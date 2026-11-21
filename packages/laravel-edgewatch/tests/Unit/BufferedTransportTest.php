<?php

use EdgeWatch\Laravel\Tests\FakeTransport;
use EdgeWatch\Laravel\Transport\BufferedTransport;
use EdgeWatch\Laravel\Transport\Transport;

it('flushes automatically when the buffer reaches capacity', function () {
    $fake = new FakeTransport;
    $buffer = new BufferedTransport($fake, capacity: 3);

    foreach (range(1, 7) as $i) {
        $buffer->write(['i' => $i]);
    }

    expect($fake->batches)->toHaveCount(2)
        ->and($buffer->count())->toBe(1);

    $buffer->flush();

    expect($fake->batches)->toHaveCount(3)
        ->and(array_column($fake->records(), 'i'))->toBe(range(1, 7));
});

it('never lets transport failures escape', function () {
    $errors = [];
    $buffer = new BufferedTransport(new class implements Transport {
        public function send(array $records): void { throw new RuntimeException('agent down'); }
    }, onError: function ($e) use (&$errors) { $errors[] = $e->getMessage(); });

    $buffer->write(['t' => 'query']);
    $buffer->flush();

    expect($errors)->toBe(['agent down'])->and($buffer->count())->toBe(0);
});

it('does not send when empty', function () {
    $fake = new FakeTransport;
    (new BufferedTransport($fake))->flush();

    expect($fake->batches)->toBe([]);
});
