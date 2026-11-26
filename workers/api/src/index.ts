import { Accounts } from './accounts';
import { login, sessionToken, trustedOrigin } from './login';
import { errorFields, healthChecks, log, shortHash, timeWindow, apiKeyKvKey, usableKey, type ApiKeyRecord, type BlobStore, type KeyStore, type NightwatchRecord, type SqlDatabase } from '@edgewatch/shared';
import { backendHealth, healthResponse, openBackends, type BackendEnv } from '@edgewatch/shared/backends';
import { fail, notFound, observe, onError, storage, type ObservedVariables } from '@edgewatch/shared/hono';
import { Hono, type Context, type Handler } from 'hono';
import { cors } from 'hono/cors';
import { EVENT_SPECS, type EventSpec } from './events';

/** Storage backends (Postgres through Hyperdrive, S3, SQL key store): see BackendEnv. */
export interface Env extends BackendEnv {
  DB: SqlDatabase;
  TRACES: BlobStore;
  API_KEYS: KeyStore;
  CORS_ORIGIN?: string;
  DASHBOARD_ORIGIN?: string;
  OWNER_SETUP_TOKEN?: string;
  OWNER_EMAIL?: string;
  OWNER_PASSWORD?: string;
  OWNER_NAME?: string;
}

const BUCKETS = 24;

interface TraceRow {
  trace_id: string; timestamp: number; execution_source: string; name: string; method: string | null; url: string | null; route: string | null; route_path: string | null;
  status_code: number | null; duration_ms: number; query_count: number; exception_count: number; server: string | null; environment: string | null; user: string | null; r2_key: string;
  project_id: string; peak_memory_usage: number | null; lazy_loads: number | null; route_action: string | null; status: string | null;
}

type AppEnv = { Bindings: Env; Variables: ObservedVariables & { project: string | null } };
const app = new Hono<AppEnv>();
app.use('*', observe('api'));
app.onError(onError('api'));
app.notFound(notFound);
// Before the backend middleware, so a half-configured backend is reported here instead of failing the request.
app.get('/healthz', async (c) =>
  healthResponse(
    await backendHealth('api', c.env, (env, kind) => ({
      events: healthChecks.sql(env.DB, kind.events),
      schema: healthChecks.schema(env.DB, kind.events),
      blobs: healthChecks.blobs(env.TRACES, kind.blobs),
      keys: healthChecks.keys(env.API_KEYS, kind.keys),
    }), { onError: (check, e) => log('api', 'warn', 'health_check_failed', { check, ...errorFields(e) }) }),
  ),
);
app.use('*', async (c, next) => {
  const backends = openBackends(c.env);
  c.env = backends.env;
  if (!backends.connected) return next();
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(backends.close());
  }
});

app.use('*', (c, next) => cors({ origin: c.env.CORS_ORIGIN ?? '*', allowHeaders: ['authorization', 'content-type'] })(c, next));
app.route('/auth', login);
app.get('/health', (c) => c.json({ ok: true }));
// Responses are private telemetry: never let a shared cache keep them.
app.use('/v1/*', async (c, next) => {
  if ((c.req.query('environment')?.length ?? 0) > 128) return fail(c, 400, 'invalid_request', 'Environment must be at most 128 characters.');
  if (!timeWindow(c.req.query('range'))) return fail(c, 400, 'invalid_request', 'Invalid absolute time window. Use custom:<start_ms>:<end_ms> with start before end.');
  await next();
  c.header('Cache-Control', 'private, no-store');
});

async function readKey(c: Context<AppEnv>): Promise<ApiKeyRecord | null> {
  if (!c.req.header('authorization') && sessionToken(c)) {
    const account = await new Accounts(c.env.DB).session(sessionToken(c));
    if (!account) return null;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !trustedOrigin(c)) return null;
    return { project_id: '', name: account.email, scopes: [account.role === 'viewer' ? 'read' : 'admin'] };
  }
  const token = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  // Edge-cached for 60s to skip a KV round trip on every dashboard poll; disabling a key applies within a minute.
  const kvKey = token ? await apiKeyKvKey(token) : null;
  const key = kvKey ? await storage('kv', () => c.env.API_KEYS.get<ApiKeyRecord>(kvKey, { type: 'json', cacheTtl: 60 })) : null;
  return usableKey(key, 'read') || usableKey(key, 'admin') ? key : null;
}

/**
 * Single-tenant: one owner, so any read key sees every project. project_id is only a filter, taken from the
 * /v1/projects/:projectId/... path (used by the dashboard's project selector) or ?project_id= on the /v1/... routes;
 * without it, data from all projects is returned.
 */
app.use('/v1/*', async (c, next) => {
  const key = await readKey(c);
  if (!key) return fail(c, 401, 'unauthenticated', 'Unauthenticated.');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !usableKey(key, 'admin')) {
    return fail(c, 403, 'forbidden', 'This action requires an admin key. Read keys cannot change settings or replay messages.');
  }
  let pathProject: string;
  try { pathProject = decodeURIComponent(c.req.path.match(/^\/v1\/projects\/([^/]+)\//)?.[1] ?? ''); } catch {
    return fail(c, 400, 'invalid_request', 'Invalid project path encoding.');
  }
  const project = pathProject || c.req.query('project_id') || null;
  c.set('project', project);
  if (project) c.set('projectId', project);
  await next();
});

const permissions: Handler<AppEnv> = async (c) => c.json({ can_manage: usableKey(await readKey(c), 'admin') });
app.get('/v1/permissions', permissions);
app.get('/v1/projects/:projectId/permissions', permissions);

/**
 * SQL filter for the optional project. With no project, "? IS NULL" keeps the bind list identical (the null
 * parameter is still bound) and matches every row; with one, the project_id indexes are used.
 */
// Grouped lists use `GROUP BY +column`: the unary + keeps SQLite from walking a whole group index to skip the sort,
// so it searches the time window instead (checked by scripts/d1-indexes.test.ts).
const pf = (pid: string | null, column = 'project_id') => (pid === null ? '? IS NULL' : `${column} = ?`);

/** Environment is execution metadata; correlate child rows by both project and trace ID. */
function environmentScope(value: string | undefined, table: string, alias = table, parameter = '?') {
  if (value === undefined) return { sql: '', values: [] as string[] };
  const predicate = table === 'traces' ? `${alias}.environment = ${parameter}`
    : `EXISTS (SELECT 1 FROM traces environment_trace WHERE environment_trace.project_id = ${alias}.project_id AND environment_trace.trace_id = ${alias}.trace_id AND environment_trace.environment = ${parameter})`;
  return { sql: ` AND ${predicate}`, values: [value] };
}

function userScope(value: string | undefined, alias = '', parameter = '?') {
  return value === undefined ? { sql: '', values: [] as string[] }
    : { sql: ` AND ${alias ? `${alias}.` : ''}user = ${parameter}`, values: [value] };
}

/** Registers a data route both as /v1/projects/:projectId<path> and /v1<path>?project_id=. */
function route(path: string, handler: Handler<AppEnv>) {
  app.get(`/v1/projects/:projectId${path}`, handler);
  app.get(`/v1${path}`, handler);
}

/** Every project that has sent data, for the dashboard's project selector. */
app.get('/v1/projects', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT p.id, p.name, p.daily_record_quota, p.retention_days, (SELECT max(timestamp) FROM traces t WHERE t.project_id = p.id) AS last_seen FROM projects p ORDER BY p.id',
  ).all<{ id: string; name: string; daily_record_quota: number | null; retention_days: number | null; last_seen: number | null }>();
  return c.json({ data: results.map((r) => ({ ...r, last_seen: r.last_seen ? iso(r.last_seen) : null })) });
});

