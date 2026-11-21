import { normalizeSql, shortHash, type IngestMessage, type NightwatchRecord } from '@edgewatch/shared';

export interface Env {
  DB: D1Database;
  TRACES: R2Bucket;
}

export interface StoredTrace {
  project_id: string;
  trace_id: string;
  records: NightwatchRecord[];
}

const ROOT_TYPES = ['request', 'command', 'job-attempt', 'scheduled-task'];
const str = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function traceKey(projectId: string, date: string, traceId: string): string {
  return `traces/${projectId}/${date}/${traceId}.json`;
}

/** Strip literals from SQL (the official Nightwatch client does not) and attach the EdgeWatch sql_hash. */
export async function normalizeRecord(record: NightwatchRecord): Promise<NightwatchRecord> {
  if (record.t !== 'query' || typeof record.sql !== 'string') return record;
  const sql = normalizeSql(record.sql);
  return { ...record, sql, sql_hash: await shortHash(sql) };
}

export async function processMessage(message: IngestMessage, env: Env): Promise<void> {
  const raw = message.records ?? ((await (await env.TRACES.get(message.r2_key!))?.json()) as NightwatchRecord[] | undefined);
  if (!raw) throw new Error(`Missing payload ${message.r2_key}`);

  await env.DB.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').bind(message.project_id, message.project_id).run();

  const records = await Promise.all(raw.map(normalizeRecord));
  const byTrace = new Map<string, NightwatchRecord[]>();
  for (const record of records) {
    // Records without a trace (e.g. `user`) are grouped under a synthetic per-message trace so nothing is lost.
    const traceId = typeof record.trace_id === 'string' ? record.trace_id : `untraced-${message.received_at}`;
    byTrace.set(traceId, [...(byTrace.get(traceId) ?? []), record]);
  }

  for (const [traceId, fresh] of byTrace) {
    await storeTrace(env, message, traceId, fresh);
  }

  if (message.r2_key) await env.TRACES.delete(message.r2_key);
}

async function storeTrace(env: Env, message: IngestMessage, traceId: string, fresh: NightwatchRecord[]): Promise<void> {
  const projectId = message.project_id;
  const existing = await env.DB.prepare('SELECT date, r2_key FROM traces WHERE project_id = ? AND trace_id = ?').bind(projectId, traceId).first<{ date: string; r2_key: string }>();
  const firstTs = Math.min(...fresh.map((r) => num(r.timestamp) || message.received_at / 1000));
  const date = existing?.date ?? new Date(firstTs * 1000).toISOString().slice(0, 10);
  const key = existing?.r2_key ?? traceKey(projectId, date, traceId);

  // Records for one trace can arrive in several batches; merge into a single R2 object.
  const previous = existing ? ((await (await env.TRACES.get(key))?.json()) as StoredTrace | undefined) : undefined;
  const all = [...(previous?.records ?? []), ...fresh];
  const stored: StoredTrace = { project_id: projectId, trace_id: traceId, records: all };
  await env.TRACES.put(key, JSON.stringify(stored), { httpMetadata: { contentType: 'application/json' }, customMetadata: { project_id: projectId } });

  const s = summarize(all, message);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO traces (project_id, trace_id, timestamp, date, execution_source, name, method, url, route, status_code, duration_ms, query_count, exception_count, server, deploy, user, r2_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, trace_id) DO UPDATE SET timestamp = excluded.timestamp, execution_source = excluded.execution_source, name = excluded.name,
         method = excluded.method, url = excluded.url, route = excluded.route, status_code = excluded.status_code, duration_ms = excluded.duration_ms,
         query_count = excluded.query_count, exception_count = excluded.exception_count, server = excluded.server, deploy = excluded.deploy, user = excluded.user`,
    ).bind(projectId, traceId, s.timestamp, date, s.source, s.name, s.method, s.url, s.route, s.status, s.duration, s.queries, s.exceptions, s.server, s.deploy, s.user, key),
  ];

  for (const r of fresh) {
    const ts = Math.round(num(r.timestamp) * 1000) || message.received_at;
    if (r.t === 'query') {
      statements.push(
        env.DB.prepare('INSERT INTO queries (project_id, trace_id, sql_hash, sql, connection, duration_ms, file, line, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(projectId, traceId, r.sql_hash, r.sql, str(r.connection), num(r.duration) / 1000, str(r.file), r.line ?? null, ts),
      );
    } else if (r.t === 'exception') {
      const group = await shortHash(`${r.class},${r.code ?? ''},${r.file},${r.line}`);
      statements.push(
        env.DB.prepare('INSERT INTO exceptions (project_id, trace_id, group_hash, class, message, code, file, line, handled, stack, timestamp, user, server) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(projectId, traceId, group, String(r.class), String(r.message), str(r.code), String(r.file), num(r.line), r.handled ? 1 : 0, str(r.trace), ts, str(r.user), str(r.server) ?? message.server),
      );
    }
  }

  await env.DB.batch(statements);
}

export function summarize(records: NightwatchRecord[], message: Pick<IngestMessage, 'server' | 'received_at'>) {
  const root = records.find((r) => ROOT_TYPES.includes(r.t));
  const starts = records.map((r) => num(r.timestamp)).filter(Boolean);
  const ends = records.map((r) => num(r.timestamp) + num(r.duration) / 1e6).filter(Boolean);
  const start = starts.length ? Math.min(...starts) : message.received_at / 1000;
  const any = root ?? records[0];

  let name = any?.t ?? 'unknown';
  let source = str(any?.execution_source) ?? name;
  let status: number | null = null;
  if (root?.t === 'request') {
    source = 'request';
    name = `${root.method} ${str(root.route_path) ?? new URL(String(root.url), 'http://x').pathname}`;
    status = num(root.status_code);
  } else if (root?.t === 'command') {
    source = 'command';
    name = `php artisan ${str(root.command) ?? str(root.name) ?? ''}`.trim();
    status = typeof root.exit_code === 'number' ? root.exit_code : null;
  } else if (root?.t === 'job-attempt') {
    source = 'job';
    name = String(root.name);
  } else if (root?.t === 'scheduled-task') {
    source = 'schedule';
    name = String(root.name);
  }

  return {
    timestamp: Math.round(start * 1000),
    source,
    name,
    method: root?.t === 'request' ? str(root.method) : null,
    url: root?.t === 'request' ? str(root.url) : null,
    route: root?.t === 'request' ? str(root.route_name) : null,
    status,
    duration: root ? num(root.duration) / 1000 : ends.length ? (Math.max(...ends) - start) * 1000 : 0,
    queries: records.filter((r) => r.t === 'query').length,
    exceptions: records.filter((r) => r.t === 'exception').length,
    server: str(any?.server) ?? (message.server || null),
    deploy: str(any?.deploy),
    user: records.map((r) => str(r.user)).find(Boolean) ?? null,
  };
}
