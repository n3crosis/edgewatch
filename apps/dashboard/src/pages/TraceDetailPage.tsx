import { useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import ContextDrawer, { parseTraceContext } from '@/components/ContextDrawer';
import ExceptionCard from '@/components/ExceptionCard';
import HeadersAndPayloadCard from '@/components/HeadersAndPayloadCard';
import Link from '@/components/ScopedLink';
import TraceTimeline from '@/components/TraceTimeline';
import { SPAN_LABELS } from '@/components/Waterfall';
import {
  CopyButton,
  DescriptionList,
  DescriptionRow,
  Empty,
  ErrorState,
  HttpMethodText,
  Loading,
  PageHeader,
  Panel,
  SourceBadge,
  SourceTag,
  Sql,
  StatusBadge,
  UtcDate,
  useRowNavigate,
} from '@/components/common';
import { LogLevelTag } from '@/pages/LogsPage';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Banner } from '@cloudflare/kumo/components/banner';
import { cn } from '@cloudflare/kumo/utils';
import {
  ArrowUpRightIcon,
  CaretDownIcon,
  GitForkIcon,
  GlobeIcon,
  SidebarSimpleIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import { api, useAsync } from '@/lib/api';
import { bytes, ms } from '@/lib/format';
import { traceView, updateTraceView } from '@/lib/trace-view';
import { filterSpansByQuery } from '@/lib/ui-helpers';
import type { ExecutionSource, SpanType } from '@/lib/types';

/** 1:1 Nightwatch `Show-CWTcwHph.js` (`V`) URL formatter highlighting origin/path/query/hash. */
function FormattedUrl({ url, className }: { url: string; className?: string }) {
  try {
    const parsed = new URL(url);
    return (
      <span className={cn('font-mono text-sm', className)}>
        <span className="font-medium text-neutral-900 dark:text-white">
          {`${parsed.protocol}//${parsed.hostname}`}
        </span>
        <span className="text-neutral-900 dark:text-white">{parsed.pathname}</span>
        {parsed.search && <span className="text-neutral-500 dark:text-neutral-400">{parsed.search}</span>}
        {parsed.hash && <span className="text-neutral-500 dark:text-neutral-400">{parsed.hash}</span>}
      </span>
    );
  } catch {
    return <span className={cn('font-mono text-sm text-neutral-700 dark:text-neutral-300', className)}>{url}</span>;
  }
}

function extractQueryParams(url: string | null | undefined): [string, string][] {
  if (!url) return [];
  try {
    const parsed = new URL(url, 'https://edgewatch.local');
    return [...parsed.searchParams.entries()];
  } catch {
    return [];
  }
}

function sourceBackLink(source: ExecutionSource): { to: string; label: string } {
  switch (source) {
    case 'job':
      return { to: '/jobs', label: 'Jobs' };
    case 'command':
      return { to: '/commands', label: 'Commands' };
    case 'schedule':
      return { to: '/scheduled-tasks', label: 'Scheduled Tasks' };
    default:
      return { to: '/requests', label: 'Requests' };
  }
}

interface TraceExceptionRecord {
  group: string;
  class: string;
  message: string;
  file: string;
  line: number;
  handled: boolean;
  stack: { file: string; source: string }[];
  timestamp: string;
}

function parseExceptionStack(raw: unknown): { file: string; source: string }[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((item) =>
        item && typeof item === 'object'
          ? { file: String((item as { file?: unknown }).file ?? ''), source: String((item as { source?: unknown }).source ?? '') }
          : null,
      )
      .filter((x): x is { file: string; source: string } => Boolean(x && (x.file || x.source)));
  }
  if (typeof raw === 'string') {
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 25)
      .map((line) => ({ file: line, source: '' }));
  }
  return [];
}