/** Stored in KV under project:<id>; `reason: 'daily_quota'` marks a block written by the consumer's usage metering. */
interface ProjectBlock {
  over_quota_until?: number;
  message?: string;
  reason?: string;
}

const SETTINGS = ['daily_record_quota', 'retention_days'] as const;

/**
 * Per-project settings. Each is a non-negative integer, 0 (no quota / keep forever) or null (use the Worker default:
 * DAILY_RECORD_QUOTA / RETENTION_DAYS on the consumer). Raising or removing the quota lifts today's automatic block.
 */
app.put('/v1/projects/:projectId/settings', async (c) => {
  const id = c.req.param('projectId');
  const body: unknown = await c.req.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail(c, 422, 'unprocessable', 'Body must be a JSON object.');
  const values = new Map<string, number | null>();
  for (const [k, v] of Object.entries(body)) {
    if (!(SETTINGS as readonly string[]).includes(k)) return fail(c, 422, 'unprocessable', `Unknown setting ${k}; allowed: ${SETTINGS.join(', ')}.`);
    if (v !== null && !(Number.isSafeInteger(v) && Number(v) >= 0)) return fail(c, 422, 'unprocessable', `${k} must be a non-negative integer or null.`);
    values.set(k, v as number | null);
  }
  if (!values.size) return fail(c, 422, 'unprocessable', `Set at least one of ${SETTINGS.join(', ')}.`);
  const sets = [...values.keys()].map((k) => `${k} = ?`).join(', ');
  const [, read] = await c.env.DB.batch<{ id: string; daily_record_quota: number | null; retention_days: number | null }>([
    c.env.DB.prepare(`UPDATE projects SET ${sets} WHERE id = ?`).bind(...values.values(), id),
    c.env.DB.prepare('SELECT id, daily_record_quota, retention_days FROM projects WHERE id = ?').bind(id),
  ]);
  const row = read?.results[0];
  if (!row) return fail(c, 404, 'not_found', 'Not found.');
  if (values.has('daily_record_quota')) {
    const quota = row.daily_record_quota;
    const day = new Date().toISOString().slice(0, 10);
    const used = (await c.env.DB.prepare('SELECT records FROM usage_daily WHERE project_id = ? AND day = ?').bind(id, day).first<number>('records')) ?? 0;
    const block = await storage('kv', () => c.env.API_KEYS.get<ProjectBlock>(`project:${id}`, { type: 'json' }));
    if (block?.reason === 'daily_quota' && (quota === null || quota === 0 || quota > used)) {
      await storage('kv', () => c.env.API_KEYS.delete(`project:${id}`));
      await c.env.DB.prepare('UPDATE usage_daily SET blocked_at = NULL WHERE project_id = ? AND day = ?').bind(id, day).run();
    }
  }
  return c.json(row);
});

const iso = (ms: number) => new Date(ms).toISOString();

function window(range: string | undefined) {
  // Invalid custom windows are rejected by the API middleware before handlers execute.
  return timeWindow(range)!;
}

function summary(t: TraceRow) {
  const { r2_key: _r2, ...rest } = t;
  return { ...rest, timestamp: iso(t.timestamp) };
}

route('/overview', async (c) => {
  const { range, since, width, now } = window(c.req.query('range'));
  const pid = c.get('project');
  const scope = environmentScope(c.req.query('environment'), 'traces');
  const exceptionScope = environmentScope(c.req.query('environment'), 'exceptions');
  const queryScope = environmentScope(c.req.query('environment'), 'queries');
  // At most 45 aggregate rows cross into the Worker: one total, 24 buckets, 20 routes.
  const [aggregates, exceptions, slow] = await Promise.all([
    c.env.DB.prepare(`WITH scoped AS (
      SELECT name, duration_ms, CASE WHEN status_code >= 500 THEN 1 ELSE 0 END AS errors,
        min(${BUCKETS - 1}, CAST((timestamp - ?) * ${BUCKETS} / ? AS INTEGER)) AS bucket
      FROM traces WHERE ${pf(pid)} AND timestamp >= ? AND timestamp <= ? AND execution_source = 'request'${scope.sql}
    ), ranked AS (
      SELECT *, row_number() OVER (ORDER BY duration_ms) AS total_rank, count(*) OVER () AS total_count,
        row_number() OVER (PARTITION BY bucket ORDER BY duration_ms) AS bucket_rank, count(*) OVER (PARTITION BY bucket) AS bucket_count,
        row_number() OVER (PARTITION BY name ORDER BY duration_ms) AS route_rank, count(*) OVER (PARTITION BY name) AS route_count
      FROM scoped
    ), route_stats AS (
      SELECT 'route' AS kind, name AS group_key, count(*) AS requests, sum(errors) AS errors,
        max(CASE WHEN route_rank = CAST((route_count * 95 + 99) / 100 AS INTEGER) THEN duration_ms ELSE NULL END) AS p95_ms
      FROM ranked GROUP BY name ORDER BY requests DESC, name LIMIT 20
    ) SELECT 'total' AS kind, '' AS group_key, count(*) AS requests, coalesce(sum(errors), 0) AS errors,
        coalesce(max(CASE WHEN total_rank = CAST((total_count * 95 + 99) / 100 AS INTEGER) THEN duration_ms ELSE NULL END), 0) AS p95_ms
      FROM ranked
    UNION ALL
      SELECT 'bucket' AS kind, CAST(bucket AS TEXT) AS group_key, count(*) AS requests, sum(errors) AS errors,
        max(CASE WHEN bucket_rank = CAST((bucket_count * 95 + 99) / 100 AS INTEGER) THEN duration_ms ELSE NULL END) AS p95_ms
      FROM ranked GROUP BY bucket
    UNION ALL SELECT kind, group_key, requests, errors, p95_ms FROM route_stats`)
      .bind(since, now - since, pid, since, now, ...scope.values).all<{ kind: string; group_key: string; requests: number; errors: number; p95_ms: number }>(),
    c.env.DB.prepare(`SELECT count(*) AS n FROM exceptions WHERE ${pf(pid)} AND timestamp >= ? AND timestamp <= ?${exceptionScope.sql}`).bind(pid, since, now, ...exceptionScope.values).first<number>('n'),
    c.env.DB.prepare(`SELECT count(*) AS n FROM queries WHERE ${pf(pid)} AND timestamp >= ? AND timestamp <= ? AND duration_ms > 100${queryScope.sql}`).bind(pid, since, now, ...queryScope.values).first<number>('n'),
  ]);
  const total = aggregates.results.find((row) => row.kind === 'total')!;
  const buckets = new Map(aggregates.results.filter((row) => row.kind === 'bucket').map((row) => [Number(row.group_key), row]));
  const series = Array.from({ length: BUCKETS }, (_, i) => {
    const row = buckets.get(i);
    return { ts: iso(since + i * width), requests: row?.requests ?? 0, errors: row?.errors ?? 0, p95_ms: row?.p95_ms ?? 0 };
  });
  return c.json({
    range, requests: total.requests, error_rate: total.requests ? total.errors / total.requests : 0, p95_ms: total.p95_ms,
    exceptions: exceptions ?? 0, slow_queries: slow ?? 0, series,
    top_routes: aggregates.results.filter((row) => row.kind === 'route')
      .map((row) => ({ route: row.group_key, requests: row.requests, p95_ms: row.p95_ms, error_rate: row.errors / row.requests }))
      .sort((a, b) => b.requests - a.requests || a.route.localeCompare(b.route)),
  });
});

