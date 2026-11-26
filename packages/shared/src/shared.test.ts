import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BrowserEvent, browserEventToRecord, normalizeSql, signIngestToken, sqlHash, usableKey, validateRecords, verifyIngestToken } from './index';

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

  it('accepts optional environments and rejects malformed environment metadata', () => {
    const request = { v: 1, t: 'request', ...base, method: 'GET', url: 'https://test/', status_code: 200, duration: 1000 };
    const result = validateRecords([request, { ...request, environment: null }, { ...request, environment: 'production' }, { ...request, environment: 42 }, { ...request, environment: 'x'.repeat(129) }]);
    expect(result.records).toHaveLength(3);
    expect(result.records[2].environment).toBe('production');
    expect(result.rejected.map((item) => item.index)).toEqual([3, 4]);
  });

  it('treats inherited object property names as unknown record types', () => {
    const types = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
    const result = validateRecords(types.map((t) => ({ v: 1, t, payload: 'kept' })));
    expect(result.rejected).toEqual([]);
    expect(result.records.map((r) => r.t)).toEqual(types);
    expect(result.records.every((r) => r.payload === 'kept')).toBe(true);
  });

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

describe('scrubPii', () => {
  it('masks emails, card numbers and bearer tokens like the PHP client', async () => {
    const { scrubPii } = await import('./index');
    expect(scrubPii('User jane.doe@example.com paid with 4242 4242 4242 4242 using Bearer sk_live_1234567890'))
      .toBe('User [email] paid with [card] using Bearer [redacted]');
  });
});

describe('observability helpers', () => {
  it('redacts secret-looking keys and scrubs PII from logged values', async () => {
    const { redact } = await import('./observability');
    const out = redact({ authorization: 'Bearer ew_live_x', api_key: 'k', token: 't', nested: { password: 'p', note: 'mail jane@example.com, card 4242 4242 4242 4242' }, path: '/api/ingest' }) as any;
    expect(out.authorization).toBe('[redacted]');
    expect(out.api_key).toBe('[redacted]');
    expect(out.token).toBe('[redacted]');
    expect(out.nested.password).toBe('[redacted]');
    expect(out.nested.note).toBe('mail [email], card [card]');
    expect(out.path).toBe('/api/ingest');
  });

  it('builds the shared error body and safe request ids', async () => {
    const { errorBody, requestIdFrom } = await import('./observability');
    expect(errorBody('forbidden', 'No.', 'req-1')).toEqual({ error: { code: 'forbidden', message: 'No.' }, message: 'No.', request_id: 'req-1' });
    expect(requestIdFrom(new Headers({ 'x-request-id': 'abc-123' }))).toBe('abc-123');
    expect(requestIdFrom(new Headers({ 'x-request-id': 'bad id <script>' }))).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('usableKey', () => {
  const key = { project_id: 'p', name: 'k', scopes: ['ingest' as const] };
  it('accepts active keys with the scope and rejects missing, revoked, expired or wrong-scope keys', async () => {
    expect(usableKey(key, 'ingest', 100)).toBe(true);
    expect(usableKey({ ...key, expires_at: 101 }, 'ingest', 100)).toBe(true);
    expect(usableKey({ ...key, expires_at: 100 }, 'ingest', 100)).toBe(false);
    expect(usableKey({ ...key, disabled: true }, 'ingest', 100)).toBe(false);
    expect(usableKey(key, 'read', 100)).toBe(false);
    expect(usableKey(null, 'ingest')).toBe(false);
  });
});

describe('browser breadcrumbs and web vitals', () => {
  const base = { timestamp: 1_700_000_000, url: 'https://shop.test/cart?x=1', release: 'v1' };
  it('turns a vitals event into a web-vital record for the page path', async () => {
    const r = await browserEventToRecord(BrowserEvent.parse({ ...base, type: 'vitals', vitals: { lcp: 1200, inp: 80, cls: 0.01, fcp: 600 } }));
    expect(r).toMatchObject({ t: 'web-vital', path: '/cart', lcp: 1200, inp: 80, cls: 0.01, fcp: 600, ttfb: null, execution_source: 'browser' });
  });
  it('attaches PII-scrubbed breadcrumbs to browser exceptions and rejects oversized lists', async () => {
    const crumb = { timestamp: 1, category: 'console', message: 'login failed for jane@example.com', data: { url: '/u?email=jane@example.com', n: 1 } };
    const r = await browserEventToRecord(BrowserEvent.parse({ ...base, message: 'x', breadcrumbs: [crumb] }));
    const crumbs = (r.browser as { breadcrumbs: { message: string; data: Record<string, unknown> }[] }).breadcrumbs;
    expect(crumbs[0].message).not.toContain('jane@example.com');
    expect(String(crumbs[0].data.url)).not.toContain('jane@example.com');
    expect(BrowserEvent.safeParse({ ...base, message: 'x', breadcrumbs: Array(31).fill(crumb) }).success).toBe(false);
    expect(BrowserEvent.safeParse({ ...base, type: 'vitals', vitals: { lcp: -1 } }).success).toBe(false);
  });
});
