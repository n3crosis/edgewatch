import { apiKeyKvKey, signIngestToken, type IngestMessage } from '@edgewatch/shared';
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import app, { type Env } from '../src/index';

const INGEST_KEY = 'ew_live_test_key';
const READ_KEY = 'ew_read_test_key';
const TRACE_A = '019aa7b1-35fb-7000-8000-00000000000a';
const TRACE_B = '0f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b'; // UUIDv4, as laravel/nightwatch generates

const agentHeaders = { accept: 'application/json', 'content-type': 'application/json', 'nightwatch-server': 'web-1', 'user-agent': 'NightwatchAgent/1.30.6' };

const query = (trace_id: string, sql = 'select * from users where id = ?') => ({
  v: 1, t: 'query', timestamp: 1763750000.1234, deploy: 'v1', server: 'web-1', _group: 'abc', trace_id, execution_source: 'request',
  execution_id: trace_id, execution_preview: 'GET /', execution_stage: 'action', user: '42', sql, file: 'app/Http/Controllers/HomeController.php', line: 12, duration: 1530, connection: 'mysql', connection_type: 'read',
});

let sent: IngestMessage[];
let testEnv: Env;

async function gzip(text: string): Promise<ArrayBuffer> {
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
}

async function call(path: string, init: RequestInit) {
  return app.fetch(new Request(`https://ingest.edgewatch.test${path}`, init), testEnv);
}

beforeAll(async () => {
  await env.API_KEYS.put(await apiKeyKvKey(INGEST_KEY), JSON.stringify({ project_id: 'proj_1', name: 'test', scopes: ['ingest'] }));
  await env.API_KEYS.put(await apiKeyKvKey(READ_KEY), JSON.stringify({ project_id: 'proj_1', name: 'read', scopes: ['read'] }));
});

beforeEach(() => {
  sent = [];
  const queue = {
    send: async (body: IngestMessage) => void sent.push(body),
    sendBatch: async (messages: Iterable<{ body: IngestMessage }>) => void [...messages].forEach((m) => sent.push(m.body)),
  } as unknown as Queue<IngestMessage>;
  testEnv = { ...(env as unknown as Env), INGEST_QUEUE: queue };
});

describe('POST /api/agent-auth (Nightwatch agent contract)', () => {
  it('exchanges NIGHTWATCH_TOKEN for a short-lived ingest token in the exact shape the agent validates', async () => {
    const res = await call('/api/agent-auth', { method: 'POST', headers: { ...agentHeaders, authorization: `Bearer ${INGEST_KEY}` }, body: '{}' });
    const json = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(Object.keys(json).sort()).toEqual(['expires_in', 'ingest_url', 'refresh_in', 'token']);
    expect(json.token).toMatch(/^ewt\./);
    expect(Number.isInteger(json.expires_in)).toBe(true);
    expect(Number.isInteger(json.refresh_in)).toBe(true);
    expect(json.refresh_in as number).toBeLessThan(json.expires_in as number);
    expect(json.ingest_url).toBe('https://ingest.edgewatch.test/api/ingest');
  });

  it.each([
    ['missing token', {}],
    ['unknown token', { authorization: 'Bearer nope' }],
    ['read-only key', { authorization: `Bearer ${READ_KEY}` }],
  ])('rejects %s with 401 and a message', async (_, headers) => {
    const res = await call('/api/agent-auth', { method: 'POST', headers: { ...agentHeaders, ...headers }, body: '{}' });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ message: 'Unauthenticated.', error: { code: 'unauthenticated', message: 'Unauthenticated.' } });
  });
});

