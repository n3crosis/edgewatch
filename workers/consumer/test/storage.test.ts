import type { BlobStore, IngestMessage, IngestQueue, KeyStore, SqlDatabase } from '@edgewatch/shared';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Cloudflare bindings satisfy the storage interfaces', () => {
  // These assignments are the compile-time check; the calls below exercise each one through the interface only.
  const db: SqlDatabase = env.DB;
  const blobs: BlobStore = env.TRACES;
  const keys: KeyStore = env.API_KEYS;

  it('runs SQL, batches and reads changes through SqlDatabase', async () => {
    await db.batch([
      db.prepare('CREATE TABLE IF NOT EXISTS storage_check (id INTEGER PRIMARY KEY, v TEXT)'),
      db.prepare('INSERT INTO storage_check (v) VALUES (?1), (?2)').bind('a', 'b'),
    ]);
    expect(await db.prepare('SELECT count(*) AS n FROM storage_check').first<number>('n')).toBe(2);
    expect((await db.prepare('SELECT v FROM storage_check ORDER BY id').all<{ v: string }>()).results.map((r) => r.v)).toEqual(['a', 'b']);
    expect((await db.prepare('DELETE FROM storage_check WHERE v = ?').bind('a').run()).meta.changes).toBe(1);
  });

  it('stores and deletes blobs and JSON keys', async () => {
    await blobs.put('check/a.json', '{"x":1}', { httpMetadata: { contentType: 'application/json' } });
    const obj = await blobs.get('check/a.json');
    expect(obj?.size).toBe(7);
    expect(await obj?.json<{ x: number }>()).toEqual({ x: 1 });
    await blobs.delete(['check/a.json']);
    expect(await blobs.get('check/a.json')).toBeNull();
    await keys.put('check', '{"ok":true}');
    expect(await keys.get<{ ok: boolean }>('check', { type: 'json' })).toEqual({ ok: true });
    await keys.delete('check');
    expect(await keys.get('check', { type: 'json' })).toBeNull();
  });

  it('accepts any sendBatch implementation as the ingest queue', async () => {
    const sent: IngestMessage[] = [];
    const queue: IngestQueue<IngestMessage> = { sendBatch: async (m) => void [...m].forEach((x) => sent.push(x.body)) };
    await queue.sendBatch([{ body: { project_id: 'p', server: '', received_at: 0, trace_id: null, records: [] } }]);
    expect(sent).toHaveLength(1);
  });
});