route('/environments', async (c) => {
  const pid = c.get('project');
  const { results } = await c.env.DB.prepare(`SELECT environment AS name, count(*) AS traces FROM traces WHERE ${pf(pid)} AND environment IS NOT NULL AND environment != '' GROUP BY environment ORDER BY environment LIMIT 200`).bind(pid).all();
  return c.json({ data: results });
});

route('/issues', async (c) => {
  const pid = c.get('project');
  const status = c.req.query('status') ?? 'open';
  if (!['open', 'resolved', 'ignored', 'all'].includes(status)) return fail(c, 400, 'invalid_request', 'Invalid issue status.');
  const offset = Number(c.req.query('offset') ?? 0);
  if (!Number.isInteger(offset) || offset < 0 || offset > 100000) return fail(c, 400, 'invalid_request', 'Invalid offset.');
  const { since, now } = window(c.req.query('range'));
  const environment = c.req.query('environment');
  const scope = environmentScope(environment, 'exceptions', 'ie');
  const where = [pf(pid), environment === undefined ? 'last_seen >= ? AND last_seen <= ?'
    : `EXISTS (SELECT 1 FROM exceptions ie WHERE ie.project_id = issues.project_id AND ie.group_hash = issues.group_hash AND ie.handled = 0 AND ie.timestamp >= ? AND ie.timestamp <= ?${scope.sql})`];
  const params: (string | number | null)[] = [pid, since, now, ...scope.values];
  if (status !== 'all') { where.push('status = ?'); params.push(status); }
  const q = c.req.query('q');
  if (q) { where.push('(class LIKE ? OR message LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const { results } = await c.env.DB.prepare(`SELECT * FROM issues WHERE ${where.join(' AND ')} ORDER BY last_seen DESC, group_hash LIMIT 51 OFFSET ?`).bind(...params, offset).all();
  return c.json({ data: results.slice(0, 50), next_offset: results.length > 50 ? offset + 50 : null, lifecycle_scope: 'project' });
});

route('/issues/:group', async (c) => {
  const pid = c.get('project');
  if (!pid) return fail(c, 400, 'invalid_request', 'Select a project to inspect an issue.');
  const group = c.req.param('group');
  const scope = environmentScope(c.req.query('environment'), 'exceptions');
  const issue = await c.env.DB.prepare('SELECT * FROM issues WHERE project_id = ? AND group_hash = ?').bind(pid, group).first();
  if (!issue) return fail(c, 404, 'not_found', 'Issue not found.');
  const { results: changes } = await c.env.DB.prepare('SELECT id, status, reason, actor, timestamp FROM issue_changes WHERE project_id = ? AND group_hash = ? ORDER BY timestamp DESC, id DESC LIMIT 100').bind(pid, group).all();
  const impact = await c.env.DB.prepare(`SELECT count(*) AS occurrences, count(DISTINCT user) AS users FROM exceptions WHERE project_id = ? AND group_hash = ? AND handled = 0${scope.sql}`).bind(pid, group, ...scope.values).first<{ occurrences: number; users: number }>();
  if (scope.values.length && !impact?.occurrences) return fail(c, 404, 'not_found', 'Issue not found in this environment.');
  return c.json({ issue, changes, impact, lifecycle_scope: 'project' });
});

app.put('/v1/projects/:projectId/issues/:group', async (c) => {
  const body = await c.req.json<{ status?: string; reason?: string; expected_status?: string; expected_revision?: number }>().catch(() => null);
  if (!body || !['open', 'resolved', 'ignored'].includes(body.status ?? '') || typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 500 || !Number.isSafeInteger(body.expected_revision) || (body.expected_revision ?? -1) < 0) {
    return fail(c, 422, 'unprocessable', 'Choose open, resolved, or ignored, provide a reason (1–500 characters), and send the current expected_revision.');
  }
  const pid = c.get('project');
  const group = c.req.param('group');
  const issue = await c.env.DB.prepare('SELECT status, revision FROM issues WHERE project_id = ? AND group_hash = ?').bind(pid, group).first<{ status: string; revision: number }>();
  if (!issue) return fail(c, 404, 'not_found', 'Issue not found.');
  const expected = body.expected_status ?? issue.status;
  if (issue.status !== expected || issue.revision !== body.expected_revision) return fail(c, 409, 'conflict', 'Issue changed. Refresh and try again.');
  if (issue.status === body.status) return c.json({ status: body.status, revision: issue.revision });
  const now = Date.now();
  const actor = (await readKey(c))?.name ?? 'admin';
  const changeId = crypto.randomUUID();
  const [changed] = await c.env.DB.batch([
    c.env.DB.prepare('UPDATE issues SET status = ?, resolved_at = ?, revision = revision + 1, change_id = ? WHERE project_id = ? AND group_hash = ? AND status = ? AND revision = ?')
      .bind(body.status, body.status === 'resolved' ? now : null, changeId, pid, group, expected, body.expected_revision),
    c.env.DB.prepare(`INSERT INTO issue_changes (id, project_id, group_hash, status, reason, actor, timestamp)
      SELECT ?, project_id, group_hash, ?, ?, ?, ? FROM issues WHERE project_id = ? AND group_hash = ? AND change_id = ?`)
      .bind(changeId, body.status, body.reason.trim(), actor, now, pid, group, changeId),
  ]);
  if (!changed.meta.changes) return fail(c, 409, 'conflict', 'Issue changed. Refresh and try again.');
  return c.json({ status: body.status, revision: issue.revision + 1 });
});

route('/log-entries', async (c) => {
  const pid = c.get('project');
  const { since, now } = window(c.req.query('range'));
  const { level, q, cursor, user } = c.req.query();
  const scope = environmentScope(c.req.query('environment'), 'logs');
  const where = [pf(pid), 'timestamp >= ?', 'timestamp <= ?'];
  const params: (string | number | null)[] = [pid, since, now];
  if (level && level !== 'all') { where.push('level = ?'); params.push(level); }
  if (q) { where.push('message LIKE ?'); params.push(`%${q}%`); }
  if (user !== undefined) { where.push('user = ?'); params.push(user); }
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (!decoded || !/^\d+$/.test(decoded[1])) return fail(c, 400, 'invalid_request', 'Invalid cursor.');
    const [ts, id] = decoded;
    where.push('(timestamp < ? OR (timestamp = ? AND id < ?))'); params.push(ts, ts, Number(id));
  }
  const { results } = await c.env.DB.prepare(`SELECT id, project_id, trace_id, timestamp, level, message, context, user, server FROM logs WHERE ${where.join(' AND ')}${scope.sql} ORDER BY timestamp DESC, id DESC LIMIT 51`)
    .bind(...params, ...scope.values).all<{ id: number; timestamp: number }>();
  const page = results.slice(0, 50);
  const last = page.at(-1);
  return c.json({ data: page.map((r) => ({ ...r, timestamp: iso(r.timestamp) })), next_cursor: results.length > 50 && last ? btoa(`${last.timestamp}|${last.id}`) : null });
});

/** An entry link resolves independently of feed search/pagination, within the investigation scope. */
route('/log-entries/:entryId', async (c) => {
  const id = c.req.param('entryId') ?? '';
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) return fail(c, 400, 'invalid_request', 'Invalid log entry ID.');
  const pid = c.get('project');
  const user = userScope(c.req.query('user'));
  const { since, now } = window(c.req.query('range'));
  const scope = environmentScope(c.req.query('environment'), 'logs');
  const row = await c.env.DB.prepare(`SELECT id, project_id, trace_id, timestamp, level, message, context, user, server,
    CASE WHEN EXISTS (SELECT 1 FROM traces t WHERE t.project_id = logs.project_id AND t.trace_id = logs.trace_id) THEN 1 ELSE 0 END AS execution_available,
    (SELECT environment FROM traces t WHERE t.project_id = logs.project_id AND t.trace_id = logs.trace_id) AS environment
    FROM logs WHERE ${pf(pid)} AND id = ? AND timestamp >= ? AND timestamp <= ?${scope.sql}${user.sql} LIMIT 1`)
    .bind(pid, Number(id), since, now, ...scope.values, ...user.values).first<{ timestamp: number }>();
  if (!row) return fail(c, 404, 'not_found', 'Log entry not found in this scope.');
  return c.json({ ...row, timestamp: iso(row.timestamp) });
});

