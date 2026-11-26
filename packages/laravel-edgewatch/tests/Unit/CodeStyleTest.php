<?php

declare(strict_types=1);

function packagePhpFiles(): array
{
    $root = dirname(__DIR__, 2);
    $files = glob($root.'/config/*.php') ?: [];
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root.'/src', FilesystemIterator::SKIP_DOTS));
    foreach ($iterator as $file) {
        if ($file->getExtension() === 'php') {
            $files[] = $file->getPathname();
        }
    }
    sort($files);

    return $files;
}

it('declares strict_types in every source and config file', function () {
    $missing = array_values(array_filter(packagePhpFiles(), fn (string $f) => ! preg_match('/^<\?php\s+declare\(strict_types=1\);/', (string) file_get_contents($f))));

    expect(packagePhpFiles())->not->toBeEmpty()
        ->and($missing)->toBe([]);
});

it('types every class property', function () {
    $untyped = [];
    foreach (packagePhpFiles() as $file) {
        foreach (file($file) ?: [] as $n => $line) {
            if (preg_match('/^\s*(public|protected|private)(\s+static)?(\s+readonly)?\s+\$/', $line)) {
                $untyped[] = basename($file).':'.($n + 1);
            }
        }
    }

    expect($untyped)->toBe([]);
});