describe('POST /api/ingest', () => {
  async function agentToken() {
    const res = await call('/api/agent-auth', { method: 'POST', headers: { ...agentHeaders, authorization: `Bearer ${INGEST_KEY}` }, body: '{}' });
    return ((await res.json()) as { token: string }).token;
  }

  it('accepts a gzip batch from the agent and enqueues one message per trace', async () => {
    const body = JSON.stringify({ records: [query(TRACE_A), query(TRACE_B), query(TRACE_A, 'select 1'), { v: 1, t: 'user', timestamp: 1763750000, id: '42', name: 'Jane', username: 'jane@example.com' }] });
    const res = await call('/api/ingest', {
      method: 'POST',
      headers: { ...agentHeaders, 'content-encoding': 'gzip', authorization: `Bearer ${await agentToken()}` },
      body: await gzip(body),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, accepted: 4, rejected: 0 });
    expect(sent.map((m) => [m.trace_id, m.records?.length])).toEqual([[TRACE_A, 2], [TRACE_B, 1], [null, 1]]);
    expect(sent[0]).toMatchObject({ project_id: 'proj_1', server: 'web-1' });
  });

  it('accepts plain JSON authenticated with a raw ingest key (direct HTTP sender)', async () => {
    const res = await call('/api/ingest', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${INGEST_KEY}` }, body: JSON.stringify({ records: [query(TRACE_A)] }) });

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('drops invalid records but keeps valid ones and passes unknown record types through', async () => {
    const res = await call('/api/ingest', {
      method: 'POST',
      headers: { authorization: `Bearer ${INGEST_KEY}` },
      body: JSON.stringify({ records: [query(TRACE_A), { v: 1, t: 'query', trace_id: TRACE_A }, { v: 1, t: 'brand-new-type', trace_id: TRACE_A }, ...['__proto__', 'constructor', 'toString', 'hasOwnProperty'].map((t) => ({ v: 1, t, trace_id: TRACE_A }))] }),
    });
    const json = (await res.json()) as { accepted: number; rejected: number; errors: { index: number }[] };

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ accepted: 6, rejected: 1 });
    expect(json.errors[0].index).toBe(1);
  });

  it('parks oversized trace groups in R2 instead of exceeding the queue message limit', async () => {
    const records = Array.from({ length: 400 }, (_, i) => query(TRACE_A, `select * from t where c = ? /* ${'x'.repeat(200)} ${i} */`));
    const res = await call('/api/ingest', { method: 'POST', headers: { authorization: `Bearer ${INGEST_KEY}` }, body: JSON.stringify({ records }) });

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].records).toBeUndefined();
    const parked = await env.TRACES.get(sent[0].r2_key!);
    expect(((await parked!.json()) as unknown[]).length).toBe(400);
  });

  it('splits a parked trace over 1 MB into parts the consumer can load one at a time', async () => {
    const records = Array.from({ length: 6000 }, (_, i) => query(TRACE_A, `select * from t where c = ? /* ${'x'.repeat(200)} ${i} */`));
    const res = await call('/api/ingest', { method: 'POST', headers: { authorization: `Bearer ${INGEST_KEY}` }, body: JSON.stringify({ records }) });

    expect(res.status).toBe(200);
    expect(sent.length).toBeGreaterThan(1);
    let total = 0;
    for (const message of sent) {
      expect(message.trace_id).toBe(TRACE_A);
      const parked = await env.TRACES.get(message.r2_key!);
      expect(parked!.size).toBeLessThanOrEqual(1_000_000);
      total += ((await parked!.json()) as unknown[]).length;
    }
    expect(total).toBe(6000);
  });

  it.each([
    ['no token', undefined],
    ['bad token', 'Bearer ewt.forged.token'],
    ['read-only key', `Bearer ${READ_KEY}`],
  ])('rejects %s with 401', async (_, authorization) => {
    const res = await call('/api/ingest', { method: 'POST', headers: authorization ? { authorization } : {}, body: JSON.stringify({ records: [] }) });
    expect(res.status).toBe(401);
  });

  it('rejects expired agent tokens with 401 so the agent re-authenticates', async () => {
    const expired = await signIngestToken({ p: 'proj_1', exp: Math.floor(Date.now() / 1000) - 1 }, 'test-secret');
    const res = await call('/api/ingest', { method: 'POST', headers: { authorization: `Bearer ${expired}` }, body: JSON.stringify({ records: [] }) });
    expect(res.status).toBe(401);
  });

  it.each([
    ['malformed JSON', '{"records": [', 422],
    ['missing records', '{"data": []}', 422],
  ])('returns %s as %i', async (_, body, status) => {
    const res = await call('/api/ingest', { method: 'POST', headers: { authorization: `Bearer ${INGEST_KEY}` }, body });
    expect(res.status).toBe(status);
    expect(await res.json()).toHaveProperty('message');
  });

  it('enforces the body size limit', async () => {
    testEnv.MAX_BODY_BYTES = '100';
    const res = await call('/api/ingest', { method: 'POST', headers: { authorization: `Bearer ${INGEST_KEY}` }, body: JSON.stringify({ records: [query(TRACE_A)] }) });
    expect(res.status).toBe(413);
  });

  const sized = (bytes: number) => {
    const base = JSON.stringify({ records: [] });
    return base.slice(0, -1) + ' '.repeat(bytes - base.length) + '}';
  };
  const streamed = (text: string) => new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = new TextEncoder().encode(text);
      for (let i = 0; i < bytes.length; i += 64) controller.enqueue(bytes.slice(i, i + 64));
      controller.close();
    },
  });

  it('accepts a body exactly at MAX_BODY_BYTES and rejects one byte more with 413, by Content-Length', async () => {
    testEnv.MAX_BODY_BYTES = '1000';
    const headers = { authorization: `Bearer ${INGEST_KEY}`, 'content-type': 'application/json' };
    const atLimit = await call('/api/ingest', { method: 'POST', headers: { ...headers, 'content-length': '1000' }, body: sized(1000) });
    expect(atLimit.status).toBe(200);
    const over = await call('/api/ingest', { method: 'POST', headers: { ...headers, 'content-length': '1001' }, body: sized(1001) });
    expect(over.status).toBe(413);
    expect(await over.json()).toMatchObject({ error: { code: 'payload_too_large' } });
  });

  it('enforces MAX_BODY_BYTES on a streamed body without Content-Length', async () => {
    testEnv.MAX_BODY_BYTES = '1000';
    const send = (body: string) => {
      const request = new Request('https://ingest.test/api/ingest', { method: 'POST', headers: { authorization: `Bearer ${INGEST_KEY}` }, body: streamed(body), duplex: 'half' } as RequestInit);
      expect(request.headers.get('content-length')).toBeNull();
      return app.fetch(request, testEnv);
    };
    expect((await send(sized(1000))).status).toBe(200);
    expect((await send(sized(1001))).status).toBe(413);
  });

});

describe('over quota / rate limited (Nightwatch stop instruction)', () => {
  it('answers ingest with 429, stop, refresh_in and Retry-After while the project is over quota', async () => {
    await env.API_KEYS.put('project:proj_1', JSON.stringify({ over_quota_until: Math.floor(Date.now() / 1000) + 300, message: 'Monthly event quota exceeded.' }));
    try {
      const res = await call('/api/ingest', { method: 'POST', headers: { authorization: `Bearer ${INGEST_KEY}` }, body: JSON.stringify({ records: [query(TRACE_A)] }) });
      const body = (await res.json()) as { message: string; stop: boolean; refresh_in: number };

      expect(res.status).toBe(429);
      expect(body).toMatchObject({ message: 'Monthly event quota exceeded.', stop: true });
      expect(body.refresh_in).toBeGreaterThan(290);
      expect(Number(res.headers.get('retry-after'))).toBe(body.refresh_in);
      expect(res.headers.get('x-edgewatch-stop')).toBe('1');
      expect(sent).toHaveLength(0);

      const auth = await call('/api/agent-auth', { method: 'POST', headers: { ...agentHeaders, authorization: `Bearer ${INGEST_KEY}` }, body: '{}' });
      expect(auth.status).toBe(429);
      expect(await auth.json()).toMatchObject({ stop: true });
    } finally {
      await env.API_KEYS.delete('project:proj_1');
    }
  });

  it('ignores an expired quota block', async () => {
    await env.API_KEYS.put('project:proj_1', JSON.stringify({ over_quota_until: Math.floor(Date.now() / 1000) - 5 }));
    try {
      const res = await call('/api/ingest', { method: 'POST', headers: { authorization: `Bearer ${INGEST_KEY}` }, body: JSON.stringify({ records: [query(TRACE_A)] }) });
      expect(res.status).toBe(200);
    } finally {
      await env.API_KEYS.delete('project:proj_1');
    }
  });

  it('answers 429 with refresh_in = RATE_LIMIT_PERIOD when the rate limiter rejects', async () => {
    const keys: string[] = [];
    testEnv.RATE_LIMITER = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: keys.length <= 1 };
      },
    };
    testEnv.RATE_LIMIT_PERIOD = '60';
    const req = () => call('/api/ingest', { method: 'POST', headers: { authorization: `Bearer ${INGEST_KEY}` }, body: JSON.stringify({ records: [query(TRACE_A)] }) });

    expect((await req()).status).toBe(200);
    const limited = await req();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ message: 'Rate limit exceeded.', error: { code: 'rate_limited' }, stop: true, refresh_in: 60 });
    expect(keys).toEqual(['proj_1', 'proj_1']);
  });
});

describe('POST /api/browser (EdgeWatch browser error extension)', () => {
  const BROWSER_KEY = 'ew_pub_browser_key';
  const LOCKED_KEY = 'ew_pub_locked_key';
  const event = (extra: Record<string, unknown> = {}) => ({
    type: 'error', timestamp: 1763750000.5, class: 'TypeError', message: "Cannot read properties of undefined (reading 'id') for jane@example.com",
    stack: 'TypeError: ...\n    at app.js:10:5', file: 'https://shop.example.com/assets/app.js', line: 10, column: 5,
    url: 'https://shop.example.com/checkout?step=2', user_agent: 'Mozilla/5.0', release: 'v42', ...extra,
  });

  beforeAll(async () => {
    await env.API_KEYS.put(await apiKeyKvKey(BROWSER_KEY), JSON.stringify({ project_id: 'proj_1', name: 'browser', scopes: ['browser'] }));
    await env.API_KEYS.put(await apiKeyKvKey(LOCKED_KEY), JSON.stringify({ project_id: 'proj_1', name: 'locked', scopes: ['browser'], allowed_origins: ['https://shop.example.com'] }));
  });

  it('answers 503 with Retry-After, without the cause, when the queue rejects browser events', async () => {
    const failing = { send: async () => { throw new Error('queue-secret-91c'); }, sendBatch: async () => { throw new Error('queue-secret-91c'); } } as unknown as Queue<IngestMessage>;
    const res = await app.fetch(new Request(`https://ingest.edgewatch.test/api/browser?key=${BROWSER_KEY}`, {
      method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8', origin: 'https://shop.example.com' }, body: JSON.stringify({ events: [event()] }),
    }), { ...testEnv, INGEST_QUEUE: failing });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await res.text()).not.toContain('queue-secret-91c');
  });

  it('accepts sendBeacon-style text/plain posts with ?key= and queues Nightwatch-shaped exception records', async () => {
    const res = await call(`/api/browser?key=${BROWSER_KEY}`, {
      method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8', origin: 'https://shop.example.com' },
      body: JSON.stringify({ events: [event(), event({ trace_id: TRACE_A, handled: true }), { nope: true }] }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: 2, rejected: 1 });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://shop.example.com');

    const records = sent.flatMap((m) => m.records ?? []);
    expect(sent.every((m) => m.project_id === 'proj_1' && m.server === 'browser')).toBe(true);
    expect(records[0]).toMatchObject({
      v: 3, t: 'exception', server: 'browser', execution_source: 'browser', execution_preview: '/checkout', deploy: 'v42',
      class: 'TypeError', file: 'https://shop.example.com/assets/app.js', line: 10, code: '0', handled: false,
      browser: { type: 'error', column: 5, url: 'https://shop.example.com/checkout?step=2' },
    });
    expect(records[0]._group).toMatch(/^[0-9a-f]{32}$/);
    expect(records[1].trace_id).toBe(TRACE_A);
  });

  it('answers CORS preflight', async () => {
    const res = await call('/api/browser', { method: 'OPTIONS', headers: { origin: 'https://a.test', 'access-control-request-method': 'POST' } });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('rejects ingest keys, unknown keys and disallowed origins', async () => {
    const body = JSON.stringify({ events: [event()] });
    expect((await call(`/api/browser?key=${INGEST_KEY}`, { method: 'POST', body })).status).toBe(401);
    expect((await call('/api/browser?key=nope', { method: 'POST', body })).status).toBe(401);
    expect((await call(`/api/browser?key=${LOCKED_KEY}`, { method: 'POST', headers: { origin: 'https://evil.test' }, body })).status).toBe(403);
    expect((await call(`/api/browser?key=${LOCKED_KEY}`, { method: 'POST', headers: { origin: 'https://shop.example.com' }, body })).status).toBe(200);
  });

  it('rejects malformed bodies and browser keys cannot use the agent endpoints', async () => {
    expect((await call(`/api/browser?key=${BROWSER_KEY}`, { method: 'POST', body: 'nope' })).status).toBe(422);
    expect((await call(`/api/browser?key=${BROWSER_KEY}`, { method: 'POST', body: '{"events":[]}' })).status).toBe(422);
    expect((await call('/api/ingest', { method: 'POST', headers: { authorization: `Bearer ${BROWSER_KEY}` }, body: '{"records":[]}' })).status).toBe(401);
  });
});

describe('project tag (single-tenant)', () => {
  const OTHER_KEY = 'ew_live_second_app';
  beforeAll(async () => {
    await env.API_KEYS.put(await apiKeyKvKey(OTHER_KEY), JSON.stringify({ project_id: 'proj_2', name: 'second', scopes: ['ingest'] }));
  });
  const ingest = (key: string, body: unknown, headers: Record<string, string> = {}, qs = '') =>
    call(`/api/ingest${qs}`, { method: 'POST', headers: { ...agentHeaders, authorization: `Bearer ${key}`, ...headers }, body: JSON.stringify(body) });

  it('untagged data goes to the key\'s default project', async () => {
    await ingest(INGEST_KEY, { records: [query(TRACE_A)] });
    await ingest(OTHER_KEY, { records: [query(TRACE_A)] });
    expect(sent.map((m) => m.project_id)).toEqual(['proj_1', 'proj_2']);
  });

  it('any ingest key can write to any project via X-EdgeWatch-Project or ?project=', async () => {
    expect((await ingest(INGEST_KEY, { records: [query(TRACE_A)] }, { 'x-edgewatch-project': 'billing' })).status).toBe(200);
    expect((await ingest(OTHER_KEY, { records: [query(TRACE_A)] }, {}, '?project=shop')).status).toBe(200);
    expect(sent.map((m) => m.project_id)).toEqual(['billing', 'shop']);
  });

  it('rejects a malformed project tag with 422 and enqueues nothing', async () => {
    for (const tag of ['has space', '../etc', 'x'.repeat(65), '-leading']) {
      const res = await ingest(INGEST_KEY, { records: [query(TRACE_A)] }, {}, `?project=${encodeURIComponent(tag)}`);
      expect(res.status, tag).toBe(422);
      expect(((await res.json()) as any).error.code).toBe('unprocessable');
    }
    expect(sent).toHaveLength(0);
  });

  it('agent-auth mints a token for the tagged project, so the agent\'s batches land there', async () => {
    const auth = await call('/api/agent-auth', { method: 'POST', headers: { ...agentHeaders, authorization: `Bearer ${INGEST_KEY}`, 'x-edgewatch-project': 'billing' }, body: '{}' });
    const { token } = (await auth.json()) as { token: string };
    expect((await ingest(token, { records: [query(TRACE_A)] })).status).toBe(200);
    expect(sent.map((m) => m.project_id)).toEqual(['billing']);
  });

  it('tags browser errors too', async () => {
    await env.API_KEYS.put(await apiKeyKvKey('ew_pub_tagged'), JSON.stringify({ project_id: 'proj_1', name: 'web', scopes: ['browser'] }));
    const res = await call('/api/browser?key=ew_pub_tagged&project=marketing-site', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ type: 'error', timestamp: Date.now() / 1000, class: 'TypeError', message: 'x', file: 'https://m.test/a.js', line: 1, url: 'https://m.test/' }] }),
    });
    expect(res.status).toBe(200);
    expect(sent.map((m) => m.project_id)).toEqual(['marketing-site']);
  });
});