// Group on captured metadata only; concrete URL paths are not route templates.
const requestRoute = "coalesce(nullif(route, ''), nullif(route_path, ''), '[unnamed]')";
const requestRouteKind = "CASE WHEN nullif(route, '') IS NOT NULL THEN 'name' WHEN nullif(route_path, '') IS NOT NULL THEN 'path' ELSE 'unknown' END";
route('/requests', async (c) => {
  const pid = c.get('project');
  const scope = environmentScope(c.req.query('environment'), 'traces');
  const user = userScope(c.req.query('user'));
  const { since, now } = window(c.req.query('range'));
  const requested = Number(c.req.query('offset') ?? 0);
  if (!Number.isInteger(requested) || requested < 0 || requested > 100000) return fail(c, 400, 'invalid_request', 'Invalid offset.');
  const q = c.req.query('q') ?? '';
  const { results } = await c.env.DB.prepare(`WITH scoped AS (
    SELECT coalesce(method, 'UNKNOWN') AS method, ${requestRoute} AS route, ${requestRouteKind} AS route_kind, duration_ms, status_code
    FROM traces WHERE ${pf(pid)} AND execution_source = 'request' AND timestamp >= ? AND timestamp <= ?
      AND (${requestRoute} LIKE ? OR coalesce(method, '') LIKE ?)${scope.sql}${user.sql}
  ), ranked AS (
    SELECT *, row_number() OVER (PARTITION BY method, route_kind, route ORDER BY duration_ms) AS duration_rank,
      count(*) OVER (PARTITION BY method, route_kind, route) AS population FROM scoped
  ) SELECT method, route, route_kind, count(*) AS requests, avg(duration_ms) AS avg_ms,
    max(CASE WHEN duration_rank = CAST((population * 95 + 99) / 100 AS INTEGER) THEN duration_ms ELSE NULL END) AS p95_ms,
    sum(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) AS status_2xx,
    sum(CASE WHEN status_code >= 300 AND status_code < 400 THEN 1 ELSE 0 END) AS status_3xx,
    sum(CASE WHEN status_code >= 400 AND status_code < 500 THEN 1 ELSE 0 END) AS status_4xx,
    sum(CASE WHEN status_code >= 500 AND status_code < 600 THEN 1 ELSE 0 END) AS status_5xx,
    sum(CASE WHEN status_code IS NULL OR status_code < 200 OR status_code >= 600 THEN 1 ELSE 0 END) AS status_other
    FROM ranked GROUP BY method, route_kind, route ORDER BY requests DESC, method, route_kind, route LIMIT 51 OFFSET ?`)
    .bind(pid, since, now, `%${q}%`, `%${q}%`, ...scope.values, ...user.values, requested).all();
  return c.json({ data: results.slice(0, 50), next_offset: results.length > 50 ? requested + 50 : null, since: iso(since), until: iso(now) });
});

route('/requests/trend', async (c) => {
  const pid = c.get('project');
  const { since, now, width } = window(c.req.query('range'));
  const { route: name, route_kind: kind = 'name', method, status, min_duration_ms: minimum } = c.req.query();
  if (name === undefined || !['name', 'path', 'unknown'].includes(kind)) return fail(c, 400, 'invalid_request', 'Select a route and a valid route kind.');
  const where = [pf(pid), "execution_source = 'request'", 'timestamp >= ?', 'timestamp <= ?', `${requestRoute} = ?`, `(${requestRouteKind}) = ?`];
  const params: (string | number | null)[] = [since, now - since, pid, since, now, name, kind];
  const environment = c.req.query('environment');
  if (environment !== undefined) { where.push('environment = ?'); params.push(environment); }
  if (c.req.query('user') !== undefined) { where.push('user = ?'); params.push(c.req.query('user')!); }
  if (method) { where.push("coalesce(method, 'UNKNOWN') = ?"); params.push(method); }
  if (status && status !== 'all') {
    if (!/^[1-5]xx$/.test(status)) return fail(c, 400, 'invalid_request', 'Invalid HTTP status family.');
    where.push('status_code >= ? AND status_code < ?'); params.push(Number(status[0]) * 100, Number(status[0]) * 100 + 100);
  }
  if (minimum !== undefined) {
    const value = Number(minimum);
    if (!minimum.trim() || !Number.isFinite(value) || value < 0) return fail(c, 400, 'invalid_request', 'Minimum duration must be a non-negative number of milliseconds.');
    where.push('duration_ms >= ?'); params.push(value);
  }
  const { results } = await c.env.DB.prepare(`WITH scoped AS (
    SELECT min(${BUCKETS - 1}, CAST((timestamp - ?) * ${BUCKETS} / ? AS INTEGER)) AS bucket, duration_ms, status_code
    FROM traces WHERE ${where.join(' AND ')}
  ), ranked AS (
    SELECT *, row_number() OVER (PARTITION BY bucket ORDER BY duration_ms) AS duration_rank,
      count(*) OVER (PARTITION BY bucket) AS population FROM scoped
  ) SELECT bucket, count(*) AS requests,
    sum(CASE WHEN status_code >= 500 AND status_code < 600 THEN 1 ELSE 0 END) AS errors,
    max(CASE WHEN duration_rank = CAST((population * 95 + 99) / 100 AS INTEGER) THEN duration_ms ELSE NULL END) AS p95_ms
    FROM ranked GROUP BY bucket`).bind(...params).all<{ bucket: number; requests: number; errors: number; p95_ms: number }>();
  const buckets = new Map(results.map((row) => [row.bucket, row]));
  return c.json({ since: iso(since), until: iso(now), series: Array.from({ length: BUCKETS }, (_, i) => {
    const row = buckets.get(i);
    return { ts: iso(since + i * width), requests: row?.requests ?? 0, errors: row?.errors ?? 0, p95_ms: row?.p95_ms ?? 0 };
  }) });
});

