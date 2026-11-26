<?php

declare(strict_types=1);

namespace EdgeWatch\Laravel\Sql;

/**
 * Strips literals from SQL so structurally identical queries share a hash, and so values never leave the app.
 * Must stay in sync with workers/consumer/src/sql.ts (both are tested against fixtures/sql-normalization.json).
 */
final class SqlNormalizer
{
    private const PATTERNS = [
        // single-quoted strings, supporting '' and backslash escapes
        '/\'(?:[^\'\\\\]|\\\\.|\'\')*\'/s' => '?',
        // postgres numbered placeholders
        '/\$\d+/' => '?',
        // hex literals
        '/\b0x[0-9a-f]+\b/i' => '?',
        // numeric literals not attached to identifiers
        '/(?<![\w$.])\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/i' => '?',
        // whitespace
        '/\s+/' => ' ',
        // IN (?, ?, ?) -> IN (?)
        '/\bin\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/i' => 'in (?)',
        // VALUES (?, ?), (?, ?) -> VALUES (...)
        '/\bvalues\s*\(\s*\?(?:\s*,\s*\?)*\s*\)(?:\s*,\s*\(\s*\?(?:\s*,\s*\?)*\s*\))*/i' => 'values (...)',
    ];

    public static function normalize(string $sql): string
    {
        foreach (self::PATTERNS as $pattern => $replacement) {
            $sql = preg_replace($pattern, $replacement, $sql) ?? $sql;
        }

        return trim($sql);
    }

    /**
     * First 32 hex chars (128 bits) of SHA-256 over the normalized SQL.
     */
    public static function hash(string $sql): string
    {
        return substr(hash('sha256', self::normalize($sql)), 0, 32);
    }
}
