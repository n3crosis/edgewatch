/**
 * Generic read endpoints for the per-type event tables (job_attempts, ...). Each spec becomes
 *   GET /v1[/projects/:id]/<path>           grouped list (or recent rows when `group` is absent), ?range= and spec filters
 *   GET /v1[/projects/:id]/<path>/:key      recent rows of one group, newest first
 * Column and table names come from these constants only, never from the request.
 */
export interface EventSpec {
  path: string;
  table: string;
  /** Column the list groups by and the detail route filters on. Absent: list returns recent rows. */
  group?: string;
  /** Extra aggregate columns for the grouped list (count and last_seen are always included). */
  aggregates?: string;
  /** Default order of the grouped list. */
  order?: string;
  /** Totals over the whole window, returned as `summary`. */
  summary?: string;
  /** Query-string filters: param -> SQL condition with one `?`. */
  filters?: Record<string, string>;
  /** Free-text search columns for ?q=. */
  search?: string[];
  /** Restricts every query of this spec (e.g. kind = 'attempt'). */
  where?: string;
}

const CACHE_COUNTS = `sum(type = 'hit') AS hits, sum(type = 'miss') AS misses, sum(type = 'write') AS writes, sum(type = 'delete') AS deletes,
  sum(type IN ('write-failure', 'delete-failure')) AS failures`;
/** hits / (hits + misses), null when nothing was read. */
const hitRatio = (col: string) => `CASE WHEN sum(${col} IN ('hit', 'miss')) > 0 THEN round(sum(${col} = 'hit') * 1.0 / sum(${col} IN ('hit', 'miss')), 4) END AS hit_ratio`;