describe('error bodies, request ids and key validation', () => {
  const ingest = (key: string | null, body: BodyInit, headers: Record<string, string> = {}) =>
    call('/api/ingest', { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers }, body });
  const records = (n = 1) => JSON.stringify({ records: Array.from({ length: n }, () => query(TRACE_A)) });

  it('answers every error with {error:{code,message}, message, request_id} and echoes X-Request-Id', async () => {
    const res = await ingest(null, records(), { 'x-request-id': 'req-abc' });
    expect(res.status).toBe(401);
    expect(res.headers.get('x-request-id')).toBe('req-abc');
    expect(await res.json()).toEqual({ error: { code: 'unauthenticated', message: 'Unauthenticated.' }, message: 'Unauthenticated.', request_id: 'req-abc' });

    const missing = await call('/nope', { method: 'GET' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'not_found' } });
    expect(missing.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects a missing, malformed, unknown, read-scope, browser-scope or disabled key', async () => {
    await env.API_KEYS.put(await apiKeyKvKey('ew_live_disabled'), JSON.stringify({ project_id: 'proj_1', name: 'off', scopes: ['ingest'], disabled: true }));
    await env.API_KEYS.put(await apiKeyKvKey('ew_pub_browser'), JSON.stringify({ project_id: 'proj_1', name: 'pub', scopes: ['browser'] }));
    for (const auth of [undefined, 'Basic abc', 'Bearer ', 'Bearer ew_live_unknown', `Bearer ${READ_KEY}`, 'Bearer ew_pub_browser', 'Bearer ew_live_disabled']) {
      const res = await call('/api/ingest', { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: records() });
      expect(res.status, String(auth)).toBe(401);
      expect(((await res.json()) as any).error.code).toBe('unauthenticated');
    }
    expect(sent).toHaveLength(0);
  });

  it('rejects an expired or tampered agent token and a token signed with another secret', async () => {
    const exp = Math.floor(Date.now() / 1000);
    const expired = await signIngestToken({ p: 'proj_1', exp: exp - 10 }, testEnv.TOKEN_SIGNING_SECRET);
    const valid = await signIngestToken({ p: 'proj_1', exp: exp + 600 }, testEnv.TOKEN_SIGNING_SECRET);
    const foreign = await signIngestToken({ p: 'proj_1', exp: exp + 600 }, 'some-other-secret');
    const tampered = valid.slice(0, -2) + (valid.endsWith('AA') ? 'BB' : 'AA');
    for (const t of [expired, foreign, tampered]) expect((await ingest(t, records())).status).toBe(401);
    expect((await ingest(valid, records())).status).toBe(200);
  });

  it('handles malformed payloads with 400/422 and never enqueues them', async () => {
    const gzipHeader = { 'content-encoding': 'gzip' };
    const cases: [BodyInit, Record<string, string>, number, string][] = [
      ['{not json', {}, 422, 'unprocessable'],
      ['[]', {}, 422, 'unprocessable'],
      ['{"records": "nope"}', {}, 422, 'unprocessable'],
      ['null', {}, 422, 'unprocessable'],
      ['', {}, 422, 'unprocessable'],
      ['this is not gzip', gzipHeader, 400, 'invalid_request'],
    ];
    for (const [body, headers, status, code] of cases) {
      const res = await ingest(INGEST_KEY, body, headers);
      expect(res.status, String(body)).toBe(status);
      expect(((await res.json()) as any).error.code).toBe(code);
    }
    expect(sent).toHaveLength(0);
  });

  it('stops inflating a gzip bomb as soon as the decoded size passes MAX_BODY_BYTES', async () => {
    testEnv = { ...testEnv, MAX_BODY_BYTES: '50000' };
    const bomb = await gzip(JSON.stringify({ records: [] }).replace(']', `${' '.repeat(2_000_000)}]`));
    expect(bomb.byteLength).toBeLessThan(50_000);
    const res = await ingest(INGEST_KEY, bomb, { 'content-encoding': 'gzip' });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: 'payload_too_large' } });
  });

  it('reports invalid records per index while accepting the valid ones', async () => {
    const res = await ingest(INGEST_KEY, JSON.stringify({ records: [query(TRACE_A), { t: 'query' }, 42, { v: 1, t: 'mystery' }] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // Unknown record types are passed through (forward compatibility with newer Nightwatch clients).
    expect(body.rejected).toBe(2);
    expect(body.accepted).toBe(2);
    expect(sent.flatMap((m) => m.records ?? [])).toHaveLength(2);
    expect(body.errors[0]).toMatchObject({ index: expect.any(Number), issues: expect.any(Array) });
  });

  it('applies the per-project rate limiter to ingest but not to agent-auth', async () => {
    const limiter = { limit: async () => ({ success: false }) };
    testEnv = { ...testEnv, RATE_LIMITER: limiter, RATE_LIMIT_PERIOD: '30' };
    const limited = await ingest(INGEST_KEY, records());
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('30');
    expect(await limited.json()).toMatchObject({ error: { code: 'rate_limited' }, stop: true, refresh_in: 30 });
    const auth = await call('/api/agent-auth', { method: 'POST', headers: { authorization: `Bearer ${INGEST_KEY}`, 'content-type': 'application/json' }, body: '{}' });
    expect(auth.status).toBe(200);
  });

  it('answers 429 over_quota on agent-auth, ingest and browser for a blocked project', async () => {
    await env.API_KEYS.put(await apiKeyKvKey('ew_live_q'), JSON.stringify({ project_id: 'proj_quota', name: 'q', scopes: ['ingest', 'browser'] }));
    await env.API_KEYS.put('project:proj_quota', JSON.stringify({ over_quota_until: Date.now() / 1000 + 120 }));
    const auth = await call('/api/agent-auth', { method: 'POST', headers: { authorization: 'Bearer ew_live_q' }, body: '{}' });
    const data = await ingest('ew_live_q', records());
    const browser = await call('/api/browser?key=ew_live_q', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: [] }) });
    for (const res of [auth, data, browser]) {
      expect(res.status).toBe(429);
      const body = (await res.json()) as any;
      expect(body).toMatchObject({ error: { code: 'over_quota' }, stop: true });
      expect(body.refresh_in).toBeGreaterThan(100);
      expect(Number(res.headers.get('retry-after'))).toBe(body.refresh_in);
    }
    expect(sent).toHaveLength(0);
  });
});

