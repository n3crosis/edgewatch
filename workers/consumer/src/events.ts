import { scrubPii, type NightwatchRecord } from '@edgewatch/shared';

type Value = string | number | null;

/** D1 table for one Nightwatch record type. Every table also gets project_id, trace_id, timestamp (unix ms), user, server. */
export interface EventTable {
  table: string;
  columns: string[];
  row: (r: NightwatchRecord) => Value[];
}

const s = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** Nightwatch durations are microseconds. */
const ms = (r: NightwatchRecord) => (typeof r.duration === 'number' ? r.duration / 1000 : 0);

export const EVENT_TABLES: Partial<Record<string, EventTable>> = {
  'job-attempt': {
    table: 'job_attempts',
    columns: ['kind', 'name', 'job_id', 'connection', 'queue', 'attempt', 'status', 'duration_ms'],
    row: (r) => ['attempt', String(r.name), s(r.job_id), s(r.connection), s(r.queue), n(r.attempt), s(r.status), ms(r)],
  },
  'queued-job': {
    table: 'job_attempts',
    columns: ['kind', 'name', 'job_id', 'connection', 'queue', 'attempt', 'status', 'duration_ms'],
    row: (r) => ['queued', String(r.name), s(r.job_id), s(r.connection), s(r.queue), null, null, ms(r)],
  },
  command: {
    table: 'commands',
    columns: ['name', 'command', 'exit_code', 'duration_ms'],
    row: (r) => [s(r.name) ?? s(r.command)?.split(' ')[0] ?? 'unknown', r.command === undefined || r.command === null ? null : scrubPii(String(r.command)), n(r.exit_code), ms(r)],
  },
};

/** Cache keys can embed user data (e.g. `user:jane@example.com`): scrub and cap them. */
export const MAX_CACHE_KEY = 255;
const cacheKey = (v: unknown) => scrubPii(String(v ?? '')).slice(0, MAX_CACHE_KEY);

EVENT_TABLES['cache-event'] = {
  table: 'cache_events',
  columns: ['store', 'key', 'type', 'duration_ms', 'ttl'],
  row: (r) => [s(r.store), cacheKey(r.key), String(r.type), ms(r), n(r.ttl)],
};

/** Query strings often carry tokens or emails: keep scheme, host and path only. */
const safeUrl = (v: unknown) => (v === undefined || v === null ? null : scrubPii(String(v).split(/[?#]/)[0]).slice(0, 2048));
const hostOf = (r: NightwatchRecord) => {
  if (s(r.host)) return String(r.host);
  try {
    return new URL(String(r.url)).host || 'unknown';
  } catch {
    return 'unknown';
  }
};

EVENT_TABLES['outgoing-request'] = {
  table: 'outgoing_requests',
  columns: ['host', 'method', 'url', 'status_code', 'duration_ms', 'request_size', 'response_size'],
  row: (r) => [hostOf(r), String(r.method).toUpperCase(), safeUrl(r.url), n(r.status_code), ms(r), n(r.request_size), n(r.response_size)],
};

const flag = (v: unknown) => (v === true || v === 1 ? 1 : 0);

EVENT_TABLES.mail = {
  table: 'mail',
  columns: ['mailer', 'class', 'subject', 'to_count', 'cc_count', 'bcc_count', 'attachments', 'duration_ms', 'failed'],
  row: (r) => [
    s(r.mailer),
    s(r.class) ?? '(raw)',
    r.subject === undefined || r.subject === null ? null : scrubPii(String(r.subject)).slice(0, 255),
    n(r.to),
    n(r.cc),
    n(r.bcc),
    n(r.attachments),
    ms(r),
    flag(r.failed),
  ],
};

EVENT_TABLES.notification = {
  table: 'notifications',
  columns: ['channel', 'class', 'duration_ms', 'failed'],
  row: (r) => [s(r.channel), String(r.class), ms(r), flag(r.failed)],
};

EVENT_TABLES['scheduled-task'] = {
  table: 'scheduled_tasks',
  columns: ['name', 'cron', 'timezone', 'repeat_seconds', 'status', 'duration_ms'],
  row: (r) => [String(r.name), s(r.cron), s(r.timezone), n(r.repeat_seconds), s(r.status), ms(r)],
};

export const MAX_LOG_MESSAGE = 4096;
export const MAX_LOG_CONTEXT = 2048;
const logContext = (v: unknown) => {
  if (v === undefined || v === null || v === '' || v === '{}' || v === '[]') return null;
  return scrubPii(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, MAX_LOG_CONTEXT);
};

EVENT_TABLES.log = {
  table: 'logs',
  columns: ['level', 'message', 'context'],
  row: (r) => [String(r.level).toLowerCase(), scrubPii(String(r.message)).slice(0, MAX_LOG_MESSAGE), logContext(r.context)],
};

/** EdgeWatch browser extension: one row per page view from @edgewatch/browser. */
EVENT_TABLES['web-vital'] = {
  table: 'web_vitals',
  columns: ['path', 'lcp_ms', 'inp_ms', 'cls', 'fcp_ms', 'ttfb_ms'],
  row: (r) => [String(r.path ?? '/').slice(0, 500), n(r.lcp), n(r.inp), n(r.cls), n(r.fcp), n(r.ttfb)],
};

/** Tables the retention job prunes besides traces. */
export const RETAINED_TABLES = ['exceptions', 'queries', ...new Set(Object.values(EVENT_TABLES).flatMap((t) => (t ? [t.table] : [])))];
