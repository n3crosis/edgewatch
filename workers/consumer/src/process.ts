import type { BackendEnv } from '@edgewatch/shared/backends';
import { recordUsage } from './usage';
import { EVENT_TABLES, RETAINED_TABLES } from './events';
import { errorFields, log, normalizeSql, scrubPii, shortHash, type BlobStore, type IngestMessage, type IngestQueue, type KeyStore, type NightwatchRecord, type SqlDatabase, type SqlStatement } from '@edgewatch/shared';

/** Storage backends (Postgres through Hyperdrive, S3, SQL key store): see BackendEnv. */
export interface Env extends BackendEnv {
  INGEST_QUEUE?: IngestQueue<IngestMessage>;
  DB: SqlDatabase;
  TRACES: BlobStore;
  /** Days of D1 metadata and R2 traces to keep (scheduled retention job). 0 disables deletion. Default 30. */
  RETENTION_DAYS?: string;
  /** Queue whose batches are dead letters (the ingest queue's dead_letter_queue). Default edgewatch-ingest-dlq. */
  DEAD_LETTER_QUEUE?: string;
  /** Optional webhook (e.g. a Slack incoming webhook) for dead letters and queue lag. */
  ALERT_WEBHOOK_URL?: string;
  /** Queue lag that triggers an alert, in seconds. Default 600. */
  ALERT_LAG_SECONDS?: string;
  /** Writes the over-quota block when a project reaches its daily record quota (same namespace as ingest). */
  API_KEYS?: KeyStore;
  /** Default daily record quota per project (projects.daily_record_quota overrides). Unset or 0: no quota. */
  DAILY_RECORD_QUOTA?: string;
}

/** Traces of one batch are stored in parallel, a few at a time, to overlap D1/R2 round trips without hammering D1. */
const TRACE_CONCURRENCY = 6;
/** Statements per D1 batch: keeps each batch (one transaction) well inside D1's request size and duration limits. */
export const D1_BATCH_STATEMENTS = 50;
/** Caps on one stored trace. Records past either cap are dropped (root records are always kept) and counted. */
export const MAX_TRACE_RECORDS = 5000;
export const MAX_TRACE_BYTES = 8_000_000;

export interface StoredTrace {
  project_id: string;
  trace_id: string;
  records: NightwatchRecord[];
  /** Records dropped because the trace passed MAX_TRACE_RECORDS or MAX_TRACE_BYTES. */
  dropped_records?: number;
}

const ROOT_TYPES = ['request', 'command', 'job-attempt', 'scheduled-task'];
const str = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function traceKey(projectId: string, date: string, traceId: string): string {
  return `traces/${projectId}/${date}/${traceId}.json`;
}

/** Strip SQL literals and attach sql_hash; scrub PII from exception/log messages (the official Nightwatch client does neither). */
export async function normalizeRecord(record: NightwatchRecord, hashes = new Map<string, Promise<string>>()): Promise<NightwatchRecord> {
  if ((record.t === 'exception' || record.t === 'log') && typeof record.message === 'string') {
    return { ...record, message: scrubPii(record.message) };
  }
  if (record.t !== 'query' || typeof record.sql !== 'string') return record;
  const sql = normalizeSql(record.sql);
  // The same statement repeats many times per batch (N+1 loops); hash each normalized SQL once.
  let hash = hashes.get(sql);
  if (!hash) hashes.set(sql, (hash = shortHash(sql)));
  return { ...record, sql, sql_hash: await hash };
}