describe('storage failures', () => {
  const SECRET = 'kv-internal-detail-7f3a';
  const body = () => JSON.stringify({ records: [query(TRACE_A)] });
  const post = (envOverride: Partial<Env>) =>
    app.fetch(new Request('https://ingest.edgewatch.test/api/ingest', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${INGEST_KEY}` }, body: body() }), { ...testEnv, ...envOverride });

  it('answers 503 unavailable with Retry-After when the key lookup in KV fails, without leaking the cause', async () => {
    const res = await post({ API_KEYS: { get: async () => { throw new Error(SECRET); } } as unknown as KVNamespace });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'unavailable', message: 'Storage temporarily unavailable.' } });
    expect(sent).toHaveLength(0);
  });

  it('fails open when the quota lookup or the rate limiter fails', async () => {
    const kv = env.API_KEYS as unknown as KVNamespace;
    const flakyQuota = { get: (key: string, options: never) => (key.startsWith('project:') ? Promise.reject(new Error(SECRET)) : kv.get(key, options)) } as unknown as KVNamespace;
    const res = await post({ API_KEYS: flakyQuota, RATE_LIMITER: { limit: async () => { throw new Error(SECRET); } } });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('answers 503 without leaking the cause when the queue rejects the batch', async () => {
    const res = await post({ INGEST_QUEUE: { send: async () => { throw new Error(SECRET); }, sendBatch: async () => { throw new Error(SECRET); } } as unknown as Queue<IngestMessage> });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'unavailable' } });
  });
});

describe('key expiry', () => {
  const EXPIRED = 'ew_live_expired_key';
  const SOON = 'ew_live_expires_soon';
  it('rejects expired keys and caps agent tokens at the key expiry', async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.API_KEYS.put(await apiKeyKvKey(EXPIRED), JSON.stringify({ project_id: 'proj_1', name: 'old', scopes: ['ingest'], expires_at: now - 1 }));
    await env.API_KEYS.put(await apiKeyKvKey(SOON), JSON.stringify({ project_id: 'proj_1', name: 'soon', scopes: ['ingest'], expires_at: now + 120 }));
    const auth = (key: string) => app.fetch(new Request('https://ingest.edgewatch.test/api/agent-auth', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: '{}' }), testEnv);
    expect((await auth(EXPIRED)).status).toBe(401);
    const ingest = await app.fetch(new Request('https://ingest.edgewatch.test/api/ingest', { method: 'POST', headers: { authorization: `Bearer ${EXPIRED}`, 'content-type': 'application/json' }, body: '{"records":[]}' }), testEnv);
    expect(ingest.status).toBe(401);
    const body = (await (await auth(SOON)).json()) as { expires_in: number; refresh_in: number };
    expect(body.expires_in).toBeGreaterThan(100);
    expect(body.expires_in).toBeLessThanOrEqual(120);
    expect(body.refresh_in).toBeLessThanOrEqual(body.expires_in);
  });
});

describe('KEY_STORE=sql', () => {
  // Minimal event store holding the kv_store table, so the test exercises SqlKeyStore's real SQL path.
  function kvTable(rows: Record<string, string>) {
    const reads: string[] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => {
            reads.push(sql);
            const value = rows[String(args[0])];
            return value === undefined ? null : { value, expires_at: null };
          },
          all: async () => ({ results: [], meta: {} }),
          run: async () => ({ results: [], meta: {} }),
        }),
      }),
      batch: async () => [],
    };
    return { db: db as unknown as Env['DB'], reads };
  }

  it('authenticates keys from the event store instead of KV', async () => {
    const hash = apiKeyKvKey(INGEST_KEY);
    const { db, reads } = kvTable({ [await hash]: JSON.stringify({ project_id: 'proj_sql', name: 'sql', scopes: ['ingest'] }) });
    const sqlEnv: Env = { ...testEnv, KEY_STORE: 'sql', DB: db, API_KEYS: { get: () => Promise.reject(new Error('KV must not be used')) } as unknown as Env['API_KEYS'] };
    const res = await app.fetch(new Request('https://ingest.edgewatch.test/api/ingest', {
      method: 'POST', headers: { authorization: `Bearer ${INGEST_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ records: [query(TRACE_A)] }),
    }), sqlEnv);
    expect(res.status).toBe(200);
    expect(reads.some((sql) => sql.includes('FROM kv_store'))).toBe(true);
    expect(sent.at(-1)?.project_id).toBe('proj_sql');

    const unknown = await app.fetch(new Request('https://ingest.edgewatch.test/api/ingest', {
      method: 'POST', headers: { authorization: 'Bearer ew_live_not_in_table', 'content-type': 'application/json' }, body: '{"records":[]}',
    }), sqlEnv);
    expect(unknown.status).toBe(401);
  });

  it('answers a typed 500 without internals when KEY_STORE=sql has no event store', async () => {
    const res = await app.fetch(new Request('https://ingest.edgewatch.test/api/ingest', {
      method: 'POST', headers: { authorization: `Bearer ${INGEST_KEY}`, 'content-type': 'application/json' }, body: '{"records":[]}',
    }), { ...testEnv, KEY_STORE: 'sql' });
    expect(res.status).toBe(500);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error).toEqual({ code: 'internal_error', message: 'Internal error.' });
  });
});

