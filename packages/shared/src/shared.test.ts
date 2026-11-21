import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeSql, signIngestToken, sqlHash, validateRecords, verifyIngestToken } from './index';

const fixtures: { name: string; sql: string; normalized: string }[] = JSON.parse(
  readFileSync(new URL('../../../fixtures/sql-normalization.json', import.meta.url), 'utf8'),
);

describe('normalizeSql', () => {
  it.each(fixtures)('$name', ({ sql, normalized }) => {
    expect(normalizeSql(sql)).toBe(normalized);
  });

  it('hashes like the PHP client (sha256 prefix of the normalized SQL)', async () => {
    // Same value as SqlNormalizerTest: substr(hash('sha256', 'select * from users where id = ?'), 0, 32)
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update('select * from users where id = ?').digest('hex').slice(0, 32);
    expect(await sqlHash('select * from users where id = 42')).toBe(expected);
  });
});

describe('ingest tokens', () => {
  it('round-trips and rejects tampering or expiry', async () => {
    const token = await signIngestToken({ p: 'proj_1', exp: 2_000 }, 'secret');
    expect(await verifyIngestToken(token, 'secret', 1_000)).toEqual({ p: 'proj_1', exp: 2_000 });
    expect(await verifyIngestToken(token, 'other', 1_000)).toBeNull();
    expect(await verifyIngestToken(token, 'secret', 3_000)).toBeNull();
    expect(await verifyIngestToken(token.replace('ewt.e', 'ewt.f'), 'secret', 1_000)).toBeNull();
    expect(await verifyIngestToken('garbage', 'secret')).toBeNull();
  });
});

describe('validateRecords', () => {
  const base = { timestamp: 1_763_750_000.123, trace_id: '019aa7b1-35fb-7000-8000-000000000000', server: 'web-1', _group: 'g', deploy: 'v1', user: '' };

  it('accepts Nightwatch records, passes unknown fields and types through, and rejects malformed ones', () => {
    const { records, rejected } = validateRecords([
      { v: 1, t: 'query', ...base, sql: 'select 1', file: 'app/x.php', line: 3, duration: 1200, connection: 'mysql', connection_type: 'read', extra_field: true },
      { v: 3, t: 'exception', ...base, class: 'E', file: 'f', line: 1, message: 'm', code: 0, trace: '[]', handled: false, php_version: '8.3', laravel_version: '11' },
      { v: 1, t: 'future-type', anything: 1 },
      { v: 1, t: 'query', ...base, duration: -1 },
      'nope',
    ]);

    expect(records).toHaveLength(3);
    expect(records[0].extra_field).toBe(true);
    expect(records[1].code).toBe('0');
    expect(rejected.map((r) => r.index)).toEqual([3, 4]);
    expect(rejected[0].issues.join()).toContain('sql');
  });
});
