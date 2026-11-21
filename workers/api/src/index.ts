import { apiKeyKvKey, type ApiKeyRecord, type NightwatchRecord } from '@edgewatch/shared';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

export interface Env {
  DB: D1Database;
  TRACES: R2Bucket;
  API_KEYS: KVNamespace;
  CORS_ORIGIN?: string;
}

type Range = '1h' | '6h' | '24h' | '7d';
const RANGES: Record<Range, number> = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3 };
const BUCKETS = 24;

interface TraceRow {
  trace_id: string; timestamp: number; execution_source: string; name: string; method: string | null; url: string | null; route: string | null;
  status_code: number | null; duration_ms: number; query_count: number; exception_count: number; server: string | null; user: string | null; r2_key: string;
}

const app = new Hono<{ Bindings: Env; Variables: { projectId: string } }>();

app.use('*', (c, next) => cors({ origin: c.env.CORS_ORIGIN ?? '*', allowHeaders: ['authorization', 'content-type'] })(c, next));
app.get('/health', (c) => c.json({ ok: true }));

app.use('/v1/projects/:projectId/*', async (c, next) => {
  const token = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const key = token ? await c.env.API_KEYS.get<ApiKeyRecord>(await apiKeyKvKey(token), 'json') : null;
  if (!key || key.disabled || !key.scopes.includes('read')) return c.json({ message: 'Unauthenticated.' }, 401);
  if (key.project_id !== c.req.param('projectId')) return c.json({ message: 'Forbidden.' }, 403);
  c.set('projectId', key.project_id);
  await next();
});