/** Normalizes in place of a copy of the list, one record at a time (no promise per record for big parked payloads). */
async function normalizeRecords(raw: NightwatchRecord[], hashes: Map<string, Promise<string>>): Promise<NightwatchRecord[]> {
  const out = new Array<NightwatchRecord>(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = await normalizeRecord(raw[i] as NightwatchRecord, hashes);
  return out;
}

interface TraceGroup {
  head: IngestMessage;
  traceId: string;
  originTraceId: string | null;
  records: NightwatchRecord[];
  /** Non-root records already past MAX_TRACE_RECORDS for this group; capRecords would drop them anyway. */
  dropped: number;
  kept: number;
  owners: Set<number>;
}

/**
 * Processes a queue batch as a whole: payloads load in parallel, project rows are upserted once, records are regrouped
 * by (project, trace) across messages so a trace split over several messages costs one R2 read-modify-write and one
 * D1 batch, and traces are stored with bounded concurrency. Returns the indexes of messages that must be retried.
 */
export async function processBodies(bodies: IngestMessage[], env: Env): Promise<{ failed: Set<number>; traces: number; records: Map<string, number> }> {
  const failed = new Set<number>();
  const hashes = new Map<string, Promise<string>>();
  const loaded = await Promise.all(
    bodies.map(async (body, index) => {
      try {
        const receipt = body.message_id ?? await shortHash(JSON.stringify(body));
        const counted = await env.DB.prepare('SELECT receipt FROM usage_receipts WHERE project_id = ? AND receipt = ?').bind(body.project_id, receipt).first();
        if (counted) return { body, index, count: 0, records: [] as NightwatchRecord[] | null };
        const raw = body.records ?? (body.r2_key ? ((await (await env.TRACES.get(body.r2_key))?.json()) as NightwatchRecord[] | undefined) : undefined);
        if (!raw) throw new Error(`Missing parked payload ${body.r2_key}`);
        const item: { body: IngestMessage; index: number; count: number; records: NightwatchRecord[] | null } = { body, index, count: raw.length, records: await normalizeRecords(raw, hashes) };
        return item;
      } catch (e) {
        failed.add(index);
        log('consumer', 'error', 'payload_load_failed', { project_id: body.project_id, r2_key: body.r2_key ?? null, ...errorFields(e) });
        return null;
      }
    }),
  );
  const ok = loaded.filter((x) => x !== null);

  const projects = [...new Set(ok.map((x) => x.body.project_id))];
  if (projects.length) {
    await env.DB.batch(projects.map((id) => env.DB.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').bind(id, id)));
  }

  const groups = new Map<string, TraceGroup>();
  const users = new Map<string, { project: string; record: NightwatchRecord; owners: Set<number> }>();
  for (const item of ok) {
    const { body, index } = item;
    for (const record of item.records ?? []) {
      // `user` records (laravel/nightwatch UserSensor: id, name, username) have no trace_id: they describe the user that
      // other records reference by id, so they go to the users table instead of becoming a trace.
      if (record.t === 'user' && record.id !== undefined && record.id !== null) {
        const key = `${body.project_id}\u0000${String(record.id)}`;
        const entry = users.get(key) ?? { project: body.project_id, record, owners: new Set<number>() };
        // Newer non-blank fields win; blank ones keep what an earlier record in the batch had.
        const filled = (r: NightwatchRecord) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== '' && v !== null && v !== undefined));
        entry.record = num(record.timestamp) >= num(entry.record.timestamp)
          ? ({ ...entry.record, ...filled(record) } as NightwatchRecord)
          : ({ ...record, ...filled(entry.record) } as NightwatchRecord);
        entry.owners.add(index);
        users.set(key, entry);
        continue;
      }
      // Any other record without a trace is grouped under a synthetic per-message trace so nothing is lost.
      const recordTrace = typeof record.trace_id === 'string' ? record.trace_id : `untraced-${body.received_at}`;
      const traceId = executionKey(record) ?? recordTrace;
      const key = `${body.project_id}\u0000${traceId}`;
      let group = groups.get(key);
      if (!group) groups.set(key, (group = { head: body, traceId, originTraceId: traceId !== recordTrace ? recordTrace : null, records: [], dropped: 0, kept: 0, owners: new Set() }));
      group.owners.add(index);
      if (ROOT_TYPES.includes(record.t)) group.records.push(record);
      else if (group.kept < MAX_TRACE_RECORDS) {
        group.records.push(record);
        group.kept++;
      } else group.dropped++;
    }
  }

  // The groups hold every record now; drop the per-message lists so they can be collected while traces are stored.
  for (const item of ok) item.records = null;

  if (users.size) {
    try {
      await env.DB.batch(
        [...users.values()].map(({ project, record }) =>
          env.DB.prepare(
            `INSERT INTO users (project_id, id, name, username, last_seen) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (project_id, id) DO UPDATE SET name = coalesce(excluded.name, users.name), username = coalesce(excluded.username, users.username),
               last_seen = max(users.last_seen, excluded.last_seen)`,
          ).bind(project, String(record.id), str(record.name), str(record.username), Math.round(num(record.timestamp) * 1000) || Date.now()),
        ),
      );
    } catch (e) {
      users.forEach((u) => u.owners.forEach((i) => failed.add(i)));
      log('consumer', 'error', 'users_store_failed', { users: users.size, ...errorFields(e) });
    }
  }

  const queue = [...groups.values()];
  const worker = async () => {
    for (let group = queue.shift(); group; group = queue.shift()) {
      try {
        await storeTrace(env, group.head, group.traceId, group.records, group.originTraceId, group.dropped);
      } catch (e) {
        group.owners.forEach((i) => failed.add(i));
        log('consumer', 'error', 'trace_store_failed', { project_id: group.head.project_id, trace_id: group.traceId, ...errorFields(e) });
      } finally {
        group.records = [];
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(TRACE_CONCURRENCY, queue.length) }, worker));

  // Count before ack, atomically with a stable receipt. Failure retries the message without double charging.
  for (const x of ok) {
    if (failed.has(x.index)) continue;
    try {
      const receipt = x.body.message_id ?? await shortHash(JSON.stringify(x.body));
      await recordUsage(env, new Map([[x.body.project_id, x.count]]), Date.now(), receipt);
    } catch (e) {
      failed.add(x.index);
      log('consumer', 'error', 'usage_failed', { project_id: x.body.project_id, ...errorFields(e) });
    }
  }

  const parked = ok.flatMap((x) => (!failed.has(x.index) && x.body.r2_key ? [x.body.r2_key] : []));
  if (parked.length) await env.TRACES.delete(parked);
  // Usage: records of the messages that were fully processed (and will be acked), per project.
  const records = new Map<string, number>();
  for (const x of ok) if (!failed.has(x.index)) records.set(x.body.project_id, (records.get(x.body.project_id) ?? 0) + x.count);
  return { failed, traces: groups.size, records };
}

/** Single-message entry point (used by tests and tools); throws if the message could not be stored. */
export async function processMessage(message: IngestMessage, env: Env): Promise<void> {
  const { failed } = await processBodies([message], env);
  if (failed.size) throw new Error('Failed to process message');
}

/**
 * laravel/nightwatch job attempts keep the dispatching request's trace_id (JobAttemptSensor, CapturesState) and are
 * identified by attempt_id, which their child records carry as execution_id. Group those by the attempt so each attempt
 * is its own trace row, as with the EdgeWatch client (where execution_id === trace_id and nothing changes).
 */
function executionKey(record: NightwatchRecord): string | null {
  if (record.t === 'job-attempt') return str(record.execution_id) ?? str(record.attempt_id);
  if (record.execution_source === 'job' && record.t !== 'queued-job') return str(record.execution_id);
  return null;
}

async function storeTrace(env: Env, message: IngestMessage, traceId: string, fresh: NightwatchRecord[], originTraceId: string | null = null, preDropped = 0): Promise<void> {
  const projectId = message.project_id;
  const existing = await env.DB.prepare('SELECT date, r2_key FROM traces WHERE project_id = ? AND trace_id = ?').bind(projectId, traceId).first<{ date: string; r2_key: string }>();
  const firstTs = fresh.reduce((min, r) => Math.min(min, num(r.timestamp) || message.received_at / 1000), Infinity);
  const date = existing?.date ?? new Date(firstTs * 1000).toISOString().slice(0, 10);
  const key = existing?.r2_key ?? traceKey(projectId, date, traceId);

  // Records for one trace can arrive in several batches; merge into a single R2 object. A retried message (D1 failed
  // after the R2 write) brings records the object already has: skip exact duplicates so retries are idempotent.
  // The blob may exist even when the first SQL write failed. Preserve it on retry or a later fragment.
  const previous = (await (await env.TRACES.get(key))?.json()) as StoredTrace | undefined;
  // Each record is serialized once: the JSON length feeds the size cap and its hash the duplicate check. A hash hit is
  // confirmed by re-serializing the earlier record, so a collision can never drop a distinct record.
  const seen = new Map<number, number[]>();
  const merged: NightwatchRecord[] = [];
  const sizes: number[] = [];
  const isDuplicate = (json: string, fp: number) => (seen.get(fp) ?? []).some((i) => sizes[i] === json.length && JSON.stringify(merged[i]) === json);
  const add = (r: NightwatchRecord, json: string, fp: number) => {
    const at = seen.get(fp);
    if (at) at.push(merged.length);
    else seen.set(fp, [merged.length]);
    merged.push(r);
    sizes.push(json.length);
  };
  for (const r of previous?.records ?? []) {
    const json = JSON.stringify(r);
    add(r, json, fingerprint(json));
  }
  for (const r of fresh) {
    const json = JSON.stringify(r);
    const fp = fingerprint(json);
    if (!isDuplicate(json, fp)) add(r, json, fp);
  }
  const { kept: all, dropped } = capRecords(merged, MAX_TRACE_RECORDS, MAX_TRACE_BYTES, sizes);
  merged.length = 0;
  const stored: StoredTrace = { project_id: projectId, trace_id: traceId, records: all };
  const droppedTotal = (previous?.dropped_records ?? 0) + dropped + preDropped;
  if (droppedTotal) stored.dropped_records = droppedTotal;
  await env.TRACES.put(key, JSON.stringify(stored), { httpMetadata: { contentType: 'application/json' }, customMetadata: { project_id: projectId } });

  const s = summarize(all, message);
  const head: SqlStatement[] = [
    env.DB.prepare(
      `INSERT INTO traces (project_id, trace_id, timestamp, date, execution_source, name, method, url, route, status_code, duration_ms, query_count, exception_count, server, deploy, user, r2_key,
         peak_memory_usage, lazy_loads, route_action, status, origin_trace_id, route_path, environment)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, trace_id) DO UPDATE SET timestamp = excluded.timestamp, execution_source = excluded.execution_source, name = excluded.name,
         method = excluded.method, url = excluded.url, route = excluded.route, route_path = excluded.route_path, environment = excluded.environment, status_code = excluded.status_code, duration_ms = excluded.duration_ms,
         query_count = excluded.query_count, exception_count = excluded.exception_count, server = excluded.server, deploy = excluded.deploy, user = excluded.user,
         peak_memory_usage = excluded.peak_memory_usage, lazy_loads = excluded.lazy_loads, route_action = excluded.route_action, status = excluded.status,
         origin_trace_id = coalesce(excluded.origin_trace_id, traces.origin_trace_id)`,
    ).bind(projectId, traceId, s.timestamp, date, s.source, s.name, s.method, s.url, s.route, s.status, s.duration, s.queries, s.exceptions, s.server, s.deploy, s.user, key,
      s.peakMemory, s.lazyLoads, s.routeAction, s.runStatus, originTraceId === traceId ? null : originTraceId, s.routePath, s.environment),
  ];

  // Child rows are rebuilt from the merged record list. For a trace that already has a row (a merge, or a retry after a
  // partly applied write) the old child rows go first, so nothing is counted twice.
  if (existing) {
    for (const table of CHILD_TABLES) head.push(env.DB.prepare(`DELETE FROM ${table} WHERE project_id = ? AND trace_id = ?`).bind(projectId, traceId));
  }
  const childStatements = async (r: NightwatchRecord): Promise<SqlStatement[]> => {
    const ts = Math.round(num(r.timestamp) * 1000) || message.received_at;
    const spec = Object.hasOwn(EVENT_TABLES, r.t) ? EVENT_TABLES[r.t] : undefined;
    if (r.t === 'query') {
      return [env.DB.prepare('INSERT INTO queries (project_id, trace_id, sql_hash, sql, connection, duration_ms, file, line, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(projectId, traceId, r.sql_hash, r.sql, str(r.connection), num(r.duration) / 1000, str(r.file), r.line ?? null, ts)];
    } else if (spec) {
      return [env.DB.prepare(`INSERT INTO ${spec.table} (project_id, trace_id, timestamp, user, server, ${spec.columns.join(', ')}) VALUES (?, ?, ?, ?, ?, ${spec.columns.map(() => '?').join(', ')})`)
        .bind(projectId, traceId, ts, str(r.user), str(r.server) ?? message.server, ...spec.row(r))];
    } else if (r.t === 'exception') {
      const group = await shortHash(`${r.class},${r.code ?? ''},${r.file},${r.line}`);
      const exception = env.DB.prepare('INSERT INTO exceptions (project_id, trace_id, group_hash, class, message, code, file, line, handled, stack, timestamp, user, server) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(projectId, traceId, group, String(r.class), String(r.message), str(r.code), String(r.file), num(r.line), r.handled ? 1 : 0, str(r.trace), ts, str(r.user), str(r.server) ?? message.server);
      if (r.handled) return [exception];
      // A lifecycle update and its audit entry are returned together so they always commit in the same batch.
      const changeId = await shortHash(`${projectId}:${group}:${traceId}:${ts}:regression`);
      return [
        env.DB.prepare(`INSERT INTO issues (project_id, group_hash, class, message, first_seen, last_seen)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (project_id, group_hash) DO UPDATE SET
            change_id = CASE WHEN issues.status = 'resolved' AND excluded.last_seen > issues.resolved_at THEN ? ELSE issues.change_id END,
            revision = issues.revision + CASE WHEN issues.status = 'resolved' AND excluded.last_seen > issues.resolved_at THEN 1 ELSE 0 END,
            status = CASE WHEN issues.status = 'resolved' AND excluded.last_seen > issues.resolved_at THEN 'open' ELSE issues.status END,
            first_seen = min(issues.first_seen, excluded.first_seen), last_seen = max(issues.last_seen, excluded.last_seen)`)
          .bind(projectId, group, String(r.class), String(r.message), ts, ts, changeId),
        env.DB.prepare(`INSERT OR IGNORE INTO issue_changes (id, project_id, group_hash, status, reason, actor, timestamp)
          SELECT ?, project_id, group_hash, 'open', 'New occurrence after resolution', 'consumer', ? FROM issues
          WHERE project_id = ? AND group_hash = ? AND change_id = ?`)
          .bind(changeId, ts, projectId, group, changeId),
        exception,
      ];
    }
    return [];
  };

  // Statements are built one chunk at a time, so a 5,000-record trace never holds 5,000 prepared statements at once.
  // Each batch is one transaction; a later chunk failing leaves earlier ones applied, which the rebuild above repairs on retry.
  let chunk: SqlStatement[] = head;
  const flush = async () => {
    await env.DB.batch(chunk);
    chunk = [];
  };
  for (const r of all) {
    const group = await childStatements(r);
    if (chunk.length && chunk.length + group.length > D1_BATCH_STATEMENTS) await flush();
    chunk.push(...group);
  }
  if (chunk.length) await flush();
}

const CHILD_TABLES = RETAINED_TABLES;

/** 53-bit cyrb53 hash of a record's JSON, so duplicate checks need not keep every JSON string alive (hits are re-checked). */
export function fingerprint(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Applies MAX_TRACE_RECORDS / MAX_TRACE_BYTES in arrival order; root records (request, command, ...) are always kept. */
export function capRecords(records: NightwatchRecord[], maxRecords = MAX_TRACE_RECORDS, maxBytes = MAX_TRACE_BYTES, sizes?: number[]): { kept: NightwatchRecord[]; dropped: number } {
  let count = records.filter((r) => ROOT_TYPES.includes(r.t)).length;
  let bytes = 0;
  const kept: NightwatchRecord[] = [];
  for (const [i, r] of records.entries()) {
    const size = sizes?.[i] ?? JSON.stringify(r).length;
    if (ROOT_TYPES.includes(r.t)) {
      kept.push(r);
      bytes += size;
    } else if (count < maxRecords && bytes + size <= maxBytes) {
      kept.push(r);
      count++;
      bytes += size;
    }
  }
  return { kept, dropped: records.length - kept.length };
}

export function summarize(records: NightwatchRecord[], message: Pick<IngestMessage, 'server' | 'received_at'>) {
  const root = records.find((r) => ROOT_TYPES.includes(r.t));
  // Loops instead of Math.min(...spread): large traces would overflow the argument limit.
  let start = Infinity;
  let end = -Infinity;
  for (const r of records) {
    const ts = num(r.timestamp);
    if (!ts) continue;
    start = Math.min(start, ts);
    end = Math.max(end, ts + num(r.duration) / 1e6);
  }
  if (start === Infinity) start = message.received_at / 1000;
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
    routePath: root?.t === 'request' ? str(root.route_path) : null,
    status,
    duration: root ? num(root.duration) / 1000 : end > -Infinity ? (end - start) * 1000 : 0,
    queries: records.filter((r) => r.t === 'query').length,
    exceptions: records.filter((r) => r.t === 'exception').length,
    server: str(any?.server) ?? (message.server || null),
    deploy: str(any?.deploy),
    environment: str(root?.environment) || records.map((r) => str(r.environment)).find(Boolean) || null,
    user: records.map((r) => str(r.user)).find(Boolean) ?? null,
    peakMemory: typeof root?.peak_memory_usage === 'number' ? Math.round(root.peak_memory_usage) : null,
    lazyLoads: typeof root?.lazy_loads === 'number' ? root.lazy_loads : null,
    routeAction: root?.t === 'request' ? str(root.route_action) : null,
    runStatus: root?.t === 'job-attempt' || root?.t === 'scheduled-task' ? str(root.status) : null,
  };
}

const RETENTION_CHUNK = 1000;
const CHILD_RETENTION_CHUNK = RETENTION_CHUNK * 5;
/** D1 allows 1,000 queries per invocation; leave headroom for the rest of the run. */
export const RETENTION_MAX_QUERIES = 900;
/** Cron invocations get 15 minutes of wall time; stop well before it. */
export const RETENTION_BUDGET_MS = 10 * 60_000;

/**
 * Retention (runs from the consumer's hourly cron). Deletes D1 rows older than RETENTION_DAYS in bounded chunks (D1
 * statements must stay short) and the R2 trace objects of the deleted traces. Each run keeps deleting until nothing
 * old is left or its query/time budget runs out (`complete: false`); the next hourly run continues from there, so
 * retention keeps up with ingest instead of deleting a fixed amount per day. Parked `incoming/` payloads and any R2
 * stragglers are covered by bucket lifecycle rules created by scripts/setup-cloudflare.ts.
 */
export type RetentionResult = { skipped: boolean; complete?: boolean; cutoff?: string; traces: number; r2_objects: number; [table: string]: number | string | boolean | undefined };

export interface RetentionBudget {
  maxQueries?: number;
  budgetMs?: number;
  /** Clock used for the time budget (tests). */
  clock?: () => number;
}

/**
 * Projects whose retention is on (`?1` is the RETENTION_DAYS default, `?2` now in ms), each with `due` = 1 when any
 * retained table has a row older than its cutoff. One index probe per table per project.
 */
export function retentionPlanSql(): string {
  const cutoff = '?2 - coalesce(p.retention_days, ?1) * 86400000';
  const due = ['traces', ...RETAINED_TABLES].map((t) => `EXISTS (SELECT 1 FROM ${t} x WHERE x.project_id = p.id AND x.timestamp < ${cutoff})`).join(' OR ');
  return `SELECT p.id, coalesce(p.retention_days, ?1) AS days, (${due}) AS due FROM projects p WHERE coalesce(p.retention_days, ?1) > 0 ORDER BY p.id`;
}

export async function applyRetention(env: Env, now = Date.now(), budget: RetentionBudget = {}): Promise<RetentionResult> {
  const fallback = Number(env.RETENTION_DAYS ?? 30);
  // Per project: projects.retention_days overrides RETENTION_DAYS (0 = keep forever). Each project is cleaned with its
  // own cutoff through the (project_id, timestamp) indexes.
  const { results: projects } = await env.DB.prepare(retentionPlanSql()).bind(Number.isFinite(fallback) && fallback > 0 ? fallback : 0, now)
    .all<{ id: string; days: number; due: number }>();
  if (!projects.length) return { skipped: true, traces: 0, exceptions: 0, queries: 0, r2_objects: 0 };
  // Only projects with expired rows cost queries. Start at a different one each hour so a project with a large backlog
  // cannot starve the ones after it.
  const plans = projects.filter((p) => p.due);
  const start = plans.length ? Math.floor(now / 3_600_000) % plans.length : 0;
  const ordered = [...plans.slice(start), ...plans.slice(0, start)];
  const result: RetentionResult = {
    skipped: false,
    complete: true,
    ...(Number.isFinite(fallback) && fallback > 0 ? { cutoff: new Date(now - fallback * 86_400_000).toISOString() } : {}),
    projects: ordered.length,
    traces: 0,
    exceptions: 0,
    queries: 0,
    r2_objects: 0,
  };
  const clock = budget.clock ?? Date.now;
  const deadline = clock() + (budget.budgetMs ?? RETENTION_BUDGET_MS);
  let queries = budget.maxQueries ?? RETENTION_MAX_QUERIES;
  /** Reserves `n` D1 queries if both budgets allow it. */
  const spend = (n: number) => {
    if (queries < n || clock() >= deadline) return false;
    queries -= n;
    return true;
  };

  for (const { id, days } of ordered) {
    const cutoff = now - days * 86_400_000;
    for (;;) {
      if (!spend(2)) return { ...result, complete: false };
      const { results } = await env.DB.prepare('SELECT r2_key FROM traces WHERE project_id = ? AND timestamp < ? ORDER BY timestamp, rowid LIMIT ?')
        .bind(id, cutoff, RETENTION_CHUNK).all<{ r2_key: string }>();
      if (!results.length) break;
      const keys = [...new Set(results.map((r) => r.r2_key))];
      await env.TRACES.delete(keys);
      result.r2_objects += keys.length;
      const del = await env.DB.prepare('DELETE FROM traces WHERE rowid IN (SELECT rowid FROM traces WHERE project_id = ? AND timestamp < ? ORDER BY timestamp, rowid LIMIT ?)')
        .bind(id, cutoff, RETENTION_CHUNK).run();
      result.traces += del.meta.changes ?? 0;
      if (results.length < RETENTION_CHUNK) break;
    }

    for (const table of RETAINED_TABLES) {
      for (;;) {
        if (!spend(1)) return { ...result, complete: false };
        const del = await env.DB.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE project_id = ? AND timestamp < ? LIMIT ?)`)
          .bind(id, cutoff, CHILD_RETENTION_CHUNK).run();
        result[table] = Number(result[table] ?? 0) + (del.meta.changes ?? 0);
        if ((del.meta.changes ?? 0) < CHILD_RETENTION_CHUNK) break;
      }
    }
  }
  return result;
}