route('/traces', async (c) => {
  const { source, status, q, cursor, range, route: routeName, route_kind: routeKind, method } = c.req.query();
  const requested = Number(c.req.query('limit') ?? 50);
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(200, requested) : 50;
  const pid = c.get('project');
  const where = [pf(pid)];
  const params: (string | number | null)[] = [pid];
  if (source && source !== 'all') where.push('execution_source = ?') && params.push(source);
  if (status && /^[1-5]xx$/.test(status)) where.push("execution_source = 'request' AND status_code >= ? AND status_code < ?") && params.push(Number(status[0]) * 100, Number(status[0]) * 100 + 100);
  if (routeName !== undefined) {
    if (routeKind && !['name', 'path', 'unknown'].includes(routeKind)) return fail(c, 400, 'invalid_request', 'Invalid route kind.');
    where.push(`${routeKind ? requestRoute : "coalesce(route, '[unnamed]')"} = ?`); params.push(routeName);
    if (routeKind) { where.push(`(${requestRouteKind}) = ?`); params.push(routeKind); }
  }
  if (method) where.push("coalesce(method, 'UNKNOWN') = ?") && params.push(method);
  for (const field of ['user', 'server', 'environment'] as const) {
    const value = c.req.query(field);
    if (value !== undefined) { where.push(`${field} = ?`); params.push(value); }
  }
  const minimumDuration = c.req.query('min_duration_ms');
  if (minimumDuration !== undefined) {
    const value = Number(minimumDuration);
    if (!minimumDuration.trim() || !Number.isFinite(value) || value < 0) return fail(c, 400, 'invalid_request', 'Minimum duration must be a non-negative number of milliseconds.');
    where.push('duration_ms >= ?'); params.push(value);
  }
  if (range) {
    const { since, now } = window(range);
    where.push('timestamp >= ? AND timestamp <= ?'); params.push(since, now);
  }
  if (q) where.push("(name LIKE ? OR trace_id LIKE ? OR coalesce(user, '') LIKE ?)") && params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  if (cursor) {
    const [ts, id] = decodeCursor(cursor) ?? [];
    if (ts === undefined || id === undefined) return fail(c, 400, 'invalid_request', 'Invalid cursor.');
    where.push('(timestamp < ? OR (timestamp = ? AND trace_id < ?))') && params.push(Number(ts), Number(ts), id);
  }
  const { results } = await c.env.DB.prepare(`SELECT * FROM traces WHERE ${where.join(' AND ')} ORDER BY timestamp DESC, trace_id DESC LIMIT ?`).bind(...params, limit + 1).all<TraceRow>();
  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  return c.json({ data: page.map(summary), next_cursor: results.length > limit && last ? btoa(`${last.timestamp}|${last.trace_id}`) : null });
});

function decodeCursor(cursor: string): [number, string] | null {
  try {
    const parts = atob(cursor).split('|');
    const [ts, id] = parts;
    return parts.length === 2 && /^\d+$/.test(ts ?? '') && Number.isSafeInteger(Number(ts)) && id ? [Number(ts), id] : null;
  } catch {
    return null;
  }
}

/** Raw stored trace, streamed straight from R2 without parsing (large traces never sit in Worker memory). */
route('/traces/:traceId/raw', async (c) => {
  const scope = environmentScope(c.req.query('environment'), 'traces');
  const row = await c.env.DB.prepare(`SELECT r2_key FROM traces WHERE ${pf(c.get('project'))} AND trace_id = ?${scope.sql} LIMIT 1`).bind(c.get('project'), (c.req.param('traceId') ?? ''), ...scope.values).first<{ r2_key: string }>();
  const object = row ? await storage('r2', () => c.env.TRACES.get(row.r2_key)) : null;
  if (!object) return fail(c, 404, 'not_found', 'Not found.');
  return c.body(object.body, 200, { 'content-type': 'application/json', 'content-length': String(object.size) });
});

route('/traces/:traceId', async (c) => {
  const scope = environmentScope(c.req.query('environment'), 'traces');
  const row = await c.env.DB.prepare(`SELECT * FROM traces WHERE ${pf(c.get('project'))} AND trace_id = ?${scope.sql} LIMIT 1`).bind(c.get('project'), (c.req.param('traceId') ?? ''), ...scope.values).first<TraceRow>();
  if (!row) return fail(c, 404, 'not_found', 'Not found.');
  const stored = await storage('r2', async () => (await c.env.TRACES.get(row.r2_key))?.json<{ records?: NightwatchRecord[]; dropped_records?: number }>());
  const records = stored?.records ?? [];
  const user = row.user
    ? await c.env.DB.prepare('SELECT id, name, username FROM users WHERE project_id = ? AND id = ?').bind(row.project_id, row.user).first<{ id: string; name: string | null; username: string | null }>()
    : null;
  const origin = (row as TraceRow & { origin_trace_id?: string | null }).origin_trace_id ?? null;
  const { results: related } = await c.env.DB.prepare(
    `SELECT trace_id, timestamp, execution_source, name, status, duration_ms, origin_trace_id FROM traces
     WHERE project_id = ? AND trace_id != ? AND (origin_trace_id = ? OR trace_id = ? OR (origin_trace_id IS NOT NULL AND origin_trace_id = ?))${scope.sql} ORDER BY timestamp LIMIT 50`,
  ).bind(row.project_id, row.trace_id, row.trace_id, origin ?? '', origin ?? '', ...scope.values).all<{ timestamp: number }>();
  return c.json({ trace: summary(row), spans: await spans(row, records), records,
    capture: { records_available: Array.isArray(stored?.records), dropped_records: stored?.dropped_records ?? 0 }, repeated_queries: repeatedQueries(records), user,
    related: related.map((r) => ({ ...r, timestamp: iso(r.timestamp) })) });
});

/**
 * N+1 signal: the same normalized statement (sql_hash) run N_PLUS_ONE_MIN+ times in one trace. Nightwatch itself only
 * reports `lazy_loads` on the root record; this makes repeated queries visible for any execution type.
 */
const N_PLUS_ONE_MIN = 5;
function repeatedQueries(records: NightwatchRecord[]) {
  const by = new Map<string, { sql_hash: string; sql: string; count: number; total_ms: number }>();
  for (const r of records) {
    if (r.t !== 'query' || typeof r.sql_hash !== 'string') continue;
    const g = by.get(r.sql_hash) ?? { sql_hash: r.sql_hash, sql: String(r.sql), count: 0, total_ms: 0 };
    g.count++;
    g.total_ms += (typeof r.duration === 'number' ? r.duration : 0) / 1000;
    by.set(r.sql_hash, g);
  }
  return [...by.values()].filter((g) => g.count >= N_PLUS_ONE_MIN).sort((a, b) => b.count - a.count);
}