/** 1:1 Nightwatch collapsible Exception row (`be` in `pretty-bytes-DviNQNl5.js`). */
function TraceExceptionRow({ exc }: { exc: TraceExceptionRecord }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className={cn(
        'flex flex-col rounded-lg border border-neutral-200 transition-colors dark:border-white/[0.06]',
        expanded
          ? 'bg-neutral-50 dark:bg-neutral-800/40'
          : 'bg-white hover:bg-neutral-50/80 dark:bg-white/[0.02] dark:hover:bg-neutral-800/30',
      )}
    >
      <div className="flex items-center justify-between gap-3 p-2.5 pl-3.5">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <Badge variant={exc.handled ? 'warning' : 'error'}>
            {exc.handled ? 'Handled' : 'Unhandled'}
          </Badge>
          <span className="truncate font-mono text-xs text-neutral-900 dark:text-neutral-100">
            {exc.class}
          </span>
          {exc.file && (
            <span className="hidden truncate font-mono text-xs text-neutral-500 sm:inline dark:text-neutral-400">
              {exc.file}
              {exc.line ? `:${exc.line}` : ''}
            </span>
          )}
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            aria-label={expanded ? 'Collapse exception' : 'Expand exception'}
            className="grid size-7 place-items-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <CaretDownIcon size={15} className={cn('transition-transform duration-150', expanded && 'rotate-180')} aria-hidden />
          </button>
          {exc.group && (
            <Link
              to={`/exceptions/${encodeURIComponent(exc.group)}`}
              className="inline-flex h-7 items-center rounded-md border border-neutral-200 bg-white px-2.5 text-xs font-medium text-neutral-700 transition-colors hover:border-blue-500 hover:text-neutral-900 dark:border-white/10 dark:bg-white/[0.04] dark:text-neutral-200 dark:hover:border-white/20 dark:hover:text-white"
            >
              View
            </Link>
          )}
        </div>
      </div>
      {expanded && (
        <div className="border-t border-neutral-200 p-4 dark:border-white/[0.06]">
          <ExceptionCard
            className={exc.class}
            message={exc.message}
            handled={exc.handled}
            file={exc.file}
            line={exc.line}
            stack={exc.stack}
          />
        </div>
      )}
    </div>
  );
}