export const EVENT_SPECS: EventSpec[] = [
  {
    path: '/jobs',
    table: 'job_attempts',
    group: 'name',
    aggregates: `max(queue) AS queue, max(connection) AS connection,
      sum(kind = 'queued') AS queued, sum(kind = 'attempt') AS attempts,
      sum(status = 'processed') AS processed, sum(status = 'released') AS released, sum(status = 'failed') AS failed,
      avg(CASE WHEN kind = 'attempt' THEN duration_ms END) AS avg_ms, max(CASE WHEN kind = 'attempt' THEN duration_ms END) AS max_ms`,
    order: 'attempts DESC, queued DESC',
    summary: `sum(kind = 'queued') AS queued, sum(kind = 'attempt') AS attempts, sum(status = 'failed') AS failed, sum(status = 'released') AS released`,
    filters: { queue: 'queue = ?', status: 'status = ?' },
    search: ['name', 'queue'],
  },
  {
    path: '/commands',
    table: 'commands',
    group: 'name',
    aggregates: `sum(coalesce(exit_code, 0) != 0) AS failed, avg(duration_ms) AS avg_ms, max(duration_ms) AS max_ms`,
    summary: `count(*) AS runs, sum(coalesce(exit_code, 0) != 0) AS failed, avg(duration_ms) AS avg_ms`,
    filters: { status: `(CASE WHEN coalesce(exit_code, 0) = 0 THEN 'success' ELSE 'failed' END) = ?` },
    search: ['name', 'command'],
  },
  {
    path: '/cache',
    table: 'cache_events',
    group: 'key',
    aggregates: `max(store) AS store, ${CACHE_COUNTS}, ${hitRatio('type')}, avg(duration_ms) AS avg_ms`,
    summary: `${CACHE_COUNTS}, ${hitRatio('type')}`,
    filters: { store: 'store = ?', type: 'type = ?' },
    search: ['key', 'store'],
  },
  {
    path: '/outgoing-requests',
    table: 'outgoing_requests',
    group: 'host',
    aggregates: `sum(status_code >= 400 OR status_code IS NULL) AS failed, sum(status_code >= 500) AS server_errors,
      avg(duration_ms) AS avg_ms, max(duration_ms) AS max_ms, group_concat(DISTINCT method) AS methods`,
    summary: `count(*) AS requests, sum(status_code >= 400 OR status_code IS NULL) AS failed, avg(duration_ms) AS avg_ms`,
    filters: {
      method: 'method = ?',
      status: `(CASE WHEN status_code IS NULL THEN 'error' WHEN status_code >= 500 THEN '5xx' WHEN status_code >= 400 THEN '4xx' WHEN status_code >= 300 THEN '3xx' ELSE '2xx' END) = ?`,
    },
    search: ['host', 'url'],
  },
  {
    path: '/mail',
    table: 'mail',
    group: 'class',
    aggregates: `sum(failed) AS failed, sum(coalesce(to_count, 0) + coalesce(cc_count, 0) + coalesce(bcc_count, 0)) AS recipients,
      avg(duration_ms) AS avg_ms, max(duration_ms) AS max_ms, group_concat(DISTINCT mailer) AS mailers`,
    summary: `count(*) AS sent, sum(failed) AS failed, avg(duration_ms) AS avg_ms`,
    filters: { mailer: 'mailer = ?', status: `(CASE WHEN failed THEN 'failed' ELSE 'sent' END) = ?` },
    search: ['class', 'subject'],
  },
  {
    path: '/notifications',
    table: 'notifications',
    group: 'class',
    aggregates: `sum(failed) AS failed, avg(duration_ms) AS avg_ms, max(duration_ms) AS max_ms, group_concat(DISTINCT channel) AS channels`,
    summary: `count(*) AS sent, sum(failed) AS failed, avg(duration_ms) AS avg_ms`,
    filters: { channel: 'channel = ?', status: `(CASE WHEN failed THEN 'failed' ELSE 'sent' END) = ?` },
    search: ['class', 'channel'],
  },
  {
    path: '/scheduled-tasks',
    table: 'scheduled_tasks',
    group: 'name',
    aggregates: `max(cron) AS cron, max(timezone) AS timezone,
      sum(status = 'processed') AS processed, sum(status = 'failed') AS failed, sum(status = 'skipped') AS skipped,
      avg(CASE WHEN status != 'skipped' THEN duration_ms END) AS avg_ms, max(duration_ms) AS max_ms`,
    summary: `count(*) AS runs, sum(status = 'failed') AS failed, sum(status = 'skipped') AS skipped,
      avg(CASE WHEN status != 'skipped' THEN duration_ms END) AS avg_ms`,
    filters: { status: 'status = ?' },
    search: ['name', 'cron'],
  },
  {
    path: '/logs',
    table: 'logs',
    group: 'level',
    aggregates: `count(DISTINCT trace_id) AS traces`,
    order: `CASE level WHEN 'emergency' THEN 0 WHEN 'alert' THEN 1 WHEN 'critical' THEN 2 WHEN 'error' THEN 3 WHEN 'warning' THEN 4 WHEN 'notice' THEN 5 WHEN 'info' THEN 6 ELSE 7 END`,
    summary: `count(*) AS logs, sum(level IN ('emergency', 'alert', 'critical', 'error')) AS errors, sum(level = 'warning') AS warnings`,
    filters: { level: 'level = ?' },
    search: ['message', 'context'],
  },
  {
    path: '/users',
    table: 'traces',
    group: 'user',
    /** Non-empty user ids only (NULL > '' is false). Single condition: the detail route prefixes it with `e.`. */
    where: "user > ''",
    aggregates: `max((SELECT coalesce(u.name, u.username) FROM users u WHERE u.project_id = traces.project_id AND u.id = traces.user)) AS name,
      sum(execution_source = 'request') AS requests, sum(status_code >= 500) AS server_errors, sum(exception_count) AS exceptions, avg(duration_ms) AS avg_ms`,
    summary: `count(DISTINCT user) AS users, count(*) AS traces, sum(exception_count) AS exceptions`,
    filters: { source: 'execution_source = ?' },
    search: ['user', 'name'],
  },
];
