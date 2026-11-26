import { apiKeyKvKey, type IngestMessage } from '@edgewatch/shared';
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import app, { type Env } from '../src/index';

const KEY = 'ew_live_fuzz_key';
const SECRET_MARKERS = ['TOKEN_SIGNING_SECRET', 'at ', 'Error:', 'D1_', 'stack'];

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)];
  return { next, int, pick };
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}

const RECORD = { v: 1, t: 'query', timestamp: 1763750000, deploy: 'v1', server: 'w', _group: 'g', trace_id: '019aa7b1-35fb-7000-8000-00000000000a', execution_source: 'request', execution_id: 'x', execution_preview: 'GET /', execution_stage: 'action', user: '', sql: 'select 1', file: 'a.php', line: 1, duration: 10, connection: 'mysql', connection_type: 'read' };

/** Random bodies: raw bytes, truncated/corrupt gzip, JSON of the wrong shape, deep nesting, near-valid records. */
async function body(seed: number): Promise<{ bytes: Uint8Array; headers: Record<string, string> }> {
  const r = rng(seed);
  const enc = new TextEncoder();
  const json = r.pick([
    () => JSON.stringify({ records: Array.from({ length: r.int(30) }, () => ({ ...RECORD, [r.pick(['v', 't', 'sql', 'duration', 'timestamp', 'trace_id'])]: r.pick([null, -1, 'x', [], {}, 1e308]) })) }),
    () => JSON.stringify({ records: r.pick([null, 'x', 1, {}, [[]]]) }),
    () => `${'['.repeat(r.int(5000))}`,
    () => JSON.stringify({ records: [RECORD] }).slice(0, r.int(200)),
    () => JSON.stringify({ __proto__: { polluted: 1 }, constructor: { prototype: { polluted: 1 } }, records: [] }),
  ])();
  let bytes = r.next() < 0.2 ? crypto.getRandomValues(new Uint8Array(1 + r.int(2000))) : enc.encode(json);
  const headers: Record<string, string> = { 'content-type': r.pick(['application/json', 'text/plain', 'application/octet-stream']) };
  const mode = r.int(4);
  if (mode === 1) bytes = await gzip(bytes);
  if (mode === 2) bytes = (await gzip(bytes)).slice(0, 12);
  if (mode === 3) headers['content-encoding'] = 'gzip';
  return { bytes, headers };
}

let testEnv: Env;
beforeAll(async () => {
  await env.API_KEYS.put(await apiKeyKvKey(KEY), JSON.stringify({ project_id: 'proj_fuzz', name: 'fuzz', scopes: ['ingest'] }));
  const queue = { send: async () => {}, sendBatch: async () => {} } as unknown as Queue<IngestMessage>;
  testEnv = { ...(env as unknown as Env), INGEST_QUEUE: queue, MAX_BODY_BYTES: '100000' };
});

describe('fuzz: ingest HTTP parsers', () => {
  it('answers every random /api/ingest body with a typed 2xx/4xx and no internals', async () => {
    const seen = new Set<number>();
    for (let seed = 1; seed <= 250; seed++) {
      const { bytes, headers } = await body(seed);
      const res = await app.fetch(new Request('https://ingest.test/api/ingest', { method: 'POST', body: bytes, headers: { ...headers, authorization: `Bearer ${KEY}` } }), testEnv);
      const text = await res.text();
      seen.add(res.status);
      expect([200, 400, 413, 422], `seed ${seed} -> ${res.status} ${text.slice(0, 200)}`).toContain(res.status);
      const json = JSON.parse(text) as { ok?: boolean; error?: { code: string; message: string } };
      if (res.status !== 200) expect(json.error?.code, `seed ${seed}`).toMatch(/^[a-z_]+$/);
      for (const m of SECRET_MARKERS) expect(text, `seed ${seed}`).not.toContain(m);
    }
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect([...seen].sort()).toEqual(expect.arrayContaining([200, 422]));
  });

  it('rejects random bearer tokens with 401', async () => {
    for (let seed = 1; seed <= 100; seed++) {
      const r = rng(seed);
      const token = r.pick(['ewt.', 'ew_live_', '']) + Array.from({ length: r.int(80) }, () => String.fromCharCode(33 + r.int(94))).join('');
      const ingest = await app.fetch(new Request('https://ingest.test/api/ingest', { method: 'POST', body: '{"records":[]}', headers: { authorization: `Bearer ${token}` } }), testEnv);
      expect(ingest.status, `seed ${seed}`).toBe(401);
    }
  });
});