/** Derive a waterfall from raw Nightwatch records (timestamps are unix seconds, durations microseconds). */
async function spans(trace: TraceRow, records: NightwatchRecord[]) {
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
      case 'mail': case 'notification': out.push({ id, type: 'mail', label: String(r.class), start_ms: at(r), duration_ms: dur(r), meta: { channel: String(r.channel ?? r.mailer ?? ''), failed: r.failed ? 1 : 0 } }); break;
      case 'queued-job': out.push({ id, type: 'queued-job', label: `queued ${r.name}`, start_ms: at(r), duration_ms: dur(r), meta: { connection: String(r.connection ?? ''), queue: String(r.queue ?? '') } }); break;
      case 'log': out.push({ id, type: 'log', label: `[${r.level}] ${r.message}`, start_ms: at(r), duration_ms: 0 }); break;
      case 'exception': out.push({ id, type: 'exception', label: `${r.class}: ${r.message}`, start_ms: at(r), duration_ms: 0 }); break;
    }
  });
  // Content identity survives partial delivery, retention caps, and record reordering.
  return (await Promise.all(out.map(async (span) => ({
    ...span, id: await shortHash(JSON.stringify(records[Number(span.id.slice(1))])),
  })))).sort((a, b) => a.start_ms - b.start_ms || a.id.localeCompare(b.id));
}

interface ExceptionGroupRow { group: string; class: string; message: string; file: string; line: number; handled: number; handled_count: number; unhandled_count: number; count: number; users: number; first_seen: number; last_seen: number; last_trace_id: string }

const exceptionGroups = (pid: string | null, environment?: string, user?: string) => `
  SELECT group_hash AS "group", max(class) AS class, max(message) AS message, max(file) AS file, max(line) AS line, min(handled) AS handled, sum(CASE WHEN handled = 1 THEN 1 ELSE 0 END) AS handled_count, sum(CASE WHEN handled = 0 THEN 1 ELSE 0 END) AS unhandled_count,
         count(*) AS count, count(DISTINCT user) AS users, min(timestamp) AS first_seen, max(timestamp) AS last_seen,
         (SELECT trace_id FROM exceptions e2 WHERE ${pid === null ? '' : 'e2.project_id = ?1 AND '}e2.group_hash = e.group_hash AND e2.timestamp >= ?2 AND e2.timestamp <= ?3${environmentScope(environment, 'exceptions', 'e2', '?4').sql}${userScope(user, 'e2', environment === undefined ? '?4' : '?5').sql} ORDER BY timestamp DESC LIMIT 1) AS last_trace_id
  FROM exceptions e WHERE ${pid === null ? '?1 IS NULL' : 'e.project_id = ?1'} AND timestamp >= ?2 AND timestamp <= ?3${environmentScope(environment, 'exceptions', 'e', '?4').sql}${userScope(user, 'e', environment === undefined ? '?4' : '?5').sql}`;

async function trends(db: SqlDatabase, table: 'exceptions' | 'queries', column: string, pid: string | null, since: number, now: number, keys: string[], environment?: string, user?: string) {
  const scope = environmentScope(environment, table);
  const capturedUser = userScope(user);
  const map = new Map<string, number[]>();
  // Keep each statement below D1's bound-parameter limit, including time/project/environment scope.
  // Never retrieve trends for groups outside the visible page (or the selected detail).
  for (let offset = 0; offset < keys.length; offset += 80) {
    const batch = keys.slice(offset, offset + 80);
    const { results } = await db.prepare(`SELECT ${column} AS k, CAST((timestamp - ?) * ${BUCKETS} / ? AS INTEGER) AS b, count(*) AS n FROM ${table} WHERE ${pf(pid)} AND timestamp >= ? AND timestamp <= ?${scope.sql}${capturedUser.sql} AND ${column} IN (${batch.map(() => '?').join(',')}) GROUP BY k, b`)
      .bind(since, now - since, pid, since, now, ...scope.values, ...capturedUser.values, ...batch).all<{ k: string; b: number; n: number }>();
    for (const r of results) {
      const t = map.get(r.k) ?? Array<number>(BUCKETS).fill(0);
      t[Math.min(BUCKETS - 1, r.b)] += r.n;
      map.set(r.k, t);
    }
  }
  return (k: string) => map.get(k) ?? Array<number>(BUCKETS).fill(0);
}

const exceptionGroup = (r: ExceptionGroupRow, trend: number[]) => ({ ...r, handled: r.handled === 1, first_seen: iso(r.first_seen), last_seen: iso(r.last_seen), trend });

// Literal contains search: SQL wildcard characters in telemetry searches are ordinary text.
const containsPattern = (value: string) => `%${value.trim().replace(/[!%_]/g, '!$&')}%`;
const listOffset = (value: string | undefined) => {
  const offset = Number(value ?? 0);
  return Number.isSafeInteger(offset) && offset >= 0 && offset <= Number.MAX_SAFE_INTEGER - 200 ? offset : null;
};

route('/exceptions', async (c) => {
  const { since, now } = window(c.req.query('range'));
  const pid = c.get('project');
  const environment = c.req.query('environment');
  const scope = environmentScope(environment, 'exceptions');
  const user = c.req.query('user');
  const capturedUser = userScope(user);
  const offset = listOffset(c.req.query('offset'));
  const handled = c.req.query('handled') ?? 'all';
  if (offset === null || !['all', 'handled', 'unhandled'].includes(handled)) return fail(c, 400, 'invalid_request', 'Invalid exception filters.');
  const q = containsPattern(c.req.query('q') ?? '');
  const { results } = await c.env.DB.prepare(`SELECT * FROM (${exceptionGroups(pid, environment, user)} GROUP BY +group_hash) grouped
      WHERE (lower(class) LIKE lower(?) ESCAPE '!' OR lower(message) LIKE lower(?) ESCAPE '!' OR lower(file) LIKE lower(?) ESCAPE '!')
      ${handled === 'all' ? '' : 'AND handled = ?'} ORDER BY count DESC, "group" LIMIT 101 OFFSET ?`)
      .bind(pid, since, now, ...scope.values, ...capturedUser.values, q, q, q, ...(handled === 'all' ? [] : [handled === 'handled' ? 1 : 0]), offset).all<ExceptionGroupRow>();
  const page = results.slice(0, 100);
  const trend = await trends(c.env.DB, 'exceptions', 'group_hash', pid, since, now, page.map((row) => row.group), environment, user);
  return c.json({ data: page.map((r) => exceptionGroup(r, trend(r.group))), next_offset: results.length > 100 ? offset + 100 : null });
});