describe('GET /healthz', () => {
  it('reports ok with every dependency checked', async () => {
    const limiter = { limit: async () => ({ success: true }) };
    const res = await app.fetch(new Request('https://ingest.edgewatch.test/healthz'), { ...testEnv, RATE_LIMITER: testEnv.RATE_LIMITER ?? limiter });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { status: string; service: string; checks: Record<string, { status: string; backend?: string }> };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('ingest');
    expect(Object.keys(body.checks).sort()).toEqual(['blobs', 'config', 'keys', 'queue', 'rate_limiter', 'signing_secret']);
    expect(body.checks.keys).toMatchObject({ status: 'ok', backend: 'kv' });
    expect(body.checks.blobs).toMatchObject({ status: 'ok', backend: 'r2' });
  });

  it('is down (503) without the signing secret or when KV fails, degraded without the rate limiter', async () => {
    const noSecret = await app.fetch(new Request('https://ingest.edgewatch.test/healthz'), { ...testEnv, TOKEN_SIGNING_SECRET: '' });
    expect(noSecret.status).toBe(503);
    expect(((await noSecret.json()) as { checks: Record<string, { error?: string }> }).checks.signing_secret?.error).toBe('not_configured');
    const kvDown = await app.fetch(new Request('https://ingest.edgewatch.test/healthz'), { ...testEnv, API_KEYS: { get: () => Promise.reject(new Error('KV down')) } as never });
    expect(kvDown.status).toBe(503);
    const noLimiter = await app.fetch(new Request('https://ingest.edgewatch.test/healthz'), { ...testEnv, RATE_LIMITER: undefined });
    expect(noLimiter.status).toBe(200);
    expect(((await noLimiter.json()) as { status: string }).status).toBe('degraded');
  });

  it('reports a half-configured backend instead of failing with 500', async () => {
    const res = await app.fetch(new Request('https://ingest.edgewatch.test/healthz'), { ...testEnv, S3_BUCKET: 'traces' });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { checks: Record<string, { error?: string }> }).checks.config?.error).toBe('not_configured');
  });
});