export default function TraceDetailPage() {
  const { traceId = '' } = useParams();
  const rowNav = useRowNavigate();
  const [spanQuery, setSpanQuery] = useState('');
  const [contextOpen, setContextOpen] = useState(false);
  const [selectedLogContext, setSelectedLogContext] = useState<Record<string, unknown> | string | null>(null);
  const { data, error, loading } = useAsync(() => api.trace(traceId), [traceId], { keepPreviousData: true });
  const [search, setSearch] = useSearchParams();
  const { eventType, spanId, selected, visibleSpans } = traceView(search, data?.spans ?? []);
  const updateView = (values: Record<string, string | null>, replace = false) => {
    setSearch((previous) => updateTraceView(previous, values), { replace });
  };

  const filteredSpans = useMemo(() => filterSpansByQuery(visibleSpans, spanQuery), [visibleSpans, spanQuery]);

  // Extract raw Nightwatch root record, exceptions, and logs from `data.records`
  const rootRecord = useMemo(() => {
    const records = data?.records ?? [];
    return records.find((r) => ['request', 'command', 'job-attempt', 'scheduled-task'].includes(String(r.t ?? '')));
  }, [data?.records]);

  const traceContext = useMemo(() => parseTraceContext(rootRecord?.context), [rootRecord]);

  const exceptionRecords = useMemo<TraceExceptionRecord[]>(() => {
    const records = data?.records ?? [];
    return records
      .filter((r) => r.t === 'exception')
      .map((r) => ({
        group: String(r._group ?? r.group_hash ?? ''),
        class: String(r.class ?? 'Exception'),
        message: String(r.message ?? ''),
        file: String(r.file ?? ''),
        line: Number(r.line ?? 0),
        handled: Boolean(r.handled),
        stack: parseExceptionStack(r.trace),
        timestamp:
          typeof r.timestamp === 'number'
            ? new Date(r.timestamp * 1000).toISOString()
            : data?.trace.timestamp ?? new Date().toISOString(),
      }));
  }, [data?.records, data?.trace.timestamp]);

  const logRecords = useMemo(() => {
    const records = data?.records ?? [];
    return records
      .filter((r) => r.t === 'log')
      .map((r, idx) => ({
        id: `${traceId}-log-${idx}`,
        level: String(r.level ?? 'info'),
        message: String(r.message ?? ''),
        context: parseTraceContext(r.context),
        timestamp:
          typeof r.timestamp === 'number'
            ? new Date(r.timestamp * 1000).toISOString()
            : data?.trace.timestamp ?? new Date().toISOString(),
      }));
  }, [data?.records, data?.trace.timestamp, traceId]);

  if (error) return <ErrorState error={error} />;
  if (loading) return <Loading />;
  if (!data) {
    return (
      <div className="space-y-5">
        <PageHeader hideTelemetryControls back={{ to: '/requests', label: 'Requests' }} title="Trace not found" />
        <Empty description="This trace may have expired or belongs to another project">Trace not found</Empty>
      </div>
    );
  }

  const { trace, spans, capture, repeated_queries: repeated = [], user, related = [] } = data;
  const split = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i.exec(trace.name);
  const method = split ? split[1].toUpperCase() : trace.method;
  const routePath = split ? split[2] : trace.name;
  const statusCode = Number(trace.status_code ?? 0);
  const globeTone =
    statusCode >= 500
      ? 'text-rose-500 dark:text-rose-400'
      : statusCode >= 400
        ? 'text-amber-600 dark:text-amber-500'
        : 'text-emerald-600 dark:text-emerald-500';

  const queryParams = extractQueryParams(trace.url);
  const requestSize = typeof rootRecord?.request_size === 'number' ? rootRecord.request_size : null;
  const responseSize = typeof rootRecord?.response_size === 'number' ? rootRecord.response_size : null;
  const ip = typeof rootRecord?.ip === 'string' && rootRecord.ip ? rootRecord.ip : null;
  const deploy = typeof rootRecord?.deploy === 'string' && rootRecord.deploy ? rootRecord.deploy : null;
  const rawHeaders = rootRecord?.headers;
  const rawPayload = rootRecord?.payload;
  const unhandledHero = exceptionRecords.find((e) => !e.handled);
  const isRequestTrace = trace.execution_source === 'request';
  const contextItemCount =
    traceContext && typeof traceContext === 'object' ? Object.keys(traceContext).length : null;

  const spanStats = (type: SpanType) => {
    const list = spans.filter((s) => s.type === type);
    const total = list.reduce((sum, s) => sum + s.duration_ms, 0);
    if (!list.length) return <span className="text-neutral-400">0 EVENTS</span>;
    const isFiltered = eventType === type;
    return (
      <button
        type="button"
        onClick={() => updateView({ type: isFiltered ? null : type, span: null })}
        className={cn(
          'inline-flex items-center gap-1 rounded px-1 -mr-1 transition-colors hover:bg-neutral-100 dark:hover:bg-white/10',
          isFiltered && 'bg-blue-50 text-blue-700 dark:bg-emerald-500/15 dark:text-emerald-300',
        )}
        title={isFiltered ? 'Clear timeline filter' : `Filter timeline to ${SPAN_LABELS[type]}`}
      >
        <span>
          {list.length} <span className="text-neutral-400">{list.length === 1 ? 'EVENT' : 'EVENTS'}</span>
          {total > 0 && <span className="text-neutral-400"> / </span>}
          {total > 0 && <span>{ms(total)}</span>}
        </span>
      </button>
    );
  };

  return (
    <div className="space-y-4 md:space-y-6">
      <PageHeader
        hideTelemetryControls
        back={sourceBackLink(trace.execution_source)}
        documentTitle={trace.name}
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {method ? <HttpMethodText method={method} className="text-xl" /> : <SourceBadge source={trace.execution_source} />}
            <span className="font-mono">{routePath}</span>
          </span>
        }
      />

      {/* 1:1 Nightwatch `Show-CWTcwHph.js`: Top Unhandled Exception Hero Card */}
      {unhandledHero && (
        <ExceptionCard
          className={unhandledHero.class}
          message={unhandledHero.message}
          handled={false}
          file={unhandledHero.file}
          line={unhandledHero.line}
          stack={unhandledHero.stack}
        />
      )}

      {/* 1:1 Nightwatch `Show-CWTcwHph.js` Request / Execution Info Card + Events Summary */}
      <div className="grid overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-md shadow-black/[0.04] dark:border-white/[0.06] dark:bg-white/[0.02]">
        <div className="flex items-start justify-between gap-3 border-b border-neutral-200/80 p-5 py-4 dark:border-white/5">
          <div className="min-w-0 flex-1">
            <div className="float-left mt-[3px] mr-1.5 flex items-center gap-1.5 font-mono text-sm font-semibold">
              <GlobeIcon size={14} className={cn('shrink-0', globeTone)} aria-hidden />
              {method && <span className="text-neutral-900 dark:text-white">{method}</span>}
            </div>
            <FormattedUrl url={trace.url ?? routePath} className="break-all" />
          </div>
          <CopyButton text={trace.url ?? routePath} label="Copy URL" className="shrink-0" />
        </div>

        <div className="grid gap-10 p-5">
          <div className="grid grid-cols-1 gap-8 md:grid-cols-2 xl:grid-cols-3">
            <div className="flex-1 space-y-3">
              <DescriptionList>
                <DescriptionRow label="Date"><UtcDate iso={trace.timestamp} /></DescriptionRow>
                <DescriptionRow label={trace.execution_source === 'command' ? 'Exit Code' : 'Status Code'}>
                  <StatusBadge status={trace.status_code} source={trace.execution_source} />
                </DescriptionRow>
                <DescriptionRow label="Duration">{ms(trace.duration_ms)}</DescriptionRow>
                {trace.route && <DescriptionRow label="Route">{trace.route}</DescriptionRow>}
                {typeof rootRecord?.queue === 'string' && rootRecord.queue && (
                  <DescriptionRow label="Queue">{rootRecord.queue}</DescriptionRow>
                )}
                {typeof rootRecord?.connection === 'string' && rootRecord.connection && (
                  <DescriptionRow label="Connection">{rootRecord.connection}</DescriptionRow>
                )}
              </DescriptionList>
              {queryParams.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1 font-mono text-xs">
                  {queryParams.map(([k, v], idx) => (
                    <div
                      key={`${k}-${idx}`}
                      className="flex max-w-full items-center rounded-sm border border-neutral-200 dark:border-white/10"
                    >
                      <span className="shrink-0 border-r border-neutral-200 px-1.5 py-0.5 font-medium text-neutral-600 dark:border-white/10 dark:text-neutral-400">
                        {k}
                      </span>
                      <span className="break-all px-2 py-0.5 text-neutral-800 dark:text-neutral-200">{v}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex-1">
              <DescriptionList>
                {traceContext && (
                  <DescriptionRow label="Context">
                    <button
                      type="button"
                      onClick={() => setContextOpen(true)}
                      className="inline-flex items-center gap-1.5 text-blue-600 hover:underline dark:text-emerald-400"
                    >
                      <span>
                        {contextItemCount !== null
                          ? `${contextItemCount} ${contextItemCount === 1 ? 'item' : 'items'}`
                          : 'View context'}
                      </span>
                      <ArrowUpRightIcon size={12} aria-hidden />
                    </button>
                  </DescriptionRow>
                )}
                <DescriptionRow label="Server">{trace.server || '—'}</DescriptionRow>
                {requestSize !== null && <DescriptionRow label="Request Size">{bytes(requestSize)}</DescriptionRow>}
                {responseSize !== null && <DescriptionRow label="Response Size">{bytes(responseSize)}</DescriptionRow>}
                <DescriptionRow label="Peak Memory">{trace.peak_memory_usage ? bytes(trace.peak_memory_usage) : '—'}</DescriptionRow>
                {deploy && <DescriptionRow label="Deployment">{deploy}</DescriptionRow>}
                <DescriptionRow label="Environment">{trace.environment || '—'}</DescriptionRow>
              </DescriptionList>
            </div>

            {(user || trace.user || ip) && (
              <div className="flex-1 space-y-2">
                <h3 className="text-sm font-semibold text-neutral-900 dark:text-white">User</h3>
                <DescriptionList>
                  {user?.name && <DescriptionRow label="Name">{user.name}</DescriptionRow>}
                  {(user || trace.user) && (
                    <DescriptionRow label="Username">
                      <Link
                        to={`/users/${encodeURIComponent(user?.id ?? trace.user ?? '')}`}
                        className="group inline-flex items-center gap-1.5 hover:underline"
                      >
                        <span>{user?.username ?? `#${user?.id ?? trace.user}`}</span>
                        <ArrowUpRightIcon size={12} className="text-neutral-500 group-hover:text-neutral-900 dark:group-hover:text-white" aria-hidden />
                      </Link>
                    </DescriptionRow>
                  )}
                  {ip && <DescriptionRow label="IP">{ip}</DescriptionRow>}
                </DescriptionList>
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-neutral-900 dark:text-white">Events</h3>
              <div className="inline-flex items-center divide-x divide-neutral-200 rounded border border-neutral-200 bg-white font-mono text-[11px] dark:divide-white/10 dark:border-white/10 dark:bg-white/[0.03]">
                <span className="px-2 py-0.5 text-neutral-500">
                  EVENTS <strong className="ml-1 font-medium text-neutral-900 dark:text-white">{spans.length}</strong>
                </span>
                <span className="px-2 py-0.5 text-neutral-500">
                  DURATION <strong className="ml-1 font-medium text-neutral-900 dark:text-white">{ms(trace.duration_ms)}</strong>
                </span>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-x-8 gap-y-2.5 md:grid-cols-2">
              <DescriptionList>
                <DescriptionRow label="Queries">{spanStats('query')}</DescriptionRow>
                <DescriptionRow label="Mail">{spanStats('mail')}</DescriptionRow>
                <DescriptionRow label="Cache">{spanStats('cache')}</DescriptionRow>
              </DescriptionList>
              <DescriptionList>
                <DescriptionRow label="Outgoing Requests">{spanStats('outgoing-request')}</DescriptionRow>
                <DescriptionRow label="Queued Jobs">{spanStats('queued-job')}</DescriptionRow>
                <DescriptionRow label="Exceptions">{spanStats('exception')}</DescriptionRow>
              </DescriptionList>
            </div>
          </div>
        </div>
      </div>

      {/* 1:1 Nightwatch `HeadersAndPayloadCard-JfysE1P8.js` collapsible Headers / Payload section */}
      {(isRequestTrace || rawHeaders !== undefined || rawPayload !== undefined) && (
        <HeadersAndPayloadCard
          headers={rawHeaders}
          payload={rawPayload}
          statusCode={trace.status_code}
          method={method}
        />
      )}

      {/* 1:1 Nightwatch Exceptions list card */}
      {exceptionRecords.length > 0 && (
        <section className="space-y-2.5">
          <h3 className="font-mono text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">
            {exceptionRecords.length} {exceptionRecords.length === 1 ? 'Exception' : 'Exceptions'}
          </h3>
          <div className="space-y-1.5">
            {exceptionRecords.map((exc, idx) => (
              <TraceExceptionRow key={`${exc.group}-${idx}`} exc={exc} />
            ))}
          </div>
        </section>
      )}

      {/* 1:1 Nightwatch Logs section (`Logs-CkjZtI46.js`) with aligned 24px grid cells and context drawer */}
      {logRecords.length > 0 && (
        <section className="space-y-2.5">
          <h3 className="font-mono text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">
            {logRecords.length} {logRecords.length === 1 ? 'Log' : 'Logs'}
          </h3>
          <div className="grid grid-cols-[auto_auto_auto_1fr_auto] gap-x-4 gap-y-1">
            {logRecords.map((row) => {
              const isEmergency = row.level.toLowerCase() === 'emergency';
              const hasContext = row.context !== null;
              const openLog = () => {
                setSelectedLogContext(
                  row.context ?? {
                    level: row.level,
                    timestamp: row.timestamp,
                    message: row.message,
                  },
                );
              };
              return (
                <div
                  key={row.id}
                  role="button"
                  tabIndex={0}
                  aria-haspopup="dialog"
                  onClick={openLog}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openLog();
                    }
                  }}
                  className={cn(
                    'group/log col-span-full grid cursor-pointer grid-cols-subgrid items-start rounded-md border py-1.5 pr-2 pl-3 font-mono text-xs leading-6 shadow-2xs transition-colors',
                    isEmergency
                      ? 'border-rose-200 bg-rose-100 hover:bg-rose-200 dark:border-rose-900 dark:bg-[#4C0519]/80 dark:hover:bg-rose-800'
                      : 'border-neutral-200 bg-white hover:bg-neutral-50 dark:border-neutral-700/30 dark:bg-neutral-800/30 dark:hover:bg-neutral-800',
                  )}
                >
                  <span className="flex h-6 items-center">
                    <UtcDate iso={row.timestamp} />
                  </span>
                  <span className="flex h-6 items-center">
                    <SourceTag source={trace.execution_source.toUpperCase()} />
                  </span>
                  <span className="flex h-6 items-center whitespace-nowrap">
                    <LogLevelTag level={row.level} />
                  </span>
                  <span className="min-w-0 break-all leading-6 text-neutral-900 dark:text-neutral-100">
                    {row.message}
                  </span>
                  <span className="relative flex size-6 items-center justify-center">
                    <SidebarSimpleIcon
                      size={13}
                      className="hidden text-neutral-500 group-hover/log:block dark:text-neutral-400"
                      aria-hidden
                    />
                    {hasContext && (
                      <span
                        className="size-[5px] rounded-full bg-neutral-400 group-hover/log:hidden dark:bg-neutral-700"
                        aria-hidden
                      />
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {capture && (!capture.records_available || capture.dropped_records > 0) && (
        <Banner
          variant="alert"
          icon={<WarningIcon />}
          title="Incomplete trace details"
          description={
            !capture.records_available
              ? 'Stored trace events are unavailable for this trace. Summary metadata may still be available; an empty timeline does not mean no events occurred.'
              : `Storage limits reported ${capture.dropped_records} dropped events. The timeline shows only retained events.`
          }
        />
      )}

      {(repeated.length > 0 || (trace.lazy_loads ?? 0) > 0) && (
        <Panel
          className="border-kumo-warning/40"
          title={
            <span className="flex items-center gap-2.5 text-kumo-warning">
              <WarningIcon size={17} />
              <span>Possible N+1 queries</span>
              {(trace.lazy_loads ?? 0) > 0 && <Badge variant="warning">{trace.lazy_loads} lazy loads</Badge>}
            </span>
          }
        >
          {repeated.length > 0 ? (
            <ul className="divide-y divide-kumo-hairline">
              {repeated.map((q) => (
                /* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard navigation is provided by the inner Link */
                <li
                  key={q.sql_hash}
                  onClick={rowNav(`/queries/${q.sql_hash}`)}
                  className="flex cursor-pointer items-center justify-between gap-4 px-5 py-3 text-xs transition-colors hover:bg-neutral-50 dark:hover:bg-white/[0.03]"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <Badge variant="warning" className="shrink-0 font-mono">{q.count}×</Badge>
                    <Link to={`/queries/${q.sql_hash}`} className="truncate hover:underline">
                      <Sql sql={q.sql} />
                    </Link>
                  </div>
                  <span className="shrink-0 font-mono tabular-nums text-kumo-warning">{ms(q.total_ms)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-5 py-4 text-xs text-kumo-subtle">
              Detected {trace.lazy_loads} Eloquent lazy load{trace.lazy_loads === 1 ? '' : 's'} during this execution.
            </div>
          )}
        </Panel>
      )}

      {related.length > 0 && (
        <Panel
          title={
            <span className="flex items-center gap-2">
              <GitForkIcon size={16} className="text-kumo-subtle" aria-hidden />
              <span>{related.some((r) => r.trace_id === trace.origin_trace_id) ? 'Dispatched by' : 'Dispatched jobs'}</span>
            </span>
          }
        >
          <ul className="divide-y divide-kumo-hairline">
            {related.map((r) => (
              /* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard navigation is provided by the inner Link */
              <li
                key={r.trace_id}
                onClick={rowNav(`/traces/${r.trace_id}`)}
                className="flex cursor-pointer items-center gap-3.5 px-5 py-3 text-sm transition-colors hover:bg-neutral-50 dark:hover:bg-white/[0.03]"
              >
                <SourceBadge source={r.execution_source} />
                <Link className="truncate font-mono text-xs text-kumo-link hover:underline" to={`/traces/${r.trace_id}`}>{r.name}</Link>
                {r.status && <Badge variant={r.status === 'failed' ? 'error' : r.status === 'processed' ? 'success' : 'warning'}>{r.status}</Badge>}
                <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-kumo-subtle">{ms(r.duration_ms)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {/* 1:1 Nightwatch Interactive Zoomable & Pannable Timeline (`St` in `pretty-bytes-DviNQNl5.js`) */}
      <TraceTimeline
        trace={trace}
        rootRecord={rootRecord}
        allSpans={spans}
        visibleSpans={filteredSpans}
        eventType={eventType ? (eventType as SpanType) : null}
        spanQuery={spanQuery}
        onSpanQueryChange={setSpanQuery}
        onEventTypeChange={(next) => updateView({ type: next, span: null })}
        selected={selected}
        onSelect={(span) => updateView({ tab: 'timeline', span: span.id })}
        onClearSelection={() => updateView({ span: null }, true)}
        missingSpanNotice={Boolean(spanId && !selected)}
      />

      <ContextDrawer open={contextOpen} context={traceContext} onClose={() => setContextOpen(false)} />
      <ContextDrawer open={selectedLogContext !== null} context={selectedLogContext} onClose={() => setSelectedLogContext(null)} />
    </div>
  );
}