route('/exceptions/:group', async (c) => {
  const { since, now } = window(c.req.query('range'));
  const pid = c.get('project');
  const environment = c.req.query('environment');
  const scope = environmentScope(environment, 'exceptions');
  const user = c.req.query('user');
  const capturedUser = userScope(user);
  const group = (c.req.param('group') ?? '');
  const row = await c.env.DB.prepare(`${exceptionGroups(pid, environment, user)} AND group_hash = ? GROUP BY group_hash`).bind(pid, since, now, ...scope.values, ...capturedUser.values, group).first<ExceptionGroupRow>();
  if (!row) return fail(c, 404, 'not_found', 'Not found.');
  const [trend, latest, occurrences] = await Promise.all([
    trends(c.env.DB, 'exceptions', 'group_hash', pid, since, now, [group], environment, user),
    c.env.DB.prepare(`SELECT stack FROM exceptions WHERE ${pf(pid)} AND group_hash = ? AND timestamp >= ? AND timestamp <= ?${scope.sql}${capturedUser.sql} ORDER BY timestamp DESC LIMIT 1`).bind(pid, group, since, now, ...scope.values, ...capturedUser.values).first<string>('stack'),
    c.env.DB.prepare(`SELECT e.trace_id, e.timestamp, coalesce(t.name, e.trace_id) AS name, e.user FROM exceptions e LEFT JOIN traces t ON t.project_id = e.project_id AND t.trace_id = e.trace_id WHERE ${pf(pid, 'e.project_id')} AND e.group_hash = ? AND e.timestamp >= ? AND e.timestamp <= ?${environmentScope(environment, 'exceptions', 'e').sql}${userScope(user, 'e').sql} ORDER BY e.timestamp DESC LIMIT 25`)
      .bind(pid, group, since, now, ...scope.values, ...capturedUser.values).all<{ trace_id: string; timestamp: number; name: string; user: string | null }>(),
  ]);
  let stack: { file: string; source: string }[] = [];
  try {
    stack = (JSON.parse(latest ?? '[]') as { file: string; source: string }[]).map(({ file, source }) => ({ file, source }));
  } catch { /* malformed stack: show none */ }
  return c.json({ ...exceptionGroup(row, trend(group)), stack, occurrences: occurrences.results.map((o) => ({ ...o, timestamp: iso(o.timestamp) })) });
});

interface QueryRow { sql_hash: string; sql: string; connection: string; calls: number; total_ms: number; avg_ms: number; p95_ms: number; max_ms: number; last_seen: number }

// Compute all statistics over one SQL snapshot; only grouped results cross the Worker boundary.
const queryGroups = (pid: string | null, single = false, environment?: string) => `WITH ranked AS (
  SELECT sql_hash, sql, connection, duration_ms, timestamp,
    row_number() OVER (PARTITION BY sql_hash ORDER BY duration_ms) AS duration_rank,
    count(*) OVER (PARTITION BY sql_hash) AS population
  FROM queries WHERE ${pf(pid)} AND timestamp >= ? AND timestamp <= ?${environmentScope(environment, 'queries').sql} ${single ? 'AND sql_hash = ?' : ''}
) SELECT sql_hash, max(sql) AS sql, max(connection) AS connection, count(*) AS calls,
    sum(duration_ms) AS total_ms, avg(duration_ms) AS avg_ms, max(duration_ms) AS max_ms,
    max(CASE WHEN duration_rank = CAST((population * 95 + 99) / 100 AS INTEGER) THEN duration_ms ELSE NULL END) AS p95_ms,
    max(timestamp) AS last_seen
  FROM ranked GROUP BY sql_hash`;

const queryGroup = (r: QueryRow, trend: number[]) => ({ ...r, last_seen: iso(r.last_seen), trend });

route('/queries', async (c) => {
  const { since, now } = window(c.req.query('range'));
  const pid = c.get('project');
  const environment = c.req.query('environment');
  const scope = environmentScope(environment, 'queries');
  const offset = listOffset(c.req.query('offset'));
  const sort = c.req.query('sort') ?? 'total_ms';
  if (offset === null || !['total_ms', 'calls', 'p95_ms'].includes(sort)) return fail(c, 400, 'invalid_request', 'Invalid query filters.');
  const q = containsPattern(c.req.query('q') ?? '');
  const { results } = await c.env.DB.prepare(`SELECT * FROM (${queryGroups(pid, false, environment)}) grouped
      WHERE lower(sql) LIKE lower(?) ESCAPE '!' OR lower(connection) LIKE lower(?) ESCAPE '!' OR lower(sql_hash) LIKE lower(?) ESCAPE '!'
      ORDER BY ${sort} DESC, sql_hash LIMIT 201 OFFSET ?`).bind(pid, since, now, ...scope.values, q, q, q, offset).all<QueryRow>();
  const page = results.slice(0, 200);
  const trend = await trends(c.env.DB, 'queries', 'sql_hash', pid, since, now, page.map((row) => row.sql_hash), environment);
  return c.json({ data: page.map((r) => queryGroup(r, trend(r.sql_hash))), next_offset: results.length > 200 ? offset + 200 : null });
});

route('/queries/:sqlHash', async (c) => {
  const { since, now } = window(c.req.query('range'));
  const pid = c.get('project');
  const environment = c.req.query('environment');
  const scope = environmentScope(environment, 'queries');
  const hash = (c.req.param('sqlHash') ?? '');
  const row = await c.env.DB.prepare(queryGroups(pid, true, environment)).bind(pid, since, now, ...scope.values, hash).first<QueryRow>();
  if (!row) return fail(c, 404, 'not_found', 'Not found.');
  const [trend, samples] = await Promise.all([
    trends(c.env.DB, 'queries', 'sql_hash', pid, since, now, [hash], environment),
    c.env.DB.prepare(`SELECT q.trace_id, q.timestamp, q.duration_ms, coalesce(t.name, q.trace_id) AS name, q.file, q.line FROM queries q LEFT JOIN traces t ON t.project_id = q.project_id AND t.trace_id = q.trace_id WHERE ${pf(pid, 'q.project_id')} AND q.sql_hash = ? AND q.timestamp >= ? AND q.timestamp <= ?${environmentScope(environment, 'queries', 'q').sql} ORDER BY q.duration_ms DESC LIMIT 20`)
      .bind(pid, hash, since, now, ...scope.values).all<{ trace_id: string; timestamp: number; duration_ms: number; name: string; file: string; line: number }>(),
  ]);
  return c.json({ ...queryGroup(row, trend(hash)), samples: samples.results.map((s) => ({ ...s, timestamp: iso(s.timestamp) })) });
});

function eventList(spec: EventSpec): Handler<AppEnv> {
  return async (c) => {
    const pid = c.get('project');
    const scope = environmentScope(c.req.query('environment'), spec.table);
    const user = userScope(c.req.query('user'));
    const { since, now } = window(c.req.query('range'));
    const where = [pf(pid), 'timestamp >= ?', 'timestamp <= ?', ...(spec.where ? [spec.where] : [])];
    const params: (string | number | null)[] = [pid, since, now];
    for (const [param, condition] of Object.entries(spec.filters ?? {})) {
      const value = c.req.query(param);
      if (value && value !== 'all') where.push(condition) && params.push(value);
    }
    const q = c.req.query('q');
    if (q && spec.search?.length) where.push(`(${spec.search.map((col) => `coalesce(${col}, '') LIKE ?`).join(' OR ')})`) && params.push(...spec.search.map(() => `%${q}%`));
    const sql = spec.group
      ? `SELECT ${spec.group} AS key, count(*) AS count, max(timestamp) AS last_seen${spec.aggregates ? `, ${spec.aggregates}` : ''} FROM ${spec.table} WHERE ${where.join(' AND ')}${scope.sql}${user.sql} GROUP BY +${spec.group} ORDER BY ${spec.order ?? 'count DESC'} LIMIT 200`
      : `SELECT * FROM ${spec.table} WHERE ${where.join(' AND ')}${scope.sql}${user.sql} ORDER BY timestamp DESC, id DESC LIMIT 200`;
    const [{ results }, summary] = await Promise.all([
      c.env.DB.prepare(sql).bind(...params, ...scope.values, ...user.values).all<Record<string, unknown> & { last_seen?: number; timestamp?: number }>(),
      spec.summary ? c.env.DB.prepare(`SELECT ${spec.summary} FROM ${spec.table} WHERE ${where.join(' AND ')}${scope.sql}${user.sql}`).bind(...params, ...scope.values, ...user.values).first<Record<string, number | null>>() : null,
    ]);
    return c.json({
      data: results.map(({ project_id: _p, ...r }) => ({ ...r, ...(r.last_seen ? { last_seen: iso(r.last_seen) } : {}), ...(r.timestamp ? { timestamp: iso(r.timestamp) } : {}) })),
      ...(summary ? { summary: Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, v ?? 0])) } : {}),
    });
  };
}

