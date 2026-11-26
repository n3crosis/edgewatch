import { describe, expect, it } from 'vitest';
import { BackendConfigError, describeBackends, openBackends } from './backends';
import { S3Error, s3BlobStore } from './s3';
import type { BlobStore, KeyStore, SqlDatabase } from './storage';

function fakeS3() {
  const objects = new Map<string, { body: string; headers: Record<string, string> }>();
  const requests: Request[] = [];
  let failWith = 0;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    requests.push(req);
    if (failWith) return new Response('<Error><Code>AccessDenied</Code><Message>secret detail</Message></Error>', { status: failWith });
    const key = new URL(req.url).pathname;
    if (req.method === 'PUT') {
      objects.set(key, { body: await req.text(), headers: Object.fromEntries(['content-type', 'x-amz-meta-project_id'].map((h) => [h, req.headers.get(h) ?? ''])) });
      return new Response(null, { status: 200 });
    }
    if (req.method === 'DELETE') {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const o = objects.get(key);
    return o ? new Response(o.body, { status: 200, headers: { 'content-length': String(o.body.length) } }) : new Response('<Error/>', { status: 404 });
  };
  return { objects, requests, fetch: fetch as typeof globalThis.fetch, fail: (s: number) => { failWith = s; } };
}

const config = { endpoint: 'https://s3.example.com/', bucket: 'traces', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI' };

describe('s3BlobStore', () => {
  it('puts, gets and deletes path-style objects with SigV4 headers and metadata', async () => {
    const s3 = fakeS3();
    const store = s3BlobStore({ ...config, fetch: s3.fetch });
    await store.put('traces/p/2025-01-01/a b.json', '{"records":[1]}', { httpMetadata: { contentType: 'application/json' }, customMetadata: { project_id: 'p' } });
    const put = s3.requests[0];
    expect(put.url).toBe('https://s3.example.com/traces/traces/p/2025-01-01/a%20b.json');
    expect(put.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request/);
    expect(put.headers.get('x-amz-content-sha256')).toBeTruthy();
    expect(s3.objects.get('/traces/traces/p/2025-01-01/a%20b.json')?.headers).toMatchObject({ 'content-type': 'application/json', 'x-amz-meta-project_id': 'p' });

    const object = await store.get('traces/p/2025-01-01/a b.json');
    expect(object?.size).toBe(15);
    expect(await object?.json()).toEqual({ records: [1] });
    expect(await (await store.get('traces/p/2025-01-01/a b.json'))?.text()).toBe('{"records":[1]}');
    expect(await store.get('missing.json')).toBeNull();

    await store.delete(['traces/p/2025-01-01/a b.json', 'never-existed.json']);
    expect(s3.objects.size).toBe(0);
  });

  it('streams the body once and refuses a second read', async () => {
    const s3 = fakeS3();
    const store = s3BlobStore({ ...config, fetch: s3.fetch });
    await store.put('k', 'hello');
    const object = await store.get('k');
    expect(await new Response(object?.body).text()).toBe('hello');
    expect(() => object?.text()).toThrow(/already read/);
  });

  it('deletes many keys with bounded concurrency', async () => {
    const s3 = fakeS3();
    const store = s3BlobStore({ ...config, fetch: s3.fetch, deleteConcurrency: 3 });
    for (let i = 0; i < 10; i++) await store.put(`k${i}`, 'x');
    await store.delete(Array.from({ length: 10 }, (_, i) => `k${i}`));
    expect(s3.objects.size).toBe(0);
    expect(s3.requests.filter((r) => r.method === 'DELETE')).toHaveLength(10);
  });

  it('throws S3Error with only the operation and status, never the response body', async () => {
    const s3 = fakeS3();
    const store = s3BlobStore({ ...config, fetch: s3.fetch });
    s3.fail(403);
    const err = await store.put('k', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(S3Error);
    expect(String(err)).toBe('S3Error: S3 PutObject failed with HTTP 403');
    expect(String(err)).not.toContain('secret');
    s3.fail(500);
    await expect(store.get('k')).rejects.toThrow('S3 GetObject failed with HTTP 500');
    await expect(store.delete('k')).rejects.toThrow('S3 DeleteObject failed with HTTP 500');
  });
});

describe('openBackends', () => {
  const DB = { prepare: () => { throw new Error('unused'); }, batch: async () => [] } as unknown as SqlDatabase;
  const TRACES = { tag: 'r2' } as unknown as BlobStore;
  const API_KEYS = { tag: 'kv' } as unknown as KeyStore;

  it('keeps the Cloudflare bindings when nothing else is configured', async () => {
    const env = { DB, TRACES, API_KEYS, OTHER: 'x' };
    const { env: out, close, connected } = openBackends(env);
    expect(out).toEqual(env);
    expect(connected).toBe(false);
    expect(describeBackends(env)).toEqual({ events: 'd1', blobs: 'r2', keys: 'kv' });
    await close();
  });

  it('swaps in S3 and the SQL key store', () => {
    const env = { DB, TRACES, API_KEYS, KEY_STORE: 'sql', S3_BUCKET: 'b', S3_ENDPOINT: 'http://s3', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 's' };
    const { env: out } = openBackends(env);
    expect(out.TRACES).not.toBe(TRACES);
    expect(out.API_KEYS).not.toBe(API_KEYS);
    expect(out.DB).toBe(DB);
    expect(openBackends(env).env.API_KEYS).toBe(out.API_KEYS);
    expect(describeBackends(env)).toEqual({ events: 'd1', blobs: 's3', keys: 'sql' });
  });

  it('fails loudly on half-configured backends', () => {
    expect(() => openBackends({ S3_BUCKET: 'b', S3_ENDPOINT: 'http://s3' })).toThrow(new BackendConfigError('S3_BUCKET is set but S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY are missing.'));
    expect(() => openBackends({ KEY_STORE: 'sql' })).toThrow(/KEY_STORE=sql needs an event store/);
  });
});