const percentile = (values: number[], p: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const iso = (ms: number) => new Date(ms).toISOString();
const isError = (t: Pick<TraceRow, 'execution_source' | 'status_code' | 'exception_count'>) =>
  t.execution_source === 'request' ? (t.status_code ?? 0) >= 500 : t.exception_count > 0;

function window(range: string | undefined) {
  const r: Range = range && range in RANGES ? (range as Range) : '24h';
  const now = Date.now();
  return { range: r, now, since: now - RANGES[r], width: RANGES[r] / BUCKETS };
}

function summary(t: TraceRow) {
  const { r2_key: _r2, ...rest } = t;
  return { ...rest, timestamp: iso(t.timestamp) };
}

app.get('/v1/projects/:projectId/overview', async (c) => {
  const { range, since, width } = window(c.req.query('range'));
  const pid = c.get('projectId');
  const [requests, exceptions, slow] = await Promise.all([
    c.env.DB.prepare("SELECT name, timestamp, duration_ms, status_code, exception_count, execution_source FROM traces WHERE project_id = ? AND timestamp >= ? AND execution_source = 'request'")
      .bind(pid, since).all<TraceRow>(),
    c.env.DB.prepare('SELECT count(*) AS n FROM exceptions WHERE project_id = ? AND timestamp >= ?').bind(pid, since).first<number>('n'),
    c.env.DB.prepare('SELECT count(*) AS n FROM queries WHERE project_id = ? AND timestamp >= ? AND duration_ms > 100').bind(pid, since).first<number>('n'),
  ]);
  const rows = requests.results;
  const series = Array.from({ length: BUCKETS }, (_, i) => {
    const from = since + i * width;
    const slice = rows.filter((r) => r.timestamp >= from && r.timestamp < from + width);
    return { ts: iso(from), requests: slice.length, errors: slice.filter(isError).length, p95_ms: percentile(slice.map((r) => r.duration_ms), 95) };
  });
  const routes = new Map<string, TraceRow[]>();
  rows.forEach((r) => routes.set(r.name, [...(routes.get(r.name) ?? []), r]));

  return c.json({
    range,
    requests: rows.length,
    error_rate: rows.length ? rows.filter(isError).length / rows.length : 0,
    p95_ms: percentile(rows.map((r) => r.duration_ms), 95),
    exceptions: exceptions ?? 0,
    slow_queries: slow ?? 0,
    series,
    top_routes: [...routes.entries()]
      .map(([route, list]) => ({ route, requests: list.length, p95_ms: percentile(list.map((r) => r.duration_ms), 95), error_rate: list.filter(isError).length / list.length }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 20),
  });
});

app.get('/v1/projects/:projectId/traces', async (c) => {
  const { source, status, q, cursor } = c.req.query();
  const limit = Math.min(200, Number(c.req.query('limit') ?? 50));
  const where = ['project_id = ?'];
  const params: (string | number)[] = [c.get('projectId')];
  if (source && source !== 'all') where.push('execution_source = ?') && params.push(source);
  if (status && /^[1-5]xx$/.test(status)) where.push("execution_source = 'request' AND status_code >= ? AND status_code < ?") && params.push(Number(status[0]) * 100, Number(status[0]) * 100 + 100);
  if (q) where.push("(name LIKE ? OR trace_id LIKE ? OR coalesce(user, '') LIKE ?)") && params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  if (cursor) {
    const [ts, id] = atob(cursor).split('|');
    where.push('(timestamp < ? OR (timestamp = ? AND trace_id < ?))') && params.push(Number(ts), Number(ts), id);
  }
  const { results } = await c.env.DB.prepare(`SELECT * FROM traces WHERE ${where.join(' AND ')} ORDER BY timestamp DESC, trace_id DESC LIMIT ?`).bind(...params, limit + 1).all<TraceRow>();
  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  return c.json({ data: page.map(summary), next_cursor: results.length > limit && last ? btoa(`${last.timestamp}|${last.trace_id}`) : null });
});

app.get('/v1/projects/:projectId/traces/:traceId', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM traces WHERE project_id = ? AND trace_id = ?').bind(c.get('projectId'), c.req.param('traceId')).first<TraceRow>();
  if (!row) return c.json({ message: 'Not found.' }, 404);
  const stored = (await (await c.env.TRACES.get(row.r2_key))?.json()) as { records: NightwatchRecord[] } | undefined;
  const records = stored?.records ?? [];
  return c.json({ trace: summary(row), spans: spans(row, records), records });
});

/** Derive a waterfall from raw Nightwatch records (timestamps are unix seconds, durations microseconds). */
export function spans(trace: TraceRow, records: NightwatchRecord[]) {
  const start = trace.timestamp / 1000;
  const at = (r: NightwatchRecord) => Math.max(0, ((r.timestamp ?? start) - start) * 1000);
  const dur = (r: NightwatchRecord) => (typeof r.duration === 'number' ? r.duration / 1000 : 0);
  const out: { id: string; type: string; label: string; start_ms: number; duration_ms: number; meta?: Record<string, string | number> }[] = [];
  records.forEach((r, i) => {
    const id = `r${i}`;
    switch (r.t) {
      case 'request': out.push({ id, type: 'request', label: trace.name, start_ms: 0, duration_ms: dur(r) }); break;
      case 'command': case 'scheduled-task': out.push({ id, type: 'controller', label: trace.name, start_ms: 0, duration_ms: dur(r) }); break;
      case 'job-attempt': out.push({ id, type: 'job', label: String(r.name), start_ms: 0, duration_ms: dur(r) }); break;
      case 'query': out.push({ id, type: 'query', label: String(r.sql), start_ms: at(r), duration_ms: dur(r), meta: { connection: String(r.connection ?? ''), file: `${r.file ?? ''}:${r.line ?? ''}`, sql_hash: String(r.sql_hash ?? '') } }); break;
      case 'cache-event': out.push({ id, type: 'cache', label: `cache ${r.type}: ${r.key}`, start_ms: at(r), duration_ms: dur(r) }); break;
      case 'outgoing-request': out.push({ id, type: 'outgoing-request', label: `${r.method} ${r.url}`, start_ms: at(r), duration_ms: dur(r), meta: { status: Number(r.status_code ?? 0) } }); break;
      case 'mail': case 'notification': out.push({ id, type: 'mail', label: String(r.class), start_ms: at(r), duration_ms: dur(r) }); break;
      case 'exception': out.push({ id, type: 'exception', label: `${r.class}: ${r.message}`, start_ms: at(r), duration_ms: 0 }); break;
    }
  });
  return out.sort((a, b) => a.start_ms - b.start_ms);
}

interface ExceptionGroupRow { group: string; class: string; message: string; file: string; line: number; handled: number; count: number; users: number; first_seen: number; last_seen: number; last_trace_id: string }

const EXCEPTION_GROUPS = `
  SELECT group_hash AS "group", class, message, file, line, handled, count(*) AS count, count(DISTINCT user) AS users,
         min(timestamp) AS first_seen, max(timestamp) AS last_seen,
         (SELECT trace_id FROM exceptions e2 WHERE e2.project_id = e.project_id AND e2.group_hash = e.group_hash ORDER BY timestamp DESC LIMIT 1) AS last_trace_id
  FROM exceptions e WHERE project_id = ? AND timestamp >= ?`;

async function trends(db: D1Database, table: 'exceptions' | 'queries', column: string, pid: string, since: number, width: number) {
  const { results } = await db.prepare(`SELECT ${column} AS k, CAST((timestamp - ?) / ? AS INTEGER) AS b, count(*) AS n FROM ${table} WHERE project_id = ? AND timestamp >= ? GROUP BY k, b`)
    .bind(since, width, pid, since).all<{ k: string; b: number; n: number }>();
  const map = new Map<string, number[]>();
  for (const r of results) {
    const t = map.get(r.k) ?? Array<number>(BUCKETS).fill(0);
    t[Math.min(BUCKETS - 1, r.b)] += r.n;
    map.set(r.k, t);
  }
  return (k: string) => map.get(k) ?? Array<number>(BUCKETS).fill(0);
}

const exceptionGroup = (r: ExceptionGroupRow, trend: number[]) => ({ ...r, handled: r.handled === 1, first_seen: iso(r.first_seen), last_seen: iso(r.last_seen), trend });

app.get('/v1/projects/:projectId/exceptions', async (c) => {
  const { since, width } = window(c.req.query('range'));
  const pid = c.get('projectId');
  const [{ results }, trend] = await Promise.all([
    c.env.DB.prepare(`${EXCEPTION_GROUPS} GROUP BY group_hash ORDER BY count DESC LIMIT 100`).bind(pid, since).all<ExceptionGroupRow>(),
    trends(c.env.DB, 'exceptions', 'group_hash', pid, since, width),
  ]);
  return c.json({ data: results.map((r) => exceptionGroup(r, trend(r.group))) });
});

app.get('/v1/projects/:projectId/exceptions/:group', async (c) => {
  const { since, width } = window('24h');
  const pid = c.get('projectId');
  const group = c.req.param('group');
  const row = await c.env.DB.prepare(`${EXCEPTION_GROUPS} AND group_hash = ? GROUP BY group_hash`).bind(pid, 0, group).first<ExceptionGroupRow>();
  if (!row) return c.json({ message: 'Not found.' }, 404);
  const [trend, latest, occurrences] = await Promise.all([
    trends(c.env.DB, 'exceptions', 'group_hash', pid, since, width),
    c.env.DB.prepare('SELECT stack FROM exceptions WHERE project_id = ? AND group_hash = ? ORDER BY timestamp DESC LIMIT 1').bind(pid, group).first<string>('stack'),
    c.env.DB.prepare('SELECT e.trace_id, e.timestamp, coalesce(t.name, e.trace_id) AS name, e.user FROM exceptions e LEFT JOIN traces t ON t.project_id = e.project_id AND t.trace_id = e.trace_id WHERE e.project_id = ? AND e.group_hash = ? ORDER BY e.timestamp DESC LIMIT 25')
      .bind(pid, group).all<{ trace_id: string; timestamp: number; name: string; user: string | null }>(),
  ]);
  let stack: { file: string; source: string }[] = [];
  try {
    stack = (JSON.parse(latest ?? '[]') as { file: string; source: string }[]).map(({ file, source }) => ({ file, source }));
  } catch { /* malformed stack: show none */ }
  return c.json({ ...exceptionGroup(row, trend(group)), stack, occurrences: occurrences.results.map((o) => ({ ...o, timestamp: iso(o.timestamp) })) });
});

interface QueryRow { sql_hash: string; sql: string; connection: string; calls: number; total_ms: number; avg_ms: number; max_ms: number; last_seen: number }

const QUERY_GROUPS = `SELECT sql_hash, sql, connection, count(*) AS calls, sum(duration_ms) AS total_ms, avg(duration_ms) AS avg_ms, max(duration_ms) AS max_ms, max(timestamp) AS last_seen
  FROM queries WHERE project_id = ? AND timestamp >= ?`;

async function p95s(db: D1Database, pid: string, since: number, hash?: string) {
  const { results } = await db.prepare(`SELECT sql_hash, duration_ms FROM queries WHERE project_id = ? AND timestamp >= ? ${hash ? 'AND sql_hash = ?' : ''} LIMIT 50000`)
    .bind(...(hash ? [pid, since, hash] : [pid, since])).all<{ sql_hash: string; duration_ms: number }>();
  const by = new Map<string, number[]>();
  results.forEach((r) => by.set(r.sql_hash, [...(by.get(r.sql_hash) ?? []), r.duration_ms]));
  return (h: string) => percentile(by.get(h) ?? [], 95);
}

const queryGroup = (r: QueryRow, p95: number, trend: number[]) => ({ ...r, p95_ms: p95, last_seen: iso(r.last_seen), trend });

app.get('/v1/projects/:projectId/queries', async (c) => {
  const { since, width } = window(c.req.query('range'));
  const pid = c.get('projectId');
  const [{ results }, p95, trend] = await Promise.all([
    c.env.DB.prepare(`${QUERY_GROUPS} GROUP BY sql_hash ORDER BY total_ms DESC LIMIT 200`).bind(pid, since).all<QueryRow>(),
    p95s(c.env.DB, pid, since),
    trends(c.env.DB, 'queries', 'sql_hash', pid, since, width),
  ]);
  return c.json({ data: results.map((r) => queryGroup(r, p95(r.sql_hash), trend(r.sql_hash))) });
});

app.get('/v1/projects/:projectId/queries/:sqlHash', async (c) => {
  const { since, width } = window('24h');
  const pid = c.get('projectId');
  const hash = c.req.param('sqlHash');
  const row = await c.env.DB.prepare(`${QUERY_GROUPS} AND sql_hash = ? GROUP BY sql_hash`).bind(pid, 0, hash).first<QueryRow>();
  if (!row) return c.json({ message: 'Not found.' }, 404);
  const [p95, trend, samples] = await Promise.all([
    p95s(c.env.DB, pid, 0, hash),
    trends(c.env.DB, 'queries', 'sql_hash', pid, since, width),
    c.env.DB.prepare('SELECT q.trace_id, q.timestamp, q.duration_ms, coalesce(t.name, q.trace_id) AS name, q.file, q.line FROM queries q LEFT JOIN traces t ON t.project_id = q.project_id AND t.trace_id = q.trace_id WHERE q.project_id = ? AND q.sql_hash = ? ORDER BY q.duration_ms DESC LIMIT 20')
      .bind(pid, hash).all<{ trace_id: string; timestamp: number; duration_ms: number; name: string; file: string; line: number }>(),
  ]);
  return c.json({ ...queryGroup(row, p95(hash), trend(hash)), samples: samples.results.map((s) => ({ ...s, timestamp: iso(s.timestamp) })) });
});

app.notFound((c) => c.json({ message: 'Not found.' }, 404));

export default app;
