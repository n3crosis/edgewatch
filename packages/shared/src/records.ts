import { z } from 'zod';

/**
 * Zod schemas for the records laravel/nightwatch v1.30.6 sends (see docs/nightwatch-compat.md).
 * Only the fields EdgeWatch relies on are validated; everything else passes through untouched so
 * newer agent versions keep working.
 */
const str = z.string();
const int = z.number().int();
const num = z.number();
const optStr = z.string().nullish();

const execution = {
  timestamp: num,
  deploy: optStr,
  server: optStr,
  _group: optStr,
  trace_id: str.min(1),
  execution_source: optStr,
  execution_id: optStr,
  execution_preview: optStr,
  execution_stage: optStr,
  user: z.union([z.string(), z.number()]).nullish(),
};

const record = <T extends string, S extends z.ZodRawShape>(t: T, shape: S) =>
  z.object({ v: int, t: z.literal(t), ...execution, ...shape }).passthrough();

export const RECORD_SCHEMAS = {
  request: record('request', {
    method: str,
    url: str,
    route_name: optStr,
    route_path: optStr,
    status_code: int,
    duration: int.nonnegative(),
    exceptions: int.optional(),
    queries: int.optional(),
    headers: optStr,
    payload: optStr,
  }),
  query: record('query', {
    sql: str,
    file: optStr,
    line: int.nullish(),
    duration: int.nonnegative(),
    connection: str,
    connection_type: optStr,
  }),
  exception: record('exception', {
    class: str,
    file: str,
    line: int,
    message: str,
    code: z.union([z.string(), z.number()]).transform(String),
    trace: str,
    handled: z.boolean(),
  }),
  command: record('command', { name: optStr, command: optStr, exit_code: int.nullish(), duration: int.nonnegative() }),
  'job-attempt': record('job-attempt', { job_id: optStr, attempt_id: optStr, attempt: int.optional(), name: str, connection: optStr, queue: optStr, status: optStr, duration: int.nonnegative() }),
  'queued-job': record('queued-job', { job_id: optStr, name: str, connection: optStr, queue: optStr, duration: int.nonnegative() }),
  'scheduled-task': record('scheduled-task', { name: str, cron: optStr, status: optStr, duration: int.nonnegative() }),
  'cache-event': record('cache-event', { store: optStr, key: str, type: str, duration: int.nonnegative() }),
  'outgoing-request': record('outgoing-request', { host: optStr, method: str, url: str, duration: int.nonnegative(), status_code: int.nullish() }),
  mail: record('mail', { mailer: optStr, class: str, duration: int.nonnegative(), failed: z.boolean().optional() }),
  notification: record('notification', { channel: optStr, class: str, duration: int.nonnegative(), failed: z.boolean().optional() }),
  log: record('log', { level: str, message: str }),
  user: z.object({ v: int, t: z.literal('user'), timestamp: num, id: z.union([z.string(), z.number()]), name: optStr, username: optStr }).passthrough(),
} as const;

export type RecordType = keyof typeof RECORD_SCHEMAS;
export type NightwatchRecord = { v: number; t: string; trace_id?: string; timestamp?: number; [key: string]: unknown };

const UnknownRecord = z.object({ v: int, t: str.min(1) }).passthrough();

export const IngestBody = z.object({ records: z.array(z.unknown()) });

export interface RecordIssue {
  index: number;
  t: unknown;
  issues: string[];
}

export function validateRecords(input: unknown[]): { records: NightwatchRecord[]; rejected: RecordIssue[] } {
  const records: NightwatchRecord[] = [];
  const rejected: RecordIssue[] = [];

  input.forEach((raw, index) => {
    const t = (raw as { t?: unknown } | null)?.t;
    const schema = typeof t === 'string' && t in RECORD_SCHEMAS ? RECORD_SCHEMAS[t as RecordType] : UnknownRecord;
    const result = schema.safeParse(raw);
    if (result.success) {
      records.push(result.data as NightwatchRecord);
    } else {
      rejected.push({ index, t, issues: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) });
    }
  });

  return { records, rejected };
}
