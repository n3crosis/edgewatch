import type { IngestMessage } from '@edgewatch/shared';
import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

const TRACE = '019aa7b1-35fb-7000-8000-0000000000c1';
const base = { timestamp: 1763750000.5, deploy: 'v1', server: 'web-1', _group: 'g', trace_id: TRACE, execution_source: 'request', execution_id: TRACE, user: '42' };

const message = (records: Record<string, unknown>[], extra: Partial<IngestMessage> = {}): IngestMessage => ({
  project_id: 'proj_c', server: 'web-1', received_at: 1763750001000, trace_id: TRACE, records: records as IngestMessage['records'], ...extra,
});

async function deliver(...bodies: IngestMessage[]) {
  const batch = createMessageBatch('edgewatch-ingest', bodies.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 1, body })));
  const ctx = createExecutionContext();
  await worker.queue(batch, env as never);
  return getQueueResult(batch, ctx);
}

describe('queue consumer', () => {
  it('normalizes SQL, writes D1 metadata and stores the raw trace in R2', async () => {
    const result = await deliver(
      message([
        { v: 1, t: 'query', ...base, sql: "select * from users where email = 'jane@example.com' and id in (1, 2, 3)", file: 'app/A.php', line: 3, duration: 2500, connection: 'mysql' },
        { v: 3, t: 'exception', ...base, class: 'RuntimeException', file: 'app/B.php', line: 9, message: 'boom', code: '0', trace: '[{"file":"app/B.php:9","source":"x","code":null}]', handled: false },
        { v: 1, t: 'request', ...base, method: 'GET', url: 'https://shop.test/users/1', route_name: 'users.show', route_path: '/users/{id}', status_code: 500, duration: 48_000, queries: 1, exceptions: 1 },
      ]),
    );

    expect(result.explicitAcks).toEqual(['m0']);

    const trace = await env.DB.prepare('SELECT * FROM traces WHERE trace_id = ?').bind(TRACE).first<Record<string, unknown>>();
    expect(trace).toMatchObject({
      project_id: 'proj_c', execution_source: 'request', name: 'GET /users/{id}', status_code: 500, duration_ms: 48, query_count: 1, exception_count: 1,
      date: '2025-11-21', r2_key: `traces/proj_c/2025-11-21/${TRACE}.json`, user: '42',
    });

    const query = await env.DB.prepare('SELECT * FROM queries WHERE trace_id = ?').bind(TRACE).first<Record<string, unknown>>();
    expect(query).toMatchObject({ sql: 'select * from users where email = ? and id in (?)', duration_ms: 2.5, connection: 'mysql' });
    expect(query!.sql_hash).toMatch(/^[0-9a-f]{32}$/);

    const exception = await env.DB.prepare('SELECT * FROM exceptions WHERE trace_id = ?').bind(TRACE).first<Record<string, unknown>>();
    expect(exception).toMatchObject({ class: 'RuntimeException', handled: 0, line: 9 });

    const raw = (await (await env.TRACES.get(trace!.r2_key as string))!.json()) as { records: { t: string; sql?: string }[] };
    expect(raw.records).toHaveLength(3);
    expect(JSON.stringify(raw)).not.toContain('jane@example.com');
  });

  it('merges records for the same trace that arrive in separate messages', async () => {
    const id = '019aa7b1-35fb-7000-8000-0000000000c2';
    await deliver(message([{ v: 1, t: 'query', ...base, trace_id: id, sql: 'select 1', duration: 100, connection: 'mysql' }], { trace_id: id }));
    await deliver(message([{ v: 1, t: 'command', ...base, trace_id: id, execution_source: 'command', name: 'shop:sync', command: 'shop:sync --force', exit_code: 0, duration: 1_200_000 }], { trace_id: id }));

    const trace = await env.DB.prepare('SELECT name, execution_source, query_count, duration_ms, r2_key FROM traces WHERE trace_id = ?').bind(id).first<Record<string, unknown>>();
    expect(trace).toMatchObject({ name: 'php artisan shop:sync --force', execution_source: 'command', query_count: 1, duration_ms: 1200 });
    const raw = (await (await env.TRACES.get(trace!.r2_key as string))!.json()) as { records: unknown[] };
    expect(raw.records).toHaveLength(2);
  });

  it('loads oversized payloads parked in R2 by the ingest worker and cleans them up', async () => {
    const id = '019aa7b1-35fb-7000-8000-0000000000c3';
    await env.TRACES.put('incoming/proj_c/big.json', JSON.stringify([{ v: 1, t: 'job-attempt', ...base, trace_id: id, execution_source: 'job', name: 'App\\Jobs\\Sync', status: 'processed', duration: 5000 }]));

    const result = await deliver(message([], { trace_id: id, records: undefined, r2_key: 'incoming/proj_c/big.json' }));

    expect(result.explicitAcks).toEqual(['m0']);
    expect(await env.DB.prepare('SELECT name FROM traces WHERE trace_id = ?').bind(id).first('name')).toBe('App\\Jobs\\Sync');
    expect(await env.TRACES.get('incoming/proj_c/big.json')).toBeNull();
  });

  it('retries messages it cannot process', async () => {
    const result = await deliver(message([], { records: undefined, r2_key: 'incoming/missing.json' }));
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(['m0']);
  });
});
