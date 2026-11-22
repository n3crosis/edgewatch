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
    expect(await res.json()).toEqual({ message: 'Unauthenticated.' });
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

  it('accepts plain JSON authenticated with a raw ingest key (laravel-edgewatch HTTP transport)', async () => {
    const res = await call('/api/ingest', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${INGEST_KEY}` }, body: JSON.stringify({ records: [query(TRACE_A)] }) });

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('drops invalid records but keeps valid ones and passes unknown record types through', async () => {
    const res = await call('/api/ingest', {
      method: 'POST',
      headers: { authorization: `Bearer ${INGEST_KEY}` },
      body: JSON.stringify({ records: [query(TRACE_A), { v: 1, t: 'query', trace_id: TRACE_A }, { v: 1, t: 'brand-new-type', trace_id: TRACE_A }] }),
    });
    const json = (await res.json()) as { accepted: number; rejected: number; errors: { index: number }[] };

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ accepted: 2, rejected: 1 });
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
    testEnv.RATE_LIMITER = { limit: async ({ key }) => (keys.push(key), { success: keys.length <= 1 }) };
    testEnv.RATE_LIMIT_PERIOD = '60';
    const req = () => call('/api/ingest', { method: 'POST', headers: { authorization: `Bearer ${INGEST_KEY}` }, body: JSON.stringify({ records: [query(TRACE_A)] }) });

    expect((await req()).status).toBe(200);
    const limited = await req();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ message: 'Rate limit exceeded.', stop: true, refresh_in: 60 });
    expect(keys).toEqual(['proj_1', 'proj_1']);
  });
});
