import { shortHash } from './crypto';

/**
 * Port of packages/laravel-edgewatch/src/Sql/SqlNormalizer.php. Both implementations are tested
 * against fixtures/sql-normalization.json and must produce identical output.
 */
const PATTERNS: [RegExp, string][] = [
  [/'(?:[^'\\]|\\[\s\S]|'')*'/g, '?'],
  [/\$\d+/g, '?'],
  [/\b0x[0-9a-f]+\b/gi, '?'],
  [/(?<![\w$.])\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi, '?'],
  [/\s+/g, ' '],
  [/\bin\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/gi, 'in (?)'],
  [/\bvalues\s*\(\s*\?(?:\s*,\s*\?)*\s*\)(?:\s*,\s*\(\s*\?(?:\s*,\s*\?)*\s*\))*/gi, 'values (...)'],
];

export function normalizeSql(sql: string): string {
  return PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), sql).trim();
}

export function sqlHash(sql: string): Promise<string> {
  return shortHash(normalizeSql(sql));
}
