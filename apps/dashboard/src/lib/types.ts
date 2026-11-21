export type ExecutionSource = 'request' | 'command' | 'job' | 'schedule';
export type Range = '1h' | '6h' | '24h';

export interface TraceSummary {
  trace_id: string;
  timestamp: string;
  execution_source: ExecutionSource;
  name: string;
  method: string | null;
  url: string | null;
  route: string | null;
  status_code: number | null;
  duration_ms: number;
  query_count: number;
  exception_count: number;
  server: string;
  user: string | null;
}

export type SpanType = 'request' | 'middleware' | 'controller' | 'query' | 'cache' | 'outgoing-request' | 'exception' | 'job' | 'mail';

export interface Span {
  id: string;
  type: SpanType;
  label: string;
  start_ms: number;
  duration_ms: number;
  meta?: Record<string, string | number>;
}

export interface TraceDetail {
  trace: TraceSummary;
  spans: Span[];
  records: Record<string, unknown>[];
}

export interface ExceptionGroup {
  group: string;
  class: string;
  message: string;
  file: string;
  line: number;
  handled: boolean;
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
  source?: ExecutionSource | 'all';
  status?: '2xx' | '3xx' | '4xx' | '5xx' | 'all';
  q?: string;
}
