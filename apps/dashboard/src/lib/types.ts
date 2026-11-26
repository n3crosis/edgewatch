export type ExecutionSource = 'request' | 'command' | 'job' | 'schedule' | 'browser';
export type { TimeRange as Range } from '@edgewatch/shared/time-window';
import type { TimeRange as Range } from '@edgewatch/shared/time-window';

export interface TraceSummary {
  trace_id: string;
  /** For a job attempt: the request/command trace that dispatched it. */
  origin_trace_id?: string | null;
  timestamp: string;
  execution_source: ExecutionSource;
  name: string;
  method: string | null;
  url: string | null;
  route: string | null;
  route_path?: string | null;
  status_code: number | null;
  duration_ms: number;
  query_count: number;
  exception_count: number;
  server: string;
  environment?: string | null;
  user: string | null;
  /** Bytes (Nightwatch peak_memory_usage). */
  peak_memory_usage?: number | null;
  /** Eloquent lazy loads in this execution (Nightwatch's N+1 signal). */
  lazy_loads?: number | null;
  route_action?: string | null;
  /** job-attempt: processed | released | failed; scheduled-task: processed | skipped | failed. */
  status?: string | null;
}

export type SpanType = 'request' | 'middleware' | 'controller' | 'query' | 'cache' | 'outgoing-request' | 'exception' | 'job' | 'mail' | 'queued-job' | 'log';

export interface Span {
  id: string;
  type: SpanType;
  label: string;
  start_ms: number;
  duration_ms: number;
  meta?: Record<string, string | number>;
}

export interface RepeatedQuery {
  sql_hash: string;
  sql: string;
  count: number;
  total_ms: number;
}

export interface TraceDetail {
  trace: TraceSummary;
  spans: Span[];
  records: Record<string, unknown>[];
  /** Storage availability and reported cap discards; does not imply full client capture. */
  capture?: { records_available: boolean; dropped_records: number };
  /** Same statement run 5+ times in this trace (possible N+1). */
  repeated_queries?: RepeatedQuery[];
  user?: { id: string; name: string | null; username: string | null } | null;
  /** Job attempts dispatched by this trace, or the trace that dispatched this job attempt. */
  related?: RelatedTrace[];
}

export interface RelatedTrace {
  trace_id: string;
  timestamp: string;
  execution_source: ExecutionSource;
  name: string;
  status: string | null;
  duration_ms: number;
  origin_trace_id: string | null;
}

export interface ExceptionGroup {
  group: string;
  class: string;
  message: string;
  file: string;
  line: number;
  /** True only when every occurrence in the selected scope was handled. */
  handled: boolean;
  handled_count?: number;
  unhandled_count?: number;
  count: number;
  users: number;
  first_seen: string;
  last_seen: string;
  last_trace_id: string;
  trend: number[];
}

export interface ExceptionDetail extends ExceptionGroup {
  stack: { file: string; source: string }[];
  occurrences: { trace_id: string; timestamp: string; name: string; user: string | null }[];
}

export interface QueryGroup {
  sql_hash: string;
  sql: string;
  connection: string;
  calls: number;
  total_ms: number;
  avg_ms: number;
  p95_ms: number;
  max_ms: number;
  last_seen: string;
  trend: number[];
}

export interface QueryDetail extends QueryGroup {
  samples: { trace_id: string; timestamp: string; duration_ms: number; name: string; file: string; line: number }[];
}

export interface Overview {
  range: Range;
  requests: number;
  error_rate: number;
  p95_ms: number;
  exceptions: number;
  slow_queries: number;
  series: { ts: string; requests: number; errors: number; p95_ms: number }[];
  top_routes: { route: string; requests: number; p95_ms: number; error_rate: number }[];
}

export interface Paginated<T> {
  data: T[];
  next_cursor: string | null;
}

export interface TraceFilters {
  environment?: string;
  user?: string;
  server?: string;
  min_duration_ms?: string;
  route?: string;
  route_kind?: 'name' | 'path' | 'unknown';
  method?: string;
  source?: ExecutionSource | 'all';
  status?: '2xx' | '3xx' | '4xx' | '5xx' | 'all';
  q?: string;
  range?: Range;
}

/** Row of a grouped event list (jobs, commands, ...): `key` is the group value; other columns depend on the type. */
export type EventGroup = { key: string; count: number; last_seen: string } & Record<string, string | number | null>;
export interface EventList {
  data: EventGroup[];
  summary?: Record<string, number>;
}
/** One stored event (a row of job_attempts, ...), newest first. */
export type EventRow = { trace_id: string; trace_name?: string; timestamp: string } & Record<string, string | number | null | undefined>;

export interface PipelineHealth {
  dead_letters: { count: number; oldest_failed_at: string | null; replay_pending: number };
  consumer: { last_batch_at: string | null; messages_1h: number; retried_1h: number; max_lag_ms_5m: number; max_lag_ms_1h: number };
  minutes: { minute: string; batches: number; messages: number; retried: number; max_lag_ms: number }[];
}

export interface DeadLetter {
  id: string;
  project_id: string;
  trace_id: string | null;
  received_at: string;
  failed_at: string;
  record_count: number;
  replay_requested_at: string | null;
  replay_attempts: number;
  last_error: string | null;
}

export interface UsageDay {
  project_id: string;
  day: string;
  records: number;
  quota: number | null;
  blocked_at: string | null;
}

export interface RequestGroup {
  route_kind: 'name' | 'path' | 'unknown';
  method: string;
  route: string;
  requests: number;
  avg_ms: number;
  p95_ms: number | null;
  status_2xx: number;
  status_3xx: number;
  status_4xx: number;
  status_5xx: number;
  status_other: number;
}
export interface RequestGroups { data: RequestGroup[]; next_offset: number | null }

export type IssueStatus = 'open' | 'resolved' | 'ignored';
export interface Issue {
  revision: number;
  group_hash: string; class: string; message: string; status: IssueStatus;
  first_seen: number; last_seen: number; resolved_at: number | null;
}
export interface IssueDetail {
  issue: Issue;
  changes: { id: string; status: IssueStatus; reason: string; actor: string; timestamp: number }[];
  impact: { occurrences: number; users: number };
}

export interface RequestTrend { since: string; until: string; series: Overview['series'] }