function eventDetail(spec: EventSpec): Handler<AppEnv> {
  return async (c) => {
    const pid = c.get('project');
    const scope = environmentScope(c.req.query('environment'), spec.table);
    const user = userScope(c.req.query('user'));
    const { since, now } = window(c.req.query('range'));
    const { results } = await c.env.DB.prepare(
      `SELECT e.*, coalesce(t.name, e.trace_id) AS trace_name FROM ${spec.table} e LEFT JOIN traces t ON t.project_id = e.project_id AND t.trace_id = e.trace_id
       WHERE ${pf(pid, 'e.project_id')} AND e.${spec.group} = ? AND e.timestamp >= ? AND e.timestamp <= ?${environmentScope(c.req.query('environment'), spec.table, 'e').sql}${userScope(c.req.query('user'), 'e').sql}${spec.where ? ` AND e.${spec.where}` : ''} ORDER BY e.timestamp DESC LIMIT 50`,
    ).bind(pid, c.req.param('key') ?? '', since, now, ...scope.values, ...user.values).all<Record<string, unknown> & { timestamp: number }>();
    if (!results.length) return fail(c, 404, 'not_found', 'Not found.');
    return c.json({ data: results.map(({ project_id: _p, ...r }) => ({ ...r, timestamp: iso(r.timestamp) })) });
  };
}

/**
 * Pipeline health: dead letters (filtered by project) and consumer stats for the whole pipeline (throughput, retries
 * and queue lag per minute, written by workers/consumer). Queue lag is how long the oldest message of a batch waited.
 */
route('/pipeline', async (c) => {
  const pid = c.get('project');
  const now = Date.now();
  const [dead, minutes] = await Promise.all([
    c.env.DB.prepare(`SELECT count(*) AS count, min(failed_at) AS oldest, sum(replay_requested_at IS NOT NULL) AS replay_pending FROM dead_letters WHERE ${pf(pid)}`)
      .bind(pid).first<{ count: number; oldest: number | null; replay_pending: number | null }>(),
    c.env.DB.prepare('SELECT minute, batches, messages, retried, max_lag_ms FROM pipeline_minutes WHERE minute >= ? ORDER BY minute')
      .bind(now - 3_600_000).all<{ minute: number; batches: number; messages: number; retried: number; max_lag_ms: number }>(),
  ]);
  const rows = minutes.results;
  const recent = rows.filter((r) => r.minute >= now - 5 * 60_000);
  return c.json({
    dead_letters: { count: dead?.count ?? 0, oldest_failed_at: dead?.oldest ? iso(dead.oldest) : null, replay_pending: dead?.replay_pending ?? 0 },
    consumer: {
      last_batch_at: rows.length ? iso(rows[rows.length - 1].minute) : null,
      messages_1h: rows.reduce((n, r) => n + r.messages, 0),
      retried_1h: rows.reduce((n, r) => n + r.retried, 0),
      max_lag_ms_5m: Math.max(0, ...recent.map((r) => r.max_lag_ms)),
      max_lag_ms_1h: Math.max(0, ...rows.map((r) => r.max_lag_ms)),
    },
    minutes: rows.map((r) => ({ ...r, minute: iso(r.minute) })),
  });
});

/** Records accepted per project per UTC day (?days=, default 30, at most 400), with the quota in force that day. */
route('/usage', async (c) => {
  const pid = c.get('project');
  const days = Math.min(400, Math.max(1, Math.floor(Number(c.req.query('days') ?? 30)) || 30));
  const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const { results } = await c.env.DB.prepare(
    `SELECT project_id, day, records, quota, blocked_at FROM usage_daily WHERE ${pf(pid)} AND day >= ? ORDER BY day DESC, project_id`,
  ).bind(pid, since).all<{ project_id: string; day: string; records: number; quota: number | null; blocked_at: number | null }>();
  return c.json({ data: results.map((r) => ({ ...r, blocked_at: r.blocked_at ? iso(r.blocked_at) : null })) });
});

/** Messages that failed every retry, newest first (stored by the consumer's dead-letter handler). */
route('/dead-letters', async (c) => {
  const pid = c.get('project');
  const { results } = await c.env.DB.prepare(
    `SELECT id, project_id, trace_id, received_at, failed_at, record_count, replay_requested_at, replay_attempts, last_error FROM dead_letters WHERE ${pf(pid)} ORDER BY failed_at DESC LIMIT 200`,
  ).bind(pid).all<{ received_at: number; failed_at: number; replay_requested_at: number | null }>();
  return c.json({
    data: results.map((r) => ({ ...r, received_at: iso(r.received_at), failed_at: iso(r.failed_at), replay_requested_at: r.replay_requested_at ? iso(r.replay_requested_at) : null })),
  });
});

/**
 * Requests a replay of dead letters (all of the project's, or `{"ids": [...]}`, at most 100). The consumer's 5-minute
 * cron re-processes them through the normal idempotent path. Requires an admin key.
 */
const replay: Handler<AppEnv> = async (c) => {
  const pid = c.get('project');
  const body: unknown = await c.req.json().catch(() => ({}));
  const raw = typeof body === 'object' && body !== null && 'ids' in body ? body.ids : undefined;
  if (raw !== undefined && (!Array.isArray(raw) || raw.length > 100 || !raw.every((id) => typeof id === 'string'))) {
    return fail(c, 422, 'unprocessable', 'ids must be an array of at most 100 dead letter ids.');
  }
  const ids = raw as string[] | undefined;
  const where = [pf(pid), 'replay_requested_at IS NULL', ...(ids ? [`id IN (${ids.map(() => '?').join(', ') || 'NULL'})`] : [])];
  const res = await c.env.DB.prepare(`UPDATE dead_letters SET replay_requested_at = ?, replay_attempts = 0, last_error = NULL WHERE ${where.join(' AND ')}`)
    .bind(Date.now(), pid, ...(ids ?? [])).run();
  return c.json({ requested: res.meta.changes ?? 0 }, 202);
};
app.post('/v1/projects/:projectId/dead-letters/replay', replay);
app.post('/v1/dead-letters/replay', replay);

for (const spec of EVENT_SPECS) {
  route(spec.path, eventList(spec));
  if (spec.group) route(`${spec.path}/:key`, eventDetail(spec));
}

export default app;
